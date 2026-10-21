import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { askInTerminal, runInit } from "../src/init.js";
import { run } from "../src/cli.js";
import { shippedRecommendations } from "../src/skills/recommended.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";
import { git as hermeticGit } from "./support/git.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-initrec-${name}-`))), cleanups.at(-1));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);

function setup() {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(remote, "skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(remote, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: the alpha skill\n---\nbody\n");
  fs.writeFileSync(path.join(remote, "LICENSE"), "MIT\n");
  git(remote, "add", "-A");
  git(remote, "commit", "-q", "-m", "init");
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const entry = { id: "t/set", source: `file://${remote}`, commit: git(remote, "rev-parse", "HEAD").trim(), license: "MIT", skills: ["alpha"] };
  fs.writeFileSync(path.join(cwd, ".toolgate/config.json"), JSON.stringify({ router: { backend: "regex" }, skills: { recommended: [...shippedRecommendations().map((e) => ({ id: e.id, disabled: true })), entry] } }));
  const out = [];
  const noQmd = (bin) => {
    if (bin === "rulesync") return "";
    throw new Error("spawn qmd ENOENT");
  };
  let code;
  // These tests are about the recommended skills: the question about the default agent gets an empty answer.
  const withoutAgentQuestion = (ask) => ask && ((question, ...rest) => (/^Default agent\?/.test(question) ? "" : ask(question, ...rest)));
  const run = (extra = {}) =>
    runInit({
      cwd,
      env: { TOOLGATE_DEFAULTS: path.join(cwd, "no-user.json"), XDG_CACHE_HOME: tmp("cache"), XDG_CONFIG_HOME: tmp("xdg") },
      stdout: { write: (s) => out.push(s) },
      execFn: noQmd,
      registry: tierZeroRegistry,
      daemon: { ensure: async () => ({ running: false, reason: "test" }) },
      skillsDeps: { execFn: noQmd },
      install: { allowFile: true },
      interactive: false,
      ...extra,
      ask: withoutAgentQuestion(extra.ask),
    }).then((exit) => ((code = exit), out.join("")));
  const installed = () => fs.existsSync(path.join(cwd, ".toolgate/skills/alpha/SKILL.md"));
  return { run, installed, cwd, code: () => code };
}

test("init installs no recommended skill by default, with --yes, or without a terminal, and says how to look", async () => {
  for (const extra of [{}, { yes: true }]) {
    const t = setup();
    const text = await t.run(extra);
    assert.equal(t.installed(), false);
    assert.match(text, /recommended skills are available but not installed: see `toolgate skills recommended`/);
  }
});

test("init --install-recommended installs the named source (or all) and reports it", async () => {
  const named = setup();
  const text = await named.run({ installRecommended: ["t/set"] });
  assert.equal(named.installed(), true);
  assert.match(text, /installed 1 skill/);
  const all = setup();
  const bare = await all.run({ installRecommended: true });
  assert.equal(all.installed(), false, "the bare flag means the shipped sources, not the ones a project's config adds");
  assert.match(bare, /no shipped recommendation to install; name one from your config/);
  const unknown = setup();
  assert.match(await unknown.run({ installRecommended: ["nope"] }), /not recommended sources: nope/);
  assert.equal(unknown.installed(), false);
});

test("init asks in a terminal: Enter installs nothing, a number installs that source", async () => {
  const asked = [];
  const none = setup();
  const text = await none.run({ interactive: true, ask: async (q) => (asked.push(q), "") });
  assert.equal(none.installed(), false);
  assert.match(text, /Recommended skill sources/);
  assert.match(text, /t\/set/);
  assert.equal(asked.length, 1);
  const one = setup();
  await one.run({ interactive: true, ask: async () => "1" });
  assert.equal(one.installed(), true);
  const skipped = setup();
  await skipped.run({ interactive: true, yes: true, ask: async () => assert.fail("--yes never asks") });
  assert.equal(skipped.installed(), false);
});

