// `toolgate hooks import` and `toolgate permissions import`: the hooks and permissions Claude Code already has.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { loadApprovals, unitKey } from "../src/assets/approval.js";
import { claudeSettingsFile, readSettings } from "../src/assets/nativeSettings.js";
import { scanHooks } from "../src/hooks/install.js";
import { scanPermissions, isGranted } from "../src/permissions/install.js";
import { readLock } from "../src/skills/install.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-nat-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const exec1 = (command, args = [], extra = {}) => ({ type: "command", command, args, ...extra });
function project({ answers = null, settings, local, user, scripts = {} } = {}) {
  const cwd = tmp("project");
  const home = tmp("home");
  const userDir = path.join(home, ".config", "toolgate");
  if (settings) put(cwd, ".claude/settings.json", typeof settings === "string" ? settings : JSON.stringify(settings));
  if (local) put(cwd, ".claude/settings.local.json", JSON.stringify(local));
  if (user) put(home, ".claude/settings.json", JSON.stringify(user));
  for (const [file, text] of Object.entries(scripts)) put(cwd, file, text);
  const questions = [];
  const env = { HOME: home, TOOLGATE_DEFAULTS: path.join(userDir, "config.json") };
  const exec = async (args, extra = {}) => {
    const out = [];
    const err = [];
    const queue = extra.answers ?? answers;
    const code = await run(args, {
      cwd,
      env: { ...env, ...extra.env },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => ({}),
      daemon: { status: async () => ({ running: false }) },
      hooks: { interactive: queue !== null, ask: async (q) => (questions.push(q), queue?.shift() ?? "") },
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const tree = () => [cwd, userDir].map((root) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((f) => !String(f).startsWith(".git") && !String(f).startsWith(".claude")).sort().map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), "utf8") : null]) : null));
  return { cwd, home, userDir, exec, questions, tree, read: (file) => fs.readFileSync(path.join(cwd, file), "utf8"), has: (file) => fs.existsSync(path.join(cwd, file)) };
}
const HOOKS = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [exec1("scripts/guard.sh", ["--strict"], { timeout: 20, statusMessage: "x" }), exec1("node", ["-v"])] }],
    Stop: [{ hooks: [exec1("prettier", ["--write"])] }],
  },
};

test("the settings file of each level: project, local and user", () => {
  const args = { projectDir: "/p", homeDir: "/h" };
  assert.deepEqual(claudeSettingsFile({ level: "project", ...args }), { file: "/p/.claude/settings.json", label: ".claude/settings.json", base: "/p" });
  assert.deepEqual(claudeSettingsFile({ level: "local", ...args }), { file: "/p/.claude/settings.local.json", label: ".claude/settings.local.json", base: "/p" });
  assert.deepEqual(claudeSettingsFile({ level: "user", ...args }), { file: "/h/.claude/settings.json", label: "~/.claude/settings.json", base: "/h" });
});

test("readSettings: a plain JSON object inside its folder; a missing one, a link, a folder, a big one, a broken one and an outside one say why", () => {
  const dir = tmp("settings");
  const at = (file) => ({ file: path.join(dir, file), label: file, base: dir });
  put(dir, "ok.json", '{ "a": 1 }');
  assert.deepEqual(readSettings(at("ok.json")), { data: { a: 1 }, note: null });
  assert.match(readSettings(at("missing.json")).note, /does not exist, so there is nothing to import/);
  put(dir, "list.json", "[]");
  assert.match(readSettings(at("list.json")).note, /does not hold a JSON object/);
  put(dir, "bad.json", "{ nope");
  assert.match(readSettings(at("bad.json")).note, /is not valid JSON/);
  put(dir, "big.json", `{"x":"${"a".repeat(1024 * 1024)}"}`);
  assert.match(readSettings(at("big.json")).note, /larger than 1048576 bytes/);
  fs.mkdirSync(path.join(dir, "folder.json"));
  assert.match(readSettings(at("folder.json")).note, /is a symlink or not a file/);
  const outside = tmp("outside");
  put(outside, "x.json", "{}");
  fs.symlinkSync(path.join(outside, "x.json"), path.join(dir, "link.json"));
  assert.match(readSettings(at("link.json")).note, /is a symlink or not a file/);
  assert.deepEqual(readSettings(at("ok.json")).data, { a: 1 });
  assert.equal(readSettings({ file: path.join(outside, "x.json"), label: "x", base: dir }).data, null, "a file outside its base is not read");
  put(dir, "proto.json", '{"__proto__": {"polluted": 1}, "b": 2}');
  assert.equal(readSettings(at("proto.json")).data.b, 2);
  assert.equal({}.polluted, undefined);
});

