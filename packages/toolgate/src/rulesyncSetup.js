// What `toolgate init` decides about rulesync: which agents become its targets, the root rule it needs, and which of the
// files it generates belong in .gitignore. Nothing here runs rulesync, and no file of the user's is ever edited.
import fs from "node:fs";
import path from "node:path";
import { printable } from "./assets/common.js";

// The rulesync target of each toolgate agent that has one. `generic` and `karajan` are not rulesync targets.
export const RULESYNC_TARGET = Object.freeze({
  "claude-code": "claudecode",
  codex: "codexcli",
  opencode: "opencode",
  antigravity: "antigravity-cli",
});

// The project files each agent reads (AGENTS.md is shared by several).
const AGENT_FILES = Object.freeze({
  "claude-code": ["CLAUDE.md"],
  codex: ["AGENTS.md"],
  opencode: ["AGENTS.md"],
  antigravity: ["AGENTS.md", "GEMINI.md"],
});

// The order in which an existing file becomes the root rule.
export const ROOT_SOURCES = Object.freeze(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
// Which agent a file that is not the root is restricted to when it is imported as a rule of its own.
const SOURCE_TARGET = Object.freeze({ "AGENTS.md": "agentsmd", "CLAUDE.md": "claudecode", "GEMINI.md": "antigravity-cli" });
const MAX_SOURCE_BYTES = 256 * 1024;

export const OVERVIEW_FILE = path.join(".rulesync", "rules", "overview.md");
const OVERVIEW_HEADER = '---\nroot: true\ntargets: ["*"]\ndescription: "Project overview (created by toolgate init)"\n---\n\n';
export const MINIMAL_OVERVIEW =
  `${OVERVIEW_HEADER}# Project overview\n\n<!-- TODO(toolgate init): review and complete this file; rulesync needs a root rule. -->\n\n` +
  "Describe here what the project is, how to build and test it, and its conventions.\n";

// What `rulesync generate` writes for a target, measured with rulesync 14.2.0. A path is listed only if the target owns it.
const GENERATED = Object.freeze({
  claudecode: [path.join(".claude", "rules", "toolgate-router.md"), path.join(".claude", "rules", "claude-md.md"), "CLAUDE.md"],
  codexcli: ["AGENTS.md"],
  opencode: ["AGENTS.md", ".opencode/memories/toolgate-router.md", "opencode.jsonc"],
  "antigravity-cli": ["AGENTS.md", ".agents/rules/toolgate-router.md", ".agents/rules/gemini-md.md"],
});

// lstat, so that a dangling link counts as something being there.
const exists = (file) => fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/** The first of `.rulesync` and `.rulesync/rules` that exists and is a link or not a folder (nothing is written through it), or null. */
export function linkedRulesyncDir(cwd) {
  for (const rel of [".rulesync", path.join(".rulesync", "rules")]) {
    const info = fs.lstatSync(path.join(cwd, rel), { throwIfNoEntry: false });
    if (info && !info.isDirectory()) return rel.split(path.sep).join("/");
  }
  return null;
}

/** A regular file of the project (a link, a directory or something huge is not read). */
function regularFile(cwd, rel) {
  const file = path.join(cwd, rel);
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= MAX_SOURCE_BYTES ? file : null;
  } catch {
    return null;
  }
}

/** The agent files the project has, in ROOT_SOURCES order. */
export function projectAgentFiles(cwd) {
  return ROOT_SOURCES.filter((rel) => regularFile(cwd, rel));
}

/**
 * The agents rulesync can write for. Only an installed agent is preselected; the file it reads in the project, when there
 * is one, only says where the preselection comes from. An agent that is not installed is listed with no reasons.
 * @param {{ cwd: string, installed: string[], registryNames: string[] }} options
 * @returns {{ agent: string, target: string, reasons: string[] }[]} every supported agent, in `registryNames` order
 */
export function targetChoices({ cwd, installed, registryNames }) {
  const files = projectAgentFiles(cwd);
  return registryNames
    .filter((agent) => RULESYNC_TARGET[agent])
    .map((agent) => ({
      agent,
      target: RULESYNC_TARGET[agent],
      reasons: installed.includes(agent) ? ["installed", ...AGENT_FILES[agent].filter((file) => files.includes(file))] : [],
    }));
}

