import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isQmdBin, isTracked, qmdUrlProblem, isValidOverride } from "./configFile.js";
import { parseJson } from "./assets/common.js";
import { ruleTemplateInvalid } from "./ruleText.js";

const IDLE_STATE = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };

// Config layers, lowest priority first: user defaults, the committed project file, the
// gitignored local file. The state file is read separately (see loadState).
export function configLayerPaths({ cwd, env = process.env, homedir = os.homedir() }) {
  const configHome = env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  const userPath = env.TOOLGATE_DEFAULTS || path.join(configHome, "toolgate", "config.json");
  return [
    { name: "user", path: userPath, base: path.dirname(userPath) },
    { name: "project", path: path.join(cwd, ".toolgate", "config.json"), base: cwd },
    { name: "local", path: path.join(cwd, ".toolgate", "config.local.json"), base: cwd },
  ];
}

/** The directory of the user config layer, or undefined when it cannot be worked out. */
export function userConfigDir({ cwd, env = process.env, homedir = os.homedir() }) {
  try {
    return configLayerPaths({ cwd, env, homedir }).find((layer) => layer.name === "user")?.base;
  } catch {
    return undefined;
  }
}

// Layers are applied in order: `baseline` REPLACEs (later layer wins), `keywords` and
// `toolBaselines` merge by appending per server. `skills`, `commands` and `subagents` concatenate their `sources` (each tagged
// with the level it came from) and lets the later layer decide every other key. `meta[i]` names
// layer i (`{ name, base }`); without it sources are left untagged and their paths untouched.
export function mergeConfigLayers(layers, meta = []) {
  const merged = {
    baseline: [],
    keywords: {},
    toolBaselines: {},
    client: {},
    qmd: {},
    router: {},
    serverMeta: {},
    skills: {},
    commands: {},
    subagents: {},
    hooks: {},
    permissions: {},
  };

  layers.forEach((layer, index) => {
    if (!layer) return;

    if (Array.isArray(layer.baseline)) {
      merged.baseline = [...layer.baseline];
    }
    mergeAppending(merged.keywords, layer.keywords);
    mergeAppending(merged.toolBaselines, layer.toolBaselines);
    if (typeof layer.defaultAgent === "string") merged.defaultAgent = layer.defaultAgent;
    if (layer.client) merged.client = { ...merged.client, ...layer.client };
    if (layer.qmd && typeof layer.qmd === "object") {
      // The port picks where the default router url points and the bin picks which program runs, so both are as sensitive
      // as `router.qmdUrl`; each key on its own. A bin that is neither a command name nor an absolute path is dropped too.
      const { port, bin, ...rest } = layer.qmd;
      const kept = { ...rest };
      for (const [key, value, valid] of [["port", port, true], ["bin", bin, isQmdBin(bin)]]) {
        if (value === undefined) continue;
        const reason = untrustedReason(meta[index]) ?? (valid ? undefined : "invalid");
        if (reason) merged.ignored = [...(merged.ignored ?? []), { key: `qmd.${key}`, layer: meta[index].name, reason }];
        else kept[key] = value;
      }
      merged.qmd = { ...merged.qmd, ...kept };
    }
    if (layer.router) {
      const hadUrl = Object.hasOwn(merged.router, "qmdUrl");
      const url = merged.router.qmdUrl;
      merged.router = { ...layer.router };
      // A file the repository ships is not trusted with where the user's prompts go (#155, #159).
      const untrusted = Object.hasOwn(merged.router, "qmdUrl") && untrustedReason(meta[index]);
      if (untrusted) {
        delete merged.router.qmdUrl;
        merged.ignored = [...(merged.ignored ?? []), { key: "router.qmdUrl", layer: meta[index].name, reason: untrusted }];
      } else if (Object.hasOwn(merged.router, "qmdUrl") && merged.router.qmdUrl !== null && qmdUrlProblem(merged.router.qmdUrl)) {
        // A trusted layer's value that is not an http(s) URL, or is local without a port, is dropped like an untrusted one; an earlier valid value stays.
        const reason = qmdUrlProblem(merged.router.qmdUrl);
        delete merged.router.qmdUrl;
        merged.ignored = [...(merged.ignored ?? []), { key: "router.qmdUrl", layer: meta[index].name, reason }];
      }
      // The block of a later layer replaces the earlier one, but where the prompts go is set only by the layers that may set it:
      // a project file with a `router` block must not wipe the user's own `qmdUrl`.
      if (hadUrl && !Object.hasOwn(merged.router, "qmdUrl")) merged.router.qmdUrl = url;
    }
    if (layer.rule && typeof layer.rule === "object" && Object.hasOwn(layer.rule, "template")) {
      // What the agent is told is as sensitive as where the prompts go: only the layers the user controls may choose it.
      const untrusted = untrustedReason(meta[index]);
      if (untrusted) merged.ignored = [...(merged.ignored ?? []), { key: "rule.template", layer: meta[index].name, reason: untrusted }];
      else if (ruleTemplateInvalid(layer.rule.template, meta.find((m) => m?.name === "project")?.base)) {
        // Not a path to a text file, or a file that is empty, binary or too long: dropped like any invalid key; an earlier valid one stays.
        merged.ignored = [...(merged.ignored ?? []), { key: "rule.template", layer: meta[index].name, reason: "invalid" }];
      } else merged.rule = { template: layer.rule.template };
    }
    if (layer.skills) {
      // Hosts a lock may name are the user's to allow: a file the repository ships cannot loosen that (#164).
      const { allowedHosts, ...rest } = layer.skills;
      if (rest.sources !== undefined && !Array.isArray(rest.sources)) {
        // A list of sources is what is indexed; anything else would index nothing and look fine.
        delete rest.sources;
        merged.ignored = [...(merged.ignored ?? []), { key: "skills.sources", layer: meta[index]?.name ?? "user", reason: "invalid" }];
      }
      const untrustedHosts = allowedHosts !== undefined && untrustedReason(meta[index]);
      if (untrustedHosts) merged.ignored = [...(merged.ignored ?? []), { key: "skills.allowedHosts", layer: meta[index].name, reason: untrustedHosts }];
      mergeAssetBlock(merged.skills, untrustedHosts || allowedHosts === undefined ? rest : { ...rest, allowedHosts }, meta[index]);
    }
    if (layer.commands) mergeAssetBlock(merged.commands, layer.commands, meta[index]);
    if (layer.subagents) mergeAssetBlock(merged.subagents, layer.subagents, meta[index]);
    if (layer.hooks) mergeAssetBlock(merged.hooks, layer.hooks, meta[index]);
    if (layer.permissions) mergeAssetBlock(merged.permissions, layer.permissions, meta[index]);
    if (layer.serverMeta) merged.serverMeta = { ...merged.serverMeta, ...layer.serverMeta };
  });

  applyLevelSwitches(merged.skills, layers, meta, "skills");
  applyLevelSwitches(merged.commands, layers, meta, "commands");
  applyLevelSwitches(merged.subagents, layers, meta, "subagents");
  applyLevelSwitches(merged.hooks, layers, meta, "hooks");
  applyLevelSwitches(merged.permissions, layers, meta, "permissions");
  return merged;
}

