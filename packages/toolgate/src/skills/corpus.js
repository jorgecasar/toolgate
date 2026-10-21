// Normalized qmd corpus: one markdown file per skill plus a generated `_index.md` catalog that
// doubles as the keyword-search fallback when qmd is unavailable.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { LINE_BREAKS, RESERVED_NAMES, SAFE_NAME, flatten, printable } from "../assets/common.js";

export const INDEX_FILE = "_index.md";
/**
 * Version of the card format. It is part of the index fingerprint, so a corpus written by an older
 * format is rebuilt by the next `skills index`, and the first line of every card, which
 * `parseCard` checks: a card without it was not written by a version that keeps every value on one
 * line, so it is unreadable rather than read with a guess. 2: one line per value.
 */
export const CARD_FORMAT = 2;
export const CARD_MARKER = `<!-- toolgate card ${CARD_FORMAT} -->`;
/** Command cards live in this folder of the corpus; skill cards stay at its root. */
export const COMMANDS_DIR = "commands";
/** Subagent cards live in this one. */
export const SUBAGENTS_DIR = "subagents";
export { RESERVED_NAMES };
/** Where `toolgate skills index` writes the corpus, relative to the project. */
export const DEFAULT_CORPUS_DIR = path.join(".toolgate", "skills-index", "corpus");
/**
 * Default qmd collection for a project. qmd collections are global to the machine, so the name
 * carries the directory name plus a short hash of the absolute path: two checkouts called the
 * same still get different collections.
 * @param {string} projectDir
 */
export function defaultCollection(projectDir) {
  const root = path.resolve(projectDir);
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 6);
  return `skills-${slug}-${hash}`;
}


/** Levels a skill can come from, lowest priority first (same order as the config layers). */
export const LEVELS = ["user", "project", "local"];

// Every value of a card is one line: the card is read back line by line (`parseCard`), so a value
// with a line break could carry a field of its own (`- Path: /elsewhere`).
const flat = flatten;
// A path keeps its spaces; only a line break could start a line of its own.
const lineSafe = (text) => String(text).replace(LINE_BREAKS, " ");
const list = (items) => (items.length ? flat(items.join(", ")) : "none");
// The catalog holds one asset per line with " | " between fields, so a pipe is escaped as well
// (`searchIndex` undoes the escape).
const oneLine = (text) => flat(text).replaceAll("|", "\\|");

/**
 * What differs between the kinds of asset in the corpus. Skills carry no kind in their card or
 * catalog line, which keeps them identical to what older versions wrote; only a command says what
 * it is and lives in its own folder.
 */
const CARD_KINDS = {
  skill: { dir: "", lines: () => [], field: "" },
  command: {
    dir: COMMANDS_DIR,
    lines: (item) => ["- Kind: command", ...(item.argumentHint ? [`- Argument hint: ${flat(item.argumentHint)}`] : [])],
    field: " | kind: command",
  },
  // A subagent card also says the tools the subagent really gets, and whether that is the default.
  subagent: {
    dir: SUBAGENTS_DIR,
    lines: (item) => ["- Kind: subagent", `- Tools: ${list(item.effectiveTools ?? [])}`, ...(item.toolsDefault ? ["- Tools default: yes"] : [])],
    field: " | kind: subagent",
  },
};
const cardKind = (item) => CARD_KINDS[item.kind] ?? CARD_KINDS.skill;

/** @param {import("./parse.js").Skill} skill */
export function renderSkill(skill) {
  return [
    CARD_MARKER,
    `# ${skill.name}`,
    "",
    flat(skill.description),
    "",
    `- Tags: ${list(skill.tags)}`,
    `- Required MCPs: ${list(skill.mcps)}`,
    ...cardKind(skill).lines(skill),
    `- Level: ${skill.level ?? "project"}`,
    ...(skill.shadows?.length ? [`- Shadows: ${skill.shadows.join(", ")}`] : []),
    `- Path: ${lineSafe(skill.path)}`,
    "",
  ].join("\n");
}

/** @param {import("./parse.js").Skill[]} skills */
export function renderIndex(skills) {
  const lines = skills.map(
    (s) =>
      `- **${s.name}** — ${oneLine(s.description)} | level: ${s.level ?? "project"}${cardKind(s).field} | tags: ${list(s.tags)} | mcps: ${list(s.mcps)} | path: ${s.path}`
  );
  return ["# Skills index", "", ...lines, ""].join("\n");
}

