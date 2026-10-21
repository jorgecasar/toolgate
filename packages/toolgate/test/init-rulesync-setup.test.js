import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.js";
import { findRoots } from "../src/rulesyncSetup.js";

const project = () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-rs-"));
  fs.mkdirSync(path.join(cwd, ".git"));
  return cwd;
};
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), "utf8");
const has = (cwd, file) => fs.existsSync(path.join(cwd, file));
const write = (cwd, file, text) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
};
const installing = (...bins) => (bin) => {
  if (bins.includes(bin)) return "";
  throw new Error("ENOENT");
};

async function init(cwd, { installed = [], answers = [], isTrackedFn = () => false, ...rest } = {}) {
  const out = [];
  const asked = [];
  const code = await runInit({
    cwd,
    env: { TOOLGATE_DEFAULTS: path.join(cwd, "no-user.json") },
    stdout: { write: (s) => out.push(s) },
    execFn: installing(...installed),
    daemon: { ensure: async () => ({ running: false, reason: "test" }) },
    isTrackedFn,
    interactive: answers.length > 0,
    ask: async (question) => {
      asked.push(question);
      const next = answers.find(([pattern]) => pattern.test(question));
      return next ? next[1] : "";
    },
    ...rest,
  });
  return { code, out: out.join(""), asked };
}
const targetsOf = (cwd) => JSON.parse(read(cwd, "rulesync.jsonc")).targets;

test("the targets are only the installed agents; a file the project has only says where the preselection comes from", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "agents text\n");
  write(cwd, "CLAUDE.md", "# mine\n");
  const run = await init(cwd, { installed: ["codex"], yes: true });
  assert.equal(run.code, 0);
  assert.deepEqual(targetsOf(cwd), ["codexcli"], "opencode and antigravity read AGENTS.md but are not installed");
  assert.match(run.out, /rulesync: yes \(default\)/);
  assert.match(run.out, /rulesync targets: codexcli {2}\[installed, AGENTS\.md\]\n/);
  const ignore = read(cwd, ".gitignore");
  assert.doesNotMatch(ignore, /opencode|\.agents|claude/i, "only the generated files of an installed agent");

  const claude = project();
  write(claude, "AGENTS.md", "agents text\n");
  await init(claude, { installed: ["claude"], yes: true });
  assert.deepEqual(targetsOf(claude), ["claudecode"], "installed, although its own file is absent");

  const none = project();
  write(none, "AGENTS.md", "agents text\n");
  const bare = await init(none, { installed: [], yes: true });
  assert.ok(!has(none, "rulesync.jsonc") && !has(none, ".rulesync/rules/overview.md"));
  assert.ok(has(none, ".rulesync/rules/toolgate-router.md"));
  assert.match(bare.out, /toolgate init --targets claudecode/);
  assert.equal(read(none, "AGENTS.md"), "agents text\n");
});

test("an agent file the project has is imported as the one root, and the originals are not touched", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "agents text\n");
  write(cwd, "CLAUDE.md", "claude text\n");
  const run = await init(cwd, { installed: ["claude"], yes: true });
  assert.equal(read(cwd, "AGENTS.md"), "agents text\n");
  assert.equal(read(cwd, "CLAUDE.md"), "claude text\n");
  assert.match(read(cwd, ".rulesync/rules/overview.md"), /^---\nroot: true\n[\s\S]*---\n\nagents text\n$/);
  const other = read(cwd, ".rulesync/rules/claude-md.md");
  assert.match(other, /targets: \["claudecode"\]/);
  assert.doesNotMatch(other, /root:/);
  assert.match(other, /claude text/);
  assert.deepEqual(findRoots(cwd), ["overview.md"], "exactly one root, so generate does not fail");
  assert.match(run.out, /imported AGENTS\.md as the root rule/);
  assert.match(run.out, /imported CLAUDE\.md as the rule \.rulesync\/rules\/claude-md\.md, for claudecode only/);
  assert.match(run.out, /`rulesync generate` will rewrite CLAUDE\.md \(/);
});