// `dir` of a source resolves against the layer that declared it: the project for the project and
// local layers, the user config directory for the user layer.
function mergeAssetBlock(target, block, meta) {
  const { sources, overrides, recommended, ...rest } = block;
  // Lists of overrides and recommendations combine across layers; they are never replaced.
  // Each recommendation remembers its layer: a committed project one is shared, not the user's own.
  if (Array.isArray(recommended)) target.recommended = [...(target.recommended ?? []), ...recommended.map((entry) => ({ ...entry, layer: meta?.name }))];
  if (overrides !== undefined) mergeOverrideList(target, overrides, meta?.name);
  // The collection and corpus are per project (#54): a user-level default must not make several
  // projects share one.
  if (meta?.name === "user") {
    delete rest.collection;
    delete rest.corpusDir;
  }
  Object.assign(target, rest);
  if (!Array.isArray(sources)) return;
  if (meta) target.declaredLevels = [...new Set([...(target.declaredLevels ?? []), meta.name])];
  const tagged = sources.map((source) => {
    if (!meta || !source || typeof source !== "object") return source;
    const dir = typeof source.dir === "string" ? path.resolve(meta.base, expandHome(source.dir)) : source.dir;
    return { ...source, dir, level: meta.name };
  });
  target.sources = [...(target.sources ?? []), ...tagged];
}