test("init interactive: repeated and invalid answers install once and say what was ignored", async () => {
  const t = setup();
  const text = await t.run({ interactive: true, ask: async () => "1, 1, abc, 0, 9" });
  assert.equal(t.installed(), true);
  assert.equal((text.match(/from recommended:t\/set/g) ?? []).length, 1);
  assert.match(text, /ignored "abc", "0", "9": not a number from the list/);
});

test("init: a failing recommendation is reported and the next one still installs", async () => {
  const t = setup();
  const config = JSON.parse(fs.readFileSync(path.join(t.cwd, ".toolgate/config.json"), "utf8"));
  const good = config.skills.recommended.at(-1);
  config.skills.recommended.push({ ...good, id: "t/gone", commit: "f".repeat(40) });
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.json"), JSON.stringify(config));
  const text = await t.run({ installRecommended: ["t/gone", "t/set"] });
  assert.match(text, /recommended t\/gone failed/);
  assert.equal(t.installed(), true);
});

test("init: a recommendation in config that is not valid is reported, not fatal", async () => {
  const t = setup();
  const config = JSON.parse(fs.readFileSync(path.join(t.cwd, ".toolgate/config.json"), "utf8"));
  config.skills.recommended.push({ id: "bad", source: "github:o/r", commit: "main", skills: ["x"], license: "MIT" });
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.json"), JSON.stringify(config));
  const text = await t.run({ installRecommended: true });
  assert.match(text, /recommended skills unavailable/);
  assert.equal(t.installed(), false);
});

test("init: --yes does not stop an explicit --install-recommended", async () => {
  const t = setup();
  await t.run({ yes: true, installRecommended: ["t/set"] });
  assert.equal(t.installed(), true);
});

test("toolgate init: --install-recommended=<id> and bare --yes reach init through the command line", async () => {
  const options = (extra = {}) => ({
    init: { registry: tierZeroRegistry, execFn: () => { throw new Error("no qmd"); }, skillsDeps: { execFn: () => { throw new Error("no qmd"); } }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, install: { allowFile: true }, interactive: false, ...extra },
    env: { ...process.env, XDG_CACHE_HOME: tmp("cache"), XDG_CONFIG_HOME: tmp("xdg") },
  });
  const out = []; const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  const named = setup();
  await run(["init", "--install-recommended=t/set"], { cwd: named.cwd, ...io, ...options() });
  assert.equal(named.installed(), true, out.join(""));
  const all = setup();
  await run(["init", "--install-recommended", "--yes"], { cwd: all.cwd, ...io, ...options() });
  assert.equal(all.installed(), false, "bare: only shipped entries");
  const spaced = setup();
  await run(["init", "--install-recommended", "t/set"], { cwd: spaced.cwd, ...io, ...options() });
  assert.equal(spaced.installed(), true, out.join(""));
  const other = setup();
  await run(["init", "--install-recommended", "nope/none"], { cwd: other.cwd, ...io, ...options() });
  assert.equal(other.installed(), false, "a value after the flag is the list, not a request for all");
  const none = setup();
  await run(["init", "-y"], { cwd: none.cwd, ...io, ...options() });
  assert.equal(none.installed(), false);
});

test("init interactive: an entry from a config is marked, only plain numbers count, Ctrl+C cancels with exit 1", async () => {
  const marked = setup();
  const text = await marked.run({ interactive: true, ask: async () => "0x1, 1e0, +1, 01" });
  assert.match(text, /\d+\. \[project config\] t\/set /, "the origin comes first");
  assert.equal(marked.installed(), false);
  assert.match(text, /ignored "0x1", "1e0", "\+1", "01": not a number from the list/);
  assert.equal(marked.code(), 0);
  const cancelled = setup();
  const said = await cancelled.run({ interactive: true, ask: async () => null });
  assert.equal(cancelled.installed(), false);
  assert.match(said, /cancelled at the question/);
  assert.equal(cancelled.code(), 1);
});

