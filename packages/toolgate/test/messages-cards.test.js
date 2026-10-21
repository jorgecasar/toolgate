// Messages, the init bridge note, the gitignore map and old cards (#241 T3).
import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import { checkSkills } from "../src/doctor/checks.js";
import { offerBridge } from "../src/initBridge.js";
import { generatedIgnores } from "../src/rulesyncSetup.js";
import { runUpdate } from "../src/update/index.js";
import { git as hermeticGit } from "./support/git.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-t3-")));
  made.push(dir);
  return dir;
};
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const quiet = () => {
  const out = [];
  const err = [];
  return { out: () => out.join(""), err: () => err.join(""), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
};
test("an agent that is not in the registry ends with a short message and exit 1, not a stack trace, for --adapter and for a stored defaultAgent", async () => {
  const names = defaultRegistry.names().join(", ");
  for (const [argv, config] of [[["--adapter", "gemini-cli", "go"], {}], [["go"], { defaultAgent: "gemini-cli" }]]) {
    const s = quiet();
    const code = await run(["--no-route", ...argv], { cwd: tmp(), ...s, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, loadConfigFn: () => config, loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {} });
    assert.equal(code, 1);
    assert.equal(s.err(), `toolgate: unknown agent "gemini-cli"; run toolgate init --agent <one of ${names}>\n`);
    assert.equal(s.out(), "");
  }
  const hostile = quiet();
  await run(["--no-route", "--adapter", "a\u001b[31m‮b", "go"], { cwd: tmp(), ...hostile, env: { HOME: tmp() }, loadConfigFn: () => ({}), loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {} });
  assert.ok(hostile.err().includes('unknown agent "a\\u001b[31m\\u202eb"'), hostile.err());
});
test("--help and -h print the usage as always, also after `--` for a subcommand or with nothing before it; for an agent launch what follows `--` is the agent's", async () => {
  const launches = [];
  const adapter = { capability: { subagents: { kind: "unknown" } }, launch: (options) => (launches.push(options), Promise.resolve({ code: 0 })) };
  const deps = (s) => ({ cwd: tmp(), ...s, env: { TOOLGATE_ADAPTER: "claude-code", HOME: tmp(), XDG_CONFIG_HOME: tmp(), TOOLGATE_DEFAULTS: "/nonexistent/none.json" }, loadConfigFn: () => ({}), loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {}, adapters: { "claude-code": () => Promise.resolve(adapter) } });
  for (const argv of [["--help"], ["-h"], ["go", "--help"], ["init", "--", "--help"], ["--", "-h"], ["--no-route", "--", "--help"], ["route", "--prompt", "x", "--", "-h"], ["skills", "--", "--help"], ["--adapter", "claude-code", "init", "--", "-h"], ["doctor", "--", "-h"]]) {
    const s = quiet();
    assert.equal(await run(argv, deps(s)), 0, `${argv.join(" ")}: ${s.err()}`);
    assert.match(s.out(), /Usage|usage/i, argv.join(" "));
  }
  assert.equal(launches.length, 0, "no agent was launched and no subcommand ran");
  for (const argv of [["--no-route", "go", "--", "--help"], ["--no-route", "go", "--", "-h"], ["--no-route", "--adapter", "claude-code", "go", "--", "--help"]]) {
    const s = quiet();
    assert.equal(await run(argv, deps(s)), 0, `${argv.join(" ")}: ${s.err()}`);
    assert.doesNotMatch(s.out(), /Usage/i, `${argv.join(" ")}: no usage text`);
  }
  assert.equal(launches.length, 3, "the agent was launched with its own --help each time");
  // The agent-name form goes to the wrapper (this fake adapter cannot be wrapped), not to the usage text.
  for (const argv of [["claude-code", "--", "--help"], ["claude-code", "--", "-h"]]) {
    const s = quiet();
    assert.equal(await run(argv, deps(s)), 1);
    assert.doesNotMatch(s.out(), /Usage/i, argv.join(" "));
    assert.match(s.err(), /cannot be wrapped/, argv.join(" "));
  }
});
// A local git repository with one file of the kind; `change` commits a new text for it.
function remote(file, text) {
  const root = tmp();
  const git = (...args) => hermeticGit(root, ...args);
  git("init", "-q", "-b", "main");
  const put = (body) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  };
  put(text);
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  return { url: `file://${root}`, change: (body) => (put(body), git("add", "-A"), git("commit", "-q", "-m", "two")) };
}
const KINDS = [
  ["skills", "skills/alpha/SKILL.md", (body) => `---\nname: alpha\ndescription: the alpha skill\n---\n${body}\n`],
  ["commands", "commands/review.md", (body) => `---\ndescription: Review\n---\n${body}\n`],
  ["subagents", "subagents/scout.md", (body) => `---\nname: scout\ndescription: Scouts\n---\n${body}\n`],
];
for (const [command, file, render] of KINDS) {
  test(`${command} install --dry-run says "would update" for what an install would update, and the real run says "updated"`, async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, ".git"));
    const s = quiet();
    const deps = { cwd, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp(), XDG_CACHE_HOME: tmp(), TOOLGATE_DEFAULTS: "/nonexistent/none.json" }, ...s, loadConfigFn: () => ({}), daemon: { status: async () => ({ running: false }) }, skills: { execFn: () => "" }, install: { allowFile: true, cache: tmp() } };
    const source = remote(file, render("one"));
    assert.equal(await run([command, "install", source.url], deps), 0, s.err());
    source.change(render("two"));
    const before = s.out().length;
    assert.equal(await run([command, "install", source.url, "--dry-run"], deps), 0, s.err());
    const dry = s.out().slice(before);
    assert.match(dry, /^  would update: \w+$/m, dry);
    assert.doesNotMatch(dry, /^  updated:/m);
    const middle = s.out().length;
    assert.equal(await run([command, "install", source.url], deps), 0, s.err());
    assert.match(s.out().slice(middle), /^  updated: \w+$/m);
  });
}
test("update: after a bridge refresh the note says what to do for a bridge, and still says rulesync generate for the rule", async () => {
  const cwd = tmp();
  const old = "---\ndescription: old\n---\n\nOld /toolgate command.\n";
  fs.mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "commands", "toolgate.md"), old);
  fs.mkdirSync(path.join(cwd, ".rulesync", "rules"), { recursive: true });
  const oldRule = "---\nroot: false\n---\nold rule\n";
  fs.writeFileSync(path.join(cwd, ".rulesync", "rules", "toolgate-router.md"), oldRule);
  const out = [];
  await runUpdate({ cwd, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, yes: true, json: true, stdout: { write: (s) => out.push(s) }, knownHashes: [sha256(oldRule)], knownBridgeHashes: [sha256(old)], isTrackedFn: () => false, interactive: false });
  const notes = Object.fromEntries(JSON.parse(out.join("")).migrations.map((m) => [m.id, m.note]));
  assert.match(notes["bridge-refresh:claude-code"], /^replaced \.claude\/commands\/toolgate\.md: it was an older text of toolgate that you had not edited; open a new session of the agent to see it$/);
  assert.doesNotMatch(notes["bridge-refresh:claude-code"], /rulesync/);
  assert.match(notes["rule-file-refresh"], /^replaced \.rulesync\/rules\/toolgate-router\.md: it was an older text of toolgate that you had not edited; run `rulesync generate` so the agents get it$/);
});
test("init: a /toolgate command that toolgate wrote and nobody edited, of a text no release shipped, is outdated, not 'changed by hand'", async () => {
  const note = async (body) => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "commands", "toolgate.md"), body);
    const notes = [];
    await offerBridge({ cwd, env: { HOME: tmp() }, agents: [{ name: "claude-code" }], yes: true, interactive: false, dryRun: false, ask: async () => "", notes, done: [], onThisMachine: [], knownHashes: [] });
    return notes;
  };
  const old = "---\ndescription: old\n---\n\nOld text.\n";
  const outdated = old.replace("---\n\n", `---\n<!-- generated by toolgate (sha256 ${sha256(old)}): old -->\n\n`);
  assert.deepEqual(await note(outdated), [".claude/commands/toolgate.md is an outdated /toolgate command (toolgate wrote it and it was not changed by hand), so toolgate leaves it as it is (`toolgate commands bridge --force` regenerates it)"]);
  const edited = outdated.replace("Old text.", "My text.");
  assert.deepEqual(await note(edited), [".claude/commands/toolgate.md was changed by hand, so toolgate leaves it as it is (`toolgate commands bridge --force` regenerates it)"]);
});
test("the gitignore map has the generated files of the imported CLAUDE.md and GEMINI.md rules", () => {
  const ignores = (targets) => generatedIgnores({ cwd: tmp(), targets, imported: [], isTrackedFn: () => false }).patterns;
  assert.ok(ignores(["claudecode"]).includes(".claude/rules/claude-md.md"));
  assert.ok(ignores(["antigravity-cli"]).includes(".agents/rules/gemini-md.md"));
  assert.ok(!ignores(["codexcli"]).some((p) => /claude-md|gemini-md/.test(p)));
});
test("doctor: the skills.overrides hint is valid JSON that names the skill as it is, and a lock that cannot be read prints its error escaped", () => {
  const hostile = "dem\u202eo";
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate", "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "skills", "demo", "SKILL.md"), `---\nname: "${hostile}"\n---\nbody\n`);
  const findings = checkSkills({ cwd, config: {}, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, homedir: tmp() });
  const hint = findings.map((f) => f.hint ?? f.fix ?? "").find((h) => h.includes("skills.overrides"));
  assert.ok(hint, "a skill without a description gets the override hint");
  assert.ok(!hint.includes("\u202e"), "nothing hidden is left raw");
  const json = /'(\{"skill":.*\})'/.exec(hint)[1].replace('"<text>"', '"x"');
  assert.equal(JSON.parse(json).skill, hostile, "and the JSON names the skill exactly");
  // The levels check cannot be made to fail by a file alone: a read that throws with hostile text stands in for the failure.
  const xdg = path.join(tmp(), "xdg-levels");
  fs.mkdirSync(path.join(xdg, "toolgate", "skills"), { recursive: true });
  const original = fs.readdirSync;
  const reads = mock.method(fs, "readdirSync", (dir, ...rest) => {
    if (String(dir).includes("xdg-levels")) throw new Error("EACCES \u202e hidden \u001b[31m");
    return original(dir, ...rest);
  });
  let levels;
  try {
    levels = checkSkills({ cwd: tmp(), config: {}, env: { HOME: tmp(), XDG_CONFIG_HOME: xdg }, homedir: tmp() }).find((f) => /levels could not be checked/.test(f.message));
  } finally {
    reads.mock.restore();
  }
  assert.ok(levels, "the levels check failed");
  assert.equal(levels.message, "levels could not be checked: EACCES \\u202e hidden \\u001b[31m");
});
