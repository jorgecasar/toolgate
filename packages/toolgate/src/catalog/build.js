// `toolgate catalog build`: start the servers that may be started, list their tools, write one file for each.
import os from "node:os";
import path from "node:path";
import { loadApprovals } from "../assets/approval.js";
import { userConfigDir } from "../config.js";
import { collectServers } from "./collect.js";
import { introspect } from "./introspect.js";
import { resolveCatalogPath } from "./path.js";
import { readManual, renderCatalog } from "./render.js";
import { oneLine } from "./sanitize.js";
import { readServerDefsByOrigin } from "./serverDefs.js";
import { approveServers } from "./trust.js";
import { readExisting, writeCatalog } from "./write.js";

/**
 * @returns {Promise<{ error?: string, rows: { server: string, origin?: string, status: "built" | "would-build" | "skipped" | "failed", reason?: string, auth?: string, toolCount?: number, file?: string }[], code: number }>}
 */
export async function buildCatalog({ cwd, homedir = os.homedir(), env = process.env, config = {}, serverFilter, dryRun = false, yes = false, force = false, interactive = false, ask, print = () => {}, introspectFn = introspect, timeoutMs }) {
  let dir;
  try {
    dir = resolveCatalogPath(config, cwd);
  } catch (err) {
    return { error: err.message, rows: [], code: 1 };
  }
  const { servers: all, invalid, malformed } = readServerDefsByOrigin({ cwd, homedir });
  // The servers of a `.mcp.json` that cannot be read are not "not configured": the build stops and says why.
  if (malformed !== null) return { error: `.mcp.json is not valid JSON (${malformed})`, rows: [], code: 1 };
  if (serverFilter !== undefined && !all.some((s) => s.name === serverFilter)) return { error: `no MCP server named ${JSON.stringify(oneLine(serverFilter, 64))} is configured`, rows: [], code: 1 };
  // Two names that differ only in case would share one file on a file system that ignores case: the first keeps it.
  const firstOf = new Map();
  const distinct = [];
  const clashes = [];
  for (const server of all) {
    const key = server.name.toLowerCase();
    if (firstOf.has(key)) clashes.push({ ...server, other: firstOf.get(key) });
    else {
      firstOf.set(key, server.name);
      distinct.push(server);
    }
  }
  const wanted = (s) => serverFilter === undefined || s.name === serverFilter;
  const servers = distinct.filter(wanted);
  const rows = [
    ...(serverFilter === undefined ? invalid.map((i) => ({ server: i.name, status: "skipped", reason: i.reason })) : []),
    ...clashes.filter(wanted).map((c) => ({ server: c.name, origin: c.origin, status: "skipped", reason: `differs only in case from ${oneLine(c.other, 64)}, which has the file` })),
  ];
  const approvals = loadApprovals(userConfigDir({ cwd, env, homedir }));
  const { allowed } = await approveServers({ servers, projectDir: cwd, approvals, ask, interactive, yes, force, dryRun, env, print });
  const results = await collectServers({ servers, allowed, introspectFn, options: { cwd, timeoutMs } });
  for (const result of results) {
    const row = { server: result.name, origin: result.origin };
    if (result.status === "skipped") rows.push({ ...row, status: "skipped", reason: result.reason, ...(result.auth ? { auth: result.auth } : {}) });
    else if (result.status !== "ok") rows.push({ ...row, status: "failed", reason: result.reason });
    else {
      try {
        const manual = readManual(readExisting(dir, result.name) ?? "");
        const text = renderCatalog({ server: result.name, transport: result.transport, auth: result.auth, instructionsChars: result.instructionsChars, tools: result.tools }, manual);
        const file = dryRun ? path.join(dir, `${result.name}.md`) : writeCatalog({ cwd, config, server: result.name, text });
        rows.push({ ...row, status: dryRun ? "would-build" : "built", toolCount: result.tools.length, ...(result.droppedTools ? { droppedTools: result.droppedTools } : {}), file: path.relative(cwd, file) });
      } catch (err) {
        rows.push({ ...row, status: "failed", reason: oneLine(err.message, 300) });
      }
    }
  }
  const unapproved = rows.some((r) => r.reason === "not approved on this machine");
  const code = rows.some((r) => r.status === "failed") ? 1 : unapproved ? 2 : 0;
  return { rows, code };
}
