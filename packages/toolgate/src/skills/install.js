// `toolgate skills install <source>`: copies the skills of a remote repository into
// `.toolgate/skills/` and records where each came from in `.toolgate/skills.lock.json`. The copy is
// a generated artifact: it is rebuilt from the source, so one that was edited by hand is never
// overwritten without `--force`.
import { unitKey } from "../assets/approval.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_NAME_LENGTH, SAFE_NAME, hasDescription, noDescriptionNotice, parseJson, printable } from "../assets/common.js";
import { RESERVED_NAMES } from "./corpus.js";
import { parseSkill } from "./parse.js";
import { checkRef, fetchSource, sourceUrl } from "./remote.js";

export const SKILLS_DIR = path.join(".toolgate", "skills");
export const LOCK_FILE = path.join(".toolgate", "skills.lock.json");
// The local level is for trying things and for one machine: its store and lock are gitignored. The
// user level lives in the user config directory, so its paths are relative to that directory.
export const LOCAL_SKILLS_DIR = path.join(".toolgate", "skills.local");
export const LOCAL_LOCK_FILE = path.join(".toolgate", "skills.local.lock.json");
// What the local level (and the staging folder both levels use) adds to .gitignore.
export const STAGING_IGNORED = `${path.join(".toolgate", ".staging")}/`.split(path.sep).join("/");
export const LOCAL_IGNORED = [`${LOCAL_SKILLS_DIR}/`, LOCAL_LOCK_FILE, STAGING_IGNORED].map((entry) => entry.split(path.sep).join("/"));

const MAX_LICENSE_BYTES = 256 * 1024;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.[\w-]+)?$/i;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function readLock(file, key = "skills") {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { sources: {}, [key]: {}, invalid: [] };
    throw err;
  }
  let lock;
  try {
    lock = parseJson(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON and was left untouched (${err.message})`);
  }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error(`${file} does not hold a JSON object and was left untouched`);
  }
  // The lock is committed, so it is not trusted: a section that is not an object or an entry that is not
  // one is dropped and listed in `invalid`, never handed to code that reads `.source` or `.hash` from it.
  // What is dropped is kept apart as it was written, and `writeLock` puts it back: a rewrite never loses an entry.
  const invalid = [];
  const unreadable = { sources: {}, [key]: {} };
  const clean = (section, value, fields) => {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalid.push(`${section} is not an object`);
      return {};
    }
    const kept = {};
    for (const [name, entry] of Object.entries(value)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        invalid.push(`${section}.${name} is not an object`);
        unreadable[section === "sources" ? "sources" : key][name] = entry;
        continue;
      }
      // A field of the wrong type would crash whatever reads it (`.slice`, `.replace`): the entry is dropped and reported.
      const wrong = Object.entries(fields).filter(([field, ok]) => entry[field] !== undefined && !ok(entry[field])).map(([field]) => field);
      if (wrong.length) {
        invalid.push(`${section}.${name} has a ${wrong.join(", ")} of the wrong type`);
        unreadable[section === "sources" ? "sources" : key][name] = entry;
      } else kept[name] = entry;
    }
    return kept;
  };
  const text_ = (v) => typeof v === "string";
  const sourceFields = { url: text_, ref: (v) => v === null || text_(v), commit: text_, path: text_, exclude: (v) => Array.isArray(v) && v.every(text_) };
  const textList = (v) => Array.isArray(v) && v.every(text_);
  const itemFields = { source: text_, commit: text_, path: text_, hash: text_, dropped: textList, unsupported: textList };
  const result = { sources: clean("sources", lock.sources, sourceFields), [key]: clean(key, lock[key], itemFields), invalid };
  // Not part of the lock's shape (it is not listed, compared or copied): only `writeLock` reads it.
  return Object.defineProperty(result, "unreadable", { value: unreadable });
}

export function writeLock(file, lock, key = "skills") {
  const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => compare(a, b)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the lock and renamed over it: an interrupted run leaves the old lock, never half of one.
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true }); // a stale one, or a link planted at this path
  // An entry that could not be read is written back as it was, unless this run wrote a valid one under the same name.
  const withUnreadable = (section) => ({ ...lock.unreadable?.[section], ...lock[section] });
  fs.writeFileSync(temp, `${JSON.stringify({ sources: sorted(withUnreadable("sources")), [key]: sorted(withUnreadable(key)) }, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temp, file);
}

// Every file of a skill folder, as relative paths. A symlink is an error: it could point anywhere.
export function filesOf(root) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Object.assign(new Error(`${full} is a symlink and symlinks are not followed`), { code: "ESYMLINK" });
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(path.relative(root, full));
    }
  };
  visit(root);
  return found.sort(compare);
}

