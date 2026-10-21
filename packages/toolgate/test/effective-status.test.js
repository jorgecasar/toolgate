// `toolgate hooks|permissions status --effective`: what each adapter's next launch passes, held back and cannot express.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { launchPlan } from "../src/hooks/effective.js";
import * as claude from "../src/adapters/claude-code.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-eff-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
function project(settings) {
  const cwd = tmp("project");
  const home = tmp("home");
  put(cwd, ".claude/settings.json", JSON.stringify(settings));
  const env = { HOME: home, TOOLGATE_DEFAULTS: path.join(home, ".config", "toolgate", "config.json") };
  const exec = async (args, answers = null) => {
    const out = [];
    const err = [];
    const queue = answers;
    const code = await run(args, {
      cwd,
      env,
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => ({}),
      daemon: { status: async () => ({ running: false }) },
      hooks: { interactive: queue !== null, ask: async () => queue?.shift() ?? "" },
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const tree = () => fs.readdirSync(path.dirname(cwd) === os.tmpdir() ? cwd : cwd, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(cwd, f)).isFile() ? fs.readFileSync(path.join(cwd, f), "utf8") : null]).concat(fs.existsSync(path.join(home, ".config")) ? fs.readdirSync(path.join(home, ".config"), { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(home, ".config", f)).isFile() ? fs.readFileSync(path.join(home, ".config", f), "utf8") : null]) : []);
  return { cwd, home, exec, tree };
}
const SETTINGS = {
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["-v"] }] }] },
  permissions: { deny: ["Read(./.env)", "WebFetch(domain:evil.test)", "mcp__bad"], ask: ["Bash(rm *)"], allow: ["Bash(git status)"] },
};

