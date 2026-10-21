import { test } from "node:test";
import assert from "node:assert/strict";
import { adapterProblems, createRegistry, validateAdapter } from "../../src/adapters/index.js";

const valid = () => ({
  capability: Object.freeze({
    defersToolSchemas: false,
    rules: Object.freeze({ kind: "none" }),
    launchGating: "none",
    exclusiveMcpConfig: false,
    resume: Object.freeze({ supported: false }),
    dynamicTools: false,
    passthrough: "args",
  }),
  supportsResume: false,
  readServers: () => [],
  applyServers: () => ({}),
  installDiscovery: () => null,
  buildToolEnv: () => ({}),
  launch: async () => ({ code: 0 }),
});

const withCapability = (patch) => ({ ...valid(), capability: Object.freeze({ ...valid().capability, ...patch }) });

test("a valid adapter has no problems", () => {
  assert.deepEqual(adapterProblems(valid()), []);
});

test("rejections name the adapter and the field", () => {
  const cases = [
    [{ ...valid(), launch: undefined }, /missing function export "launch"/],
    [{ ...valid(), supportsResume: "yes" }, /supportsResume.*boolean/],
    [{ ...valid(), capability: { ...valid().capability } }, /must be frozen/],
    [withCapability({ extra: true }), /unknown capability "extra"/],
    [withCapability({ launchGating: "magic" }), /launchGating must be one of/],
    [withCapability({ rules: Object.freeze({ kind: "projectFile" }) }), /requires a rules.path/],
    [withCapability({ resume: Object.freeze({ supported: true }) }), /requires a resume.arg/],
    [withCapability({ dynamicTools: "maybe" }), /dynamicTools must be/],
    [{ ...valid(), supportsResume: true }, /must match capability.resume.supported/],
  ];
  for (const [mod, pattern] of cases) {
    assert.throws(() => validateAdapter("demo", mod), (err) => /^Invalid adapter "demo"/.test(err.message) && pattern.test(err.message));
  }
});

test("a module is validated when registered; a lazy loader when first loaded", async () => {
  assert.throws(() => createRegistry({ bad: { ...valid(), launch: 1 } }), /Invalid adapter "bad"/);
  const registry = createRegistry({ lazy: () => Promise.resolve({ ...valid(), launch: 1 }) });
  await assert.rejects(() => registry.get("lazy"), /Invalid adapter "lazy"/);
});

test("unknown and duplicate names fail readably", async () => {
  const registry = createRegistry({ one: valid() });
  await assert.rejects(() => registry.get("two"), /Unknown adapter "two". Available: one/);
  assert.throws(() => registry.register("one", valid()), /already registered/);
});

test("the default registry lists every built-in adapter", async () => {
  const { defaultRegistry } = await import("../../src/adapters/index.js");
  assert.deepEqual(defaultRegistry.names(), ["claude-code", "codex", "antigravity", "karajan", "opencode"]);
});
