import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTargets, runInit } from "../src/init.js";
import { run as cliRun } from "../src/cli.js";
// The daemon is faked by default: with none, `refreshDaemon` would ask the real default port whether a daemon is up (the hermetic guard refuses that).
const run = (argv, deps = {}) => cliRun(argv, { ...deps, daemon: { status: async () => ({ running: false }), ...deps.daemon } });

const TEMPLATE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "step0-rule.md"), "utf8");
const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-initrs-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// `installed` lists the binaries that "exist" on this fake machine (qmd never does, so the backend is the same).
function setup(installed = []) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  const out = [];
  const exec = (bin) => {
    if (installed.includes(bin)) return "";
    throw new Error(`${bin}: not found`);
  };
  const init = (extra = {}) =>
    runInit({
      cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn: exec,
      daemon: { ensure: async () => ({ running: false, reason: "test" }) },
      skillsDeps: { execFn: exec },
      interactive: false,
      ...extra,
    }).then((code) => ({ code, text: out.join("") }));
  const has = (file) => fs.existsSync(path.join(cwd, file));
  const read = (file) => fs.readFileSync(path.join(cwd, file), "utf8");
  return { cwd, init, has, read };
}
const treeOf = (cwd) => {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else files[path.relative(cwd, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(cwd);
  return files;
};

test("the Step 0 rule always goes to .rulesync/rules, never to an agent's own file, whatever is installed", async () => {
  const t = setup(["claude", "codex", "rulesync"]);
  const { code, text } = await t.init();
  assert.equal(code, 0);
  assert.match(t.read(".rulesync/rules/toolgate-router.md"), /^---\ntargets: \["\*"\]\n[\s\S]*# Toolgate Step 0 router/);
  for (const absent of [".claude/rules", "AGENTS.md", ".agents/rules"]) assert.equal(t.has(absent), false, absent);
  assert.match(text, /run `rulesync generate`/);
});

test("rulesync.jsonc is created minimal: the targets of the flag (default: the installed agents), only the rules feature", async () => {
  const dflt = setup(["claude"]);
  await dflt.init();
  assert.deepEqual(JSON.parse(dflt.read("rulesync.jsonc")), { $schema: "https://github.com/dyoshikawa/rulesync/releases/latest/download/config-schema.json", targets: ["claudecode"], features: ["rules"] });
  const flagged = setup();
  const { text } = await flagged.init({ targets: ["claudecode", "codexcli", "claudecode"] });
  assert.deepEqual(JSON.parse(flagged.read("rulesync.jsonc")).targets, ["claudecode", "codexcli"], "repeated ids are written once");
  assert.match(text, /created rulesync\.jsonc \(targets: claudecode, codexcli\)/);
  assert.equal(JSON.parse(flagged.read("rulesync.jsonc")).delete, undefined, "no `delete`, no other feature");
});

test("an existing rulesync.jsonc is never rewritten: a target it lacks is printed, one it has is not", async () => {
  const mine = '{\n  // my own comment\n  "targets": ["claudecode", "antigravity-cli"],\n  "delete": true,\n}\n';
  const t = setup();
  fs.writeFileSync(path.join(t.cwd, "rulesync.jsonc"), mine);
  const noFlag = await t.init();
  assert.equal(t.read("rulesync.jsonc"), mine, "byte for byte");
  assert.match(noFlag.text, /kept rulesync\.jsonc \(targets: claudecode, antigravity-cli\)/);
  assert.doesNotMatch(noFlag.text, /does not list/);
  const flagged = await t.init({ targets: ["claudecode", "codexcli", "opencode"] });
  assert.equal(t.read("rulesync.jsonc"), mine);
  assert.match(flagged.text, /rulesync\.jsonc does not list codexcli, opencode: add "codexcli", "opencode" to its "targets" \(init does not edit this file\)/);
  const star = setup();
  fs.writeFileSync(path.join(star.cwd, "rulesync.jsonc"), '{"targets": ["*"]}');
  assert.doesNotMatch((await star.init({ targets: ["codexcli"] })).text, /does not list/);
});

test("--targets that are not rulesync ids are refused before anything is written", async () => {
  for (const bad of [[""], ["Claude Code"], ["a,b;rm"], ["../x"], ["-x"]]) {
    const t = setup();
    const { code, text } = await t.init({ targets: bad });
    assert.equal(code, 1, JSON.stringify(bad));
    assert.match(text, /--targets takes rulesync target ids/);
    assert.deepEqual(fs.readdirSync(t.cwd), [".git"], "nothing written");
  }
  assert.deepEqual(parseTargets("claudecode,codexcli,antigravity-cli,*"), ["claudecode", "codexcli", "antigravity-cli", "*"]);
  assert.equal(parseTargets("a,,b"), null);
});

test("--targets reaches init from the command line, in both spellings", async () => {
  for (const args of [["--targets", "claudecode,codexcli"], ["--targets=claudecode,codexcli"]]) {
    const t = setup();
    const out = [];
    const code = await run(["init", ...args], { cwd: t.cwd, env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") }, stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, init: { execFn: () => { throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false } });
    assert.equal(code, 0, args.join(" "));
    assert.deepEqual(JSON.parse(t.read("rulesync.jsonc")).targets, ["claudecode", "codexcli"]);
  }
});

test("init says when rulesync is not installed, and does not when it is", async () => {
  const missing = await setup([]).init();
  assert.match(missing.text, /Found on this machine \(informational[\s\S]*rulesync is not installed \(`npm install -g rulesync`\)/);
  assert.doesNotMatch((await setup(["rulesync"]).init()).text, /rulesync is not installed/);
});

test("a rule an earlier init wrote into an agent's file is noted, not touched, and only when it is the template", async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.cwd, ".claude/rules"), { recursive: true });
  fs.writeFileSync(path.join(t.cwd, ".claude/rules/toolgate-router.md"), TEMPLATE);
  fs.writeFileSync(path.join(t.cwd, "AGENTS.md"), TEMPLATE);
  fs.mkdirSync(path.join(t.cwd, ".agents/rules"), { recursive: true });
  fs.writeFileSync(path.join(t.cwd, ".agents/rules/toolgate-router.md"), `${TEMPLATE}\nmy own notes\n`);
  const { text } = await t.init();
  assert.match(text, /\.claude\/rules\/toolgate-router\.md was written by an earlier `toolgate init`/);
  assert.match(text, /AGENTS\.md was written by an earlier `toolgate init`/);
  assert.doesNotMatch(text, /\.agents\/rules\/toolgate-router\.md was written/, "a file that differs is the user's");
  assert.equal(t.read("AGENTS.md"), TEMPLATE);
  assert.match(t.read(".agents/rules/toolgate-router.md"), /my own notes/);
});

test("init is deterministic: the same flags give the same files and the same output with 0, 1 or 3 agents installed (explicit targets)", async () => {
  const shot = async (installed, extra) => {
    const t = setup(installed);
    const { code, text } = await t.init(extra);
    // The section that reports this machine is the one thing allowed to differ.
    // The /toolgate command is about the agents installed here (init-bridge.test.js), so it is left out of this comparison.
    const output = text.split(t.cwd).join("<project>").replace(/\nFound on this machine[\s\S]*?(?=\n\S|$)/, "").replace(/^ {2}\/toolgate command: .*\n/gm, "").replace(/^ {2}- (restart the agent|codex reads).*\n/gm, "");
    const files = Object.fromEntries(Object.entries(treeOf(t.cwd)).filter(([name]) => !/(commands|workflows|command)\/toolgate\.md$/.test(name)));
    return { code, output, files };
  };
  // The default agent follows what is installed (init-agent.test.js), so --agent pins it for this comparison.
  for (const extra of [{ agent: "claude-code", targets: ["claudecode"] }, { agent: "claude-code", targets: ["claudecode", "codexcli"] }, { targets: ["claudecode"], agent: "claude-code", yes: true }]) {
    const none = await shot([], extra);
    const one = await shot(["codex"], extra);
    const three = await shot(["claude", "codex", "opencode"], extra);
    assert.deepEqual(one, none, JSON.stringify(extra));
    assert.deepEqual(three, none, JSON.stringify(extra));
  }
});

// A machine where `rulesync` answers or not, and `npm install -g rulesync` makes it answer, fails, or finishes without effect.
function machine({ rulesync = false, npm = "installs" } = {}) {
  const state = { rulesync };
  const calls = [];
  const exec = (bin, args = []) => {
    calls.push([bin, ...args].join(" "));
    if (bin === "rulesync") {
      if (state.rulesync) return "";
      throw new Error("spawn rulesync ENOENT");
    }
    if (bin === "npm") {
      if (npm === "fails") throw Object.assign(new Error("Command failed: npm install -g rulesync\nnpm ERR! code EACCES\n    at Object.<anonymous> (/x.js:1:1)"), { stderr: "npm ERR! code EACCES\nnpm ERR! permission denied" });
      if (npm === "installs") state.rulesync = true;
      return "";
    }
    throw new Error(`${bin}: not found`);
  };
  const t = setup();
  const asked = [];
  const out = [];
  const init = (extra = {}) =>
    runInit({
      cwd: t.cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn: exec,
      daemon: { ensure: async () => ({ running: false, reason: "test" }) },
      skillsDeps: { execFn: exec },
      interactive: false,
      targets: ["claudecode"],
      ...extra,
    }).then((code) => ({ code, text: out.join("") }));
  const installs = () => calls.filter((call) => call.startsWith("npm "));
  return { init, installs, asked, ask: (reply) => async (question) => (asked.push(question), /^rulesync was not found/.test(question) ? reply : "") };
}
const RS_COMMAND = "npm install -g rulesync";

test("rulesync missing and wanted, in a terminal: the question shows the exact command; yes installs it", async () => {
  const m = machine();
  const { code, text } = await m.init({ interactive: true, ask: m.ask("y") });
  assert.equal(code, 0);
  assert.equal(m.asked.find((q) => /^rulesync was not found/.test(q)), `rulesync was not found. Install it now with: ${RS_COMMAND} ? [y/N] `);
  assert.deepEqual(m.installs(), [RS_COMMAND]);
  assert.match(text, /installed rulesync \(npm install -g rulesync\)/);
  assert.doesNotMatch(text, /rulesync is not installed/);
});

test("rulesync missing and wanted: no, or Enter, installs nothing and says how", async () => {
  for (const reply of ["n", "", "no", "yes please"]) {
    const m = machine();
    const { code, text } = await m.init({ interactive: true, ask: m.ask(reply) });
    assert.equal(code, 0, reply);
    assert.deepEqual(m.installs(), [], reply);
    assert.match(text, /rulesync is not installed \(`npm install -g rulesync`\)/);
  }
});

test("rulesync missing: CI and no terminal ask nothing and install nothing; --yes and the flag install it without asking", async () => {
  const m = machine();
  const { text } = await m.init({ interactive: false, ask: m.ask("y") });
  assert.equal(m.asked.length, 0);
  assert.deepEqual(m.installs(), []);
  assert.match(text, /rulesync is not installed \(`npm install -g rulesync`\)/);
  for (const extra of [{ yes: true, interactive: true }, { yes: true }, { installRulesync: true }, { installRulesync: true, interactive: true }]) {
    const t = machine();
    const result = await t.init({ ...extra, ask: t.ask("n") });
    assert.equal(t.asked.some((q) => /^rulesync was not found/.test(q)), false, JSON.stringify(extra));
    assert.equal(t.installs().filter((call) => call === RS_COMMAND).length, 1, JSON.stringify(extra));
    assert.match(result.text, /installed rulesync/);
  }
  const unused = machine();
  await unused.init({ yes: true, targets: undefined });
  assert.equal(unused.installs().includes(RS_COMMAND), false, "--yes does not install rulesync when the project does not use it");
});

test("rulesync is not offered when the project does not use it, but --install-rulesync still installs it", async () => {
  const m = machine();
  const { code, text } = await m.init({ targets: undefined, interactive: true, ask: m.ask("y") });
  assert.equal(code, 0);
  assert.equal(m.asked.some((q) => /^rulesync was not found/.test(q)), false);
  assert.deepEqual(m.installs(), []);
  assert.match(text, /rulesync is not installed/);
  const asked = machine();
  await asked.init({ targets: undefined, installRulesync: true });
  assert.deepEqual(asked.installs(), [RS_COMMAND]);
});

test("rulesync is found in the project: its config alone makes it wanted", async () => {
  const first = setup();
  fs.writeFileSync(path.join(first.cwd, "rulesync.jsonc"), JSON.stringify({ targets: ["claudecode"], features: ["rules"] }));
  const exec = (bin) => {
    throw new Error(`${bin}: not found`);
  };
  const asked = [];
  await runInit({
    cwd: first.cwd,
    env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
    stdout: { write() {} },
    execFn: exec,
    daemon: { ensure: async () => ({ running: false, reason: "test" }) },
    skillsDeps: { execFn: exec },
    interactive: true,
    ask: async (q) => (asked.push(q), /^rulesync was not found/.test(q) ? "n" : ""),
  });
  assert.equal(asked.some((q) => /^rulesync was not found/.test(q)), true);
});

test("a failed rulesync install is one short note, no stack trace, exit 0; one that leaves no rulesync on the PATH is a note too", async () => {
  const failing = machine({ npm: "fails" });
  const { code, text } = await failing.init({ installRulesync: true });
  assert.equal(code, 0);
  assert.match(text, /could not install rulesync \(npm ERR! code EACCES\); run it yourself: npm install -g rulesync/);
  assert.doesNotMatch(text, /at Object|\.js:\d/);
  const noEffect = machine({ npm: "noop" });
  const result = await noEffect.init({ installRulesync: true });
  assert.equal(result.code, 0);
  assert.match(result.text, /finished but rulesync is still not on the PATH/);
  assert.doesNotMatch(result.text, /installed rulesync/);
});

test("--dry-run says it would install rulesync and runs nothing", async () => {
  const m = machine();
  const { code, text } = await m.init({ dryRun: true, installRulesync: true });
  assert.equal(code, 0);
  assert.match(text, /would install rulesync \(npm install -g rulesync\)/);
  assert.deepEqual(m.installs(), []);
});

test("Ctrl+C at the rulesync question installs nothing, exits 1 and asks nothing else", async () => {
  const m = machine();
  const { code } = await m.init({ interactive: true, ask: async (q) => (m.asked.push(q), null) });
  assert.equal(code, 1);
  assert.equal(m.asked.length, 1);
  assert.deepEqual(m.installs(), []);
});

test("--install-rulesync reaches init from the command line", async () => {
  const installs = [];
  const t = setup();
  const code = await run(["init", "--install-rulesync", "--targets", "claudecode"], {
    cwd: t.cwd,
    env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
    stdout: { write() {} },
    stderr: { write() {} },
    init: { execFn: (bin, args = []) => (bin === "npm" ? (installs.push(["npm", ...args].join(" ")), "") : (() => { throw new Error(`${bin}: not found`); })()), skillsDeps: { execFn: () => { throw new Error("none"); } }, interactive: false },
  });
  assert.equal(code, 0);
  assert.deepEqual(installs, [RS_COMMAND]);
});

test("targets listed in rulesync.jsonc are the answer: no question about them, and a file without a list still asks", async () => {
  const run = async (config) => {
    const t = setup();
    fs.writeFileSync(path.join(t.cwd, "CLAUDE.md"), "mine\n");
    if (config !== null) fs.writeFileSync(path.join(t.cwd, "rulesync.jsonc"), config);
    const asked = [];
    const out = [];
    const exec = (bin) => {
      if (bin === "claude" || bin === "rulesync") return "1.0";
      throw new Error("none");
    };
    await runInit({
      cwd: t.cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn: exec,
      daemon: { ensure: async () => ({ running: false, reason: "t" }) },
      interactive: true,
      backend: "regex",
      ask: async (q) => (asked.push(q), ""),
    });
    return { asked, text: out.join(""), t };
  };
  const listed = await run('{\n  // mine\n  "targets": ["claudecode", "antigravity-cli"],\n}\n');
  assert.equal(listed.asked.some((q) => /^Targets\?/.test(q)), false);
  assert.match(listed.text, /rulesync targets: claudecode, antigravity-cli \(from rulesync\.jsonc\)/);
  assert.match(listed.t.read("rulesync.jsonc"), /\/\/ mine/, "the file is never rewritten");
  assert.match(listed.text, /\.agents\/rules\/toolgate-router\.md/, "the generated files follow the listed targets, not only the installed agent");
  assert.equal((await run('{ "features": ["rules"] }\n')).asked.some((q) => /^Targets\?/.test(q)), true);
  assert.equal((await run(null)).asked.some((q) => /^Targets\?/.test(q)), true);
});
