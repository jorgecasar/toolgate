import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stampPath } from "../src/daemonStamp.js";
import { COLD_START_ATTEMPTS, daemonStatus, ensureDaemon as realEnsureDaemon, managedPid, managedPort, portHolder, verifiedManagedPid, portOwner, portOwners, stopDaemon as realStopDaemon, remoteQmdOrigin } from "../src/daemon.js";

const healthy = async () => ({ ok: true, json: async () => ({ status: "ok", uptime: 42 }) });
// ensureDaemon and stopDaemon write and remove the stamp of the daemon, and read qmd's pid file: these tests always give them a
// throwaway home, so they can never touch the real XDG_STATE_HOME or the real qmd cache.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-daemon-"));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
const isolated = { env: { HOME: sandbox, XDG_STATE_HOME: path.join(sandbox, "state"), XDG_CACHE_HOME: path.join(sandbox, "cache") }, homedir: sandbox };
const ensureDaemon = (options = {}) => realEnsureDaemon({ ...isolated, ...options });
const stopDaemon = (options = {}) => realStopDaemon({ ...isolated, ...options });
const down = async () => {
  throw new Error("ECONNREFUSED");
};
const noSleep = async () => {};

// A fetch that fails until `after` calls have been made, then answers.
function fetchAfter(after) {
  let calls = 0;
  return async (...args) => {
    calls += 1;
    return calls > after ? healthy(...args) : down(...args);
  };
}

test("managedPort: env, local url and disabled or remote endpoints", () => {
  assert.equal(managedPort({}, {}), 8181);
  assert.equal(managedPort({}, { QMD_SHARED_PORT: "9100" }), 9100);
  assert.equal(
    managedPort({ router: { qmdUrl: "http://127.0.0.1:9200/mcp" } }, { QMD_SHARED_PORT: "9100" }),
    9200
  );
  assert.equal(managedPort({ router: { qmdUrl: null } }, {}), null);
  assert.equal(managedPort({ router: { qmdUrl: "http://qmd.example.com:8181/mcp" } }, {}), null);
});

test("daemonStatus: healthy with uptime, or not running on failure and non-2xx", async () => {
  const status = await daemonStatus({ port: 8181, fetchFn: healthy });
  assert.deepEqual(status, { running: true, state: "up", port: 8181, url: "http://localhost:8181/mcp", uptime: 42 });
  assert.equal((await daemonStatus({ fetchFn: down })).running, false);
  assert.equal((await daemonStatus({ fetchFn: async () => ({ ok: false }) })).running, false);
});

test("daemonStatus: state is up on 2xx, down when the port refuses or is unreachable, hung when the probe times out or answers without 2xx", async () => {
  assert.equal((await daemonStatus({ fetchFn: healthy })).state, "up");
  assert.equal((await daemonStatus({ fetchFn: down })).state, "down");
  assert.equal((await daemonStatus({ fetchFn: async () => ({ ok: false }) })).state, "hung");
  // Pending until the signal fires, with a timer of its own that keeps the event loop alive: the timeout of an AbortSignal does not, and on
  // Linux the loop would empty first and cancel the test.
  const never = (_url, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 20);
      init.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        reject(init.signal.reason);
      });
    });
  const started = Date.now();
  const hung = await daemonStatus({ fetchFn: never, timeoutMs: 50 });
  assert.deepEqual([hung.running, hung.state], [false, "hung"]);
  assert.ok(Date.now() - started < 1000);
  // A redirect is not followed, and a 3xx is an answer without 2xx: hung, the body released.
  const seen = [];
  let released = false;
  const redirected = await daemonStatus({ fetchFn: async (url, init) => (seen.push(init.redirect), { ok: false, status: 302, body: { cancel: async () => { released = true; } } }) });
  assert.deepEqual([redirected.state, seen, released], ["hung", ["manual"], true]);
  const aborted = await daemonStatus({ fetchFn: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } });
  assert.equal(aborted.state, "hung");
});

