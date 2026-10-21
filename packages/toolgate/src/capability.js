// Client capability model (SPEC §5 / DESIGN "Client capability model").
// Every adapter declares its target client's tool-loading behavior as static
// metadata (`defersToolSchemas`); config may override it. That boolean maps to
// one of two classes, and each class carries the behavior the orchestrator
// branches on.
import path from "node:path";

/**
 * @typedef {"DEFERRED" | "LAUNCHED"} ClientClass
 * @typedef {Object} ClassBehavior
 * @property {boolean} defersToolSchemas Tool schemas cost ~0 context at launch.
 * @property {boolean} filterTools Per-tool allow-list filtering is a context win.
 * @property {boolean} route Run the server router for this class.
 * @property {string} summary One-line description of toolgate's value here.
 */

export const CLIENT_CLASS = Object.freeze({
  /** Client defers tool schema resolution to the proxy (e.g. Claude Code tool search). */
  DEFERRED: "DEFERRED",
  /** Client loads all tool schemas at launch; per-tool filtering saves tokens. */
  LAUNCHED: "LAUNCHED",
});

/** @type {Readonly<Record<ClientClass, ClassBehavior>>} */
export const CLASS_BEHAVIOR = Object.freeze({
  DEFERRED: Object.freeze({
    defersToolSchemas: true,
    filterTools: false,
    route: true,
    summary: "Defers tool schemas; value is server routing and cost deferral.",
  }),
  LAUNCHED: Object.freeze({
    defersToolSchemas: false,
    filterTools: true,
    route: false,
    summary: "Loads all tool schemas at launch; per-tool filtering saves tokens.",
  }),
});

/**
 * Resolve the effective client class from the adapter's static default and an
 * optional config override (`client.defersToolSchemas`).
 * @param {boolean} adapterDefersToolSchemas Adapter capability metadata.
 * @param {boolean|null} [override] Config override; null/undefined = use default.
 * @returns {ClientClass}
 */
export function resolveClientClass(adapterDefersToolSchemas, override) {
  const defers = override ?? adapterDefersToolSchemas;
  return defers ? CLIENT_CLASS.DEFERRED : CLIENT_CLASS.LAUNCHED;
}

/**
 * Look up the behavior descriptor for a class, failing loudly on unknown input.
 * @param {ClientClass} clientClass
 * @returns {ClassBehavior}
 */
export function classBehavior(clientClass) {
  const behavior = CLASS_BEHAVIOR[clientClass];
  if (!behavior) throw new Error(`Unknown client class "${clientClass}"`);
  return behavior;
}

// Adapter capability schema (docs/ADAPTERS.md). Every field takes `"unknown"` when the agent's
// behavior has not been verified: it is reported as such and never guessed.
export const UNKNOWN = "unknown";
export const RULES_KINDS = Object.freeze(["none", "projectFile", "launchInjection", UNKNOWN]);
export const LAUNCH_GATING = Object.freeze(["none", "settingsFlag", "configFile", "flagOverrides", UNKNOWN]);
export const PASSTHROUGH = Object.freeze(["args", UNKNOWN]);
export const COMMANDS_KINDS = Object.freeze(["none", "nativeDir", UNKNOWN]);
export const COMMAND_FORMATS = Object.freeze(["markdown"]);
export const COMMAND_DIALECTS = Object.freeze(["claude", "opencode", "codex", "antigravity", "rulesync"]);
export const SUBAGENTS_KINDS = Object.freeze(["none", "launchFlag", "projectDir", UNKNOWN]);
export const APPLYING_KINDS = Object.freeze(["none", "settingsFlag", "configEnv", UNKNOWN]);
const BOOLEAN_FIELDS = ["defersToolSchemas", "exclusiveMcpConfig", "dynamicTools"];
const FIELDS = new Set([...BOOLEAN_FIELDS, "rules", "launchGating", "resume", "passthrough", "commands", "subagents", "hooks", "permissions"]);

const isTriState = (value) => typeof value === "boolean" || value === UNKNOWN;

