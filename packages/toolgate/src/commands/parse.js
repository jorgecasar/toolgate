// Command reader: turns a command file of any supported dialect into the one normalized form
// toolgate indexes and copies. Nothing here runs anything: execution-capable syntax is rewritten
// into plain instructions, so the copy is only text the agent reads.
import fs from "node:fs";
import path from "node:path";
import { RESERVED_NAMES, SAFE_NAME, asList, descriptionOf, extractRequiredMcps, flatten, hasDescription, parseFrontmatter, truncate } from "../assets/common.js";
import { MODEL } from "../subagents/parse.js";

/** @typedef {{ name: string, description: string, argumentHint?: string, allowedTools: string[], model?: string, tags: string[], mcps: string[], body: string, path: string, kind: "command", dropped: string[], unsupported: string[] }} Command */

/** Dialects whose body syntax is understood. */
export const DIALECTS = Object.freeze(["claude", "opencode", "codex", "antigravity", "rulesync"]);
/** `toolgate` is the name of the bridge command (#57), so no installed command may take it. */
export const RESERVED_COMMAND_NAMES = new Set([...RESERVED_NAMES, "toolgate"]);
export const MAX_COMMAND_BYTES = 64 * 1024;
/** The argument hint is shown to the agent next to the command, so it is one short line. */
export const MAX_HINT_LENGTH = 120;

const KEPT_KEYS = new Set(["name", "description", "argument-hint", "tags", "mcps"]);
const FENCE_OPEN = /^```/;
const FENCE_CLOSE = /^```[ \t]*$/;

/**
 * The text split at its fenced code blocks, the way `String.split` with a capturing regexp would
 * do: prose, block, prose, block, ..., prose. A block starts at a line that starts with three
 * backticks and ends at the first line, two or more lines on, that is only three backticks; an opening line with no closing
 * one after it is prose. One backward pass finds the next closing line of every line, so a body of
 * thousands of unclosed fences is read in linear time.
 * @param {string} text
 * @returns {string[]}
 */
function splitFences(text) {
  // Lines end where they do in Markdown (CommonMark): `\n`, `\r\n` and a lone `\r`. U+2028 and U+2029 do not
  // end a line. (The regular expression this replaced took them as line ends for `^` and `$` only, and a
  // `\n` for everything else, so a body with a lone `\r` or one of those two was read differently.)
  const lines = [];
  const starts = [];
  const ends = [];
  let lineStart = 0;
  for (const match of text.matchAll(/\r\n|[\n\r]/g)) {
    starts.push(lineStart);
    ends.push(match.index);
    lines.push(text.slice(lineStart, match.index));
    lineStart = match.index + match[0].length;
  }
  starts.push(lineStart);
  ends.push(text.length);
  lines.push(text.slice(lineStart));
  const nextClose = new Array(lines.length).fill(-1);
  let seen = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (i + 2 < lines.length && FENCE_CLOSE.test(lines[i + 2])) seen = i + 2;
    nextClose[i] = seen;
  }
  const parts = [];
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_OPEN.test(lines[i]) || nextClose[i] === -1) continue;
    const end = ends[nextClose[i]];
    parts.push(text.slice(from, starts[i]), text.slice(starts[i], end));
    from = end;
    i = nextClose[i];
  }
  parts.push(text.slice(from));
  return parts;
}
const ARGUMENT_TOKEN = /\$ARGUMENTS|\$[1-9]/;

