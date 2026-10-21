import fs from "node:fs";

// Resolution order (see docs/DESIGN.md "Self-configured proxy"):
//   TOOLGATE_ALLOWED_TOOLS env (CSV) -> proxy config file (server + profile) -> fail-open (null).
export function resolveAllowList(env) {
  const fromEnv = parseCsvEnv(env.TOOLGATE_ALLOWED_TOOLS);
  if (fromEnv) {
    return { tools: fromEnv, source: "env" };
  }

  const fromConfig = readConfigFile(env);
  if (fromConfig) {
    return { tools: fromConfig, source: "config" };
  }

  return { tools: null, source: "fail-open" };
}

function parseCsvEnv(csv) {
  if (!csv || csv.trim() === "") return null;
  const names = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? new Set(names) : null;
}

function readConfigFile(env) {
  const configPath = env.TOOLGATE_PROXY_CONFIG;
  const server = env.TOOLGATE_SERVER;
  if (!configPath || !server) return null;

  const profile = env.TOOLGATE_PROFILE || "default";

  let raw;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return null; // missing config file -> fail-open, never breaks the server
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed config -> fail-open
  }

  const list = parsed?.servers?.[server]?.[profile];
  return Array.isArray(list) && list.length > 0 ? new Set(list) : null;
}
