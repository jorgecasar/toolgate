// `toolgate doctor` for hooks and permissions: lock drift, units waiting for a review, and agents that cannot apply them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";

const noneRegistry = (kind) => ({
  has: tierZeroRegistry.has,
  get: async () => {
    const adapter = await tierZeroRegistry.get();
    return { ...adapter, capability: Object.freeze({ ...adapter.capability, hooks: Object.freeze({ kind }), permissions: Object.freeze({ kind }) }) };
  },
});

async function doctor({ files = {}, registry, setup } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-doctor-rev-"));
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-home-rev-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  await setup?.({ cwd, homedir });
  const out = [];
  await run(["doctor", "--json"], {
    cwd,
    env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "" },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    doctor: { homedir, registry, execFn: () => "1.0.0", daemon: { status: async () => ({ running: false }) } },
  });
  const report = JSON.parse(out.join(""));
  return { report, cwd, homedir, of: (prefix) => report.checks.filter((c) => c.id.startsWith(prefix)) };
}
const PERMISSION = JSON.stringify({ name: "rules", description: "d", deny: ["Read(./.env)"], allow: ["Bash(git status)"] });
const HOOK = JSON.stringify({ name: "fmt", description: "d", handlers: [{ type: "command", event: "Stop", command: "prettier", args: ["--write"] }] });

test("no hook and no permission installed: doctor says nothing about them", async () => {
  const { of } = await doctor();
  assert.deepEqual(of("hooks."), []);
  assert.deepEqual(of("permissions."), []);
});

test("a permission and a hook that nobody approved on this machine warn, with the review command", async () => {
  const { of } = await doctor({ files: { ".toolgate/permissions/rules.json": PERMISSION, ".toolgate/hooks/fmt/HOOK.json": HOOK } });
  assert.ok(of("permissions.pending").some((c) => c.level === "warn" && /1 permission not applied: rules/.test(c.message) && /toolgate permissions review/.test(c.hint)));
  assert.ok(of("hooks.pending").some((c) => c.level === "warn" && /1 hook not applied: fmt/.test(c.message) && c.hint === "toolgate hooks review"));
});

test("an approved unit is ok", async () => {
  const { of } = await doctor({
    files: { ".toolgate/permissions/rules.json": JSON.stringify({ name: "rules", description: "d", deny: ["Read(./.env)"] }) },
    setup: async ({ cwd, homedir }) => {
      const out = [];
      const env = { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), HOME: homedir };
      await run(["permissions", "review"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, loadConfigFn: () => ({}), hooks: { interactive: true, ask: async () => "yes" } });
    },
  });
  assert.ok(of("permissions.pending").some((c) => c.level === "ok"), JSON.stringify(of("permissions")));
});

test("a unit installed for an agent that applies no hooks or permissions is said: an error for its deny rules when the agent applies none, a warning when it is not verified", async () => {
  for (const kind of ["none", "unknown"]) {
    const { of } = await doctor({ files: { ".toolgate/permissions/rules.json": PERMISSION, ".toolgate/hooks/fmt/HOOK.json": HOOK }, registry: noneRegistry(kind) });
    assert.ok(of("permissions.adapter").some((c) => c.level === (kind === "none" ? "error" : "warn") && /cannot apply them \(permissions: .*\); its 1 deny rule is NOT applied there/.test(c.message)), kind);
    assert.ok(of("hooks.adapter").some((c) => c.level === "warn" && /1 hook installed but codex cannot apply them \(hooks: /.test(c.message)), kind);
  }
});

test("a lock entry whose unit is gone is an error, and an edited unit a warning", async () => {
  const { of } = await doctor({
    files: { ".toolgate/permissions/rules.json": PERMISSION, ".toolgate/permissions.lock.json": JSON.stringify({ version: 1, sources: {}, permissions: { gone: { source: "local:x", path: "x", hash: "sha256:00" }, rules: { source: "local:x", path: "x", hash: "sha256:11" } } }) },
  });
  const drift = of("permissions.lockDrift");
  assert.ok(drift.some((c) => c.level === "error" && /gone is in the project lock but missing/.test(c.message)), JSON.stringify(drift));
  assert.ok(drift.some((c) => c.level === "warn" && /rules \(project\) was edited by hand/.test(c.message)), JSON.stringify(drift));
});

const opencodeLike = {
  has: tierZeroRegistry.has,
  get: async () => {
    const adapter = await tierZeroRegistry.get();
    return { ...adapter, capability: Object.freeze({ ...adapter.capability, hooks: Object.freeze({ kind: "none" }), permissions: Object.freeze({ kind: "configEnv" }) }) };
  },
};

test("for an opencode-like agent, a deny or ask rule it cannot express is a warning (the deny says NOT APPLIED), an allow is not", async () => {
  const unit = JSON.stringify({ name: "rules", description: "d", deny: ["mcp__bad"], ask: ["mcp__ask"], allow: ["mcp__good"] });
  const grant = async ({ cwd, homedir }) => {
    const env = { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), HOME: homedir };
    await run(["permissions", "review", "--grant"], { cwd, env, stdout: { write: () => {} }, stderr: { write: () => {} }, loadConfigFn: () => ({}), hooks: { interactive: true, ask: async () => "yes" } });
  };
  const { of } = await doctor({ files: { ".toolgate/permissions/rules.json": unit }, registry: opencodeLike, setup: grant });
  const unmapped = of("permissions.unmapped");
  assert.ok(unmapped.some((c) => c.level === "warn" && /codex cannot express mcp__bad \[deny\]: NOT APPLIED there: /.test(c.message)), JSON.stringify(unmapped));
  assert.ok(unmapped.some((c) => c.level === "warn" && /codex cannot express mcp__ask \[ask\]: /.test(c.message) && !/NOT APPLIED/.test(c.message)));
  assert.ok(!unmapped.some((c) => /mcp__good/.test(c.message)), "an allow rule is not reported");
  const none = await doctor({ files: { ".toolgate/permissions/rules.json": unit }, registry: noneRegistry("none") });
  assert.deepEqual(none.of("permissions.unmapped"), [], "only a configEnv agent maps rules");
});

test("doctor does not say every installed unit is approved while one is invalid: only the valid ones are counted", async () => {
  const DENY_ONLY = JSON.stringify({ name: "rules", description: "d", deny: ["Read(./.env)"] });
  const { of } = await doctor({ files: { ".toolgate/permissions/rules.json": DENY_ONLY, ".toolgate/permissions/broken.json": "{ nope" } });
  const pending = of("permissions.pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].level, "ok");
  assert.match(pending[0].message, /^every valid installed permission \(1\) is approved on this machine; 1 invalid permission is not applied$/);
  assert.ok(of("permissions.levels").some((c) => /permission broken \(project\)/.test(c.message)), "the invalid one is named");
  const clean = await doctor({ files: { ".toolgate/permissions/rules.json": DENY_ONLY } });
  assert.equal(clean.of("permissions.pending")[0].message, "every installed permission is approved on this machine");
});
