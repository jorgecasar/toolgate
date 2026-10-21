// The environment names the proxy reads, and the ones it no longer reads (renamed to TOOLGATE_*).
export const RENAMED_ENV = Object.freeze([
  ["UPSTREAM_CMD", "TOOLGATE_UPSTREAM_CMD"],
  ["UPSTREAM_ARGS", "TOOLGATE_UPSTREAM_ARGS"],
  ["ALLOWED_TOOLS", "TOOLGATE_ALLOWED_TOOLS"],
]);

/** The `[old, new]` pairs where the old name is set and the new one is not. A name set to an empty text counts as set. */
export const renamedEnvNames = (env) => RENAMED_ENV.filter(([oldName, newName]) => env[oldName] !== undefined && env[newName] === undefined);