test("ensureDaemon: is a no-op when the daemon is already healthy", async () => {
  const execFn = () => {
    throw new Error("must not spawn a second daemon");
  };
  const result = await ensureDaemon({ fetchFn: healthy, execFn });
  assert.equal(result.running, true);
  assert.equal(result.started, false);
});

test("ensureDaemon: starts the daemon and waits until it answers", async () => {
  const calls = [];
  const result = await ensureDaemon({
    port: 9100,
    qmdBin: "qmd-test",
    fetchFn: fetchAfter(3),
    execFn: (bin, args) => {
      calls.push([bin, args]);
      return "Started on http://localhost:9100/mcp";
    },
    sleepFn: noSleep,
  });
  assert.deepEqual(calls, [["qmd-test", ["mcp", "--http", "--daemon", "--port", "9100"]]]);
  assert.equal(result.running, true);
  assert.equal(result.started, true);
});

test("ensureDaemon: keeps polling when qmd says the daemon is already running", async () => {
  const result = await ensureDaemon({
    fetchFn: fetchAfter(2),
    execFn: () => {
      const err = new Error("Command failed");
      err.stderr = "Already running (PID 123). Run 'qmd mcp stop' first.";
      throw err;
    },
    sleepFn: noSleep,
  });
  assert.equal(result.running, true);
  assert.equal(result.started, false);
});

test("ensureDaemon: reports a spawn failure without throwing", async () => {
  const result = await ensureDaemon({
    fetchFn: down,
    execFn: () => {
      throw new Error("spawn qmd ENOENT");
    },
    sleepFn: noSleep,
  });
  assert.equal(result.running, false);
  assert.equal(result.started, false);
  assert.match(result.reason, /could not start qmd daemon: .*ENOENT/);
});

test("ensureDaemon: reports a timeout when the daemon never answers", async () => {
  const result = await ensureDaemon({
    fetchFn: down,
    execFn: () => "Started",
    sleepFn: noSleep,
    attempts: 3,
    intervalMs: 100,
  });
  assert.equal(result.running, false);
  assert.match(result.reason, /did not answer on port 8181 after 300ms/);
});

