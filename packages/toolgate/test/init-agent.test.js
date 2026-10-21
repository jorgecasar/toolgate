import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/init.js";
import { run } from "../src/cli.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-initagent-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

const noQmd = (bin) => {
  if (bin === "rulesync") return "";
  throw new Error("spawn qmd ENOENT");
};
// `codex` is the one agent the tier-zero registry can detect.
const withCodex = (bin) => {
  if (bin === "rulesync") return "";
  if (bin !== "codex") throw new Error(`${bin}: not found`);
  return "codex 1.0";
};

function setup({ files = {} } = {}) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(cwd, ".toolgate", name), JSON.stringify(value));
  const xdg = tmp("xdg");
  const env = { XDG_CONFIG_HOME: xdg, XDG_CACHE_HOME: tmp("cache"), HOME: tmp("home") };
  const out = [];
  const init = (extra = {}) =>
    runInit({
      cwd,
      env,
      stdout: { write: (s) => out.push(s) },
      execFn: noQmd,
      registry: tierZeroRegistry,
      daemon: { ensure: async () => ({ running: false, reason: "test" }) },
      skillsDeps: { execFn: noQmd },
      interactive: false,
      targets: ["claudecode"],
      ...extra,
      // These tests are about the agent: the question about installing qmd gets "no".
      ask: extra.ask && ((question, ...rest) => (/^qmd was not found/.test(question) ? "n" : extra.ask(question, ...rest))),
    }).then((code) => ({ code, text: out.join("") }));
  const read = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
  const localFile = path.join(cwd, ".toolgate/config.local.json");
  const userFile = path.join(xdg, "toolgate/config.json");
  return { cwd, env, init, out: () => out.join(""), read, localFile, userFile };
}

const bothRegistry = { has: (name) => name === "codex" || name === "claude-code", get: tierZeroRegistry.get };
const withBoth = (bin) => {
  if (bin === "rulesync") return "";
  if (bin !== "codex" && bin !== "claude") throw new Error(`${bin}: not found`);
  return `${bin} 1.0`;
};

test("init --yes or without a terminal never asks: it lists every agent, sets the first installed one in the fixed order and says how to change it", async () => {
  for (const extra of [{}, { yes: true }, { yes: true, interactive: true }]) {
    const t = setup();
    const asked = [];
    const { code, text } = await t.init({ ...extra, execFn: withCodex, ask: async (q) => (asked.push(q), "") });
    assert.equal(code, 0);
    assert.deepEqual(asked, []);
    assert.deepEqual(t.read(t.localFile), { defaultAgent: "codex" });
    assert.equal(fs.existsSync(t.userFile), false);
    assert.match(text, /set defaultAgent codex in the local config/);
    assert.match(text, / {2}1\. claude-code {2}\(not installed\)\n {2}2\. codex {2}\(installed, tier 0\) {2}<- default\n {2}3\. opencode {2}\(not installed\)/);
    assert.match(text, /karajan {2}\(not installed\)/);
    assert.match(text, /change it with `toolgate config set defaultAgent <name> --local`/);
  }
  // Several installed: the order decides, not the machine's luck.
  const both = setup();
  await both.init({ yes: true, execFn: withBoth, registry: bothRegistry });
  assert.deepEqual(both.read(both.localFile), { defaultAgent: "claude-code" });
  // Second run: nothing changes.
  const before = fs.readFileSync(both.localFile, "utf8");
  const second = await both.init({ yes: true, execFn: withBoth, registry: bothRegistry });
  assert.equal(fs.readFileSync(both.localFile, "utf8"), before);
  assert.match(second.text, /default agent: claude-code \(from the local config\)/);
  // --user goes to the user layer.
  const user = setup();
  await user.init({ yes: true, user: true, execFn: withCodex });
  assert.deepEqual(user.read(user.userFile), { defaultAgent: "codex" });
  assert.equal(fs.existsSync(user.localFile), false);
  // --dry-run writes nothing.
  const dry = setup();
  assert.match((await dry.init({ yes: true, dryRun: true, execFn: withCodex })).text, /would set defaultAgent codex/);
  assert.equal(fs.existsSync(dry.localFile), false);
  // Nothing installed: nothing is set, and the output says so.
  const none = setup();
  const { text } = await none.init({ yes: true });
  assert.equal(fs.existsSync(none.localFile), false);
  assert.match(text, /no agent was found installed[\s\S]*toolgate config set defaultAgent <name> --local/);
});