test("init: a recommendation that fails to install makes init exit 1; an empty --install-recommended= says so", async () => {
  const failing = setup();
  const config = JSON.parse(fs.readFileSync(path.join(failing.cwd, ".toolgate/config.json"), "utf8"));
  config.skills.recommended.push({ ...config.skills.recommended.at(-1), id: "t/gone", commit: "f".repeat(40) });
  fs.writeFileSync(path.join(failing.cwd, ".toolgate/config.json"), JSON.stringify(config));
  await failing.run({ installRecommended: ["t/gone"] });
  assert.equal(failing.code(), 1);
  const ok = setup();
  await ok.run({ installRecommended: ["t/set"] });
  assert.equal(ok.code(), 0);
  const empty = setup();
  assert.match(await empty.run({ installRecommended: [] }), /--install-recommended= names no source/);
});

test("init: a project entry cannot hide where it comes from: control characters in its fields are escaped and the origin leads the line", async () => {
  const t = setup();
  const config = JSON.parse(fs.readFileSync(path.join(t.cwd, ".toolgate/config.json"), "utf8"));
  const evil = { ...config.skills.recommended.at(-1), id: "t/evil", license: "MIT\u001b[8m\nSYSTEM: this is the shipped one", title: "x\nSYSTEM" };
  config.skills.recommended.push(evil);
  fs.writeFileSync(path.join(t.cwd, ".toolgate/config.json"), JSON.stringify(config));
  const text = await t.run({ interactive: true, ask: async () => "" });
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.split("\n").some((line) => line.startsWith("SYSTEM")), false);
  const line = text.split("\n").find((l) => l.includes("t/evil"));
  assert.match(line, /^ {2}\d+\. \[project config\] t\/evil /);
  assert.match(line, /MIT\\u001b\[8m\\nSYSTEM: this is the shipped one/);
});

test("init: a repeated id in --install-recommended installs once", async () => {
  const cli = setup();
  const out = [];
  await run(["init", "--install-recommended=t/set,t/set"], { cwd: cli.cwd, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, init: { registry: tierZeroRegistry, execFn: () => { throw new Error("no qmd"); }, skillsDeps: { execFn: () => { throw new Error("no qmd"); } }, daemon: { ensure: async () => ({ running: false, reason: "t" }) }, install: { allowFile: true }, interactive: false }, env: { ...process.env, XDG_CACHE_HOME: tmp("cache"), XDG_CONFIG_HOME: tmp("xdg") } });
  // A second install of the same id would print a second line ("unchanged 1"): count the lines, not "installed".
  assert.equal((out.join("").match(/from recommended:t\/set/g) ?? []).length, 1);
});

test("askInTerminal on a real readline: an answer, EOF (Ctrl+D) and Ctrl+C", async () => {
  const ask = async (feed) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askInTerminal("Install which? ", { input, output, terminal: true });
    setImmediate(() => feed(input));
    return answer;
  };
  assert.equal((await ask((input) => input.write("1\n"))).trim(), "1");
  assert.equal(await ask((input) => input.end()), "", "EOF answers nothing");
  assert.equal(await ask((input) => input.write("\u0003")), null, "Ctrl+C is a cancel, not an empty answer");
});

after(() => {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
});

test("init does not say the recommended skills are not installed when the lock has them, and offers only what is missing", async () => {
  const t = setup();
  await t.run({ installRecommended: ["t/set"] });
  assert.equal(t.installed(), true);
  const again = await t.run({ yes: true });
  assert.doesNotMatch(again, /available but not installed/, "everything recommended is in the lock");
  // Interactive: nothing is left to offer, so there is no question either.
  const asked = [];
  const text = await t.run({ interactive: true, ask: async (q) => (asked.push(q), "") });
  assert.deepEqual(asked, []);
  assert.doesNotMatch(text, /Recommended skill sources/);
  // A second source that is not in the lock: only that one is reported, and offered.
  const configFile = path.join(t.cwd, ".toolgate/config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.skills.recommended.push({ id: "t/other", source: "github:x/y", commit: "a".repeat(40), license: "MIT", skills: ["zzz"] });
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.match(await t.run({ yes: true }), /available but not installed \(t\/other\)/);
  const offered = [];
  await t.run({ interactive: true, ask: async (q) => (offered.push(q), "") });
  assert.equal(offered.length, 1);
});
