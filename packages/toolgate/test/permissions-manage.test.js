// `toolgate permissions install|update|status|list|review|import|remove [--grant]`: deny and ask narrow; allow is a grant of its own.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { loadApprovals, unitKey } from "../src/assets/approval.js";
import { defaultExec } from "../src/daemon.js";
import { PERMISSION_KIND, grantHash, grantKeyOf, isBroad, isGranted, previewPermission, scanPermissions } from "../src/permissions/install.js";
import { parsePermission } from "../src/permissions/parse.js";
import { readLock } from "../src/skills/install.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-perm-${name}-`)));
  made.push(dir);
  return dir;
};
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const unit = (extra = {}) => JSON.stringify({ description: "Rules for the repo", deny: ["Read(./.env)", "Bash(rm *)"], allow: ["Bash(git status)"], ...extra });
function remoteRepo(layout = (root) => {
  put(root, "permissions/safe.json", unit());
  put(root, "permissions/readonly.json", JSON.stringify({ description: "Only narrows", deny: ["Write", "Edit"], ask: ["WebFetch"] }));
}) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  layout(root);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, spec: `file://${root}`, commitAll: (message) => (git(root, "add", "-A"), git(root, "commit", "-q", "-m", message)) };
}
function project({ answers = null, config = {} } = {}) {
  const cwd = tmp("project");
  const home = tmp("home");
  const userDir = path.join(home, ".config", "toolgate");
  const cache = tmp("cache");
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
      loadConfigFn: () => config,
      daemon: { status: async () => ({ running: false }) },
      install: { allowFile: true, cache, execFn: defaultExec },
      hooks: { interactive: queue !== null, ask: async (q) => (questions.push(q), queue?.shift() ?? "") },
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const tree = () => [cwd, userDir].map((root) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((f) => !String(f).startsWith(".git")).sort().map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), "utf8") : null]) : null));
  return { cwd, userDir, exec, questions, tree, read: (file) => fs.readFileSync(path.join(cwd, file), "utf8"), has: (file) => fs.existsSync(path.join(cwd, file)) };
}
const lockOf = (p) => readLock(path.join(p.cwd, ".toolgate/permissions.lock.json"), "permissions");
const stored = (p, name) => parsePermission(path.join(p.cwd, ".toolgate/permissions", `${name}.json`));
const state = (p, name = "safe") => {
  const approvals = loadApprovals(p.userDir);
  const permission = stored(p, name);
  return {
    unit: approvals.has(unitKey({ projectDir: p.cwd, level: "project", kind: "permission", name }), lockOf(p).permissions[name].hash),
    granted: isGranted(approvals, { projectDir: p.cwd, level: "project", permission }),
  };
};

test("broad allow rules: a tool alone, an empty or match-everything specifier, a whole server", () => {
  for (const rule of ["Bash", "Bash()", "Bash(*)", "Bash(**)", "Bash(:*)", "Read", "mcp__github"]) assert.equal(isBroad(rule), true, rule);
  for (const rule of ["Bash(git status)", "Bash(npm run test:*)", "Read(./docs/**)", "mcp__github__get_issue", "WebFetch(domain:example.com)"]) assert.equal(isBroad(rule), false, rule);
});

test("the preview says deny and ask narrow, shows allow as a grant, and marks the broad ones", () => {
  const dir = tmp("file");
  put(dir, "p.json", JSON.stringify({ description: "d", deny: ["Read(./.env)"], ask: ["WebFetch"], allow: ["Bash(*)", "Bash(git status)"] }));
  const text = previewPermission(parsePermission(path.join(dir, "p.json")));
  assert.match(text, /deny \(narrows\):\n {4}Read\(\.\/\.env\)/);
  assert.match(text, /ask \(narrows\):\n {4}WebFetch/);
  assert.match(text, /allow \(a GRANT, inactive until you grant it\):\n {4}Bash\(\*\)   <- BROAD: every use of that tool or server\n {4}Bash\(git status\)\n?/);
  assert.doesNotMatch(text, /git status\)\s+<- BROAD/);
});