test("init --agent writes the local layer without asking, also with --yes, and config print shows it", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ agent: "claude-code", yes: true, interactive: true, ask: async (q) => (asked.push(q), "") });
  assert.equal(code, 0);
  assert.deepEqual(asked, []);
  assert.deepEqual(t.read(t.localFile), { defaultAgent: "claude-code" });
  assert.match(text, /set defaultAgent claude-code in the local config \(\.toolgate\/config\.local\.json\)/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.cwd, ".toolgate/config.json"), "utf8")).defaultAgent, undefined, "never the project layer");
  assert.match(fs.readFileSync(path.join(t.cwd, ".gitignore"), "utf8"), /\.toolgate\/config\.local\.json/, "the file is ignored");
  const out = [];
  assert.equal(await run(["config", "print", "--json"], { cwd: t.cwd, env: t.env, stdout: { write: (s) => out.push(s) }, stderr: { write() {} } }), 0);
  const printed = JSON.parse(out.join(""));
  assert.equal(printed.config.defaultAgent, "claude-code");
  assert.deepEqual(printed.origins.defaultAgent, ["local"]);
});

test("init --agent --user writes the user layer, never the project or the local one", async () => {
  const t = setup();
  await t.init({ agent: "codex", user: true });
  assert.deepEqual(t.read(t.userFile), { defaultAgent: "codex" });
  assert.equal(fs.existsSync(t.localFile), false);
  assert.equal(t.read(t.cwd, ".toolgate/config.json").defaultAgent, undefined);
});

test("init --agent with an unknown name exits 1, lists the valid ones and writes nothing at all", async () => {
  const t = setup();
  fs.rmSync(path.join(t.cwd, ".toolgate"), { recursive: true });
  const { code, text } = await t.init({ agent: "emacs" });
  assert.equal(code, 1);
  assert.match(text, /unknown agent "emacs"; use one of: claude-code/);
  assert.deepEqual(fs.readdirSync(t.cwd), [".git"], "not even the config or .gitignore was created");
});

test("init leaves a default agent of the user's own layers alone, says where it comes from and does not ask", async () => {
  const t = setup({ files: { "config.local.json": { defaultAgent: "opencode" } } });
  const asked = [];
  const { text } = await t.init({ agent: "codex", interactive: true, execFn: withCodex, ask: async (q) => (asked.push(q), "") });
  assert.deepEqual(asked.filter((q) => /^Default agent/.test(q)), []);
  assert.match(text, /default agent: opencode \(from the local config\)/);
  assert.match(text, /--agent codex was not applied/);
  assert.equal(t.read(t.cwd, ".toolgate", "config.local.json").defaultAgent, "opencode");
  assert.equal(fs.existsSync(t.userFile), false);
});

