// A registry with one detectable agent that cannot read a rules file, so it stays at tier 0.
export const tierZeroRegistry = {
  has: (name) => name === "codex",
  get: async () => ({
    installDiscovery: () => null,
    capability: Object.freeze({
      defersToolSchemas: false,
      rules: Object.freeze({ kind: "none" }),
      launchGating: "none",
      exclusiveMcpConfig: false,
      resume: Object.freeze({ supported: false }),
      dynamicTools: false,
      passthrough: "args",
    }),
  }),
};
