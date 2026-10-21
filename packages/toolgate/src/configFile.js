// Structured edits of a toolgate config file (`toolgate config set|unset|add|remove`). A command
// reads the JSON, changes only the key it owns, and writes it back with stable formatting, so unknown
// keys survive and diffs stay small. A file that cannot be parsed is never overwritten.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasHiddenChars, parseJson } from "./assets/common.js";
import { RULE_TEXT_WHY } from "./ruleText.js";
import { defaultRegistry } from "./adapters/index.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string" && value !== "";
const stringList = (value) => Array.isArray(value) && value.every(isString);

const oneOf = (...allowed) => ({
  check: (value) => allowed.some((item) => Object.is(item, value)),
  expected: `one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
});

const STRING = { check: isString, expected: "a non-empty string" };
const BOOLEAN = { check: (value) => typeof value === "boolean", expected: "true or false" };
const NUMBER = { check: (value) => typeof value === "number" && Number.isFinite(value), expected: "a number" };
const HTTP_URL_OR_NULL = {
  check: (value) => value === null || isQmdUrl(value),
  expected: "an http or https URL, or null",
  message: (value) => (qmdUrlProblem(value) === "port" ? "router.qmdUrl on this machine must name its port, for example http://localhost:8181/mcp" : "router.qmdUrl must be an http or https URL, or null"),
};
const STRINGS = { check: stringList, expected: "a list of non-empty strings" };

// An element of a list-typed key; `list` marks the key as one `add` and `remove` can work on.
const listOf = (element) => ({
  list: true,
  element,
  check: (value) => Array.isArray(value) && value.every(element.check),
  expected: `a list of ${element.expected}`,
});

// The agent `toolgate "<prompt>"` launches when none is named: one the adapter registry knows.
const AGENT = {
  check: (value) => isString(value) && defaultRegistry.names().includes(value),
  get expected() {
    return `one of ${defaultRegistry.names().map((name) => JSON.stringify(name)).join(", ")}`;
  },
};

const SOURCE = {
  check: (value) =>
    isObject(value) &&
    isString(value.dir) &&
    (value.glob === undefined || isString(value.glob)) &&
    (value.level === undefined || isString(value.level)) &&
    Object.keys(value).every((key) => key === "dir" || key === "glob" || key === "level"),
  expected: 'an object like {"dir": "...", "glob": "...", "level": "..."} (glob and level are optional)',
};

// The fields an override can replace; scan.js applies the same ones.
export const OVERRIDE_FIELDS = ["tags", "mcps", "description"];
const OVERRIDE_KEYS = ["skill", ...OVERRIDE_FIELDS];
// The description is what the router shows for the skill: a bound keeps a long one from taking over.
export const MAX_DESCRIPTION = 500;
// What an override says ends up in index cards and in terminal output: no control characters, line breaks, separators, bidi
// controls, zero-width or other invisible characters, or lone surrogates.
const plain = (text) => !hasHiddenChars(text);
const OVERRIDE = {
  check: (value) =>
    isObject(value) &&
    isString(value.skill) &&
    plain(value.skill) &&
    (value.tags === undefined || (stringList(value.tags) && value.tags.every(plain))) &&
    (value.mcps === undefined || (stringList(value.mcps) && value.mcps.every(plain))) &&
    (value.description === undefined || (isString(value.description) && value.description.length <= MAX_DESCRIPTION && plain(value.description))) &&
    Object.keys(value).every((key) => OVERRIDE_KEYS.includes(key)) &&
    OVERRIDE_FIELDS.some((key) => value[key] !== undefined),
  expected: `an object like {"skill": "...", "tags": ["..."], "mcps": ["..."], "description": "..."} (plain text without control characters; at least one of tags, mcps and description; the description at most ${MAX_DESCRIPTION} characters)`,
};
/** Whether a value of `skills.overrides` has the shape the index can apply. */
export const isValidOverride = OVERRIDE.check;

const RECOMMENDED_KEYS = ["id", "title", "source", "commit", "path", "license", "skills", "exclude", "overrides", "disabled"];
const SOURCE_SPEC = /^(github:[\w.-]+\/[\w.-]+|https:\/\/[^\s/@]+\/\S+)$/;
const hasOnlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
// `{ "id": "...", "disabled": true }` hides an entry of a lower layer and carries nothing else.
const isDisabledEntry = (value) => value.disabled === true && hasOnlyKeys(value, ["id", "disabled"]);
const isFullEntry = (value) =>
  value.disabled === undefined &&
  hasOnlyKeys(value, RECOMMENDED_KEYS) &&
  isString(value.source) &&
  SOURCE_SPEC.test(value.source) &&
  /^[0-9a-f]{40}$/.test(value.commit ?? "") &&
  stringList(value.skills) &&
  value.skills.length > 0 &&
  (value.exclude === undefined || stringList(value.exclude)) &&
  (value.overrides === undefined || (Array.isArray(value.overrides) && value.overrides.every(OVERRIDE.check))) &&
  ["title", "path", "license"].every((key) => value[key] === undefined || isString(value[key]));
const RECOMMENDED = {
  check: (value) => isObject(value) && isString(value.id) && (isDisabledEntry(value) || isFullEntry(value)),
  expected:
    'an object like {"id": "...", "source": "github:owner/repo", "commit": "<40 hex>", "skills": ["..."]}, or {"id": "...", "disabled": true}; the commit must be a full SHA and the source github: or https://',
};

const BINDING = {
  check: (value) =>
    isObject(value) &&
    isString(value.pattern) &&
    (value.skill === undefined || isString(value.skill)) &&
    (value.path === undefined || isString(value.path)) &&
    (value.servers === undefined || stringList(value.servers)) &&
    Object.keys(value).every((key) => ["pattern", "skill", "path", "servers"].includes(key)),
  expected: 'an object like {"pattern": "...", "skill": "...", "path": "...", "servers": ["..."]}',
};

// A commands (or subagents) source also says how its files are written.
const COMMAND_SOURCE = {
  check: (value) =>
    isObject(value) &&
    isString(value.dir) &&
    (value.glob === undefined || isString(value.glob)) &&
    (value.level === undefined || isString(value.level)) &&
    (value.dialect === undefined || isString(value.dialect)) &&
    Object.keys(value).every((key) => ["dir", "glob", "level", "dialect"].includes(key)),
  expected: 'an object like {"dir": "...", "glob": "...", "level": "...", "dialect": "..."} (all but dir are optional)',
};
// `*` stands for any one segment (a server name). Only these keys can be set; a typo is refused
// instead of being written and ignored.
const SCHEMA = new Map([
  ["router.backend", oneOf("qmd", "regex")],
  ["router.minScore", NUMBER],
  ["router.qmdUrl", HTTP_URL_OR_NULL],
  ["rule.template", STRING],
  ["router.skillsCollection", STRING],
  ["router.catalogPath", STRING],
  // No effect any more (the catalog is not a qmd collection): accepted for one release, and `doctor` says so.
  ["router.catalogCollection", STRING],
  ["qmd.bin", { check: isQmdBin, expected: "a command name or an absolute path", message: "qmd.bin must be a command name or an absolute path" }],
  ["qmd.port", { check: (value) => validPort(value) !== null, expected: "a whole number from 1 to 65535" }],
  ["router.catalogMaxServers", { check: (value) => Number.isInteger(value) && value >= 0, expected: "a whole number, 0 or more (0 turns the catalog off for routing)" }],
  ["router.skillsRoots", listOf(STRING)],
  ["router.bindings", listOf(BINDING)],
  ["baseline", listOf(STRING)],
  ["keywords.*", listOf(STRING)],
  ["toolBaselines.*", listOf(STRING)],
  ["client.defersToolSchemas", oneOf(true, false, null)],
  ["client.exclusiveMcp", BOOLEAN],
  ["client.injectRule", BOOLEAN],
  ["defaultAgent", AGENT],
  ["serverMeta.*.tier", oneOf("cheap", "expensive")],
  ["serverMeta.*.install", STRING],
  ["skills.sources", listOf(SOURCE)],
  ["skills.allowedHosts", listOf(STRING)],
  ["skills.overrides", listOf(OVERRIDE)],
  ["skills.recommended", listOf(RECOMMENDED)],
  ["skills.collection", STRING],
  ["skills.corpusDir", STRING],
  ["skills.userLevel", BOOLEAN],
  ["skills.localLevel", BOOLEAN],
  ["commands.sources", listOf(COMMAND_SOURCE)],
  ["commands.userLevel", BOOLEAN],
  ["commands.localLevel", BOOLEAN],
  ["subagents.sources", listOf(COMMAND_SOURCE)],
  ["subagents.baseline", listOf(STRING)],
  ["permissions.userLevel", BOOLEAN],
  ["permissions.localLevel", BOOLEAN],
  ["hooks.userLevel", BOOLEAN],
  ["hooks.localLevel", BOOLEAN],
  ["subagents.userLevel", BOOLEAN],
  ["subagents.localLevel", BOOLEAN],
]);

// The project decides which levels may add skills, so those switches only make sense there.
// Where the user's prompts are sent is not for a repository to choose: these keys do not count in the committed project file.
/**
 * The program toolgate runs as qmd: a command name looked up on PATH (no separator, no whitespace) or an absolute path
 * of the running platform (spaces are fine there), never a relative path. A control character is refused in both forms.
 */
export function isQmdBin(value) {
  if (typeof value !== "string" || value === "" || /[\x00-\x1f\x7f]/.test(value)) return false;
  return path.isAbsolute(value) || (!/[\\/\s]/.test(value) && value !== "." && value !== "..");
}
/**
 * Where the router sends the task text: an http or https URL with a host, no control characters and no leading or trailing
 * whitespace (the URL parser would trim it silently). `null` (daemon off) is checked by the caller.
 */
export function isQmdUrl(value) {
  return qmdUrlProblem(value) === null;
}
/** A TCP port: the value when it is a whole number from 1 to 65535, else null. The one rule for `qmd.port`, `managedPort`, `portOwners` and init. */
export const validPort = (value) => (Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null);
/** The hosts that mean this machine: where toolgate's own daemon runs. */
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * Why a `router.qmdUrl` value is refused: "invalid" (not an http or https URL with a host), "port" (a URL on this machine
 * without a port, or with port 0: toolgate starts its daemon on 8181 for it while the router would call port 80, 443 or 0),
 * or null when it is fine. The URL parser drops a default port (`http://localhost:80`), so that one counts as no port too.
 * @returns {"invalid"|"port"|null}
 */
export function qmdUrlProblem(value) {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return "invalid";
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return "invalid";
    return LOCAL_HOSTS.has(url.hostname) && (url.port === "" || url.port === "0") ? "port" : null;
  } catch {
    return "invalid";
  }
}
/** Why a value a trusted layer wrote is dropped, for the keys whose value can be invalid (the warning and doctor). */
export const invalidWhy = (key, reason = "invalid") =>
  key === "rule.template" ? RULE_TEXT_WHY
    : key === "skills.sources" ? "it must be a list"
      : key !== "router.qmdUrl" ? "it must be a command name or an absolute path" : reason === "port" ? "router.qmdUrl on this machine must name its port, for example http://localhost:8181/mcp" : "it must be an http or https URL, or null";
export const invalidFix = (key) => (key === "router.qmdUrl" ? "<http or https URL, or null>" : key === "rule.template" ? "<path to a text file>" : key === "skills.sources" ? "<list>" : "<command or absolute path>");
const NOT_IN_PROJECT = new Set(["router.qmdUrl", "qmd.bin", "qmd.port", "rule.template", "skills.allowedHosts"]);
/** What a repository must not choose, for the key a layer may not set (the words of the refusal, the warning and doctor). */
export const ignoredWhat = (key) =>
  key === "skills.allowedHosts" ? "a repository must not choose which hosts a lock may name"
    : key === "qmd.port" ? "a repository must not choose which port toolgate manages"
      : key === "qmd.bin" ? "a repository must not choose which program toolgate runs"
        : key === "router.qmdUrl" ? "a repository must not choose where your prompts go"
          : key === "rule.template" ? "a repository must not choose what the agent is told"
            : "a repository must not choose this setting";
const PROJECT_ONLY = new Set(["skills.userLevel", "skills.localLevel", "commands.userLevel", "commands.localLevel", "subagents.userLevel", "subagents.localLevel", "hooks.userLevel", "hooks.localLevel", "permissions.userLevel", "permissions.localLevel"]);

function rule(key) {
  const segments = key.split(".");
  for (const [pattern, spec] of SCHEMA) {
    const parts = pattern.split(".");
    if (parts.length === segments.length && parts.every((part, i) => part === "*" || part === segments[i])) {
      return spec;
    }
  }
  return null;
}

// A strict prefix of a managed key (`skills`, `keywords`): unsetting it would drop every key under it.
function isSection(segments) {
  return [...SCHEMA.keys()].some((pattern) => {
    const parts = pattern.split(".");
    return parts.length > segments.length && segments.every((segment, i) => parts[i] === "*" || parts[i] === segment);
  });
}

function requireRule(key) {
  const spec = rule(key);
  if (!spec) throw new Error(`"${key}" is not a key toolgate manages`);
  return spec;
}

function parseKey(key) {
  const segments = typeof key === "string" ? key.split(".") : [];
  if (segments.length === 0 || segments.some((segment) => segment === "" || ["__proto__", "constructor", "prototype"].includes(segment))) {
    throw new Error(`"${key}" is not a valid key`);
  }
  return segments;
}

/**
 * Like `parseValue`, but a value the key expects as a string stays the raw text when it only
 * happens to parse as another JSON type (`2024`, `true`).
 */
export function parseValueFor(key, action, raw) {
  const parsed = parseValue(raw);
  const spec = rule(key);
  const target = action === "set" ? spec : spec?.element;
  return target && !target.check(parsed) && target.check(raw) ? raw : parsed;
}

/** A command-line value is JSON when it parses as JSON, and the plain string otherwise. */
export function parseValue(raw) {
  try {
    return parseJson(raw);
  } catch {
    return raw;
  }
}

function describeError(key, spec, value) {
  return (typeof spec.message === "function" ? spec.message(value) : spec.message) ?? `${key}: expected ${spec.expected}, got ${JSON.stringify(value)}`;
}

function get(data, segments) {
  return segments.reduce((node, segment) => (isObject(node) && Object.hasOwn(node, segment) ? node[segment] : undefined), data);
}

// Creates the intermediate objects; refuses to descend through a value that is not an object.
function parentOf(data, segments, create) {
  let node = data;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(node, segment)) {
      if (!create) return null;
      node[segment] = {};
    }
    if (!isObject(node[segment])) throw new Error(`${segments.join(".")}: "${segment}" is not an object`);
    node = node[segment];
  }
  return node;
}

