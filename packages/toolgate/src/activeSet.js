// Computes the active server/tool set: baseline is always on, self-match and keyword
// patterns react to the current prompt, and extras/toolExtras only apply once a prior
// `escalate` has set pendingRestart — otherwise the escalation just waits for next launch.

export function computeActiveServers(config, state, prompt = "") {
  const { baseline = [], keywords = {}, toolBaselines = {} } = config;
  const { extras = [], pendingRestart = false } = state;

  const active = new Set(baseline);

  const knownServers = new Set([...baseline, ...Object.keys(keywords), ...Object.keys(toolBaselines)]);
  for (const name of knownServers) {
    if (matchesWholeWord(prompt, name)) active.add(name);
  }

  for (const [server, patterns] of Object.entries(keywords)) {
    if (patterns.some((pattern) => new RegExp(pattern, "i").test(prompt))) {
      active.add(server);
    }
  }

  if (pendingRestart) {
    for (const server of extras) active.add(server);
  }

  return active;
}

export function computeActiveTools(config, state, server) {
  const { toolBaselines = {} } = config;
  const { toolExtras = {}, pendingRestart = false } = state;

  const baseline = toolBaselines[server] ?? [];
  const extras = pendingRestart ? (toolExtras[server] ?? []) : [];

  return new Set([...baseline, ...extras]);
}

export function matchesWholeWord(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}
