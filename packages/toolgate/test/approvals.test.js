// Approvals and the gate of the kinds that need review: nothing is applied without an approval of its exact content.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APPROVALS_FILE, canAsk, loadApprovals, reviewWaiting, unitKey } from "../src/assets/approval.js";
import { COMMAND_KIND } from "../src/commands/install.js";
import { installAssets } from "../src/skills/install.js";
import { formatUpdate, updateAssets, updateExitCode } from "../src/skills/update.js";
import { git as hermeticGit } from "./support/git.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-appr-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const cmd = (description, body = "Do it.") => `---\ndescription: ${description}\n---\n${body}\n`;
function remote(files) {
  const root = tmp("remote");
  git(root, "init", "-q", "-b", "main");
  for (const [file, text] of Object.entries(files)) put(root, file, text);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return { root, spec: `file://${root}`, commit: (message) => (git(root, "add", "-A"), git(root, "commit", "-q", "-m", message)) };
}
// A kind that needs review: the command kind with the flag the hooks and permissions kinds will carry.
const REVIEW = { ...COMMAND_KIND, review: true };
function setup(files = { "commands/guard.md": cmd("Guards"), "commands/other.md": cmd("Other") }) {
  const project = tmp("project");
  const user = tmp("user");
  const cache = tmp("cache");
  const source = remote(files);
  const base = { projectDir: project, userDir: user, cache, allowFile: true };
  return { project, user, source, base, install: (kind, extra = {}) => installAssets(kind, { ...base, spec: source.spec, ...extra }), update: (kind, extra = {}) => updateAssets(kind, { ...base, ...extra }) };
}
// Every file under a folder with its content: to prove that nothing moved.
const snapshot = (...roots) => roots.map((root) => (fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).sort().map((f) => [f, fs.statSync(path.join(root, f)).isFile() ? fs.readFileSync(path.join(root, f), "utf8") : null]) : null));
const keyOf = (t, name) => unitKey({ projectDir: t.project, level: "project", kind: "command", name });

test("the store: a missing file approves nothing, one that is not valid or is a link approves nothing and says so, a bad entry is dropped", () => {
  const user = tmp("user");
  const fresh = loadApprovals(user);
  assert.deepEqual([fresh.problem, fresh.has("k", "a".repeat(64))], [null, false]);
  const good = "a".repeat(64);
  put(user, APPROVALS_FILE, JSON.stringify({ version: 1, approvals: { good: { hash: good }, short: { hash: "abc" }, number: { hash: 5 }, plain: "x", null: null } }));
  const loaded = loadApprovals(user);
  assert.deepEqual([loaded.has("good", good), loaded.has("short", "abc"), loaded.has("number", 5), loaded.has("plain", "x")], [true, false, false, false]);
  put(user, APPROVALS_FILE, '{"approvals":{"__proto__":{"hash":"' + good + '"},"x":{"hash":"' + good + '"}}}');
  const proto = loadApprovals(user);
  assert.equal(proto.has("x", good), true);
  assert.equal({}.hash, undefined);
  put(user, APPROVALS_FILE, "{ nope");
  assert.match(loadApprovals(user).problem, /not valid JSON, so it approves nothing/);
  put(user, APPROVALS_FILE, "[]");
  assert.equal(loadApprovals(user).has("x", good), false);
  const other = tmp("user");
  fs.symlinkSync(path.join(user, APPROVALS_FILE), path.join(other, APPROVALS_FILE));
  const linked = loadApprovals(other);
  assert.match(linked.problem, /is a link, not a file or too big, so it approves nothing/);
  assert.equal(linked.has("x", good), false);
  linked.approve("y", good);
  assert.throws(() => linked.save(), /is a link or not a file; approvals were not saved/);
});

test("the store: approve, revoke and save atomically, private to the user, and only when something changed", () => {
  const user = tmp("user");
  const hash = "b".repeat(64);
  const a = loadApprovals(path.join(user, "nested"));
  a.save();
  assert.equal(fs.existsSync(path.join(user, "nested")), false, "nothing changed: nothing written");
  a.approve("k", hash);
  a.save();
  const file = path.join(user, "nested", APPROVALS_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1, approvals: { k: { hash } } });
  assert.deepEqual(fs.readdirSync(path.join(user, "nested")), [APPROVALS_FILE], "no temporary file is left");
  const b = loadApprovals(path.join(user, "nested"));
  assert.equal(b.has("k", hash), true);
  assert.equal(b.has("k", "c".repeat(64)), false, "another content is not approved");
  b.revoke("k");
  b.revoke("never-there");
  b.save();
  assert.equal(loadApprovals(path.join(user, "nested")).has("k", hash), false);
});

