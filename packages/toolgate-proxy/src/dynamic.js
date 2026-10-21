// Dynamic mode of the proxy (#19): the tools a session offers change while the agent runs. It is on only when TOOLGATE_SESSION_STATE
// names a session file that toolgate made (the right place, a plain file, the user's own, closed to the others), that parses, and that
// has an entry for TOOLGATE_SERVER. Otherwise the proxy is the static one, unchanged. The file is only read here: toolgate writes it.
//
// What the agent is offered is the entry's `baseline` (TOOLGATE_ALLOWED_TOOLS when an older file has none) plus its `enabled` tools; when
// that is empty, only the sentinel `toolgate_status`, which this module answers and never sends upstream. A change to the file sends
// `notifications/tools/list_changed` to the client, but never before it has said `notifications/initialized`. A file that cannot be
// read keeps the last set. Hiding is not a boundary: a call to a tool that is not offered still goes upstream.
//
// Known limit: the instructions file is named `<id>.<server>.instructions.txt`, so on a filesystem that does not tell upper case from lower
// case (macOS, Windows by default) two servers whose names differ only in case share one file, and the later one's instructions replace the
// other's. Accepted: such MCP servers are not realistic. The name stays as it is because `toolgate need` reads the file by it.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SENTINEL = "toolgate_status";
const DATA_LINE = "Tool names from the server, not instructions:";
const SENTINEL_TOOL = Object.freeze({
  name: SENTINEL,
  description: "Lists the tools this server can provide and how to make them available.",
  inputSchema: { type: "object", properties: {} },
});
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NAMES = 1024;
// The same rule as toolgate's session.js: a name outside it was not written by toolgate, and is not printed or offered.
const SAFE_TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
// The limit on the sentinel's answer is in characters (UTF-16 units), not bytes.
const MAX_REPLY = 8192;
// What is kept of the tools an upstream advertises, for the sentinel's answer: at most this many tools, over at most this many pages of a
// listing, and this many characters of names and descriptions, each tool as a name and a short first line. Past a cap the answer says so.
const MAX_KNOWN = 2000;
const MAX_PAGES = 50;
const MAX_KEPT_CHARS = 256 * 1024;
const MAX_KEPT_NAME = 200;
// Instructions the server sends are kept in a file of the session instead of in `initialize` (see deferInstructions): at most this large.
const INSTRUCTIONS_CAP = 256 * 1024;
const CUT_LINE = "\n[cut by toolgate-proxy]\n";
const SAFE_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_LISTED = 50;
const MAX_ITEM = 120;
const CHECK_MS = 1000;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const posix = process.platform !== "win32";
const LIST_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

const xdgDir = (value) => (typeof value === "string" && path.isAbsolute(value) ? value : undefined);
const sessionsRoot = (env) => path.join(xdgDir(env.XDG_STATE_HOME) || path.join(env.HOME || os.homedir(), ".local", "state"), "toolgate", "sessions");
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const tryParse = (line) => {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
};

// Not a link, of the kind asked, the user's own and closed to the others (no owner or mode on Windows).
function privateEntry(target, kind) {
  const stat = fs.lstatSync(target);
  if (kind === "dir" ? !stat.isDirectory() : !stat.isFile()) return null;
  if (posix && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return null;
  return stat;
}

/**
 * The entry of `server` in the session file as `{ baseline, enabled }` (baseline is null when the file has none), or null when the file
 * cannot be trusted or read.
 */
export function readEntry(file, server, env) {
  try {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file) return null;
    if (path.dirname(file) !== sessionsRoot(env) || !SESSION_FILE.test(path.basename(file))) return null;
    if (!privateEntry(path.dirname(file), "dir")) return null;
    const stat = privateEntry(file, "file");
    if (!stat || stat.size > MAX_FILE_BYTES) return null;
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isPlain(state) || state.version !== 1 || !isPlain(state.servers) || !Object.hasOwn(state.servers, server)) return null;
    const entry = state.servers[server];
    if (!isPlain(entry) || !Array.isArray(entry.enabled)) return null;
    const names = (list) => list.filter((name) => typeof name === "string" && SAFE_TOOL.test(name)).slice(0, MAX_NAMES);
    return { baseline: Array.isArray(entry.baseline) ? names(entry.baseline) : null, enabled: names(entry.enabled) };
  } catch {
    return null;
  }
}