test("hooks import: exec-form commands become one unit; shell form, other handler types and bad scripts are skipped with the reason; the script is copied into the unit", async () => {
  const settings = { hooks: { ...HOOKS.hooks, PostToolUse: [{ hooks: [{ type: "command", command: "echo hi | sh" }, { type: "prompt", prompt: "p" }, exec1("$CLAUDE_PROJECT_DIR/x.sh", []), exec1("scripts/missing.sh", []), exec1("../outside.sh", []), exec1("scripts/guard.sh", ["${HOME}"])] }], Whatever: [{ hooks: [exec1("node", [])] }] } };
  put(tmp("outside"), "x", "x");
  const p = project({ answers: ["yes"], settings, scripts: { "scripts/guard.sh": "#!/bin/sh\nexit 0\n" } });
  put(path.dirname(p.cwd), "outside.sh", "evil");
  const result = await p.exec(["hooks", "import"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /toolgate: imported 1 hook \(3 handlers\), unchanged 0 from \.claude\/settings\.json at the project level/);
  assert.match(result.out, /skipped PostToolUse#\d+: shell form: rewrite it as command and args/);
  assert.match(result.out, /skipped PostToolUse#\d+: only a command is imported \(this one is "prompt"\)/);
  assert.match(result.out, /skipped PostToolUse#\d+: .*(placeholder|variable|substitution)/);
  assert.match(result.out, /skipped PostToolUse#\d+: the script scripts\/missing\.sh is not a plain file/);
  assert.match(result.out, /skipped PostToolUse#\d+: the script \.\.\/outside\.sh is not inside /);
  assert.match(result.out, /skipped Whatever#\d+: .*is not a hook event Claude Code documents/);
  assert.match(result.out, /the original in \.claude\/settings\.json is not changed and keeps running: until you remove those hooks from it, they run twice/);
  assert.match(result.out, /PreToolUse \[Bash\] runs: "scripts\/guard\.sh" "--strict"/, "the unit is shown before it is approved");
  const unit = scanHooks({ projectDir: p.cwd, userDir: p.userDir })[0];
  assert.deepEqual([unit.name, unit.handlers.map((h) => [h.event, h.command])], ["native-claude", [["PreToolUse", "scripts/guard.sh"], ["PreToolUse", "node"], ["Stop", "prettier"]]]);
  assert.deepEqual(unit.handlers[0], { event: "PreToolUse", matcher: "Bash", command: "scripts/guard.sh", args: ["--strict"], timeout: 20 }, "statusMessage is not kept");
  assert.equal(p.read(".toolgate/hooks/native-claude/scripts/guard.sh"), "#!/bin/sh\nexit 0\n");
  assert.equal(fs.statSync(path.join(p.cwd, ".toolgate/hooks/native-claude/scripts/guard.sh")).mode & 0o111, 0);
  assert.equal(readLock(path.join(p.cwd, ".toolgate/hooks.lock.json"), "hooks").hooks["native-claude"].source, "local:.claude/settings.json");
  assert.deepEqual(JSON.parse(p.read(".claude/settings.json")), settings, "the original is never changed");
});

test("nothing is written without a yes: no terminal, --yes, CI, --dry-run and --force leave the store, the lock and the approvals as they were (exit 2)", async () => {
  const p = project({ settings: HOOKS, scripts: { "scripts/guard.sh": "x" } });
  const before = p.tree();
  for (const [answers, args, env] of [[null, [], {}], [["yes"], ["--yes"], {}], [["yes"], [], { CI: "1" }], [["yes"], ["--dry-run"], {}], [["yes"], ["--force"], { CI: "1" }]]) {
    const result = await p.exec(["hooks", "import", ...args], { answers, env });
    assert.ok([0, 2].includes(result.code), JSON.stringify(args));
    assert.deepEqual(p.tree(), before, JSON.stringify([args, env]));
  }
  assert.equal((await p.exec(["hooks", "import"], { answers: null })).code, 2);
  assert.deepEqual(p.questions, [], "nothing was asked");
});

test("a second import finds it unchanged, a changed settings file waits for a new approval, and an edit of the stored copy is not overwritten without --force", async () => {
  const p = project({ answers: ["yes"], settings: HOOKS, scripts: { "scripts/guard.sh": "v1" } });
  await p.exec(["hooks", "import"]);
  assert.match((await p.exec(["hooks", "import"], { answers: null })).out, /imported 0 hooks \(3 handlers\), unchanged 1/);
  put(p.cwd, "scripts/guard.sh", "v2 changed");
  const waiting = await p.exec(["hooks", "import"], { answers: null });
  assert.equal(waiting.code, 2);
  assert.match(p.read(".toolgate/hooks/native-claude/scripts/guard.sh"), /^v1$/);
  assert.equal((await p.exec(["hooks", "import"], { answers: ["yes"] })).code, 0);
  assert.equal(p.read(".toolgate/hooks/native-claude/scripts/guard.sh"), "v2 changed");
  fs.appendFileSync(path.join(p.cwd, ".toolgate/hooks/native-claude/scripts/guard.sh"), "\nmine");
  assert.match((await p.exec(["hooks", "import"], { answers: ["yes"] })).out, /skipped native-claude: edited since it was imported \(use --force to overwrite it\)/);
});

test("the levels read their own file: --local reads settings.local.json and gitignores its store; --user reads the home one and stores in the config folder", async () => {
  const p = project({ answers: ["yes", "yes"], settings: { hooks: { Stop: [{ hooks: [exec1("project-tool", [])] }] } }, local: { hooks: { Stop: [{ hooks: [exec1("local-tool", [])] }] } }, user: { hooks: { Stop: [{ hooks: [exec1("user-tool", [])] }] } } });
  await p.exec(["hooks", "import", "--local"]);
  assert.match(p.read(".toolgate/hooks.local/native-claude-local/HOOK.json"), /local-tool/);
  assert.match(p.read(".gitignore"), /\.toolgate\/hooks\.local\//);
  await p.exec(["hooks", "import", "--user"]);
  assert.match(fs.readFileSync(path.join(p.userDir, "hooks/native-claude-user/HOOK.json"), "utf8"), /user-tool/);
  assert.ok(!p.has(".toolgate/hooks/native-claude"), "the project level was not touched");
  assert.ok(!p.has(".toolgate/hooks"), "the other levels are still empty");
});

test("a settings file that is missing, a link, broken or has no hooks says so and writes nothing", async () => {
  const none = project();
  assert.match((await none.exec(["hooks", "import"])).out, /\.claude\/settings\.json does not exist, so there is nothing to import/);
  assert.equal((await none.exec(["hooks", "import"])).code, 0);
  const broken = project({ settings: "{ nope" });
  const bad = await broken.exec(["hooks", "import"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /is not valid JSON/);
  const linked = project();
  const outside = tmp("outside");
  put(outside, "s.json", JSON.stringify(HOOKS));
  fs.mkdirSync(path.join(linked.cwd, ".claude"));
  fs.symlinkSync(path.join(outside, "s.json"), path.join(linked.cwd, ".claude/settings.json"));
  const through = await linked.exec(["hooks", "import"]);
  assert.equal(through.code, 1);
  assert.match(through.out, /is a symlink or not a file, and is not read/);
  assert.ok(!linked.has(".toolgate/hooks"));
  const empty = project({ settings: { model: "x" } });
  assert.match((await empty.exec(["hooks", "import"])).out, /\.claude\/settings\.json has no hooks/);
  const shell = project({ settings: { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } } });
  const only = await shell.exec(["hooks", "import"]);
  assert.equal(only.code, 1);
  assert.match(only.out, /no handler could be imported/);
  assert.ok(!shell.has(".toolgate/hooks"));
});

test("a script that is a link, or in a folder that leads outside, is not copied", async () => {
  const outside = tmp("outside");
  put(outside, "evil.sh", "evil");
  const p = project({ settings: { hooks: { Stop: [{ hooks: [exec1("scripts/linked.sh", []), exec1("escape/evil.sh", [])] }] } } });
  fs.mkdirSync(path.join(p.cwd, "scripts"));
  fs.symlinkSync(path.join(outside, "evil.sh"), path.join(p.cwd, "scripts/linked.sh"));
  fs.symlinkSync(outside, path.join(p.cwd, "escape"));
  const result = await p.exec(["hooks", "import"], { answers: ["yes"] });
  assert.equal(result.code, 1);
  assert.match(result.out, /skipped Stop#1: the script scripts\/linked\.sh is not a plain file/);
  assert.match(result.out, /skipped Stop#2: the script escape\/evil\.sh is not inside /);
  assert.ok(!p.has(".toolgate/hooks"));
});

test("a script reached through a symlinked folder, even one that stays inside the project, is not copied; the same script by its real path is", async () => {
  const p = project({ settings: { hooks: { Stop: [{ hooks: [exec1("linkdir/ok.sh", []), exec1("real/ok.sh", [])] }] } } });
  fs.mkdirSync(path.join(p.cwd, "real"));
  fs.writeFileSync(path.join(p.cwd, "real/ok.sh"), "#!/bin/sh\nexit 0\n");
  fs.symlinkSync(path.join(p.cwd, "real"), path.join(p.cwd, "linkdir"));
  const result = await p.exec(["hooks", "import"], { answers: ["yes"] });
  assert.match(result.out, /skipped Stop#1: the script linkdir\/ok\.sh is reached through a symlinked folder, and symlinks are not followed/);
  assert.doesNotMatch(result.out, /skipped Stop#2/, "the real path is imported");
  assert.ok(p.has(".toolgate/hooks"));
});
const PERMS = { permissions: { deny: ["Read(./.env)", "Bash(rm *)"], ask: ["WebFetch"], allow: ["Bash(git status)"], defaultMode: "bypassPermissions", additionalDirectories: ["/"], extra: 1 } };

test("permissions import: the rules become one unit; invalid rules are skipped; defaultMode and additionalDirectories are not kept and said", async () => {
  const settings = { permissions: { ...PERMS.permissions, deny: [...PERMS.permissions.deny, "Bash(", "mcp__github(x)", 5], allow: [...PERMS.permissions.allow] } };
  const p = project({ answers: ["yes"], settings });
  const result = await p.exec(["permissions", "import"]);
  assert.equal(result.code, 0);
  assert.match(result.out, /toolgate: imported 1 permission \(4 rules\), unchanged 0 from \.claude\/settings\.json at the project level/);
  assert.match(result.out, /skipped deny: Bash\(: .*is not valid/);
  assert.match(result.out, /skipped deny: mcp__github\(x\): .*an mcp__ rule/);
  assert.match(result.out, /skipped deny: 5: .*plain text/);
  assert.match(result.out, /not kept \(they can widen what the agent may do\): additionalDirectories, defaultMode, extra/);
  assert.match(result.out, /the original in \.claude\/settings\.json is not changed and keeps applying/);
  assert.match(result.out, /allow \(a GRANT, inactive until you grant it\):\n {4}Bash\(git status\)/);
  const unit = scanPermissions({ projectDir: p.cwd, userDir: p.userDir })[0];
  assert.deepEqual([unit.name, unit.deny, unit.ask, unit.allow], ["native-claude", ["Read(./.env)", "Bash(rm *)"], ["WebFetch"], ["Bash(git status)"]]);
  assert.doesNotMatch(p.read(".toolgate/permissions/native-claude.json"), /defaultMode|additionalDirectories|bypass/);
  assert.equal(readLock(path.join(p.cwd, ".toolgate/permissions.lock.json"), "permissions").permissions["native-claude"].dropped.join(), "additionalDirectories,defaultMode,extra");
  assert.ok(!(isGranted(loadApprovals(p.userDir), { projectDir: p.cwd, level: "project", permission: unit })), "the allow rules are not granted by an import");
});

test("permissions import --grant is refused: a grant is never given from an import, nothing is asked and nothing is written", async () => {
  const p = project({ answers: ["yes", "yes"], settings: PERMS });
  const before = p.tree();
  const result = await p.exec(["permissions", "import", "--grant"]);
  assert.equal(result.code, 1);
  assert.equal(result.err, "toolgate: --grant works only with install and review\n");
  assert.equal(p.questions.length, 0, "no question");
  assert.deepEqual(p.tree(), before);
  const plain = await p.exec(["permissions", "import"], { answers: ["yes"] });
  assert.equal(plain.code, 0);
  const unit = scanPermissions({ projectDir: p.cwd, userDir: p.userDir })[0];
  assert.ok(!isGranted(loadApprovals(p.userDir), { projectDir: p.cwd, level: "project", permission: unit }), "the allow rules stay ungranted");
});

test("permissions import: no permissions, only invalid rules, a list that is not a list", async () => {
  const empty = project({ settings: { hooks: {} } });
  assert.match((await empty.exec(["permissions", "import"])).out, /has no permissions/);
  const invalid = project({ settings: { permissions: { deny: ["Bash("], allow: "Read" } } });
  const result = await invalid.exec(["permissions", "import"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /skipped allow: "allow" is not a list of rules/);
  assert.match(result.out, /no rule could be imported/);
  assert.ok(!invalid.has(".toolgate/permissions"));
  assert.match((await project({ settings: { permissions: [] } }).exec(["permissions", "import"])).out, /"permissions" is not an object/);
});

test("the unit is approved for the exact content: imported and approved, then an edit of the Claude settings asks again, and the approval is for this project only", async () => {
  const p = project({ answers: ["yes"], settings: { permissions: { deny: ["Write"] } } });
  await p.exec(["permissions", "import"]);
  const unit = scanPermissions({ projectDir: p.cwd, userDir: p.userDir })[0];
  assert.ok(loadApprovals(p.userDir).has(unitKey({ projectDir: p.cwd, level: "project", kind: "permission", name: "native-claude" }), unit.hash));
  put(p.cwd, ".claude/settings.json", JSON.stringify({ permissions: { deny: ["Write", "Edit"] } }));
  assert.equal((await p.exec(["permissions", "import"], { answers: null })).code, 2);
  assert.deepEqual(scanPermissions({ projectDir: p.cwd, userDir: p.userDir })[0].deny, ["Write"]);
});

test("a link to a file inside the folder is not read or copied either, and a unit takes at most 16 handlers", async () => {
  const dir = tmp("links");
  put(dir, "real.json", "{}");
  fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "inside.json"));
  assert.match(readSettings({ file: path.join(dir, "inside.json"), label: "inside.json", base: dir }).note, /is a symlink or not a file/);
  const many = Array.from({ length: 18 }, (_, i) => exec1(`tool${i}`, []));
  const p = project({ answers: ["yes"], settings: { hooks: { Stop: [{ hooks: [...many, exec1("scripts/link.sh", [])] }] } }, scripts: { "scripts/real.sh": "x" } });
  fs.symlinkSync(path.join(p.cwd, "scripts/real.sh"), path.join(p.cwd, "scripts/link.sh"));
  const result = await p.exec(["hooks", "import"]);
  assert.match(result.out, /imported 1 hook \(16 handlers\)/);
  assert.match(result.out, /skipped Stop#17: over the limit of 16 handlers in one unit/);
  assert.match(result.out, /skipped Stop#19: the script scripts\/link\.sh is not a plain file/);
});

test("--force replaces an edited copy, --dry-run with the approval already given reports and writes nothing, and the lock records the settings file as the source", async () => {
  const p = project({ answers: ["yes"], settings: HOOKS, scripts: { "scripts/guard.sh": "v1" } });
  await p.exec(["hooks", "import"]);
  const lock = JSON.parse(p.read(".toolgate/hooks.lock.json"));
  assert.deepEqual(lock.sources["local:.claude/settings.json"], { path: ".claude/settings.json", local: true });
  put(p.cwd, "scripts/guard.sh", "v2");
  await p.exec(["hooks", "import"], { answers: ["yes"] });
  const stored = path.join(p.cwd, ".toolgate/hooks/native-claude/scripts/guard.sh");
  fs.appendFileSync(stored, "\nmine");
  const before = p.tree();
  const dry = await p.exec(["hooks", "import", "--dry-run"], { answers: null });
  assert.deepEqual(p.tree(), before);
  assert.equal(dry.code, 1);
  assert.match(dry.out, /skipped native-claude: edited since it was imported/);
  const forced = await p.exec(["hooks", "import", "--force"], { answers: ["yes"] });
  assert.equal(forced.code, 0);
  assert.equal(fs.readFileSync(stored, "utf8"), "v2");
});

test("--dry-run of an approved unit that is not in the store yet says it would import and writes nothing", async () => {
  const p = project({ answers: ["yes"], settings: { permissions: { deny: ["Write"] } } });
  await p.exec(["permissions", "import"]);
  fs.rmSync(path.join(p.cwd, ".toolgate"), { recursive: true });
  const dry = await p.exec(["permissions", "import", "--dry-run"], { answers: null });
  assert.equal(dry.code, 0);
  assert.match(dry.out, /would import 1 permission/);
  assert.ok(!p.has(".toolgate"));
});

test("scripts with one base name do not overwrite each other: each handler runs its own", async () => {
  const p = project({ answers: ["yes"], settings: { hooks: { PreToolUse: [{ hooks: [exec1("./a/x.sh", []), exec1("./e/2-x.sh", []), exec1("./b/x.sh", []), exec1("./c/x.sh", [])] }] } }, scripts: { "a/x.sh": "A", "e/2-x.sh": "E", "b/x.sh": "B", "c/x.sh": "C" } });
  assert.equal((await p.exec(["hooks", "import"])).code, 0);
  const unit = scanHooks({ projectDir: p.cwd, userDir: p.userDir })[0];
  const seen = unit.handlers.map((h) => p.read(`.toolgate/hooks/native-claude/${h.command}`));
  assert.deepEqual(seen, ["A", "E", "B", "C"]);
  assert.equal(new Set(unit.handlers.map((h) => h.command)).size, 4);
});

test("the keys of a hook that are not kept are listed per handler and recorded in the lock", async () => {
  const p = project({ answers: ["yes"], settings: { hooks: { Stop: [{ hooks: [exec1("a", [], { async: true, statusMessage: "s", once: true }), exec1("b", [], { shell: "bash" })] }] } } });
  const result = await p.exec(["hooks", "import"]);
  assert.match(result.out, /\.claude\/settings\.json: Stop#1 does not keep async, once, statusMessage/);
  assert.match(result.out, /Stop#2 does not keep shell/);
  const entry = JSON.parse(p.read(".toolgate/hooks.lock.json")).hooks["native-claude"];
  assert.deepEqual(entry.dropped, ["async", "once", "shell", "statusMessage"]);
});

test("a name that exists at another level is refused like install does, and only the exact yes writes", async () => {
  const p = project({ answers: ["yes"], settings: HOOKS, local: HOOKS, scripts: { "scripts/guard.sh": "x" } });
  put(p.cwd, ".toolgate/hooks.local/native-claude/HOOK.json", JSON.stringify({ name: "native-claude", description: "mine", handlers: [{ type: "command", event: "Stop", command: "x", args: [] }] }));
  const before = p.tree();
  const result = await p.exec(["hooks", "import"], { answers: ["yes"] });
  assert.equal(result.code, 1);
  assert.match(result.out, /skipped native-claude: already exists at the local level; remove one \(a hook never hides another\)/);
  assert.deepEqual(p.tree(), before);
  const other = project({ settings: HOOKS, scripts: { "scripts/guard.sh": "x" } });
  for (const answer of ["y", "Yes", "yes please", ""]) {
    assert.equal((await other.exec(["hooks", "import"], { answers: [answer] })).code, 2, answer);
    assert.ok(!other.has(".toolgate/hooks"), answer);
  }
});

test("an import does not grant the allow rules, and import --grant is refused", async () => {
  const p = project({ settings: { permissions: { allow: ["Bash(git status)"] } } });
  await p.exec(["permissions", "import"], { answers: ["yes"] });
  const unit = scanPermissions({ projectDir: p.cwd, userDir: p.userDir })[0];
  const granted = () => isGranted(loadApprovals(p.userDir), { projectDir: p.cwd, level: "project", permission: unit });
  assert.ok(!granted(), "an import without --grant does not grant");
  const other = project({ settings: { permissions: { allow: ["Bash(git status)"] } } });
  const refused = await other.exec(["permissions", "import", "--grant"], { answers: ["yes", "y"] });
  assert.equal(refused.code, 1, "an import never grants, so the flag is refused");
  assert.equal(other.questions.length, 0);
});
