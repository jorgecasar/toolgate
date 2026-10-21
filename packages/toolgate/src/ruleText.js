import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The Step 0 rule that ships with toolgate. */
export const BUILTIN_RULE_TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "step0-rule.md");

/** The file the Step 0 text comes from: `rule.template` (already limited to the layers the user controls) or the built-in one. */
export const ruleTemplateFile = (config, cwd) => (config?.rule?.template === undefined ? BUILTIN_RULE_TEMPLATE : path.resolve(cwd, config.rule.template));

/**
 * Reads a rule template. A folder, a FIFO or /dev/null is not a rule: reading a FIFO would hang, /dev/null would give an empty rule.
 * @param {string} file
 * @returns {string}
 * @throws when the file is not a readable regular file
 */
export function readRuleText(file) {
  if (!fs.statSync(file).isFile()) throw new Error("not a regular file");
  const text = fs.readFileSync(file);
  const problem = ruleTextProblem(text);
  if (problem) throw new Error(problem);
  return text.toString("utf8");
}

/** The most a rule template may hold: it goes into the agent's prompt, so it is a short text, not a document. */
export const MAX_RULE_BYTES = 64 * 1024;
export const RULE_TEXT_WHY = "it must be a non-empty text file of at most 64 KiB";
/** Why these bytes are not a rule (empty, a NUL byte, over the limit), or null. */
export const ruleTextProblem = (bytes) => (bytes.length === 0 || bytes.length > MAX_RULE_BYTES || bytes.includes(0) ? RULE_TEXT_WHY : null);

/**
 * Whether a `rule.template` is no rule at all, before anything is read to use it: not a text path, or a file that exists and is
 * empty, binary or too long. A file that is not there (or cannot be read) is not judged here: reading it to use it says so.
 * @param {unknown} template
 * @param {string | undefined} cwd where a relative template is resolved; without it only the type is checked
 * @returns {boolean} true when the template is invalid
 */
export function ruleTemplateInvalid(template, cwd) {
  if (typeof template !== "string" || template === "") return true;
  if (cwd === undefined) return false;
  let fd;
  try {
    const file = path.resolve(cwd, template);
    const info = fs.statSync(file);
    if (!info.isFile()) return false;
    if (info.size === 0 || info.size > MAX_RULE_BYTES) return true;
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(info.size);
    fs.readSync(fd, bytes, 0, info.size, 0);
    return ruleTextProblem(bytes) !== null;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A TOML basic string for `text`: `\\`, `"` and every control character are escaped (`\n`, `\t`, `\uXXXX`), and a lone surrogate
 * becomes U+FFFD. It is one line, so it travels as one command-line argument.
 * @param {string} text
 * @returns {string}
 */
export function tomlString(text) {
  const escapes = { "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f" };
  const body = text.toWellFormed().replace(/[\\"\u0000-\u001f\u007f]/g, (ch) => escapes[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `"${body}"`;
}
