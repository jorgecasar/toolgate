// Permission reader: turns a permission unit (one JSON file of `deny`, `ask` and `allow` rules) into the neutral form
// toolgate stores, shows and applies. `deny` and `ask` only narrow what the agent may do; `allow` is a grant, so the
// callers keep it apart. What can widen access beyond the rules (`defaultMode`, `additionalDirectories`) is dropped.
import fs from "node:fs";
import path from "node:path";
import { RESERVED_NAMES, SAFE_NAME, parseJson, printable } from "../assets/common.js";

/** @typedef {{ name: string, description: string, deny: string[], ask: string[], allow: string[], path: string, kind: "permission", dropped: string[] }} Permission */

export const RESERVED_PERMISSION_NAMES = new Set([...RESERVED_NAMES, "toolgate"]);
export const MAX_PERMISSION_FILE_BYTES = 16 * 1024;
export const MAX_RULES = 200;
export const MAX_RULE_LENGTH = 512;
const LISTS = ["deny", "ask", "allow"];
const TOP_KEYS = new Set(["name", "description", ...LISTS]);
// `Tool` or `Tool(specifier)`; a server rule is `mcp__<server>` or `mcp__<server>__<tool>` and takes no parentheses.
const TOOL_RULE = /^[A-Za-z][\w]{0,99}(\([^\n\r]*\))?$/;
const MCP_RULE = /^mcp__[\w-]{1,100}(__[\w-]{1,100})?$/;

const fail = (file, message) => new Error(`${file}: ${message}`);

function checkRule(file, rule, list) {
  if (typeof rule !== "string" || rule === "" || Array.from(rule).length > MAX_RULE_LENGTH || printable(rule) !== rule) {
    throw fail(file, `a "${list}" rule must be plain text of at most ${MAX_RULE_LENGTH} characters`);
  }
  if (rule.startsWith("mcp__")) {
    if (!MCP_RULE.test(rule)) throw fail(file, `rule ${printable(rule).slice(0, 60)} is not valid: an mcp__ rule is mcp__<server> or mcp__<server>__<tool>, without parentheses`);
    return;
  }
  if (!TOOL_RULE.test(rule)) throw fail(file, `rule ${printable(rule).slice(0, 60)} is not valid: use Tool or Tool(specifier)`);
}

/**
 * @param {string} file
 * @param {Object} [options]
 * @param {string} [options.relative] Name from the file name when the file has none
 * @returns {Permission}
 */
export function parsePermission(file, { relative } = {}) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) throw fail(file, "a permission is a regular file, and a symlink is not followed");
  if (info.size > MAX_PERMISSION_FILE_BYTES) throw fail(file, `larger than ${MAX_PERMISSION_FILE_BYTES} bytes`);
  let data;
  try {
    data = parseJson(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    throw fail(file, `not valid JSON (${err.message.split("\n")[0]})`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw fail(file, "must hold an object");

  // Nested folders join with a dash, as for commands and subagents.
  const name = data.name ?? (relative ?? path.basename(file)).replace(/\.json$/, "").split(/[\\/]/).join("-");
  if (typeof name !== "string" || !SAFE_NAME.test(name) || RESERVED_PERMISSION_NAMES.has(name)) throw fail(file, `"${printable(String(name)).slice(0, 60)}" cannot be used as a permission name`);
  if (typeof data.description !== "string" || data.description === "" || Array.from(data.description).length > MAX_RULE_LENGTH || printable(data.description) !== data.description) {
    throw fail(file, 'needs a "description" (plain text, one line)');
  }
  const rules = {};
  let total = 0;
  for (const list of LISTS) {
    const given = data[list] ?? [];
    if (!Array.isArray(given)) throw fail(file, `"${list}" must be a list of rules`);
    given.forEach((rule) => checkRule(file, rule, list));
    rules[list] = [...new Set(given)];
    total += rules[list].length;
  }
  if (total === 0) throw fail(file, "has no rule");
  if (total > MAX_RULES) throw fail(file, `more than ${MAX_RULES} rules`);
  return { name, description: data.description, ...rules, path: file, kind: "permission", dropped: Object.keys(data).filter((key) => !TOP_KEYS.has(key)).sort() };
}

/** The normalized file: the kept fields in a fixed order, so the same rules always have the same text and hash. */
export function renderPermission(permission) {
  return `${JSON.stringify({ name: permission.name, description: permission.description, deny: permission.deny, ask: permission.ask, allow: permission.allow }, null, 2)}\n`;
}
