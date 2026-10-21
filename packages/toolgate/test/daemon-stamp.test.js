// The stamp of the qmd daemon toolgate started, and the restart when qmd was upgraded (#136).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureQmdDaemon, run } from "../src/cli.js";
import { ensureDaemon, stopDaemon } from "../src/daemon.js";
import { VERSION_MAX, qmdVersion, readStamp, removeStamp, stampPath, writeStamp } from "../src/daemonStamp.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-stamp-")));
  made.push(dir);
  return dir;
};
const PORT = 18291;
const noSleep = async () => {};

// A stand-in for qmd and the machine: who listens on the port, which version is installed, what each command does.
function world({ version = "1.0.0", running = false, pid = 4242 } = {}) {
  const home = tmp();
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache") };
  const w = { env, home, version, running, pid, nextPid: 5000, log: [], versionFails: false, extraOwners: [], err: [] };
  const pidFile = path.join(env.XDG_CACHE_HOME, "qmd", "mcp.pid");
  w.setPidFile = (value) => {
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, `${value}\n`);
  };
  w.execFn = (bin, args) => {
    w.log.push([bin, ...args].join(" "));
    // Every process of this world has run for five seconds: older than nothing, so the pid file and the stamp come after it.
    if (bin === "ps") return w.psOut ?? "00:05\n";
    if (bin === "lsof") {
      if (w.lsofBroken) throw new Error("lsof failed");
      return w.running ? [w.pid, ...w.extraOwners].join("\n") : "";
    }
    if (args[0] === "--version") {
      if (w.versionFails) throw new Error("no version");
      return `qmd ${w.version}\nmore\n`;
    }
    if (args[0] === "mcp" && args[1] === "stop") {
      w.running = false;
      return "stopped";
    }
    if (args[0] === "mcp" && args[1] === "--http") {
      w.running = true;
      w.pid = w.nextPid++;
      w.setPidFile(w.pid);
      return "started";
    }
    throw new Error(`unexpected ${bin} ${args.join(" ")}`);
  };
  w.fetchFn = async () => {
    if (!w.running) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => ({ uptime: 1 }) };
  };
  w.ensure = (extra = {}) => ensureDaemon({ port: PORT, qmdBin: "qmd", execFn: w.execFn, fetchFn: w.fetchFn, sleepFn: noSleep, env, homedir: home, stderr: { write: (s) => w.err.push(s) }, ...extra });
  w.stamp = () => readStamp(PORT, { env, homedir: home });
  w.started = () => w.log.filter((line) => line.startsWith("qmd mcp --http")).length;
  return w;
}

