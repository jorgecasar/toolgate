// Remote sources (#241): git never asks for a password, an abbreviated commit is explained, and a recommended source gets the
// same host check a lock source gets.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { fetchSource, gitEnv } from "../src/skills/remote.js";
import { loadRecommendations, shippedRecommendations, validateRecommendation } from "../src/skills/recommended.js";
import { git as hermeticGit } from "./support/git.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-rs-")));
  made.push(dir);
  return dir;
};
const SHA = "a".repeat(40);
const entry = (extra = {}) => ({ id: "o/r", source: "github:o/r", commit: SHA, license: "MIT", skills: ["a"], ...extra });
test("gitEnv: git and ssh never get a password helper, and still never prompt", () => {
  const env = gitEnv({ PATH: "/bin", GIT_ASKPASS: "/x/askpass", SSH_ASKPASS: "/x/ssh-askpass", SSH_ASKPASS_REQUIRE: "force", HOME: "/h" });
  assert.equal(Object.hasOwn(env, "GIT_ASKPASS"), false);
  assert.equal(Object.hasOwn(env, "SSH_ASKPASS"), false);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/h");
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
});
test("fetchSource: an abbreviated commit gets the message status --remote gives, not git's error; a real branch named like one still works", () => {
  const remote = tmp();
  const git = (...args) => hermeticGit(remote, ...args);
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(remote, "f"), "x");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const full = git("rev-parse", "HEAD").trim();
  git("branch", "deadbeef");
  const url = `file://${remote}`;
  for (const ref of [full.slice(0, 7), full.slice(0, 12), full.slice(0, 39)]) {
    assert.throws(() => fetchSource({ url, ref, cache: tmp(), allowFile: true }), { message: `"${ref}" looks like an abbreviated commit, which cannot be looked up upstream; use the full 40-character SHA` }, ref);
  }
  assert.equal(fetchSource({ url, ref: "deadbeef", cache: tmp(), allowFile: true }).commit, full, "a branch that exists is a branch");
  assert.throws(() => fetchSource({ url, ref: "no-such-branch", cache: tmp(), allowFile: true }), (err) => !/abbreviated/.test(err.message), "another missing ref keeps git's words");
});
test("fetchSource: a failure that is not a missing ref keeps git's words even when the ref looks like an abbreviated commit", () => {
  const fail = (stderr) => (bin, args) => {
    if (args.includes("clone") || args.includes("fetch")) throw Object.assign(new Error("Command failed: git"), { stderr });
    return "";
  };
  for (const stderr of ["fatal: unable to access 'https://x/': Could not resolve host: x", "fatal: Authentication failed for 'https://x/'", "fatal: write error: No space left on device"]) {
    assert.throws(() => fetchSource({ url: "https://x/o/r", ref: "abc1234", cache: tmp(), execFn: fail(stderr) }), (err) => !/abbreviated/.test(err.message) && err.stderr === stderr, stderr);
  }
  assert.throws(() => fetchSource({ url: "https://x/o/r", ref: "abc1234", cache: tmp(), execFn: fail("warning: Could not find remote branch abc1234 to clone.\nfatal: Remote branch abc1234 not found in upstream origin") }), /looks like an abbreviated commit/);
  assert.throws(() => fetchSource({ url: "https://x/o/r", ref: "abc1234", cache: tmp(), execFn: fail("fatal: couldn't find remote ref abc1234") }), /looks like an abbreviated commit/);
});
test("a recommended source goes through the host check of a lock source: refused with the same text, allowed with skills.allowedHosts", () => {
  const env = { HOME: tmp(), XDG_CONFIG_HOME: tmp() };
  const projectDir = tmp();
  for (const [source, reason] of [["https://127.0.0.1/o/r", "a loopback, private or link-local address"], ["https://10.0.0.5/o/r", "a loopback, private or link-local address"], ["https://localhost/o/r", "localhost"], ["https://[::1]/o/r", "a loopback, private or link-local address"]]) {
    assert.throws(() => validateRecommendation(entry({ source }), { projectDir, env }), (err) => err.message.includes(`is ${reason}: a lock file is not trusted to name it; to allow it, add the host to "skills.allowedHosts" in your user or local config`), source);
    const warnings = [];
    const list = loadRecommendations([entry({ id: "p/q", source, layer: "project" }), entry({ id: "ok/ok", source: "github:ok/ok", layer: "project" })], [], { projectDir, env, warn: (m) => warnings.push(m) });
    assert.deepEqual(list.map((e) => e.id), ["ok/ok"], "the entry is left out and the rest of the list stays");
    assert.deepEqual(warnings, [`recommended skill p/q in the project config is ignored: its source host ${new URL(source).hostname.replace(/^\[|\]$/g, "")} is private`], source);
  }
  validateRecommendation(entry({ source: "https://github.com/o/r" }), { projectDir, env });
  validateRecommendation(entry({ source: "github:o/r" }), { projectDir, env });
  const userConfig = path.join(env.XDG_CONFIG_HOME, "toolgate", "config.json");
  fs.mkdirSync(path.dirname(userConfig), { recursive: true });
  fs.writeFileSync(userConfig, JSON.stringify({ skills: { allowedHosts: ["10.0.0.5"] } }));
  validateRecommendation(entry({ source: "https://10.0.0.5/o/r" }), { projectDir, env });
});
test("a project recommendation that reuses a shipped id is skipped with a warning, through the CLI too, and the list is still shown", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const shipped = shippedRecommendations()[0];
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ skills: { recommended: [{ ...shipped, source: "github:evil/skills" }] } }));
  const out = [];
  const err = [];
  const code = await run(["skills", "recommended"], { cwd, env: { HOME: tmp(), XDG_CONFIG_HOME: tmp() }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  assert.equal(code, 0, err.join(""));
  assert.match(err.join(""), new RegExp(`toolgate: recommended entry ${shipped.id.replace(/[/.]/g, "\\$&")} in the project config reuses a shipped id; skipped`));
  assert.ok(!out.join("").includes("evil/skills"), "the entry is not listed");
  assert.ok(out.join("").includes(shipped.id), "the shipped one is");
});
