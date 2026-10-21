// The hook kind: `toolgate hooks install <source>` copies the hook units of a remote repository (a folder with
// `HOOK.json` and the scripts it runs) into `.toolgate/hooks/`, normalized: the kept fields of `HOOK.json` and the
// files of the unit, nothing else. A hook runs a command on the user's machine, so the kind is `review`: a unit is
// applied only with an approval of its exact content (see `assets/approval.js`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashDir, installNameProblem } from "../skills/install.js";
import { printable } from "../assets/common.js";
import { parseHook, renderHook } from "./parse.js";

export const HOOKS_DIR = path.join(".toolgate", "hooks");
export const HOOKS_LOCK_FILE = path.join(".toolgate", "hooks.lock.json");
// The local level is for one machine: its store and lock are gitignored. The user level lives in the user config folder.
export const HOOKS_LOCAL_DIR = path.join(".toolgate", "hooks.local");
export const HOOKS_LOCAL_LOCK_FILE = path.join(".toolgate", "hooks.local.lock.json");
export const HOOKS_LOCAL_IGNORED = [`${HOOKS_LOCAL_DIR}/`, HOOKS_LOCAL_LOCK_FILE].map((entry) => entry.split(path.sep).join("/"));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Folders of a repository that are never a unit: version control and the licenses toolgate keeps.
const NOT_UNITS = new Set([".git", ".licenses"]);

/** The text shown for a unit: its handlers with their commands and arguments as they will run, and its files. */
export function previewHook(hook) {
  const lines = [`${printable(hook.name)}: ${printable(hook.description)}`];
  for (const h of hook.handlers) {
    const when = `${h.event}${h.matcher === undefined ? "" : ` [${printable(h.matcher)}]`}${h.if === undefined ? "" : ` if ${printable(h.if)}`}`;
    lines.push(`  ${when} runs: ${[h.command, ...h.args].map((part) => JSON.stringify(printable(part))).join(" ")}${h.timeout === undefined ? "" : ` (timeout ${h.timeout}s)`}`);
  }
  lines.push(`  files: ${hook.files.map(printable).join(", ")}`);
  // What is approved is the exact content of the unit, so the user sees the text of every file but HOOK.json (shown above as
  // handlers), a long one cut with a count and its hash. A change only in a script changes these lines, which is what an update shows.
  for (const file of hook.files.filter((f) => f !== "HOOK.json")) lines.push(...fileLines(hook.dir, file));
  return lines.join("\n");
}

export const PREVIEW_LINES_PER_FILE = 60;
const PREVIEW_LINE_WIDTH = 300;
function fileLines(dir, file) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(dir, file));
  } catch {
    return [`  file ${printable(file)}: cannot be read`];
  }
  const sha = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const head = `  file ${printable(file)} (${bytes.length} bytes, sha256 ${sha}):`;
  if (bytes.includes(0)) return [head, "    | (binary content, not shown)"];
  const all = bytes.toString("utf8").split("\n");
  if (all.at(-1) === "") all.pop();
  const shown = all.slice(0, PREVIEW_LINES_PER_FILE).map((line) => `    | ${printable(line.length > PREVIEW_LINE_WIDTH ? `${line.slice(0, PREVIEW_LINE_WIDTH)}…` : line)}`);
  const cut = all.slice(0, PREVIEW_LINES_PER_FILE).filter((line) => line.length > PREVIEW_LINE_WIDTH).length;
  const cutNote = cut ? [`    | … ${cut} line${cut === 1 ? "" : "s"} cut at ${PREVIEW_LINE_WIDTH} characters; read ${printable(path.join(dir, file))} before approving`] : [];
  return [head, ...shown, ...cutNote, ...(all.length > PREVIEW_LINES_PER_FILE ? [`    | … ${all.length - PREVIEW_LINES_PER_FILE} more lines not shown; read ${printable(path.join(dir, file))} before approving`] : [])];
}

/** The units of a folder: every sub-folder with a `HOOK.json`, read and checked. Each invalid one is listed with its reason. */
function discover(base) {
  const items = [];
  const skipped = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    if (NOT_UNITS.has(entry.name) || entry.name.startsWith(".")) continue;
    const dir = path.join(base, entry.name);
    // A link is listed and refused, never followed: it could lead anywhere.
    if (entry.isSymbolicLink()) {
      skipped.push({ name: entry.name, reason: "is a symlink and symlinks are not followed" });
      continue;
    }
    if (!entry.isDirectory()) continue;
    try {
      const hook = parseHook(dir, { relative: entry.name });
      if (hook.name !== entry.name) throw new Error(`the name "${hook.name}" in HOOK.json must be the name of its folder, "${entry.name}"`);
      const problem = installNameProblem(hook.name);
      if (problem) throw new Error(problem);
      const other = items.find((item) => item.name.toLowerCase() === hook.name.toLowerCase());
      if (other) throw new Error(`"${hook.name}" differs only in case from "${other.name}"`);
      items.push(hook);
    } catch (err) {
      skipped.push({ name: entry.name, reason: err.message.replace(`${dir}: `, "").split("\n")[0] });
    }
  }
  return { items, skipped };
}