test("stampPath: under XDG_STATE_HOME, else ~/.local/state, one file per port", () => {
  assert.equal(stampPath(8181, { env: { XDG_STATE_HOME: "/s" }, homedir: "/h" }), path.join("/s", "toolgate", "daemon-8181.json"));
  assert.equal(stampPath(9, { env: {}, homedir: "/h" }), path.join("/h", ".local", "state", "toolgate", "daemon-9.json"));
  assert.equal(stampPath(9, { env: { HOME: "/e" }, homedir: "/h" }), path.join("/e", ".local", "state", "toolgate", "daemon-9.json"));
});
test("writeStamp, readStamp and removeStamp round-trip; anything else in the file is no stamp", () => {
  const where = { env: { XDG_STATE_HOME: path.join(tmp(), "state") }, homedir: "/unused" };
  assert.equal(readStamp(PORT, where), null);
  assert.equal(writeStamp(PORT, { pid: 7, version: "1.2.3", startedAt: "2026-10-18T10:00:00.000Z" }, where), true);
  assert.deepEqual(readStamp(PORT, where), { pid: 7, version: "1.2.3", port: PORT, startedAt: "2026-10-18T10:00:00.000Z" });
  assert.equal(readStamp(PORT + 1, where), null, "another port has its own file");
  const file = stampPath(PORT, where);
  for (const bad of ["not json", "[]", "null", JSON.stringify({ pid: 0, version: "1", port: PORT, startedAt: "x" }), JSON.stringify({ pid: 7, version: 3, port: PORT, startedAt: "x" }), JSON.stringify({ pid: 7, version: "1", port: PORT + 5, startedAt: "x" }), JSON.stringify({ pid: 7, version: "1", port: PORT })]) {
    fs.writeFileSync(file, bad);
    assert.equal(readStamp(PORT, where), null, bad);
  }
  writeStamp(PORT, { pid: 7, version: null }, where);
  assert.equal(readStamp(PORT, where).version, null, "a version that could not be told is stored as null");
  removeStamp(PORT, where);
  assert.equal(fs.existsSync(file), false);
  removeStamp(PORT, where);
});
test("writeStamp does not throw when the state folder cannot be written", () => {
  const blocker = path.join(tmp(), "file");
  fs.writeFileSync(blocker, "");
  assert.equal(writeStamp(PORT, { pid: 7, version: "1" }, { env: { XDG_STATE_HOME: blocker }, homedir: "/unused" }), false);
});
test("qmdVersion: the first line, trimmed; null when qmd fails or prints nothing", () => {
  assert.equal(qmdVersion("qmd", () => "  qmd 1.2.3  \nmore"), "qmd 1.2.3");
  assert.equal(qmdVersion("qmd", () => ""), null);
  assert.equal(qmdVersion("qmd", () => { throw new Error("x"); }), null);
  const seen = [];
  qmdVersion("/opt/qmd", (bin, args) => (seen.push([bin, args]), "1"));
  assert.deepEqual(seen, [["/opt/qmd", ["--version"]]]);
});

