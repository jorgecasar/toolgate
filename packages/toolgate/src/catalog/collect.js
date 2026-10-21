// Introspects the servers that may be started, one at a time. A server that may not be started is never started.
import { introspect } from "./introspect.js";
import { normalizeDef } from "./serverDefs.js";

/**
 * @param {{ name: string, origin: string, def: object }[]} servers
 * @param {Set<string>} allowed The names `approveServers` allowed
 * @returns {Promise<{ name: string, origin: string, status: "ok" | "skipped" | "error", reason?: string, auth?: string, tools?: object[], instructionsChars?: number, transport?: string }[]>}
 */
export async function collectServers({ servers, allowed, introspectFn = introspect, options = {} }) {
  const results = [];
  for (const { name, origin, def } of servers) {
    if (!allowed.has(name)) {
      results.push({ name, origin, status: "skipped", reason: "not approved on this machine" });
      continue;
    }
    const normalized = normalizeDef(def);
    if (normalized.error) {
      results.push({ name, origin, status: "error", reason: normalized.error });
      continue;
    }
    results.push({ name, origin, transport: normalized.transport, ...(await introspectFn(normalized, options)) });
  }
  return results;
}
