import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/init.js";
import { run as cliRun } from "../src/cli.js";
// The daemon is faked by default: with none, `refreshDaemon` would ask the real default port whether a daemon is up (the hermetic guard refuses that).
const run = (argv, deps = {}) => cliRun(argv, { ...deps, daemon: { status: async () => ({ running: false }), ...deps.daemon } });

const COMMAND = "npm install -g @tobilu/qmd";
const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-initqmd-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// A machine: `qmd` answers or not; `npm install -g @tobilu/qmd` makes it answer, fails, or finishes without effect.
function setup({ qmd = false, npm = "installs" } = {}) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  const state = { qmd };
  const calls = [];
  const daemon = [];
  const out = [];
  const execFn = (bin, args = []) => {
    calls.push([bin, ...args].join(" "));
    if (bin === "rulesync") return "";
    if (bin === "qmd") {
      if (state.qmd) return "";
      throw new Error("spawn qmd ENOENT");
    }
    if (bin === "npm") {
      if (npm === "fails") throw Object.assign(new Error("Command failed: npm install -g @tobilu/qmd\nnpm ERR! code EACCES\n    at Object.<anonymous> (/x.js:1:1)"), { stderr: "npm ERR! code EACCES\nnpm ERR! permission denied" });
      if (npm === "installs") state.qmd = true;
      return "";
    }
    throw new Error(`${bin}: not found`);
  };
  const init = (extra = {}) =>
    runInit({
      cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn,
      daemon: { ensure: async (options) => (daemon.push(options), { running: true, started: true, url: "http://localhost:8181/mcp" }) },
      skillsDeps: { execFn },
      interactive: false,
      nodeMajor: 24,
      targets: ["claudecode"],
      ...extra,
    }).then((code) => ({ code, text: out.join("") }));
  const config = () => JSON.parse(fs.readFileSync(path.join(cwd, ".toolgate/config.json"), "utf8"));
  const installs = () => calls.filter((call) => call.startsWith("npm "));
  return { cwd, init, config, calls, daemon, installs, state };
}
const answering = (reply, asked = []) => async (question) => (asked.push(question), /^qmd was not found/.test(question) ? reply : "");

test("the backend is qmd by default, with or without qmd installed: config.json does not depend on the machine", async () => {
  const without = setup();
  await without.init();
  const present = setup({ qmd: true });
  await present.init();
  assert.deepEqual(without.config(), { router: { backend: "qmd" } });
  assert.deepEqual(present.config(), without.config());
  const regex = setup();
  await regex.init({ backend: "regex" });
  assert.deepEqual(regex.config(), { router: { backend: "regex" } });
});

test("--backend regex never asks, never installs, never starts the daemon and never indexes", async () => {
  const t = setup({ qmd: true });
  fs.mkdirSync(path.join(t.cwd, ".toolgate/skills/one"), { recursive: true });
  fs.writeFileSync(path.join(t.cwd, ".toolgate/skills/one/SKILL.md"), "---\nname: one\ndescription: d\n---\n");
  const asked = [];
  const { code, text } = await t.init({ backend: "regex", interactive: true, ask: answering("y", asked) });
  assert.equal(code, 0);
  assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
  assert.deepEqual(t.installs(), []);
  assert.deepEqual(t.daemon, []);
  assert.equal(t.calls.some((call) => call.startsWith("qmd collection")), false);
  assert.doesNotMatch(text, /qmd daemon|indexed/);
  // And without qmd on the machine: nothing is offered either.
  const bare = setup();
  const questions = [];
  const result = await bare.init({ backend: "regex", interactive: true, ask: answering("y", questions) });
  assert.equal(result.code, 0);
  assert.equal(questions.some((q) => /^qmd was not found/.test(q)), false);
  assert.deepEqual(bare.installs(), []);
  assert.doesNotMatch(result.text, /qmd was not found/);
});

test("qmd missing in a terminal: the question shows the exact command; yes installs it and init goes on with the daemon", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ interactive: true, ask: answering("y", asked) });
  assert.equal(code, 0);
  assert.equal(asked.find((q) => /^qmd was not found/.test(q)), `qmd was not found. Install it now with: ${COMMAND} ? [y/N] `);
  assert.deepEqual(t.installs(), [COMMAND]);
  assert.match(text, /installed qmd \(npm install -g @tobilu\/qmd\)/);
  assert.equal(t.daemon.length, 1, "qmd is there now, so the daemon is started");
});

test("qmd missing in a terminal: no, or Enter, installs nothing and says how", async () => {
  for (const reply of ["n", "", "no", "yes please"]) {
    const t = setup();
    const { code, text } = await t.init({ interactive: true, ask: answering(reply) });
    assert.equal(code, 0, reply);
    assert.equal(t.installs().length, 0, reply);
    assert.match(text, /qmd was not found, so skills are searched by keywords only until it is installed \(`npm install -g @tobilu\/qmd`\)/);
    assert.deepEqual(t.daemon, []);
  }
});

test("CI and no terminal: no question and no install, only the note with the command", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ ask: answering("y", asked) });
  assert.equal(code, 0);
  assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
  assert.deepEqual(t.installs(), []);
  assert.match(text, /npm install -g @tobilu\/qmd/);
  assert.deepEqual(t.config(), { router: { backend: "qmd" } });
});