/** The front matter of a rule file as simple `key: value` lines (no YAML dependency). */
function frontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => /^([A-Za-z_]+):\s*(.*)$/.exec(line)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
}

/** The rule files of the project that rulesync takes as a root, by name. */
export function findRoots(cwd) {
  const dir = path.join(cwd, ".rulesync", "rules");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".md")).filter((name) => {
    try {
      return frontMatter(fs.readFileSync(path.join(dir, name), "utf8")).root === "true";
    } catch {
      return false;
    }
  });
}

const slug = (rel) => rel.replace(/\.md$/i, "").toLowerCase() + "-md";

/**
 * Makes sure rulesync has exactly one root rule, from the agent files the project already has. The originals are only
 * read. An existing root stops the import; a file whose text differs from the root becomes a rule of its own agent.
 * @returns {{ lines: string[], notes: string[], imported: string[] }} `imported` lists the source files read
 */
export function ensureRoot({ cwd, dryRun = false }) {
  const say = (verb, past = `${verb}d`) => (dryRun ? `would ${verb}` : past);
  const linked = linkedRulesyncDir(cwd);
  if (linked) return { lines: [], notes: [`${linked} is a link or not a folder, so no root rule was written or imported`], imported: [] };
  const roots = findRoots(cwd);
  if (roots.length > 0) {
    return { lines: [`kept the root rule ${roots.map((name) => `.rulesync/rules/${printable(name)}`).join(", ")} (nothing imported)`], notes: [], imported: [] };
  }
  const sources = projectAgentFiles(cwd).map((rel) => ({ rel, text: fs.readFileSync(path.join(cwd, rel), "utf8") }));
  if (sources.length === 0 && !exists(path.join(cwd, OVERVIEW_FILE))) {
    writeIfMissing(path.join(cwd, OVERVIEW_FILE), MINIMAL_OVERVIEW, dryRun);
    return { lines: [`${say("create")} ${OVERVIEW_FILE.split(path.sep).join("/")} (root: true)`], notes: [`review ${OVERVIEW_FILE.split(path.sep).join("/")}: it is the minimal root rule toolgate created, with nothing about your project yet`], imported: [] };
  }
  if (exists(path.join(cwd, OVERVIEW_FILE))) {
    return { lines: [], notes: [`${OVERVIEW_FILE.split(path.sep).join("/")} exists but is not a root rule, so the agent files were not imported: add \`root: true\` to its front matter, or move it`], imported: [] };
  }
  const [first, ...rest] = ROOT_SOURCES.map((rel) => sources.find((source) => source.rel === rel)).filter(Boolean);
  const lines = [];
  writeIfMissing(path.join(cwd, OVERVIEW_FILE), OVERVIEW_HEADER + first.text, dryRun);
  lines.push(`${say("import", "imported")} ${first.rel} as the root rule ${OVERVIEW_FILE.split(path.sep).join("/")} (${first.rel} is not changed)`);
  for (const other of rest) {
    if (other.text === first.text) continue;
    const rule = path.join(".rulesync", "rules", `${slug(other.rel)}.md`);
    const header = `---\ntargets: ["${SOURCE_TARGET[other.rel]}"]\ndescription: "Imported from ${other.rel} by toolgate init"\n---\n\n`;
    if (exists(path.join(cwd, rule)) || !writeIfMissing(path.join(cwd, rule), header + other.text, dryRun)) {
      lines.push(`kept ${rule.split(path.sep).join("/")} (it exists, ${other.rel} was not imported)`);
      continue;
    }
    lines.push(`${say("import", "imported")} ${other.rel} as the rule ${rule.split(path.sep).join("/")}, for ${SOURCE_TARGET[other.rel]} only (${other.rel} is not changed)`);
  }
  return { lines, notes: [], imported: sources.map((source) => source.rel) };
}

function writeIfMissing(file, content, dryRun) {
  if (exists(file)) return false;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, content, { flag: "wx" });
    } catch (err) {
      if (err.code === "EEXIST") return false;
      throw err;
    }
  }
  return true;
}