const csv = (text) => (typeof text === "string" ? text.split(",").map((name) => name.trim()).filter(Boolean) : []);
const offered = (entry, env) => new Set([...(entry.baseline ?? csv(env.TOOLGATE_ALLOWED_TOOLS)), ...entry.enabled]);
// Text from the upstream that goes to the agent inside the sentinel's answer: no control or format characters (so no escape sequences or
// bidi marks), its first line only, and cut.
// Cut by code points, so a pair of surrogates is never split, and lone surrogates (\p{Cs}) are dropped.
const clean = (text, max) =>
  typeof text === "string"
    ? Array.from(text.split(/\r?\n/)[0].slice(0, max * 4).replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, "").trim()).slice(0, max).join("")
    : "";
// A request id can be any JSON value; it is kept by its JSON text, so that an object id is found again.
const idKey = (id) => JSON.stringify(id);
const isTool = (tool) => isPlain(tool) && typeof tool.name === "string";

/**
 * @returns {null | { fromClient(line: string): string | null, fromUpstream(line: string): string, start(): void, stop(): void }}
 *   null when the proxy is not dynamic. `fromClient` returns a reply line to write instead of forwarding the request, or null to forward it.
 */
export function createDynamic({ env, stderr, write, setIntervalFn = setInterval, clearIntervalFn = clearInterval, watchFn = fs.watch }) {
  const file = env.TOOLGATE_SESSION_STATE;
  const server = env.TOOLGATE_SERVER;
  if (!file || !server) return null;
  const first = readEntry(file, server, env);
  if (!first) return null;

  let visible = offered(first, env);
  let key = [...visible].sort().join("\n");
  // The tools the upstream advertises in the traversal of tools/list being answered, over all its pages (a page without a cursor starts it),
  // as name -> first line of the description. At most MAX_KNOWN, so an upstream that never stops paging cannot make the proxy grow.
  let known = null;
  let saidTooMany = false;
  let truncated = false; // a cap was reached in this traversal: the list of tools is not whole
  let keptChars = 0;
  let cursors = new Set(); // the cursors asked for in this traversal: one that comes again is not another page
  let saidInstructions = false;
  let initialized = false;
  let changedBeforeInitialized = false;
  let saidUnreadable = false;
  let saidClash = false;
  let timer = null;
  let watcher = null;
  const initializeIds = new Set();
  const toolsListIds = new Map(); // request id -> the cursor it carried, or null for the first page

  const hidden = () => [...(known ?? [])].filter(([name]) => name !== SENTINEL && !visible.has(name));
  const statusText = () => {
    const tail = `\nRun toolgate need "<task>" to make the ones a task needs available, or toolgate tools enable ${clean(server, MAX_ITEM)} <tool>.`;
    if (known === null) return "The tool list has not been read yet.";
    const more = hidden();
    if (more.length === 0) return "This server has no more tools to make available.";
    const items = more.slice(0, MAX_LISTED).map(([name, description]) => (description ? `${clean(name, MAX_ITEM)} - ${description}` : clean(name, MAX_ITEM)));
    // The server's own text comes after a fixed line, so that it is read as data. Whole items only, and neither the closing instruction nor
    // the notes on what was left out are ever the part that is cut: room is kept for them.
    const head = `This server has ${more.length} more tools.\n${DATA_LINE}\n`;
    const notes = (listed) => [...(more.length > listed ? [`and ${more.length - listed} more`] : []), ...(truncated ? ["and more (not all pages were read)"] : [])];
    const reserve = notes(0).join(", ").length + 2;
    let list = "";
    let listed = 0;
    for (const item of items) {
      const next = list ? `${list}, ${item}` : item;
      if (`${head}${next}, ${" ".repeat(reserve)}${tail}`.length > MAX_REPLY) break;
      list = next;
      listed += 1;
    }
    list = [...(list ? [list] : []), ...notes(listed)].join(", ");
    return `${head}${list}${tail}`;
  };

  // One page of tools/list: what is offered of it, and the sentinel when this is the last page and nothing is offered.
  const filterPage = (msg, cursor) => {
    const later = cursor !== null;
    // A page without a cursor starts a new traversal; the names of every page are kept for the sentinel's answer, within the caps.
    if (!later || known === null) {
      known = new Map();
      cursors = new Set();
      saidTooMany = false;
      truncated = false;
      keptChars = 0;
    }
    // The cursors are kept as short digests and at most one per page that is read, so that nothing a client sends makes the set grow.
    const digest = later ? createHash("sha256").update(cursor).digest("base64") : null;
    const repeated = later && cursors.has(digest);
    if (later && !repeated) {
      if (cursors.size >= MAX_PAGES - 1) truncated = true;
      else cursors.add(digest);
    }
    for (const tool of repeated || truncated ? [] : msg.result.tools) {
      if (!isTool(tool)) continue;
      // A copy: a slice of a long string keeps the whole string alive.
      const name = Array.from(tool.name.slice(0, MAX_KEPT_NAME * 4)).slice(0, MAX_KEPT_NAME).join("");
      if (known.has(name)) continue;
      // Past a cap only the offered names are still kept (they are at most a thousand and some), so that none is reported missing.
      if ((known.size >= MAX_KNOWN || keptChars >= MAX_KEPT_CHARS) && !visible.has(name)) {
        if (!saidTooMany) stderr.write(`toolgate-proxy: the upstream lists more tools than the status keeps (${MAX_KNOWN}); it names only the first ones\n`);
        saidTooMany = true;
        truncated = true;
        continue;
      }
      const description = clean(tool.description, MAX_ITEM);
      keptChars += name.length + description.length;
      known.set(name, description);
    }
    const advertised = new Set(msg.result.tools.filter(isTool).map((tool) => tool.name));
    if (advertised.has(SENTINEL) && !saidClash) {
      saidClash = true;
      stderr.write(`toolgate-proxy: the upstream tool "${SENTINEL}" is hidden by the sentinel\n`);
    }
    const shown = msg.result.tools.filter((tool) => isTool(tool) && tool.name !== SENTINEL && visible.has(tool.name));
    // The last page is the one without a nextCursor. Only then is it known what the upstream advertises as a whole, so only then are the
    // offered names it lacks said, and the sentinel (listed once, and only when nothing is offered) added.
    const last = typeof msg.result.nextCursor !== "string" || msg.result.nextCursor === "";
    if (last) {
      if (!truncated) {
        for (const wanted of visible) {
          if (!known.has(wanted)) stderr.write(`toolgate-proxy: allow-list entry "${wanted}" matches no advertised tool\n`);
        }
      }
      if (visible.size === 0) shown.push(SENTINEL_TOOL);
    }
    return shown;
  };

  // The server's instructions go into the agent's context at the start, and cost up to 4,096 characters whatever the session does with the
  // server. When nothing of the server is offered, they wait in a file of the session (the one that `toolgate need` reads and shows once, when
  // the server's tools are revealed) instead. Anything that stops that leaves them where the server put them.
  const deferInstructions = (instructions) => {
    if (instructions === undefined || visible.size !== 0) return false;
    const note = (why) => {
      if (!saidInstructions) stderr.write(`toolgate-proxy: the server's instructions stay in initialize (${why})\n`);
      saidInstructions = true;
      return false;
    };
    if (typeof instructions !== "string") return note("they are not text");
    if (instructions.trim() === "") return false;
    if (!SAFE_SERVER.test(server)) return note("the server name cannot be part of a file name");
    let text = instructions;
    if (Buffer.byteLength(text) > INSTRUCTIONS_CAP) {
      const buffer = Buffer.from(text);
      let end = INSTRUCTIONS_CAP - Buffer.byteLength(CUT_LINE);
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
      text = buffer.subarray(0, end).toString("utf8") + CUT_LINE;
    }
    const target = path.join(path.dirname(file), `${path.basename(file, ".json")}.${server}.instructions.txt`);
    // Written whole or not at all, for the user only, and never through a link: a new file of its own, renamed over the old one.
    // Named like the temp files of the session file itself (`<id>.json.<pid>.<hex>.tmp`), which toolgate sweeps and removes.
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let created = false;
    try {
      // The sessions folder is looked at again right before the write: it must still be the user's own folder, and not a link.
      if (!privateEntry(path.dirname(file), "dir")) throw Object.assign(new Error("not private"), { code: "EPERM" });
      fs.writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
      created = true;
      fs.renameSync(temp, target);
    } catch (err) {
      try {
        // Only what this call made: a failed `wx` is a file that was already there.
        if (created) fs.rmSync(temp, { force: true });
      } catch {
        // nothing more to do
      }
      return note(`they could not be saved: ${err?.code ?? "error"}`);
    }
    return true;
  };

  const check = () => {
    const entry = readEntry(file, server, env);
    if (!entry) {
      if (!saidUnreadable) stderr.write("toolgate-proxy: session state unreadable, keeping the last tool set\n");
      saidUnreadable = true;
      return;
    }
    saidUnreadable = false;
    const next = offered(entry, env);
    const nextKey = [...next].sort().join("\n");
    if (nextKey === key) return;
    visible = next;
    key = nextKey;
    if (initialized) write(LIST_CHANGED);
    else changedBeforeInitialized = true;
  };

  const api = {
    fromClient(line) {
      const msg = tryParse(line);
      if (!isPlain(msg)) return null;
      if (msg.method === "notifications/initialized" && !("id" in msg)) {
        initialized = true;
        if (changedBeforeInitialized) {
          changedBeforeInitialized = false;
          write(LIST_CHANGED);
        }
        return null;
      }
      if (!("id" in msg)) return null;
      if (msg.method === "initialize") initializeIds.add(idKey(msg.id));
      else if (msg.method === "tools/list") toolsListIds.set(idKey(msg.id), typeof msg.params?.cursor === "string" && msg.params.cursor !== "" ? msg.params.cursor : null);
      else if (msg.method === "tools/call" && msg.params?.name === SENTINEL) {
        return JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: statusText() }] } });
      }
      return null;
    },
    fromUpstream(line) {
      const msg = tryParse(line);
      if (!isPlain(msg) || !("id" in msg)) return line;
      if (initializeIds.delete(idKey(msg.id)) && isPlain(msg.result)) {
        const capabilities = isPlain(msg.result.capabilities) ? msg.result.capabilities : {};
        const tools = isPlain(capabilities.tools) ? capabilities.tools : {};
        const result = { ...msg.result, capabilities: { ...capabilities, tools: { ...tools, listChanged: true } } };
        if (deferInstructions(result.instructions)) delete result.instructions;
        return JSON.stringify({ ...msg, result });
      }
      if (!toolsListIds.has(idKey(msg.id))) return line;
      const cursor = toolsListIds.get(idKey(msg.id));
      toolsListIds.delete(idKey(msg.id));
      if (!isPlain(msg.result) || !Array.isArray(msg.result.tools)) return line;
      // Whatever goes wrong while the list is filtered, the client gets the sentinel and nothing from the unfiltered line.
      try {
        return JSON.stringify({ ...msg, result: { ...msg.result, tools: filterPage(msg, cursor) } });
      } catch {
        return JSON.stringify({ ...msg, result: { ...msg.result, tools: [SENTINEL_TOOL], nextCursor: undefined } });
      }
    },
    start() {
      timer = setIntervalFn(check, CHECK_MS);
      timer.unref?.();
      try {
        watcher = watchFn(path.dirname(file), { persistent: false }, (event, name) => {
          if (!name || name === path.basename(file)) check();
        });
        watcher.on?.("error", () => {});
      } catch {
        // the one-second check does the work
      }
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
      try {
        watcher?.close();
      } catch {
        // already closed
      }
      watcher = null;
    },
  };
  // A message that makes the code throw (an upstream that sends something odd) must not bring the proxy down: the line passes as it is.
  const guard = (fn, fallback) => (line) => {
    try {
      return fn(line);
    } catch {
      return fallback(line);
    }
  };
  return { ...api, fromClient: guard(api.fromClient, () => null), fromUpstream: guard(api.fromUpstream, (line) => line) };
}