test("install without a terminal, with --yes or in CI: what would be applied is shown, nothing is written, exit 2", async () => {
  const remote = remoteRepo();
  for (const [answers, args, env] of [[null, [], {}], [["yes", "yes"], ["--yes", "--grant"], {}], [["yes", "yes"], ["--grant"], { CI: "true" }]]) {
    const p = project({ answers });
    const before = p.tree();
    const result = await p.exec(["permissions", "install", remote.spec, ...args], { env });
    assert.equal(result.code, 2, JSON.stringify([args, env]));
    assert.match(result.out, /allow \(a GRANT, inactive until you grant it\)/);
    assert.deepEqual(p.tree(), before);
    assert.deepEqual(p.questions, []);
  }
});

test("install in a terminal without --grant: the unit is approved and stored, its allow rules are listed as not granted", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "yes"] });
  const result = await p.exec(["permissions", "install", remote.spec]);
  assert.equal(result.code, 0);
  assert.match(result.out, /safe: 1 allow rule is not granted until you run with --grant/);
  assert.deepEqual(p.questions.length, 2, "one question per unit, none about grants");
  assert.deepEqual(state(p), { unit: true, granted: false });
  assert.match((await p.exec(["permissions", "list"])).out, /^safe\tproject\tapproved\tdeny 2, ask 0, allow 1 \(not granted\)$/m);
  assert.match((await p.exec(["permissions", "list"])).out, /^readonly\tproject\tapproved\tdeny 2, ask 1, allow 0$/m);
  assert.match((await p.exec(["permissions", "status"])).out, /not granted: the allow rules of safe \(project\)/);
  assert.equal(JSON.parse((await p.exec(["permissions", "list", "--json"])).out).find((u) => u.name === "safe").granted, false);
});

test("install --grant: a second, separate yes grants the allow rules; the first yes alone does not", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "no", "yes"] });
  const first = await p.exec(["permissions", "install", remote.spec, "safe", "--grant"]);
  assert.equal(first.code, 0);
  assert.match(first.out, /permission grant waiting for your approval/);
  assert.match(p.questions[0], /^Apply safe\? Type yes to approve this content: $/);
  assert.match(p.questions.at(-1), /^Grant these allow rules of safe\? Type yes to grant: $/, "the second yes is plainly another decision");
  assert.deepEqual(state(p), { unit: true, granted: false }, "the unit was approved, the grant was declined");

  const q = project({ answers: ["yes", "yes"] });
  await q.exec(["permissions", "install", remote.spec, "safe", "--grant"]);
  assert.deepEqual(state(q), { unit: true, granted: true });
  assert.equal(q.questions.length, 2);
  assert.doesNotMatch((await q.exec(["permissions", "status"])).out, /not granted/);
  assert.match((await q.exec(["permissions", "list"])).out, /allow 1 \(granted\)/);
});

test("review --grant grants what was approved earlier; without --grant it never asks about allow rules", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec]);
  assert.deepEqual(state(p), { unit: true, granted: false });
  const quiet = await p.exec(["permissions", "review"], { answers: ["yes"] });
  assert.match(quiet.out, /no permission waits for review/);
  assert.deepEqual(p.questions.length, 2, "nothing asked");
  const status = await p.exec(["permissions", "status", "--check"]);
  assert.equal(status.code, 0, "not granted is not pending review");

  const noTerminal = await p.exec(["permissions", "review", "--grant"], { answers: null });
  assert.equal(noTerminal.code, 2);
  assert.match(noTerminal.out, /GRANT the allow rules of safe/);
  assert.deepEqual(state(p), { unit: true, granted: false });
  assert.equal((await p.exec(["permissions", "review", "--grant"], { answers: ["Yes"] })).code, 2);
  assert.equal((await p.exec(["permissions", "review", "--grant", "--dry-run"], { answers: ["yes"] })).code, 2);
  assert.deepEqual(state(p), { unit: true, granted: false }, "--dry-run never grants");
  assert.equal((await p.exec(["permissions", "review", "--grant"], { answers: ["yes"] })).code, 0);
  assert.deepEqual(state(p), { unit: true, granted: true });
});