test("the key is the real project, the level, the kind and the name: an approval for one never counts for another", () => {
  const project = tmp("project");
  const link = path.join(tmp("links"), "p");
  fs.symlinkSync(project, link);
  const base = { projectDir: project, level: "project", kind: "hook", name: "guard" };
  assert.equal(unitKey(base), unitKey({ ...base, projectDir: link }), "a link to the project is the same project");
  for (const change of [{ level: "user" }, { kind: "permission" }, { name: "other" }, { projectDir: tmp("project") }]) assert.notEqual(unitKey({ ...base, ...change }), unitKey(base), JSON.stringify(change));
  assert.notEqual(unitKey({ projectDir: "/x", level: "a|b", kind: "c", name: "d" }), unitKey({ projectDir: "/x|a", level: "b", kind: "c", name: "d" }), "no separator can be written into a part");
  assert.notEqual(unitKey({ ...base, kind: "a", name: "b-c" }), unitKey({ ...base, kind: "a-b", name: "c" }), "a dash in the kind or the name cannot move a part");
  assert.notEqual(unitKey({ ...base, kind: "a", name: "b\nc" }), unitKey({ ...base, kind: "a\nb", name: "c" }), "nor a line break");
  assert.notEqual(unitKey({ ...base, kind: "a:b", name: "c" }), unitKey({ ...base, kind: "a", name: "b:c" }));
  assert.notEqual(unitKey({ ...base, name: 'a","b' }), unitKey({ ...base, kind: 'hook","a', name: "b" }), "the parts cannot be run together");
});

test("install: a kind that needs review waits for an approval of its exact content; with none, store, lock and approvals are untouched", () => {
  const t = setup();
  const before = snapshot(path.join(t.project, ".toolgate"), t.user);
  const result = t.install(REVIEW);
  assert.deepEqual([result.installed, result.updated, result.unchanged], [[], [], []]);
  assert.deepEqual(result.waiting.map((w) => w.name).sort(), ["guard", "other"]);
  assert.match(result.waiting[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshot(path.join(t.project, ".toolgate"), t.user), before, "nothing was written");
  const empty = loadApprovals(t.user);
  assert.equal(t.install(REVIEW, { approvals: empty }).waiting.length, 2, "an empty store approves nothing");
  assert.deepEqual(snapshot(path.join(t.project, ".toolgate"), t.user), before);
  // A kind that does not need review is not gated, as before.
  assert.equal(t.install(COMMAND_KIND).installed.length, 2);
});

test("install: an approval of the hash applies the unit and the next run finds it unchanged; --force never skips the gate", () => {
  const t = setup();
  const forced = t.install(REVIEW, { force: true });
  assert.equal(forced.waiting.length, 2, "--force is not an approval");
  const approvals = loadApprovals(t.user);
  const guard = forced.waiting.find((w) => w.name === "guard");
  approvals.approve(guard.key, guard.hash);
  approvals.save();
  const first = t.install(REVIEW, { approvals });
  assert.deepEqual([first.installed, first.waiting.map((w) => w.name)], [["guard"], ["other"]]);
  assert.ok(fs.existsSync(path.join(t.project, ".toolgate/commands/guard.md")));
  assert.ok(!fs.existsSync(path.join(t.project, ".toolgate/commands/other.md")));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(t.project, ".toolgate/commands.lock.json"), "utf8")).commands), ["guard"]);
  const again = t.install(REVIEW, { approvals: loadApprovals(t.user) });
  assert.deepEqual([again.unchanged, again.installed], [["guard"], []], "the approval persists across runs");
});

test("install: an approval is for one project, one level and one name", () => {
  const t = setup();
  const w = t.install(REVIEW).waiting.find((x) => x.name === "guard");
  const approvals = loadApprovals(t.user);
  approvals.approve(unitKey({ projectDir: tmp("elsewhere"), level: "project", kind: "command", name: "guard" }), w.hash);
  approvals.approve(unitKey({ projectDir: t.project, level: "user", kind: "command", name: "guard" }), w.hash);
  approvals.approve(unitKey({ projectDir: t.project, level: "project", kind: "command", name: "other-name" }), w.hash);
  assert.equal(t.install(REVIEW, { approvals }).installed.length, 0);
});

