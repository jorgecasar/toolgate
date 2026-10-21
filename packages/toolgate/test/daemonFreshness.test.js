import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkFreshness,
  corpusDocCount,
  daemonDocCount,
  refreshDaemonIfStale,
  restartDaemon,
  skillsLocation,
  staleMessage,
} from "../src/daemonFreshness.js";
import { defaultCollection } from "../src/skills/corpus.js";

const corpus = (names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fresh-"));
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
  return dir;
};

// A client double: `status` answers with the given documents per collection.
const clientWith = (collections) => ({
  callTool: async (name) => {
    assert.equal(name, "status");
    return { structuredContent: { collections } };
  },
});

test("corpusDocCount: counts the markdown files (cards and catalog), and is null without a corpus", () => {
  assert.equal(corpusDocCount(corpus(["a.md", "b.md", "_index.md", "notes.txt"])), 3);
  assert.equal(corpusDocCount(path.join(os.tmpdir(), "toolgate-no-corpus-here")), null);
});

test("daemonDocCount: reads the collection's documents from the status tool, and is null when it cannot", async () => {
  const client = clientWith([{ name: "other", documents: 9 }, { name: "mine", documents: 4 }]);
  assert.equal(await daemonDocCount({ collection: "mine", client }), 4);
  assert.equal(await daemonDocCount({ collection: "absent", client }), null);
  assert.equal(await daemonDocCount({ collection: "mine", client: clientWith([{ name: "mine" }]) }), null);
  assert.equal(await daemonDocCount({ collection: "mine", client: { callTool: async () => ({ structuredContent: { results: [] } }) } }), null);
  assert.equal(await daemonDocCount({ collection: "mine", client: { callTool: async () => { throw new Error("down"); } } }), null);
});

test("checkFreshness: fresh when the counts match, stale when they differ, unknown when either is missing", async () => {
  const corpusDir = corpus(["a.md", "b.md", "_index.md"]);
  const check = (collections, dir = corpusDir) => checkFreshness({ collection: "mine", corpusDir: dir, client: clientWith(collections) });
  assert.deepEqual(await check([{ name: "mine", documents: 3 }]), { state: "fresh", expected: 3, actual: 3 });
  assert.deepEqual(await check([{ name: "mine", documents: 1 }]), { state: "stale", expected: 3, actual: 1 });
  // more documents than the corpus cannot hide a skill from a query: not stale
  assert.deepEqual(await check([{ name: "mine", documents: 7 }]), { state: "fresh", expected: 3, actual: 7 });
  assert.equal((await check([])).state, "unknown");
  assert.equal((await check([{ name: "mine", documents: 3 }], path.join(os.tmpdir(), "toolgate-none"))).state, "unknown");
});

test("staleMessage: says what the daemon serves and how to fix it", () => {
  assert.equal(
    staleMessage({ collection: "skills-app", expected: 26, actual: 2 }),
    'the qmd daemon serves 2 of the 26 documents of "skills-app"; run "toolgate daemon restart"'
  );
});

test("skillsLocation: the project's own collection and corpus unless the config says otherwise", () => {
  assert.deepEqual(skillsLocation({}, "/work/app"), {
    collection: defaultCollection("/work/app"),
    corpusDir: path.join("/work/app", ".toolgate", "skills-index", "corpus"),
  });
  assert.deepEqual(skillsLocation({ skills: { collection: "team", corpusDir: "build/corpus" } }, "/work/app"), {
    collection: "team",
    corpusDir: "/work/app/build/corpus",
  });
});

test("restartDaemon: stops, then starts; a stop that fails never starts", async () => {
  const steps = [];
  const ok = await restartDaemon({
    port: 8181,
    stopFn: () => (steps.push("stop"), { ok: true }),
    ensureFn: async ({ port }) => (steps.push(`start ${port}`), { running: true }),
    statusFn: async () => ({ running: false }),
  });
  assert.deepEqual([ok.running, steps], [true, ["stop", "start 8181"]]);

  const failed = await restartDaemon({ port: 1, stopFn: () => ({ ok: false, message: "no qmd" }), ensureFn: async () => assert.fail("no start") });
  assert.deepEqual(failed, { running: false, started: false, port: 1, reason: "no qmd" });
});

