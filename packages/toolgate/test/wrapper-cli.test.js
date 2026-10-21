import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry } from "../src/adapters/index.js";
import { run } from "../src/cli.js";
import * as claude from "../src/adapters/claude-code.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-agent.js");

function setup({ config = { baseline: ["repo"], toolBaselines: { repo: ["a"] } }, exit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-wrapper-"));
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { repo: {}, docs: {} } }));
  const out = path.join(dir, "out.json");
  const fakeBin = path.join(dir, "claude");
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const adapter = {
    ...claude,
    launch: (args, options) =>
      claude.launch(args, {
        ...options,
        claudeBin: fakeBin,
        tmpDir: dir,
        env: { ...process.env, FAKE_OUT: out, FAKE_EXIT: String(exit), ...options.envExtra },
      }),
  };
  const adapters = createRegistry({ "claude-code": () => Promise.resolve(adapter) }, { validate: false, aliases: { claude: "claude-code" } });
  const errors = [];
  const deps = {
    cwd: dir,
    env: {},
    adapters,
    stderr: { write: (s) => errors.push(s) },
    stdout: { write: () => {} },
    loadConfigFn: () => config,
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
  };
  const recorded = () => JSON.parse(fs.readFileSync(out, "utf8"));
  return { deps, recorded, out, errors, dir };
}

test("toolgate claude forwards the agent's arguments untouched and adds --settings", async () => {
  const { deps, recorded } = setup();
  assert.equal(await run(["--no-route", "claude", "--model", "haiku", "hi"], deps), 0);
  const { argv, settings, env } = recorded();
  assert.equal(argv[0], "--settings");
  assert.deepEqual(argv.slice(2), ["--model", "haiku", "hi"]);
  assert.deepEqual(settings.enabledMcpjsonServers, ["repo"]);
  assert.deepEqual(settings.disabledMcpjsonServers, ["docs"]);
  assert.equal(env, "a");
});

test("flags that used to be taken for the prompt reach the agent intact", async () => {
  const { deps, recorded } = setup();
  assert.equal(await run(["--no-route", "claude", "--resume"], deps), 0);
  assert.deepEqual(recorded().argv.slice(2), ["--resume"]);
});

test("the claude alias selects claude-code", async () => {
  const { deps, recorded } = setup();
  assert.equal(await run(["--no-route", "claude", "-p", "hi"], deps), 0);
  assert.deepEqual(recorded().argv.slice(2), ["-p", "hi"]);
});

test("the agent's subcommands are forwarded with no settings generated", async () => {
  const { deps, recorded, dir } = setup();
  assert.equal(await run(["claude", "mcp", "list"], deps), 0);
  assert.deepEqual(recorded().argv, ["mcp", "list"]);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith("toolgate-settings")), []);
});

test("the agent's exit code is returned", async () => {
  const { deps } = setup({ exit: 7 });
  assert.equal(await run(["--no-route", "claude", "-p", "x"], deps), 7);
});

test("a prompt is routed only when unambiguous: ambiguous leaves the baseline", async () => {
  const config = { baseline: ["repo"], keywords: { docs: ["document"] }, toolBaselines: {} };
  const ambiguous = setup({ config });
  await run(["--no-route", "claude", "--unknown", "document this"], ambiguous.deps);
  assert.deepEqual(ambiguous.recorded().settings.enabledMcpjsonServers, ["repo"]);
  const clear = setup({ config });
  await run(["--no-route", "claude", "-p", "document this"], clear.deps);
  assert.deepEqual(clear.recorded().settings.enabledMcpjsonServers, ["repo", "docs"]);
});

test("a pending escalation is consumed after the launch", async () => {
  const saved = [];
  const { deps } = setup();
  deps.loadStateFn = () => ({ extras: ["docs"], toolExtras: {}, pendingRestart: true });
  deps.saveStateFn = (p, state) => saved.push(state);
  await run(["--no-route", "claude", "-p", "x"], deps);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pendingRestart, false);
});

test("an adapter without argument passthrough cannot be wrapped yet", async () => {
  const { deps, errors } = setup();
  deps.adapters = createRegistry({ codex: () => Promise.resolve({ launch: async () => ({ code: 0 }) }) }, { validate: false });
  assert.equal(await run(["codex", "hi"], deps), 1);
  assert.match(errors.join(""), /cannot be wrapped yet/);
});

test("signals are forwarded to the agent and its exit code comes back", async () => {
  const { dir } = setup();
  const ready = path.join(dir, "ready");
  const source = new EventEmitter();
  const running = claude.launch(["-p", "x"], {
    raw: true,
    claudeBin: path.join(dir, "claude"),
    signalSource: source,
    env: { ...process.env, FAKE_OUT: path.join(dir, "out.json"), FAKE_WAIT: ready },
  });
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(ready), "the fake agent started");
  source.emit("SIGTERM");
  const result = await running;
  assert.equal(result.code, 42, "the agent received SIGTERM and exited with its own code");
  assert.equal(source.listenerCount("SIGTERM"), 0, "forwarding stops once the agent exits");
});

// Opt-in (uses the network and the user's Claude login): TOOLGATE_REAL_CLAUDE=1 npm test
test("a real claude -p run through the wrapper", { skip: !process.env.TOOLGATE_REAL_CLAUDE }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-real-"));
  fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  const code = await run(["--no-route", "claude", "-p", "Reply with exactly: ok"], {
    cwd: dir,
    env: process.env,
    stderr: process.stderr,
    stdout: process.stdout,
    loadConfigFn: () => ({ baseline: [] }),
    loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false }),
    saveStateFn: () => {},
  });
  assert.equal(code, 0);
});
test("the user's own --settings is folded into the generated one, toolgate's servers win", async () => {
  const { deps, recorded } = setup();
  const theirs = '{"model":"haiku","enabledMcpjsonServers":["docs"]}';
  assert.equal(await run(["--no-route", "claude", "--settings", theirs, "hi"], deps), 0);
  const { argv, settings } = recorded();
  assert.equal(argv.filter((a) => a === "--settings").length, 1);
  assert.deepEqual(argv.slice(2), ["hi"]);
  assert.equal(settings.model, "haiku");
  assert.deepEqual(settings.enabledMcpjsonServers, ["repo"]);
});
// --resume [value]: the argv reaches claude unchanged in every form, and the task is routed only when there is one.
const ROUTE_DOCS = { baseline: [], keywords: { docs: ["docs"] } };
test("toolgate claude --resume in its four forms forwards the arguments unchanged, and routes only a real task", async () => {
  const cases = [
    [["--resume"], false],
    [["--resume", "abc-123"], false],
    [["--resume", "abc-123", "read the docs"], true],
    [["--resume", "read the docs"], false],
    [["-r", "read the docs"], false],
    [["-r", "abc-123", "read the docs"], true],
  ];
  for (const [args, routed] of cases) {
    const { deps, recorded } = setup({ config: ROUTE_DOCS });
    assert.equal(await run(["claude", ...args], deps), 0, JSON.stringify(args));
    const { argv, settings } = recorded();
    assert.deepEqual(argv.slice(2), args, `argv ${JSON.stringify(args)}`);
    assert.equal((settings.enabledMcpjsonServers ?? []).includes("docs"), routed, `routing ${JSON.stringify(args)}`);
  }
});
