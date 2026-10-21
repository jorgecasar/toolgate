// `toolgate commands install <source>`: installs the commands of a remote repository as normalized
// text files in `.toolgate/commands/`, recorded in `.toolgate/commands.lock.json`. Like skills the
// copy is a generated artifact; unlike skills it is not the source file but its normalized form
// (see `renderCommand`), so nothing executable is kept and every dialect reads the same.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { installAssets, installNameProblem, readLock, storeFor } from "../skills/install.js";
import { scanCommands } from "../skills/scan.js";
import { DIALECTS, parseCommand, renderCommand } from "./parse.js";

export const COMMANDS_DIR = path.join(".toolgate", "commands");
export const COMMANDS_LOCK_FILE = path.join(".toolgate", "commands.lock.json");
// The local level is for one machine: its store and lock are gitignored. The user level lives in the user
// config directory, so its paths are relative to that directory (as for skills).
export const COMMANDS_LOCAL_DIR = path.join(".toolgate", "commands.local");
export const COMMANDS_LOCAL_LOCK_FILE = path.join(".toolgate", "commands.local.lock.json");
export const COMMANDS_LOCAL_IGNORED = [`${COMMANDS_LOCAL_DIR}/`, COMMANDS_LOCAL_LOCK_FILE].map((entry) => entry.split(path.sep).join("/"));

const SOURCE_EXTENSION = /\.md$/;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Folders of a repository that never hold commands: version control, and the licenses toolgate keeps.
const IGNORED_DIRS = new Set([".git", ".licenses"]);

/** sha256 of the file content. */
export function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Every `.md` file under `base`, as `{ file, relative }` or `{ file, error }` for one that cannot be
// read: a symlink is never followed. Folders nest into the command name (`git/commit.md` is `git-commit`).
function* commandFiles(base, dir = base) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const file = path.join(dir, entry.name);
    const relative = path.relative(base, file).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* commandFiles(base, file);
    } else if (entry.name.endsWith(".md")) {
      yield entry.isFile() ? { file, relative } : { file, relative, error: "is a symlink and symlinks are not followed" };
    }
  }
}

/**
 * Descriptor of the command kind for `installAssets` (see `SKILL_KIND`). `dialect` says how the
 * bodies of the source are written.
 * @param {string} [dialect]
 */
export function commandKind(dialect = "claude") {
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown command dialect "${dialect}" (use ${DIALECTS.join(", ")})`);
  function discover(base) {
    const items = [];
    const skipped = [];
    for (const { file, relative, error } of commandFiles(base)) {
      try {
        if (error) throw new Error(error);
        const command = parseCommand(file, { dialect, relative });
        const problem = installNameProblem(command.name);
        if (problem) throw new Error(problem);
        // Compared without case: `Foo` and `foo` are one file on a case-insensitive filesystem.
        const other = items.find((item) => item.name.toLowerCase() === command.name.toLowerCase());
        if (other) throw new Error(`"${command.name}" is already provided by ${path.relative(base, other.dir)}`);
        // The normalized text the copy holds: its name comes from the folders the file sits in.
        items.push({ ...command, dir: file, text: renderCommand(command) });
      } catch (err) {
        skipped.push({ name: relative.replace(SOURCE_EXTENSION, ""), reason: err.message.replace(`${file}: `, "") });
      }
    }
    return { items, skipped };
  }

  return Object.freeze({
    noun: "command",
    plural: "commands",
    storeDir: COMMANDS_DIR,
    lockFile: COMMANDS_LOCK_FILE,
    stores: Object.freeze({
      user: Object.freeze({ storeDir: "commands", lockFile: "commands.lock.json" }),
      local: Object.freeze({ storeDir: COMMANDS_LOCAL_DIR, lockFile: COMMANDS_LOCAL_LOCK_FILE }),
    }),
    lockKey: "commands",
    // No root fallback: a repository's top-level markdown files (README, CHANGELOG) are not commands.
    defaultBases: Object.freeze(["commands", ".claude/commands", ".opencode/command", ".agents/commands", ".agents/workflows"]),
    discover,
    hash: hashFile,
    sourceHash: (file, item) => crypto.createHash("sha256").update(item.text).digest("hex"),
    copy: (file, to, item) => {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, item.text);
    },
    fileName: (name) => `${name}.md`,
    lookedFor: (subdir) => `<name>.md files in ${subdir}`,
    // What `update` and `status` need to treat a command as a unit (see the contract in skills/install.js):
    // the name a store entry stands for, the scan of the sources, the kind to read a source with (its
    // dialect is in the lock), the text of a copy, what the agent sees of it, and the lock entry's name
    // as `discover` reports it when the file is invalid upstream.
    unitName: (entry) => ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") ? entry.name.slice(0, -3) : null),
    scan: (sources) => scanCommands(sources),
    forSource: (info) => commandKind(info?.dialect ?? "claude"),
    unitText: (file) => fs.readFileSync(file, "utf8"),
    describe: (file) => {
      const command = parseCommand(file, { dialect });
      return { description: command.description, mcps: command.mcps };
    },
    skippedName: (entry, located) => path.relative(located.subdir, entry.path ?? "").split(path.sep).join("/").replace(SOURCE_EXTENSION, ""),
  });
}

export const COMMAND_KIND = commandKind();

/**
 * `installSkills` for commands: same options, plus `dialect`.
 * @param {Parameters<typeof installAssets>[1] & { dialect?: string }} options
 */
export function installCommands({ dialect, ...options }) {
  // Without --dialect the source keeps the one it was installed with.
  const { root, lockFile } = storeFor(COMMAND_KIND, options.level ?? "project", { projectDir: options.projectDir, userDir: options.userDir });
  const locked = readLock(path.join(root, lockFile), "commands").sources[options.spec]?.dialect;
  const used = dialect ?? locked ?? "claude";
  // The dialect is kept with the source, so a later update reads it the same way.
  return installAssets(commandKind(used), { ...options, sourceExtra: { dialect: used } });
}
