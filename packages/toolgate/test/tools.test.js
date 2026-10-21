// `toolgate tools enable|disable|status|reset` (#19 T8): exact texts, exit codes, --json, and the baseline that stays.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { runTools } from "../src/tools.js";
import { createSession, readSession } from "../src/session.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (label = "tools") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-${label}-`)));
  made.push(dir);
  return dir;
};
const NOTE = "note: a tool already used stays in the conversation; this only stops it from being offered\n";

// A session with `repo` (baseline: list, get) and `docs` (no baseline), made as the launcher makes it, for a project folder that has its
// own config; the CLI is called from `cwd`, which is not necessarily the project (the config of `cwd` is never read for the baseline).
function setup({ baselines = { repo: ["list", "get"] }, cwd } = {}) {
  const env = { XDG_STATE_HOME: tmp("state"), HOME: tmp("home") };
  const projectDir = tmp("proj");
  const { file } = createSession([{ server: "repo", baseline: baselines.repo ?? [] }, { server: "docs", baseline: baselines.docs ?? [] }], { env, projectDir });
  const out = [];
  const err = [];
  const call = (args, { sessionEnv = { TOOLGATE_SESSION_STATE: file }, config = () => ({ toolBaselines: { repo: ["WRONG"] } }) } = {}) => {
    out.length = 0;
    err.length = 0;
    return run(["tools", ...args], {
      cwd: cwd ?? tmp("cwd"),
      env: { ...env, ...sessionEnv },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: config,
    }).then((code) => ({ code, out: out.join(""), err: err.join("") }));
  };
  return { env, file, projectDir, call, state: () => readSession(file, { env }) };
}

test("outside a toolgate session: the exact line and exit 1, for every action", async () => {
  const { call } = setup();
  for (const args of [["enable", "repo", "x"], ["disable", "repo"], ["status"], ["reset"]]) {
    const result = await call(args, { sessionEnv: { TOOLGATE_SESSION_STATE: "" } });
    assert.deepEqual([result.code, result.out, result.err], [1, "", "toolgate: no toolgate session here (TOOLGATE_SESSION_STATE is not set); launch the agent with toolgate\n"], args.join(" "));
  }
});

test("a path outside the sessions folder, a link or an open file is refused with the exact line", async () => {
  const { call, file, env } = setup();
  const elsewhere = path.join(tmp("else"), path.basename(file));
  fs.copyFileSync(file, elsewhere);
  const out = await call(["status"], { sessionEnv: { TOOLGATE_SESSION_STATE: elsewhere } });
  assert.deepEqual([out.code, out.err], [1, "toolgate: TOOLGATE_SESSION_STATE is not a toolgate session file\n"]);
  fs.chmodSync(file, 0o644);
  const open = await call(["status"]);
  assert.equal(open.code, 1);
  assert.match(open.err, /is not a private file of yours; its tools are revealed only by a restart this session\n$/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "{not json", { mode: 0o600 });
  const corrupt = await call(["enable", "repo", "x"]);
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.err, /could not be read \(not valid\)/);
  assert.equal(fs.readFileSync(file, "utf8"), "{not json", "never overwritten");
  assert.ok(env);
});

test("a server that is not dynamic in this session: the exact line and exit 1, nothing written", async () => {
  const { call, state } = setup();
  const before = JSON.stringify(state());
  for (const args of [["enable", "ghost", "x"], ["disable", "ghost"], ["status", "ghost"], ["reset", "ghost"], ["enable", "constructor", "x"]]) {
    const result = await call(args);
    assert.deepEqual([result.code, result.out, result.err], [1, "", `toolgate: ${args[1]} is not a dynamic server of this session\n`], args.join(" "));
  }
  assert.equal(JSON.stringify(state()), before);
});