/** sha256 over the relative path and content of every file, in a stable order. */
export function hashDir(root) {
  const hash = crypto.createHash("sha256");
  for (const file of filesOf(root)) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// A copy with a symlink added by hand counts as edited (null). Any other failure, a permission
// error for one, says nothing about the content and is not turned into "edited".
export function hashOrNull(root, hash) {
  try {
    return hash(root);
  } catch (err) {
    if (err.code === "ESYMLINK") return null;
    throw err;
  }
}

// Copies are written without the executable bit: a skill is text for the agent, and nothing
// downloaded should become runnable by being installed. The content hash ignores the mode.
function copyDir(from, to) {
  for (const file of filesOf(from)) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.copyFileSync(path.join(from, file), path.join(to, file));
    // `filesOf` rejects symlinks, so this always changes a regular file inside `to`.
    fs.chmodSync(path.join(to, file), 0o644);
  }
  fs.mkdirSync(to, { recursive: true });
}

/** Why a name longer than `MAX_NAME_LENGTH` is not installed (a copy that is already there is not touched). */
export const overInstallLimit = (name) =>
  `"${name.slice(0, 40)}…" has ${name.length} characters, over the install limit of ${MAX_NAME_LENGTH}; a copy already installed is untouched`;

/** Why a name is not installed, or null: too long, starting with a dash (a command line reads that as an option), or a folder toolgate keeps. */
export const installNameProblem = (name) =>
  name.length > MAX_NAME_LENGTH
    ? overInstallLimit(name)
    : name.startsWith("-")
      ? `"${name}" starts with a dash; a command line would read it as an option`
      : name === ".staging" || name === ".licenses"
        ? `"${name}" is a folder toolgate keeps for itself`
        : null;

/** Whether two paths are the same file (a hard link, or one file seen under two spellings of its name). */
export const sameFile = (a, b) => {
  try {
    return fs.statSync(a).ino === fs.statSync(b).ino;
  } catch {
    return false;
  }
};

// A skill is text for the agent. A folder far beyond that is a way to fill the disk (and the agent's
// context), not a skill; it is skipped with a reason, the others are installed.
export const MAX_SKILL_BYTES = 10 * 1024 * 1024;
export const MAX_SKILL_FILES = 500;
function assertReasonableSize(dir, files) {
  if (files.length > MAX_SKILL_FILES) throw new Error(`has ${files.length} files, more than the ${MAX_SKILL_FILES} a skill may have`);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);
  if (bytes > MAX_SKILL_BYTES) throw new Error(`is ${Math.ceil(bytes / 1024 / 1024)} MB, more than the ${MAX_SKILL_BYTES / 1024 / 1024} MB a skill may have`);
}