test("files git ignores are rulesync's own output: no rewrite warning, no 'earlier init' note and no .gitignore note for them", async () => {
  const TEMPLATE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "step0-rule.md"), "utf8");
  const setupProject = () => {
    const cwd = project();
    write(cwd, ".rulesync/rules/overview.md", "---\nroot: true\ntargets: [\"*\"]\n---\n\nmine\n");
    write(cwd, "rulesync.jsonc", JSON.stringify({ targets: ["claudecode"], features: ["rules"] }));
    write(cwd, "CLAUDE.md", "generated\n");
    write(cwd, ".claude/rules/toolgate-router.md", TEMPLATE);
    return cwd;
  };
  const noisy = await init(setupProject(), { installed: ["claude"], yes: true, isIgnoredFn: () => false });
  assert.match(noisy.out, /`rulesync generate` will rewrite CLAUDE\.md/, "not ignored: it may be yours, so it is said");
  assert.match(noisy.out, /\.claude\/rules\/toolgate-router\.md was written by an earlier `toolgate init`/);
  assert.match(noisy.out, /not added to \.gitignore, because it exists or git tracks it/);
  const quiet = await init(setupProject(), { installed: ["claude"], yes: true, isIgnoredFn: () => true });
  assert.doesNotMatch(quiet.out, /will rewrite/);
  assert.doesNotMatch(quiet.out, /written by an earlier `toolgate init`/);
  assert.doesNotMatch(quiet.out, /not added to \.gitignore/);
});
test("files with the same text give one overview, and nothing is imported twice", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "same\n");
  write(cwd, "CLAUDE.md", "same\n");
  await init(cwd, { installed: ["claude"], yes: true });
  assert.deepEqual(fs.readdirSync(path.join(cwd, ".rulesync", "rules")).sort(), ["overview.md", "toolgate-router.md"]);
});

test("an existing root rule is kept and nothing is imported, so two roots never exist", async () => {
  const cwd = project();
  write(cwd, ".rulesync/rules/mine.md", '---\nroot: true\ntargets: ["*"]\n---\nmy root\n');
  write(cwd, "AGENTS.md", "agents text\n");
  const run = await init(cwd, { yes: true });
  assert.deepEqual(findRoots(cwd), ["mine.md"]);
  assert.ok(!has(cwd, ".rulesync/rules/overview.md"));
  assert.equal(read(cwd, ".rulesync/rules/mine.md"), '---\nroot: true\ntargets: ["*"]\n---\nmy root\n');
  assert.match(run.out, /kept the root rule \.rulesync\/rules\/mine\.md \(nothing imported\)/);
});

test("with no agent file a minimal root is created and the user is told to review it", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude"], yes: true });
  assert.match(read(cwd, ".rulesync/rules/overview.md"), /^---\nroot: true\ntargets: \["\*"\]\n[\s\S]*TODO\(toolgate init\)/);
  assert.match(run.out, /review \.rulesync\/rules\/overview\.md/);
  assert.deepEqual(findRoots(cwd), ["overview.md"]);
});

test("a link is never taken for a source, and a non-root overview.md is not replaced", async () => {
  const cwd = project();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-out-")), "secret.md");
  fs.writeFileSync(outside, "outside text\n");
  fs.symlinkSync(outside, path.join(cwd, "AGENTS.md"));
  await init(cwd, { installed: ["claude"], yes: true });
  assert.doesNotMatch(read(cwd, ".rulesync/rules/overview.md"), /outside text/);

  const again = project();
  write(again, ".rulesync/rules/overview.md", "not a root\n");
  write(again, "AGENTS.md", "agents text\n");
  const run = await init(again, { yes: true });
  assert.equal(read(again, ".rulesync/rules/overview.md"), "not a root\n");
  assert.match(run.out, /overview\.md exists but is not a root rule/);
});

test('"delete": true in an existing rulesync.jsonc is warned about, and init never writes it', async () => {
  const cwd = project();
  write(cwd, "rulesync.jsonc", '{ "targets": ["claudecode"], "delete": true }\n');
  const run = await init(cwd, { installed: ["claude"], yes: true });
  assert.match(run.out, /"delete": true, so everything the agents read must live in \.rulesync\/[\s\S]*`rulesync generate` deletes, for every agent, the files/);
  assert.match(run.out, /\nNotices:\n[\s\S]*"delete": true/, "it is a notice, not a step under Next:");
  assert.doesNotMatch(run.out.split("\nNext:")[1] ?? "", /"delete": true/);
  const fresh = project();
  await init(fresh, { installed: ["claude"], yes: true });
  assert.doesNotMatch(read(fresh, "rulesync.jsonc"), /delete/);
});

test(".gitignore gets only the generated files of the chosen targets, never one that exists, is tracked or was imported", async () => {
  const cwd = project();
  write(cwd, "CLAUDE.md", "mine\n");
  await init(cwd, { installed: ["claude", "codex"], yes: true });
  const ignore = read(cwd, ".gitignore");
  assert.match(ignore, /^\.claude\/rules\/toolgate-router\.md$/m);
  assert.match(ignore, /^\/AGENTS\.md$/m, "codex generates it and the project has none");
  assert.doesNotMatch(ignore, /CLAUDE\.md/, "the user's own file is not hidden");
  assert.doesNotMatch(ignore, /\.agents/, "antigravity is not a target here");

  const tracked = project();
  const run = await init(tracked, { installed: ["codex"], yes: true, isTrackedFn: (file) => file.endsWith("AGENTS.md") });
  assert.doesNotMatch(read(tracked, ".gitignore"), /AGENTS\.md/);
  assert.match(run.out, /not added to \.gitignore[^\n]*AGENTS\.md/);
});