test("a grant is for the allow rules alone: a change in deny keeps it, a change in allow asks again", async () => {
  const remote = remoteRepo((root) => put(root, "permissions/safe.json", unit()));
  const p = project({ answers: ["yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec, "--grant"]);
  assert.deepEqual(state(p), { unit: true, granted: true });

  put(remote.root, "permissions/safe.json", unit({ deny: ["Read(./.env)", "Bash(rm *)", "Write"] }));
  remote.commitAll("another deny");
  assert.equal((await p.exec(["permissions", "update"], { answers: ["yes"] })).code, 0);
  assert.equal(stored(p, "safe").deny.length, 3);
  assert.deepEqual(state(p), { unit: true, granted: true }, "the grant is for the same allow rules");

  put(remote.root, "permissions/safe.json", unit({ deny: ["Read(./.env)", "Bash(rm *)", "Write"], allow: ["Bash(git status)", "Bash"] }));
  remote.commitAll("a broad allow");
  const shown = await p.exec(["permissions", "update"], { answers: ["yes"] });
  assert.match(shown.out, /<- BROAD/);
  assert.deepEqual(state(p), { unit: true, granted: false }, "new allow rules are not granted by an old grant");
  assert.match((await p.exec(["permissions", "status"])).out, /not granted: the allow rules of safe \(project\)/);
});

test("update: a removed deny waits, because it widens; the old copy stays until the change is approved", async () => {
  const remote = remoteRepo((root) => put(root, "permissions/safe.json", unit({ allow: [] })));
  const p = project({ answers: ["yes"] });
  await p.exec(["permissions", "install", remote.spec]);
  put(remote.root, "permissions/safe.json", unit({ deny: ["Read(./.env)"], allow: [] }));
  remote.commitAll("one deny less");
  const before = p.tree();
  const waiting = await p.exec(["permissions", "update"], { answers: null });
  assert.equal(waiting.code, 2);
  assert.match(waiting.out, /^- {5}Bash\(rm \*\)$/m, "the removed deny is shown as removed");
  assert.deepEqual(p.tree(), before);
  assert.equal((await p.exec(["permissions", "update", "--force"], { answers: ["yes"], env: { CI: "1" } })).code, 2);
  assert.deepEqual(p.tree(), before);
  assert.equal((await p.exec(["permissions", "update"], { answers: ["yes"] })).code, 0);
  assert.deepEqual(stored(p, "safe").deny, ["Read(./.env)"]);
});

test("review for a committed store: a teammate's unit waits here; remove forgets the approval and the grant", async () => {
  const remote = remoteRepo();
  const donor = project({ answers: ["yes", "yes", "yes"] });
  await donor.exec(["permissions", "install", remote.spec, "safe", "--grant"]);
  const p = project();
  fs.cpSync(path.join(donor.cwd, ".toolgate"), path.join(p.cwd, ".toolgate"), { recursive: true });
  assert.match((await p.exec(["permissions", "status"])).out, /pending review: safe \(project\)/);
  assert.deepEqual(state(p), { unit: false, granted: false }, "a granted allow of another machine is not a grant here");
  assert.equal((await p.exec(["permissions", "review"], { answers: ["yes"] })).code, 0);
  assert.equal((await p.exec(["permissions", "review", "--grant"], { answers: ["yes"] })).code, 0);
  assert.deepEqual(state(p), { unit: true, granted: true });
  assert.equal((await p.exec(["permissions", "remove", "safe"])).code, 0);
  assert.ok(!p.has(".toolgate/permissions/safe.json"));
  const approvals = loadApprovals(p.userDir);
  assert.equal(approvals.has(grantKeyOf({ projectDir: p.cwd, level: "project", name: "safe" }), grantHash({ allow: ["Bash(git status)"] })), false);
  assert.deepEqual([...Object.keys(JSON.parse(fs.readFileSync(path.join(p.userDir, "approvals.json"), "utf8")).approvals)], []);
});

test("levels: local is gitignored, the same name at two levels is an error, --user and --local together are refused", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec, "readonly", "--local"]);
  assert.ok(p.has(".toolgate/permissions.local/readonly.json") && p.has(".toolgate/permissions.local.lock.json"));
  assert.match(p.read(".gitignore"), /\.toolgate\/permissions\.local\//);
  const clash = await p.exec(["permissions", "install", remote.spec, "readonly"], { answers: ["yes"] });
  assert.match(clash.out, /skipped readonly: already exists at the local level; remove one \(a permission never hides another\)/);
  await p.exec(["permissions", "install", remote.spec, "safe", "--user"], { answers: ["yes"] });
  assert.ok(fs.existsSync(path.join(p.userDir, "permissions/safe.json")));
  fs.copyFileSync(path.join(p.cwd, ".toolgate/permissions.local/readonly.json"), path.join(p.userDir, "permissions/readonly.json"));
  const scanned = scanPermissions({ projectDir: p.cwd, userDir: p.userDir });
  assert.deepEqual(scanned.filter((u) => u.error).map((u) => `${u.name}@${u.level}`).sort(), ["readonly@local", "readonly@user"], "the two that clash");
  assert.match(scanned.find((u) => u.error).error, /permission "readonly" exists at the user and local levels/);
  assert.equal(scanned.find((u) => u.name === "safe").error, undefined, "the others are not affected");
  assert.equal((await p.exec(["permissions", "list", "--user", "--local"])).code, 1);
});

test("hostile source: links, a name that differs from its file, a bad rule, an mcp rule with parentheses, a reserved name and a changed store", async () => {
  const outside = tmp("outside");
  put(outside, "x.json", unit());
  const remote = remoteRepo((root) => {
    put(root, "permissions/ok.json", JSON.stringify({ description: "d", deny: ["Read"] }));
    put(root, "permissions/named.json", JSON.stringify({ name: "other", description: "d", deny: ["Read"] }));
    put(root, "permissions/bad.json", JSON.stringify({ description: "d", deny: ["Bash("] }));
    put(root, "permissions/mcp.json", JSON.stringify({ description: "d", deny: ["mcp__github(x)"] }));
    put(root, "permissions/toolgate.json", JSON.stringify({ description: "d", deny: ["Read"] }));
    put(root, "permissions/-rf.json", JSON.stringify({ description: "d", deny: ["Read"] }));
    fs.symlinkSync(path.join(outside, "x.json"), path.join(root, "permissions/linked.json"));
    put(root, "permissions/readme.md", "not a unit");
  });
  const p = project({ answers: ["yes"] });
  const result = await p.exec(["permissions", "install", remote.spec]);
  assert.equal(result.code, 0);
  assert.match(result.out, /new: ok/);
  assert.match(result.out, /skipped named: the name "other" must be the name of its file, "named"/);
  assert.match(result.out, /skipped bad: .*is not valid: use Tool or Tool\(specifier\)/);
  assert.match(result.out, /skipped mcp: .*an mcp__ rule is mcp__<server>/);
  assert.match(result.out, /skipped toolgate: /);
  assert.match(result.out, /skipped -rf: /);
  assert.match(result.out, /skipped linked: is a symlink or not a file/);
  assert.deepEqual(fs.readdirSync(path.join(p.cwd, ".toolgate/permissions")).filter((n) => !n.startsWith(".")), ["ok.json"]);
  put(p.cwd, ".toolgate/permissions/dir1.json", JSON.stringify({ name: "other", description: "d", deny: ["Read"] }));
  const units = scanPermissions({ projectDir: p.cwd, userDir: p.userDir });
  assert.match(units.find((u) => u.name === "dir1").error, /must be the name of its file/);
  assert.doesNotMatch(result.out + result.err, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.equal(PERMISSION_KIND.review, true);
});

test("usage", async () => {
  const p = project();
  assert.match((await p.exec(["permissions"])).err, /expected install, update, status, list, review, import or remove/);
  assert.match((await p.exec(["permissions", "install"])).err, /usage: toolgate permissions install .*\[--grant\]/);
  assert.match((await p.exec(["permissions", "list"])).out, /no permissions found/);
  assert.match((await p.exec(["--help"])).out, /toolgate permissions <install\|update\|status\|list\|review\|import\|remove> \[--grant\]/);
});

test("remove of a file unit: a link or a folder in its place is refused and nothing outside is deleted; an edited file needs --force", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec]);
  const file = path.join(p.cwd, ".toolgate/permissions/safe.json");
  fs.appendFileSync(file, " ");
  const edited = await p.exec(["permissions", "remove", "safe"]);
  assert.match(edited.out, /edited since it was installed \(use --force to delete it\)/);
  assert.ok(fs.existsSync(file));

  const outside = tmp("outside");
  put(outside, "keep.json", "{}");
  fs.rmSync(file);
  fs.symlinkSync(path.join(outside, "keep.json"), file);
  const linked = await p.exec(["permissions", "remove", "safe", "--force"]);
  assert.match(linked.out, /its file is not a plain file inside the store/);
  assert.ok(fs.existsSync(path.join(outside, "keep.json")));
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.match((await p.exec(["permissions", "remove", "safe", "--force"])).out, /its file is not a plain file inside the store/);
});