test("--yes takes the default for qmd: it installs it without asking, in a terminal or not", async () => {
  for (const extra of [{ yes: true }, { yes: true, interactive: true }]) {
    const t = setup();
    const asked = [];
    const { code, text } = await t.init({ ...extra, ask: answering("n", asked) });
    assert.equal(code, 0);
    assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
    assert.deepEqual(t.installs(), [COMMAND]);
    assert.match(text, /installed qmd \(npm install -g @tobilu\/qmd\)/);
  }
  const regex = setup();
  await regex.init({ yes: true, backend: "regex" });
  assert.deepEqual(regex.installs(), [], "the regex backend never uses qmd, so --yes installs nothing");
});

test("--install-qmd installs without asking, also with --yes, and is refused with --backend regex before anything is written", async () => {
  for (const extra of [{}, { yes: true }]) {
    const t = setup();
    const asked = [];
    await t.init({ installQmd: true, interactive: true, ask: answering("n", asked), ...extra });
    assert.deepEqual(t.installs(), [COMMAND]);
    assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
  }
  const t = setup();
  const { code, text } = await t.init({ installQmd: true, backend: "regex" });
  assert.equal(code, 1);
  assert.match(text, /--install-qmd and --backend regex contradict each other/);
  assert.deepEqual(fs.readdirSync(t.cwd), [".git"]);
  assert.deepEqual(t.installs(), []);
});

test("an unknown --backend is refused before anything is written", async () => {
  const t = setup();
  const { code, text } = await t.init({ backend: "sqlite" });
  assert.equal(code, 1);
  assert.match(text, /--backend is qmd or regex, not "sqlite"/);
  assert.deepEqual(fs.readdirSync(t.cwd), [".git"]);
});

test("a qmd that already answers (a global one, or the one that comes with toolgate) means no question and no install", async () => {
  const t = setup({ qmd: true });
  const asked = [];
  await t.init({ interactive: true, installQmd: true, ask: answering("y", asked) });
  assert.deepEqual(t.installs(), []);
  assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
  assert.equal(t.daemon.length, 1);
});

test("on Node older than 22 qmd cannot run: no question, no install even with --install-qmd, and the note says why", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ nodeMajor: 20, interactive: true, installQmd: true, ask: answering("y", asked) });
  assert.equal(code, 0);
  assert.equal(asked.some((q) => /^qmd was not found/.test(q)), false);
  assert.deepEqual(t.installs(), []);
  assert.match(text, /needs Node 22 or newer and this is Node 20/);
});

test("a failed install is one short note, no stack trace, exit 0, and the rest of init still runs", async () => {
  const t = setup({ npm: "fails" });
  const { code, text } = await t.init({ installQmd: true });
  assert.equal(code, 0);
  assert.match(text, /could not install qmd \(npm ERR! code EACCES\); run it yourself: npm install -g @tobilu\/qmd/);
  assert.doesNotMatch(text, /\n\s+at |Command failed/);
  assert.ok(fs.existsSync(path.join(t.cwd, ".rulesync/rules/toolgate-router.md")), "the rest of init ran");
  assert.deepEqual(t.daemon, []);
});

test("an install that finishes but leaves no qmd on the PATH is a note, not a success", async () => {
  const t = setup({ npm: "noeffect" });
  const { code, text } = await t.init({ installQmd: true });
  assert.equal(code, 0);
  assert.match(text, /finished but qmd is still not on the PATH/);
  assert.doesNotMatch(text, /installed qmd/);
});

test("Ctrl+C at the qmd question installs nothing, exits 1 and asks nothing else", async () => {
  const t = setup();
  const asked = [];
  const { code } = await t.init({ interactive: true, ask: async (q) => (asked.push(q), null) });
  assert.equal(code, 1);
  assert.equal(asked.length, 1);
  assert.deepEqual(t.installs(), []);
});

test("--install-qmd and --backend reach init from the command line", async () => {
  const t = setup();
  const out = [];
  const exec = (bin, args = []) => {
    t.calls.push([bin, ...args].join(" "));
    if (bin === "npm") return "";
    throw new Error("none");
  };
  const code = await run(["init", "--install-qmd"], { cwd: t.cwd, env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") }, stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, init: { execFn: exec, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false, nodeMajor: 24 } });
  assert.equal(code, 0);
  assert.deepEqual(t.installs(), [COMMAND]);
  const regex = setup();
  assert.equal(await run(["init", "--backend", "regex"], { cwd: regex.cwd, env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache") }, stdout: { write() {} }, stderr: { write() {} }, init: { execFn: exec, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: false } }), 0);
  assert.deepEqual(regex.config(), { router: { backend: "regex" } });
});

test("init writes the same files with and without qmd installed (starting the daemon and indexing are effects)", async () => {
  const tree = (cwd) => {
    const files = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        if (entry.name === ".git" || entry.name === "skills-index") continue;
        if (entry.isDirectory()) walk(full);
        else files[path.relative(cwd, full)] = fs.readFileSync(full, "utf8");
      }
    };
    walk(cwd);
    return files;
  };
  for (const extra of [{}, { backend: "regex" }, { targets: ["claudecode", "codexcli"] }]) {
    const without = setup();
    const present = setup({ qmd: true });
    for (const t of [without, present]) {
      fs.mkdirSync(path.join(t.cwd, ".toolgate/skills/one"), { recursive: true });
      fs.writeFileSync(path.join(t.cwd, ".toolgate/skills/one/SKILL.md"), "---\nname: one\ndescription: d\n---\n");
    }
    await without.init(extra);
    await present.init(extra);
    assert.deepEqual(tree(present.cwd), tree(without.cwd), JSON.stringify(extra));
  }
});