// The skill folders of a checkout: direct children holding a SKILL.md. Invalid ones are reported
// instead of aborting the others.
function discover(base) {
  const skills = [];
  const skipped = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const dir = path.join(base, entry.name);
    const file = path.join(dir, "SKILL.md");
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    try {
      const skill = parseSkill(file);
      const files = filesOf(dir); // a symlink anywhere in the folder disqualifies this skill, not the others
      assertReasonableSize(dir, files);
      const problem = installNameProblem(skill.name);
      if (problem) throw new Error(problem);
      if (!SAFE_NAME.test(skill.name) || RESERVED_NAMES.has(skill.name)) {
        throw new Error(`"${skill.name}" cannot be used as a skill name`);
      }
      if (skills.some((other) => other.name === skill.name)) {
        throw new Error(`"${skill.name}" is already provided by another folder of the repository`);
      }
      skills.push({ ...skill, dir });
    } catch (err) {
      // The reason can quote text of the repository (a name in the frontmatter): it is printed as one line.
      skipped.push({ name: entry.name, reason: printable(err.message.replace(`${file}: `, "")) });
    }
  }
  return { items: skills, skipped };
}

export function locateBase(checkout, subdir, plural, defaultBases) {
  const explicit = subdir !== undefined;
  let refused = null;
  for (const candidate of explicit ? [subdir] : defaultBases) {
    const base = path.resolve(checkout, candidate);
    const inside = base === checkout || base.startsWith(`${checkout}${path.sep}`);
    if (!inside) throw new Error(`--path "${subdir}" must stay inside the repository`);
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      // A folder of the repository can be a symlink to anywhere on this machine; what counts is where it resolves.
      const real = fs.realpathSync(base);
      if (real !== checkout && !real.startsWith(`${checkout}${path.sep}`)) throw new Error(`${path.relative(checkout, base) || "."} is a symlink that leaves the repository, and symlinks are not followed`);
      // A default folder that is a link to the repository root would make every file of the repository a unit.
      if (real === checkout && base !== checkout) {
        const why = `${path.relative(checkout, base)} is a symlink to the repository root`;
        if (explicit) throw new Error(why);
        refused ??= why;
        continue;
      }
      return { base, subdir: path.relative(checkout, base) || "." };
    }
  }
  if (refused) throw new Error(refused);
  throw new Error(explicit ? `--path "${subdir}" does not exist in the repository` : `no ${plural} folder found in the repository`);
}

