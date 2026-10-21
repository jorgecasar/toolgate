// Subagent reader: turns a subagent definition of any supported dialect into the one neutral form toolgate
// indexes and copies. A subagent is a system prompt plus the tools it may use, which the agent obeys with its
// own permissions, so only what describes it is kept: name, description, tools, model, servers and the prompt.
// A subagent gets the least: only the tools its definition lists, and a read-only set when it lists none (it never
// inherits every tool of the agent). Everything that changes what it is allowed to do (hooks, permission mode, inline servers) is dropped and listed.
import fs from "node:fs";
import path from "node:path";
import { RESERVED_NAMES, SAFE_NAME, asList, descriptionOf, extractRequiredMcps, hasDescription, hasHiddenChars, parseFrontmatter, printable } from "../assets/common.js";

/** @typedef {{ name: string, description: string, tools: string[] | null, model?: string, tags: string[], mcps: string[], prompt: string, path: string, kind: "subagent", dropped: string[] }} Subagent */

/** `claude`: `.claude/agents/*.md`; `opencode`: `.opencode/agent/*.md`. Other agents are not read yet. */
export const SUBAGENT_DIALECTS = Object.freeze(["claude", "opencode"]);
/** Names the agents have for subagents of their own, and `toolgate`: a user definition cannot take them (compared without case). */
export const RESERVED_SUBAGENT_NAMES = new Set([...RESERVED_NAMES, "toolgate", "general-purpose", "explore", "plan"]);
export const MAX_SUBAGENT_BYTES = 64 * 1024;
const MAX_TOOLS = 100;
// A tool is what the subagent is given: a name (`Read`), a scoped form (`Bash(git:*)`) or a server pattern (`mcp__ok__*`), as a
// command's `allowed-tools` takes them. Only the shape is checked: one line of plain text, not huge, nothing hidden.
const MAX_TOOL_LENGTH = 200;
// A comma in the string form cuts `Bash(git add,commit:*)` in two pieces; a piece with a parenthesis left open or closed too
// early is not a tool, like any other invalid name.
const balanced = (tool) => {
  let depth = 0;
  for (const char of tool) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (depth < 0) return false;
  }
  return depth === 0;
};
const validTool = (tool) => tool !== "" && Array.from(tool).length <= MAX_TOOL_LENGTH && !hasHiddenChars(tool) && balanced(tool);
const SERVER_NAME = /^[\w.-]{1,100}$/;
/** What a model id looks like (a subagent's `model`, and a command's). */
export const MODEL = /^[\w.:/@-]{1,100}$/;

/** What a subagent that lists no tools gets (names as Claude Code has them; each adapter maps them to its own). */
export const DEFAULT_SUBAGENT_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);
/** The tools a subagent really gets: the ones it lists, or the read-only default. */
export const effectiveTools = (subagent) => subagent.tools ?? DEFAULT_SUBAGENT_TOOLS;

const KEPT_KEYS = new Set(["name", "description", "tools", "tools-default", "model", "tags", "mcps"]);

function readText(filePath) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_SUBAGENT_BYTES) throw new Error(`${filePath}: larger than ${MAX_SUBAGENT_BYTES} bytes`);
  return fs.readFileSync(filePath, "utf8").replace(/^﻿/, "").replaceAll("\r\n", "\n");
}

// A list of tool names: Claude writes `Read, Grep` or a YAML list, the neutral copy a JSON list.
function toolList(value, key, filePath) {
  const list = typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : asList(value, key, filePath);
  if (list.length > MAX_TOOLS) throw new Error(`${filePath}: "${key}" lists more than ${MAX_TOOLS} tools`);
  for (const tool of list) {
    if (!validTool(tool)) throw new Error(`${filePath}: "${key}" has a tool name that is not plain text: ${printable(tool).slice(0, 40)}`);
  }
  return [...new Set(list)];
}

// opencode writes `tools: { write: true, bash: false }`: the enabled ones are the tools; a disabled one is not a tool.
function toolMap(value, filePath) {
  const enabled = [];
  for (const [tool, on] of Object.entries(value)) {
    if (typeof on !== "boolean") throw new Error(`${filePath}: "tools" must map each tool to true or false`);
    if (on) enabled.push(tool);
  }
  return toolList(enabled, "tools", filePath);
}

/**
 * @param {string} filePath
 * @param {Object} [options]
 * @param {string} [options.dialect] One of `SUBAGENT_DIALECTS`
 * @param {string} [options.relative] Path inside the source folder; nested folders join with `-`
 * @returns {Subagent} `tools` is null when the definition lists none: the subagent then gets `DEFAULT_SUBAGENT_TOOLS`
 */
