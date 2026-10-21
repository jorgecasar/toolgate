import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as opencode from "../../src/adapters/opencode.js";
import * as generic from "../../src/adapters/generic.js";

const state = { extras: [], toolExtras: {}, pendingRestart: false };
const config = { baseline: ["docs"], keywords: {}, toolBaselines: { docs: ["a", "b"] } };

function spawnRecorder(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
}

test("opencode launch writes a temp config and points OPENCODE_CONFIG at it", async () => {
  const writes = {};
  const calls = [];
  const result = await opencode.launch({
    prompt: "hi",
    config,
    state,
    spawnFn: spawnRecorder(calls),
    writeFileFn: (file, text) => (writes[file] = text),
    tmpDir: "/tmp",
    pid: 1,
    now: 2,
  });
  assert.equal(calls[0].cmd, "opencode");
  assert.deepEqual(calls[0].args, ["--prompt", "hi"]);
  assert.equal(calls[0].opts.env.OPENCODE_CONFIG, result.resolvedConfigPath);
  assert.deepEqual(Object.keys(JSON.parse(writes[result.resolvedConfigPath]).mcp), ["docs"]);
  assert.equal(opencode.supportsResume, false);
});

test("opencode readServers reads the mcp key and tolerates a missing file", () => {
  assert.deepEqual(opencode.readServers("x", { readFileFn: () => '{"mcp":{"a":{},"b":{}}}' }), ["a", "b"]);
  assert.deepEqual(opencode.readServers("x", { readFileFn: () => { throw new Error("ENOENT"); } }), []);
});

test("generic builds json and toml from its spec", () => {
  const toolEnv = { TOOLGATE_DOCS_TOOLS: "a,b" };
  const json = generic.buildConfig({ format: "json", serversKey: "servers" }, ["docs"], toolEnv);
  assert.deepEqual(JSON.parse(json), { servers: { docs: { env: { TOOLGATE_DOCS_TOOLS: "a,b" } } } });
  const toml = generic.buildConfig({ format: "toml" }, ["docs"], toolEnv);
  assert.match(toml, /\[mcp_servers\.docs\]/);
  assert.match(toml, /TOOLGATE_DOCS_TOOLS = "a,b"/);
  assert.deepEqual(generic.parseServers({ format: "toml" }, toml), ["docs"]);
});

test("generic quotes and escapes TOML keys and values", () => {
  const toml = generic.buildConfig({ format: "toml" }, ['we"ird.name'], { TOOLGATE_WE_IRD_NAME_TOOLS: 'a"b' });
  assert.match(toml, /^\[mcp_servers\."we\\"ird\.name"\]/);
  assert.deepEqual(generic.parseServers({ format: "toml" }, toml), ['we"ird.name']);
});

test("generic rejects an invalid spec and launches a valid one", async () => {
  assert.throws(() => generic.createGenericAdapter({ bin: "x" }), /configFile is required.*format/);
  const calls = [];
  const writes = {};
  const adapter = generic.createGenericAdapter({ bin: "myagent", configFile: "cfg/mcp.json", format: "json", homeEnv: "MYAGENT_HOME" });
  const result = await adapter.launch({
    config,
    state,
    spawnFn: spawnRecorder(calls),
    writeFileFn: (file, text) => (writes[file] = text),
    mkdirFn: () => {},
    tmpDir: "/tmp",
    pid: 1,
    now: 2,
  });
  assert.equal(calls[0].cmd, "myagent");
  assert.equal(calls[0].opts.env.MYAGENT_HOME, "/tmp/toolgate-generic-1-2");
  assert.equal(result.resolvedConfigPath, "/tmp/toolgate-generic-1-2/cfg/mcp.json");
  assert.ok(writes[result.resolvedConfigPath]);
});