test("a daemon toolgate started gets a stamp: qmd's pid, the version, the port and the time", async () => {
  const w = world({ version: "1.0.0" });
  const result = await w.ensure();
  assert.equal(result.running, true);
  assert.equal(result.started, true);
  const stamp = w.stamp();
  assert.equal(stamp.pid, w.pid);
  assert.equal(stamp.version, "qmd 1.0.0");
  assert.equal(stamp.port, PORT);
  assert.ok(!Number.isNaN(Date.parse(stamp.startedAt)));
  assert.equal(stampPath(PORT, { env: w.env, homedir: w.home }).startsWith(path.join(w.home, "state", "toolgate")), true);
});
test("a daemon that was already alive, or one that never answered, gets no stamp", async () => {
  const alive = world();
  alive.execFn = ((inner) => (bin, args) => {
    if (args[1] === "--http") {
      alive.log.push("start refused");
      throw Object.assign(new Error("already running"), { stderr: "already running" });
    }
    return inner(bin, args);
  })(alive.execFn);
  alive.setPidFile(99);
  setTimeout(() => (alive.running = true), 0);
  const result = await alive.ensure({ sleepFn: () => new Promise((resolve) => setTimeout(resolve, 5)) });
  assert.equal(result.running, true);
  assert.equal(result.started, false);
  assert.equal(alive.stamp(), null);
  const dead = world();
  dead.fetchFn = async () => { throw new Error("down"); };
  const failed = await dead.ensure({ attempts: 2 });
  assert.equal(failed.running, false);
  assert.equal(dead.stamp(), null);
});
test("no stamp is written when qmd's pid cannot be read", async () => {
  const w = world();
  const inner = w.execFn;
  w.execFn = (bin, args) => {
    const out = inner(bin, args);
    if (args[1] === "--http") fs.rmSync(path.join(w.env.XDG_CACHE_HOME, "qmd", "mcp.pid"));
    return out;
  };
  assert.equal((await w.ensure()).running, true);
  assert.equal(fs.existsSync(stampPath(PORT, { env: w.env, homedir: w.home })), false);
});
test("the installed qmd changed: say so on stderr, restart, and stamp the new daemon", async () => {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  const old = w.stamp();
  w.version = "1.1.0";
  w.err.length = 0;
  const result = await w.ensure();
  assert.deepEqual(w.err, ["toolgate: qmd changed from qmd 1.0.0 to qmd 1.1.0; restarting the qmd daemon\n"]);
  assert.equal(result.running, true);
  assert.equal(w.started(), 2);
  assert.ok(w.log.includes("qmd mcp stop"));
  const fresh = w.stamp();
  assert.equal(fresh.version, "qmd 1.1.0");
  assert.notEqual(fresh.pid, old.pid);
  assert.equal(fresh.pid, w.pid);
});
test("the same version: nothing is said and the daemon is not touched", async () => {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  const before = w.stamp();
  w.err.length = 0;
  w.log.length = 0;
  const result = await w.ensure();
  assert.equal(result.started, false);
  assert.deepEqual(w.err, []);
  assert.deepEqual(w.stamp(), before);
  assert.equal(w.log.some((line) => /mcp (stop|--http)/.test(line)), false);
});
test("qmd --version failing, or a stamp without a version: no restart", async () => {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  w.version = "2.0.0";
  w.versionFails = true;
  await w.ensure();
  assert.equal(w.started(), 1);
  assert.deepEqual(w.err, []);
  w.versionFails = false;
  writeStamp(PORT, { pid: w.pid, version: null }, { env: w.env, homedir: w.home });
  await w.ensure();
  assert.equal(w.started(), 1, "an unknown old version cannot be compared");
});
test("a stamp whose pid is dead, or does not hold the port, is discarded and nothing is restarted", async () => {
  const w = world({ version: "1.0.0", running: true, pid: 4242 });
  writeStamp(PORT, { pid: 31337, version: "qmd 0.1" }, { env: w.env, homedir: w.home });
  w.version = "9.9.9";
  const result = await w.ensure();
  assert.equal(result.running, true);
  assert.equal(result.started, false);
  assert.equal(w.stamp(), null, "the stamp is gone");
  assert.equal(w.log.some((line) => /mcp (stop|--http)/.test(line)), false, "the foreign daemon is left alone");
  assert.deepEqual(w.err, []);
  const gone = world();
  writeStamp(PORT, { pid: 31337, version: "qmd 0.1" }, { env: gone.env, homedir: gone.home });
  await gone.ensure();
  assert.equal(gone.stamp().pid, gone.pid, "nobody answered: the old stamp was dropped and the new daemon stamped");
});
test("a stamp whose pid is not the one qmd manages is discarded and nothing is restarted", async () => {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  w.setPidFile(w.pid + 1000);
  w.version = "9.9.9";
  w.err.length = 0;
  w.log.length = 0;
  const result = await w.ensure();
  assert.equal(result.running, true);
  assert.equal(result.started, false);
  assert.equal(w.stamp(), null, "the stamp is gone");
  assert.deepEqual(w.err, []);
  assert.equal(w.log.some((line) => /mcp (stop|--http)/.test(line)), false);
});
// A daemon that answers after `qmd mcp stop`: what qmd's pid file says afterwards decides whose it is.
async function survivor(mode) {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  const before = w.stamp();
  const oldPid = w.pid;
  const inner = w.execFn;
  w.execFn = (bin, args) => {
    if (args[0] === "mcp" && args[1] === "stop") {
      w.log.push("qmd mcp stop");
      const pidFile = path.join(w.env.XDG_CACHE_HOME, "qmd", "mcp.pid");
      if (mode === "forgotten") fs.rmSync(pidFile, { force: true });
      if (mode === "lookup") w.lsofBroken = true;
      if (mode === "foreign") fs.writeFileSync(pidFile, "99999\n");
      if (mode === "lookupForeign") {
        w.lsofBroken = true;
        fs.writeFileSync(pidFile, "99999\n");
      }
      return "stopped";
    }
    return inner(bin, args);
  };
  w.version = "1.1.0";
  w.err.length = 0;
  w.log.length = 0;
  return { w, before, oldPid };
}
const STILL = (pid) => `the qmd daemon (pid ${pid}) is still running after "qmd mcp stop"; stop it with "kill ${pid}" and run "toolgate daemon start"`;
test("qmd's own daemon that survives the stop: its own text, never 'already running'; the old stamp goes back, so the next launch retries", async () => {
  const { w, before, oldPid } = await survivor("own");
  const result = await w.ensure();
  assert.equal(result.running, false);
  assert.equal(result.reason, STILL(oldPid));
  assert.doesNotMatch(JSON.stringify(result), /already running/);
  assert.equal(w.started(), 0, "nothing was started on top of it");
  assert.deepEqual(w.stamp(), before, "the old stamp is back, unchanged");
  assert.deepEqual(w.err, ["toolgate: qmd changed from qmd 1.0.0 to qmd 1.1.0; restarting the qmd daemon\n"]);
  w.err.length = 0;
  const again = await w.ensure();
  assert.equal(again.reason, STILL(oldPid), "the next ensure tries again and says the same");
  assert.equal(w.err.length, 1, "with the version line again");
  assert.deepEqual(w.stamp(), before);
});
test("the surviving daemon dies later: the next ensure starts a new one with a new stamp", async () => {
  const { w, before } = await survivor("own");
  await w.ensure();
  w.running = false;
  const result = await w.ensure();
  assert.equal(result.running, true);
  assert.equal(result.started, true);
  assert.equal(w.stamp().version, "qmd 1.1.0");
  assert.notEqual(w.stamp().pid, before.pid);
});
test("a survivor qmd's pid file no longer names: the generic text and no stamp; one it names as another process: #193's text and no stamp", async () => {
  const forgotten = await survivor("forgotten");
  const generic = await forgotten.w.ensure();
  assert.equal(generic.reason, `port ${PORT} still answers after stopping the daemon, and toolgate cannot tell which process holds it; stop that process and run "toolgate daemon start"`);
  assert.equal(forgotten.w.stamp(), null, "a stamp whose pid qmd no longer manages is not put back");
  const lookup = await survivor("lookup");
  const unknown = await lookup.w.ensure();
  assert.equal(unknown.reason, generic.reason, "a holder lookup that fails is the unknown case");
  assert.deepEqual(lookup.w.stamp(), lookup.before);
  const foreign = await survivor("foreign");
  const held = await foreign.w.ensure();
  assert.equal(held.reason, `port ${PORT} is held by pid ${foreign.oldPid}, which toolgate did not start; stop it with "kill ${foreign.oldPid}" and run "toolgate daemon start"`);
  assert.equal(foreign.w.stamp(), null, "a process that is not ours leaves no stamp behind");
  assert.equal(foreign.w.started(), 0);
});
test("qmd mcp stop failing: its message, and the stamp stays as it was", async () => {
  const { w, before } = await survivor("own");
  const inner = w.execFn;
  w.execFn = (bin, args) => {
    if (args[0] === "mcp" && args[1] === "stop") throw Object.assign(new Error("cannot stop"), { stderr: "cannot stop" });
    return inner(bin, args);
  };
  const result = await w.ensure();
  assert.equal(result.running, false);
  assert.match(result.reason, /could not stop qmd daemon: cannot stop/);
  assert.deepEqual(w.stamp(), before);
});
test("daemon start and daemon restart exit 1 with the text on stderr; a launch says it and goes on", async () => {
  for (const action of ["start", "restart"]) {
    const { w, oldPid } = await survivor("own");
    const err = [];
    const out = [];
    const code = await run(["daemon", action, "--port", String(PORT)], {
      cwd: tmp(),
      env: { ...w.env, TOOLGATE_DEFAULTS: path.join(w.home, "none.json") },
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      daemon: {
        ensure: (options) => w.ensure(options),
        stop: (options) => stopDaemon({ ...options, execFn: w.execFn, homedir: w.home }),
        status: async () => (w.running ? { running: true, url: "u" } : { running: false }),
        holder: () => ({ pid: oldPid, foreign: false }),
        sleep: noSleep,
      },
    });
    assert.equal(code, 1, action);
    assert.ok(err.join("").includes(`toolgate daemon: ${STILL(oldPid)}\n`), `${action}: ${err.join("")}`);
    assert.doesNotMatch(err.join("") + out.join(""), /already running/);
  }
  const { w, oldPid } = await survivor("own");
  const launch = [];
  await ensureQmdDaemon({ config: { router: { backend: "qmd" } }, backend: "qmd", env: { ...w.env, QMD_SHARED_PORT: String(PORT) }, stderr: { write: (text) => launch.push(text) }, ensureFn: (options) => w.ensure(options) });
  assert.ok(launch.join("").includes(`toolgate: qmd daemon unavailable (${STILL(oldPid)}); routing falls back to the qmd CLI`), launch.join(""));
});
test("a pid among several listeners still counts", async () => {
  const w = world({ version: "1.0.0" });
  await w.ensure();
  w.extraOwners = [777];
  w.version = "1.5.0";
  await w.ensure();
  assert.equal(w.started(), 2);
});
test("stopDaemon removes the stamp of its port, and only on success", () => {
  const w = world();
  const where = { env: w.env, homedir: w.home };
  writeStamp(PORT, { pid: 1, version: "a" }, where);
  writeStamp(PORT + 1, { pid: 1, version: "a" }, where);
  assert.equal(stopDaemon({ execFn: () => { throw new Error("cannot run"); }, port: PORT, ...where }).ok, false);
  assert.notEqual(readStamp(PORT, where), null);
  assert.equal(stopDaemon({ execFn: () => "stopped", port: PORT, ...where }).ok, true);
  assert.equal(readStamp(PORT, where), null);
  assert.notEqual(readStamp(PORT + 1, where), null, "another port's stamp stays");
});