test("stopDaemon: delegates to qmd mcp stop; not running is not an error; spawn failure is", () => {
  const calls = [];
  const stopped = stopDaemon({
    qmdBin: "qmd-test",
    execFn: (bin, args) => {
      calls.push([bin, args]);
      return "Stopped QMD MCP server (PID 123).\n";
    },
  });
  assert.deepEqual(calls, [["qmd-test", ["mcp", "stop"]]]);
  assert.deepEqual(stopped, { ok: true, stopped: true, message: "Stopped QMD MCP server (PID 123)." });

  const idle = stopDaemon({ execFn: () => "Not running (no PID file).\n" });
  assert.deepEqual([idle.ok, idle.stopped], [true, false]);

  const failed = stopDaemon({
    execFn: () => {
      throw new Error("spawn qmd ENOENT");
    },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /could not stop qmd daemon: .*ENOENT/);
});

test("ensureDaemon: waits 10 s by default, and up to a minute when asked for a cold start", async () => {
  let polls = 0;
  const countingDown = async () => {
    polls += 1;
    throw new Error("ECONNREFUSED");
  };
  const waits = [];
  const result = await ensureDaemon({
    fetchFn: countingDown,
    execFn: () => "",
    sleepFn: async (ms) => waits.push(ms),
  });
  assert.equal(result.running, false);
  assert.equal(waits.length, 20);
  assert.equal(waits.reduce((a, b) => a + b, 0), 10000);
  assert.match(result.reason, /after 10000ms/);
  assert.equal(polls, 21, "one initial check plus one per wait");

  const cold = [];
  const coldResult = await ensureDaemon({
    fetchFn: countingDown,
    execFn: () => "",
    sleepFn: async (ms) => cold.push(ms),
    attempts: COLD_START_ATTEMPTS,
  });
  assert.equal(cold.reduce((a, b) => a + b, 0), 60000);
  assert.match(coldResult.reason, /after 60000ms/);
});

// What each tool prints, as the platform prints it; the command that was asked is recorded.
const missing = () => Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
const lookup = (answers) => {
  const asked = [];
  return { asked, execFn: (bin, args) => (asked.push([bin, ...args].join(" ")), bin in answers ? answers[bin](args) : (() => { throw missing(); })()) };
};
test("portOwner: lsof gives the pid on darwin and on linux, asking only for listeners of that port", () => {
  for (const platform of ["darwin", "linux"]) {
    const { asked, execFn } = lookup({ lsof: () => "4242\n" });
    assert.equal(portOwner(8181, { platform, execFn }), 4242);
    assert.deepEqual(asked, ["lsof -nP -iTCP:8181 -sTCP:LISTEN -t"]);
  }
});
test("portOwner: linux without lsof asks ss and reads the pid from its users column", () => {
  const { asked, execFn } = lookup({ ss: () => 'LISTEN 0 511 127.0.0.1:8181 0.0.0.0:* users:(("node",pid=7788,fd=19))\n' });
  assert.equal(portOwner(8181, { platform: "linux", execFn }), 7788);
  assert.deepEqual(asked, ["lsof -nP -iTCP:8181 -sTCP:LISTEN -t", "ss -ltnpH sport = :8181"]);
});
test("portOwner: linux with neither tool, and a platform with no tool to ask, give no pid", () => {
  assert.equal(portOwner(8181, { platform: "linux", execFn: lookup({}).execFn }), null);
  assert.equal(portOwner(8181, { platform: "darwin", execFn: lookup({}).execFn }), null);
});
test("portOwner: win32 reads the listening lines of exactly that port from `netstat -ano`, told by the empty remote address", () => {
  const netstat = () => [
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:18181          0.0.0.0:0              LISTENING       111",
    "  TCP    127.0.0.1:8181         127.0.0.1:50000        ESTABLISHED     222",
    "  TCP    0.0.0.0:81810          0.0.0.0:0              LISTENING       5555",
    "  TCP    0.0.0.0:8181           0.0.0.0:0              LISTENING       3333",
    "  UDP    0.0.0.0:8181           *:*                                    4444",
    "",
  ].join("\r\n");
  const { asked, execFn } = lookup({ netstat });
  assert.equal(portOwner(8181, { platform: "win32", execFn }), 3333);
  assert.deepEqual(asked, ["netstat -ano"]);
  assert.equal(portOwner(9999, { platform: "win32", execFn }), null);
  // a port that is only part of another one (1818 in 18181, 818 in 81810) is not that port
  assert.equal(portOwner(1818, { platform: "win32", execFn }), null);
  assert.equal(portOwner(818, { platform: "win32", execFn }), null);
  assert.equal(portOwner(18181, { platform: "win32", execFn }), 111);
});
test("portOwners: win32 does not depend on the word LISTENING, which Windows translates, and reads IPv6 too", () => {
  const netstat = () => [
    "  Proto  Direccion local        Direccion remota       Estado          PID",
    "  TCP    0.0.0.0:8181           0.0.0.0:0              ESCUCHANDO      3333",
    "  TCP    [::]:8181              [::]:0                 ESCUCHANDO      3333",
    "  TCP    [::]:8181              [::]:0                 ESCUCHANDO      3334",
    "  TCP    [::1]:8181             [::1]:52000            ESTABLISHED     9999",
    "",
  ].join("\r\n");
  assert.deepEqual(portOwners(8181, { platform: "win32", execFn: lookup({ netstat }).execFn }), [3333, 3334]);
});
test("portOwners: every listener, once each, in the order printed (a parent and workers sharing the socket)", () => {
  assert.deepEqual(portOwners(8181, { platform: "darwin", execFn: lookup({ lsof: () => "10\n11\n10\n12\n" }).execFn }), [10, 11, 12]);
  const ss = () => 'LISTEN 0 511 *:8181 *:* users:(("node",pid=21,fd=19),("node",pid=22,fd=19))\n';
  assert.deepEqual(portOwners(8181, { platform: "linux", execFn: lookup({ ss }).execFn }), [21, 22]);
  assert.equal(portOwner(8181, { platform: "darwin", execFn: lookup({ lsof: () => "10\n11\n" }).execFn }), 10, "portOwner is the first");
  assert.deepEqual(portOwners(8181, { platform: "linux", execFn: lookup({}).execFn }), []);
  assert.deepEqual(portOwners(0, { platform: "darwin", execFn: () => "1\n" }), []);
});
test("portHolder: the port is toolgate's when ANY listener is the pid qmd manages, and foreign only when none is", () => {
  const cacheWithPid = (pid) => cacheWith(String(pid));
  const holder = (lsof, env) => portHolder(8181, { env, platform: "darwin", execFn: lookup({ lsof: () => lsof, ps: () => "00:05\n" }).execFn });
  assert.deepEqual(holder("10\n11\n", { XDG_CACHE_HOME: cacheWithPid(11) }), { pid: 11, foreign: false }, "the worker is the managed one");
  assert.deepEqual(holder("10\n11\n", { XDG_CACHE_HOME: cacheWithPid(10) }), { pid: 10, foreign: false });
  assert.deepEqual(holder("10\n11\n", { XDG_CACHE_HOME: cacheWithPid(99) }), { pid: 10, foreign: true }, "none matches: names the first");
  assert.deepEqual(holder("10\n", { XDG_CACHE_HOME: cacheWith(null) }), { pid: 10, foreign: true }, "no pid file at all");
  assert.deepEqual(holder("", { XDG_CACHE_HOME: cacheWithPid(10) }), { pid: null, foreign: null }, "nobody listens or it cannot be told");
});
test("portOwner: nothing listening, output that is not a pid, and a bad port give no pid", () => {
  assert.equal(portOwner(8181, { platform: "darwin", execFn: lookup({ lsof: () => "" }).execFn }), null);
  assert.equal(portOwner(8181, { platform: "darwin", execFn: lookup({ lsof: () => "COMMAND PID\nnode abc" }).execFn }), null);
  assert.equal(portOwner(8181, { platform: "darwin", execFn: lookup({ lsof: () => { throw Object.assign(new Error("exit 1"), { status: 1 }); } }).execFn }), null);
  assert.equal(portOwner(8181, { platform: "linux", execFn: lookup({ ss: () => "LISTEN 0 511 *:8181 *:*\n" }).execFn }), null);
  for (const port of [0, -1, 1.5, NaN, undefined, "8181"]) assert.equal(portOwner(port, { platform: "darwin", execFn: () => "1\n" }), null);
});
const cleanups = [];
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const cacheWith = (pidText, sub = "qmd") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-pid-"));
  cleanups.push(dir);
  if (pidText !== null) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.writeFileSync(path.join(dir, sub, "mcp.pid"), pidText);
  }
  return dir;
};
test("managedPid: reads mcp.pid under XDG_CACHE_HOME, else under HOME/.cache, as qmd does", () => {
  assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith("1234\n") }), 1234);
  const home = cacheWith(null);
  fs.mkdirSync(path.join(home, ".cache", "qmd"), { recursive: true });
  fs.writeFileSync(path.join(home, ".cache", "qmd", "mcp.pid"), "99");
  assert.equal(managedPid({ HOME: home }), 99);
  assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith("5"), HOME: home }), 5, "XDG_CACHE_HOME wins");
});
test("managedPid: no file, an empty file and a file that is not a pid give null", () => {
  assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith(null) }), null);
  for (const text of ["", "\n", "abc", "-4", "12.5"]) assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith(text) }), null, JSON.stringify(text));
});
test("a pid is decimal digits and a safe integer above zero: 0x10, 1e3, 0 and a huge number are not pids", () => {
  for (const text of ["0x10", "1e3", "0", "+5", "-5", "5.5", "99999999999999999999", " "]) {
    assert.equal(portOwner(8181, { platform: "darwin", execFn: () => `${text}\n` }), null, JSON.stringify(text));
    assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith(text) }), null, JSON.stringify(text));
  }
  assert.equal(portOwner(8181, { platform: "darwin", execFn: () => "007\n" }), 7);
});