test("restartDaemon: waits for the old daemon to stop answering before starting a new one", async () => {
  const steps = [];
  let answering = 3;
  await restartDaemon({
    port: 8181,
    stopFn: () => ({ ok: true }),
    statusFn: async () => (steps.push("status"), { running: answering-- > 0 }),
    sleepFn: async () => steps.push("sleep"),
    ensureFn: async () => (steps.push("start"), { running: true }),
  });
  assert.deepEqual(steps, ["status", "sleep", "status", "sleep", "status", "sleep", "status", "start"]);

  // an old daemon that never stops does not hang the restart
  const stuck = await restartDaemon({
    port: 8181,
    stopFn: () => ({ ok: true }),
    statusFn: async () => ({ running: true }),
    sleepFn: async () => {},
    stopAttempts: 2,
    ensureFn: async () => ({ running: false, reason: "still the old one" }),
  });
  assert.equal(stuck.running, false);
});

// A fake fetch that behaves like the daemon: initialize, then `status` with a mutable document count.
function fakeDaemonFetch(state) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const reply = (result) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json", "mcp-session-id": "s1" }),
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    });
    if (body.method === "tools/call") {
      return reply({ structuredContent: { collections: [{ name: state.collection, documents: state.documents }] } });
    }
    return reply({});
  };
}

function refreshSetup({ served, restartResult = { running: true, started: true }, afterRestart, daemonOverrides = {} }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-refresh-"));
  const corpusDir = path.join(cwd, ".toolgate", "skills-index", "corpus");
  fs.mkdirSync(corpusDir, { recursive: true });
  for (const name of ["a.md", "b.md", "_index.md"]) fs.writeFileSync(path.join(corpusDir, name), "x");

  const state = { collection: defaultCollection(cwd), documents: served };
  const out = [];
  const err = [];
  const steps = [];
  return {
    cwd,
    out: () => out.join(""),
    err: () => err.join(""),
    steps,
    run: (config = {}, env = {}) =>
      refreshDaemonIfStale({
        cwd,
        config,
        env,
        stdout: { write: (s) => out.push(s) },
        stderr: { write: (s) => err.push(s) },
        fetchFn: fakeDaemonFetch(state),
        daemon: {
          status: async () => (steps.includes("stop") ? { running: false } : { running: true }),
          stop: () => (steps.push("stop"), { ok: true, message: "Stopped." }),
          ensure: async () => {
            steps.push("start");
            if (afterRestart !== undefined) state.documents = afterRestart;
            return restartResult;
          },
          ...daemonOverrides,
        },
      }),
  };
}

test("refreshDaemonIfStale: a daemon serving more documents than the corpus is left alone", async () => {
  const t = refreshSetup({ served: 7 });
  assert.equal(await t.run(), "fresh");
  assert.deepEqual(t.steps, []);
  assert.equal(t.out() + t.err(), "");
});

test("refreshDaemonIfStale: a daemon serving the same documents is left alone, silently", async () => {
  const t = refreshSetup({ served: 3 });
  assert.equal(await t.run(), "fresh");
  assert.deepEqual(t.steps, []);
  assert.equal(t.out() + t.err(), "");
});

test("refreshDaemonIfStale: a daemon serving fewer documents is restarted, and it says so", async () => {
  const t = refreshSetup({ served: 1, afterRestart: 3 });
  assert.equal(await t.run(), "restarted");
  assert.deepEqual(t.steps, ["stop", "start"]);
  assert.match(t.out(), /the qmd daemon serves 1 of the 3 documents of "skills-.*"; run "toolgate daemon restart"; restarting it/);
  assert.match(t.out(), /qmd daemon restarted/);
});

test("refreshDaemonIfStale: a restart that fails, or that does not fix it, is reported with the command to run", async () => {
  const cannot = refreshSetup({ served: 1, restartResult: { running: false, reason: "did not answer" } });
  assert.equal(await cannot.run(), "failed");
  assert.match(cannot.err(), /could not restart the qmd daemon \(did not answer\); run "toolgate daemon restart"/);

  const stillStale = refreshSetup({ served: 1, afterRestart: 1 });
  assert.equal(await stillStale.run(), "failed");
  assert.match(stillStale.err(), /restarted daemon still serves 1 of 3 documents.*toolgate skills index --force/);
});

test("refreshDaemonIfStale: nothing happens for a daemon that is remote, disabled, or not running", async () => {
  const t = refreshSetup({ served: 1 });
  assert.equal(await t.run({ router: { qmdUrl: "http://qmd.example.com:8181/mcp" } }), "skipped");
  assert.equal(await t.run({ router: { qmdUrl: null } }), "skipped");

  const down = refreshSetup({ served: 1 });
  const result = await refreshDaemonIfStale({
    cwd: down.cwd,
    config: {},
    stdout: { write() {} },
    stderr: { write() {} },
    daemon: { status: async () => ({ running: false }), stop: () => assert.fail("no stop"), ensure: async () => assert.fail("no start") },
  });
  assert.equal(result, "skipped");
  assert.deepEqual(t.steps, []);
});

