import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  readServers,
  readServerDefs,
  installedServers,
  applyActiveSet,
  buildToolEnv,
  toEnvVarName,
  launch,
} from "../../src/adapters/claude-code.js";

test("readServers lists the server names defined in .mcp.json", () => {
  const readFileFn = () => JSON.stringify({ mcpServers: { repo: {}, docs: {} } });
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), ["repo", "docs"]);
});

test("readServers returns an empty list when .mcp.json is missing", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), []);
});

test("readServers returns an empty list when .mcp.json is malformed", () => {
  const readFileFn = () => "not json";
  assert.deepEqual(readServers(".mcp.json", { readFileFn }), []);
});

test("applyActiveSet splits all known servers into enabled/disabled", () => {
  const active = new Set(["docs", "repo"]);
  const { enabledMcpjsonServers, disabledMcpjsonServers } = applyActiveSet(active, ["docs", "repo", "tasks"]);
  assert.deepEqual(enabledMcpjsonServers, ["docs", "repo"]);
  assert.deepEqual(disabledMcpjsonServers, ["tasks"]);
});

test("toEnvVarName uppercases and sanitizes the server name", () => {
  assert.equal(toEnvVarName("repo-server"), "TOOLGATE_REPO_SERVER_TOOLS");
});

test("buildToolEnv exports a CSV env var only for active servers with a tool baseline", () => {
  const config = { toolBaselines: { repo: ["listPRs", "getPR"] } };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const env = buildToolEnv(config, state, new Set(["repo", "docs"]));
  assert.deepEqual(env, { TOOLGATE_REPO_TOOLS: "listPRs,getPR" });
});

test("buildToolEnv includes escalated tools once pendingRestart is set", () => {
  const config = { toolBaselines: { repo: ["listPRs"] } };
  const state = { extras: [], toolExtras: { repo: ["mergePullRequest"] }, pendingRestart: true };
  const env = buildToolEnv(config, state, new Set(["repo"]));
  assert.deepEqual(env, { TOOLGATE_REPO_TOOLS: "listPRs,mergePullRequest" });
});

test("buildToolEnv skips servers that are not active", () => {
  const config = { toolBaselines: { repo: ["listPRs"] } };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const env = buildToolEnv(config, state, new Set(["docs"]));
  assert.deepEqual(env, {});
});

function fakeChild() {
  return new EventEmitter();
}

test("launch writes a settings file, sets tool env vars, and spawns claude with --settings", async () => {
  const readFileFn = () => JSON.stringify({ mcpServers: { docs: {}, repo: {}, tasks: {} } });
  const writes = [];
  const writeFileFn = (path, contents) => writes.push({ path, contents });
  const spawnCalls = [];
  const child = fakeChild();
  const spawnFn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };

  const config = {
    baseline: ["docs"],
    keywords: { repo: ["pull request"] },
    toolBaselines: { repo: ["listPRs", "getPR"] },
  };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };

  const result = await launch({
    prompt: "please review this pull request",
    config,
    state,
    readFileFn,
    writeFileFn,
    spawnFn,
    tmpDir: "/tmp",
    pid: 123,
    now: 456,
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/toolgate-settings-123-456.json");
  const settings = JSON.parse(writes[0].contents);
  assert.deepEqual(settings, {
    enabledMcpjsonServers: ["docs", "repo"],
    disabledMcpjsonServers: ["tasks"],
    enableAllProjectMcpServers: false,
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, "claude");
  assert.deepEqual(spawnCalls[0].args, [
    "--settings",
    "/tmp/toolgate-settings-123-456.json",
    "please review this pull request",
  ]);
  assert.equal(spawnCalls[0].opts.stdio, "inherit");
  assert.equal(spawnCalls[0].opts.env.TOOLGATE_REPO_TOOLS, "listPRs,getPR");

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.enabledMcpjsonServers, ["docs", "repo"]);
  assert.deepEqual(result.disabledMcpjsonServers, ["tasks"]);
});

test("launch propagates a non-zero exit code from claude", async () => {
  const readFileFn = () => JSON.stringify({ mcpServers: {} });
  const child = fakeChild();
  const spawnFn = () => {
    queueMicrotask(() => child.emit("exit", 3, null));
    return child;
  };
  const result = await launch({
    prompt: "hi",
    config: { baseline: [] },
    state: { extras: [], toolExtras: {}, pendingRestart: false },
    readFileFn,
    writeFileFn: () => {},
    spawnFn,
    tmpDir: "/tmp",
    pid: 1,
    now: 1,
  });
  assert.equal(result.code, 3);
});