// Drops the objects a removal left empty, so unsetting the last key does not leave `{}` behind.
function prune(data, segments) {
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const parent = get(data, segments.slice(0, depth));
    if (isObject(parent) && Object.keys(parent).length === 0) {
      delete get(data, segments.slice(0, depth - 1))[segments[depth - 1]];
    }
  }
}

/**
 * Applies one command to parsed config data. Returns whether anything changed.
 * @param {Object} data Mutated in place.
 * @param {{ action: "set" | "unset" | "add" | "remove", key: string, value?: unknown, layer?: string }} change
 * @returns {boolean}
 */
export function applyChange(data, { action, key, value, layer = "project" }) {
  const segments = parseKey(key);
  // A value a hostile repository put there can only be removed by hand if unset were refused too: unset is always allowed.
  if (NOT_IN_PROJECT.has(key) && layer === "project" && action !== "unset") {
    throw new Error(`${key} is ignored in the project layer (${ignoredWhat(key)}); use --user or --local`);
  }
  if (PROJECT_ONLY.has(key) && layer !== "project") {
    throw new Error(`${key} only counts in the project layer; set it there`);
  }

  if (action === "unset") {
    if (isSection(segments)) throw new Error(`${key} is a whole section; unset one of its keys`);
    const parent = parentOf(data, segments, false);
    const last = segments.at(-1);
    if (!parent || !Object.hasOwn(parent, last)) return false;
    delete parent[last];
    prune(data, segments);
    return true;
  }

  const spec = requireRule(key);

  if (action === "set") {
    if (!spec.check(value)) throw new Error(describeError(key, spec, value));
    const parent = parentOf(data, segments, true);
    const last = segments.at(-1);
    if (isDeepStrictEqual(parent[last], value)) return false;
    parent[last] = value;
    return true;
  }

  if (!spec.list) throw new Error(`${key} is not a list; use "config set"`);
  if (!spec.element.check(value)) throw new Error(describeError(key, { expected: spec.element.expected }, value));
  const current = get(data, segments);
  if (current !== undefined && !Array.isArray(current)) throw new Error(`${key}: the current value is not a list`);
  const items = current ?? [];

  if (action === "add") {
    if (items.some((item) => isDeepStrictEqual(item, value))) return false;
    parentOf(data, segments, true)[segments.at(-1)] = [...items, value];
    return true;
  }
  if (action === "remove") {
    const kept = items.filter((item) => !isDeepStrictEqual(item, value));
    if (kept.length === items.length) return false;
    if (kept.length > 0) {
      parentOf(data, segments, true)[segments.at(-1)] = kept;
    } else {
      delete parentOf(data, segments, false)[segments.at(-1)];
      prune(data, segments);
    }
    return true;
  }
  throw new Error(`unknown action "${action}"`);
}

