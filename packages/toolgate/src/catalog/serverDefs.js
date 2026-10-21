// The MCP servers a project can start, with where each definition comes from. Claude merges its layers; this keeps them apart,
// because the user's own configuration is trusted and a `.mcp.json` of a cloned repository is not.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validServerName } from "./sanitize.js";

const MAX_FILE_BYTES = 1024 * 1024;

function readJson(file, readFileFn, onMalformed) {
  let text;
  try {
    text = readFileFn(file, "utf8").replace(/^\uFEFF/, ""); // a byte order mark is not a syntax error
  } catch {
    return {};
  }
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (err) {
    // V8 quotes a piece of the file after the first words of its message, with line breaks in it when the file has them: the
    // message is cut where the quote starts, before anything else is done with it. The file could hold a secret.
    const message = String(err.message);
    const quote = message.search(/, (?:\.\.\.)?"/);
    onMalformed?.((quote < 0 ? message : message.slice(0, quote)).split("\n")[0]);
    return {};
  }
}

// A `.mcp.json` that is a link, not a file or over 1 MiB is not read: it comes from the repository. The user's own file has no limit.
function readProjectFile(file, readFileFn, onMalformed) {
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info || info.isSymbolicLink() || !info.isFile()) return {};
  // Over the limit it is not read, and that is said: its servers are missing, which is not "none configured".
  if (info.size > MAX_FILE_BYTES) {
    onMalformed?.("it is larger than 1 MiB");
    return {};
  }
  return readJson(file, readFileFn, onMalformed);
}

function projectEntry(projects, cwd) {
  if (projects === null || typeof projects !== "object") return {};
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (Object.hasOwn(projects, dir) && projects[dir] !== null && typeof projects[dir] === "object") return projects[dir];
    if (path.dirname(dir) === dir) return {};
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringMap = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) : {});

/**
 * What toolgate needs of a definition: a stdio command with its arguments and environment, or an http url with headers.
 * Anything else is an error, said and never guessed.
 */
export function normalizeDef(def) {
  if (!isObject(def)) return { error: "the definition is not an object" };
  if (def.type === "http" || def.type === "sse" || typeof def.url === "string") {
    let url;
    try {
      url = new URL(def.url);
    } catch {
      return { error: "the url is not valid" };
    }
    if (!["http:", "https:"].includes(url.protocol)) return { error: "only http and https urls are supported" };
    if (url.username || url.password) return { error: "the url holds credentials: put them in headers" };
    return { transport: "http", url: url.href, headers: stringMap(def.headers) };
  }
  if (typeof def.command !== "string" || def.command === "") return { error: "no command and no url" };
  if (def.args !== undefined && !(Array.isArray(def.args) && def.args.every((a) => typeof a === "string"))) return { error: "args is not a list of strings" };
  return { transport: "stdio", command: def.command, args: def.args ?? [], env: stringMap(def.env) };
}

/**
 * The servers of a project, each with its origin: `user` (the user's own `~/.claude.json`, top level or local scope) or
 * `project` (the `.mcp.json` of the repository). Precedence is Claude's (local, then project, then user); the definition
 * that wins decides the origin. Names that are not safe file names are returned apart, with the reason.
 * `malformed` is why the repository's `.mcp.json` could not be parsed, or null: its servers are missing, which is not "none configured".
 * @returns {{ servers: { name: string, origin: "user" | "project", def: object }[], invalid: { name: string, reason: string }[], malformed: string | null }}
 */
export function readServerDefsByOrigin({ cwd = process.cwd(), homedir = os.homedir(), readFileFn = fs.readFileSync } = {}) {
  const user = readJson(path.join(homedir, ".claude.json"), readFileFn);
  const local = projectEntry(user.projects, cwd);
  let malformed = null;
  const project = readProjectFile(path.join(cwd, ".mcp.json"), readFileFn, (reason) => (malformed = reason));
  const layers = [
    ["user", user.mcpServers],
    ["project", project.mcpServers],
    ["user", local.mcpServers],
  ];
  const winners = new Map();
  for (const [origin, servers] of layers) {
    if (!isObject(servers)) continue;
    for (const [name, def] of Object.entries(servers)) winners.set(name, { origin, def });
  }
  for (const name of Array.isArray(local.disabledMcpServers) ? local.disabledMcpServers : []) winners.delete(name);
  const servers = [];
  const invalid = [];
  for (const [name, { origin, def }] of [...winners].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!validServerName(name)) {
      invalid.push({ name: name.replace(/[^\x20-\x7e]/g, "?").slice(0, 64), reason: "not a safe file name (letters, digits, dot, dash, underscore; at most 64)" });
      continue;
    }
    servers.push({ name, origin, def });
  }
  return { servers, invalid, malformed };
}
