#!/usr/bin/env node
// A fat MCP server for measuring what a client loads at session start (#19): 30 tools, each with a description and an input schema,
// and 4,096 characters of server instructions. It speaks newline-delimited JSON-RPC on stdin/stdout like fake-upstream.js, and does
// nothing else: a tool call answers with its own name. Run it directly or through toolgate-proxy (see README.md).
import fs from "node:fs";
import readline from "node:readline";

const TOOL_COUNT = 30;
const INSTRUCTIONS_LENGTH = 4096;

const TOOLS = Array.from({ length: TOOL_COUNT }, (_, i) => {
  const name = `fat_tool_${String(i + 1).padStart(2, "0")}`;
  return {
    name,
    description: `${name}: a tool that does nothing but carry a description of realistic length, so that loading it up front costs what a real tool costs. It takes a target, an optional filter and a limit, and answers with its own name.`,
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "What the tool acts on, for example an id, a path or a name." },
        filter: { type: "string", description: "Keeps only the entries that match this text." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "The most entries to return." },
      },
      required: ["target"],
    },
  };
});

// Exactly INSTRUCTIONS_LENGTH characters, the most Claude Code keeps of a server's instructions.
const INSTRUCTIONS = "Fat upstream instructions. Use these tools only to measure context. ".repeat(INSTRUCTIONS_LENGTH).slice(0, INSTRUCTIONS_LENGTH);

// Keep the event loop alive independently of stdin, like fake-upstream.js.
setInterval(() => {}, 1 << 30);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // FAT_UPSTREAM_LOG: a file that gets one line per message received (`<method>`, and `tools/call <tool>` for a call), so a test can say
  // what reached the upstream and what did not.
  if (process.env.FAT_UPSTREAM_LOG && msg !== null && typeof msg === "object" && !Array.isArray(msg) && typeof msg.method === "string") {
    fs.appendFileSync(process.env.FAT_UPSTREAM_LOG, `${msg.method}${msg.method === "tools/call" ? ` ${msg.params?.name}` : ""}\n`);
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg) || !("id" in msg)) return;
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fat-upstream", version: "0.0.0" },
      instructions: INSTRUCTIONS,
    });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools: TOOLS });
  } else if (msg.method === "tools/call") {
    reply(msg.id, { content: [{ type: "text", text: String(msg.params?.name) }] });
  } else {
    reply(msg.id, {});
  }
});
