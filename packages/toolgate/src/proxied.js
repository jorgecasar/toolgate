// Whether an MCP server entry runs through toolgate-proxy: it names the upstream in its env, or its command is the proxy.
// The entry comes from a file of the repository, so any field may be of any type: what is not text is not looked at.
// A server that is run by a command, and so can be put behind a stdio proxy (an http server cannot).
export const isCommandServer = (def) => def !== null && typeof def === "object" && typeof def.command === "string";

// Whether a wrapped entry names its server, which the proxy needs to find its entry in a session file: without `TOOLGATE_SERVER` the proxy
// stays the static one however the session is set up.
export const namesItsServer = (def, name) => def?.env !== null && typeof def?.env === "object" && def.env.TOOLGATE_SERVER === name;

export function isProxied(def) {
  if (def === null || typeof def !== "object") return false;
  const command = typeof def.command === "string" ? def.command : "";
  const args = Array.isArray(def.args) ? def.args : [];
  return Boolean(def.env?.TOOLGATE_UPSTREAM_CMD) || /toolgate-proxy/.test(`${command} ${args.join(" ")}`);
}
