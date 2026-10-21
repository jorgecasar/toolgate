// qmd collection for skills: registered once, re-indexed only when the sources change.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultExec } from "../daemon.js";
import { CARD_FORMAT, assertCorpusLocation, writeCorpus } from "./corpus.js";
import { COMMAND_GLOB, compare, listSourceFiles, mergeOverrides, scanCommands, scanSkills, scanSubagents } from "./scan.js";

const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

function gitHead(dir, execFn) {
  try {
    return execFn("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

/**
 * Hash of every source's git HEAD (null outside a repo) and the mtime of each selected file.
 * @param {Array<{ dir: string, glob?: string }>} sources
 * @param {(bin: string, args: string[]) => string} [execFn]
 * @param {Array<{ dir: string, glob?: string }>} [commandSources]
 * @param {Array} [overrides] Per-skill overrides of the config
 * @param {number} [format] Card format of the corpus; an older one never matches, so it is rebuilt
 * @param {Array<{ dir: string, glob?: string, dialect?: string }>} [subagentSources]
 * @returns {string}
 */
export function fingerprint(sources, execFn = defaultExec, commandSources = [], overrides = [], format = CARD_FORMAT, subagentSources = []) {
  const part = (source) => ({
    dir: source.dir,
    head: gitHead(source.dir, execFn),
    // A folder that cannot be read has no files here; the scan that follows reports it.
    files: listSourceFiles(source, { onUnreadable: () => {} }).map((file) => [file, fs.statSync(file).mtimeMs]),
  });
  const parts = [
    ...sources.map(part),
    ...commandSources.map((source) => ({
      kind: "command",
      dialect: source.dialect ?? "claude",
      ...part({ glob: COMMAND_GLOB, ...source }),
    })),
    ...subagentSources.map((source) => ({
      kind: "subagent",
      dialect: source.dialect ?? "claude",
      ...part({ glob: COMMAND_GLOB, ...source }),
    })),
  ];
  // What the index sees of the overrides (merged per skill, by name), not how the config lists them:
  // reordering entries or moving one to another layer must not force a reindex.
  const applied = [...mergeOverrides(overrides)].sort(([a], [b]) => compare(a, b));
  return crypto.createHash("sha256").update(JSON.stringify(applied.length ? { format, parts, overrides: applied } : { format, parts })).digest("hex");
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return {};
  }
}

const realPath = (dir) => {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

// `qmd collection show` prints a `Path:` line for the folder the collection indexes.
function collectionPath(shown) {
  const line = shown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("Path:"));
  return line ? line.slice("Path:".length).trim() : null;
}

// True when qmd has the collection and it indexes this corpus. Any failure to ask means "no":
// the local fingerprint cannot see a collection removed from qmd, so it is never trusted alone.
export function collectionIsCurrent({ qmdBin, collection, corpusDir, execFn }) {
  try {
    const current = collectionPath(execFn(qmdBin, ["collection", "show", collection]));
    return current !== null && realPath(current) === realPath(corpusDir);
  } catch {
    return false;
  }
}

/**
 * Register the corpus as a qmd collection. A name that is already taken is fine only when it
 * already points at this corpus: pointing anywhere else would leave qmd indexing other files
 * while the index looks healthy, so that case fails with the way out.
 */
export function registerCollection({ qmdBin, collection, corpusDir, execFn, label = "skills corpus", setting = "skills.collection" }) {
  try {
    execFn(qmdBin, ["collection", "add", corpusDir, "--name", collection, "--mask", "**/*.md"]);
    return;
  } catch (err) {
    if (!/already exists/i.test(`${err.stderr ?? ""}${err.message ?? ""}`)) throw err;
  }

  const current = collectionPath(execFn(qmdBin, ["collection", "show", collection]));
  if (current === null || realPath(current) !== realPath(corpusDir)) {
    throw new Error(
      `qmd collection "${collection}" points at ${current ?? "an unknown path"}, not at the ${label} ` +
        `${corpusDir}; remove it with "qmd collection remove ${collection}" or set ${setting} to another name`
    );
  }
}

/**
 * Rebuild the corpus and refresh qmd, unless nothing changed since the last successful index.
 * Throws when qmd fails: a half-indexed collection must not be recorded as fresh.
 * @param {Object} options
 * @param {Array<{ dir: string, glob?: string }>} options.sources
 * @param {Array<{ dir: string, glob?: string, dialect?: string }>} [options.commandSources]
 * @param {Array<{ dir: string, glob?: string, dialect?: string }>} [options.subagentSources]
 * @param {string} options.corpusDir
 * @param {string} [options.projectDir] The project: when given, `corpusDir` must be inside its `.toolgate`
 * @param {string} options.stateFile Kept outside corpusDir, which is rewritten on every index.
 * @param {string} options.collection Name of the qmd collection for this project.
 * @param {Array<{ skill: string }>} [options.overrides] Per-skill `tags`, `mcps` and `description`
 * @param {string} [options.qmdBin]
 * @param {boolean} [options.force]
 * @param {(bin: string, args: string[]) => string} [options.execFn]
 * @returns {{ indexed: boolean, count: number, commands: number, subagents: number }} `count` is skills, commands and subagents together
 */
// The corpus can sit inside a source (`.` is a legitimate source): its cards are neither skills, commands nor subagents.
const apart = (list, corpusDir) => list.map((source) => ({ ...source, exclude: [...(source.exclude ?? []), corpusDir] }));

/**
 * What an index would hold, read without writing anything: the skills and commands the sources have now.
 * `syncCollection` reads the same way, and `init --dry-run` uses it to say how many it would index.
 * @returns {{ skills: object[], commands: object[], subagents: object[], skipped: { kind: string, file: string, reason: string }[] }}
 *   `skills` holds the commands and subagents too; `skipped` are the files that could not be read, which are left out
 */
export function scanIndexable({ sources, commandSources = [], subagentSources = [], overrides = [], corpusDir }) {
  // A project may have commands or subagents only; without any source at all, scanSkills says so.
  const commands = scanCommands(apart(commandSources, corpusDir));
  const subagents = scanSubagents(apart(subagentSources, corpusDir));
  const own = sources.length || !(commandSources.length || subagentSources.length) ? scanSkills(apart(sources, corpusDir), overrides) : [];
  const skipped = [
    ...(own.skipped ?? []).map((item) => ({ kind: "skill", ...item })),
    ...commands.skipped.map((item) => ({ kind: "command", ...item })),
    ...subagents.skipped.map((item) => ({ kind: "subagent", ...item })),
  ];
  return { skills: [...own, ...commands, ...subagents], commands, subagents, skipped };
}

export function syncCollection({
  sources,
  commandSources = [],
  subagentSources = [],
  overrides = [],
  corpusDir,
  projectDir,
  stateFile,
  collection,
  qmdBin = "qmd",
  force = false,
  execFn = defaultExec,
  onSkipped,
}) {
  if (!collection) throw new Error("syncCollection: a collection name is required");
  if (projectDir !== undefined) assertCorpusLocation(corpusDir, projectDir, [...sources, ...commandSources, ...subagentSources].map((source) => source.dir));
  // The corpus can sit inside a source (`.` is a legitimate source): its cards are neither skills nor commands,
  // and rewriting them must not change what the fingerprint sees.
  const [skillSources, commandSourcesApart, subagentSourcesApart] = [apart(sources, corpusDir), apart(commandSources, corpusDir), apart(subagentSources, corpusDir)];
  const current = fingerprint(skillSources, execFn, commandSourcesApart, overrides, undefined, subagentSourcesApart);
  const previous = readState(stateFile);
  const unchanged = previous.fingerprint === current;
  if (!force && unchanged && collectionIsCurrent({ qmdBin, collection, corpusDir, execFn })) {
    return { indexed: false, count: previous.count ?? 0, commands: previous.commands ?? 0, subagents: previous.subagents ?? 0 };
  }

  const { skills, commands, subagents, skipped } = scanIndexable({ sources, commandSources, subagentSources, overrides, corpusDir });
  // Said by the caller (on stderr), once per scan that really ran: a skipped file is not in the index.
  for (const item of skipped) onSkipped?.(item);
  writeCorpus(skills, corpusDir);
  registerCollection({ qmdBin, collection, corpusDir, execFn });
  // The first run loads the models and embeds every skill, which takes far longer than a query.
  execFn(qmdBin, ["update"], { timeout: INDEX_TIMEOUT_MS });
  execFn(qmdBin, ["embed", "-c", collection], { timeout: INDEX_TIMEOUT_MS });

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ fingerprint: current, count: skills.length, commands: commands.length, subagents: subagents.length }, null, 2));
  return { indexed: true, count: skills.length, commands: commands.length, subagents: subagents.length };
}
