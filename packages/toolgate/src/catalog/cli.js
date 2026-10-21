import { jsonSafe } from "../assets/common.js";
import { askInTerminal } from "../init.js";
import { buildCatalog } from "./build.js";
import { oneLine } from "./sanitize.js";

const HELP = "toolgate catalog build [--server <name>] [--dry-run] [--json]\n";

const line = (row) => {
  const name = oneLine(row.server, 64);
  if (row.status === "built" || row.status === "would-build") return `${row.status === "built" ? "built" : "would build"} ${name}: ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"} -> ${row.file}${row.droppedTools ? ` (${row.droppedTools} left out: unsafe or repeated names)` : ""}`;
  return `${row.status} ${name}: ${oneLine(row.reason ?? "", 300)}`;
};

export async function runCatalog(args, ctx) {
  const { stdout, stderr, json = false } = ctx;
  if (args[0] !== "build" || args.length > 1) {
    stderr.write(`toolgate catalog: expected build\n${HELP}`);
    return 1;
  }
  const result = await (ctx.buildFn ?? buildCatalog)({ ...ctx, ask: ctx.ask ?? askInTerminal, print: (text) => (json ? stderr : stdout).write(text) });
  if (result.error) {
    stderr.write(`toolgate catalog: ${oneLine(result.error, 300)}\n`);
    return result.code;
  }
  if (json) stdout.write(`${jsonSafe(JSON.stringify({ servers: result.rows }, null, 2))}\n`);
  else stdout.write(`${result.rows.length ? result.rows.map(line).join("\n") : "toolgate: no MCP server is configured"}\n`);
  return result.code;
}