const MAX_INLINE = 80;

const isPrimitive = (value) => value === null || typeof value !== "object";

// Two-space JSON. Short lists of primitives stay on one line, the way people write config by hand,
// so the first managed write does not reflow a file that was already tidy.
export function formatConfig(value, indent = "") {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    if (value.every(isPrimitive) && indent.length + inline.length <= MAX_INLINE) return inline;
    const inner = `${indent}  `;
    return `[\n${value.map((item) => `${inner}${formatConfig(item, inner)}`).join(",\n")}\n${indent}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((key) => `${inner}${JSON.stringify(key)}: ${formatConfig(value[key], inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

// Hooks, `git rebase --exec` and `git bisect run` run with GIT_DIR and friends set, and GIT_DIR wins over `-C`: the question
// would be asked of another repository. Nothing that picks a repository, an index or a work tree is passed on.
const withoutGitVariables = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

/**
 * A config file that git tracks but the working tree lacks was most likely deleted by accident: creating a new one
 * would hide that behind a fresh file with defaults. Asks the repository the file belongs to (the nearest existing folder
 * above it, so a deleted `.toolgate/` is found too); no repository, no git, or any doubt means "not tracked".
 * @param {string} file
 * @param {{ execFn?: Function }} [options]
 */
export function trackedAndMissing(file, { execFn = execFileSync } = {}) {
  try {
    if (fs.lstatSync(file, { throwIfNoEntry: false })) return false;
  } catch {
    return false; // a parent that is not a folder (ENOTDIR) and the like: the write will say what is wrong
  }
  return gitTracks(file, execFn, false);
}

/**
 * Whether git versions an existing file. Unlike `trackedAndMissing` this guards trust: when git cannot answer (missing,
 * timed out) the file counts as versioned, so what it says is ignored rather than believed. A repository that git
 * reports as "not tracked" (exit 1) is a definite no; "not a repository" (128) is one only when no `.git` exists in the folder or above.
 * @param {string} file
 * @param {{ execFn?: Function }} [options]
 */
/**
 * Whether git ignores `file` (a generated file: rulesync's output). Only a clear yes counts: when git does not answer, or the
 * folder is not a repository, the file is not taken as ignored, so a warning about it is kept.
 */
export function isIgnored(file, { execFn = execFileSync } = {}) {
  const dir = path.dirname(file);
  try {
    execFn("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, "check-ignore", "-q", "--", path.basename(file)], { stdio: "ignore", timeout: 10000, env: withoutGitVariables() });
    return true;
  } catch {
    return false;
  }
}

export function isTracked(file, { execFn = execFileSync } = {}) {
  return gitTracks(file, execFn, true);
}

// `onDoubt` is the answer when git could not be asked at all, or answered "not a repository" (128) while a `.git` entry exists
// in the folder or above it: a damaged or hostile `.git` (corrupt index, bad config, `gitdir:` to nowhere) is not proof of "unversioned".
// A repository we do not trust may configure programs that git runs for any command, so those are switched off.
function gitTracks(file, execFn, onDoubt) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    execFn("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, "ls-files", "--error-unmatch", "--", path.relative(dir, file)], { stdio: "ignore", timeout: 10000, env: withoutGitVariables() });
    return true;
  } catch (error) {
    if (typeof error?.status !== "number") return onDoubt;
    if (error.status === 1) return false; // git answered: this file is not tracked
    if (error.status === 128) return onDoubt === true ? hasGitEntry(dir) : false;
    return onDoubt; // any other code (a usage error, a crash) is not an answer
  }
}

function hasGitEntry(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.lstatSync(path.join(current, ".git"), { throwIfNoEntry: false })) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** The line that says a tracked config is missing and how to get it back. */
export const restoreHint = (file, cwd) => {
  const shown = path.relative(cwd, file) || file;
  return `${shown} is tracked by git but missing here; restore it with: git restore ${shown} (or pass --force to create a new one)`;
};

/**
 * @param {string} file
 * @returns {{ data: Object, exists: boolean }}
 * @throws when the file exists but is not a JSON object: it must never be overwritten.
 */
export function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { data: {}, exists: false };
    throw new Error(`${file}: ${err.message}`);
  }
  let data;
  try {
    data = parseJson(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON and was left untouched (${err.message})`);
  }
  if (!isObject(data)) throw new Error(`${file} does not hold a JSON object and was left untouched`);
  return { data, exists: true };
}

// The user's own config, kept in a dotfiles folder and linked into place, is edited where it points: replacing the link would cut it
// off from the file it stands for. Only there: a link in a repository (the project and local configs) is replaced, never written
// through, because a cloned repository could aim it at any JSON file of the user's. A link to nothing is left alone and said.
function writeTarget(file, followLinks) {
  if (!followLinks || !fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return file;
  try {
    return fs.realpathSync(file);
  } catch {
    throw new Error(`${file} is a link to a file that does not exist, and was left untouched`);
  }
}
export function writeConfigFile(file, data, { followLinks = false } = {}) {
  const target = writeTarget(file, followLinks);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write beside the target and rename, so a crash never leaves a truncated config behind.
  // A name nobody can guess, created only if it does not exist: a link planted at a predictable name is never written through.
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    // The file keeps the mode it had (0600 stays 0600, a read-only one stays read-only), from the first byte; a new one gets the usual default.
    const mode = fs.statSync(target, { throwIfNoEntry: false })?.mode;
    fs.writeFileSync(temp, `${formatConfig(data)}\n`, { flag: "wx", ...(mode === undefined ? {} : { mode: mode & 0o7777 }) });
    if (mode !== undefined) fs.chmodSync(temp, mode & 0o7777);
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Reads, changes and writes one config file. Nothing is written when the change is a no-op.
 * @returns {{ changed: boolean, created: boolean }}
 */
export function editConfigFile(file, change) {
  const { data, exists } = readConfigFile(file);
  const changed = applyChange(data, change);
  if (changed) writeConfigFile(file, data, { followLinks: change.layer === "user" });
  return { changed, created: changed && !exists };
}

/**
 * The `skills.overrides` list of a parsed config and the entries of it that name `skill`.
 * @param {Record<string, any>} data
 */
export function overridesFor(data, skill) {
  const list = Array.isArray(data.skills?.overrides) ? data.skills.overrides : [];
  return { list, mine: list.filter((entry) => entry?.skill === skill) };
}
