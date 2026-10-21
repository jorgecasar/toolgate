import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init.js";
import { shippedRecommendations } from "../src/skills/recommended.js";
import { git as hermeticGit } from "./support/git.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-inityes-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);

// A machine where qmd is missing, no default agent is set and a recommended source is waiting: all the questions init has.
function setup() {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(remote, "skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "init");
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const entry = { id: "t/set", source: `file://${remote}`, commit: git(remote, "rev-parse", "HEAD").trim(), license: "MIT", skills: ["alpha"] };
  fs.writeFileSync(path.join(cwd, ".toolgate/config.json"), JSON.stringify({ router: { backend: "qmd" }, skills: { recommended: [...shippedRecommendations().map((e) => ({ id: e.id, disabled: true })), entry] } }));
  const asked = [];
  const calls = [];
  const state = { qmd: false };
  const execFn = (bin, args = []) => {
    calls.push([bin, ...args].join(" "));
    if (bin === "rulesync") return "";
    if (bin === "qmd") {
      if (state.qmd) return "";
      throw new Error("spawn qmd ENOENT");
    }
    if (bin === "npm") {
      state.qmd = true;
      return "";
    }
    throw new Error(`${bin}: not found`);
  };
  const out = [];
  const init = (extra = {}) =>
    runInit({
      cwd,
      env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") },
      stdout: { write: (s) => out.push(s) },
      execFn,
      daemon: { ensure: async () => ({ running: true, started: true, url: "http://localhost:8181/mcp" }) },
      skillsDeps: { execFn },
      install: { allowFile: true },
      interactive: true,
      nodeMajor: 24,
      ask: async (question) => (asked.push(question), "y"),
      ...extra,
    }).then((code) => ({ code, text: out.join("") }));
  const installed = () => fs.existsSync(path.join(cwd, ".toolgate/skills/alpha/SKILL.md"));
  const hasAgent = () => fs.existsSync(path.join(cwd, ".toolgate/config.local.json"));
  const npm = () => calls.filter((call) => call.startsWith("npm "));
  return { init, asked, installed, hasAgent, npm };
}

test("without --yes, in a terminal, init asks the three questions it has (so the tests below cover all of them)", async () => {
  const t = setup();
  await t.init({ targets: ["claudecode"] });
  assert.deepEqual(t.asked.map((q) => q.split(/[?(]/)[0].trim()), ["qmd was not found. Install it now with: npm install -g @tobilu/qmd", "Default agent", "Install which"]);
});

test("--yes in a terminal asks nothing, whichever of the three situations is waiting: it takes the defaults (install qmd) and skips the optional things", async () => {
  const t = setup();
  const { code } = await t.init({ yes: true });
  assert.equal(code, 0);
  assert.deepEqual(t.asked, [], "no question at all");
  assert.deepEqual(t.npm(), ["npm install -g @tobilu/qmd"], "qmd is the default backend, so --yes installs it");
  assert.equal(t.hasAgent(), false, "no default agent is chosen");
  assert.equal(t.installed(), false, "no recommended skill is installed");
});

test("--yes prints what each skipped question would have done, as the command to run", async () => {
  const t = setup();
  const { text } = await t.init({ yes: true });
  assert.match(text, /npm install -g @tobilu\/qmd/);
  assert.match(text, /toolgate config set defaultAgent <name> --local/);
  assert.match(text, /toolgate skills recommended/);
});

test("without a terminal and without --yes nothing is asked and nothing is installed: qmd, the default agent and the recommended skills are left as commands", async () => {
  const t = setup();
  const { code } = await t.init({ interactive: false });
  assert.equal(code, 0);
  assert.deepEqual(t.asked, []);
  assert.deepEqual(t.npm(), []);
  assert.equal(t.hasAgent() || t.installed(), false);
});

test("explicit flags still act under --yes, one by one and together, still without a question", async () => {
  const separately = [
    [{ agent: "claude-code" }, (t) => assert.equal(t.hasAgent(), true)],
    [{ installQmd: true }, (t) => assert.equal(t.npm().length, 1)],
    [{ installRecommended: ["t/set"] }, (t) => assert.equal(t.installed(), true)],
  ];
  for (const [flags, check] of separately) {
    const t = setup();
    await t.init({ yes: true, ...flags });
    check(t);
    assert.deepEqual(t.asked, [], JSON.stringify(flags));
  }
  const all = setup();
  const { code } = await all.init({ yes: true, agent: "claude-code", installQmd: true, installRecommended: ["t/set"] });
  assert.equal(code, 0);
  assert.deepEqual(all.asked, []);
  assert.equal(all.hasAgent() && all.installed() && all.npm().length === 1, true);
});

test("rulesync and its targets are asked in a terminal when an agent is installed, and not at all with nothing to choose", async () => {
  const marked = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-inityes-marked-"));
  cleanups.push(marked);
  fs.mkdirSync(path.join(marked, ".git"));
  fs.writeFileSync(path.join(marked, "CLAUDE.md"), "mine\n");
  const asked = [];
  await runInit({ cwd: marked, env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") }, stdout: { write() {} }, execFn: (bin) => { if (bin === "claude") return "1.0"; throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: true, backend: "regex", ask: async (q) => (asked.push(q), "") });
  assert.deepEqual(asked.slice(0, 2).map((q) => q.split(/[?(]/)[0].trim()), ["Write the agents' files with rulesync", "Targets"]);
  const none = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-inityes-none-"));
  cleanups.push(none);
  fs.mkdirSync(path.join(none, ".git"));
  const askedNone = [];
  await runInit({ cwd: none, env: { XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") }, stdout: { write() {} }, execFn: () => { throw new Error("none"); }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, interactive: true, backend: "regex", ask: async (q) => (askedNone.push(q), "") });
  assert.ok(!askedNone.some((q) => /rulesync|Targets/.test(q)), "no signal, so no question");
});

test("a new question cannot appear without a test here: init has exactly the eight it has", () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const source = ["init.js", "initBridge.js"].map((name) => fs.readFileSync(path.join(src, name), "utf8")).join("\n");
  const sites = [...source.matchAll(/await ask\(/g)].length;
  // The seventh (the port, only with a holder toolgate did not start) is covered with --yes, a terminal, no terminal and --dry-run in init-port.test.js.
  // The eighth (installing rulesync, only when the project uses it and it is missing) is covered in init-rulesync.test.js.
  assert.equal(sites, 8, "init asks: add the new question to setup() above and to the --yes tests, then update this count");
});