test("managedPort: --port > router.qmdUrl > QMD_SHARED_PORT > qmd.port > 8181, and a remote or disabled url is null", () => {
  const cfg = (qmdUrl) => ({ qmd: { port: 18282 }, ...(qmdUrl === undefined ? {} : { router: { qmdUrl } }) });
  const env = { QMD_SHARED_PORT: "18283" };
  assert.equal(managedPort(cfg(), {}), 18282, "qmd.port alone");
  assert.equal(managedPort(cfg(), env), 18283, "the environment beats qmd.port");
  assert.equal(managedPort(cfg("http://127.0.0.1:9200/mcp"), env), 9200, "a local router.qmdUrl beats the environment");
  assert.equal(managedPort(cfg("http://127.0.0.1:9200/mcp"), env, { flagPort: 18284 }), 18284, "--port beats everything");
  assert.equal(managedPort(cfg(null), env), null);
  assert.equal(managedPort(cfg("http://qmd.example.com:8181/mcp"), env), null);
  assert.equal(managedPort({}, {}), 8181);
  for (const bad of [0, 70000, 1.5, "18282", null]) assert.equal(managedPort({ qmd: { port: bad } }, {}), 8181, `a file with qmd.port ${JSON.stringify(bad)} is not trusted`);
});

test("the tests of this file never write the stamp outside their own throwaway home", async () => {
  fs.mkdirSync(path.join(isolated.env.XDG_CACHE_HOME, "qmd"), { recursive: true });
  fs.writeFileSync(path.join(isolated.env.XDG_CACHE_HOME, "qmd", "mcp.pid"), "4242\n");
  const real = stampPath(9191, { env: process.env });
  await ensureDaemon({ port: 9191, fetchFn: fetchAfter(1), execFn: () => "1.0.0", sleepFn: noSleep });
  assert.equal(fs.existsSync(stampPath(9191, isolated)), true, "the stamp went to the sandbox");
  assert.equal(fs.existsSync(real), false, "and not to the real state folder");
  assert.equal(stampPath(9191, isolated).startsWith(sandbox), true);
});
test("remoteQmdOrigin: only the origin of a parseable url that is not this machine's; credentials, path and query never", () => {
  const of = (qmdUrl) => remoteQmdOrigin({ router: { qmdUrl } });
  assert.equal(of("https://u:secret@qmd.example.com:9443/mcp?token=abc#x"), "https://qmd.example.com:9443");
  assert.equal(of("http://10.0.0.5/mcp"), "http://10.0.0.5");
  for (const value of ["file:///x", "data:text/plain,x", "javascript:alert(1)", "ftp://h/", "ws://h/", "mailto:a@b.c", "http://localhost:8181/mcp", "http://127.0.0.1/mcp", "http://[::1]:9/mcp", "not a url", "", null, undefined, 5, {}]) assert.equal(of(value), null, String(value));
  assert.equal(remoteQmdOrigin(undefined), null);
});