test("a tool name that is not a safe name: the exact line and exit 1, nothing written", async () => {
  const { call, state } = setup();
  for (const tool of ["bad name", "../x", "a;b", "", "x".repeat(200), "-lead"]) {
    const result = await call(["enable", "repo", "ok", tool]);
    assert.deepEqual([result.code, result.out, result.err], [1, "", `toolgate: "${tool}" is not a valid tool name\n`], JSON.stringify(tool));
  }
  assert.equal((await call(["disable", "repo", "bad name"])).code, 1);
  assert.deepEqual(state().servers.repo.enabled, []);
});

test("enable: reveals the tools (a union), prints the exact line, and a second enable keeps the first", async () => {
  const { call, state } = setup();
  assert.deepEqual(await call(["enable", "docs", "search", "read"]), { code: 0, out: "enabled docs: search, read\n", err: "" });
  assert.deepEqual(state().servers.docs.enabled, ["search", "read"]);
  assert.deepEqual(await call(["enable", "docs", "read", "write"]), { code: 0, out: "enabled docs: read, write\n", err: "" });
  assert.deepEqual(state().servers.docs.enabled, ["search", "read", "write"]);
  assert.deepEqual(await call(["enable", "docs", "dup", "dup"]), { code: 0, out: "enabled docs: dup\n", err: "" });
  assert.equal((await call(["enable", "docs"])).code, 1, "a tool is required");
  assert.equal((await call(["enable"])).code, 1, "a server is required");
});