/**
 * Validate a capability object, returning every problem found (empty when valid).
 * @param {object} capability
 * @returns {string[]}
 */
export function validateCapability(capability) {
  if (!capability || typeof capability !== "object") return ["capability must be an object"];
  const problems = [];
  if (!Object.isFrozen(capability)) problems.push("capability must be frozen (Object.freeze)");
  for (const key of Object.keys(capability)) {
    if (!FIELDS.has(key)) problems.push(`unknown capability "${key}"`);
  }
  if (typeof capability.defersToolSchemas !== "boolean") problems.push("defersToolSchemas must be a boolean");
  for (const field of ["exclusiveMcpConfig", "dynamicTools"]) {
    if (!isTriState(capability[field])) problems.push(`${field} must be a boolean or "${UNKNOWN}"`);
  }
  const rules = capability.rules;
  if (!RULES_KINDS.includes(rules?.kind)) problems.push(`rules.kind must be one of ${RULES_KINDS.join(", ")}`);
  else if (rules.kind === "projectFile" && (typeof rules.path !== "string" || !rules.path)) {
    problems.push("rules.kind projectFile requires a rules.path");
  }
  if (rules?.injectFlag !== undefined && (!["projectFile", "launchInjection"].includes(rules.kind) || typeof rules.injectFlag !== "string" || !/^--[a-z][a-z-]*$/.test(rules.injectFlag))) {
    problems.push("rules.injectFlag must be a command-line flag like --append-system-prompt, on a projectFile or launchInjection rules kind");
  }
  if (rules?.injectConfigKey !== undefined && (!["projectFile", "launchInjection"].includes(rules.kind) || typeof rules.injectConfigKey !== "string" || !/^[a-z][a-z_]*$/.test(rules.injectConfigKey))) {
    problems.push("rules.injectConfigKey must be an agent config key like developer_instructions, on a projectFile or launchInjection rules kind");
  }
  if (rules?.injectFlag !== undefined && rules?.injectConfigKey !== undefined) problems.push("rules.injectFlag and rules.injectConfigKey are alternatives: use one");
  if (!LAUNCH_GATING.includes(capability.launchGating)) {
    problems.push(`launchGating must be one of ${LAUNCH_GATING.join(", ")}`);
  }
  if (!PASSTHROUGH.includes(capability.passthrough)) problems.push(`passthrough must be one of ${PASSTHROUGH.join(", ")}`);
  const resume = capability.resume;
  if (!resume || !isTriState(resume.supported)) {
    problems.push(`resume.supported must be a boolean or "${UNKNOWN}"`);
  } else if (resume.supported === true && (typeof resume.arg !== "string" || !resume.arg)) {
    problems.push("resume.supported requires a resume.arg");
  }
  if (capability.commands !== undefined) problems.push(...commandsProblems(capability.commands));
  if (capability.subagents !== undefined) problems.push(...subagentsProblems(capability.subagents));
  // How the approved hooks and the permissions reach the agent: a kind alone, from a short list.
  for (const field of ["hooks", "permissions"]) {
    const value = capability[field];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "kind")) problems.push(`${field} must be an object with only a kind`);
    else if (!APPLYING_KINDS.includes(value.kind)) problems.push(`${field}.kind must be one of ${APPLYING_KINDS.join(", ")}`);
    else if (field === "hooks" && value.kind === "configEnv") problems.push("hooks.kind configEnv is not supported: only permissions can go in an inline config");
  }
  return problems;
}

// A folder is a plain relative path inside the project or the home directory.
const isRelativeDir = (dir) => typeof dir === "string" && dir !== "" && path.posix.normalize(dir) !== "." && !dir.includes("\\") && !dir.split("/").some((part) => part === ".." || part === "") && !dir.startsWith("/") && !/^[A-Za-z]:/.test(dir);