test("a second run changes nothing", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "agents text\n");
  await init(cwd, { installed: ["claude"], yes: true });
  const snapshot = () => fs.readdirSync(cwd, { recursive: true }).filter((name) => !String(name).startsWith(".git" + path.sep) && fs.statSync(path.join(cwd, name)).isFile()).sort().map((name) => `${name}\n${read(cwd, name)}`);
  const before = snapshot();
  await init(cwd, { installed: ["claude"], yes: true });
  assert.deepEqual(snapshot(), before);
});

test("--targets wins over what is detected and asks nothing", async () => {
  const cwd = project();
  write(cwd, "CLAUDE.md", "mine\n");
  const run = await init(cwd, { installed: ["codex"], yes: true, targets: ["cursor"] });
  assert.deepEqual(targetsOf(cwd), ["cursor"]);
  assert.doesNotMatch(run.out, /rulesync: yes/);
});

test("a dry run writes no root, no rule and no ignore entry", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "agents text\n");
  const run = await init(cwd, { installed: ["claude"], dryRun: true });
  assert.ok(!has(cwd, ".rulesync") && !has(cwd, "rulesync.jsonc") && !has(cwd, ".gitignore"));
  assert.match(run.out, /would import AGENTS\.md as the root rule/);
});

test("interactively rulesync is offered, yes by default, and the marked targets are taken with Enter", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude"], answers: [[/rulesync/i, ""]] });
  assert.ok(run.asked.some((q) => /Write the agents' files with rulesync/.test(q)));
  assert.deepEqual(targetsOf(cwd), ["claudecode"]);
  assert.match(run.out, /1\. \* claudecode {2}\[installed\]/);
  assert.match(run.out, /2\. {3}codexcli/, "an agent that is not installed is listed unmarked");
  const menu = run.out.split("Agents rulesync")[1].split("\n\n")[0];
  assert.doesNotMatch(menu, /karajan|generic/, "neither is a rulesync target");
});

test("answering no to rulesync writes the rule where each marked agent reads it, and no rulesync file", async () => {
  const cwd = project();
  const run = await init(cwd, { installed: ["claude", "codex"], answers: [[/rulesync/i, "n"]] });
  assert.ok(has(cwd, ".claude/rules/toolgate-router.md"));
  assert.match(read(cwd, "AGENTS.md"), /Toolgate Step 0 router/);
  assert.ok(!has(cwd, ".rulesync") && !has(cwd, "rulesync.jsonc"));
  assert.doesNotMatch(run.out, /run `rulesync generate`/);

  const mine = project();
  write(mine, "AGENTS.md", "my text\n");
  const kept = await init(mine, { installed: ["codex"], answers: [[/rulesync/i, "n"]] });
  assert.equal(read(mine, "AGENTS.md"), "my text\n");
  assert.match(kept.out, /AGENTS\.md exists and toolgate does not edit it/);
});

test("a number list picks the targets", async () => {
  const cwd = project();
  await init(cwd, { installed: ["claude"], answers: [[/Targets\?/, "2,opencode"]] });
  assert.deepEqual(targetsOf(cwd), ["codexcli", "opencode"]);
});

test("a dangling link at overview.md, or a link as .rulesync/rules, is skipped with a note: no error, nothing written through it", async () => {
  const cwd = project();
  write(cwd, "AGENTS.md", "agents text\n");
  fs.mkdirSync(path.join(cwd, ".rulesync", "rules"), { recursive: true });
  fs.symlinkSync(path.join(cwd, "nowhere.md"), path.join(cwd, ".rulesync/rules/overview.md"));
  const run = await init(cwd, { installed: ["claude"], yes: true });
  assert.equal(run.code, 0);
  assert.ok(!has(cwd, "nowhere.md"), "nothing was written through the link");
  assert.match(run.out, /overview\.md exists but is not a root rule/);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-out-"));
  const linked = project();
  fs.mkdirSync(path.join(linked, ".rulesync"));
  fs.symlinkSync(outside, path.join(linked, ".rulesync", "rules"));
  const second = await init(linked, { installed: ["claude"], yes: true });
  assert.equal(second.code, 0);
  assert.deepEqual(fs.readdirSync(outside), [], "nothing reached the folder the link leads to");
  assert.match(second.out, /\.rulesync\/rules is a link or not a folder/);
});
