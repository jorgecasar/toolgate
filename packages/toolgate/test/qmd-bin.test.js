// qmd.bin (#136): every call to qmd goes to the program the user chose, and it runs without a shell.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureQmdDaemon, run } from "../src/cli.js";
import { qmdBinOf, stopDaemon } from "../src/daemon.js";
import { restartDaemon } from "../src/daemonFreshness.js";
import { detect, runInit } from "../src/init.js";
import { checkDaemon, checkQmd } from "../src/doctor/checks.js";
import { createQmdBackend, registerBackend, resetBackends, route } from "../src/router.js";
import { settings } from "../src/skills/cli.js";
import { searchSkills } from "../src/skills/search.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qbin-")));
  made.push(dir);
  return dir;
};
const BIN = path.resolve("/opt/qmd/bin/qmd");
const config = { qmd: { bin: BIN } };
const recorder = () => {
  const calls = [];
  return { calls, execFn: (bin, args) => (calls.push([bin, ...args]), "") };
};
test("qmdBinOf: the chosen program, else qmd", () => {
  assert.equal(qmdBinOf(config), BIN);
  assert.equal(qmdBinOf({}), "qmd");
  assert.equal(qmdBinOf(undefined), "qmd");
});
test("the daemon commands and the launch hand the chosen program to start, stop and restart", async () => {
  const seen = [];
  const daemon = {
    status: async () => ({ running: false }),
    ensure: async (opts) => (seen.push(["ensure", opts.qmdBin]), { running: true, started: true, url: "u" }),
    stop: (opts) => (seen.push(["stop", opts?.qmdBin]), { ok: true, message: "stopped" }),
    holder: () => ({ pid: null, foreign: null }),
    sleep: async () => {},
  };
  const cwd = tmp();
  const user = path.join(tmp(), "config.json");
  fs.writeFileSync(user, JSON.stringify(config));
  const env = { TOOLGATE_DEFAULTS: user, QMD_SHARED_PORT: "18299" };
  const quiet = { write: () => {} };
  for (const action of ["start", "stop", "restart"]) await run(["daemon", action], { cwd, env, stdout: quiet, stderr: quiet, daemon });
  assert.deepEqual(seen, [["ensure", BIN], ["stop", BIN], ["stop", BIN], ["ensure", BIN]]);
  seen.length = 0;
  await ensureQmdDaemon({ config: { router: { backend: "qmd" }, ...config }, env: { QMD_SHARED_PORT: "18299" }, stderr: quiet, ensureFn: async (opts) => (seen.push(opts.qmdBin), { running: true }) });
  assert.deepEqual(seen, [BIN]);
});
test("restartDaemon hands the program to stop and start", async () => {
  const seen = [];
  await restartDaemon({ port: 1, qmdBin: BIN, stopFn: (opts) => (seen.push(opts.qmdBin), { ok: true }), ensureFn: async (opts) => (seen.push(opts.qmdBin), { running: true }), statusFn: async () => ({ running: false }) });
  assert.deepEqual(seen, [BIN, BIN]);
});
test("init and doctor probe the chosen program", () => {
  const probe = recorder();
  detect({ cwd: tmp(), execFn: probe.execFn, qmdBin: BIN });
  assert.deepEqual(probe.calls, [[BIN, "--version"]]);
  const doctor = recorder();
  const ctx = { cwd: tmp(), config, execFn: doctor.execFn };
  checkQmd(ctx);
  assert.deepEqual(doctor.calls, [[BIN, "--version"]]);
});
test("a route search by the CLI and a skills search use the chosen program", async () => {
  resetBackends();
  const search = recorder();
  registerBackend("qmd", createQmdBackend({ daemonUrl: null, execFn: (bin, args) => (search.calls.push([bin, ...args]), "[]") }));
  await route("anything", { ...config, skills: { collection: "skills" } }, { backend: "qmd" });
  assert.ok(search.calls.length > 0 && search.calls.every(([bin]) => bin === BIN), JSON.stringify(search.calls));
  resetBackends();
  const options = settings(config, tmp(), {});
  assert.equal(options.qmdBin, BIN);
  fs.mkdirSync(options.corpusDir, { recursive: true });
  fs.writeFileSync(path.join(options.corpusDir, "_index.md"), "# index\n");
  const skills = recorder();
  try {
    searchSkills("x", { ...options, execFn: skills.execFn });
  } catch {
    // an empty answer may not parse: only the program that was asked matters here
  }
  assert.ok(skills.calls.length > 0 && skills.calls.every(([bin]) => bin === BIN));
});
test("the program runs without a shell: a name like $(id) is looked up literally, a path with spaces works", () => {
  const dir = tmp();
  const log = path.join(dir, "log");
  const script = `#!/bin/sh\necho "$0 $*" >> "${log}"\n`;
  const plain = path.join(dir, "$(id)");
  fs.writeFileSync(plain, script, { mode: 0o755 });
  const spaced = path.join(dir, "with space", "qmd");
  fs.mkdirSync(path.dirname(spaced));
  fs.writeFileSync(spaced, script, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const before = process.env.PATH;
  process.env.PATH = env.PATH;
  try {
    assert.equal(stopDaemon({ qmdBin: "$(id)" }).ok, true);
    assert.equal(stopDaemon({ qmdBin: spaced }).ok, true);
  } finally {
    process.env.PATH = before;
  }
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\$\(id\) mcp stop$/, "the name reached the program as typed, nothing was expanded");
  assert.match(lines[1], /with space\/qmd mcp stop$/);
});
test("toolgate runs the chosen program and not the qmd on the PATH, and adds no bundled qmd to the PATH", () => {
  const dir = tmp();
  const home = tmp();
  const log = path.join(dir, "chosen.log");
  const chosen = path.join(dir, "chosen-qmd");
  fs.writeFileSync(chosen, `#!/bin/sh\necho "$* PATH=$PATH" >> "${log}"\n`, { mode: 0o755 });
  const guardDir = path.join(dir, "guard");
  fs.mkdirSync(guardDir);
  fs.writeFileSync(path.join(guardDir, "qmd"), `#!/bin/sh\necho called >> "${path.join(dir, "guard.log")}"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, "cfg"));
  fs.writeFileSync(path.join(home, "cfg", "config.json"), JSON.stringify({ qmd: { bin: chosen } }));
  const PATH = `${guardDir}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`;
  const cli = fileURLToPath(new URL("../bin/toolgate.js", import.meta.url));
  execFileSync(process.execPath, [cli, "daemon", "stop"], { cwd: tmp(), env: { PATH, HOME: home, TOOLGATE_DEFAULTS: path.join(home, "cfg", "config.json") }, encoding: "utf8" });
  assert.equal(fs.existsSync(path.join(dir, "guard.log")), false, "the qmd on the PATH was not called");
  assert.equal(fs.readFileSync(log, "utf8").trim(), `mcp stop PATH=${PATH}`, "the PATH is the one given");
  // With no qmd on the PATH toolgate would append its bundled copy (when installed); with qmd.bin set it does not,
  // not even when qmd.bin is the plain name "qmd".
  fs.rmSync(log);
  const bare = tmp();
  execFileSync(process.execPath, [cli, "daemon", "stop"], { cwd: tmp(), env: { PATH: bare, HOME: home, TOOLGATE_DEFAULTS: path.join(home, "cfg", "config.json") }, encoding: "utf8" });
  assert.equal(fs.readFileSync(log, "utf8").trim(), `mcp stop PATH=${bare}`, "no bundled qmd was added");
});
test("init probes the chosen program before and after installing qmd, and asks for the daemon with it", async () => {
  const cwd = tmp();
  const user = path.join(tmp(), "config.json");
  fs.writeFileSync(user, JSON.stringify(config));
  const calls = [];
  const ensures = [];
  let installed = false;
  const execFn = (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === "npm") installed = true;
    else if (bin === BIN && args[0] === "--version" && !installed) throw new Error("not found");
    return "1";
  };
  await runInit({ cwd, env: { TOOLGATE_DEFAULTS: user }, stdout: { write: () => {} }, execFn, daemon: { ensure: async (opts) => (ensures.push(opts.qmdBin), { running: false, reason: "t" }) }, backend: "qmd", installQmd: true, yes: true, interactive: false });
  assert.ok(calls.filter(([bin, arg]) => bin === BIN && arg === "--version").length >= 2, JSON.stringify(calls));
  assert.equal(calls.some(([bin]) => bin === "qmd"), false, "the qmd on the PATH was never asked");
  assert.deepEqual(ensures, [BIN]);
});
test("doctor checks the skills collection with the chosen program", async () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate", "skills-index", "corpus"), { recursive: true });
  const probe = recorder();
  const ctx = { cwd, config, env: { QMD_SHARED_PORT: "18299" }, qmd: true, execFn: probe.execFn, daemon: { status: async () => ({ running: true }) }, fetchFn: async () => { throw new Error("down"); } };
  await checkDaemon(ctx);
  const shows = probe.calls.filter((call) => call[1] === "collection");
  assert.ok(shows.length > 0, JSON.stringify(probe.calls));
  assert.ok(shows.every(([bin]) => bin === BIN));
});
test("an explicit qmd.bin of qmd also counts as chosen: no bundled qmd is added", () => {
  const home = tmp();
  const log = path.join(home, "log");
  const bare = tmp();
  fs.writeFileSync(path.join(bare, "qmd"), `#!/bin/sh\necho "$* PATH=$PATH" >> "${log}"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, "cfg"));
  fs.writeFileSync(path.join(home, "cfg", "config.json"), JSON.stringify({ qmd: { bin: "qmd" } }));
  const cli = fileURLToPath(new URL("../bin/toolgate.js", import.meta.url));
  const empty = tmp();
  fs.writeFileSync(path.join(empty, "qmd"), "#!/bin/sh\ntrue\n", { mode: 0o755 });
  execFileSync(process.execPath, [cli, "daemon", "stop"], { cwd: tmp(), env: { PATH: bare, HOME: home, TOOLGATE_DEFAULTS: path.join(home, "cfg", "config.json") }, encoding: "utf8" });
  assert.equal(fs.readFileSync(log, "utf8").trim(), `mcp stop PATH=${bare}`);
});