// A hand-edited override can have any shape. What the index cannot apply is dropped here and kept in
// `invalidOverrides`, with the layer it came from, for `doctor`; the valid ones remember their layer.
function mergeOverrideList(target, overrides, layer) {
  const invalid = (entry) => (target.invalidOverrides = [...(target.invalidOverrides ?? []), { layer, entry }]);
  if (!Array.isArray(overrides)) return invalid(overrides);
  for (const entry of overrides) {
    if (isValidOverride(entry)) target.overrides = [...(target.overrides ?? []), { ...entry, layer }];
    else invalid(entry);
  }
}

function expandHome(dir) {
  return dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

// The project decides whether user-level and local-level assets may be used at all, so a team can
// keep the stack uniform. Only the project layer's switches count, one pair per asset block.
function applyLevelSwitches(assets, layers, meta, block) {
  const project = layers.find((layer, index) => layer && meta[index]?.name === "project")?.[block] ?? {};
  const off = new Set(["user", "local"].filter((level) => project[`${level}Level`] === false));
  delete assets.userLevel;
  delete assets.localLevel;
  // Kept so that default stores of a switched-off level are not added as sources either.
  if (off.size) assets.disabledLevels = [...off];
  if (off.size && assets.sources) assets.sources = assets.sources.filter((source) => !off.has(source?.level));
}

function mergeAppending(target, source) {
  if (!source) return;
  for (const [key, values] of Object.entries(source)) {
    // A committed config is not trusted: `__proto__` as a server name would make the spread below throw
    // and take every command down with it, and it must never be assigned to.
    if (key === "__proto__" || !Array.isArray(values)) continue;
    target[key] = [...(Object.hasOwn(target, key) ? target[key] : []), ...values];
  }
}

const layerPath = (layer) => (typeof layer === "string" ? layer : layer.path);
const layerName = (layer) => (typeof layer === "string" ? layer : layer.name);

// Accepts plain paths or `{ name, path }` layers from configLayerPaths.
export function loadConfig(layers) {
  return mergeConfigLayers(layers.map((layer) => readJsonIfExists(layerPath(layer))), layerMeta(layers));
}

// The local layer is gitignored by `init`, but a repository can still version it: it is then as untrusted as the project one.
// `tracked` is lazy so git is only asked when the file carries a key that needs trust.
const layerMeta = (layers) => layers.map((layer) => (typeof layer === "string" ? undefined : layer.name === "local" ? { ...layer, tracked: () => isTracked(layer.path) } : layer));

/** Why a layer may not set keys that run code or send data out (`router.qmdUrl`), or undefined when it may. */
function untrustedReason(layer) {
  if (layer?.name === "project") return "project";
  if (layer?.name === "local" && layer.tracked?.()) return "tracked";
  return undefined;
}

// Which layers contributed each key: top-level keys, plus `keywords.<server>`, `toolBaselines.<server>`
// and `serverMeta.<server>` for the maps that merge per server. Layers that fail to parse are
// listed in `errors` instead of being skipped silently.
export function resolveConfig(layers) {
  const origins = {};
  const errors = [];
  const contents = layers.map((layer) => {
    const read = readLayer(layerPath(layer));
    if (read.error) errors.push({ layer: layerName(layer), path: layerPath(layer), message: read.error });
    return read.value;
  });

  const config = mergeConfigLayers(contents, layerMeta(layers));
  // `origins` is the plain record (what `--json` prints). `shown` is the same for a person reading `config print`: a key a layer was
  // not trusted with was dropped by the merge, so the layer did not contribute it and the text must not say it did.
  const shown = {};
  const note = (map, key, name) => {
    map[key] = [...(map[key] ?? []), name];
  };
  const dropped = (name, key) => (config.ignored ?? []).some((entry) => entry.layer === name && entry.key === key);
  const droppedAll = (name, key, value) => dropped(name, key) || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every((sub) => dropped(name, `${key}.${sub}`)));
  contents.forEach((content, index) => {
    if (!content) return;
    const name = layerName(layers[index]);
    for (const [key, value] of Object.entries(content)) {
      note(origins, key, name);
      note(shown, key, droppedAll(name, key, value) ? `${name} (ignored)` : name);
      if (PER_SERVER.has(key) && value && typeof value === "object") {
        for (const server of Object.keys(value)) {
          note(origins, `${key}.${server}`, name);
          note(shown, `${key}.${server}`, name);
        }
      }
    }
  });
  // The dropped keys, each on its own line of the text: `qmd.port` from the project layer, ignored.
  for (const entry of config.ignored ?? []) note(shown, entry.key, `${entry.layer} (ignored)`);

  return { config, origins, shown, errors };
}