// How an adapter registers subagents at launch: nothing, a command-line flag, or a folder the agent reads.
function subagentsProblems(subagents) {
  if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return ["subagents must be an object"];
  if (!SUBAGENTS_KINDS.includes(subagents.kind)) return [`subagents.kind must be one of ${SUBAGENTS_KINDS.join(", ")}`];
  const allowed = { launchFlag: ["kind", "flag"], projectDir: ["kind", "dialect", "dir"] }[subagents.kind] ?? ["kind"];
  const problems = Object.keys(subagents).filter((key) => !allowed.includes(key)).map((key) => `subagents.kind ${subagents.kind} does not take "${key}"`);
  if (subagents.kind === "launchFlag" && !(typeof subagents.flag === "string" && /^--[a-z][a-z-]*$/.test(subagents.flag))) problems.push("subagents.flag must be a command-line flag like --agents");
  if (subagents.kind === "projectDir") {
    if (!isRelativeDir(subagents.dir)) problems.push("subagents.dir must be a relative folder inside the project");
    if (!["claude", "opencode"].includes(subagents.dialect)) problems.push("subagents.dialect must be claude or opencode");
  }
  return problems;
}

function commandsProblems(commands) {
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) return ["commands must be an object"];
  if (!COMMANDS_KINDS.includes(commands.kind)) return [`commands.kind must be one of ${COMMANDS_KINDS.join(", ")}`];
  if (commands.kind !== "nativeDir") return Object.keys(commands).length > 1 ? [`commands.kind ${commands.kind} takes no other field`] : [];
  const problems = [];
  if (!COMMAND_DIALECTS.includes(commands.dialect)) problems.push(`commands.dialect must be one of ${COMMAND_DIALECTS.join(", ")}`);
  if (!COMMAND_FORMATS.includes(commands.format)) problems.push(`commands.format must be one of ${COMMAND_FORMATS.join(", ")}`);
  for (const field of ["projectDirs", "userDirs"]) {
    const list = commands[field];
    if (!Array.isArray(list) || !list.every(isRelativeDir)) problems.push(`commands.${field} must be a list of relative folders inside the ${field === "projectDirs" ? "project" : "home folder"}`);
  }
  if (!problems.length && commands.projectDirs.length + commands.userDirs.length === 0) problems.push("commands.kind nativeDir needs at least one folder");
  for (const key of Object.keys(commands)) {
    if (!["kind", "dialect", "format", "projectDirs", "userDirs"].includes(key)) problems.push(`unknown commands field "${key}"`);
  }
  return problems;
}

const GATES = new Set(["settingsFlag", "configFile", "flagOverrides"]);
const readsRules = (capability) => ["projectFile", "launchInjection"].includes(capability.rules?.kind);

/**
 * Support tier an agent reaches (each includes the one before): 0 none, 1 skills on demand,
 * 2 servers on demand at launch, 3 automatic restart, 4 mid-session reveal.
 * @param {object} capability
 * @returns {0|1|2|3|4}
 */
export function computeTier(capability) {
  if (!readsRules(capability)) return 0;
  if (!GATES.has(capability.launchGating)) return 1;
  if (capability.resume?.supported !== true) return 2;
  if (capability.dynamicTools !== true) return 3;
  return 4;
}

const RAISE = [
  (c) => (readsRules(c) ? null : rulesHint(c)),
  (c) => (GATES.has(c.launchGating) ? null : gateHint(c)),
  (c) => (c.resume?.supported === true ? null : stateHint(c.resume?.supported, "resume the last session")),
  (c) => (c.dynamicTools === true ? null : stateHint(c.dynamicTools, "honor tools/list_changed")),
];

const rulesHint = (c) => stateHint(c.rules?.kind === UNKNOWN ? UNKNOWN : false, "read a rules file the Step 0 rule can go in");
const gateHint = (c) => stateHint(c.launchGating === UNKNOWN ? UNKNOWN : false, "apply MCP servers at launch");
const stateHint = (state, what) => (state === UNKNOWN ? `unknown whether the agent can ${what}` : `needs an agent that can ${what}`);

/**
 * What would raise the tier by one, or null at the top. Says "unknown" rather than guessing.
 * @param {object} capability
 * @returns {string|null}
 */
export function whatWouldRaise(capability) {
  const tier = computeTier(capability);
  return tier >= 4 ? null : RAISE[tier](capability);
}
