#!/usr/bin/env node
// A minimal MCP server for the tests of the dynamic proxy whose tools/list comes in pages and holds whatever the test puts in them. PAGED_PAGES
// (or the file PAGED_FILE, for large ones: an environment string is limited) is a JSON array of pages, each an array of the entries of `tools` (they may be null, hostile or odd on purpose). A request without a cursor
// gets page 0; page i answers to the cursor "c<i>", and every page but the last has a nextCursor. A call answers with the tool name.
import fs from "node:fs";
import readline from "node:readline";

const pages = JSON.parse(process.env.PAGED_FILE ? fs.readFileSync(process.env.PAGED_FILE, "utf8") : (process.env.PAGED_PAGES ?? "[[]]"));
// The instructions it sends in initialize: the text of PAGED_INSTRUCTIONS_FILE, or the JSON value of PAGED_INSTRUCTIONS (which may not be text).
const instructions = process.env.PAGED_INSTRUCTIONS_FILE ? fs.readFileSync(process.env.PAGED_INSTRUCTIONS_FILE, "utf8") : process.env.PAGED_INSTRUCTIONS === undefined ? undefined : JSON.parse(process.env.PAGED_INSTRUCTIONS);
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
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "paged-upstream", version: "0.0.0" }, ...(instructions === undefined ? {} : { instructions }) });
  else if (msg.method === "tools/list") {
    const index = msg.params?.cursor ? Number(String(msg.params.cursor).slice(1)) : 0;
    reply(msg.id, { tools: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: `c${index + 1}` } : {}) });
  } else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: String(msg.params?.name) }] });
  else reply(msg.id, {});
});