// A folder name for a source; "." and ".." would name the store or its parent, so they become "source".
export const slug = (spec) => {
  const name = spec.replace(/^[a-z]+:\/*/i, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^\.*$/.test(name) ? "source" : name;
};

/**
 * Puts a copy of `from` at `<root>/<storeDir>/<name>`, replacing what is there. It is staged beside
 * the store, not in it: an interrupted run must not leave a folder that the scanner would read as a
 * second copy of the skill.
 */
/**
 * What a lock entry says about the unit besides where it came from: the keys of its definition that were not
 * copied into the store (`dropped`) and the constructs left as plain text (`unsupported`), only when there are some.
 * @param {{ dropped?: string[], unsupported?: string[] }} item
 */
export const recordedOf = (item) => ({
  ...(item.dropped?.length ? { dropped: item.dropped } : {}),
  ...(item.unsupported?.length ? { unsupported: item.unsupported } : {}),
});

export function replaceUnit(kind, { root, storeDir, name, from, item }) {
  const target = path.join(root, storeDir, kind.fileName?.(name) ?? name);
  const stagingRoot = stagingDir(root, storeDir);
  const staging = path.join(stagingRoot, `${path.basename(storeDir)}-${name}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  kind.copy(from, staging, item);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The old copy is moved aside, not deleted first: if the process dies between the two renames
  // the skill is still on disk (in staging) instead of gone while the lock says it is installed.
  const aside = `${staging}.old`;
  fs.rmSync(aside, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, aside);
  fs.renameSync(staging, target);
  fs.rmSync(aside, { recursive: true, force: true });
  // This run's folder goes once it holds nothing (another unit of the same run may still be in it).
  try {
    fs.rmdirSync(stagingRoot);
  } catch {
    // not empty: the next unit or the sweep of a later run deals with it
  }
}

// A license file of the repository, read through one descriptor opened without following symlinks: a
// LICENSE that is a symlink would otherwise copy whatever local file it points at into the project,
// and checking the path first and reading it afterwards could be raced.
function readLicense(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    return { reason: err.code === "ELOOP" ? "is a symlink" : `cannot be read (${err.code})` };
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return { reason: "is not a regular file" };
    if (info.size > MAX_LICENSE_BYTES) return { reason: `is larger than ${MAX_LICENSE_BYTES} bytes` };
    return { content: fs.readFileSync(fd) };
  } finally {
    fs.closeSync(fd);
  }
}

const isLink = (file) => {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

// Copies the licenses of the source next to the installed assets. Returns where they went and which
// ones were left out, with the reason.
export function copyLicenses(checkout, projectDir, spec, storeDir) {
  const read = fs.readdirSync(checkout).filter((name) => LICENSE_FILE.test(name)).map((name) => ({ name, ...readLicense(path.join(checkout, name)) }));
  const skipped = read.filter((entry) => entry.reason).map(({ name, reason }) => ({ name, reason }));
  const files = read.filter((entry) => entry.content);
  if (files.length === 0) return { dir: null, skipped };
  const licenses = path.join(projectDir, storeDir, ".licenses");
  const target = path.join(licenses, slug(spec));
  // A symlink planted at the destination would make the writes land somewhere else.
  const planted = [path.join(projectDir, ".toolgate"), path.join(projectDir, storeDir), licenses, target].find(isLink);
  if (planted) return { dir: null, skipped: [...skipped, ...files.map(({ name }) => ({ name, reason: `not copied: ${path.relative(projectDir, planted)} is a symlink` }))] };
  fs.mkdirSync(target, { recursive: true });
  for (const { name, content } of files) {
    // Written aside and renamed over: a link at the destination is replaced, not followed.
    // under a name nobody can guess, and removed again if anything goes wrong
    const temp = path.join(target, `${name}.writing-${crypto.randomBytes(6).toString("hex")}`);
    try {
      fs.writeFileSync(temp, content, { flag: "wx" });
      fs.renameSync(temp, path.join(target, name));
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  return { dir: path.relative(projectDir, target), skipped };
}

// Every run stages in its own folder `.staging/<pid>-<random>/`, so that what an interrupted run left behind can be
// told from what a live one is using: by whether that pid still runs, never by age or by a name in the store.
const RUN = `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
export const stagingDir = (root, storeDir) => path.join(root, path.dirname(storeDir), ".staging", RUN);

const pidIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // it exists, it is only not ours to signal
  }
};

// A replace moves the old copy aside (`<store>-<name>.old`) before the new one goes in. A run that died between the two
// renames leaves the store without the item while the lock still lists it: the copy aside is put back, but only for a plain
// name the lock lists, into a place that is empty, and never through a link.
function recoverReplaced(runDir, storeAbs, locked, kind) {
  const prefix = `${path.basename(storeAbs)}-`;
  const back = [];
  for (const entry of fs.readdirSync(runDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".old")) continue;
    const name = entry.slice(prefix.length, -".old".length);
    if (!SAFE_NAME.test(name) || !Object.hasOwn(locked, name)) continue;
    const from = path.join(runDir, entry);
    // A command or a subagent is stored as `<name>.md`: the place to check and to fill is the one a replace would use.
    const to = path.join(storeAbs, kind?.fileName?.(name) ?? name);
    // What a replace moves aside is a folder (a skill) or a file (a command, a subagent), never a link or the other kind: a
    // planted file named like a copy aside is not put into the store.
    const aside = fs.lstatSync(from);
    if (!(kind?.fileName ? aside.isFile() : aside.isDirectory()) || fs.lstatSync(to, { throwIfNoEntry: false })) continue;
    fs.mkdirSync(storeAbs, { recursive: true });
    fs.renameSync(from, to);
    back.push(name);
  }
  return back;
}

/**
 * Removes the staging folders of runs that are over: real folders shaped `<pid>-<hex>` whose pid is dead. Nothing else is
 * touched. With the store and its lock entries, what an interrupted replace left aside is put back first.
 * @returns {string[]} the names recovered into the store
 */
export function clearStaging(stagingRoot, { storeAbs, locked, kind } = {}) {
  if (!fs.existsSync(stagingRoot)) return [];
  // Never through a symlink: a cloned repository can ship `.toolgate/.staging` pointing at a folder of yours.
  if (fs.lstatSync(stagingRoot).isSymbolicLink()) throw new Error(`${stagingRoot} is a symlink, and toolgate does not clean or write through symlinks`);
  const recovered = [];
  for (const name of fs.readdirSync(stagingRoot)) {
    const found = /^(\d+)-[0-9a-f]+$/.exec(name);
    if (!found || name === RUN) continue;
    const full = path.join(stagingRoot, name);
    if (!fs.lstatSync(full).isDirectory()) continue;
    if (Number(found[1]) === process.pid || !pidIsAlive(Number(found[1]))) {
      if (storeAbs && locked) recovered.push(...recoverReplaced(full, storeAbs, locked, kind));
      fs.rmSync(full, { recursive: true, force: true });
    }
  }
  return recovered;
}

/**
 * Refuses a store whose folders are symlinks. `.toolgate/` and `.toolgate/skills/` are committed to the
 * repository, so a cloned one can make them point anywhere, and an install would then write (and an
 * update delete) there. Missing folders are fine: they are created as plain ones.
 */
export function assertPlainStore(root, storeDir) {
  const parent = path.dirname(storeDir);
  for (const rel of new Set([parent, storeDir, path.join(parent, ".staging")])) {
    if (rel === ".") continue;
    let stat;
    try {
      stat = fs.lstatSync(path.join(root, rel));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`${rel} is a symlink, and toolgate does not write through symlinks (a cloned repository can ship one)`);
  }
}

// The license files of a checkout that count as such (regular files, not symlinks, not huge): what `update`
// compares with the copies it keeps. Nothing a repository links to is read.
export function licenseFilesOf(dir) {
  return fs.readdirSync(dir).filter((name) => {
    if (!LICENSE_FILE.test(name)) return false;
    const stat = fs.lstatSync(path.join(dir, name));
    return stat.isFile() && stat.size <= MAX_LICENSE_BYTES;
  });
}

// What a reviewer needs to see about a skill folder that is not in its file list.
function describe(dir) {
  const skill = parseSkill(path.join(dir, "SKILL.md"));
  return { description: skill.description, mcps: skill.mcps };
}

/**
 * What differs between asset kinds in an install: where the copies and the lock live, which key of
 * the lock holds them, where a repository keeps them, and how one unit (a folder for a skill) is
 * found, hashed and copied. The skill kind is the only one so far.
 *
 * Invariants: `storeDir` and `lockFile` are joined to the project directory without validation, so
 * a descriptor is trusted code, never user input. `discover(base)` returns `{ items, skipped }`
 * (items have `name` and `dir`, the folder or file of the unit in the checkout) and must find the same
 * units that `lookedFor` describes. `copy(dir, to, item)` writes a copy and `hash(path)` hashes an installed
 * one. A kind whose copy differs from its source (a command is rewritten into the normalized form) also
 * gives `sourceHash(dir, item)`, the hash its copy will have, so an unchanged source is recognised; and
 * `fileName(name)`, the name of the copy inside `storeDir` when it is not just the name. Both get the
 * discovered `item`, which knows what `dir` alone does not.
 */
export const SKILL_KIND = Object.freeze({
  noun: "skill",
  plural: "skills",
  storeDir: SKILLS_DIR,
  lockFile: LOCK_FILE,
  stores: Object.freeze({
    user: Object.freeze({ storeDir: "skills", lockFile: "skills.lock.json" }),
    local: Object.freeze({ storeDir: LOCAL_SKILLS_DIR, lockFile: LOCAL_LOCK_FILE }),
  }),
  lockKey: "skills",
  defaultBases: Object.freeze(["skills", "."]),
  discover,
  hash: hashDir,
  copy: copyDir,
  describe,
  lookedFor: (subdir) => `<name>/SKILL.md in ${subdir}`,
});

/**
 * Where a level keeps its copies and lock: the user level relative to the user config directory,
 * the others relative to the project.
 * @returns {{ root: string, storeDir: string, lockFile: string }}
 */
export function storeFor(kind, level, { projectDir, userDir }) {
  const store = level === "project" ? kind : kind.stores?.[level];
  if (!store) throw new Error(`unknown level "${level}"`);
  if (level === "user" && !userDir) throw new Error("the user config directory is not known");
  return { root: level === "user" ? userDir : projectDir, ...store };
}

/**
 * @param {Object} options
 * @param {string} options.spec `github:<owner>/<repo>`, or an https or ssh git URL
 * @param {string[]} [options.names] Install only these skills (all when empty)
 * @param {string[]} [options.exclude]
 * @param {string} [options.ref] Branch or tag
 * @param {string} [options.subdir] Folder of the repository that holds the skills
 * @param {string} options.projectDir
 * @param {string} options.cache Where fetched repositories are kept
 * @param {"user" | "project" | "local"} [options.level] Which store to install into (default project)
 * @param {string} [options.pin] A full commit SHA to fetch instead of a ref; the lock records it as the ref, so `update` stays on it
 * @param {string[]} [options.only] Install no other skills than these, and fail if one is missing
 * @param {string} [options.userDir] The user config directory, for the user level
 * @param {boolean} [options.force] Overwrite copies edited by hand and skills of another origin
 * @returns {{ commit: string, installed: string[], updated: string[], unchanged: string[], skipped: Array<{ name: string, reason: string }>, license: string | null, licensesSkipped: Array<{ name: string, reason: string }> }}
 */
export function installSkills(options) {
  return installAssets(SKILL_KIND, options);
}

/** `installSkills` for any asset kind; `kind` is a descriptor like `SKILL_KIND`. */
export function installAssets(kind, { approvals = null, spec, names = [], exclude = [], ref, subdir, projectDir, cache, force = false, execFn, allowFile = false, level = "project", userDir, pin, only, sourceExtra = {}, dryRun = false, onNoDescription, onSkipped, onServers }) {
  const { root, storeDir, lockFile: lockPath } = storeFor(kind, level, { projectDir, userDir });
  assertPlainStore(root, storeDir);
  const lockFile = path.join(root, lockPath);
  const lock = readLock(lockFile, kind.lockKey);
  // A dry run fetches into the cache and checks everything, and writes nothing in the project.
  const recovered = dryRun ? [] : clearStaging(path.join(root, path.dirname(storeDir), ".staging"), { storeAbs: path.join(root, storeDir), locked: lock[kind.lockKey], kind });
  const url = sourceUrl(spec, { allowFile });
  const checkedRef = checkRef(ref);
  // Installing again without saying where from keeps a source pinned to a commit pinned: it must not
  // silently go back to following the branch.
  const kept = !pin && checkedRef === undefined && /^[0-9a-f]{40}$/.test(lock.sources[spec]?.ref ?? "") ? lock.sources[spec].ref : undefined;
  const fetched = fetchSource({ url, ref: pin ?? checkedRef ?? kept, cache, execFn, allowFile });
  const checkout = fs.realpathSync(fetched.dir);
  const located = locateBase(checkout, subdir, kind.plural, kind.defaultBases);
  const { items: available, skipped } = kind.discover(located.base);
  // Each file that could not be read is said on stderr as well as listed in the result, so the result is unchanged.
  for (const { name, reason } of skipped) onSkipped?.({ kind: kind.noun, file: name, reason });
  if (available.length === 0 && skipped.length === 0) {
    throw new Error(`no ${kind.plural} found in ${spec} (looked for ${kind.lookedFor(located.subdir)})`);
  }

  const unknown = names.filter((name) => !available.some((item) => item.name === name));
  if (unknown.length > 0) {
    throw new Error(`not found in ${spec}: ${unknown.join(", ")} (available: ${available.map((item) => item.name).join(", ") || "none"})`);
  }
  const outside = (only ?? []).filter((name) => !available.some((item) => item.name === name));
  if (outside.length > 0) {
    throw new Error(`${spec} at ${fetched.commit.slice(0, 7)} lacks the reviewed skills: ${outside.join(", ")}`);
  }
  const chosen = available.filter((item) => (names.length === 0 || names.includes(item.name)) && (!only || only.includes(item.name)) && !exclude.includes(item.name));

  const locked = lock[kind.lockKey];
  const result = { commit: fetched.commit, recovered, installed: [], updated: [], unchanged: [], skipped, license: null, licensesSkipped: [], notes: {}, waiting: [] };
  const storeRoot = path.join(root, storeDir);
  let stored = [];
  try {
    stored = fs.existsSync(storeRoot) ? fs.readdirSync(storeRoot) : [];
  } catch (err) {
    throw new Error(`${path.relative(root, storeRoot)} cannot be read (${err.code ?? err.message}); nothing was installed`);
  }
  const storedNames = stored.filter((name) => name !== ".licenses").map((name) => (kind.fileName ? name.replace(/\.md$/, "") : name));

  for (const item of chosen) {
    const target = path.join(root, storeDir, kind.fileName?.(item.name) ?? item.name);
    // `Foo` and `foo` are one file on a case-insensitive filesystem: another spelling of this name that is locked
    // or stored is a different unit that would be overwritten (and then look edited), so it is skipped. The one
    // exception: the same source renamed the unit upstream and --force was given on a filesystem that ignores
    // case, where the old and the new spelling are the same file and it is rewritten in place; nothing is ever
    // deleted for a rename. A locked name whose file is gone (it was removed by hand, as the message asks) is no clash.
    const lockedHere = Object.keys(locked).filter((name) => fs.existsSync(path.join(storeRoot, kind.fileName?.(name) ?? name)));
    const clash = [...lockedHere, ...storedNames].find((other) => other !== item.name && other.toLowerCase() === item.name.toLowerCase());
    const old = clash !== undefined && Object.hasOwn(locked, clash) ? locked[clash] : undefined;
    const renamed = old?.source === spec && !available.some((other) => other.name === clash);
    const inPlace = renamed && force && sameFile(path.join(storeRoot, kind.fileName?.(clash) ?? clash), target);
    if (clash !== undefined && !inPlace) {
      result.skipped.push({
        name: item.name,
        reason: renamed
          ? `renamed upstream from "${clash}"; remove the installed ${kind.fileName?.(clash) ?? clash} by hand and install again, or use --force on a filesystem that ignores case`
          : `differs only in case from the installed "${clash}"`,
      });
      continue;
    }
    for (const name of Object.keys(locked)) {
      if (name !== item.name && name.toLowerCase() === item.name.toLowerCase() && !lockedHere.includes(name)) delete locked[name];
    }
    // A kind can refuse a name another level already has (hooks: a hook never hides another).
    const clash2 = kind.clash?.(item.name, { level, projectDir, userDir });
    if (clash2) {
      result.skipped.push({ name: item.name, reason: `already exists at the ${clash2} level; remove one (a ${kind.noun} never hides another)` });
      continue;
    }
    const entry = inPlace ? old : Object.hasOwn(locked, item.name) ? locked[item.name] : undefined;
    const present = fs.existsSync(target);
    let current;
    try {
      current = present ? hashOrNull(target, kind.hash) : undefined;
    } catch (err) {
      // One folder that cannot be read does not stop the others.
      result.skipped.push({ name: item.name, reason: printable(`could not be read: ${err.message.split("\n")[0]}`) });
      continue;
    }

    if (present && !force) {
      if (!entry) {
        result.skipped.push({ name: item.name, reason: "already exists and was not installed by toolgate (use --force to replace it)" });
        continue;
      }
      if (entry.source !== spec) {
        result.skipped.push({ name: item.name, reason: `installed from ${entry.source} (use --force to replace it)` });
        continue;
      }
      if (current !== entry.hash) {
        result.skipped.push({ name: item.name, reason: "edited since it was installed (use --force to overwrite it)" });
        continue;
      }
    }

    const hash = (kind.sourceHash ?? kind.hash)(item.dir, item);
    // A kind that runs something or widens access (`review`) is applied only with an approval of this exact content, on
    // this machine. Without one the unit waits: nothing is written, nothing is locked. `--force` never skips this.
    if (kind.review === true) {
      const key = unitKey({ projectDir, level, kind: kind.noun, name: item.name });
      if (approvals?.has(key, hash) !== true) {
        result.waiting.push({ name: item.name, hash, key, preview: kind.preview?.(item) ?? null, ...(kind.waitingExtra?.(item) ?? {}) });
        continue;
      }
    }
    if (present && entry?.hash === hash && entry.source === spec && current === hash) {
      result.unchanged.push(item.name);
      onServers?.(item.mcps);
    } else {
      // One unit that cannot be written is reported; the others, and the lock, still go through.
      try {
        if (!dryRun) replaceUnit(kind, { root, storeDir, name: item.name, from: item.dir, item });
      } catch (err) {
        result.skipped.push({ name: item.name, reason: printable(`could not be written: ${err.code ?? err.message}`) });
        continue;
      }
      (present ? result.updated : result.installed).push(item.name);
      onServers?.(item.mcps);
      // Said once, on stderr, only for what was really added (not a preview), so the stdout JSON does not change.
      if (!dryRun && !hasDescription(item)) onNoDescription?.(noDescriptionNotice(kind.noun, item.name, path.relative(checkout, item.path ?? item.dir)));
      // What was not kept, what was left as text and what the kind wants said (a subagent's default tools): never silent.
      const said = [...(item.dropped?.length ? [`not kept (never copied into the store): ${item.dropped.join(", ")}`] : []), ...(item.unsupported?.length ? [`placeholders with no equivalent, left as text: ${item.unsupported.join(", ")}`] : []), ...(kind.remark?.(item) ? [kind.remark(item)] : [])];
      if (said.length) result.notes[item.name] = said;
    }
    if (inPlace) delete locked[clash];
    locked[item.name] = {
      source: spec,
      commit: fetched.commit,
      path: path.relative(checkout, item.dir),
      hash,
      ...recordedOf(item),
    };
  }

  // The lock moves only when something was written or is already current: a store that could not be written to
  // must not make the lock say the source is at the new commit.
  if (!dryRun && result.installed.length + result.updated.length + result.unchanged.length > 0) {
    const previous = lock.sources[spec] ?? {};
    const excluded = [...new Set([...(previous.exclude ?? []), ...exclude])].sort(compare);
    lock.sources[spec] = { url, ref: pin ?? checkedRef ?? kept ?? null, commit: fetched.commit, path: located.subdir, ...(excluded.length ? { exclude: excluded } : {}), ...sourceExtra };
    const licenses = copyLicenses(checkout, root, spec, storeDir);
    result.license = licenses.dir;
    result.licensesSkipped = licenses.skipped;
    writeLock(lockFile, lock, kind.lockKey);
  }
  return result;
}
