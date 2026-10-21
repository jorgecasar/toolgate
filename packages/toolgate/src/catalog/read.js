// Reads the catalog folder that `toolgate catalog build` writes. Never throws: what cannot be read is a problem, not an error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCatalogPath } from "./path.js";
import { catalogServer, isCatalogFile, parseTools } from "./render.js";
import { validServerName } from "./sanitize.js";
import { readServerDefsByOrigin } from "./serverDefs.js";

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 500;

/**
 * @returns {{ dir: string | null, servers: Map<string, { file: string, mtimeMs: number, tools: { name: string, description: string, whenToUse: string, generated: boolean }[] }>, problems: string[] }}
 */
export function readCatalog(config, cwd) {
  const servers = new Map();
  const problems = [];
  let dir;
  try {
    dir = resolveCatalogPath(config, cwd);
  } catch (err) {
    return { dir: null, servers, problems: [err.message] };
  }
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort().slice(0, MAX_FILES);
  } catch {
    return { dir, servers, problems };
  }
  for (const name of names) {
    const server = name.slice(0, -3);
    const file = path.join(dir, name);
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!validServerName(server) || !info || info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // A file is the catalog of the server it names inside, and of no other.
    if (!isCatalogFile(text) || catalogServer(text) !== server) continue;
    servers.set(server, { file, mtimeMs: info.mtimeMs, tools: parseTools(text) });
  }
  return { dir, servers, problems };
}

/** The newest change among the files that define the MCP servers of this project (the repository's and the user's own). */
export function definitionMtime({ cwd, homedir = os.homedir() }) {
  let newest = 0;
  for (const file of [path.join(cwd, ".mcp.json"), path.join(homedir, ".claude.json")]) {
    const info = fs.statSync(file, { throwIfNoEntry: false });
    if (info?.isFile()) newest = Math.max(newest, info.mtimeMs);
  }
  return newest;
}

/**
 * What `route` needs of the catalog, or null when there is none: the catalog itself, the servers `catalog build` could have
 * built (the ones a config file defines), and when those definitions last changed. A project that never built a catalog gets
 * null, so nothing about the catalog is ever said to it.
 */
export function catalogForRoute({ config, cwd, homedir = os.homedir() }) {
  const catalog = readCatalog(config, cwd);
  if (!catalog.servers.size) return null;
  const defs = readServerDefsByOrigin({ cwd, homedir }).servers;
  const known = new Set(defs.map((server) => server.name));
  // The ones the repository defines: the only ones the route asks the user to build when they lack an entry.
  const projectKnown = new Set(defs.filter((server) => server.origin === "project").map((server) => server.name));
  return { servers: catalog.servers, known, projectKnown, definitionMtime: definitionMtime({ cwd, homedir }) };
}
