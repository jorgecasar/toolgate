// toolgate init and the port of the qmd daemon (#136): a port held by a process toolgate did not start is moved away from.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heldMessage, nextFreePort } from "../src/daemon.js";
import { runInit } from "../src/init.js";
import { tierZeroRegistry } from "./support/tierZeroRegistry.js";
import { git as hermeticGit } from "./support/git.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-ip-")));
  made.push(dir);
  return dir;
};
const PORT = 18299;
const FOREIGN = { pid: 4321, foreign: true };
const FREE = async () => true;
const UNCHANGED = { qmd: { port: PORT } };

// Runs init with qmd available, a fake daemon and a user config in a throwaway folder.
async function init({ holder, status = { running: false }, probePort = FREE, ask, interactive = false, yes = false, dryRun = false, env = {}, local, userPort = PORT, track = false, daemonHolder, projectConfig, skills = false }) {
  const cwd = tmp();
  if (skills) {
    fs.mkdirSync(path.join(cwd, ".toolgate", "skills", "demo"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".toolgate", "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: a demo skill\n---\nbody\n");
  }
  if (local) hermeticGit(cwd, "init", "-q");
  else fs.mkdirSync(path.join(cwd, ".git"));
  const user = path.join(tmp(), "config.json");
  fs.writeFileSync(user, JSON.stringify(userPort === null ? {} : { qmd: { port: userPort } }));
  if (local) {
    fs.mkdirSync(path.join(cwd, ".toolgate"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".toolgate", "config.local.json"), JSON.stringify(local));
    if (track) hermeticGit(cwd, "add", ".toolgate/config.local.json");
  }
  if (projectConfig) {
    fs.mkdirSync(path.join(cwd, ".toolgate"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify(projectConfig));
  }
  const ensures = [];
  const asked = [];
  const out = [];
  const kills = [];
  const realKill = process.kill;
  process.kill = (...args) => (kills.push(args), true);
  try {
    const code = await runInit({
      cwd,
      env: { TOOLGATE_DEFAULTS: user, ...env },
      stdout: { write: (s) => out.push(s) },
      execFn: (bin) => {
        if (bin === "qmd") return "1.0.0";
        throw new Error(`no ${bin}`);
      },
      daemon: { ensure: async (options) => (ensures.push(options.port), { running: true, started: true, url: `http://localhost:${options.port}/mcp` }), status: async () => status, holder: daemonHolder ?? (() => holder) },
      probePort,
      registry: tierZeroRegistry,
      backend: "qmd",
      interactive,
      yes,
      dryRun,
      ask: async (question, options) => (asked.push(question), ask?.(question, options)),
    });
    return { code, ensures, asked, kills, localConfig: local ? fs.readFileSync(path.join(cwd, ".toolgate", "config.local.json"), "utf8") : null, out: out.join(""), userConfig: JSON.parse(fs.readFileSync(user, "utf8")) };
  } finally {
    process.kill = realKill;
  }
}
const LINE = (free) => `toolgate: port ${PORT} is held by pid 4321, which toolgate did not start; using ${free} and saving qmd.port in your user config\n`;
const hint = (free) => `run "toolgate config set qmd.port ${free} --user" and "toolgate daemon start"`;

test("nextFreePort: the first port from 8182 where the probe says nothing listens, up to 8281", async () => {
  assert.equal(await nextFreePort(8182, { probe: FREE }), 8182);
  const busy = new Set([8182, 8183]);
  assert.equal(await nextFreePort(8182, { probe: async (port) => !busy.has(port) }), 8184);
  assert.equal(await nextFreePort(8182, { probe: async (port) => port === 8281 }), 8281);
  assert.equal(await nextFreePort(8182, { probe: async () => false }), null);
  const seen = [];
  await nextFreePort(8182, { probe: async (port) => (seen.push(port), false) });
  assert.deepEqual([seen[0], seen.at(-1), seen.length], [8182, 8281, 100]);
});
test("a free port, or one held by a daemon toolgate started: nothing is written and the daemon starts on it", async () => {
  for (const holder of [{ pid: null, foreign: null }, { pid: 77, foreign: false }]) {
    const result = await init({ holder, yes: true });
    assert.deepEqual(result.ensures, [PORT]);
    assert.deepEqual(result.userConfig, UNCHANGED);
    assert.doesNotMatch(result.out, /held by pid/);
  }
});
test("a foreign holder with --yes: says so, saves qmd.port in the user config and starts the daemon there", async () => {
  const result = await init({ holder: FOREIGN, yes: true });
  assert.ok(result.out.includes(LINE(8182)), result.out);
  assert.deepEqual(result.userConfig, { qmd: { port: 8182 } });
  assert.deepEqual(result.ensures, [8182]);
  assert.deepEqual(result.kills, [], "the foreign process is never signalled");
  assert.equal(result.code, 0);
});
test("a busy port in the way is skipped", async () => {
  const result = await init({ holder: FOREIGN, yes: true, probePort: async (port) => port > 8183 });
  assert.deepEqual(result.userConfig, { qmd: { port: 8184 } });
  assert.deepEqual(result.ensures, [8184]);
});
test("in a terminal it asks first: yes (also the empty answer) saves and starts, no writes and starts nothing", async () => {
  for (const reply of ["", "y", "Y", "yes"]) {
    const result = await init({ holder: FOREIGN, interactive: true, ask: (question) => (question.startsWith("use port") ? reply : "") });
    assert.deepEqual(result.asked.filter((question) => question.startsWith("use port")), ["use port 8182 and save it in your user config? [Y/n] "]);
    assert.deepEqual(result.userConfig, { qmd: { port: 8182 } }, JSON.stringify(reply));
    assert.deepEqual(result.ensures, [8182]);
  }
  for (const reply of ["n", "N", "no", null]) {
    const result = await init({ holder: FOREIGN, interactive: true, ask: (question) => (question.startsWith("use port") ? reply : "") });
    assert.deepEqual(result.userConfig, UNCHANGED, JSON.stringify(reply));
    assert.deepEqual(result.ensures, []);
    assert.ok(result.out.includes(`  - ${hint(8182)}`), result.out);
    assert.deepEqual(result.kills, []);
  }
});
test("without a terminal and without --yes: nothing is written or started, and a note says how", async () => {
  const result = await init({ holder: FOREIGN });
  assert.deepEqual(result.asked, []);
  assert.deepEqual(result.userConfig, UNCHANGED);
  assert.deepEqual(result.ensures, []);
  assert.ok(result.out.includes(`  - ${hint(8182)}`), result.out);
  assert.doesNotMatch(result.out, /using 8182/);
});
test("--dry-run only says what it would do", async () => {
  const result = await init({ holder: FOREIGN, dryRun: true, yes: true });
  assert.ok(result.out.includes("  would use port 8182 and save qmd.port in your user config"), result.out);
  assert.deepEqual(result.userConfig, UNCHANGED);
  assert.deepEqual(result.ensures, []);
  assert.deepEqual(result.asked, []);
});
test("a holder whose pid is not known, or no free port in 8182-8281: only a note, nothing written", async () => {
  const unknown = await init({ holder: { pid: null, foreign: null }, status: { running: true }, yes: true });
  assert.ok(unknown.out.includes(`  - ${heldMessage(PORT, null)}`), unknown.out);
  assert.deepEqual(unknown.userConfig, UNCHANGED);
  assert.deepEqual(unknown.ensures, [PORT]);
  const full = await init({ holder: FOREIGN, yes: true, probePort: async () => false });
  assert.ok(full.out.includes(`  - ${heldMessage(PORT, 4321)}`), full.out);
  assert.deepEqual(full.userConfig, UNCHANGED);
  assert.deepEqual(full.ensures, [PORT]);
  assert.deepEqual(full.kills, []);
});
const note = (from, free = 8182) => `toolgate: port ${PORT} comes from ${from} and is held by pid 4321, which toolgate did not start; change it there (port ${free} is free)`;
test("Ctrl+D at the port question is a no: nothing is written or started, and the note is left; Enter is still yes", async () => {
  const closed = await init({ holder: FOREIGN, interactive: true, ask: (question, options) => (question.startsWith("use port") ? options.onEnd : "") });
  assert.deepEqual(closed.userConfig, UNCHANGED);
  assert.deepEqual(closed.ensures, []);
  assert.ok(closed.out.includes(`  - ${hint(8182)}`), closed.out);
  const enter = await init({ holder: FOREIGN, interactive: true, ask: () => "" });
  assert.deepEqual(enter.userConfig, { qmd: { port: 8182 } });
});
test("askInTerminal: closing the input answers onEnd, \"\" by default", async () => {
  const { PassThrough } = await import("node:stream");
  const { askInTerminal } = await import("../src/init.js");
  for (const [options, expected] of [[{}, ""], [{ onEnd: null }, null]]) {
    const input = new PassThrough();
    const answer = askInTerminal("q? ", { input, output: new PassThrough(), terminal: true, ...options });
    input.end();
    assert.equal(await answer, expected);
  }
});
test("a busy port set by QMD_SHARED_PORT or a local router.qmdUrl: a note, nothing written, asked or started, also with --yes", async () => {
  for (const [from, options] of [
    ["QMD_SHARED_PORT", { env: { QMD_SHARED_PORT: String(PORT) } }],
    ["router.qmdUrl", { local: { router: { qmdUrl: `http://localhost:${PORT}/mcp` } } }],
    ["router.qmdUrl", { env: { QMD_SHARED_PORT: "18111" }, local: { router: { qmdUrl: `http://localhost:${PORT}/mcp` } } }],
  ]) {
    for (const mode of [{ yes: true }, { interactive: true, ask: () => "y" }]) {
      const result = await init({ holder: FOREIGN, ...options, ...mode });
      assert.ok(result.out.includes(`  - ${note(from)}`), from + JSON.stringify(options) + result.out);
      assert.deepEqual(result.userConfig, UNCHANGED);
      assert.deepEqual(result.ensures, []);
      assert.deepEqual(result.asked.filter((question) => question.startsWith("use port")), []);
      assert.deepEqual(result.kills, []);
    }
  }
});
test("an override with --dry-run prints the note as a would line; without a free port or with an unknown holder it is #193's text", async () => {
  const env = { QMD_SHARED_PORT: String(PORT) };
  const dry = await init({ holder: FOREIGN, env, dryRun: true });
  assert.ok(dry.out.includes(`  would leave this note: ${note("QMD_SHARED_PORT")}`), dry.out);
  assert.deepEqual(dry.userConfig, UNCHANGED);
  const full = await init({ holder: FOREIGN, env, yes: true, probePort: async () => false });
  assert.ok(full.out.includes(`  - ${heldMessage(PORT, 4321)}`), full.out);
  assert.doesNotMatch(full.out, /comes from/);
  const unknown = await init({ holder: { pid: null, foreign: null }, status: { running: true }, env, yes: true });
  assert.ok(unknown.out.includes(`  - ${heldMessage(PORT, null)}`), unknown.out);
});
test("an override that is free or held by our daemon starts it there; qmd.port decides when nothing overrides", async () => {
  const result = await init({ holder: { pid: 77, foreign: false }, env: { QMD_SHARED_PORT: String(PORT) }, yes: true });
  assert.deepEqual(result.ensures, [PORT]);
  const own = await init({ holder: FOREIGN, yes: true });
  assert.deepEqual(own.userConfig, { qmd: { port: 8182 } });
});
test("a busy port from qmd.port in an unversioned local config is an override: a note, nothing written in either layer, asked or started", async () => {
  const local = { qmd: { port: PORT } };
  for (const mode of [{ yes: true }, { interactive: true, ask: () => "y" }]) {
    const result = await init({ holder: FOREIGN, local, userPort: 17777, ...mode });
    assert.ok(result.out.includes(`  - ${note("qmd.port in the local config")}`), result.out);
    assert.deepEqual(result.userConfig, { qmd: { port: 17777 } });
    assert.equal(result.localConfig, JSON.stringify(local));
    assert.deepEqual(result.ensures, []);
    assert.deepEqual(result.asked.filter((question) => question.startsWith("use port")), []);
    assert.deepEqual(result.kills, []);
  }
  const dry = await init({ holder: FOREIGN, local, userPort: 17777, dryRun: true });
  assert.ok(dry.out.includes(`  would leave this note: ${note("qmd.port in the local config")}`), dry.out);
});
test("qmd.port in the user layer is no override, and neither is one in a local config git tracks", async () => {
  const user = await init({ holder: FOREIGN, local: { qmd: {} }, yes: true });
  assert.deepEqual(user.userConfig, { qmd: { port: 8182 } });
  assert.deepEqual(user.ensures, [8182]);
  const tracked = await init({ holder: FOREIGN, local: { qmd: { port: PORT } }, track: true, yes: true });
  assert.doesNotMatch(tracked.out, /comes from/);
  assert.deepEqual(tracked.userConfig, { qmd: { port: 8182 } });
});
test("with a not parseable router.qmdUrl, init keeps the port of QMD_SHARED_PORT and qmd.port, and names them as the source", async () => {
  for (const qmdUrl of ["not a url"]) {
    const local = { router: { qmdUrl } };
    const fromUser = await init({ holder: { pid: null, foreign: null }, local, yes: true });
    assert.deepEqual(fromUser.ensures, [PORT], String(qmdUrl));
    const fromEnv = await init({ holder: FOREIGN, local, env: { QMD_SHARED_PORT: String(PORT) }, userPort: 17777, yes: true });
    assert.ok(fromEnv.out.includes(`  - ${note("QMD_SHARED_PORT")}`), `${qmdUrl}\n${fromEnv.out}`);
    assert.deepEqual(fromEnv.ensures, []);
    const fromLocal = await init({ holder: FOREIGN, local: { router: { qmdUrl }, qmd: { port: PORT } }, userPort: 17777, yes: true });
    assert.ok(fromLocal.out.includes(`  - ${note("qmd.port in the local config")}`), `${qmdUrl}\n${fromLocal.out}`);
    // The port is not taken from the URL; an unparseable one is said as the other commands say it, a remote one is simply valid.
    if (qmdUrl === "not a url") assert.match(fromLocal.out, /router\.qmdUrl in the local config is ignored: it must be an http or https URL, or null/);
    else assert.doesNotMatch(fromLocal.out, /router\.qmdUrl/);
  }
});
test("no qmd.port in any layer: a foreign holder of the default port is #227's flow, never an override", async () => {
  for (const local of [undefined, {}, { qmd: {} }, { qmd: { port: 70000 } }, { qmd: { port: "x" } }]) {
    const result = await init({ holder: FOREIGN, local, userPort: null, yes: true });
    assert.doesNotMatch(result.out, /comes from/, JSON.stringify(local));
    assert.deepEqual(result.userConfig, { qmd: { port: 8182 } }, JSON.stringify(local));
    assert.deepEqual(result.ensures, [8182], JSON.stringify(local));
  }
});
test("--dry-run with any override prints only the note, never that it would start the daemon", async () => {
  for (const options of [{ env: { QMD_SHARED_PORT: String(PORT) } }, { local: { router: { qmdUrl: `http://localhost:${PORT}/mcp` } } }, { local: { qmd: { port: PORT } } }]) {
    const result = await init({ holder: FOREIGN, dryRun: true, ...options });
    assert.match(result.out, /would leave this note: /, JSON.stringify(options));
    assert.doesNotMatch(result.out, /would start the qmd daemon/, JSON.stringify(options));
  }
  const plain = await init({ holder: FOREIGN, dryRun: true });
  assert.match(plain.out, /would start the qmd daemon/);
});
test("a valid local qmd.port is an override even when it equals the user's; an invalid one is never named as the source", async () => {
  const same = await init({ holder: FOREIGN, local: { qmd: { port: PORT } }, yes: true });
  assert.ok(same.out.includes(`  - ${note("qmd.port in the local config")}`), same.out);
  assert.deepEqual(same.userConfig, UNCHANGED);
  for (const port of [0, 70000, "x", 1.5]) {
    const result = await init({ holder: FOREIGN, local: { qmd: { port } }, yes: true });
    assert.doesNotMatch(result.out, /comes from/, String(port));
    assert.deepEqual(result.userConfig, { qmd: { port: 8182 } }, String(port));
  }
});

const OFF = "qmd daemon not started: router.qmdUrl is null, so routing uses the qmd CLI";
const OFF_DRY = "would not start the qmd daemon: router.qmdUrl is null, so routing uses the qmd CLI";
test("a trusted router.qmdUrl null: no daemon, no holder lookup, no question, no qmd.port, whatever holds the port", async () => {
  for (const holder of [{ pid: null, foreign: null }, FOREIGN]) {
    for (const mode of [{ yes: true }, { interactive: true, ask: async () => "y" }, {}]) {
      let looked = 0;
      const result = await init({ holder, local: { router: { qmdUrl: null } }, userPort: null, ...mode, daemonHolder: () => (looked++, holder) });
      assert.deepEqual(result.ensures, [], "nothing is started");
      assert.deepEqual(result.asked.filter((q) => /port|daemon/i.test(q)), [], "no question about the port");
      assert.equal(looked, 0, "no holder lookup");
      assert.deepEqual(result.userConfig, {}, "no qmd.port");
      assert.ok(result.out.includes(`  ${OFF}\n`), result.out);
      assert.doesNotMatch(result.out, /qmd daemon (started|already)|held by/);
    }
  }
});
test("--dry-run with a trusted router.qmdUrl null says it would not start the daemon, and writes nothing", async () => {
  const result = await init({ holder: FOREIGN, local: { router: { qmdUrl: null } }, userPort: null, dryRun: true, yes: true });
  assert.ok(result.out.includes(`  ${OFF_DRY}\n`), result.out);
  assert.doesNotMatch(result.out, /would start the qmd daemon|qmd daemon not started/);
  assert.deepEqual(result.ensures, []);
  assert.deepEqual(result.userConfig, {});
});
test("an empty router.qmdUrl, or a null that a tracked local config sets, is not off: the daemon starts as today", async () => {
  const empty = await init({ holder: { pid: null, foreign: null }, local: { router: { qmdUrl: "" } }, yes: true });
  assert.deepEqual(empty.ensures, [PORT]);
  assert.doesNotMatch(empty.out, /qmd daemon not started/);
  const tracked = await init({ holder: { pid: null, foreign: null }, local: { router: { qmdUrl: null } }, track: true, yes: true });
  assert.deepEqual(tracked.ensures, [PORT], "the trust rule ignores a null in a file git tracks");
  assert.doesNotMatch(tracked.out, /qmd daemon not started/);
});
test("a null only in the project config (.toolgate/config.json) is ignored by the trust rule: the daemon starts as today", async () => {
  const result = await init({ holder: { pid: null, foreign: null }, projectConfig: { router: { qmdUrl: null } }, yes: true });
  assert.deepEqual(result.ensures, [PORT]);
  assert.doesNotMatch(result.out, /qmd daemon not started/);
  assert.match(result.out, /qmd daemon started on/);
});
const REMOTE = (origin) => `router.qmdUrl points to ${origin}, which toolgate does not manage`;
test("a remote router.qmdUrl: no daemon, no holder lookup, no question, no qmd.port, whatever holds the port; only the origin is printed", async () => {
  const url = "https://u:secret@qmd.example.com:9443/mcp/deep?token=abc#frag";
  for (const holder of [{ pid: null, foreign: null }, FOREIGN]) {
    for (const mode of [{ yes: true }, { interactive: true, ask: async () => "y" }, {}]) {
      let looked = 0;
      const result = await init({ holder, local: { router: { qmdUrl: url } }, userPort: null, ...mode, daemonHolder: () => (looked++, holder) });
      assert.deepEqual(result.ensures, [], "nothing is started");
      assert.deepEqual(result.asked.filter((q) => /port|daemon/i.test(q)), []);
      assert.equal(looked, 0, "no holder lookup");
      assert.deepEqual(result.userConfig, {});
      assert.ok(result.out.includes(`  qmd daemon not started: ${REMOTE("https://qmd.example.com:9443")}\n`), result.out);
      assert.doesNotMatch(result.out, /secret|token|frag|deep|u:/);
      assert.doesNotMatch(result.out, /qmd daemon (started|already)|held by/);
    }
  }
});
test("--dry-run with a remote router.qmdUrl says it would not start the daemon, still reports the index, and writes nothing", async () => {
  const result = await init({ holder: FOREIGN, local: { router: { qmdUrl: "https://u:secret@qmd.example.com/mcp?token=abc" } }, userPort: null, dryRun: true, yes: true, skills: true });
  assert.ok(result.out.includes(`  would not start the qmd daemon: ${REMOTE("https://qmd.example.com")}\n`), result.out);
  assert.doesNotMatch(result.out, /secret|token|would start the qmd daemon/);
  assert.match(result.out, /would index /);
  assert.deepEqual(result.ensures, []);
  assert.deepEqual(result.userConfig, {});
});
test("a router.qmdUrl of another scheme never reaches init's line: no \"points to\", and the flow is today's", async () => {
  for (const qmdUrl of ["file:///x", "data:text/plain,x", "javascript:alert(1)", "ftp://h/"]) {
    const result = await init({ holder: { pid: null, foreign: null }, local: { router: { qmdUrl } }, yes: true, dryRun: true });
    assert.doesNotMatch(result.out, /points to|which toolgate does not manage|null,/, qmdUrl);
  }
});
test("a local router.qmdUrl, an unparseable one, and a remote one only in the project config keep today's flow", async () => {
  const local = await init({ holder: { pid: null, foreign: null }, local: { router: { qmdUrl: `http://localhost:${PORT}/mcp` } }, yes: true });
  assert.deepEqual(local.ensures, [PORT]);
  const garbage = await init({ holder: { pid: null, foreign: null }, local: { router: { qmdUrl: "not a url" } }, yes: true });
  assert.deepEqual(garbage.ensures, [PORT]);
  const project = await init({ holder: { pid: null, foreign: null }, projectConfig: { router: { qmdUrl: "https://qmd.example.com/mcp" } }, yes: true });
  assert.deepEqual(project.ensures, [PORT]);
  for (const result of [local, garbage, project]) assert.doesNotMatch(result.out, /qmd daemon not started|which toolgate does not manage/);
});
test("the upper end of qmd.port: init takes 65535 in the user or the local config and ignores 65536, which is not a port", async () => {
  const free = { pid: null, foreign: null };
  assert.deepEqual((await init({ userPort: 65535, holder: free })).ensures, [65535]);
  assert.deepEqual((await init({ userPort: 65536, holder: free })).ensures, [8181], "an invalid user value falls to the default");
  assert.deepEqual((await init({ local: { qmd: { port: 65535 } }, holder: free })).ensures, [65535]);
  const beyondLocal = (await init({ local: { qmd: { port: 65536 } }, holder: free })).ensures;
  assert.ok(beyondLocal.length === 1 && [PORT, 8181].includes(beyondLocal[0]), `an invalid local value is never the port: ${beyondLocal}`);
  const held = await init({ local: { qmd: { port: 65535 } }, holder: FOREIGN, yes: true });
  assert.match(held.out, /port 65535 comes from qmd\.port in the local config and is held by pid 4321/);
  const beyond = await init({ local: { qmd: { port: 65536 } }, holder: FOREIGN, yes: true });
  assert.doesNotMatch(beyond.out, /comes from qmd\.port in the local config/, "an invalid value is never named as the source");
});
