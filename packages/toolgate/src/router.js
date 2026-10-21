// Plugin-based router system (SPEC §7.2 / DESIGN "Router").
// Routes a task prompt to the set of expensive-tier servers to activate
// and the set of relevant skills to load on demand.
// Step 0a: mandatory bindings (`config.router.bindings`) are checked first and,
// when one matches, short-circuit any backend lookup.
// Backends are pluggable via registerBackend(); ships with:
// 1. "regex": zero-dependency regex backend using the existing `keywords` config.
// 2. "qmd": hybrid semantic + keyword backend via the shared QMD daemon.

import { ignoredWhat, invalidWhy } from "./configFile.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { daemonStatus, managedPort, qmdBinOf, remoteQmdOrigin } from "./daemon.js";
import { checkFreshness, skillsLocation, staleMessage, unknownMessage } from "./daemonFreshness.js";
import { NOT_INDEXED, skillsButNoIndex } from "./skills/unindexed.js";
import { createDaemonClient } from "./qmdClient.js";
import { SAFE_NAME, printable } from "./assets/common.js";
import { catalogMaxServers, matchCatalog } from "./catalog/match.js";
import { COMMANDS_DIR, DEFAULT_CORPUS_DIR, RESERVED_NAMES, SUBAGENTS_DIR, defaultCollection, parseCard } from "./skills/corpus.js";
import path from "node:path";
import { matchesWholeWord } from "./activeSet.js";

/**
 * @typedef {Object} SkillMatch
 * @property {string} name Skill identifier.
 * @property {string} path Relative or absolute path to SKILL.md.
 * @property {number} [score] Match relevance score.
 * @property {string} [snippet] Snippet from match.
 */

/**
 * @typedef {Object} CommandMatch
 * @property {string} name Command identifier (typed `/name` in the agents that have commands).
 * @property {string} path Path to the command file toolgate copied or indexed.
 * @property {string} [argumentHint] What the command expects after its name.
 * @property {number} [score] Match relevance score.
 * @property {string} [snippet] Snippet from match.
 */

/**
 * @typedef {Object} SubagentMatch
 * @property {string} name Subagent identifier.
 * @property {string} path Path to the subagent definition toolgate copied or indexed.
 * @property {string[]} tools The tools it gets (its own, or the read-only default).
 * @property {boolean} toolsDefault Whether `tools` is the default because its definition lists none.
 * @property {number} [score] Match relevance score.
 */
/**
 * @typedef {Object} RouteResult
 * @property {string[]} servers Expensive-tier servers to activate this launch.
 * @property {string[]} alwaysOn Matched servers that are always on (baseline or cheap tier).
 * @property {SkillMatch[]} skills Recommended skills to load on demand.
 * @property {CommandMatch[]} commands Recommended commands, separate from skills: a skill and a command may match together.
 * @property {SubagentMatch[]} subagents Recommended subagents, apart from skills and commands. A subagent is registered in the agent at launch, not read.
 * @property {string} reason Human-readable explanation of the routing decision.
 * @property {Array<{server: string, reason: string}>} escalations Servers implied but requiring OAuth.
 * @property {string|null} binding Pattern of the mandatory binding that decided the route, if any.
 */

/**
 * @typedef {Object} Binding
 * @property {string} pattern Case-insensitive regex tested against the prompt.
 * @property {string} [skill] Skill name to load.
 * @property {string} [path] Path to the skill's SKILL.md.
 * @property {string[]} [servers] Servers to activate.
 */

/**
 * @typedef {Object} RouterBackend
 * @property {string} name Backend identifier.
 * @property {(prompt: string, config: Object) => RouteResult | Promise<RouteResult>} match
 */

// --- Plugin registry ---

const backends = new Map();

export function registerBackend(name, plugin) {
  if (!plugin || typeof plugin.match !== "function") {
    throw new Error(`Router backend "${name}" must expose a match() function`);
  }
  backends.set(name, { ...plugin, name });
}

export function getBackend(name) {
  return backends.get(name) ?? null;
}

export function resetBackends() {
  backends.clear();
  registerBuiltinBackends();
}

// --- Regex backend logic ---