/** What `rulesync generate` is going to rewrite of the user's own files, for the note that warns before it is run. */
export function rewriteWarning({ cwd, targets, isIgnoredFn = () => false }) {
  // A file git ignores is rulesync's own output from an earlier run, not text of yours it would overwrite.
  const rewritten = [...new Set(targets.flatMap((id) => GENERATED[id] ?? []))].filter((rel) => projectAgentFiles(cwd).includes(rel) && !isIgnoredFn(path.join(cwd, rel)));
  return rewritten.length === 0 ? null : `\`rulesync generate\` will rewrite ${rewritten.join(", ")} (their text is kept in .rulesync/rules/); review the result with git diff, and commit or back up a file git does not track first`;
}

/** The file `rulesync generate` writes for the Step 0 rule (toolgate-router.md) for a target, or null when the target has none. */
const generatedStep0 = (target) => GENERATED[target]?.find((rel) => rel.endsWith("toolgate-router.md")) ?? null;
const STEP0_TARGETS = Object.keys(GENERATED).filter((target) => generatedStep0(target) !== null);
/**
 * The text between the brackets of the first `"targets": [ ... ]` of a rulesync.jsonc, or null. One pass with indexOf and no
 * backtracking: a committed file of a cloned repository is untrusted, and a pattern with a nested scan took seconds on 256 KB.
 */
function targetsList(text) {
  const KEY = '"targets"';
  for (let at = text.indexOf(KEY); at !== -1; at = text.indexOf(KEY, at + KEY.length)) {
    let i = at + KEY.length;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] !== ":") continue;
    i++;
    while (/\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "[") continue;
    const end = text.indexOf("]", i + 1);
    // No `]` after this one means none after any later one either.
    return end === -1 ? null : text.slice(i + 1, end);
  }
  return null;
}
/**
 * The targets of rulesync.jsonc (`*` is every target with a Step 0 file) for which `rulesync generate` has not written the
 * Step 0 rule yet. A missing, unreadable or list-less rulesync.jsonc gives none: there is nothing to check. The file is
 * JSONC and belongs to the user, so only its `"targets"` list is read, with no parser.
 * @returns {string[]}
 */
export function step0NotGenerated(cwd) {
  const file = regularFile(cwd, "rulesync.jsonc");
  if (file === null) return [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const list = targetsList(text);
  if (list === null) return [];
  const named = [...list.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  const wanted = named.includes("*") ? STEP0_TARGETS : named.filter((target) => STEP0_TARGETS.includes(target));
  return [...new Set(wanted)].filter((target) => !exists(path.join(cwd, generatedStep0(target))));
}
/** Warns when an existing rulesync.jsonc has `"delete": true`, which makes `generate` remove files no rule owns. */
export function deleteWarning(cwd) {
  try {
    const text = fs.readFileSync(path.join(cwd, "rulesync.jsonc"), "utf8");
    return /"delete"\s*:\s*true/.test(text) ? 'rulesync.jsonc has "delete": true, so everything the agents read must live in .rulesync/ (rules, commands, subagents, skills, mcp, hooks, permissions): `rulesync generate` deletes, for every agent, the files in its output folders (.claude/, .agents/...) that no source there produces. toolgate init never sets it' : null;
  } catch {
    return null;
  }
}

/**
 * The generated files of the chosen targets that belong in .gitignore: never one that already exists (the user's own, or
 * one git tracks) nor one init just imported from.
 */
export function generatedIgnores({ cwd, targets, imported = [], isTrackedFn, isIgnoredFn = () => false }) {
  const patterns = [];
  const kept = [];
  for (const rel of new Set(targets.flatMap((id) => GENERATED[id] ?? []))) {
    // A file git already ignores is covered: it is neither added to .gitignore nor reported.
    if (!imported.includes(rel) && isIgnoredFn(path.join(cwd, rel))) continue;
    if (imported.includes(rel) || exists(path.join(cwd, rel)) || isTrackedFn(path.join(cwd, rel))) kept.push(rel);
    else patterns.push(rel.startsWith(".") ? rel : `/${rel}`);
  }
  return { patterns, kept };
}
