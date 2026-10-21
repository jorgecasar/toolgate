#!/usr/bin/env node
// Toy MCP-ish server used only by toolgate-proxy's integration tests.
// Speaks newline-delimited JSON-RPC on stdin/stdout, like a real stdio MCP server would.
import readline from "node:readline";

// Keep the event loop alive independently of stdin, so tests can observe that closing
// the proxy's stdin (EOF) does not, by itself, terminate this upstream process.
setInterval(() => {}, 1 << 30);

const TOOLS = [
  { name: "listPRs", description: "List pull requests" },
  { name: "getPR", description: "Get a pull request" },
  { name: "getPRComments", description: "Get PR comments" },
  { name: "comment", description: "Comment on a PR" },
  { name: "approve", description: "Approve a PR" },
  { name: "createPR", description: "Create a PR" },
  { name: "mergePullRequest", description: "Merge a PR" },
];

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.error(`FAKE_UPSTREAM_GOT_${signal}`);
    process.exit(0);
  });
}
// Tests that send a signal wait for this line: before it, the handlers above may not be installed yet.
console.error("FAKE_UPSTREAM_READY");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (line.trim() === "") return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // Not JSON: echo the raw line back untouched so passthrough is observable.
    process.stdout.write(line + "\n");
    return;
  }

  if (Array.isArray(msg) || typeof msg !== "object" || msg === null) {
    // Batches/arrays: echo the raw line back untouched (JSON-RPC batching is unsupported
    // by design) so tests can assert the proxy forwarded it byte-for-byte.
    process.stdout.write(line + "\n");
    return;
  }

  if (msg.method === "initialize" && "id" in msg) {
    reply(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "fake-upstream", version: "0.0.0" },
    });
    return;
  }

  if (msg.method === "tools/list" && "id" in msg) {
    reply(msg.id, { tools: TOOLS });
    return;
  }

  if (msg.method === "test/exit") {
    process.exit(msg.params?.code ?? 0);
  }

  if (msg.method === "test/killSelf") {
    process.kill(process.pid, msg.params?.signal ?? "SIGKILL");
    return;
  }

  if (!("id" in msg)) {
    // Notification: real servers don't reply. Nothing to do.
    return;
  }

  // Unknown request: reply with deliberately non-canonical key order, so any test
  // that re-parses/re-serializes this response instead of forwarding it verbatim breaks.
  process.stdout.write(JSON.stringify({ result: { echoed: msg.method }, id: msg.id, jsonrpc: "2.0" }) + "\n");
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