test("hooks status --effective: an approved hook is passed to claude-code, and nothing to the adapters that cannot take hooks", async () => {
  const p = project(SETTINGS);
  await p.exec(["hooks", "import"], ["yes"]);
  const result = await p.exec(["hooks", "status", "--effective"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /effective for claude-code \(hooks: settingsFlag\):\n {2}passes: PreToolUse \[Bash\] node -v \(unit native-claude, project\)/);
  assert.match(result.out, /effective for opencode \(hooks: none\):\n {2}nothing is passed\n/);
  assert.match(result.out, /effective for codex \(hooks: unknown\):\n {2}nothing is passed \(not verified for this agent\)/);
});

test("a hook that is not approved, or changed since, is held back and not passed", async () => {
  const p = project(SETTINGS);
  await p.exec(["hooks", "import"], ["yes"]);
  put(p.cwd, ".toolgate/hooks/native-claude/HOOK.json", JSON.stringify({ name: "native-claude", description: "x", handlers: [{ type: "command", event: "Stop", command: "node", args: ["-e", "1"] }] }));
  const result = await p.exec(["hooks", "status", "--effective", "--agent", "claude-code", "--check"]);
  assert.equal(result.code, 2);
  assert.match(result.out, /held back: native-claude \(project\): .* -> toolgate hooks review/);
  assert.doesNotMatch(result.out, /passes:/);
  const json = JSON.parse((await p.exec(["hooks", "status", "--effective", "--agent", "claude-code", "--json"])).out);
  assert.equal(json.adapters[0].held[0].name, "native-claude");
  assert.deepEqual(json.adapters[0].passes, {});
});

test("permissions status --effective: claude-code gets deny and ask, allow only once granted; opencode reports what it cannot express", async () => {
  const p = project(SETTINGS);
  await p.exec(["permissions", "import"], ["yes"]);
  const before = await p.exec(["permissions", "status", "--effective", "--agent", "claude-code"]);
  assert.match(before.out, /deny: Read\(\.\/\.env\)/);
  assert.match(before.out, /ask: Bash\(rm \*\)/);
  assert.doesNotMatch(before.out, /allow \(granted\)/);
  await p.exec(["permissions", "review", "--grant"], ["yes"]);
  assert.match((await p.exec(["permissions", "status", "--effective", "--agent", "claude-code"])).out, /allow \(granted\): Bash\(git status\)/);
  const open = await p.exec(["permissions", "status", "--effective", "--agent", "opencode", "--check"]);
  assert.match(open.out, /effective for opencode \(permissions: configEnv\):/);
  assert.match(open.out, /OPENCODE_CONFIG_CONTENT: /);
  assert.match(open.out, /cannot express: mcp__bad \[deny\] DENY NOT APPLIED: /);
  assert.equal(open.code, 2);
});

test("status --effective writes nothing: the project and the config folder are byte-equal after it", async () => {
  const p = project(SETTINGS);
  await p.exec(["hooks", "import"], ["yes"]);
  await p.exec(["permissions", "import"], ["yes"]);
  const before = JSON.stringify(p.tree());
  for (const noun of ["hooks", "permissions"]) {
    await p.exec([noun, "status", "--effective"]);
    await p.exec([noun, "status", "--effective", "--json"]);
  }
  assert.equal(JSON.stringify(p.tree()), before);
});

test("an unknown agent is an error and control characters in the JSON are escaped", async () => {
  const p = project({ permissions: { deny: ["Read(./a\u001b[31mb)"] } });
  await p.exec(["permissions", "import"], ["yes"]);
  const bad = await p.exec(["permissions", "status", "--effective", "--agent", "nope"]);
  assert.equal(bad.code, 1);
  const json = (await p.exec(["permissions", "status", "--effective", "--json", "--agent", "claude-code"])).out;
  assert.doesNotMatch(json, /\u001b/);
  JSON.parse(json);
});

test("launchPlan: an adapter takes only the part its capability names, and nothing is written", async () => {
  const p = project(SETTINGS);
  await p.exec(["hooks", "import"], ["yes"]);
  await p.exec(["permissions", "import"], ["yes"]);
  const env = { HOME: p.home, TOOLGATE_DEFAULTS: path.join(p.home, ".config", "toolgate", "config.json") };
  const before = JSON.stringify(p.tree());
  const full = launchPlan({ adapterModule: claude, config: {}, cwd: p.cwd, env });
  assert.deepEqual(Object.keys(full.preview).sort(), ["hooks", "permissions"]);
  assert.match(full.preview.hooks.PreToolUse[0].hooks[0].command, /^node$/);
  const noHooks = launchPlan({ adapterModule: { capability: { hooks: { kind: "none" }, permissions: { kind: "settingsFlag" } } }, config: {}, cwd: p.cwd, env });
  assert.deepEqual(noHooks.effective.hooks, []);
  assert.deepEqual(Object.keys(noHooks.preview), ["permissions"]);
  const nothing = launchPlan({ adapterModule: { capability: { hooks: { kind: "unknown" }, permissions: { kind: "none" } } }, config: {}, cwd: p.cwd, env });
  assert.equal(nothing.applies, false);
  assert.equal(nothing.effective, null);
  assert.equal(JSON.stringify(p.tree()), before);
});

test("--check exits 2 when a deny rule is installed for an agent that applies no permissions, and says so", async () => {
  const p = project({ permissions: { deny: ["Read(./.env)"] } });
  await p.exec(["permissions", "import"], ["yes"]);
  const lost = await p.exec(["permissions", "status", "--effective", "--agent", "codex", "--check"]);
  assert.equal(lost.code, 2);
  assert.match(lost.out, /effective for codex \(permissions: unknown\):\n {2}cannot apply: 1 deny rule DENY NOT APPLIED/);
  assert.equal((await p.exec(["permissions", "status", "--effective", "--agent", "codex"])).code, 0, "without --check it only reports");
  assert.equal((await p.exec(["permissions", "status", "--effective", "--agent", "claude-code", "--check"])).code, 0);
  const none = project({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x", args: [] }] }] } });
  await none.exec(["hooks", "import"], ["yes"]);
  assert.equal((await none.exec(["hooks", "status", "--effective", "--check"])).code, 0, "hooks held by no agent are not a deny");
  const json = JSON.parse((await p.exec(["permissions", "status", "--effective", "--agent", "codex", "--json"])).out);
  assert.equal(json.adapters[0].lostDeny, 1);
});

test("status --effective --check exits 1 when a unit is rejected, 2 when one is only held back, and 0 otherwise", async () => {
  const p = project(SETTINGS);
  await p.exec(["permissions", "import"], ["yes"]);
  await p.exec(["permissions", "review", "--grant"], ["yes"]);
  const args = ["permissions", "status", "--effective", "--agent", "claude-code", "--check"];
  assert.equal((await p.exec(args)).code, 0);
  put(p.cwd, ".toolgate/permissions/broken.json", "{ nope");
  const rejected = await p.exec(args);
  assert.equal(rejected.code, 1);
  assert.match(rejected.out, /not applied: permission broken \(project\): /);
  assert.equal((await p.exec(args.slice(0, -1))).code, 0, "without --check the exit code is 0");
  fs.rmSync(path.join(p.cwd, ".toolgate/permissions/broken.json"));
  const held = project(SETTINGS);
  await held.exec(["hooks", "import"], ["yes"]);
  put(held.cwd, ".toolgate/hooks/native-claude/HOOK.json", JSON.stringify({ name: "native-claude", description: "x", handlers: [{ type: "command", event: "Stop", command: "node", args: ["-e", "1"] }] }));
  assert.equal((await held.exec(["hooks", "status", "--effective", "--agent", "claude-code", "--check"])).code, 2, "held back is still 2");
});
