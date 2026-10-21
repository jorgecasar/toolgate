import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRegistry } from "../../src/adapters/index.js";
import { validateAdapter } from "../../src/adapters/index.js";
import { createGenericAdapter } from "../../src/adapters/generic.js";
import { computeTier } from "../../src/capability.js";

// Every registered adapter must pass these; a new adapter is covered by registering it.
for (const name of defaultRegistry.names()) {
  test(`contract: ${name} honors the adapter contract`, async () => {
    const adapter = await defaultRegistry.get(name); // validates exports and capability
    assert.ok(Object.isFrozen(adapter.capability));
    assert.equal(adapter.supportsResume, adapter.capability.resume.supported === true);
    assert.ok(computeTier(adapter.capability) >= 0);
  });

  test(`contract: ${name} buildToolEnv is pure and only covers active servers`, async () => {
    const adapter = await defaultRegistry.get(name);
    const config = { toolBaselines: { repo: ["a", "b"], docs: ["c"] } };
    const state = { extras: [], toolExtras: {}, pendingRestart: false };
    const first = adapter.buildToolEnv(config, state, new Set(["repo"]));
    assert.deepEqual(adapter.buildToolEnv(config, state, new Set(["repo"])), first);
    assert.deepEqual(first, { TOOLGATE_REPO_TOOLS: "a,b" });
    assert.deepEqual(state, { extras: [], toolExtras: {}, pendingRestart: false });
  });

  test(`contract: ${name} installDiscovery follows its rules capability`, async () => {
    const adapter = await defaultRegistry.get(name);
    const result = adapter.installDiscovery({ cwd: "/project", template: "rule" });
    if (adapter.capability.rules.kind === "projectFile") {
      assert.deepEqual(result, { file: `/project/${adapter.capability.rules.path}`, content: "rule" });
    } else {
      assert.equal(result, null);
    }
  });
}

test("contract: claude-code applyServers pins the active set", async () => {
  const claude = await defaultRegistry.get("claude-code");
  assert.deepEqual(claude.applyServers(new Set(["repo"]), ["repo", "docs"]), {
    enabledMcpjsonServers: ["repo"],
    disabledMcpjsonServers: ["docs"],
    enableAllProjectMcpServers: false,
  });
});

// `generic` needs a spec, so it cannot sit in the default registry; its bound adapter must still pass.
test("contract: a generic adapter honors the adapter contract", () => {
  const adapter = createGenericAdapter({ bin: "myagent", configFile: "cfg/mcp.json", format: "json" });
  validateAdapter("generic", adapter);
});
