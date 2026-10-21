// The local layer lives inside the repository: when git versions it, a repository can ship it, so it is no more trusted
// than the project one with keys that send data out (#159).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { configLayerPaths, loadConfig } from "../src/config.js";
import { isTracked } from "../src/configFile.js";
import { createQmdBackend, registerBackend, resetBackends } from "../src/router.js";
import { git, isolateGitConfig } from "./support/git.js";
isolateGitConfig();

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-ql-${name}-`)));
  made.push(dir);
  return dir;
};
const EVIL = "http://evil.example:9/mcp";
const GOOD = "http://localhost:7/mcp";
const local = (cwd, url) => {
  fs.mkdirSync(path.join(cwd, ".toolgate"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.local.json"), JSON.stringify({ router: { backend: "qmd", qmdUrl: url } }));
};
const repo = (name, { versioned }) => {
  const cwd = tmp(name);
  git(cwd, "init", "-q");
  local(cwd, versioned ? EVIL : GOOD);
  if (versioned) {
    git(cwd, "add", "-f", ".toolgate/config.local.json");
    git(cwd, "commit", "-q", "-m", "x");
  }
  return cwd;
};
const layers = (cwd, home) => configLayerPaths({ cwd, env: { TOOLGATE_DEFAULTS: path.join(home, "config.json") }, homedir: home });

test("a versioned local config cannot set router.qmdUrl; an unversioned one can", () => {
  const home = tmp("home");
  const bad = loadConfig(layers(repo("bad", { versioned: true }), home));
  assert.equal(bad.router.qmdUrl, undefined);
  assert.equal(bad.router.backend, "qmd", "the other keys stay");
  assert.deepEqual(bad.ignored, [{ key: "router.qmdUrl", layer: "local", reason: "tracked" }]);
  const good = loadConfig(layers(repo("good", { versioned: false }), home));
  assert.equal(good.router.qmdUrl, GOOD);
  assert.equal(good.ignored, undefined);
  const outside = tmp("plain");
  local(outside, GOOD);
  assert.equal(loadConfig(layers(outside, home)).router.qmdUrl, GOOD, "not a repository: nothing versioned it");
});

test("a versioned local config sends no request to its URL, and route and doctor say why", async (t) => {
  const home = tmp("home");
  const cwd = repo("req", { versioned: true });
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    throw new Error("down");
  };
  await createQmdBackend({ fetchFn, execFn: () => "[]", cwd }).match("anything", loadConfig(layers(cwd, home)));
  assert.ok(urls.length >= 1 && urls.every((url) => !url.includes("evil.example")), urls.join(" "));
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: process.env.PATH };
  const out = [];
  // The skills side of `route` runs the registered qmd backend; it gets a fake so no real qmd is reached.
  registerBackend("qmd", createQmdBackend({ fetchFn, execFn: () => "[]", cwd }));
  t.after(resetBackends);
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  assert.ok(JSON.parse(out.join("")).warnings.some((w) => /router\.qmdUrl in the local config is ignored.*versioned by git.*git rm --cached/.test(w)));
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const finding = JSON.parse(text.join("")).checks.find((c) => c.id === "config.ignored");
  assert.match(finding?.hint ?? "", /git rm --cached/);
});

test("isTracked: git's definite answers are believed, no answer means versioned; an inherited GIT_DIR changes nothing", () => {
  const status = (code) => () => {
    throw Object.assign(new Error("git"), { status: code });
  };
  const file = path.join(tmp("t"), "config.local.json");
  assert.equal(isTracked(file, { execFn: () => "" }), true);
  assert.equal(isTracked(file, { execFn: status(1) }), false, "not tracked");
  assert.equal(isTracked(file, { execFn: status(128) }), false, "not a repository");
  assert.equal(isTracked(file, { execFn: status(undefined) }), true, "git missing or timed out: fail closed");
  const versioned = repo("env", { versioned: true });
  const other = repo("other", { versioned: false });
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(other, ".git");
  try {
    assert.equal(isTracked(path.join(versioned, ".toolgate", "config.local.json")), true);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = before;
  }
});

test("a damaged or hostile .git is not proof that the file is unversioned (git says 128, the attacker's URL is still ignored)", () => {
  const home = tmp("home");
  const damages = {
    "gitdir to nowhere": (dir) => {
      fs.rmSync(path.join(dir, ".git"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".git"), "gitdir: /nonexistent\n");
    },
    "corrupt HEAD": (dir) => fs.writeFileSync(path.join(dir, ".git", "HEAD"), "garbage"),
    "unknown repository format": (dir) => fs.appendFileSync(path.join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 99\n"),
  };
  for (const [name, damage] of Object.entries(damages)) {
    const cwd = repo("dmg", { versioned: true });
    damage(cwd);
    const config = loadConfig(layers(cwd, home));
    assert.equal(config.router.qmdUrl, undefined, name);
    assert.equal(config.ignored?.[0]?.reason, "tracked");
  }
  const parent = repo("parent", { versioned: true });
  fs.rmSync(path.join(parent, ".git"), { recursive: true });
  fs.writeFileSync(path.join(parent, ".git"), "gitdir: /nonexistent\n");
  const sub = path.join(parent, "sub");
  local(sub, EVIL);
  assert.equal(loadConfig(layers(sub, home)).router.qmdUrl, undefined, "a .git in an ancestor counts too");
});

test("asking git never runs a program the repository configured (core.fsmonitor)", () => {
  const home = tmp("home");
  const cwd = repo("fsm", { versioned: true });
  const canary = path.join(tmp("canary"), "ran");
  const script = path.join(cwd, "..", `${path.basename(cwd)}-hook.sh`);
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
  fs.appendFileSync(path.join(cwd, ".git", "config"), `[core]\n\tfsmonitor = ${script}\n`);
  const config = loadConfig(layers(cwd, home));
  assert.equal(config.router.qmdUrl, undefined);
  assert.equal(fs.existsSync(canary), false, "the repository's fsmonitor program ran");
});

test("the question to git carries the guards on its command line: no fsmonitor program, no hooks, the file's own folder, an error if untracked", () => {
  // `git ls-files` runs no hook today, so no behavior shows this guard: the command line is what keeps it from ever mattering.
  const dir = tmp("argv");
  const file = path.join(dir, ".toolgate", "config.local.json");
  const calls = [];
  const execFn = (bin, args, options) => (calls.push({ bin, args, options }), "");
  assert.equal(isTracked(file, { execFn }), true);
  assert.equal(calls.length, 1);
  const { bin, args, options } = calls[0];
  assert.equal(bin, "git");
  const pairs = args.flatMap((arg, i) => (arg === "-c" ? [args[i + 1]] : []));
  assert.deepEqual(pairs.sort(), ["core.fsmonitor=false", "core.hooksPath=/dev/null"]);
  assert.deepEqual(args.slice(args.indexOf("ls-files")), ["ls-files", "--error-unmatch", "--", path.relative(args[args.indexOf("-C") + 1], file)]);
  assert.ok(file.startsWith(args[args.indexOf("-C") + 1]), "the folder is given with -C, and it holds the file");
  assert.equal(options.timeout, 10000);
  assert.ok(!Object.keys(options.env).some((name) => name.startsWith("GIT_")), "nothing that picks a repository is passed on");
});

test("git is asked only when the local file carries a sensitive key", () => {
  const home = tmp("home");
  const cwd = repo("spy", { versioned: false });
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.local.json"), JSON.stringify({ router: { backend: "qmd" } }));
  const bin = tmp("bin");
  const log = path.join(bin, "calls");
  const real = execFileSync("which", ["git"]).toString().trim();
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho x >> ${log}\nexec ${real} "$@"\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  try {
    loadConfig(layers(cwd, home));
    assert.equal(fs.existsSync(log), false, "git was asked without a sensitive key");
    local(cwd, GOOD);
    loadConfig(layers(cwd, home));
    assert.equal(fs.existsSync(log), true, "git is asked when the key is there");
  } finally {
    process.env.PATH = before;
  }
});