export function parseSubagent(filePath, { dialect = "claude", relative } = {}) {
  if (!SUBAGENT_DIALECTS.includes(dialect)) throw new Error(`unknown subagent dialect "${dialect}" (use ${SUBAGENT_DIALECTS.join(", ")})`);
  const text = readText(filePath);
  let parsed;
  try {
    parsed = parseFrontmatter(text);
  } catch (err) {
    throw new Error(`${filePath}: ${err.message.split("\n")[0]}`, { cause: err });
  }
  const { data, body } = parsed;

  const stem = (relative ?? path.basename(filePath)).replace(/\.[^./]+$/, "").split(/[\\/]/).join("-");
  if (data.name !== undefined && (typeof data.name !== "string" || !data.name)) {
    throw new Error(`${filePath}: frontmatter "name" must be a non-empty string`);
  }
  const name = data.name ?? stem;
  if (!SAFE_NAME.test(name) || RESERVED_SUBAGENT_NAMES.has(name.toLowerCase())) {
    throw new Error(`${filePath}: "${printable(name).slice(0, 60)}" cannot be used as a subagent name`);
  }
  const prompt = body.trim();
  if (prompt === "") throw new Error(`${filePath}: the subagent has no prompt`);

  let tools = null;
  const declared = data.tools;
  // The neutral copy marks a default it wrote itself, so reading it again does not make the default a declared list. A mark
  // next to any other list still means the default, so a hand edit cannot widen what a subagent gets; the list the author
  // wrote is then reported as dropped, not silently lost.
  let listIgnored = false;
  if (declared !== undefined && declared !== null) {
    const isMap = dialect === "opencode" && typeof declared === "object" && !Array.isArray(declared);
    if (data["tools-default"] === true) {
      let list = null;
      try {
        list = isMap ? toolMap(declared, filePath) : toolList(declared, "tools", filePath);
      } catch {
        // not a list that could be read: it was ignored all the same
      }
      listIgnored = !(list && list.length === DEFAULT_SUBAGENT_TOOLS.length && DEFAULT_SUBAGENT_TOOLS.every((tool) => list.includes(tool)));
    } else {
      const list = isMap ? toolMap(declared, filePath) : toolList(declared, "tools", filePath);
      // An empty list written by the author is not "no tools declared": it is refused, never widened into the default.
      if (!list.length) throw new Error(`${filePath}: "tools" is empty (list at least one tool, or leave it out for the read-only default)`);
      tools = list;
    }
  }

  if (data.model !== undefined && (typeof data.model !== "string" || !MODEL.test(data.model))) {
    throw new Error(`${filePath}: frontmatter "model" must be a model id`);
  }
  const mcps = asList(data.mcps, "mcps", filePath);
  const servers = mcps.length ? mcps : extractRequiredMcps(prompt);
  for (const server of servers) {
    if (!SERVER_NAME.test(server)) throw new Error(`${filePath}: a server name is not a plain name: ${printable(server).slice(0, 40)}`);
  }
  return {
    name,
    description: descriptionOf(data),
    tools,
    ...(data.model ? { model: data.model } : {}),
    tags: asList(data.tags, "tags", filePath),
    mcps: servers,
    prompt,
    path: filePath,
    kind: "subagent",
    dropped: [...Object.keys(data).filter((key) => !KEPT_KEYS.has(key)), ...(listIgnored ? ["tools"] : [])].sort(),
  };
}

// JSON strings are valid YAML, so every value is quoted and a colon or a leading dash is safe.
/**
 * The generated copy: kept frontmatter only, then the prompt. `tools` is always written: the declared list, or
 * the read-only default with `tools-default: true`, so a copy never gives more than the minimum.
 * @param {Subagent} subagent
 * @returns {string}
 */
export function renderSubagent(subagent) {
  const head = [`name: ${JSON.stringify(subagent.name)}`];
  if (hasDescription(subagent)) head.push(`description: ${JSON.stringify(subagent.description)}`);
  head.push(`tools: ${JSON.stringify(effectiveTools(subagent))}`);
  if (!subagent.tools) head.push("tools-default: true");
  if (subagent.model) head.push(`model: ${JSON.stringify(subagent.model)}`);
  if (subagent.tags.length) head.push(`tags: ${JSON.stringify(subagent.tags)}`);
  if (subagent.mcps.length) head.push(`mcps: ${JSON.stringify(subagent.mcps)}`);
  return ["---", ...head, "---", "", subagent.prompt, ""].join("\n");
}
