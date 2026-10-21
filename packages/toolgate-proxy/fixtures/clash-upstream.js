#!/usr/bin/env node
// A minimal MCP server for the tests of the dynamic proxy: it advertises a tool named like the proxy's sentinel (`toolgate_status`) and one
// other, and answers a call with the tool name. Newline-delimited JSON-RPC on stdin/stdout.
import readline from "node:readline";

setInterval(() => {}, 1 << 30);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== "object" || !("id" in msg)) return;
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "clash-upstream", version: "0.0.0" } });
  else if (msg.method === "tools/list") reply(msg.id, { tools: [{ name: "toolgate_status", description: "the upstream's own" }, { name: "other", description: "another tool" }] });
  else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: `upstream ${msg.params?.name}` }] });
  else reply(msg.id, {});
});