/**
 * Reads the description (the line under the title) and the `Path`, `Required MCPs`, `Kind`, `Level` and `Shadows` lines of a corpus card. A card
 * without `Kind` is a skill, as one without `Level` is a project one.
 * @param {string} text
 * @returns {{ description: string, path: string, mcps: string[], kind: "skill" | "command" | "subagent", argumentHint?: string, tools?: string[], toolsDefault?: boolean, level: string, shadows: string[] }}
 */
export function parseCard(text) {
  const lines = text.split("\n");
  if (lines[0] !== CARD_MARKER) throw new Error(`not a card of format ${CARD_FORMAT}`);
  // Marker, title, blank, description (one line), blank; the generated fields follow. Every value is
  // one line, so nothing a description or a hint says can be taken for a field.
  const block = lines.slice(5).join("\n");
  const field = (label) => block.match(new RegExp(`^- ${label}:[ \\t]*(.+)$`, "m"))?.[1].trim();
  const mcps = field("Required MCPs");
  return {
    description: lines[3].trim(),
    path: field("Path") ?? "",
    mcps: !mcps || mcps === "none" ? [] : mcps.split(",").map((name) => name.trim()).filter(Boolean),
    kind: ["command", "subagent"].find((kind) => kind === field("Kind")) ?? "skill",
    argumentHint: field("Argument hint"),
    ...(field("Tools") === undefined ? {} : { tools: field("Tools") === "none" ? [] : field("Tools").split(",").map((name) => name.trim()).filter(Boolean), toolsDefault: field("Tools default") === "yes" }),
    level: field("Level") ?? "project",
    shadows: (field("Shadows") ?? "").split(",").map((level) => level.trim()).filter(Boolean),
  };
}

/**
 * Cards of `corpusDir` that were not written in the current card format (by an older version),
 * as paths relative to the corpus. A missing corpus has none.
 * @param {string} corpusDir
 * @returns {string[]}
 */
export function staleCards(corpusDir) {
  const cards = (dir, prefix) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE).map((e) => `${prefix}${e.name}`);
    } catch {
      return [];
    }
  };
  const marked = (card) => {
    try {
      return fs.readFileSync(path.join(corpusDir, card), "utf8").split("\n", 1)[0] === CARD_MARKER;
    } catch {
      return true; // unreadable is not the same as old: other checks report it
    }
  };
  return [...cards(corpusDir, ""), ...cards(path.join(corpusDir, COMMANDS_DIR), `${COMMANDS_DIR}/`), ...cards(path.join(corpusDir, SUBAGENTS_DIR), `${SUBAGENTS_DIR}/`)].filter((card) => !marked(card));
}

/** Corpus file of a card, relative to the corpus: commands in their own folder, so a command and a skill may share a name. */
export const cardFile = (item) => cardPath(item.kind, item.name);

/** Corpus path of the card of `name`, from its kind. */
export function cardPath(kind, name) {
  return path.join(cardKind({ kind }).dir, `${name}.md`);
}

/**
 * Replace the corpus directory contents with the given skills and commands.
 * @param {Array<import("./parse.js").Skill | (import("../commands/parse.js").Command & { level?: string, shadows?: string[] })>} skills
 * @param {string} corpusDir
 */
export function writeCorpus(skills, corpusDir) {
  for (const { name, kind } of skills) {
    if (!SAFE_NAME.test(name) || RESERVED_NAMES.has(name)) throw new Error(`unsafe ${kind ?? "skill"} name "${name}"`);
  }
  // Whatever the folder is, only what toolgate itself wrote is removed (see `isGeneratedCard`): a
  // file of the user's, in the folder a config pointed at, is never touched.
  const index = path.join(corpusDir, INDEX_FILE);
  const existing = lstatOrNull(index);
  if (existing?.isDirectory()) throw new Error(`${printable(index)} is a folder; refusing to use ${printable(corpusDir)} as a corpus`);
  if (existing?.isFile() && !readSmall(index).startsWith(GENERATED_INDEX)) {
    throw new Error(`${printable(index)} is not a catalog written by toolgate; refusing to overwrite it`);
  }
  for (const dir of [COMMANDS_DIR, SUBAGENTS_DIR]) {
    const folder = lstatOrNull(path.join(corpusDir, dir));
    if (folder && !folder.isDirectory() && !folder.isSymbolicLink()) {
      throw new Error(`${printable(path.join(corpusDir, dir))} is a file; refusing to use ${printable(corpusDir)} as a corpus`);
    }
  }
  fs.mkdirSync(corpusDir, { recursive: true });
  clearGenerated(corpusDir);
  // Files are created exclusively (`wx`): a symlink left in the folder is never written through.
  create(index, renderIndex(skills));
  for (const skill of skills) {
    const file = path.join(corpusDir, cardFile(skill));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    create(file, renderSkill(skill));
  }
}