// Inline shell and file inclusion.
const SYNTAX = {
  shell: /!`([^`\n]+)`/g,
  // A path needs a leading `./`, `../`, `~/` or `/`, or a file extension: `@scope/pkg` is not a file.
  file: /(^|[\s(])@((?:\.{0,2}\/|~\/)[\w.-]+(?:\/[\w.-]+)*|(?:[\w.-]+\/)*[\w-]+\.\w+)/g,
};

/**
 * Body in the normalized form: arguments as `$ARGUMENTS`, shell and file inclusion as visible
 * instructions. Returns the constructs that have no equivalent and were left as plain text.
 * @param {string} body
 * @returns {{ body: string, unsupported: string[] }}
 */
export function normalizeBody(body) {
  let text = body;
  text = text.replace(SYNTAX.shell, (_, command) => `(run \`${command.trim()}\` and use its output here)`);
  // File inclusion and placeholders only apply to prose: fenced code is literal (`npm i @a/b.js`, `$HOME`).
  // The odd entries of the split are the fenced blocks.
  const parts = splitFences(text);
  text = parts.map((part, index) => (index % 2 ? part : part.replace(SYNTAX.file, (_, before, file) => `${before}(read \`${file.trim()}\`)`))).join("");
  // Named placeholders (`$FOO`, Codex) have no positional equivalent: they stay as text and are reported.
  // Code spans are skipped: `$HOME` there is a shell variable, not a placeholder.
  const prose = parts.filter((_, index) => index % 2 === 0).join("\n").replace(/`[^`\n]*`/g, "");
  const named = [...prose.matchAll(/\$([A-Z][A-Z0-9_]*)/g)].map((match) => match[0]).filter((token) => token !== "$ARGUMENTS");
  return { body: text, unsupported: [...new Set(named)].sort() };
}

function readText(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_COMMAND_BYTES) throw new Error(`${filePath}: larger than ${MAX_COMMAND_BYTES} bytes`);
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

const MAX_ALLOWED_TOOLS = 100;
// `allowed-tools` is a comma list or a YAML list of strings; each entry is a tool the command may use (Claude also
// writes patterns such as `Bash(git add:*)`, so only its shape is checked: text, one line, not huge).
function allowedToolList(value, filePath) {
  if (value === undefined) return [];
  const list = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
    throw new Error(`${filePath}: frontmatter "allowed-tools" must be a string or a list of strings`);
  }
  const tools = list.map((item) => item.trim()).filter(Boolean);
  if (tools.length > MAX_ALLOWED_TOOLS) throw new Error(`${filePath}: "allowed-tools" lists more than ${MAX_ALLOWED_TOOLS} tools`);
  for (const tool of tools) {
    if (tool.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(tool)) throw new Error(`${filePath}: "allowed-tools" has an entry that is not plain text`);
  }
  return [...new Set(tools)];
}

/**
 * @param {string} filePath
 * @param {Object} [options]
 * @param {string} [options.dialect] One of `DIALECTS`
 * @param {string} [options.relative] Path inside the source folder; nested folders join with `-`
 * @returns {Command}
 */
export function parseCommand(filePath, { dialect = "claude", relative } = {}) {
  if (!DIALECTS.includes(dialect)) throw new Error(`unknown command dialect "${dialect}" (use ${DIALECTS.join(", ")})`);
  const text = readText(filePath);
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    throw new Error(`${filePath}: ${err.message.split("\n")[0]}`, { cause: err });
  }
  const { data, body: raw } = parsed;

  const stem = (relative ?? path.basename(filePath)).replace(/\.[^./]+$/, "").split(/[\\/]/).join("-");
  if (data.name !== undefined && (typeof data.name !== "string" || !data.name)) {
    throw new Error(`${filePath}: frontmatter "name" must be a non-empty string`);
  }
  const name = data.name ?? stem;
  if (!SAFE_NAME.test(name) || RESERVED_COMMAND_NAMES.has(name)) {
    throw new Error(`${filePath}: "${name}" cannot be used as a command name`);
  }
  if (raw.trim() === "") throw new Error(`${filePath}: the command has no body`);

  const declaredHint = data["argument-hint"];
  if (declaredHint !== undefined && typeof declaredHint !== "string") {
    throw new Error(`${filePath}: frontmatter "argument-hint" must be a string`);
  }
  const allowedTools = allowedToolList(data["allowed-tools"], filePath);
  const model = data.model;
  if (model !== undefined && (typeof model !== "string" || !MODEL.test(model))) {
    throw new Error(`${filePath}: frontmatter "model" must be a model id`);
  }
  const hint = declaredHint === undefined ? undefined : truncate(flatten(declaredHint), MAX_HINT_LENGTH);
  const { body, unsupported } = normalizeBody(raw.trim());
  const declared = asList(data.mcps, "mcps", filePath);
  return {
    name,
    description: descriptionOf(data),
    ...(hint ? { argumentHint: hint } : {}),
    // Read and checked, not copied: a copy of a command is text and grants nothing (both stay in `dropped`).
    allowedTools,
    ...(model === undefined ? {} : { model }),
    tags: asList(data.tags, "tags", filePath),
    mcps: declared.length ? declared : extractRequiredMcps(body),
    body,
    path: filePath,
    kind: "command",
    dropped: Object.keys(data).filter((key) => !KEPT_KEYS.has(key)).sort(),
    unsupported,
  };
}

// JSON strings are valid YAML, so every value is quoted and a colon or a leading dash is safe.
/**
 * The generated copy: kept frontmatter only, then the body. Commands that use arguments say where
 * they come from, because the agent reads this file and no `/command` is registered to fill them in.
 * @param {Command} command
 * @returns {string}
 */
export function renderCommand(command) {
  const head = [`name: ${JSON.stringify(command.name)}`];
  if (hasDescription(command)) head.push(`description: ${JSON.stringify(command.description)}`);
  if (command.argumentHint) head.push(`argument-hint: ${JSON.stringify(command.argumentHint)}`);
  if (command.tags.length) head.push(`tags: ${JSON.stringify(command.tags)}`);
  if (command.mcps.length) head.push(`mcps: ${JSON.stringify(command.mcps)}`);
  const note = ARGUMENT_TOKEN.test(command.body)
    ? [
        "Arguments: the text after the command name in the user's request, substituted where `$ARGUMENTS` (or `$1`..`$9`) appears.",
        "",
      ]
    : [];
  return ["---", ...head, "---", "", ...note, command.body, ""].join("\n");
}
