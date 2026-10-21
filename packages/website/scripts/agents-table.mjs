// Writes docs/agents.md: what each agent supports, per level, read from the `capability` object of every adapter registered in
// packages/toolgate/src/adapters/index.js. The code is the only source: the page is generated, ignored by git, and made again
// before every build (`predocs:build`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
export const AGENTS_PAGE = path.join(repoRoot, "docs", "agents.md");

const code = (text) => `\`${text}\``;
const list = (items) => items.map(code).join(", ");
// A kind this script does not know is shown as it is, so a new one is visible instead of silently missing.
const raw = (value) => (value === undefined ? "unknown" : code(String(value)));
const cell = (text) => String(text).replaceAll("|", "\\|").replaceAll("\n", " ");

const tri = (value, yes, no) => (value === true ? yes : value === false ? no : "unknown");

function rules({ rules: r = {} }) {
  if (r.kind === "none") return "none";
  if (r.kind === "unknown") return "unknown";
  const file = r.kind === "projectFile" ? code(r.path) : raw(r.kind);
  const launch = r.injectFlag ? ` and, with \`client.injectRule\`, at launch with ${code(r.injectFlag)}` : r.injectConfigKey ? ` and, with \`client.injectRule\`, at launch with ${code(`-c ${r.injectConfigKey}`)}` : "";
  return `${file}${launch}`;
}

function commands({ commands: c = {} }) {
  if (c.kind === "none") return "none";
  if (c.kind === "unknown") return "unknown";
  if (c.kind !== "nativeDir") return raw(c.kind);
  const where = [c.projectDirs.length ? `project: ${list(c.projectDirs)}` : "", c.userDirs.length ? `user: ${list(c.userDirs)}` : ""].filter(Boolean);
  return where.join("; ") || "none";
}

function subagents({ subagents: s = {} }) {
  if (s.kind === "none") return "none";
  if (s.kind === "unknown") return "unknown";
  if (s.kind === "launchFlag") return `at launch with ${code(s.flag)}`;
  if (s.kind === "projectDir") return `files in ${code(s.dir)}`;
  return raw(s.kind);
}

function applied(entry = {}) {
  const kind = entry.kind;
  if (kind === "none") return "none";
  if (kind === "unknown") return "unknown";
  if (kind === "settingsFlag") return "in the launch settings";
  if (kind === "configEnv") return "in the launch config";
  return raw(kind);
}

const GATING = {
  settingsFlag: "launch settings (`--settings`)",
  flagOverrides: "launch flags (`-c`)",
  configFile: "a config file made for the launch",
  none: "none",
};
const gating = ({ launchGating }) => GATING[launchGating] ?? raw(launchGating);

const resume = ({ resume: r = {} }) => (r.supported === true ? code(r.arg) : tri(r.supported, "", "no"));

const TABLES = [
  {
    title: "Rules and tools",
    head: ["Agent", "Step 0 rule", "Tool schemas", "Servers per launch", "Exclusive MCP config"],
    row: (c) => [rules(c), c.defersToolSchemas ? "deferred (tool search)" : "loaded at launch", gating(c), tri(c.exclusiveMcpConfig, "yes", "no")],
  },
  {
    title: "Commands, subagents, hooks and permissions",
    head: ["Agent", "Commands", "Subagents", "Hooks", "Permissions"],
    row: (c) => [commands(c), subagents(c), applied(c.hooks), applied(c.permissions)],
  },
  {
    title: "Session",
    head: ["Agent", "Resume", "Tools change mid-session"],
    row: (c) => [resume(c), tri(c.dynamicTools, "yes", "no")],
  },
];

/**
 * The page for these adapters.
 * @param {Array<{ name: string, capability: object }>} adapters
 * @returns {string}
 */
export function agentsPage(adapters) {
  const lines = [
    "---",
    "title: Agents",
    "---",
    "",
    "# Agents",
    "",
    "What each agent supports, per level. This page is generated from the `capability` of every adapter in the code, so it cannot drift from it. `unknown` means no adapter has verified it. To add an agent or read the contract, see [ADAPTERS](./ADAPTERS).",
    "",
  ];
  for (const table of TABLES) {
    lines.push(`## ${table.title}`, "", `| ${table.head.join(" | ")} |`, `| ${table.head.map(() => "---").join(" | ")} |`);
    for (const { name, capability } of adapters) lines.push(`| ${[code(name), ...table.row(capability)].map(cell).join(" | ")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Every adapter of the registry, in its order. */
export async function registeredAdapters() {
  const { defaultRegistry } = await import(pathToFileURL(path.join(repoRoot, "packages", "toolgate", "src", "adapters", "index.js")).href);
  return Promise.all(defaultRegistry.names().map(async (name) => ({ name, capability: (await defaultRegistry.get(name)).capability })));
}

// Run directly (not imported): compared by real path, so a linked folder (/tmp on macOS) does not make it a silent no-op.
// argv[1] may be no file at all (`node -e`, a user argument), which counts as imported.
function runDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (process.argv[1] && runDirectly()) {
  fs.writeFileSync(AGENTS_PAGE, agentsPage(await registeredAdapters()));
}
