// Starting a server runs a program. A server of the user's own configuration is already run by the user; one from the
// `.mcp.json` of a repository is started only after a typed `yes` for that exact definition, kept per machine.
import crypto from "node:crypto";
import { canAsk, reviewWaiting, unitKey } from "../assets/approval.js";
import { exact, oneLine } from "./sanitize.js";
import { normalizeDef } from "./serverDefs.js";

export const CATALOG_KIND = "catalog-server";

const sortedEntries = (map = {}) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** The hash of what runs: command, arguments, url and the environment or headers with their values, so a changed token asks again. */
export function defHash(def) {
  const canonical = def.transport === "http"
    ? { transport: "http", url: def.url, headers: sortedEntries(def.headers) }
    : { transport: "stdio", command: def.command, args: def.args, env: sortedEntries(def.env) };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export const catalogKey = (projectDir, name) => unitKey({ projectDir, level: "project", kind: CATALOG_KIND, name });

// What is shown before the question: the command and arguments exactly, and only the names of environment variables or headers.
export function showDef(name, def) {
  if (def.transport === "http") {
    const url = new URL(def.url);
    url.username = "";
    url.password = "";
    const query = url.search;
    url.search = "";
    return `toolgate: the project wants to contact the MCP server ${oneLine(name, 64)} (${defHash(def).slice(0, 12)}):\n  url: ${exact(url.href)}${query ? " (the query is hidden, " + query.length + " characters, and is part of the approval)" : ""}\n  headers: ${Object.keys(def.headers).map(exact).join(", ") || "none"}`;
  }
  return `toolgate: the project wants to start the MCP server ${oneLine(name, 64)} (${defHash(def).slice(0, 12)}):\n  runs: ${[def.command, ...def.args].map(exact).join(" ")}\n  environment variables it receives: ${Object.keys(def.env).map(exact).join(", ") || "none"}`;
}

/**
 * Decides which servers may be started. A server of the user's own configuration always may. A project server may when its
 * exact definition was approved before, or when the user types `yes` now. `--yes`, CI, no terminal, `--force` and `--dry-run`
 * never approve: the server stays in `waiting` and nothing is recorded.
 * @returns {Promise<{ allowed: Set<string>, waiting: string[] }>}
 */
export async function approveServers({ servers, projectDir, approvals, ask, interactive = false, yes = false, force = false, dryRun = false, env = process.env, print = () => {} }) {
  const allowed = new Set();
  const pending = [];
  for (const { name, origin, def: raw } of servers) {
    // The definition is always read through `normalizeDef`, as `collect` does, whatever keys it brings: what is approved is what runs.
    const def = normalizeDef(raw);
    if (def.error) continue;
    if (origin === "user") {
      allowed.add(name);
      continue;
    }
    const hash = defHash(def);
    const key = catalogKey(projectDir, name);
    if (approvals.problem === null && approvals.has(key, hash)) allowed.add(name);
    else pending.push({ name, hash, key, def, question: `Start ${oneLine(name, 64)}? Type yes to approve this exact command: ` });
  }
  if (approvals.problem) print(`toolgate: ${oneLine(approvals.problem, 300)}\n`);
  const may = approvals.problem === null && !force && !dryRun && canAsk({ yes, interactive, env });
  const { approved, left } = await reviewWaiting({ waiting: pending, approvals, show: (item) => showDef(item.name, item.def), ask, print, allowed: may });
  if (approved.length) approvals.save();
  for (const name of approved) allowed.add(name);
  return { allowed, waiting: left };
}
