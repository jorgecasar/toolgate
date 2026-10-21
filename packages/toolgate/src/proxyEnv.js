// The environment names toolgate-proxy no longer reads, and the ones that replaced them (#19). `toolgate update` renames them in the MCP
// files, `toolgate doctor` reports the entries that still use them, and the proxy itself refuses to start on an old name alone.
export const RENAMED_PROXY_ENV = Object.freeze([
  ["UPSTREAM_CMD", "TOOLGATE_UPSTREAM_CMD"],
  ["UPSTREAM_ARGS", "TOOLGATE_UPSTREAM_ARGS"],
  ["ALLOWED_TOOLS", "TOOLGATE_ALLOWED_TOOLS"],
]);

/** The most of an MCP file that `toolgate update` reads and rewrites; a bigger one is not migrated, and `doctor` says so instead of "run toolgate update". */
export const MAX_MCP_BYTES = 16 * 1024 * 1024;

/** The `[old, new]` pairs an entry's `env` still has: the old name is set and the new one is not (both set: the new one wins, nothing to do). */
export function oldProxyNames(env) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) return [];
  return RENAMED_PROXY_ENV.filter(([oldName, newName]) => Object.hasOwn(env, oldName) && !Object.hasOwn(env, newName));
}

/** The text every place uses for one pair, the proxy's own. */
export const renamedText = ([oldName, newName]) => `toolgate-proxy: ${oldName} was renamed to ${newName}; run toolgate update`;