function create(file, text) {
  try {
    fs.writeFileSync(file, text, { flag: "wx" });
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`${printable(file)} exists and was not written by toolgate; refusing to overwrite it`);
    throw err;
  }
}

const MAX_CARD_BYTES = 256 * 1024;
const lstatOrNull = (file) => {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
};
// The text of a regular file, or "" when it is too big to be a card.
const readSmall = (file) => {
  const info = lstatOrNull(file);
  return info?.isFile() && info.size <= MAX_CARD_BYTES ? fs.readFileSync(file, "utf8") : "";
};

// Whether a regular file starts with the format marker. Only its first bytes are read, so a card of any
// size that carries the marker is recognised as toolgate's.
const hasMarker = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const head = Buffer.alloc(40);
    fs.readSync(fd, head, 0, 40, 0);
    return MARKED_CARD.test(head.toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

// A card in the old shape that is too big for `readSmall` is judged by its ends: the title at the start, and the generated
// fields up to the path at the end. It is removed like a small one, so a vanished skill is never routed to from a card left behind.
const OLD_HEAD = /^# [^\n]+\n\n/;
const OLD_TAIL = /\n\n- Tags: [^\n]*\n- Required MCPs: [^\n]*\n(?:- Kind: command\n(?:- Argument hint: [^\n]*\n)?)?- Level: [^\n]*\n(?:- Shadows: [^\n]*\n)?- Path: [^\n]*\n$/;
const hasOldShapeLarge = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size <= MAX_CARD_BYTES) return false;
    const head = Buffer.alloc(512);
    fs.readSync(fd, head, 0, 512, 0);
    const tail = Buffer.alloc(65536);
    fs.readSync(fd, tail, 0, 65536, info.size - 65536);
    return OLD_HEAD.test(head.toString("utf8")) && OLD_TAIL.test(tail.toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

const GENERATED_INDEX = "# Skills index\n";
// What toolgate writes, and so the only thing it removes: a card with the format marker, or one in the
// shape this and earlier versions wrote (a title, the description, then exactly the generated fields,
// ending at the path) so a corpus built by an older version can still be rebuilt.
const MARKED_CARD = /^<!-- toolgate card \d+ -->\n/;
const OLD_SHAPE_CARD = /^# [^\n]+\n\n[\s\S]*?\n\n- Tags: [^\n]*\n- Required MCPs: [^\n]*\n(?:- Kind: command\n(?:- Argument hint: [^\n]*\n)?)?- Level: [^\n]*\n(?:- Shadows: [^\n]*\n)?- Path: [^\n]*\n$/;
export const isGeneratedCard = (text) => MARKED_CARD.test(text) || OLD_SHAPE_CARD.test(text);

const CARD_FOLDERS = [COMMANDS_DIR, SUBAGENTS_DIR];
// Removes the cards toolgate generated: at the top level, and in `commands/` and `subagents/` when that is a real
// folder. Any other file stays, and so does a folder of the user's that is called `commands`. A
// symlink named like a card is removed itself, never followed.
function clearGenerated(corpusDir) {
  const ours = (full, entry) => entry.isSymbolicLink() || hasMarker(full) || isGeneratedCard(readSmall(full)) || hasOldShapeLarge(full);
  const isCardName = (entry) => entry.name.endsWith(".md") && !entry.isDirectory();
  for (const entry of fs.readdirSync(corpusDir, { withFileTypes: true })) {
    const full = path.join(corpusDir, entry.name);
    if (CARD_FOLDERS.includes(entry.name) && entry.isSymbolicLink()) {
      fs.unlinkSync(full);
    } else if (CARD_FOLDERS.includes(entry.name) && entry.isDirectory()) {
      for (const card of fs.readdirSync(full, { withFileTypes: true })) {
        if (isCardName(card) && ours(path.join(full, card.name), card)) fs.unlinkSync(path.join(full, card.name));
      }
      try {
        fs.rmdirSync(full);
      } catch {
        // it holds something that is not ours: it stays
      }
    } else if (isCardName(entry) && entry.name !== INDEX_FILE && ours(full, entry)) {
      fs.unlinkSync(full);
    }
  }
  fs.rmSync(path.join(corpusDir, INDEX_FILE), { force: true });
}

/**
 * `skills.corpusDir` comes from a project's config, which a repository can commit, and the folder is
 * emptied on every index. So it has to be a folder of toolgate's own: inside `<project>/.toolgate`
 * (never that folder itself) with no symlink on the way, whatever the folder holds.
 * @param {string} corpusDir
 * @param {string} projectDir
 */
export function assertCorpusLocation(corpusDir, projectDir, sourceDirs = []) {
  const root = path.resolve(projectDir, ".toolgate");
  const dir = path.resolve(corpusDir);
  if (dir === root || !dir.startsWith(`${root}${path.sep}`)) {
    throw new Error(`skills.corpusDir must be a folder inside ${printable(root)}, not ${printable(dir)}`);
  }
  // Not toolgate's other areas either: the stores of what is installed, the locks, the config files and the state
  // of the index. The folder may not be one of them, hold one, or sit inside one. Compared by name, ignoring case
  // (on a filesystem that ignores it `COMMANDS` is the store of commands even before it exists) and, for what
  // exists, by file identity, which also sees spellings a name comparison does not.
  const bound = path.resolve(projectDir);
  const dirNodes = chainNodes(dir, bound);
  const dirNode = nodeOf(dir);
  const relation = (area) => {
    const [low, lowArea] = [dir.toLowerCase(), area.toLowerCase()];
    const areaNode = nodeOf(area);
    const same = low === lowArea || (areaNode !== null && areaNode === dirNode);
    const inside = low.startsWith(`${lowArea}${path.sep}`) || (areaNode !== null && dirNodes.includes(areaNode));
    const holds = lowArea.startsWith(`${low}${path.sep}`) || (dirNode !== null && chainNodes(area, bound).includes(dirNode));
    return { same, inside, holds };
  };
  for (const area of OWN_AREAS.map((name) => path.join(root, name))) {
    const { same, inside, holds } = relation(area);
    if (same || inside || holds) {
      throw new Error(`skills.corpusDir ${printable(dir)} overlaps ${printable(area)}, which toolgate keeps for something else`);
    }
  }
  // The folders the project reads its skills and commands from: the corpus may sit inside one (the default
  // corpus is under the project, and `.` is a source), but it may not be one, or hold one.
  for (const source of sourceDirs.map((name) => path.resolve(name))) {
    const { same, holds } = relation(source);
    if (same || holds) {
      throw new Error(`skills.corpusDir ${printable(dir)} is, or holds, ${printable(source)}, a folder the project reads skills or commands from`);
    }
  }
  let walked = root;
  for (const part of ["", ...path.relative(root, dir).split(path.sep)]) {
    walked = path.join(walked, part);
    let info;
    try {
      info = fs.lstatSync(walked);
    } catch {
      return; // from here on nothing exists yet
    }
    if (info.isSymbolicLink()) throw new Error(`skills.corpusDir goes through a symlink (${printable(walked)}); refusing to use it`);
  }
}

// The identity of a file or folder (`device:inode`), or null when it does not exist.
export const nodeOf = (file) => {
  const info = lstatOrNull(file);
  return info ? `${info.dev}:${info.ino}` : null;
};
// The identities of a path and of each of its parents, up to `bound`.
function chainNodes(file, bound) {
  const nodes = [];
  for (let current = file; ; current = path.dirname(current)) {
    const node = nodeOf(current);
    if (node) nodes.push(node);
    if (current === bound || current === path.dirname(current)) return nodes;
  }
}

/** What toolgate keeps in `.toolgate` apart from the corpus: a corpus folder cannot be, hold or sit inside any of it. */
const OWN_AREAS = [
  "skills",
  "commands",
  "subagents",
  "skills.lock.json",
  "commands.lock.json",
  "subagents.lock.json",
  "config.json",
  "config.local.json",
  "state.json",
  path.join("skills-index", "state.json"),
];
