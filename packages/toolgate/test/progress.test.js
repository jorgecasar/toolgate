import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { progressFor } from "../src/cli.js";
import { describeLongStep, setProgress, withProgress } from "../src/progress.js";
import { SKIP_NO_PGREP } from "./support/skips.js";

const lines = () => {
  const out = [];
  return { out, write: (s) => out.push(s) };
};

test("only the slow qmd and git steps are described", () => {
  assert.match(describeLongStep("qmd", ["update"]), /updating the qmd index/);
  assert.match(describeLongStep("/usr/bin/qmd", ["embed", "-c", "x"]), /embedding.*the first run is the slowest/);
  assert.match(describeLongStep("qmd", ["collection", "add", "dir"]), /registering/);
  assert.match(describeLongStep("git", ["-c", "protocol.file.allow=never", "clone", "--", "u"]), /downloading a repository/);
  assert.equal(describeLongStep("qmd", ["collection", "show", "x"]), null);
  assert.equal(describeLongStep("qmd", ["query", "x"]), null);
  assert.equal(describeLongStep("git", ["rev-parse", "HEAD"]), null);
});

test("a long step is announced before it runs; nothing is said without a sink or for a short step", () => {
  const w = lines();
  assert.equal(withProgress("qmd", ["update"], () => "r"), "r");
  assert.deepEqual(w.out, []);
  setProgress({ stream: w });
  try {
    const order = [];
    assert.equal(withProgress("qmd", ["update"], () => (order.push(w.out.length), 7)), 7);
    assert.deepEqual(order, [1], "the line is out before the step starts");
    assert.match(w.out[0], /^toolgate: updating the qmd index; this can take a while\n$/);
    withProgress("qmd", ["collection", "show", "x"], () => 0);
    assert.equal(w.out.length, 1, "a short step says nothing");
    assert.throws(() => withProgress("git", ["clone"], () => { throw new Error("boom"); }), /boom/);
  } finally {
    setProgress(null);
  }
});

test("progressFor: --json, --dry-run and an agent launch say nothing; --yes, CI and a pipe get plain lines; a terminal animates", () => {
  const tty = { isTTY: true };
  const pipe = {};
  assert.equal(progressFor(["init", "--json"], { stderr: tty }), null);
  assert.equal(progressFor(["init", "--dry-run"], { stderr: tty }), null);
  assert.equal(progressFor(["claude-code", "hi"], { stderr: tty }), null);
  assert.equal(progressFor(["doctor"], { stderr: tty }), null);
  assert.deepEqual(progressFor(["init"], { stderr: tty, env: {} }), { stream: tty, animated: true });
  assert.equal(progressFor(["skills", "index"], { stderr: tty, env: {} }).animated, true);
  assert.equal(progressFor(["init", "--yes"], { stderr: tty, env: {} }).animated, false);
  assert.equal(progressFor(["init"], { stderr: tty, env: { CI: "true" } }).animated, false);
  assert.equal(progressFor(["init"], { stderr: pipe, env: {} }).animated, false);
  assert.ok(progressFor(["catalog", "build"], { stderr: pipe, env: {} }));
});

// The helper process prints on the real stderr, so it is checked in a child process.
function ticking(animated) {
  const script = `
    import { setProgress, withProgress } from ${JSON.stringify(new URL("../src/progress.js", import.meta.url).href)};
    setProgress({ stream: process.stderr, animated: ${animated}, intervalMs: 150 });
    withProgress("git", ["clone"], () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }).stderr;
}
test("while a step runs the helper shows a sign of life: plain lines in a pipe, one redrawn line in a terminal", () => {
  const plain = ticking(false);
  assert.match(plain, /toolgate: downloading a repository; this can take a while/);
  assert.match(plain, /still downloading a repository \(\d+s\)\n/);
  assert.doesNotMatch(plain, /[\r\x1b]/, "no cursor tricks");
  const animated = ticking(true);
  assert.match(animated, /\r\x1b\[K {2}downloading a repository\.\.\. \d+s/);
  assert.match(animated, /\r\x1b\[K$/, "the line is cleared when the step ends");
});

test("the helper does not outlive its parent: it exits within one interval after the parent is killed", { skip: SKIP_NO_PGREP }, async () => {
  const { spawn, execFileSync } = await import("node:child_process");
  const script = `
    import { setProgress, withProgress } from ${JSON.stringify(new URL("../src/progress.js", import.meta.url).href)};
    setProgress({ stream: process.stderr, animated: false, intervalMs: 150 });
    withProgress("git", ["clone"], () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000));
  `;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((resolve) => parent.stderr.once("data", resolve));
  const helpers = () => {
    try {
      return execFileSync("pgrep", ["-P", String(parent.pid)], { encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  // Wait for what we need to see instead of a fixed pause: the helper has started, and later it is gone.
  const until = async (done, ms) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline && !done(); ) await new Promise((resolve) => setTimeout(resolve, 25));
    return done();
  };
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await until(() => helpers().length > 0, 5000);
  const [helper] = helpers();
  assert.ok(helper, "the helper runs while the step runs");
  parent.kill("SIGKILL");
  await new Promise((resolve) => parent.once("exit", resolve));
  const alive = !(await until(() => !isAlive(Number(helper)), 2000));
  assert.equal(alive, false, "the helper is gone");
});