test("a default agent from the project config is asked about in a terminal: Enter keeps it, a number or name overrides it in the local layer only", async () => {
  const project = { defaultAgent: "opencode" };
  const keep = setup({ files: { "config.json": project } });
  const asked = [];
  const kept = await keep.init({ interactive: true, execFn: withCodex, ask: async (q) => (asked.push(q), "") });
  const question = asked.find((q) => /^Default agent/.test(q));
  assert.equal(question, "Default agent? (number or name, Enter to keep opencode): ");
  assert.match(kept.text, /3\. opencode .*<- project default/);
  assert.match(kept.text, /default agent: opencode \(from the project config\)/);
  assert.equal(fs.existsSync(keep.localFile), false, "keeping it writes nothing");
  for (const answer of ["2", "codex"]) {
    const t = setup({ files: { "config.json": project } });
    const { text } = await t.init({ interactive: true, execFn: withCodex, ask: async () => answer });
    assert.deepEqual(t.read(t.localFile), { defaultAgent: "codex" }, answer);
    assert.match(text, /set defaultAgent codex in the local config .*, over the project's opencode/);
    assert.equal(t.read(t.cwd, ".toolgate", "config.json").defaultAgent, "opencode", "the project's file is never written");
  }
  const same = setup({ files: { "config.json": project } });
  await same.init({ interactive: true, execFn: withCodex, ask: async () => "opencode" });
  assert.equal(fs.existsSync(same.localFile), false, "choosing the project's own value writes nothing");
});

test("a project default agent: --yes and no terminal keep it without asking; --agent overrides it; Ctrl+C exits 1 and changes nothing; a second run does not ask once overridden", async () => {
  const project = { defaultAgent: "opencode" };
  for (const extra of [{ yes: true, interactive: true }, { interactive: false }]) {
    const t = setup({ files: { "config.json": project } });
    const asked = [];
    const { text } = await t.init({ ...extra, execFn: withCodex, ask: async (q) => (asked.push(q), "") });
    assert.deepEqual(asked.filter((q) => /^Default agent/.test(q)), []);
    assert.match(text, /default agent: opencode \(from the project config\)/);
    assert.equal(fs.existsSync(t.localFile), false);
  }
  const flagged = setup({ files: { "config.json": project } });
  const result = await flagged.init({ agent: "codex", yes: true, execFn: withCodex });
  assert.deepEqual(flagged.read(flagged.localFile), { defaultAgent: "codex" });
  assert.match(result.text, /over the project's opencode/);
  const same = setup({ files: { "config.json": project } });
  await same.init({ agent: "opencode", yes: true, execFn: withCodex });
  assert.equal(fs.existsSync(same.localFile), false, "--agent with the project's own value writes nothing");
  const cancelled = setup({ files: { "config.json": project } });
  const { code, text } = await cancelled.init({ interactive: true, execFn: withCodex, ask: async () => null });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(cancelled.localFile), false);
  assert.match(text, /the default agent was not changed/);
  const again = setup({ files: { "config.json": project } });
  const asked = [];
  const ask = async (q) => (asked.push(q), "codex");
  await again.init({ interactive: true, execFn: withCodex, ask });
  await again.init({ interactive: true, execFn: withCodex, ask });
  assert.equal(asked.filter((q) => /^Default agent/.test(q)).length, 1, "once it is overridden locally, it is the user's own");
});

test("with a single installed agent and no project default there is nothing to choose: it is set without asking, in a terminal too", async () => {
  const t = setup();
  const asked = [];
  const { text } = await t.init({ interactive: true, execFn: withCodex, ask: async (q) => (asked.push(q), "") });
  assert.deepEqual(asked.filter((q) => /^Default agent/.test(q)), []);
  assert.deepEqual(t.read(t.localFile), { defaultAgent: "codex" });
  assert.match(text, /set defaultAgent codex in the local config/);
});

test("init asks in a terminal when several agents are installed: every agent in the fixed order, Enter takes the first installed one, a number or a name picks, anything else is ignored", async () => {
  const both = { execFn: withBoth, registry: bothRegistry, interactive: true };
  const one = setup();
  const questions = [];
  const { text } = await one.init({ ...both, ask: async (q) => (questions.push(q), "") });
  assert.match(text, /Default agent[\s\S]*1\. claude-code {2}\(installed, tier 0\) {2}<- default\n {2}2\. codex {2}\(installed, tier 0\)/, "the fixed order, installed or not");
  assert.match(questions[0], /^Default agent\? \(number or name, Enter to use claude-code\)/);
  assert.deepEqual(one.read(one.localFile), { defaultAgent: "claude-code" });

  const skip = setup();
  const skipped = await skip.init({ interactive: true, ask: async (q) => (/^Default agent/.test(q) ? "" : "") });
  assert.equal(fs.existsSync(skip.localFile), false, "no agent detected: Enter skips and writes nothing");
  assert.match(skipped.text, /no default agent|Default agent/);

  for (const [answer, expected] of [["2", "codex"], ["opencode", "opencode"]]) {
    const t = setup();
    await t.init({ ...both, ask: async () => answer });
    assert.equal(t.read(t.localFile).defaultAgent, expected, answer);
  }
  for (const answer of ["99", "0", "emacs", "1e0"]) {
    const t = setup();
    const { text: said } = await t.init({ ...both, ask: async () => answer });
    assert.equal(fs.existsSync(t.localFile), false, answer);
    assert.match(said, new RegExp(`ignored "${answer}": not an agent of the list`));
  }
});

test("init: Ctrl+C at the agent question writes nothing, exits 1 and asks nothing else", async () => {
  const t = setup();
  const asked = [];
  const { code, text } = await t.init({ interactive: true, execFn: withBoth, registry: bothRegistry, ask: async (q) => (asked.push(q), null) });
  assert.equal(code, 1);
  assert.equal(asked.length, 1);
  assert.equal(fs.existsSync(t.localFile), false);
  assert.match(text, /cancelled at the question: no default agent was set/);
});

test("init: a second run does not ask again", async () => {
  const t = setup();
  const asked = [];
  const ask = async (q) => (asked.push(q), "claude-code");
  await t.init({ interactive: true, ask });
  assert.equal(asked.filter((q) => /^Default agent/.test(q)).length, 1);
  await t.init({ interactive: true, ask });
  assert.equal(asked.filter((q) => /^Default agent/.test(q)).length, 1, "the answer is already there");
  assert.equal(t.read(t.localFile).defaultAgent, "claude-code");
});

test("init is deterministic: two runs from scratch with the same --agent give the same files and the same output", async () => {
  const snapshot = async () => {
    const t = setup();
    const { code, text } = await t.init({ agent: "claude-code", execFn: withCodex });
    const files = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, entry.name);
        if (entry.name === ".git") continue;
        if (entry.isDirectory()) walk(full);
        else files[path.relative(t.cwd, full)] = fs.readFileSync(full, "utf8");
      }
    };
    walk(t.cwd);
    return { code, text: text.split(t.cwd).join("<project>"), files };
  };
  const [first, second] = [await snapshot(), await snapshot()];
  assert.deepEqual(second, first);
  assert.equal(first.files[".toolgate/config.local.json"].includes("claude-code"), true);
});

