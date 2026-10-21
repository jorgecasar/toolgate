// scripts/postinstall.sh (#274): the setup runs only in an interactive install of the main checkout. The four reasons to skip print one
// exact line and run nothing; with none of them the command runs. `TOOLGATE_SETUP_CMD` replaces `npm run setup` here, so no test touches
// the real HOME, a daemon or qmd. A terminal for the "runs" case comes from python3's pty module (the tests that need it skip without it).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "postinstall.sh");
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (label) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-postinstall-${label}-`)));
  made.push(dir);
  return dir;
};

const home = tmp("home");
const gitEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: gitEnv, stdio: "pipe" });
const main = tmp("main");
git(main, "init", "-q", "-b", "main");
git(main, "commit", "-q", "--allow-empty", "-m", "first");
const linked = path.join(tmp("wt"), "linked");
git(main, "worktree", "add", "-q", linked);
const plain = tmp("plain");

const line = (reason) => `toolgate setup skipped (${reason}); run npm run setup to do it\n`;
const baseEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: home, TOOLGATE_SETUP_CMD: "echo RAN", ...extra });
// No terminal: stdin and stdout are pipes.
const piped = (cwd, env) => spawnSync("sh", [SCRIPT], { cwd, env, encoding: "utf8" });
const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim();
const hasPython = python !== "" && spawnSync(python, ["-c", "import pty"]).status === 0;
// A terminal on both: the script runs under a pty.
const withTerminal = (cwd, env) =>
  spawnSync(python, ["-c", "import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(['/bin/sh', sys.argv[1]])))", SCRIPT], { cwd, env, encoding: "utf8" });
const terminalOpts = { skip: hasPython ? false : "python3 with pty is not available" };

test("CI set: skipped with the reason CI, nothing runs, exit 0", () => {
  for (const cwd of [main, linked, plain]) {
    const result = piped(cwd, baseEnv({ CI: "true" }));
    assert.deepEqual([result.status, result.stdout], [0, line("CI")], cwd);
  }
});

test("TOOLGATE_SKIP_SETUP set: skipped with its name as the reason; CI comes first", () => {
  assert.deepEqual(((r) => [r.status, r.stdout])(piped(main, baseEnv({ TOOLGATE_SKIP_SETUP: "1" }))), [0, line("TOOLGATE_SKIP_SETUP")]);
  assert.equal(piped(main, baseEnv({ TOOLGATE_SKIP_SETUP: "1", CI: "1" })).stdout, line("CI"));
});

test("a linked git worktree: skipped as git worktree, in a pipe or a terminal; the main checkout is not", { ...terminalOpts }, () => {
  assert.equal(piped(linked, baseEnv()).stdout, line("git worktree"), "before the terminal rule");
  assert.equal(withTerminal(linked, baseEnv()).stdout.replace(/\r/g, ""), line("git worktree"), "with a terminal too");
  const sub = path.join(linked, "sub");
  fs.mkdirSync(sub);
  assert.equal(piped(sub, baseEnv()).stdout, line("git worktree"), "from a sub-folder");
  assert.equal(piped(main, baseEnv()).stdout, line("not interactive"), "the main checkout goes on to the next rule");
});

test("no terminal on stdin or stdout: skipped as not interactive", { ...terminalOpts }, () => {
  assert.deepEqual(((r) => [r.status, r.stdout])(piped(main, baseEnv())), [0, line("not interactive")]);
  const stdoutOnly = spawnSync(python, ["-c", "import os, pty, sys; m, s = pty.openpty(); os.dup2(s, 0); os.execv('/bin/sh', ['sh', sys.argv[1]])", SCRIPT], { cwd: main, env: baseEnv(), encoding: "utf8" });
  assert.equal(stdoutOnly.stdout, line("not interactive"), "a terminal on stdin only");
  // A terminal on stdout only: the child's stdin is /dev/null. What it prints goes to the terminal, so the marker file shows whether the command ran.
  const marker = path.join(tmp("marker"), "ran");
  const script = "import os, pty, subprocess, sys; m, s = pty.openpty(); sys.exit(subprocess.run(['/bin/sh', sys.argv[1]], stdin=subprocess.DEVNULL, stdout=s).returncode)";
  const stdoutTerminal = spawnSync(python, ["-c", script, SCRIPT], { cwd: main, env: baseEnv({ TOOLGATE_SETUP_CMD: `touch ${marker}` }), encoding: "utf8" });
  assert.equal(stdoutTerminal.status, 0);
  assert.equal(fs.existsSync(marker), false, "a terminal on stdout only does not run the setup");
});

test("an interactive install of the main checkout, or outside git, runs the command", terminalOpts, () => {
  for (const cwd of [main, plain]) {
    const result = withTerminal(cwd, baseEnv());
    assert.equal(result.status, 0, cwd);
    assert.equal(result.stdout.replace(/\r/g, ""), "RAN\n", cwd);
  }
});

test("without git on the PATH the worktree rule does not apply", terminalOpts, () => {
  const empty = tmp("nogit");
  fs.symlinkSync("/bin/sh", path.join(empty, "sh"));
  const result = withTerminal(linked, { PATH: empty, HOME: home, TOOLGATE_SETUP_CMD: "echo RAN" });
  assert.equal(result.stdout.replace(/\r/g, ""), "RAN\n");
});

test("a command that fails does not fail the install", terminalOpts, () => {
  const result = withTerminal(main, baseEnv({ TOOLGATE_SETUP_CMD: "echo before; exit 3" }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout.replace(/\r/g, ""), "before\n");
});

test("the root postinstall calls the script and npm run setup is the default command", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT), "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts.postinstall, "sh scripts/postinstall.sh");
  assert.match(fs.readFileSync(SCRIPT, "utf8"), /\$\{TOOLGATE_SETUP_CMD:-npm run setup\}/);
});