// The content of the unit as it is stored: every file of the unit, with the normalized `HOOK.json` in place of the original.
const storedBytes = (item, file, read) => (file === "HOOK.json" ? Buffer.from(renderHook(item)) : read(file));

/** What the hash of the stored copy will be, computed from the source: the same bytes `copy` writes, in the order `hashDir` reads them. */
function sourceHash(dir, item) {
  const hash = crypto.createHash("sha256");
  for (const file of item.files) {
    hash.update(`${file}\0`);
    hash.update(storedBytes(item, file, (f) => fs.readFileSync(path.join(dir, f))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Copies are written without the executable bit: nothing downloaded becomes runnable by being installed. The adapter
// runs a hook from a checked copy of its own (see the plan, PR 5).
function copy(from, to, item) {
  fs.mkdirSync(to, { recursive: true });
  for (const file of item.files) {
    const target = path.join(to, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, storedBytes(item, file, (f) => fs.readFileSync(path.join(from, f))), { mode: 0o644 });
  }
}

/** The hook units of the stores of every level, with their level; a name used at two levels is an error for those units only (no shadowing). */
export function scanHooks({ projectDir, userDir, levels = ["user", "project", "local"] }) {
  const found = [];
  for (const level of levels) {
    if (level === "user" && !userDir) continue;
    const root = level === "user" ? userDir : projectDir;
    const store = level === "project" ? HOOK_KIND : HOOK_KIND.stores[level];
    const dir = path.join(root, store.storeDir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        found.push({ name: entry.name, level, dir: path.join(dir, entry.name), error: "is a link or not a folder" });
        continue;
      }
      try {
        const hook = parseHook(path.join(dir, entry.name), { relative: entry.name });
        // The same rules as at install: a unit is known by the name of its folder, and a store changed by hand is checked again.
        if (hook.name !== entry.name) throw new Error(`the name "${hook.name}" in HOOK.json must be the name of its folder, "${entry.name}"`);
        const problem = installNameProblem(hook.name);
        if (problem) throw new Error(problem);
        found.push({ ...hook, level, hash: hashDir(path.join(dir, entry.name)) });
      } catch (err) {
        found.push({ name: entry.name, level, dir: path.join(dir, entry.name), error: err.message.replace(`${path.join(dir, entry.name)}: `, "").split("\n")[0] });
      }
    }
  }
  // A name used at two levels makes both units errors (a hook never hides another); the other units are not affected.
  const levelsOf = new Map();
  for (const unit of found) if (!unit.error) levelsOf.set(unit.name, [...(levelsOf.get(unit.name) ?? []), unit.level]);
  return found.map((unit) => (!unit.error && levelsOf.get(unit.name).length > 1 ? { name: unit.name, level: unit.level, dir: unit.dir, error: `exists at the ${levelsOf.get(unit.name).join(" and ")} levels; remove one (a hook never hides another)` } : unit));
}

/** The descriptor of the hook kind for `installAssets`, `updateAssets` and `assetStatus` (see `SKILL_KIND`). */
export const HOOK_KIND = Object.freeze({
  noun: "hook",
  plural: "hooks",
  storeDir: HOOKS_DIR,
  lockFile: HOOKS_LOCK_FILE,
  stores: Object.freeze({
    user: Object.freeze({ storeDir: "hooks", lockFile: "hooks.lock.json" }),
    local: Object.freeze({ storeDir: HOOKS_LOCAL_DIR, lockFile: HOOKS_LOCAL_LOCK_FILE }),
  }),
  lockKey: "hooks",
  review: true,
  // No root fallback: only a `hooks` folder (or `.toolgate/hooks`) of a repository holds units.
  defaultBases: Object.freeze(["hooks", ".toolgate/hooks"]),
  discover,
  hash: hashDir,
  sourceHash,
  copy,
  // What the user is shown before approving: every handler with its command and arguments verbatim (printable), and the files.
  preview: (hook, options) => previewHook(options?.stored ? parseHook(options.dir) : hook),
  describe: (dir) => ({ description: parseHook(dir).description, mcps: [] }),
  lookedFor: (subdir) => `<name>/HOOK.json in ${subdir}`,
  // The same name at another level is an error, not a shadow: a hook of another level never hides this one.
  clash: (name, { level, projectDir, userDir }) => {
    for (const other of ["user", "project", "local"].filter((l) => l !== level)) {
      if (other === "user" && !userDir) continue;
      const store = other === "project" ? HOOK_KIND : HOOK_KIND.stores[other];
      const root = other === "user" ? userDir : projectDir;
      if (fs.existsSync(path.join(root, store.storeDir, name))) return other;
    }
    return null;
  },
});