test("portOwners: a value that is not a port (0, negative, above 65535, fractional, not a number) is never looked up", () => {
  const calls = [];
  const execFn = (...args) => (calls.push(args), "4242\n");
  for (const port of [0, -1, 65536, 99999, 1.5, NaN, "8181", undefined]) assert.deepEqual(portOwners(port, { platform: "darwin", execFn }), [], String(port));
  assert.deepEqual(calls, [], "no tool is run for them");
  assert.deepEqual(portOwners(65535, { platform: "darwin", execFn }), [4242]);
});
test("managedPort ignores a qmd.port above 65535 and falls back to 8181", () => {
  assert.equal(managedPort({ qmd: { port: 65536 } }, {}), 8181);
  assert.equal(managedPort({ qmd: { port: 65535 } }, {}), 65535);
  assert.equal(managedPort({ qmd: { port: 0 } }, {}), 8181);
});
test("managedPid: a relative XDG_CACHE_HOME is ignored, as the XDG spec says, and ~/.cache is read", () => {
  const home = cacheWith("4242", ".cache/qmd");
  assert.equal(managedPid({ XDG_CACHE_HOME: "relative/cache", HOME: home }), 4242);
  assert.equal(managedPid({ XDG_CACHE_HOME: "", HOME: home }), 4242);
  assert.equal(managedPid({ XDG_CACHE_HOME: cacheWith("77"), HOME: home }), 77, "an absolute one still wins");
});
// A pid in qmd's file is the daemon's only while the process is older than the file: a pid reused later is another process.
const longAgo = (dir) => fs.utimesSync(path.join(dir, "qmd", "mcp.pid"), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
const psSays = (out) => lookup({ ps: typeof out === "function" ? out : () => out }).execFn;
test("verifiedManagedPid: a daemon started by hand, with no stamp, is managed while its process is older than mcp.pid", () => {
  const dir = cacheWith("4242");
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "darwin", execFn: psSays("00:05\n") }), 4242);
  longAgo(dir);
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "darwin", execFn: psSays("02:00:00\n") }), 4242, "two hours old, the file an hour old: it was running before the file");
});
test("verifiedManagedPid: a pid reused after mcp.pid was written is not managed, and so is a port it holds foreign", () => {
  const dir = cacheWith("4242");
  longAgo(dir);
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "darwin", execFn: psSays("00:05\n") }), null, "started 5 s ago, the file is an hour old");
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "linux", execFn: psSays("1-00:00:01\n") }), 4242, "a day-old process is older than the file");
  const execFn = lookup({ lsof: () => "4242\n", ps: () => "00:05\n" }).execFn;
  assert.deepEqual(portHolder(8181, { env: { XDG_CACHE_HOME: dir }, platform: "darwin", execFn }), { pid: 4242, foreign: true });
});
test("verifiedManagedPid: the stamp of that pid is the reference when there is one", () => {
  const dir = cacheWith("4242");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-state-"));
  cleanups.push(state);
  const env = { XDG_CACHE_HOME: dir, XDG_STATE_HOME: state };
  fs.mkdirSync(path.join(state, "toolgate"));
  const stamp = (startedAt) => fs.writeFileSync(path.join(state, "toolgate", "daemon-8181.json"), JSON.stringify({ pid: 4242, version: "1", port: 8181, startedAt }));
  stamp(new Date(Date.now() - 600_000).toISOString());
  assert.equal(verifiedManagedPid(env, { port: 8181, platform: "darwin", execFn: psSays("20:00\n") }), 4242, "started before the stamp");
  assert.equal(verifiedManagedPid(env, { port: 8181, platform: "darwin", execFn: psSays("01:00\n") }), null, "started a minute ago, the stamp is ten minutes old, though mcp.pid is new");
  stamp("not a date");
  assert.equal(verifiedManagedPid(env, { port: 8181, platform: "darwin", execFn: psSays("00:05\n") }), 4242, "a stamp without a usable time falls back to the file");
});
test("verifiedManagedPid: when ps is missing or not understood there is nothing to check, and the file is trusted as it was before; no pid file, no pid", () => {
  const dir = cacheWith("4242");
  longAgo(dir);
  for (const out of ["", "garbage", "12", "00:05 extra", () => { throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }); }]) {
    assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "darwin", execFn: psSays(out) }), 4242, String(out));
  }
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir }, { platform: "win32", execFn: () => { throw new Error("no ps"); } }), 4242);
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: cacheWith(null) }, { platform: "darwin", execFn: psSays("00:05\n") }), null, "no pid file");
});
test("verifiedManagedPid: a stamp time in the future is not trusted: mcp.pid decides", () => {
  const dir = cacheWith("4242");
  longAgo(dir);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-state-"));
  cleanups.push(state);
  fs.mkdirSync(path.join(state, "toolgate"));
  fs.writeFileSync(path.join(state, "toolgate", "daemon-8181.json"), JSON.stringify({ pid: 4242, version: "1", port: 8181, startedAt: new Date(Date.now() + 86_400_000).toISOString() }));
  assert.equal(verifiedManagedPid({ XDG_CACHE_HOME: dir, XDG_STATE_HOME: state }, { port: 8181, platform: "darwin", execFn: psSays("00:05\n") }), null, "a stamp from tomorrow would call any new process managed");
});
