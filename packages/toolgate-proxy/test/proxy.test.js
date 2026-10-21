import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_BIN = path.join(__dirname, "..", "bin", "toolgate-proxy.js");
const FAKE_UPSTREAM = path.join(__dirname, "..", "fixtures", "fake-upstream.js");

// A test that fails (a waitFor that times out) leaves its proxy running, and `node --test` would wait for it forever.
const started = new Set();
// SIGTERM first: the proxy forwards it to its upstream, which shares the stderr pipe and would keep the process alive.
after(async () => {
  for (const child of started) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await gone;
    clearTimeout(timer);
  }
});
function startProxy(envOverrides = {}) {
  const child = spawn(process.execPath, [PROXY_BIN], {
    env: {
      ...process.env,
      TOOLGATE_UPSTREAM_CMD: process.execPath,
      TOOLGATE_UPSTREAM_ARGS: JSON.stringify([FAKE_UPSTREAM]),
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  started.add(child);
  const stdoutLines = [];
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const parts = stdoutBuffer.split("\n");
    stdoutBuffer = parts.pop();
    stdoutLines.push(...parts);
  });

  let stderrData = "";
  child.stderr.on("data", (chunk) => {
    stderrData += chunk.toString("utf8");
  });

  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    },
    sendRaw(line) {
      child.stdin.write(line + "\n");
    },
    stdoutLines,
    getStderr: () => stderrData,
    closeStdin: () => child.stdin.end(),
    exited,
  };
}

function waitFor(fn, { timeout = 3000, interval = 20 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("waitFor timed out"));
      setTimeout(tick, interval);
    };
    tick();
  });
}

test("filters tools/list to the allow list", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "listPRs,getPR,mergePullRequest" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await waitFor(() => proxy.stdoutLines.length >= 2);

  const initResp = JSON.parse(proxy.stdoutLines[0]);
  assert.equal(initResp.id, 1);
  assert.equal(initResp.result.serverInfo.name, "fake-upstream");

  const listResp = JSON.parse(proxy.stdoutLines[1]);
  assert.equal(listResp.id, 2);
  assert.deepEqual(listResp.result.tools.map((t) => t.name).sort(), ["getPR", "listPRs", "mergePullRequest"]);

  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("fail-open: no TOOLGATE_ALLOWED_TOOLS means no filtering", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  const listResp = JSON.parse(proxy.stdoutLines[0]);
  assert.equal(listResp.result.tools.length, 7);
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("warns on stderr for allow-list entries that match no advertised tool", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "listPRs,totallyMadeUpTool" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  await waitFor(() => proxy.getStderr().includes("totallyMadeUpTool"));
  assert.match(proxy.getStderr(), /totallyMadeUpTool/);
  const listResp = JSON.parse(proxy.stdoutLines[0]);
  assert.deepEqual(
    listResp.result.tools.map((t) => t.name),
    ["listPRs"]
  );
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("passes through non tools/list responses verbatim (no re-serialization)", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "listPRs" });
  proxy.send({ jsonrpc: "2.0", id: 42, method: "some/other", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  assert.equal(proxy.stdoutLines[0], '{"result":{"echoed":"some/other"},"id":42,"jsonrpc":"2.0"}');
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("passes through arrays/batches untouched", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "listPRs" });
  const batchLine = '[{"jsonrpc":"2.0","id":1,"method":"a"},{"jsonrpc":"2.0","id":2,"method":"b"}]';
  proxy.sendRaw(batchLine);
  await waitFor(() => proxy.stdoutLines.length >= 1);
  assert.equal(proxy.stdoutLines[0], batchLine);
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("passes through notifications with no id on stdin without erroring", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "listPRs" });
  proxy.sendRaw('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  const listResp = JSON.parse(proxy.stdoutLines[0]);
  assert.deepEqual(
    listResp.result.tools.map((t) => t.name),
    ["listPRs"]
  );
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("propagates the child exit code", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxy.send({ jsonrpc: "2.0", method: "test/exit", params: { code: 7 } });
  const { code, signal } = await proxy.exited;
  assert.equal(code, 7);
  assert.equal(signal, null);
});

test("exits with 128+N when the child dies from a signal", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxy.send({ jsonrpc: "2.0", method: "test/killSelf", params: { signal: "SIGKILL" } });
  const { code } = await proxy.exited;
  assert.equal(code, 128 + 9); // SIGKILL = 9
});

test("forwards SIGTERM to the child", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  // The child says it is ready once its own handler is installed; the proxy installed its handler right after spawning it,
  // so by then a signal reaches both. A fixed wait here was a race that failed on a loaded machine.
  await waitFor(() => proxy.getStderr().includes("FAKE_UPSTREAM_READY"));
  proxy.child.kill("SIGTERM");
  await proxy.exited;
  assert.match(proxy.getStderr(), /FAKE_UPSTREAM_GOT_SIGTERM/);
});

test("stdin EOF closes the child stdin without killing the proxy prematurely", async () => {
  const proxy = startProxy({ TOOLGATE_ALLOWED_TOOLS: "" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  proxy.closeStdin();
  // A wait that can only miss a premature exit, never invent one: it is long enough to see one, and a slow machine cannot fail it.
  // The fake upstream stays alive after its own stdin EOFs (kept alive by its own
  // interval); the proxy must not exit on its own stdin EOF, only when the child exits.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(proxy.child.exitCode, null);
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});

test("fails fast with a clear stderr message when TOOLGATE_UPSTREAM_CMD is missing", async () => {
  const proxy = startProxy({ TOOLGATE_UPSTREAM_CMD: "", TOOLGATE_ALLOWED_TOOLS: "" });
  const { code } = await proxy.exited;
  assert.equal(code, 1);
  assert.match(proxy.getStderr(), /TOOLGATE_UPSTREAM_CMD/);
});

// An old name alone is refused, with the rename text, one test per name (#19).
for (const [oldName, newName] of [["UPSTREAM_CMD", "TOOLGATE_UPSTREAM_CMD"], ["UPSTREAM_ARGS", "TOOLGATE_UPSTREAM_ARGS"], ["ALLOWED_TOOLS", "TOOLGATE_ALLOWED_TOOLS"]]) {
  test(`${oldName} alone exits 1 with the rename text, and is never read`, async () => {
    const proxy = startProxy({ [newName]: undefined, [oldName]: oldName === "UPSTREAM_ARGS" ? "[]" : oldName === "ALLOWED_TOOLS" ? "listPRs" : process.execPath });
    const { code } = await proxy.exited;
    assert.equal(code, 1);
    assert.match(proxy.getStderr(), new RegExp(`^toolgate-proxy: ${oldName} was renamed to ${newName}; run toolgate update\\n`, "m"));
  });
}

test("ALLOWED_TOOLS alone never fails open, even with an empty value and the other names right", async () => {
  const proxy = startProxy({ ALLOWED_TOOLS: "" });
  const { code } = await proxy.exited;
  assert.equal(code, 1);
  assert.match(proxy.getStderr(), /ALLOWED_TOOLS was renamed to TOOLGATE_ALLOWED_TOOLS; run toolgate update/);
});

test("an old name next to its new one is ignored: the new one wins and nothing is refused", async () => {
  const proxy = startProxy({ ALLOWED_TOOLS: "mergePullRequest", TOOLGATE_ALLOWED_TOOLS: "listPRs" });
  proxy.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await waitFor(() => proxy.stdoutLines.length >= 1);
  assert.deepEqual(JSON.parse(proxy.stdoutLines[0]).result.tools.map((t) => t.name), ["listPRs"]);
  proxy.child.kill("SIGTERM");
  await proxy.exited;
});