test("refreshDaemonIfStale: when the daemon cannot say how many documents it has, nothing is restarted", async () => {
  const t = refreshSetup({ served: 1 });
  const result = await refreshDaemonIfStale({
    cwd: t.cwd,
    config: {},
    stdout: { write() {} },
    stderr: { write() {} },
    fetchFn: async () => {
      throw new Error("down");
    },
    daemon: { status: async () => ({ running: true }), stop: () => assert.fail("no stop"), ensure: async () => assert.fail("no start") },
  });
  assert.equal(result, "unknown");
});

// qmd's pid file names a process other than the one holding the port: that holder is not qmd's own.
const managedElsewhere = () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-managed-"));
  fs.mkdirSync(path.join(cache, "qmd"));
  fs.writeFileSync(path.join(cache, "qmd", "mcp.pid"), "1\n");
  process.on("exit", () => fs.rmSync(cache, { recursive: true, force: true }));
  return { XDG_CACHE_HOME: cache };
};
const stuckDaemon = (extra) => ({
  port: 8181,
  stopFn: () => ({ ok: true }),
  statusFn: async () => ({ running: true }),
  sleepFn: async () => {},
  stopAttempts: 2,
  ensureFn: async () => assert.fail("a daemon is never started over a process that still answers"),
  ...extra,
});
test("restartDaemon: a process toolgate did not start that keeps answering fails with its pid and the command, and starts nothing", async () => {
  const posix = await restartDaemon(stuckDaemon({ env: managedElsewhere(), holderFn: () => ({ pid: 4242, foreign: true }), platform: "linux" }));
  assert.deepEqual(posix, { running: false, started: false, port: 8181, reason: 'port 8181 is held by pid 4242, which toolgate did not start; stop it with "kill 4242" and run "toolgate daemon start"' });
  const windows = await restartDaemon(stuckDaemon({ env: managedElsewhere(), holderFn: () => ({ pid: 4242, foreign: true }), platform: "win32" }));
  assert.match(windows.reason, /stop it with "taskkill \/PID 4242"/);
});
test("restartDaemon: a port that still answers with no way to tell who holds it says so, with no pid", async () => {
  const result = await restartDaemon(stuckDaemon({ holderFn: () => ({ pid: null, foreign: null }) }));
  assert.equal(result.running, false);
  assert.equal(result.reason, 'port 8181 still answers after stopping the daemon, and toolgate cannot tell which process holds it; stop that process and run "toolgate daemon start"');
});
test("restartDaemon: after starting, a port held by a process that is not the one qmd manages is not reported as restarted", async () => {
  const base = { port: 8181, stopFn: () => ({ ok: true }), statusFn: async () => ({ running: false }), ensureFn: async () => ({ running: true, started: true, url: "u" }) };
  const foreign = await restartDaemon({ ...base, holderFn: () => ({ pid: 77, foreign: true }), platform: "linux" });
  assert.deepEqual([foreign.running, foreign.reason], [false, 'port 8181 is held by pid 77, which toolgate did not start; stop it with "kill 77" and run "toolgate daemon start"']);
  for (const holder of [{ pid: 77, foreign: false }, { pid: null, foreign: null }]) {
    assert.equal((await restartDaemon({ ...base, holderFn: () => holder })).running, true);
  }
});
test("refreshDaemonIfStale: a process toolgate did not start that still holds the port after the stop is named, not restarted over", async () => {
  const t = refreshSetup({
    served: 1,
    daemonOverrides: { status: async () => ({ running: true }), holder: () => ({ pid: 4321, foreign: true }), sleep: async () => {} },
  });
  const env = { XDG_CACHE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fresh-cache-")) };
  fs.mkdirSync(path.join(env.XDG_CACHE_HOME, "qmd"));
  fs.writeFileSync(path.join(env.XDG_CACHE_HOME, "qmd", "mcp.pid"), "99999\n");
  assert.equal(await t.run({}, env), "failed");
  assert.match(t.err(), /port \d+ is held by pid 4321, which toolgate did not start; stop it with "kill 4321"/);
  assert.deepEqual(t.steps, ["stop"], "nothing was started on top of it");
});
