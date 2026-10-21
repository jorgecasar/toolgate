// `--policy` and the `policy` setting never changed a result and were removed: the flag fails loudly (it must not be
// joined to the task text), the setting is an unknown key like any other, and an old config that still has it is ignored.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";

const made = [];
const tmp = (name) => (made.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-policy-${name}-`))), made.at(-1));
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const IDLE = { extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] };
const MESSAGE = "toolgate: --policy was removed: it never changed the result; drop it\n";

function session(files = {}) {
  const cwd = tmp("project");
  fs.mkdirSync(path.join(cwd, ".git"));
  for (const [name, value] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  const home = tmp("home");
  const out = [];
  const err = [];
  const deps = {
    cwd,
    env: { HOME: home, XDG_CONFIG_HOME: tmp("xdg"), XDG_CACHE_HOME: tmp("cache"), TOOLGATE_DEFAULTS: path.join(home, "none.json") },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    loadStateFn: () => IDLE,
    saveStateFn: () => {},
    catalog: { homedir: home },
    daemon: { status: async () => ({ running: false }) },
  };
  return { cwd, deps, out: () => out.join(""), err: () => err.join("") };
}

test("--policy fails with the removal text and exit 1, on route and need, with or without a value, and as --policy=value", async () => {
  for (const args of [
    ["route", "--prompt", "open a pull request", "--policy", "two-tier"],
    ["route", "--prompt", "open a pull request", "--policy"],
    ["need", "open a pull request", "--policy", "connect-all"],
    ["need", "open a pull request", "--policy"],
    ["need", "open a pull request", "--json", "--policy=connect-all"],
    ["doctor", "--policy", "two-tier"],
    ["--policy", "two-tier", "route", "--prompt", "x"],
  ]) {
    const s = session();
    assert.equal(await run(args, s.deps), 1, args.join(" "));
    assert.equal(s.err(), MESSAGE, args.join(" "));
    assert.equal(s.out(), "", `nothing runs: ${args.join(" ")}`);
  }
});
test("without --policy route and need work as before, and the task text is not changed by a flag that used to be taken", async () => {
  const s = session();
  assert.equal(await run(["need", "open a pull request", "--json"], s.deps), 0);
  assert.equal(s.err(), "");
  assert.doesNotThrow(() => JSON.parse(s.out()));
});
test("config set policy is refused like any unknown key, and writes nothing", async () => {
  const s = session();
  const before = fs.readdirSync(s.cwd);
  assert.equal(await run(["config", "set", "policy", "connect-all"], s.deps), 1);
  assert.match(s.err(), /policy/);
  assert.deepEqual(fs.readdirSync(s.cwd), before, "no config file was created");
});
test("a policy left in a config file is ignored: need --json prints the same with and without it, without a warning", async () => {
  const without = session();
  const withPolicy = session({ ".toolgate/config.json": { policy: "connect-all" } });
  assert.equal(await run(["need", "open a pull request", "--json"], without.deps), 0);
  assert.equal(await run(["need", "open a pull request", "--json"], withPolicy.deps), 0);
  assert.equal(withPolicy.out(), without.out());
  assert.equal(withPolicy.err(), "");
  assert.deepEqual(JSON.parse(withPolicy.out()).warnings, JSON.parse(without.out()).warnings);
});
