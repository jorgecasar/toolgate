// Helpers every asset kind (skills, commands) shares: what a safe name is, how frontmatter and
// frontmatter lists are read, and which names the corpus keeps for itself.
import path from "node:path";
import yaml from "js-yaml";

// The characters that change how text is shown, or hide it, without being seen. One list for every output.
// Controls: C0 (a newline that starts a fake line, an ANSI escape), DEL and C1.
const CONTROLS = "\\u0000-\\u001f";
const C1 = "\\u007f-\\u009f";
// Invisible or blank: the soft hyphen, the combining grapheme joiner, the Arabic letter mark, the Hangul and halfwidth Hangul
// fillers, the Khmer and Mongolian format characters, the zero-width space, the bidi controls (text that reads backwards), line
// and paragraph separators, the word joiner and the invisible operators, the braille blank, the ideographic Hangul filler, the
// variation selectors (all but the two emoji ones), the BOM, the interlinear annotations, the tag characters, any lone surrogate.
const HIDDEN =
  "\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164" +
  "\\ufe00-\\ufe0d\\ufeff\\uffa0\\ufff9-\\ufffb\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}\\p{Cs}";
// What a person decides on (a prompt that asks "run this?") shows even more: the joiners and the emoji selectors, the
// no-break space, the noncharacters and every other format character.
const STRICT = `${HIDDEN}\\u00a0\\u200c\\u200d\\ufe0e\\ufe0f\\ufdd0-\\ufdef\\ufffe\\uffff\\p{Cf}`;
const SHOWN = new RegExp(`[${CONTROLS}${C1}${HIDDEN}]`, "gu");
const SHOWN_STRICT = new RegExp(`[${CONTROLS}${C1}${STRICT}]`, "gu");
const IN_JSON = new RegExp(`[${C1}${HIDDEN}]`, "gu");
/** True when the text has a control character or one that hides or reorders text (the joiners and emoji selectors are fine). */
export const hasHiddenChars = (text) => new RegExp(`[${CONTROLS}${C1}${HIDDEN}]`, "u").test(text);
// \uXXXX, or \u{XXXXX} above the BMP.
const escapeOf = (char) => {
  const code = char.codePointAt(0).toString(16).padStart(4, "0");
  return code.length > 4 ? `\\u{${code}}` : `\\u${code}`;
};
/**
 * Text that came from a lock, a folder name or a remote repository, made safe to print: control
 * characters and the ones that hide or reorder text are shown as escapes, so what is printed is one line of plain text.
 * Output of toolgate commands ends up in an agent's context. The joiners U+200C and U+200D and the emoji selectors stay:
 * emoji and several scripts need them.
 */
export function printable(value) {
  return String(value).replace(SHOWN, (char) => (char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : escapeOf(char)));
}
/**
 * Text shown to someone who is deciding whether to run it: whole, in quotes, and every control, separator, override and
 * invisible or format character (the joiners and every variation selector too) written out, so nothing is hidden.
 */
export function exact(value) {
  return JSON.stringify(String(value)).replace(SHOWN_STRICT, escapeOf);
}
/**
 * JSON text with the characters that hide or reorder text (C1 controls, bidi controls, zero-width characters, tag characters...)
 * written as \u escapes, which JSON.stringify leaves as they are. Line breaks between tokens stay; above the BMP an escape is a
 * surrogate pair.
 */
export const jsonSafe = (text) =>
  text.replace(IN_JSON, (char) => Array.from({ length: char.length }, (_, i) => `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""));
/** JSON.parse that drops `__proto__` keys: they would set the prototype of an object that gets merged or assigned into. */
export const parseJson = (text) => JSON.parse(text, (key, value) => (key === "__proto__" ? undefined : value));
/** Every character that ends a line: the ones JavaScript regular expressions know plus U+0085. */
export const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;
/** One line of text: every run of whitespace, line breaks (U+0085, U+2028 and U+2029 too) included, is one space. */
export const flatten = (text) => String(text).split(/[\s\u0085]+/).filter(Boolean).join(" ");
/** At most `max` characters, cut between code points so a surrogate pair is never split. */
export const truncate = (text, max) => Array.from(String(text)).slice(0, max).join("");

// Not only dots: "." and ".." would resolve to the store folder or its parent.
export const SAFE_NAME = /^(?!\.+$)[\w.-]+$/;
/** Longest name an install writes: a store file name has to fit the filesystem (255 bytes) with its suffixes. */
export const MAX_NAME_LENGTH = 100;

/**
 * A frontmatter value as a list of strings: absent is empty, one string is a one-item list.
 * @param {unknown} value
 * @param {string} key
 * @param {string} filePath
 * @returns {string[]}
 */
export function asList(value, key, filePath) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  if (!list.every((item) => typeof item === "string")) {
    throw new TypeError(`${filePath}: frontmatter "${key}" must be a list of strings`);
  }
  return list;
}

// qmd reports the catalog as `index.md` (it drops the leading underscore), so both spellings are
// reserved: an asset with either name could not be told apart from the catalog in search hits.
export const RESERVED_NAMES = new Set(["_index", "index", "__proto__"]);

/** Linear-time split of a `---` delimited header from the body (no backtracking regex). */
function splitFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0].trimEnd() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (end === -1) return null;
  return { head: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/**
 * Frontmatter is parsed by js-yaml's default schema, which never builds JS objects or runs code.
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, body: string }}
 */
export function parseFrontmatter(text) {
  const split = splitFrontmatter(text);
  if (!split) return { data: {}, body: text };

  const data = yaml.load(split.head) ?? {};
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new TypeError("frontmatter must be a YAML mapping");
  }
  return { data, body: split.body };
}

function isRequiredMcpsHeading(line) {
  const title = line.replace(/^#+/, "").trim().toLowerCase();
  return title === "required mcps" || title === "required mcp";
}

/**
 * Server names listed under a "Required MCPs" heading, up to the next heading.
 * @param {string} body
 * @returns {string[]}
 */
export function extractRequiredMcps(body) {
  const mcps = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = isRequiredMcpsHeading(line);
      continue;
    }
    const item = inSection && /^\s*[-*]\s+`?([\w@./:-]+)`?/.exec(line);
    if (item) mcps.push(item[1]);
  }
  return mcps;
}

/** A skill, command or subagent says what it is for when its description is text with something in it. */
export const hasDescription = (item) => typeof item?.description === "string" && item.description.trim() !== "";
/** The description as stored: the text, or empty when the frontmatter has none (missing, not a string). */
export const descriptionOf = (data) => (typeof data.description === "string" ? data.description : "");
/** The line said once when an item without a description is added: route and need will show it without one. */
export const noDescriptionNotice = (noun, name, file) => `toolgate: ${noun} ${printable(name)} has no description (${printable(file)}); route and need will show it without one`;
/** A callback that writes those lines to a stream (stderr), one per call. */
export const warnNoDescription = (stream) => (line) => stream.write(`${line}\n`);
/** The line said when a file could not be read as a skill, command or subagent and was left out. */
export const skippedNotice = (kind, file, reason) => `toolgate: ${kind} ${printable(file)} was skipped: ${printable(reason)}; run "toolgate doctor"`;
/** A callback that writes that line to a stream (stderr) for an item `{ kind, file, reason }`; a file inside `base` is shown relative to it. */
export const warnSkipped = (stream, base) => ({ kind, file, reason }) => {
  const relative = base && path.isAbsolute(file) ? path.relative(base, file) : file;
  stream.write(`${skippedNotice(kind, relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file, reason)}\n`);
};
