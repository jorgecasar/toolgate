// `toolgate subagents install <source>`: installs the subagents of a remote repository as normalized text
// files in `.toolgate/subagents/`, recorded in `.toolgate/subagents.lock.json`. Like commands, the copy is
// not the source file but its neutral form (see `renderSubagent`): only what describes the subagent is kept,
// and its tools are always written out, so nothing ends up with more than the minimum.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { installAssets, installNameProblem, readLock, storeFor } from "../skills/install.js";
import { scanSubagents } from "../skills/scan.js";
import { DEFAULT_SUBAGENT_TOOLS, SUBAGENT_DIALECTS, effectiveTools, parseSubagent, renderSubagent } from "./parse.js";

export const SUBAGENTS_DIR = path.join(".toolgate", "subagents");
export const SUBAGENTS_LOCK_FILE = path.join(".toolgate", "subagents.lock.json");
// The local level is for one machine: its store and lock are gitignored.
export const SUBAGENTS_LOCAL_DIR = path.join(".toolgate", "subagents.local");
export const SUBAGENTS_LOCAL_LOCK_FILE = path.join(".toolgate", "subagents.local.lock.json");
export const SUBAGENTS_LOCAL_IGNORED = [`${SUBAGENTS_LOCAL_DIR}/`, SUBAGENTS_LOCAL_LOCK_FILE].map((entry) => entry.split(path.sep).join("/"));

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Folders of a repository that never hold subagents: version control, and the licenses toolgate keeps.
const IGNORED_DIRS = new Set([".git", ".licenses"]);

/** sha256 of the file content. */
export function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Every `.md` file under `base`, as `{ file, relative }` or `{ file, error }` for one that cannot be read: a
// symlink is never followed. Folders nest into the name (`team/qa.md` is `team-qa`).
function* markdownFiles(base, dir = base) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const file = path.join(dir, entry.name);
    const relative = path.relative(base, file).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* markdownFiles(base, file);
    } else if (entry.name.endsWith(".md")) {
      yield entry.isFile() ? { file, relative } : { file, relative, error: "is a symlink and symlinks are not followed" };
    }
  }
}

/**
 * Descriptor of the subagent kind for `installAssets` (see `SKILL_KIND`). `dialect` says how the files of the
 * source are written.
 * @param {string} [dialect]
 */
export function subagentKind(dialect = "claude") {
  if (!SUBAGENT_DIALECTS.includes(dialect)) throw new Error(`unknown subagent dialect "${dialect}" (use ${SUBAGENT_DIALECTS.join(", ")})`);
  function discover(base) {
    const items = [];
    const skipped = [];
    for (const { file, relative, error } of markdownFiles(base)) {
      try {
        if (error) throw new Error(error);
        const subagent = parseSubagent(file, { dialect, relative });
        const problem = installNameProblem(subagent.name);
        if (problem) throw new Error(problem);
        // Compared without case: `Foo` and `foo` are one file on a case-insensitive filesystem.
        const other = items.find((item) => item.name.toLowerCase() === subagent.name.toLowerCase());
        if (other) throw new Error(`"${subagent.name}" is already provided by ${path.relative(base, other.dir)}`);
        items.push({ ...subagent, dir: file, text: renderSubagent(subagent) });
      } catch (err) {
        skipped.push({ name: relative.replace(/\.md$/, ""), reason: err.message.replace(`${file}: `, "") });
      }
    }
    return { items, skipped };
  }

  return Object.freeze({
    noun: "subagent",
    plural: "subagents",
    storeDir: SUBAGENTS_DIR,
    lockFile: SUBAGENTS_LOCK_FILE,
    stores: Object.freeze({
      user: Object.freeze({ storeDir: "subagents", lockFile: "subagents.lock.json" }),
      local: Object.freeze({ storeDir: SUBAGENTS_LOCAL_DIR, lockFile: SUBAGENTS_LOCAL_LOCK_FILE }),
    }),
    lockKey: "subagents",
    // No root fallback: a repository's top-level markdown files are not subagents.
    defaultBases: Object.freeze(["subagents", ".claude/agents", ".opencode/agents"]),
    discover,
    hash: hashFile,
    sourceHash: (file, item) => crypto.createHash("sha256").update(item.text).digest("hex"),
    copy: (file, to, item) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, item.text);
    },
    fileName: (name) => `${name}.md`,
    lookedFor: (subdir) => `<name>.md files in ${subdir}`,
    // What `update` and `status` need to treat a subagent as a unit (see the contract in skills/install.js).
    unitName: (entry) => ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") ? entry.name.slice(0, -3) : null),
    scan: (sources) => scanSubagents(sources),
    forSource: (info) => subagentKind(info?.dialect ?? "claude"),
    unitText: (file) => fs.readFileSync(file, "utf8"),
    describe: (file) => {
      const subagent = parseSubagent(file, { dialect });
      return { description: subagent.description, mcps: subagent.mcps, tools: effectiveTools(subagent) };
    },
    // Said by `install` and `import`: a definition with no tools gets the least, and that is never silent.
    remark: (item) => (item.tools ? null : `no tools listed: read-only default ${DEFAULT_SUBAGENT_TOOLS.join(", ")}`),
    skippedName: (entry, located) => path.relative(located.subdir, entry.path ?? "").split(path.sep).join("/").replace(/\.md$/, ""),
  });
}

export const SUBAGENT_KIND = subagentKind();

/**
 * `installAssets` for subagents: same options, plus `dialect`.
 * @param {Parameters<typeof installAssets>[1] & { dialect?: string }} options
 */
export function installSubagents({ dialect, ...options }) {
  // Without --dialect the source keeps the one it was installed with.
  const { root, lockFile } = storeFor(SUBAGENT_KIND, options.level ?? "project", { projectDir: options.projectDir, userDir: options.userDir });
  const locked = readLock(path.join(root, lockFile), "subagents").sources[options.spec]?.dialect;
  const used = dialect ?? locked ?? "claude";
  // The dialect is kept with the source, so a later update reads it the same way.
  return installAssets(subagentKind(used), { ...options, sourceExtra: { dialect: used } });
}