const quiet = { write: () => {} };
const cliDaemon = (w, holder, status = { running: true, url: "http://localhost:18291/mcp", uptime: 7 }) => ({
  status: async () => status,
  holder: () => holder,
  ensure: async () => ({ running: true }),
  stop: (opts) => stopDaemon({ execFn: () => "stopped", ...opts }),
});
const runDaemon = async (w, action, daemon, args = []) => {
  const out = [];
  const code = await run(["daemon", action, "--port", String(PORT), ...args], { cwd: tmp(), env: { ...w.env, TOOLGATE_DEFAULTS: path.join(w.home, "none.json") }, stdout: { write: (s) => out.push(s) }, stderr: quiet, daemon });
  return { code, out: out.join("") };
};
test("daemon status: the stamp of a daemon toolgate started adds pid, qmd and start time; none or a foreign pid add nothing of it", async () => {
  const w = world();
  const where = { env: w.env, homedir: w.home };
  const plain = await runDaemon(w, "status", cliDaemon(w, { pid: null, foreign: null }));
  assert.equal(plain.out, "toolgate: qmd daemon running on http://localhost:18291/mcp (uptime 7s)\n");
  writeStamp(PORT, { pid: 4242, version: "qmd 1.0.0", startedAt: "2026-10-18T10:00:00.000Z" }, where);
  const own = await runDaemon(w, "status", cliDaemon(w, { pid: 4242, foreign: false }));
  assert.equal(own.code, 0);
  assert.equal(own.out, "toolgate: qmd daemon running on http://localhost:18291/mcp (uptime 7s) (pid 4242, qmd qmd 1.0.0, started 2026-10-18T10:00:00.000Z)\n");
  const stale = await runDaemon(w, "status", cliDaemon(w, { pid: 9, foreign: false }));
  assert.doesNotMatch(stale.out, /qmd 1\.0\.0/, "the stamp's pid is not the one holding the port");
  const sameFlagged = await runDaemon(w, "status", cliDaemon(w, { pid: 4242, foreign: true }));
  assert.doesNotMatch(sameFlagged.out, /qmd 1\.0\.0/, "a holder flagged foreign is never described by a stamp");
  const foreign = await runDaemon(w, "status", cliDaemon(w, { pid: 9, foreign: true }));
  assert.match(foreign.out, /\(pid 9, not started by toolgate\)$/m);
  assert.doesNotMatch(foreign.out, /qmd 1\.0\.0/);
  const down = await runDaemon(w, "status", cliDaemon(w, { pid: 4242, foreign: false }, { running: false }));
  assert.equal(down.code, 1);
  assert.doesNotMatch(down.out, /pid/);
  writeStamp(PORT, { pid: 4242, version: null, startedAt: "t" }, where);
  assert.match((await runDaemon(w, "status", cliDaemon(w, { pid: 4242, foreign: false }))).out, /\(pid 4242, qmd unknown, started t\)/);
});
test("daemon stop removes the stamp", async () => {
  const w = world();
  const where = { env: w.env, homedir: w.home };
  writeStamp(PORT, { pid: 4242, version: "1" }, where);
  const result = await runDaemon(w, "stop", cliDaemon(w, { pid: null, foreign: null }));
  assert.equal(result.code, 0);
  assert.equal(readStamp(PORT, where), null);
});
test("restart with a holder that cannot be told and a pid file that names another process: the old stamp is not put back", async () => {
  const { w, before } = await survivor("lookupForeign");
  assert.ok(before);
  const result = await w.ensure();
  assert.equal(result.running, false);
  assert.equal(w.stamp(), null, "the stamp of a pid qmd does not manage is not restored");
});
test("a relative XDG_STATE_HOME is ignored, as the XDG spec says: the stamp goes under ~/.local/state", () => {
  const home = tmp();
  assert.equal(stampPath(PORT, { env: { XDG_STATE_HOME: "relative/state", HOME: home } }), path.join(home, ".local", "state", "toolgate", `daemon-${PORT}.json`));
  assert.equal(stampPath(PORT, { env: { XDG_STATE_HOME: "", HOME: home } }), path.join(home, ".local", "state", "toolgate", `daemon-${PORT}.json`));
  assert.equal(stampPath(PORT, { env: { XDG_STATE_HOME: path.join(home, "abs"), HOME: home } }), path.join(home, "abs", "toolgate", `daemon-${PORT}.json`));
});
test("the version of a stamp and of qmd is capped at 64 characters, and goes through printable() when it is shown", async () => {
  const long = "v".repeat(500);
  assert.equal(qmdVersion("qmd", () => `${long}\n`).length, VERSION_MAX);
  const env = { HOME: tmp() };
  const file = stampPath(PORT, { env });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: 5, version: long, port: PORT, startedAt: "2026-10-19T00:00:00.000Z" }));
  assert.equal(readStamp(PORT, { env }).version.length, VERSION_MAX);
  const w = world({ version: "1.0.0" });
  await w.ensure();
  w.version = "2.0.0\u001b[31m";
  w.err.length = 0;
  await w.ensure();
  assert.equal(w.err.length, 1);
  assert.doesNotMatch(w.err[0], /\u001b/, "no control character reaches the terminal");
  assert.match(w.err[0], /qmd changed from qmd 1\.0\.0 to qmd 2\.0\.0/);
});
test("a stamp is written whole and for its owner only: mode 600, no temporary file left, and a failed write leaves the old stamp valid", { skip: process.platform === "win32" }, () => {
  const env = { HOME: tmp() };
  const file = stampPath(PORT, { env });
  assert.equal(writeStamp(PORT, { pid: 5, version: "1" }, { env }), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], "no .tmp left");
  const old = readStamp(PORT, { env });
  fs.mkdirSync(`${file}.${process.pid}.tmp`);
  fs.writeFileSync(path.join(`${file}.${process.pid}.tmp`, "x"), "");
  assert.equal(writeStamp(PORT, { pid: 6, version: "2" }, { env }), false);
  assert.deepEqual(readStamp(PORT, { env }), old, "the old stamp is intact");
});
test("daemon status shows the stamp's start time through printable(): a hostile file cannot put a control character or a second line on the terminal", async () => {
  const w = world();
  writeStamp(PORT, { pid: 4242, version: "qmd 1.0.0", startedAt: "2026-10-19\u001b[31m\nspoof" }, { env: w.env, homedir: w.home });
  const own = await runDaemon(w, "status", cliDaemon(w, { pid: 4242, foreign: false }));
  assert.equal(own.out.split("\n").length, 2, "one line and its newline");
  assert.doesNotMatch(own.out, /\u001b/);
  assert.match(own.out, /started 2026-10-19/);
});
