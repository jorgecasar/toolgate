// The test helper for git does not read the machine's own git configuration.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "./support/git.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

test("a commit works with a global git config that requires a signature that cannot be made, because the helper's environment ignores it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-gh-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-gr-"));
  made.push(home, repo);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n");
  const run = (env, ...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const plain = { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  run(plain, "init", "-q");
  fs.writeFileSync(path.join(repo, "f"), "x");
  run(plain, "add", "f");
  assert.throws(() => run(plain, "commit", "-q", "-m", "x"), "the hostile config does break a commit that trusts the machine's config");
  assert.doesNotThrow(() => run({ ...gitEnv(), HOME: home }, "commit", "-q", "-m", "x"));
  assert.equal(gitEnv({ GIT_DIR: "/nowhere" }).GIT_DIR, "/nowhere");
  assert.equal(gitEnv().GIT_CONFIG_GLOBAL, "/dev/null");
});
test("git does not climb above the temporary directory, so a TMPDIR under a checkout does not make a plain directory a repository", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-gc-"));
  made.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv() });
  const tmpdir = path.join(repo, "t");
  const plain = path.join(tmpdir, "w");
  fs.mkdirSync(plain, { recursive: true });
  const probe = `import { git } from ${JSON.stringify(new URL("./support/git.js", import.meta.url).href)}; try { git(${JSON.stringify(plain)}, "rev-parse", "--git-dir"); console.log("repo") } catch { console.log("none") }`;
  const ask = (env) => execFileSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).trim();
  assert.equal(ask({ TMPDIR: tmpdir }), "none");
  assert.equal(gitEnv().GIT_CEILING_DIRECTORIES, os.tmpdir());
});
test("no test file runs git without the helper's environment (a hostile global git config must not fail the suite)", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const files = fs.readdirSync(here, { recursive: true }).filter((name) => name.endsWith(".js") && !["support/git.js", "git-hermetic.test.js"].includes(name.split(path.sep).join("/")));
  const raw = files.filter((name) => /(?:execFileSync|execFile|spawnSync|spawn|execSync|exec)\(\s*["'`]git["'`]/.test(fs.readFileSync(path.join(here, name), "utf8")));
  assert.deepEqual(raw, []);
});