function matchRegexServers(prompt, config) {
  const { keywords = {} } = config;
  const knownServers = Object.keys(keywords);
  const matched = [];
  const reasons = [];

  for (const name of knownServers) {
    if (matchesWholeWord(prompt, name)) {
      matched.push(name);
      reasons.push(`self-match for ${name}`);
      continue;
    }
    const patterns = keywords[name] ?? [];
    for (const pattern of patterns) {
      try {
        if (new RegExp(pattern, "i").test(prompt)) {
          matched.push(name);
          reasons.push(`"${pattern}" matched for ${name}`);
          break;
        }
      } catch {
        // skip invalid regex patterns
      }
    }
  }

  return {
    servers: [...new Set(matched)],
    reasons,
  };
}

// --- QMD JSON output parser ---

export function parseQmdJson(stdout) {
  if (!stdout || typeof stdout !== "string") return [];
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
}

function extractSkillName(hit) {
  if (hit.snippet) {
    const nameMatch = hit.snippet.match(/name:\s*["']?([a-zA-Z0-9_-]+)["']?/);
    if (nameMatch) return nameMatch[1];
  }
  if (hit.title && hit.title !== "SKILL" && hit.title !== "skill") {
    return hit.title;
  }
  if (hit.file) {
    const dir = path.dirname(hit.file);
    const base = path.basename(dir);
    if (base && base !== "." && base !== "skills") {
      return base;
    }
    return path.basename(hit.file, path.extname(hit.file));
  }
  return "unknown-skill";
}

// QMD reports `<collection>/<relative path>`; agents need a path they can open.
// Tries each configured skills root (default: .rulesync/skills, .toolgate/skills)
// and keeps the QMD path untouched when nothing resolves.
function resolveSkillPath(file, collection, { roots, cwd, existsFn }) {
  if (!file || path.isAbsolute(file)) return file;
  const prefix = `${collection}/`;
  const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  for (const root of roots) {
    const candidate = path.resolve(cwd, root, relative);
    if (existsFn(candidate)) return path.relative(cwd, candidate);
  }
  return file;
}

// `qmd search --full-path` (the CLI fallback) reports the path of the card: absolute in some versions, relative to the
// project (`./.toolgate/skills-index/corpus/x.md`) in others; a daemon reports `<collection>/<relative path>`.
export const withoutCollection = (file, collection, corpusDir, cwd = process.cwd()) => {
  const prefix = `${collection}/`;
  if (file.startsWith(prefix)) return file.slice(prefix.length);
  const full = file.startsWith("./") || file.startsWith("../") ? path.resolve(cwd, file) : file;
  const root = `${corpusDir}${path.sep}`;
  return full.startsWith(root) ? full.slice(root.length).split(path.sep).join("/") : file;
};
// A corpus card is `<collection>/<name>.md`; the generated catalog is not a skill.
function corpusCardName(file, collection, corpusDir = "", cwd) {
  if (typeof file !== "string") return null;
  const relative = withoutCollection(file, collection, corpusDir, cwd);
  if (relative.includes("/") || path.extname(relative) !== ".md") return null;
  return relative === "SKILL.md" ? null : relative;
}

// A command card is `<collection>/commands/<name>.md`, a subagent card `<collection>/subagents/<name>.md`.
// `{ card: null }` is a hit inside one of those folders that is not a card (a nested path, `..`, another
// extension): it is dropped, never read as a skill. `undefined` is a hit that is not about either.
function corpusKindCard(file, collection, corpusDir, cwd) {
  if (typeof file !== "string") return undefined;
  const relative = withoutCollection(file, collection, corpusDir, cwd);
  for (const [kind, dir] of [["command", COMMANDS_DIR], ["subagent", SUBAGENTS_DIR]]) {
    if (!relative.startsWith(`${dir}/`)) continue;
    return { kind, card: new RegExp(`^${dir}/[^/]+\\.md$`).test(relative) ? relative : null };
  }
  return undefined;
}

const DEFAULT_SKILLS_ROOTS = [".rulesync/skills", ".toolgate/skills"];

function defaultExec(bin, args, options = {}) {
  return execFileSync(bin, args, {
    encoding: "utf8",
    timeout: 5000,
    // A qmd that ignores the polite signal would hold the prompt for good.
    killSignal: "SIGKILL",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

const PROBE_TIMEOUT_MS = 1000;
/** What the user is told when the local daemon is down or hung: the routing is by keyword only, and the command that fixes it. */
const daemonWarning = (state, port) =>
  state === "down"
    ? `the qmd daemon is not running on port ${port}; skills are found by keyword only until it runs: toolgate daemon start`
    : `the qmd daemon on port ${port} is not answering; skills are found by keyword only until it is restarted: toolgate daemon restart`;

/** The MCP endpoint of the local daemon: the port `managedPort` decides (the environment and `qmd.port`, then 8181). */
export function defaultDaemonUrl(env = process.env, config) {
  return `http://localhost:${managedPort({ qmd: config?.qmd }, env)}/mcp`;
}

/**
 * Creates a QMD router backend.
 * Prefers the shared HTTP daemon (models stay loaded once, across all agents);
 * falls back to `qmd search` (BM25 only, no model load) when the daemon is down.
 * @param {Object} [options]
 * @param {string|null} [options.daemonUrl] MCP endpoint of the shared daemon; null disables it.
 * @param {typeof fetch} [options.fetchFn] Custom fetch implementation.
 * @param {number} [options.timeoutMs] Daemon request timeout (default: 5000).
 * @param {(bin: string, args: string[], opts?: Object) => string} [options.execFn] Custom execution function.
 * @param {string} [options.qmdBin] QMD binary path/name.
 * @param {number} [options.minScore] Minimum relevance score for skill matches (default: 0.5).
 * @param {string} [options.cwd] Working directory for running QMD and resolving skill paths.
 * @param {(p: string) => boolean} [options.existsFn] File existence check used to resolve skill paths.
 * @param {(p: string) => string} [options.readFn] Reads corpus cards (default: utf8 file read).
 * @param {(p: string) => string[]} [options.readdirFn] Lists the corpus folder, to compare it with what the daemon serves.
 */
export function createQmdBackend(options = {}) {
  const {
    daemonUrl,
    fetchFn = globalThis.fetch,
    timeoutMs = 5000,
    execFn = defaultExec,
    qmdBin,
    minScore = 0.5,
    cwd = process.cwd(),
    existsFn = existsSync,
    readFn = (file) => readFileSync(file, "utf8"),
    readdirFn = readdirSync,
    env = process.env,
  } = options;

  const clients = new Map();
  function clientFor(url) {
    if (!clients.has(url)) clients.set(url, createDaemonClient({ url, fetchFn, timeoutMs }));
    return clients.get(url);
  }

  async function queryDaemon(url, prompt, collection, threshold) {
    const result = await clientFor(url).callTool("query", {
      searches: [
        { type: "lex", query: prompt },
        { type: "vec", query: `which skill handles: ${prompt}` },
      ],
      collections: [collection],
      intent: "find the agent skill (SKILL.md) or command that handles this task",
      minScore: threshold,
      rerank: false,
    });
    return result?.structuredContent?.results ?? [];
  }

  function queryCli(prompt, collection, bin) {
    const stdout = execFn(bin, ["search", prompt, "-c", collection, "--format", "json", "--full-path"], {
      cwd,
    });
    return parseQmdJson(stdout);
  }

  return {
    name: "qmd",
    async match(prompt, config) {
      // 1. Keyword-based server matching
      const regexResult = matchRegexServers(prompt, config);
      const servers = [...regexResult.servers];
      const reasons = [...regexResult.reasons];
      const skills = [];
      const commands = [];
      const subagents = [];

      const threshold = config?.router?.minScore ?? minScore;
      const collection =
        config?.router?.skillsCollection ?? config?.skills?.collection ?? defaultCollection(cwd);
      const roots = config?.router?.skillsRoots ?? config?.skills_sources ?? DEFAULT_SKILLS_ROOTS;
      const url = config?.router?.qmdUrl !== undefined ? config.router.qmdUrl : (daemonUrl === undefined ? defaultDaemonUrl(process.env, config) : daemonUrl);

      // 2. Query QMD for matching skills: shared daemon first, CLI BM25 as fallback
      const warnings = [];
      const { corpusDir } = skillsLocation(config, cwd);
      // A checkout with skills and no index finds none and would say nothing (a new git worktree, #197).
      if (skillsButNoIndex(config, cwd, env)) warnings.push(NOT_INDEXED);
      let hits = null;
      if (url && fetchFn) {
        // A local daemon is probed first (1 s, as `daemon status` does): a daemon that is down or hung is said once in `warnings`, which the
        // Step 0 rule relays, and the query is not tried. A remote server is not probed and has no command: toolgate does not manage it.
        const port = managedPort({ router: { qmdUrl: url } });
        const probe = port === null ? null : await daemonStatus({ port, fetchFn, timeoutMs: PROBE_TIMEOUT_MS });
        if (probe !== null && probe.state !== "up") {
          warnings.push(daemonWarning(probe.state, port));
          reasons.push(`QMD daemon unavailable (${probe.state === "down" ? "not running" : "not answering"}); falling back to CLI search`);
        } else {
          try {
            hits = await queryDaemon(url, prompt, collection, threshold);
            // A daemon that serves fewer documents than the corpus returns less without saying so.
            const check = await checkFreshness({ url, collection, corpusDir, client: clientFor(url), readdirFn });
            if (check.state === "stale") warnings.push(staleMessage({ collection, ...check }));
            // With a corpus to compare against, an answer that cannot be counted is not "fine": the daemon may be
            // serving an old or foreign index and returning nothing without saying so. No corpus, nothing to say.
            else if (check.state === "unknown" && check.expected !== null) warnings.push(unknownMessage({ collection }));
          } catch (err) {
            reasons.push(`QMD daemon unavailable (${err.message}); falling back to CLI search`);
            if (port !== null) warnings.push(daemonWarning("hung", port));
            else {
              const origin = remoteQmdOrigin({ router: { qmdUrl: url } });
              if (origin !== null) warnings.push(`the qmd server at ${origin} is not answering; skills are found by keyword only`);
            }
          }
        }
      }
      if (hits === null) {
        try {
          hits = queryCli(prompt, collection, qmdBin ?? qmdBinOf(config));
        } catch (err) {
          reasons.push(`QMD lookup failed: ${err.message}`);
          hits = [];
        }
      }

      let unreadable = 0;
      const requires = (entry) => (entry.mcps.length ? `; requires ${entry.mcps.join(", ")}` : "");
      // The card of a hit, or null (with the reason) when it cannot be read or is not a command's.
      function readCard(card, label, kind) {
        let entry;
        try {
          entry = parseCard(readFn(path.join(corpusDir, card)));
        } catch {
          reasons.push(`${label} card ${card} unreadable in ${corpusDir}; run "toolgate skills index"`);
          unreadable++;
          return null;
        }
        if (kind !== undefined && entry.kind !== kind) {
          reasons.push(`${label} card ${card} is not a ${kind} card; run "toolgate skills index"`);
          unreadable++;
          return null;
        }
        return entry;
      }

      for (const hit of hits) {
        // A result that is not a plain object with something in it (null, a number, a list, {}) names nothing: it is not a hit.
        if (hit === null || typeof hit !== "object" || Array.isArray(hit) || Object.keys(hit).length === 0) continue;
        const score = typeof hit.score === "number" ? hit.score : 1;
        if (score < threshold) continue;

        const apart = corpusKindCard(hit.file, collection, corpusDir, cwd);
        if (apart?.kind === "subagent") {
          const name = apart.card ? path.basename(apart.card, ".md") : null;
          if (!name || !SAFE_NAME.test(name) || RESERVED_NAMES.has(name)) continue;
          const entry = readCard(apart.card, "subagent", "subagent");
          if (!entry) continue;
          subagents.push({
            name,
            path: entry.path,
            tools: entry.tools ?? [],
            toolsDefault: entry.toolsDefault === true,
            level: entry.level,
            shadows: entry.shadows,
            description: entry.description,
            score,
            snippet: hit.snippet ?? "",
          });
          servers.push(...entry.mcps);
          reasons.push(`QMD matched subagent ${name} (score: ${score})${requires(entry)}`);
          continue;
        }
        const command = apart;
        if (command) {
          const name = command.card ? path.basename(command.card, ".md") : null;
          if (!name || !SAFE_NAME.test(name) || RESERVED_NAMES.has(name)) continue;
          const entry = readCard(command.card, "command", "command");
          if (!entry) continue;
          commands.push({
            name,
            path: entry.path,
            ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
            level: entry.level,
            shadows: entry.shadows,
            description: entry.description,
            score,
            snippet: hit.snippet ?? "",
          });
          servers.push(...entry.mcps);
          reasons.push(`QMD matched command ${name} (score: ${score})${requires(entry)}`);
          continue;
        }

        const card = corpusCardName(hit.file, collection, corpusDir, cwd);
        if (card && RESERVED_NAMES.has(path.basename(card, ".md"))) continue; // the catalog, not a skill
        if (card) {
          const name = path.basename(card, ".md");
          const entry = readCard(card, "skills");
          if (!entry) continue;
          skills.push({ name, path: entry.path, level: entry.level, shadows: entry.shadows, description: entry.description, score, snippet: hit.snippet ?? "" });
          servers.push(...entry.mcps);
          reasons.push(`QMD matched skill ${name} (score: ${score})${requires(entry)}`);
          continue;
        }

        const skillName = extractSkillName(hit);
        skills.push({
          name: skillName,
          path: resolveSkillPath(hit.file, collection, { roots, cwd, existsFn }) ?? "",
          score,
          snippet: hit.snippet ?? "",
        });
        reasons.push(`QMD matched skill ${skillName} (score: ${score})`);
      }

      // Said once and in `warnings`, where `need` shows it: after an upgrade every card can be of an older
      // format, and a quiet empty answer would look like "nothing is needed".
      if (unreadable) {
        warnings.push(`${unreadable} skill or command card${unreadable === 1 ? " is" : "s are"} unreadable in ${corpusDir}; run "toolgate skills index"`);
      }
      return {
        servers: [...new Set(servers)],
        skills,
        commands,
        subagents,
        reason: reasons.join("; ") || "No matches found",
        escalations: [],
        warnings,
      };
    },
  };
}

// --- Built-in backends ---

function registerBuiltinBackends() {
  registerBackend("regex", {
    match(prompt, config) {
      const regexResult = matchRegexServers(prompt, config);
      return {
        servers: regexResult.servers,
        skills: [],
        reason: regexResult.reasons.join("; ") || "No keyword matches found",
      };
    },
  });

  registerBackend("qmd", createQmdBackend());
}

registerBuiltinBackends();

// --- Mandatory bindings (Step 0a) ---

function matchBinding(prompt, bindings = []) {
  for (const binding of bindings) {
    try {
      if (new RegExp(binding.pattern, "i").test(prompt)) return binding;
    } catch {
      // skip invalid regex patterns
    }
  }
  return null;
}

/**
 * The command a task names: its first word, with an optional leading `/`, when `commandByName` knows it.
 * @returns {{ match: object, mcps: string[] } | null}
 */
function exactCommand(prompt, commandByName) {
  if (typeof commandByName !== "function") return null;
  const found = /^\s*\/?([^\s]+)(?:\s+([\s\S]*))?$/.exec(prompt);
  const name = found?.[1];
  if (!name || !SAFE_NAME.test(name) || RESERVED_NAMES.has(name)) return null;
  let command;
  try {
    command = commandByName(name);
  } catch {
    return null;
  }
  if (!command || command.name !== name) return null;
  const rest = (found[2] ?? "").trim();
  return {
    match: {
      name,
      path: command.path,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      level: command.level,
      shadows: command.shadows ?? [],
      ...(command.description ? { description: command.description } : {}),
      score: 1,
      snippet: "",
      ...(rest ? { arguments: rest } : {}),
    },
    mcps: command.mcps ?? [],
  };
}

// --- Main route function ---

/**
 * Route a task prompt to the set of expensive-tier servers to activate
 * and relevant skills to load on demand.
 * @param {string} prompt The user's task prompt.
 * @param {Object} config Merged toolgate config (baseline, keywords, serverMeta, router, etc.).
 * @param {{ backend?: string, installed?: { servers: string[], source: string } | null }} [options]
 *   `installed` lists the servers the agent has configured; without it nothing is reported missing.
 * @returns {Promise<RouteResult>}
 */
export async function route(prompt, config, options = {}) {
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("route: prompt must be a non-empty string");
  }

  const backendName = options.backend ?? config?.router?.backend ?? "regex";
  const backend = getBackend(backendName);
  if (!backend) {
    throw new Error(`route: unknown backend "${backendName}". Available: ${[...backends.keys()].join(", ")}`);
  }

  const { baseline = [], serverMeta = {} } = config ?? {};

  const cheapServers = new Set([
    ...baseline,
    ...Object.entries(serverMeta)
      .filter(([, meta]) => meta.tier === "cheap")
      .map(([name]) => name),
  ]);

  const binding = matchBinding(prompt, config?.router?.bindings);
  // `/toolgate build auto` reaches here as "build auto": a first word that is the name of a command is that
  // command, found by name and not by similarity, so it works with a stale or missing index.
  const exact = binding ? null : exactCommand(prompt, options.commandByName);
  const matched = binding
    ? {
        servers: binding.servers ?? [],
        skills: binding.skill ? [{ name: binding.skill, path: binding.path ?? "", score: 1 }] : [],
        reason: `mandatory binding "${binding.pattern}" matched`,
      }
    : await backend.match(prompt, config ?? {});
  const matchedOrExact = exact
    ? {
        ...matched,
        commands: [exact.match, ...(matched.commands ?? []).filter((command) => command.name !== exact.match.name)],
        servers: [...(matched.servers ?? []), ...exact.mcps],
      }
    : matched;

  // The catalog adds servers after the ones the binding, the skills and the keywords gave; a mandatory binding is the whole answer.
  let semantic = [];
  let searchNote = null;
  if (!binding && options.catalog?.servers?.size && typeof options.catalogSearch === "function") {
    try {
      semantic = await options.catalogSearch(prompt);
    } catch (err) {
      searchNote = `catalog search unavailable (${printable(String(err.message).split("\n")[0])}); matched by words`;
    }
  }
  const { result, catalogAdded, catalogWarnings } = binding
    ? { result: matchedOrExact, catalogAdded: [], catalogWarnings: [] }
    : addCatalogServers(matchedOrExact, { prompt, config, catalog: options.catalog, cheapServers, semantic, searchNote });

  const expensiveMatched = [...new Set((result.servers ?? []).filter((s) => !cheapServers.has(s)))];
  const sessionTools = binding ? [] : activeCatalogTools(prompt, { config, catalog: options.catalog, servers: options.activeServers });

  // A server the task needs but the agent has not configured cannot be escalated: it stays in
  // `servers` and is also annotated in `missing` with what the config knows about installing it,
  // so a wrong installed check degrades to an extra question instead of hiding the server.
  const installed = options.installed ? new Set(options.installed.servers) : null;
  const isMissing = (server) => installed !== null && !installed.has(server);
  const missing = expensiveMatched.filter(isMissing).map((server) => ({
    server,
    install: serverMeta[server]?.install ?? null,
    checkedIn: options.installed.source,
  }));

  return {
    servers: expensiveMatched,
    alwaysOn: [...new Set((result.servers ?? []).filter((s) => cheapServers.has(s)))],
    missing,
    skills: result.skills ?? [],
    commands: result.commands ?? [],
    subagents: result.subagents ?? [],
    reason: result.reason,
    escalations: result.escalations ?? [],
    warnings: [...(result.warnings ?? []), ...catalogWarnings, ...ignoredWarnings(config)],
    binding: binding?.pattern ?? null,
    // Only when the catalog added something: a route without one looks exactly as it did before the catalog existed.
    ...(catalogAdded.length ? { catalog: catalogAdded } : {}),
    // Only when a session asked and a card matched.
    ...(sessionTools.length ? { sessionTools } : {}),
  };
}

// The tools of the cards of servers that are already active (and dynamic, in a toolgate session) that the task matches: these servers
// were chosen before the catalog looked, so `addCatalogServers` never sees them. Nothing is added to the servers, and the cap
// `router.catalogMaxServers` does not apply: the servers are already there.
function activeCatalogTools(prompt, { config, catalog, servers }) {
  if (!catalog?.servers?.size || !Array.isArray(servers) || !servers.length) return [];
  const cards = new Map([...catalog.servers].filter(([server]) => servers.includes(server)));
  if (!cards.size) return [];
  return matchCatalog(prompt, { servers: cards }, { minScore: config?.router?.minScore ?? 0.5, maxServers: cards.size }).map((hit) => ({ server: hit.server, tools: hit.tools }));
}

// Settings a layer is not trusted with are dropped when the layers are merged; the user is told, once per route.
const IGNORED_FIX = "git rm --cached .toolgate/config.local.json, or set it in your user config";
const ignoredWhy = (entry) => (entry.reason === "invalid" || entry.reason === "port" ? invalidWhy(entry.key, entry.reason) : entry.reason === "tracked" ? `the local config is versioned by git, so it ships with the repository (${IGNORED_FIX})` : `${ignoredWhat(entry.key)}; set it in your user or local config`);
export const ignoredWarnings = (config) => (config?.ignored ?? []).map((entry) => `${entry.key} in the ${entry.layer} config is ignored: ${ignoredWhy(entry)}`);

// Servers the catalog finds for the task, after the ones already chosen. It never removes or reorders those, never touches the
// baseline, counts a server once, and stops at `router.catalogMaxServers`. A server the config files do not define is ignored.
function addCatalogServers(result, { prompt, config, catalog, cheapServers, semantic = [], searchNote = null }) {
  if (!catalog?.servers?.size) return { result, catalogAdded: [], catalogWarnings: [] };
  const warnings = [];
  const chosen = new Set(result.servers ?? []);
  const eligible = new Map([...catalog.servers].filter(([server]) => catalog.known.has(server) && !cheapServers.has(server) && !chosen.has(server)));
  const cap = catalogMaxServers(config);
  const byWords = matchCatalog(prompt, { servers: eligible }, { minScore: config?.router?.minScore ?? 0.5, maxServers: cap });
  // What qmd found by meaning comes after what the words found, and only if the catalog this process read has that server.
  const taken = new Set(byWords.map((hit) => hit.server));
  const byMeaning = [...new Map(semantic.filter((hit) => eligible.has(hit.server) && !taken.has(hit.server)).map((hit) => [hit.server, hit])).values()]
    .sort((a, b) => b.score - a.score || (a.server < b.server ? -1 : 1))
    .map((hit) => ({ server: hit.server, score: hit.score, tools: [], semantic: true }));
  const hits = cap > 0 ? [...byWords, ...byMeaning].slice(0, cap) : [];
  const orphans = [...catalog.servers.keys()].filter((server) => !catalog.known.has(server));
  if (orphans.length) warnings.push(`the catalog has entries for servers that are not configured (${orphans.map((s) => printable(s)).join(", ")}): run \`toolgate catalog build\``);
  // Only the servers of the repository's own .mcp.json: the ones of the user's configuration are the user's to build (and may fail to).
  const unknown = [...(catalog.projectKnown ?? catalog.known)].filter((server) => !catalog.servers.has(server) && !cheapServers.has(server));
  if (unknown.length) warnings.push(`the catalog does not know ${unknown.map((s) => printable(s)).join(", ")}: run \`toolgate catalog build\``);
  const oldest = Math.min(...[...catalog.servers.values()].map((entry) => entry.mtimeMs));
  if (catalog.definitionMtime > oldest) warnings.push("the catalog is older than the definitions of the MCP servers: run `toolgate catalog build`");
  if (!hits.length) return { result: searchNote ? { ...result, reason: [result.reason, searchNote].filter(Boolean).join("; ") } : result, catalogAdded: [], catalogWarnings: warnings };
  const why = [...hits.map((hit) => (hit.semantic ? `catalog matched ${printable(hit.server)} by meaning` : `catalog matched ${printable(hit.server)} (tools: ${hit.tools.join(", ")})`)), ...(searchNote ? [searchNote] : [])].join("; ");
  return {
    result: { ...result, servers: [...(result.servers ?? []), ...hits.map((hit) => hit.server)], reason: [result.reason, why].filter(Boolean).join("; ") },
    catalogAdded: hits.map((hit) => ({ server: hit.server, tools: hit.tools })),
    catalogWarnings: warnings,
  };
}