test("update: new content waits for an approval of its hash, the old approval does not carry over, and nothing changes meanwhile", () => {
  const t = setup({ "commands/guard.md": cmd("Guards", "v1") });
  const approvals = loadApprovals(t.user);
  const w = t.install(REVIEW).waiting[0];
  approvals.approve(w.key, w.hash);
  assert.deepEqual(t.install(REVIEW, { approvals }).installed, ["guard"]);

  put(t.source.root, "commands/guard.md", cmd("Guards", "v2 does something else"));
  t.source.commit("v2");
  const before = snapshot(path.join(t.project, ".toolgate"), t.user);
  const dry = t.update(REVIEW, { approvals, dryRun: true });
  assert.deepEqual(dry.sources[0].waiting.map((x) => x.name), ["guard"]);
  const result = t.update(REVIEW, { approvals, force: true });
  assert.deepEqual([result.sources[0].updated, result.sources[0].waiting.map((x) => x.name)], [[], ["guard"]], "--force is not an approval either");
  assert.deepEqual(snapshot(path.join(t.project, ".toolgate"), t.user), before);
  assert.equal(updateExitCode(result), 2);
  assert.match(formatUpdate(result, { dryRun: false }), /waiting for review: guard; nothing was changed for them/);

  const next = result.sources[0].waiting[0];
  approvals.approve(next.key, next.hash);
  const applied = t.update(REVIEW, { approvals });
  assert.deepEqual(applied.sources[0].updated, ["guard"]);
  assert.equal(updateExitCode(applied), 0);
  assert.match(fs.readFileSync(path.join(t.project, ".toolgate/commands/guard.md"), "utf8"), /v2 does something else/);
  assert.deepEqual(t.update(REVIEW, { approvals }).sources[0].unchanged, ["guard"], "same hash: nothing is asked again");
});

test("update --prune: removing a unit of a kind that needs review waits, because a removed deny widens; other kinds prune as before", () => {
  const t = setup({ "commands/guard.md": cmd("Guards"), "commands/gone.md": cmd("Gone") });
  const approvals = loadApprovals(t.user);
  for (const w of t.install(REVIEW).waiting) approvals.approve(w.key, w.hash);
  assert.equal(t.install(REVIEW, { approvals }).installed.length, 2);
  fs.rmSync(path.join(t.source.root, "commands/gone.md"));
  t.source.commit("remove");
  const result = t.update(REVIEW, { approvals, prune: true, force: true });
  assert.deepEqual(result.sources[0].waiting.map((x) => [x.name, x.reason]), [["gone", "removed upstream"]]);
  assert.deepEqual(result.sources[0].pruned, []);
  assert.ok(fs.existsSync(path.join(t.project, ".toolgate/commands/gone.md")));
  assert.match(formatUpdate(result, {}), /waiting for review: gone \(removed upstream\)/);

  const plain = setup({ "commands/guard.md": cmd("Guards"), "commands/gone.md": cmd("Gone") });
  plain.install(COMMAND_KIND);
  fs.rmSync(path.join(plain.source.root, "commands/gone.md"));
  plain.source.commit("remove");
  assert.deepEqual(plain.update(COMMAND_KIND, { prune: true }).sources[0].pruned, ["gone"]);
});

test("update: a conflict still wins over waiting in the exit code, and an unchanged unit is not asked about", () => {
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], sources: [{ conflicts: ["a"], skipped: [], waiting: [{ name: "b" }] }] }), 1);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], sources: [{ conflicts: [], skipped: [], waiting: [{ name: "b" }] }] }), 2);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], sources: [{ conflicts: [], skipped: [], waiting: [] }] }), 0);
});

test("reviewWaiting: nothing but the exact word yes approves: no spaces, no line ending, no other case or word", async () => {
  const hash = "e".repeat(64);
  for (const answer of ["yes ", " yes", "yes\n", "yes\r\n", "\tyes\t", "YES", "Yes", "yes please", "y", "ye", "sí", "", null, undefined, 1, true]) {
    const approvals = loadApprovals(tmp("user"));
    const result = await reviewWaiting({ waiting: [{ name: "a", hash, key: "k" }], approvals, show: () => "x", print: () => {}, allowed: true, ask: async () => answer });
    assert.deepEqual(result, { approved: [], left: ["a"] }, JSON.stringify(answer));
    assert.equal(approvals.has("k", hash), false, JSON.stringify(answer));
  }
  const approvals = loadApprovals(tmp("user"));
  assert.deepEqual((await reviewWaiting({ waiting: [{ name: "a", hash, key: "k" }], approvals, show: () => "x", print: () => {}, allowed: true, ask: async () => "yes" })).approved, ["a"]);
});