const PER_SERVER = new Set(["keywords", "toolBaselines", "serverMeta"]);

export function loadState(statePath) {
  const state = readJsonIfExists(statePath);
  return {
    extras: state?.extras ?? IDLE_STATE.extras,
    toolExtras: state?.toolExtras ?? IDLE_STATE.toolExtras,
    pendingRestart: state?.pendingRestart ?? IDLE_STATE.pendingRestart,
    subagentExtras: Array.isArray(state?.subagentExtras) ? state.subagentExtras.filter((name) => typeof name === "string") : IDLE_STATE.subagentExtras,
  };
}

export function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// The one place that records "this session needs these servers at the next launch".
export function escalateServers(state, servers) {
  return { ...state, extras: [...new Set([...state.extras, ...servers])], pendingRestart: true };
}

/** Same as `escalateServers`, for subagents: they are registered at the next launch. */
export function escalateSubagents(state, names) {
  return { ...state, subagentExtras: [...new Set([...(state.subagentExtras ?? []), ...names])], pendingRestart: true };
}
export function consumeEscalations() {
  return { ...IDLE_STATE, toolExtras: {}, subagentExtras: [] };
}

const listOf = (value) => (Array.isArray(value) ? value : []);
const toolsOf = (state) => (state?.toolExtras !== null && typeof state?.toolExtras === "object" ? Object.entries(state.toolExtras) : []);
const withPending = (state, extras, toolExtras, subagentExtras) => ({
  ...state,
  extras,
  toolExtras,
  subagentExtras,
  pendingRestart: extras.length > 0 || Object.keys(toolExtras).length > 0 || subagentExtras.length > 0,
});

/** The escalations of both states together, in the shape of `a`: a failed launch gives back what it consumed without dropping what was escalated since. */
export function mergeEscalations(a, b) {
  const tools = new Map();
  for (const [server, names] of [...toolsOf(a), ...toolsOf(b)]) tools.set(server, [...new Set([...(tools.get(server) ?? []), ...listOf(names)])]);
  const merged = withPending(a, [...new Set([...listOf(a.extras), ...listOf(b.extras)])], Object.fromEntries(tools), [...new Set([...listOf(a.subagentExtras), ...listOf(b.subagentExtras)])]);
  return { ...merged, pendingRestart: merged.pendingRestart || a.pendingRestart === true || b.pendingRestart === true };
}

/** `state` without the escalations of `consumed`: what a launch took for itself goes, what was escalated meanwhile stays. */
export function withoutEscalations(state, consumed) {
  const gone = new Set(listOf(consumed.extras));
  const goneSubagents = new Set(listOf(consumed.subagentExtras));
  const taken = new Map(toolsOf(consumed));
  const tools = [];
  for (const [server, names] of toolsOf(state)) {
    const takenNames = new Set(listOf(taken.get(server)));
    const left = listOf(names).filter((name) => !takenNames.has(name));
    if (left.length) tools.push([server, left]);
  }
  return withPending(state, listOf(state.extras).filter((name) => !gone.has(name)), Object.fromEntries(tools), listOf(state.subagentExtras).filter((name) => !goneSubagents.has(name)));
}

function readLayer(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return { value: null };
  }
  try {
    return { value: parseJson(text) };
  } catch (err) {
    return { value: null, error: err.message };
  }
}

function readJsonIfExists(configPath) {
  return readLayer(configPath).value;
}
