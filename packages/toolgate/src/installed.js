import fs from "node:fs";

// Servers an agent has configured, merged across the config files it reads. Each source is
// `{ path, parse }` where `parse(raw)` returns the server names or throws on malformed content.
// Files that cannot be read are skipped (a scope may simply not exist). Returns `null` when no
// source could be read, or when one is malformed: nothing reliable can be concluded about what
// is installed, so callers must not report anything missing.
export function collectInstalled(sources, { readFileFn = fs.readFileSync } = {}) {
  const servers = new Set();
  const read = [];
  for (const { path: source, parse } of sources) {
    let raw;
    try {
      raw = readFileFn(source, "utf8");
    } catch {
      continue;
    }
    try {
      for (const server of parse(raw)) servers.add(server);
    } catch {
      return null;
    }
    read.push(source);
  }
  if (read.length === 0) return null;
  return { servers: [...servers], source: read.join(", ") };
}