test("--grant asks about the grant only for a unit that was approved; a declined unit is not asked, and update --grant is refused: update approves the new content, review --grant asks the grant", async () => {
  const remote = remoteRepo((root) => put(root, "permissions/safe.json", unit()));
  const declined = project({ answers: ["no", "yes"] });
  const result = await declined.exec(["permissions", "install", remote.spec, "--grant"]);
  assert.equal(result.code, 2);
  assert.equal(declined.questions.length, 1, "no grant question for a unit that was declined");
  assert.ok(!declined.has(".toolgate/permissions/safe.json"));

  const p = project({ answers: ["yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec, "--grant"]);
  put(remote.root, "permissions/safe.json", unit({ allow: ["Bash(git log)"] }));
  remote.commitAll("another allow");
  const refused = await p.exec(["permissions", "update", "--grant"], { answers: ["yes", "yes"] });
  assert.equal(refused.code, 1);
  assert.equal(refused.err, "toolgate: --grant works only with install and review\n");
  assert.deepEqual(stored(p, "safe").allow, ["Bash(git status)"], "nothing was updated");
  const update = await p.exec(["permissions", "update"], { answers: ["yes"] });
  assert.equal(update.code, 0);
  assert.deepEqual(state(p), { unit: true, granted: false }, "the new allow rules are not granted by an update");
  const review = await p.exec(["permissions", "review", "--grant"], { answers: ["yes"] });
  assert.equal(review.code, 0);
  assert.deepEqual(state(p), { unit: true, granted: true });
  assert.deepEqual(stored(p, "safe").allow, ["Bash(git log)"]);
});

test("review --grant on a committed store asks the unit once and then the grant once, not the grant twice", async () => {
  const remote = remoteRepo();
  const donor = project({ answers: ["yes", "yes", "yes"] });
  await donor.exec(["permissions", "install", remote.spec, "safe", "--grant"]);
  const p = project({ answers: ["yes", "yes", "yes", "yes"] });
  fs.cpSync(path.join(donor.cwd, ".toolgate"), path.join(p.cwd, ".toolgate"), { recursive: true });
  const result = await p.exec(["permissions", "review", "--grant"]);
  assert.equal(result.code, 0);
  assert.equal(p.questions.length, 2, "the unit, then its grant");
  assert.deepEqual(state(p), { unit: true, granted: true });
});

test("the grant question of install and review marks the broad rules and has its own wording", async () => {
  const broad = JSON.stringify({ description: "wide", deny: ["Read(./.env)"], allow: ["Bash(*)", "mcp__github", "Bash(git status)"] });
  const remote = remoteRepo((root) => put(root, "permissions/wide.json", broad));
  const marked = (out) => {
    const at = out.indexOf("GRANT the allow rules of wide:");
    assert.ok(at >= 0, "the grant view is shown");
    const grant = out.slice(at);
    assert.match(grant, /GRANT the allow rules of wide:/);
    assert.match(grant, /Bash\(\*\)   <- BROAD: every use of that tool or server/);
    assert.match(grant, /mcp__github   <- BROAD/);
    assert.doesNotMatch(grant, /git status\)\s+<- BROAD/);
    assert.doesNotMatch(grant, /Read\(\.\/\.env\)/, "only the allow rules are in the grant view");
  };
  const p = project({ answers: ["yes", "yes"] });
  const install = await p.exec(["permissions", "install", remote.spec, "--grant"]);
  marked(install.out);
  assert.match(p.questions[1], /^Grant these allow rules of wide\? Type yes to grant: $/);

  put(remote.root, "permissions/wide.json", JSON.stringify({ description: "wide", deny: ["Read(./.env)"], allow: ["Bash(*)", "mcp__github", "Bash(git status)", "Edit"] }));
  remote.commitAll("one more allow");
  await p.exec(["permissions", "update"], { answers: ["yes"] });
  const update = await p.exec(["permissions", "review", "--grant"], { answers: ["yes"] });
  marked(update.out);
  assert.match(update.out, /Edit   <- BROAD/);

  const q = project({ answers: ["yes", "no"] });
  await q.exec(["permissions", "install", remote.spec, "--grant"]);
  const review = await q.exec(["permissions", "review", "--grant"], { answers: ["no"] });
  marked(review.out);
  assert.match(q.questions.at(-1), /^Grant these allow rules of wide\? Type yes to grant: $/);
});


test("isBroad: a whole tool or server in every spelling, and nothing that names something", () => {
  for (const broad of ["Bash", "Bash()", "Bash(*)", "Bash(**)", "Bash(:*)", "Bash( * )", "Bash(  )", "Read(**)", "Read( ** )", "mcp__srv", "mcp__srv__", "mcp__srv__*", "mcp__my-srv__*"]) assert.equal(isBroad(broad), true, broad);
  for (const narrow of ["Bash(git status)", "Bash(git *)", "Read(./docs/**)", "mcp__srv__tool", "mcp__srv__tool*", "mcp__srv__*x", "Bash( * x)"]) assert.equal(isBroad(narrow), false, narrow);
  const shown = previewPermission({ name: "n", description: "d", deny: [], ask: [], allow: ["Bash( * )", "mcp__srv__*", "Read(./a)"] });
  assert.match(shown, /Bash\( \* \)   <- BROAD/);
  assert.match(shown, /mcp__srv__\*   <- BROAD/);
  assert.doesNotMatch(shown, /Read\(\.\/a\)\s+<- BROAD/);
});
test("a name used at two levels is reported for those units only: status, list and review go on with the others", async () => {
  const remote = remoteRepo();
  const p = project({ answers: ["yes", "yes", "yes"] });
  await p.exec(["permissions", "install", remote.spec, "readonly", "--local"]);
  await p.exec(["permissions", "install", remote.spec, "safe", "--user"], { answers: ["yes"] });
  fs.copyFileSync(path.join(p.cwd, ".toolgate/permissions.local/readonly.json"), path.join(p.userDir, "permissions/readonly.json"));
  const listed = await p.exec(["permissions", "list"]);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^readonly\tuser\tunreadable: permission "readonly" exists at the user and local levels/m, "the clash is named on each unit that has the name");
  assert.match(listed.out, /^readonly\tlocal\tunreadable: /m);
  assert.match(listed.out, /^safe\tuser\t/m, "the others are listed as usual");
  for (const action of ["status", "review"]) {
    const result = await p.exec(["permissions", action]);
    assert.equal(result.code, 0, `${action} does not fail for every unit because of one clash: ${result.err}`);
    assert.equal(result.err, "", action);
  }
  const doc = JSON.parse((await p.exec(["permissions", "list", "--json"])).out);
  assert.deepEqual(doc.filter((u) => u.error).map((u) => `${u.name}@${u.level}`).sort(), ["readonly@local", "readonly@user"]);
});