test("launch omits the prompt argument when none is given", async () => {
  const readFileFn = () => JSON.stringify({ mcpServers: {} });
  const child = fakeChild();
  const spawnCalls = [];
  const spawnFn = (cmd, args) => {
    spawnCalls.push(args);
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  await launch({
    config: { baseline: [] },
    state: { extras: [], toolExtras: {}, pendingRestart: false },
    readFileFn,
    writeFileFn: () => {},
    spawnFn,
    tmpDir: "/tmp",
    pid: 1,
    now: 1,
  });
  assert.deepEqual(spawnCalls[0], ["--settings", "/tmp/toolgate-settings-1-1.json"]);
});

test("installedServers reports the servers in .mcp.json and where it looked", () => {
  const readFileFn = (file) => {
    if (file === "/p/.mcp.json") return JSON.stringify({ mcpServers: { repo: {}, docs: {} } });
    throw new Error("ENOENT");
  };
  assert.deepEqual(installedServers({ cwd: "/p", homedir: "/h", readFileFn }), {
    servers: ["repo", "docs"],
    source: "/p/.mcp.json",
  });
});

test("installedServers also sees user and local scope servers in ~/.claude.json", () => {
  const readFileFn = (file) => {
    if (file === "/p/.mcp.json") return JSON.stringify({ mcpServers: { repo: {} } });
    return JSON.stringify({ mcpServers: { qmd: {} }, projects: { "/p": { mcpServers: { local: {} } }, "/o": { mcpServers: { other: {} } } } });
  };
  assert.deepEqual(installedServers({ cwd: "/p", homedir: "/h", readFileFn }), {
    servers: ["repo", "qmd", "local"],
    source: "/p/.mcp.json, /h/.claude.json",
  });
});

test("installedServers is null when a config is malformed, so nothing is reported missing", () => {
  assert.equal(installedServers({ cwd: "/p", homedir: "/h", readFileFn: () => "{ truncated" }), null);
});

test("installedServers is null when .mcp.json cannot be read, so nothing is reported missing", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.equal(installedServers({ cwd: "/p", homedir: "/h", readFileFn }), null);
});