test("enable: a tool that is not in the catalog card is enabled anyway, with a warning; the card is looked up in the session's project", () => {
  const { env, file, projectDir } = setup();
  const out = [];
  const err = [];
  const seen = [];
  const card = { servers: new Map([["docs", { tools: [{ name: "search" }, { name: "read" }] }]]) };
  const base = { env: { ...env, TOOLGATE_SESSION_STATE: file }, loadConfigFn: () => ({}), stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  const code = runTools(["enable", "docs", "search", "ghost"], { ...base, readCatalogFn: (config, dir) => (seen.push(dir), card) });
  assert.equal(code, 0);
  assert.equal(out.join(""), "enabled docs: search, ghost\n");
  assert.equal(err.join(""), "warning: ghost is not in the catalog card of docs\n");
  assert.deepEqual(seen, [projectDir], "the project of the session, not the folder it was run from");
  assert.deepEqual(readSession(file, { env }).servers.docs.enabled, ["search", "ghost"]);
  err.length = 0;
  runTools(["enable", "repo", "anything"], { ...base, readCatalogFn: () => card });
  assert.deepEqual(err, [], "a server with no card: nothing to compare with");
  runTools(["enable", "docs", "x"], { ...base, readCatalogFn: () => { throw new Error("unreadable"); } });
  assert.deepEqual(err, [], "a catalog that cannot be read: no warning");
  runTools(["enable", "docs", "y"], { ...base, loadConfigFn: () => { throw new Error("bad config"); }, readCatalogFn: () => card });
  assert.match(err.join(""), /warning: y is not in the catalog card of docs/, "a config that cannot be read still finds the default catalog");
});

test("disable: with tools removes those, without tools all that were revealed, and the baseline stays", async () => {
  const { call, state } = setup();
  await call(["enable", "repo", "merge", "close", "list"]);
  assert.deepEqual(await call(["disable", "repo", "merge"]), { code: 0, out: `disabled repo: merge\n${NOTE}`, err: "" });
  assert.deepEqual(state().servers.repo.enabled, ["close", "list"]);
  const all = await call(["disable", "repo"]);
  assert.deepEqual([all.code, all.out, all.err], [0, `disabled repo: close\n${NOTE}`, ""], "list is in the baseline: it stays offered, so it is not listed");
  assert.deepEqual(state().servers.repo.enabled, []);
  const status = await call(["status", "repo"]);
  assert.equal(status.out, "repo: list, get\n", "the baseline tools are still offered");
  const baselineTool = await call(["disable", "repo", "list"]);
  assert.equal(baselineTool.code, 0);
  assert.equal(baselineTool.err, "warning: list is in toolBaselines of repo and stays offered\n");
  assert.equal(baselineTool.out, `disabled repo: none\n${NOTE}`);
  assert.equal((await call(["status", "repo"])).out, "repo: list, get\n");
  assert.equal((await call(["disable"])).code, 1, "a server is required");
});

test("status: the offered tools or only the sentinel, for one server or all, and --json", async () => {
  const { call } = setup();
  assert.deepEqual(await call(["status"]), { code: 0, out: "repo: list, get\ndocs: only the sentinel\n", err: "" });
  await call(["enable", "docs", "search"]);
  await call(["enable", "repo", "merge", "get"]);
  assert.equal((await call(["status"])).out, "repo: list, get, merge\ndocs: search\n");
  assert.equal((await call(["status", "docs"])).out, "docs: search\n");
  assert.deepEqual(JSON.parse((await call(["status", "--json"])).out), { servers: { repo: { enabled: ["merge", "get"], offered: ["list", "get", "merge"] }, docs: { enabled: ["search"], offered: ["search"] } } });
  assert.deepEqual(JSON.parse((await call(["status", "docs", "--json"])).out), { servers: { docs: { enabled: ["search"], offered: ["search"] } } });
  
  const noBaseline = setup({ baselines: {} });
  assert.equal((await noBaseline.call(["status"])).out, "repo: only the sentinel\ndocs: only the sentinel\n");
});

test("reset: one server or every server back to the baseline, with the note once", async () => {
  const { call, state } = setup();
  await call(["enable", "repo", "a"]);
  await call(["enable", "docs", "b"]);
  assert.deepEqual(await call(["reset", "docs"]), { code: 0, out: `reset docs\n${NOTE}`, err: "" });
  assert.deepEqual([state().servers.repo.enabled, state().servers.docs.enabled], [["a"], []]);
  assert.deepEqual(await call(["reset"]), { code: 0, out: `reset repo\nreset docs\n${NOTE}`, err: "" });
  assert.deepEqual([state().servers.repo.enabled, state().servers.docs.enabled], [[], []]);
  assert.equal((await call(["status", "repo"])).out, "repo: list, get\n");
});

test("an unknown action, or none, prints the usage and exits 1", async () => {
  const { call } = setup();
  for (const args of [[], ["frobnicate"], ["--json"]]) {
    const result = await call(args);
    assert.equal(result.code, 1);
    assert.match(result.err, /^toolgate tools: use enable <server> <tool\.\.\.>, disable <server> \[tool\.\.\.\], status \[server\] \[--json\] or reset \[server\]\n$/);
  }
});

test("the baseline is the session's: the same from a sub-folder or any folder, and a config changed or broken since the launch changes nothing", async () => {
  const project = tmp("project");
  const sub = path.join(project, "deep", "sub");
  fs.mkdirSync(sub, { recursive: true });
  const { call } = setup({ cwd: sub });
  assert.equal((await call(["status"])).out, "repo: list, get\ndocs: only the sentinel\n", "from a sub-folder, with a config that says something else");
  const broken = () => { throw new Error("config is broken now"); };
  assert.deepEqual(await call(["status"], { config: broken }), { code: 0, out: "repo: list, get\ndocs: only the sentinel\n", err: "" });
  assert.deepEqual(JSON.parse((await call(["status", "--json"], { config: broken })).out).servers.repo, { enabled: [], offered: ["list", "get"] });
  const warned = await call(["disable", "repo", "list"], { config: broken });
  assert.equal(warned.err, "warning: list is in toolBaselines of repo and stays offered\n", "the baseline warning does not depend on the config");
  await call(["enable", "repo", "merge"]);
  assert.equal((await call(["status", "repo"], { config: () => ({ toolBaselines: { repo: ["other"] } }) })).out, "repo: list, get, merge\n");
});

test("disable says only what is no longer offered: a revealed tool that is also in the baseline stays, with the warning, and exits 0", async () => {
  const { call, state } = setup();
  await call(["enable", "repo", "get", "newtool"]);
  const result = await call(["disable", "repo", "get", "newtool"]);
  assert.deepEqual([result.code, result.out, result.err], [0, `disabled repo: newtool\n${NOTE}`, "warning: get is in toolBaselines of repo and stays offered\n"]);
  assert.deepEqual(state().servers.repo.enabled, []);
  assert.equal((await call(["status", "repo"])).out, "repo: list, get\n");
  const only = await call(["disable", "repo", "list"]);
  assert.deepEqual([only.code, only.out], [0, `disabled repo: none\n${NOTE}`]);
  await call(["enable", "repo", "get"]);
  const all = await call(["disable", "repo"]);
  assert.equal(all.out, `disabled repo: none\n${NOTE}`, "get is revealed but still offered by the baseline, so nothing is taken away");
  assert.deepEqual(state().servers.repo.enabled, []);
});

test("extra arguments are refused with nothing written", async () => {
  const { call, state } = setup();
  await call(["enable", "repo", "a"]);
  const before = JSON.stringify(state());
  for (const [args, action] of [[["status", "repo", "extra"], "status"], [["status", "repo", "extra", "more"], "status"], [["reset", "repo", "extra"], "reset"], [["reset", "a", "b"], "reset"]]) {
    const result = await call(args);
    assert.deepEqual([result.code, result.out, result.err], [1, "", `toolgate tools ${action}: it takes at most one server name\n`], args.join(" "));
  }
  assert.equal(JSON.stringify(state()), before);
});

test("more than 1024 revealed tools in a server: the write-failure text with the cap as the reason, nothing written", async () => {
  const { call, state, file } = setup();
  const many = Array.from({ length: 1024 }, (_, i) => `t${i}`);
  assert.equal((await call(["enable", "docs", ...many])).code, 0, "1024 fit");
  const result = await call(["enable", "docs", "one-more"]);
  assert.deepEqual([result.code, result.out], [1, ""]);
  assert.equal(result.err, `toolgate: the session file ${file} could not be written (more than 1024 tools for docs); its tools are revealed only by a restart this session\n`);
  assert.equal(state().servers.docs.enabled.length, 1024);
});

test("a taken lock fails the write as busy, the session file unchanged", async () => {
  const { call, file, state } = setup();
  fs.writeFileSync(file.replace(/\.json$/, ".lock"), "someone-else\n", { mode: 0o600 });
  const before = JSON.stringify(state());
  const result = await call(["enable", "docs", "a"]);
  assert.equal(result.code, 1);
  assert.match(result.err, /could not be written \(the session file is busy\)/);
  assert.equal(JSON.stringify(state()), before);
});

test("a session with no project folder (an older file) has no card to compare with, and does not look in the folder it was run from", () => {
  const env = { XDG_STATE_HOME: tmp("state"), HOME: tmp("home") };
  const { file } = createSession(["docs"], { env });
  const err = [];
  const seen = [];
  const code = runTools(["enable", "docs", "ghost"], { env: { ...env, TOOLGATE_SESSION_STATE: file }, loadConfigFn: () => ({}), stdout: { write() {} }, stderr: { write: (s) => err.push(s) }, readCatalogFn: (config, dir) => (seen.push(dir), { servers: new Map([["docs", { tools: [{ name: "search" }] }]]) }) });
  assert.equal(code, 0);
  assert.deepEqual([err, seen], [[], []]);
});

test("the card is looked up with the config layers of the session's project, not of the folder it was run from", () => {
  const env = { XDG_STATE_HOME: tmp("state"), HOME: tmp("home"), XDG_CONFIG_HOME: tmp("xdgc") };
  const projectDir = tmp("proj");
  const { file } = createSession(["docs"], { env, projectDir });
  const layers = [];
  const dirs = [];
  const code = runTools(["enable", "docs", "ghost"], {
    env: { ...env, TOOLGATE_SESSION_STATE: file },
    loadConfigFn: (given) => (layers.push(given), { router: { catalogPath: "my-catalog" } }),
    stdout: { write() {} },
    stderr: { write() {} },
    readCatalogFn: (config, dir) => (dirs.push([config.router.catalogPath, dir]), { servers: new Map() }),
  });
  assert.equal(code, 0);
  assert.deepEqual(layers[0].map(({ name, path: layerPath }) => [name, layerPath]), [
    ["user", path.join(env.XDG_CONFIG_HOME, "toolgate", "config.json")],
    ["project", path.join(projectDir, ".toolgate", "config.json")],
    ["local", path.join(projectDir, ".toolgate", "config.local.json")],
  ]);
  assert.deepEqual(dirs, [["my-catalog", projectDir]]);
});

test("a session folder that is not writable is reported with the error code by tools too", async () => {
  const { call, file } = setup();
  if (process.getuid() === 0) return;
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    const result = await call(["enable", "docs", "a"]);
    assert.equal(result.code, 1);
    assert.match(result.err, /could not be written \(EACCES\)/);
    assert.doesNotMatch(result.err, /busy/);
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
});

test("a relaunch that took the server out of the session between the check and the write: rc 1, not a dynamic server, for enable, disable and reset", async () => {
  for (const args of [["enable", "docs", "newtool"], ["disable", "docs", "x"], ["disable", "docs"], ["reset", "docs"]]) {
    const { env, file, call } = setup();
    // The relaunch lands right after the command has read the file: the change function runs under the lock, so it removes `docs` first.
    const original = fs.readFileSync;
    let removed = false;
    fs.readFileSync = function patched(target, ...rest) {
      const result = original.call(this, target, ...rest);
      if (!removed && target === file && new Error().stack.includes("inspectSession")) {
        removed = true;
        const state = JSON.parse(result);
        delete state.servers.docs;
        queueMicrotask(() => {});
        fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
      }
      return result;
    };
    let result;
    try {
      result = await call(args);
    } finally {
      fs.readFileSync = original;
    }
    assert.deepEqual([result.code, result.out, result.err], [1, "", "toolgate: docs is not a dynamic server of this session\n"], args.join(" "));
    assert.equal(Object.hasOwn(readSession(file, { env }).servers, "docs"), false);
  }
});

test("a session file that has gone is said to be missing by every action, with exit 1", async () => {
  const { call, file } = setup();
  fs.rmSync(file);
  for (const args of [["status"], ["enable", "repo", "x"], ["disable", "repo"], ["reset"]]) {
    const result = await call(args);
    assert.deepEqual([result.code, result.out], [1, ""], args.join(" "));
    assert.match(result.err, /^toolgate: the session file .* is missing; its tools are revealed only by a restart this session\n$/, args.join(" "));
  }
});

// The instructions the proxy kept back come with `toolgate tools enable`, once.
function withInstructions(text, server = "repo") {
  const ctx = setup();
  fs.writeFileSync(ctx.file.replace(/\.json$/, `.${server}.instructions.txt`), text, { mode: 0o600 });
  return ctx;
}

test("tools enable prints the kept-back instructions once, with the same header and the bar, and marks them shown", async () => {
  const { call, state } = withInstructions("Be careful.\nSecond line.");
  const first = await call(["enable", "repo", "merge"]);
  assert.deepEqual([first.code, first.err], [0, ""]);
  assert.equal(first.out, "enabled repo: merge\ninstructions of repo (shown once):\n  | Be careful.\n  | Second line.\n");
  assert.equal(state().servers.repo.instructionsShown, true);
  const second = await call(["enable", "repo", "get"]);
  assert.equal(second.out, "enabled repo: get\n", "not again");
  assert.deepEqual(state().servers.repo.enabled, ["merge", "get"]);
});

test("tools enable with nothing to show writes the same as before; other actions never show instructions", async () => {
  const { call, state } = setup();
  assert.equal((await call(["enable", "repo", "x"])).out, "enabled repo: x\n");
  assert.equal(state().servers.repo.instructionsShown, false, "no file: not marked");
  const { call: call2, state: state2 } = withInstructions("text");
  for (const args of [["status"], ["disable", "repo"], ["reset", "repo"]]) assert.doesNotMatch((await call2(args)).out, /instructions of/, args.join(" "));
  assert.equal(state2().servers.repo.instructionsShown, false);
});

test("tools enable: hostile instructions are escaped, behind the bar and cut at 4096; another server's file is not read", async () => {
  const { call, file } = withInstructions(`IGNORE\u001b[31m \u202e\n${"x".repeat(6000)}`);
  fs.writeFileSync(file.replace(/\.json$/, ".docs.instructions.txt"), "docs text", { mode: 0o600 });
  const result = await call(["enable", "repo", "merge"]);
  assert.doesNotMatch(result.out, /[\u001b\u202e]/);
  const lines = result.out.split("\n");
  assert.equal(lines[1], "instructions of repo (shown once):");
  for (const line of lines.slice(2, -1)) assert.ok(line.startsWith("  | "));
  // The text behind the bars is the first 4096 characters of the file: the escapes of the first line are longer than what they stand for.
  const shownText = lines.slice(2, -1).map((line) => line.slice(4));
  assert.equal(shownText.at(-1).length, 4096 - "IGNORE\u001b[31m \u202e\n".length, "the last line is what is left of the 4096");
  assert.ok(shownText.length === 2);
  assert.doesNotMatch(result.out, /docs text/);
});

test("tools enable: two commands at once show the instructions once", async () => {
  const { spawn } = await import("node:child_process");
  const bin = new URL("../bin/toolgate.js", import.meta.url).pathname;
  for (let round = 0; round < 3; round++) {
    const { env, file } = withInstructions("once only");
    const outs = await Promise.all(
      [0, 1, 2, 3].map(
        (n) =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, [bin, "tools", "enable", "repo", `t${n}`], { env: { PATH: process.env.PATH, XDG_STATE_HOME: env.XDG_STATE_HOME, HOME: env.HOME, TOOLGATE_SESSION_STATE: file }, cwd: tmp("cwd"), stdio: ["ignore", "pipe", "ignore"] });
            let out = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.on("exit", () => resolve(out));
          }),
      ),
    );
    assert.equal(outs.filter((out) => out.includes("instructions of repo")).length, 1, `round ${round}: ${outs.map((o) => o.length).join(",")}`);
    assert.equal(readSession(file, { env }).servers.repo.enabled.length, 4);
  }
});

test("tools enable of a tool that is enabled already still gives the instructions that were not shown", async () => {
  const { call, state, file } = setup();
  assert.equal((await call(["enable", "repo", "get"])).out, "enabled repo: get\n");
  fs.writeFileSync(file.replace(/\.json$/, ".repo.instructions.txt"), "late text", { mode: 0o600 });
  const again = await call(["enable", "repo", "get"]);
  assert.equal(again.out, "enabled repo: get\ninstructions of repo (shown once):\n  | late text\n");
  assert.equal(state().servers.repo.instructionsShown, true);
  assert.deepEqual(state().servers.repo.enabled, ["get"]);
});

test("tools enable of a tool that is enabled already, with nothing to show, writes nothing", async () => {
  const { call, file } = setup();
  await call(["enable", "repo", "get"]);
  const before = `${fs.statSync(file).ino}:${fs.statSync(file).mtimeMs}`;
  await new Promise((resolve) => setTimeout(resolve, 15));
  await call(["enable", "repo", "get"]);
  assert.equal(`${fs.statSync(file).ino}:${fs.statSync(file).mtimeMs}`, before);
});