test("canAsk: only a terminal, without --yes and outside CI", () => {
  assert.equal(canAsk({ interactive: true, env: {} }), true);
  assert.equal(canAsk({ interactive: true, yes: true, env: {} }), false);
  assert.equal(canAsk({ interactive: true, env: { CI: "true" } }), false);
  assert.equal(canAsk({ interactive: false, env: {} }), false);
  assert.equal(canAsk({ env: {} }), false);
});

test("reviewWaiting: the content is shown, only an exact `yes` approves, and without a terminal nothing is approved or recorded", async () => {
  const hash = "d".repeat(64);
  const items = [{ name: "a", hash, key: "ka" }, { name: "b", hash, key: "kb" }, { name: "c", hash, key: "kc" }, { name: "d", hash, key: "kd" }];
  const approvals = loadApprovals(tmp("user"));
  const printed = [];
  const answers = ["yes", "Yes", "y", null];
  const asked = [];
  const result = await reviewWaiting({ waiting: items, approvals, show: (i) => `content of ${i.name}`, print: (t) => printed.push(t), allowed: true, ask: async (q) => (asked.push(q), answers.shift()) });
  assert.deepEqual(result, { approved: ["a"], left: ["b", "c", "d"] });
  assert.deepEqual([approvals.has("ka", hash), approvals.has("kb", hash), approvals.has("kd", hash)], [true, false, false]);
  assert.deepEqual(printed.map((p) => p.trim()), ["content of a", "content of b", "content of c", "content of d"]);
  assert.match(asked[0], /Type yes to approve this content/);

  const quiet = loadApprovals(tmp("user"));
  const none = await reviewWaiting({ waiting: items, approvals: quiet, show: (i) => i.name, print: () => {}, allowed: false, ask: async () => "yes" });
  assert.deepEqual(none, { approved: [], left: ["a", "b", "c", "d"] });
  assert.equal(quiet.has("ka", hash), false);
  const noAsk = await reviewWaiting({ waiting: items, approvals: quiet, show: (i) => i.name, print: () => {}, allowed: true });
  assert.deepEqual(noAsk.approved, []);
  quiet.save();
  assert.equal(fs.existsSync(quiet.file), false, "nothing approved: nothing written");
});

test("update: an edited unit whose upstream did not change is kept, and a conflict is a conflict: neither is turned into a waiting review", () => {
  const t = setup({ "commands/guard.md": cmd("Guards", "v1"), "commands/other.md": cmd("Other", "v1") });
  const approvals = loadApprovals(t.user);
  for (const w of t.install(REVIEW).waiting) approvals.approve(w.key, w.hash);
  t.install(REVIEW, { approvals });
  fs.appendFileSync(path.join(t.project, ".toolgate/commands/guard.md"), "\nmy edit\n");
  fs.appendFileSync(path.join(t.project, ".toolgate/commands/other.md"), "\nmy edit\n");
  put(t.source.root, "commands/other.md", cmd("Other", "v2"));
  t.source.commit("other changed");
  const report = t.update(REVIEW, { approvals }).sources[0];
  assert.deepEqual([report.kept, report.conflicts, report.waiting], [["guard"], ["other"], []]);
});

test("update, when the copy already is what upstream has but the lock is behind (a run died after replacing it): without an approval the lock does not move either", () => {
  const t = setup({ "commands/guard.md": cmd("Guards", "v1") });
  const approvals = loadApprovals(t.user);
  const first = t.install(REVIEW).waiting[0];
  approvals.approve(first.key, first.hash);
  t.install(REVIEW, { approvals });
  put(t.source.root, "commands/guard.md", cmd("Guards", "v2"));
  t.source.commit("v2");
  // The copy a dead run would have left: v2 in the store, the lock still at v1.
  const donor = setup({ "commands/guard.md": cmd("Guards", "v2") });
  const w = donor.install(REVIEW).waiting[0];
  const donorApprovals = loadApprovals(donor.user);
  donorApprovals.approve(w.key, w.hash);
  donor.install(REVIEW, { approvals: donorApprovals });
  fs.copyFileSync(path.join(donor.project, ".toolgate/commands/guard.md"), path.join(t.project, ".toolgate/commands/guard.md"));
  const lockFile = path.join(t.project, ".toolgate/commands.lock.json");
  const lockBefore = fs.readFileSync(lockFile, "utf8");
  const result = t.update(REVIEW, { approvals });
  assert.deepEqual([result.sources[0].updated, result.sources[0].waiting.map((x) => x.name)], [[], ["guard"]]);
  assert.equal(fs.readFileSync(lockFile, "utf8"), lockBefore, "the lock stays where it was");
  assert.equal(updateExitCode(result), 2);
});