test("listAgents orders every registered agent by AGENT_ORDER and marks installed, not installed and not detectable (only an agent with no binary)", async () => {
  const { listAgents, AGENT_ORDER } = await import("../src/agentReport.js");
  const list = listAgents(["karajan", "zeta", "codex", "claude-code", "opencode", "antigravity"], [{ name: "codex", tier: 2 }]);
  assert.deepEqual(list.map((e) => e.name), [...AGENT_ORDER, "zeta"]);
  assert.deepEqual(list.map((e) => e.status), ["not installed", "installed", "not installed", "not installed", "not installed", "not detectable"]);
  assert.equal(list[1].tier, 2);
});

test("the run that sets the default and a re-run both mark it in the list of agents found, in the fixed order, and the heading no longer says nothing is configured", async () => {
  const t = setup();
  const first = await t.init({ yes: true, execFn: withBoth, registry: bothRegistry });
  const firstBlock = first.text.split("Found on this machine")[1].split("\n\n")[0];
  assert.match(firstBlock, /^ \(informational, only the default agent is configured\):/, "the run that sets it already says so");
  assert.match(firstBlock, /claude-code: tier \d[^\n]*  <- default/);
  assert.doesNotMatch(first.text, /nothing is configured for it/);
  const again = await t.init({ yes: true, execFn: withBoth, registry: bothRegistry });
  again.text = again.text.slice(first.text.length);
  const block = again.text.split("Found on this machine")[1].split("\n\n")[0];
  assert.match(block, /^ \(informational, only the default agent is configured\):/);
  assert.match(block, /claude-code: tier \d[^\n]*  <- default/);
  assert.doesNotMatch(block.replace(/claude-code[^\n]*/, ""), /<- default/, "only one agent is marked");
  assert.ok(block.indexOf("claude-code:") < block.indexOf("codex:"), "the fixed order");
  assert.doesNotMatch(again.text, /nothing is configured for it/);
});

test("a default agent that is not installed or not known is shown as such, not silently marked", async () => {
  for (const [name, expected] of [["opencode", /opencode {2}<- default, but not installed here/], ["emacs", /emacs {2}<- default, but not an agent toolgate knows/]]) {
    const t = setup({ files: { "config.local.json": { defaultAgent: name } } });
    const { text } = await t.init({ yes: true, execFn: withCodex });
    const block = text.split("Found on this machine")[1].split("\n\n")[0];
    assert.match(block, expected);
    assert.doesNotMatch(block, /codex: tier \d[^\n]*<- default/);
  }
});

test("the agents found follow AGENT_ORDER (opencode before antigravity) once a default is set, on the run that sets it and on a re-run", async () => {
  const all = { has: (name) => ["claude-code", "codex", "opencode", "antigravity"].includes(name), get: tierZeroRegistry.get };
  const everything = (bin) => (["claude", "codex", "opencode", "agy"].includes(bin) ? `${bin} 1.0` : (() => { throw new Error("not found"); })());
  const t = setup();
  const first = await t.init({ yes: true, agent: "codex", execFn: everything, registry: all });
  const names = (text) => [...text.split("Found on this machine")[1].split("\n\n")[0].matchAll(/^ {2}(claude-code|codex|opencode|antigravity):/gm)].map((m) => m[1]);
  assert.deepEqual(names(first.text), ["claude-code", "codex", "opencode", "antigravity"], "the run that sets the default already follows the order");
  const again = await t.init({ yes: true, execFn: everything, registry: all });
  assert.deepEqual(names(again.text.slice(first.text.length)), ["claude-code", "codex", "opencode", "antigravity"]);
});

test("karajan is detected through its kj binary: installed when kj works, not installed when it does not, and it can be the default", async () => {
  const { AGENT_BINS } = await import("../src/agentReport.js");
  assert.equal(AGENT_BINS.karajan, "kj");
  const karajanRegistry = { has: (name) => name === "karajan", get: tierZeroRegistry.get };
  const withKj = (bin) => {
    if (bin !== "kj") throw new Error(`${bin}: not found`);
    return "kj 4.51.1";
  };
  const found = setup();
  const yes = await found.init({ yes: true, execFn: withKj, registry: karajanRegistry });
  assert.match(yes.text, /karajan {2}\(installed, tier 0\) {2}<- default/);
  assert.deepEqual(found.read(found.localFile), { defaultAgent: "karajan" });
  const missing = setup();
  const none = await missing.init({ yes: true, execFn: noQmd, registry: karajanRegistry });
  assert.match(none.text, /karajan {2}\(not installed\)/);
  assert.doesNotMatch(none.text, /not detectable/);
  assert.equal(fs.existsSync(missing.localFile), false);
});
