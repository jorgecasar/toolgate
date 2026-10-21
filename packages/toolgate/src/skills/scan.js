// Skill discovery: walks the configured `skills.sources[]` (dir + glob) and parses each SKILL.md.
import fs from "node:fs";
import path from "node:path";
import { LEVELS, nodeOf } from "./corpus.js";
import { effectiveTools, parseSubagent } from "../subagents/parse.js";
import { parseCommand } from "../commands/parse.js";
import { OVERRIDE_FIELDS } from "../configFile.js";
import { parseSkill } from "./parse.js";

const DEFAULT_GLOB = "*/SKILL.md";
/** Where a commands source looks when it declares no glob (nested folders become dashed names). */
export const COMMAND_GLOB = "**/*.md";

// UTF-16 code unit order: the same on every machine, unlike localeCompare.
export const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function globToRegExp(glob) {
  const source = glob
    .split("**/")
    .map((part) =>
      part
        .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]")
    )
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`);
}

function checkSource(source) {
  const { dir, glob = DEFAULT_GLOB } = source ?? {};
  if (typeof dir !== "string" || !dir) throw new TypeError("a skills source needs a dir");
  if (typeof glob !== "string" || path.isAbsolute(glob) || glob.split("/").includes("..")) {
    throw new TypeError(`skills source glob must be relative and stay inside its dir: ${glob}`);
  }
  return { dir, glob };
}

// Files only: a symlinked directory is never entered, so nothing outside the source is reached.
// A folder the caller keeps apart, by its path or, when it exists, by what it is: a source spelled with another
// case, or through another name of the same folder, still leaves it out.
const excluding = (list) => ({ paths: list.map((skip) => path.resolve(skip)), nodes: new Set(list.map((skip) => nodeOf(skip)).filter(Boolean)) });
const isExcluded = (full, { paths, nodes }) => paths.some((skip) => path.resolve(skip) === full) || (nodes.size > 0 && nodes.has(nodeOf(full)));

function* walk(dir, base = dir, exclude = { paths: [], nodes: new Set() }, onUnreadable = undefined) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // The source itself must be readable; a folder inside it that is not is reported and the rest is read.
    if (dir === base || !onUnreadable) throw err;
    onUnreadable(dir, err);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // the licenses and the staging area toolgate keeps are not assets; and a folder the caller keeps apart (the corpus, when it sits inside a source) is not part of the source
      if (entry.name !== ".licenses" && entry.name !== ".staging" && !isExcluded(full, exclude)) yield* walk(full, base, exclude, onUnreadable);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const relative = path.relative(base, full).split(path.sep).join("/");
      yield { full, relative, link: entry.isSymbolicLink() };
    }
  }
}

/**
 * Absolute paths of the files a source selects. A missing dir, an unsafe glob and a selected
 * symlink are errors: nothing is silently skipped or followed out of the source.
 * @param {{ dir: string, glob?: string }} source
 * @returns {string[]}
 */
export function listSourceFiles(source, { onUnreadable } = {}) {
  const { dir, glob } = checkSource(source);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`skills source directory not found: ${dir}`);
  }
  const matcher = globToRegExp(glob);
  const selected = [...walk(dir, dir, excluding(source.exclude ?? []), onUnreadable)].filter((file) => matcher.test(file.relative));
  const link = selected.find((file) => file.link);
  if (link) throw new Error(`skills source file is a symlink and symlinks are not followed: ${link.full}`);
  return selected.map((file) => file.full).sort(compare);
}

/**
 * Overrides merged by skill name, key by key: a later entry (a higher config layer) wins.
 * @param {Array<{ skill: string, tags?: string[], mcps?: string[], description?: string }>} [list]
 * @returns {Map<string, Record<string, unknown>>}
 */
export function mergeOverrides(list = []) {
  const merged = new Map();
  for (const entry of list) {
    if (!entry || typeof entry.skill !== "string") continue;
    const current = merged.get(entry.skill) ?? {};
    for (const key of OVERRIDE_FIELDS) if (entry[key] !== undefined) current[key] = entry[key];
    merged.set(entry.skill, current);
  }
  return merged;
}

/**
 * Skills of every source, one per name. Sources carry the `level` they were declared at (default
 * "project"). Two skills with the same name inside one level are an error; across levels the
 * higher one wins (local over project over user) and the winner lists the levels it shadows.
 * Overrides replace the `tags`, `mcps` and `description` of the winning skill; the files are untouched.
 * @param {Array<{ dir: string, glob?: string, level?: string }>} sources
 * @param {Array<{ skill: string }>} [overrides]
 * @returns {Array<import("./parse.js").Skill & { level: string, shadows: string[] }>}
 */
export function scanSkills(sources, overrides = []) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("no skills sources configured (set skills.sources[] in .toolgate/config.json)");
  }
  return scanAssets(sources, "skill", (file) => parseSkill(file), mergeOverrides(overrides));
}

/**
 * Commands of every source, resolved by level exactly like skills. A source with no `glob` reads
 * every `.md` file under its dir, and its `dialect` (default "claude") says how bodies are written.
 * No sources is not an error: a project need not have commands.
 * @param {Array<{ dir: string, glob?: string, level?: string, dialect?: string }>} sources
 */
export function scanCommands(sources = []) {
  const withGlob = sources.map((source) => ({ glob: COMMAND_GLOB, ...source }));
  return scanAssets(withGlob, "command", (file, source) =>
    parseCommand(file, { dialect: source.dialect, relative: path.relative(source.dir, file) })
  );
}

/**
 * The subagents of the sources, like `scanCommands`: every `.md` file under the dir, the `dialect` of the source
 * (default "claude") says how it is written. Each one carries the tools it really gets.
 * @param {Array<{ dir: string, glob?: string, level?: string, dialect?: string }>} sources
 */
export function scanSubagents(sources = []) {
  const withGlob = sources.map((source) => ({ glob: COMMAND_GLOB, ...source }));
  return scanAssets(withGlob, "subagent", (file, source) => {
    const subagent = parseSubagent(file, { dialect: source.dialect, relative: path.relative(source.dir, file) });
    return { ...subagent, effectiveTools: effectiveTools(subagent), toolsDefault: subagent.tools === null };
  });
}

// `applied` is the per-name overrides of the assets that have them (skills); commands have none.
// A file that cannot be read as the asset is skipped, never half-parsed, and the others are still scanned: the
// skipped ones are `{ file, reason }` in a `skipped` property of the returned list (not an element of it, so the
// callers still get the array they always did). A problem with a source itself (a missing dir, a link, a duplicate
// name, an unknown level) still throws.
function scanAssets(sources, noun, parse, applied = new Map()) {
  const byName = new Map();
  const skipped = [];
  for (const source of sources) {
    const level = source.level ?? "project";
    if (!LEVELS.includes(level)) throw new Error(`unknown ${noun}s level "${level}" for ${source.dir}`);
    const parsed = [];
    const unreadable = (folder, err) => skipped.push({ file: folder, reason: reasonOf(err, folder) });
    for (const file of listSourceFiles(source, { onUnreadable: unreadable })) {
      try {
        parsed.push(parse(file, source));
      } catch (err) {
        skipped.push({ file, reason: reasonOf(err, file) });
      }
    }
    for (const skill of parsed) {
      const levels = byName.get(skill.name) ?? new Map();
      if (levels.has(level)) {
        throw new Error(`duplicate ${noun} name "${skill.name}" in the ${level} level (${skill.path})`);
      }
      levels.set(level, { ...skill, level });
      byName.set(skill.name, levels);
    }
  }
  const found = [...byName.values()]
    .map((levels) => {
      const present = LEVELS.filter((level) => levels.has(level));
      const winner = present.at(-1);
      const skill = levels.get(winner);
      return { ...skill, ...applied.get(skill.name), shadows: present.slice(0, -1) };
    })
    .sort((a, b) => compare(a.name, b.name));
  return Object.defineProperty(found, "skipped", { value: skipped });
}
// The parser's reason without the file it starts with (the file is said on its own).
const reasonOf = (err, file) => String(err?.message ?? err).split("\n")[0].replace(`${file}: `, "");