test("launch with client.exclusiveMcp passes only the active servers, project and user level, under --strict-mcp-config", async () => {
  const files = {
    "/home/.claude.json": JSON.stringify({ mcpServers: { mine: { command: "m" }, other: { command: "o" } } }),
    ".mcp.json": JSON.stringify({ mcpServers: { alpha: { command: "a" }, beta: { command: "b" } } }),
  };
  const written = {};
  const modes = {};
  const removed = [];
  let spawned;
  const spawnFn = (bin, args) => {
    spawned = args;
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  let err = "";
  const result = await launch(["-p", "hi"], {
    prompt: "hi",
    mcpJsonPath: ".mcp.json",
    homedir: "/home",
    cwd: "/proj",
    config: { baseline: ["alpha", "mine"], keywords: {}, toolBaselines: {}, client: { exclusiveMcp: true } },
    state: {},
    spawnFn,
    readFileFn: (file) => {
      if (!(file in files)) throw new Error("ENOENT");
      return files[file];
    },
    writeFileFn: (file, content, opts) => {
      written[file] = content;
      modes[file] = opts?.mode;
    },
    rmFn: (file) => removed.push(file),
    tmpDir: "/tmp",
    pid: 1,
    now: 2,
    stderr: { write: (text) => (err += text) },
    signalSource: new EventEmitter(),
  });
  assert.ok(spawned.includes("--strict-mcp-config"));
  assert.equal(spawned[spawned.indexOf("--mcp-config") + 1], result.mcpConfigPath);
  assert.deepEqual(Object.keys(JSON.parse(written[result.mcpConfigPath]).mcpServers).sort(), ["alpha", "mine"]);
  assert.deepEqual(result.leftOut.sort(), ["beta", "other"]);
  assert.match(err, /left out: .*beta/);
  assert.match(err, /built-ins still are/);
  assert.equal(modes[result.mcpConfigPath], 0o600);
  assert.deepEqual(removed, [result.settingsPath, result.mcpConfigPath], "the settings file and the MCP config of this launch both go");
});

test("readServerDefs: local beats project beats user, found from a subdirectory, disabled ones dropped", () => {
  const files = {
    "/home/.claude.json": JSON.stringify({
      mcpServers: { a: { command: "user" }, b: { command: "user" }, c: { command: "user" } },
      projects: { "/proj": { mcpServers: { a: { command: "local" } }, disabledMcpServers: ["c"] } },
    }),
    ".mcp.json": JSON.stringify({ mcpServers: { a: { command: "project" }, b: { command: "project" } } }),
  };
  const readFileFn = (file) => {
    if (!(file in files)) throw new Error("ENOENT");
    return files[file];
  };
  const defs = readServerDefs({ project: JSON.parse(files[".mcp.json"]), homedir: "/home", cwd: "/proj/sub/dir", readFileFn });
  assert.deepEqual(defs, { a: { command: "local" }, b: { command: "project" } });
});

test("readServerDefs is empty when no file can be read", () => {
  const readFileFn = () => {
    throw new Error("ENOENT");
  };
  assert.deepEqual(readServerDefs({ homedir: "/h", cwd: "/p", readFileFn }), {});
});

test("launch (prompt form) with exclusiveMcp reports active servers no file defines", async () => {
  let spawned;
  let err = "";
  const spawnFn = (bin, args) => {
    spawned = args;
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", 0, null));
    return child;
  };
  await launch({
    prompt: "hi",
    mcpJsonPath: ".mcp.json",
    homedir: "/home",
    cwd: "/proj",
    config: { baseline: ["plugged"], keywords: {}, toolBaselines: {}, client: { exclusiveMcp: true } },
    state: {},
    spawnFn,
    readFileFn: () => {
      throw new Error("ENOENT");
    },
    writeFileFn: () => {},
    rmFn: () => {},
    tmpDir: "/tmp",
    pid: 1,
    now: 2,
    stderr: { write: (text) => (err += text) },
  });
  assert.ok(spawned.includes("--strict-mcp-config"));
  assert.match(err, /left out: none/);
  assert.match(err, /defined in no config file.*plugged/);
});

test("the user's own --mcp-config stays after toolgate's, and no exclusive args without the option", async () => {
  const run = async (client) => {
    let spawned;
    await launch(["--mcp-config", "mine.json"], {
      prompt: "hi",
      config: { baseline: [], keywords: {}, toolBaselines: {}, client },
      state: {},
      spawnFn: (bin, args) => {
        spawned = args;
        const child = new EventEmitter();
        setImmediate(() => child.emit("exit", 0, null));
        return child;
      },
      readFileFn: () => {
        throw new Error("ENOENT");
      },
      writeFileFn: () => {},
      rmFn: () => {},
      tmpDir: "/tmp",
      pid: 1,
      now: 2,
      stderr: { write: () => {} },
      signalSource: new EventEmitter(),
    });
    return spawned;
  };
  const on = await run({ exclusiveMcp: true });
  assert.ok(on.indexOf("--strict-mcp-config") < on.lastIndexOf("mine.json"));
  const off = await run({});
  assert.ok(!off.includes("--strict-mcp-config"));
});

test("a failed spawn still removes the exclusive MCP config, and the launch rejects with the error", async () => {
  for (const args of [["-p", "hi"], null]) {
    const child = new EventEmitter();
    const removed = [];
    const options = {
      prompt: "hi",
      config: { baseline: [], keywords: {}, toolBaselines: {}, client: { exclusiveMcp: true } },
      state: {},
      spawnFn: () => child,
      readFileFn: () => {
        throw new Error("ENOENT");
      },
      writeFileFn: () => {},
      rmFn: (file) => removed.push(file),
      tmpDir: "/tmp",
      pid: 1,
      now: 2,
      stderr: { write: () => {} },
      signalSource: new EventEmitter(),
    };
    const started = args ? launch(args, options) : launch(options);
    child.emit("error", new Error("spawn claude ENOENT"));
    await assert.rejects(started, /ENOENT/);
    assert.deepEqual(removed, ["/tmp/toolgate-settings-1-2.json", "/tmp/toolgate-mcp-1-2.json"]);
  }
});
