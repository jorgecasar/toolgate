// The state of one toolgate session (#19): which tools of each server wrapped by toolgate-proxy have been revealed. One small JSON file per
// session under `$XDG_STATE_HOME/toolgate/sessions/` (else `~/.local/state/toolgate/sessions/`), a folder only the user can
// enter and a file only the user can read. toolgate writes it (read, change, write to a temp file next to it, rename); the
// proxies only read it (whether a server's instructions were deferred is not kept here: it is true when the proxy wrote
// `<id>.<server>.instructions.txt`). Two toolgate commands changing it at once take turns on `<id>.lock`. Nothing here throws on a bad folder or file: it
// answers with one of the two texts below and the caller goes on with the tools revealed only by a restart.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SAFE_SERVER, SAFE_TOOL } from "./catalog/sanitize.js";
import { printable } from "./assets/common.js";
import { xdgDir } from "./daemonStamp.js";

export const SESSION_VERSION = 1;
/** A session file older than this was left by a launch that did not end cleanly. */
export const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds for what the file may hold: it is not trusted to be small. */
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_SERVERS = 256;
export const MAX_ENABLED = 1024;
const MAX_PATH = 4096;
/** The lock around a change: tried every 50 ms, 40 times, and one older than 10 s is taken to be left by a process that died. */
export const LOCK_RETRY_MS = 50;
export const LOCK_TRIES = 40;
export const LOCK_STALE_MS = 10 * 1000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_FILE = new RegExp(`^(${UUID})\\.json$`);
// Files a session owns, and so the only ones the sweep and the removal touch: its state, its temp files and the
// deferred instructions of its servers.
const OWNED_FILE = new RegExp(`^(${UUID})\\.(?:lock|json(?:\\.[0-9]+\\.[0-9a-f]+\\.tmp)?|[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\.instructions\\.txt)$`);
const posix = process.platform !== "win32";

/** @param {{ env?: Record<string, string | undefined>, homedir?: string }} [options] */
export function sessionsRoot({ env = process.env, homedir = os.homedir() } = {}) {
  const state = xdgDir(env.XDG_STATE_HOME) || path.join(env.HOME || homedir, ".local", "state");
  return path.join(state, "toolgate", "sessions");
}

/** The file is not one toolgate may use (not its own, not private, a link, outside the folder). */
export const refusal = (file) => `toolgate: ${printable(file)} is not a private file of yours; its tools are revealed only by a restart this session`;

/** The session file is not there (it was removed, or the name is stale): not the same thing as a file that failed a check. */
export const missingFailure = (file) => `toolgate: the session file ${printable(file)} is missing; its tools are revealed only by a restart this session`;

// What to say when `file` is not a private session file: that it is missing, or that it is not one toolgate may use.
function notUsable(file) {
  try {
    fs.lstatSync(file);
  } catch (err) {
    if (err.code === "ENOENT") return missingFailure(file);
  }
  return refusal(file);
}

/** The file is fine but cannot be written: the cap, a folder that is not writable, a failed write, a lock that stays taken. */
export const writeFailure = (file, reason) => `toolgate: the session file ${printable(file)} could not be written (${printable(reason)}); its tools are revealed only by a restart this session`;

/** The file is a session file but cannot be read: it is corrupt or over the cap. It is never overwritten. */
export const readFailure = (file, reason) => `toolgate: the session file ${printable(file)} could not be read (${printable(reason)}); its tools are revealed only by a restart this session`;

/** True for `<root>/<uuid>.json` and nothing else: a path elsewhere, a sub-folder or any other name is not a session. */
export function isSessionFile(file, options) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) return false;
  const resolved = path.resolve(file);
  return resolved === file && path.dirname(resolved) === sessionsRoot(options) && SESSION_FILE.test(path.basename(resolved));
}

// `options.uid` stands in for the user in tests: a file of another owner cannot be made without root.
const ownerOf = (options) => options?.uid ?? (posix ? process.getuid() : 0);

// Not a link, of the kind asked, the user's own, and closed to the group and others.
function privateEntry(target, kind, uid) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (kind === "dir" ? !stat.isDirectory() : !stat.isFile()) return false;
  if (!posix) return true;
  return stat.uid === uid && (stat.mode & 0o077) === 0;
}

/** Whether the sessions folder exists and is private. */
export const privateRoot = (options) => privateEntry(sessionsRoot(options), "dir", ownerOf(options));

/** Whether `file` is a session file of this user, in the sessions folder, a plain file closed to others. */
export const privateSession = (file, options) => isSessionFile(file, options) && privateRoot(options) && privateEntry(file, "file", ownerOf(options));

// Every folder that is missing on the way down to `dir` is made with mode 700 (the umask cannot widen it); one that exists is left as it is.
function mkdirPrivate(dir) {
  if (fs.existsSync(dir)) return;
  mkdirPrivate(path.dirname(dir));
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return;
  }
  if (posix) fs.chmodSync(dir, 0o700);
}

// The folder, created with mode 700 when it is missing; an existing one is used only if it is already private.
function ensureRoot(options) {
  const root = sessionsRoot(options);
  try {
    fs.lstatSync(root);
  } catch (err) {
    if (err.code !== "ENOENT") return false;
    try {
      mkdirPrivate(root);
    } catch {
      // another launch made it first, or it cannot be made: the check below decides
    }
  }
  return privateRoot(options);
}

// An absolute, normalized path with no control, format or separator characters in it: it is printed and used to find files.
export const plainPath = (value) => typeof value === "string" && value.length <= MAX_PATH && path.isAbsolute(value) && path.resolve(value) === value && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
export const SAFE_AGENT = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The state as it may be written or trusted, or null: the right version, only plain objects, server and tool names that
 * pass the same checks as the catalog's, and sizes inside the bounds.
 */
export function validState(value) {
  if (!isPlain(value) || value.version !== SESSION_VERSION || !isPlain(value.servers)) return null;
  const names = Object.keys(value.servers);
  if (names.length > MAX_SERVERS) return null;
  const projectDir = value.projectDir;
  if (projectDir !== undefined && !plainPath(projectDir)) return null;
  // The agent the session was launched for (its adapter name): `need` names it in the text that says how to relaunch.
  const agent = value.agent;
  if (agent !== undefined && !(typeof agent === "string" && SAFE_AGENT.test(agent))) return null;
  const servers = {};
  for (const name of names) {
    const entry = value.servers[name];
    if (!SAFE_SERVER.test(name) || !isPlain(entry)) return null;
    if (!Array.isArray(entry.enabled) || entry.enabled.length > MAX_ENABLED) return null;
    if (!entry.enabled.every((tool) => typeof tool === "string" && SAFE_TOOL.test(tool))) return null;
    if (typeof entry.instructionsShown !== "boolean") return null;
    // The tools the proxy offers from the start (its TOOLGATE_ALLOWED_TOOLS), written at launch; a file without them has none.
    const baseline = entry.baseline ?? [];
    if (!Array.isArray(baseline) || baseline.length > MAX_ENABLED || !baseline.every((tool) => typeof tool === "string" && SAFE_TOOL.test(tool))) return null;
    servers[name] = { enabled: [...new Set(entry.enabled)], baseline: [...new Set(baseline)], instructionsShown: entry.instructionsShown };
  }
  return { version: SESSION_VERSION, ...(projectDir === undefined ? {} : { projectDir }), ...(agent === undefined ? {} : { agent }), servers };
}

/**
 * What can be stored of a baseline: the valid, distinct tool names, at most MAX_ENABLED of them, and the entries left out (to be said).
 * @returns {{ kept: string[], dropped: unknown[] }}
 */
export function cleanBaseline(list) {
  const kept = [];
  const dropped = [];
  for (const tool of Array.isArray(list) ? list : []) {
    if (typeof tool === "string" && SAFE_TOOL.test(tool) && kept.length < MAX_ENABLED) {
      if (!kept.includes(tool)) kept.push(tool);
    } else {
      dropped.push(tool);
    }
  }
  return { kept, dropped };
}

// Whole or not at all, for the user only: a temp file in the same folder, renamed over the target.
function writeAtomic(file, state) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * A new session with one entry per active server that toolgate-proxy wraps (a name, or `{ server, baseline }`), all with nothing
 * revealed. `options.projectDir` is the project it was launched for. A name that is not a plain server name is left out.
 * @param {string[]} wrapped
 * @returns {{ file: string, id: string } | { refused: string }}
 */
export function createSession(wrapped, options) {
  const root = sessionsRoot(options);
  if (!Array.isArray(wrapped)) return { refused: writeFailure(root, "no list of servers") };
  if (!ensureRoot(options)) return { refused: refusal(root) };
  const servers = {};
  for (const item of wrapped) {
    const { server, baseline = [] } = typeof item === "string" ? { server: item } : (item ?? {});
    if (typeof server === "string" && SAFE_SERVER.test(server)) servers[server] = { enabled: [], baseline, instructionsShown: false };
  }
  if (Object.keys(servers).length > MAX_SERVERS) return { refused: writeFailure(root, `more than ${MAX_SERVERS} servers`) };
  const state = validState({ version: SESSION_VERSION, ...(options?.projectDir === undefined ? {} : { projectDir: options.projectDir }), ...(options?.agent === undefined ? {} : { agent: options.agent }), servers });
  if (!state) return { refused: writeFailure(root, "the servers or the project folder are not valid") };
  const id = randomUUID();
  const file = path.join(root, `${id}.json`);
  try {
    writeAtomic(file, state);
  } catch (err) {
    return { refused: writeFailure(file, err.code ?? "write failed") };
  }
  return { file, id };
}

// The state in `file`, or the reason it cannot be read; the caller has checked that it is a private session file.
function readOutcome(file) {
  try {
    if (fs.lstatSync(file).size > MAX_FILE_BYTES) return { reason: "too large" };
    const state = validState(JSON.parse(fs.readFileSync(file, "utf8")));
    return state ? { state } : { reason: "not valid" };
  } catch (err) {
    return { reason: err instanceof SyntaxError ? "not valid" : (err.code ?? "unreadable") };
  }
}

/** The state in `file` as `{ state }`, or `{ refused }` with the text to print: not a private session file, or unreadable. */
export function inspectSession(file, options) {
  if (!privateSession(file, options)) return { refused: notUsable(file) };
  const { state, reason } = readOutcome(file);
  return state ? { state } : { refused: readFailure(file, reason) };
}

/** The state in `file`, or null when it is not a private session file of this user or does not hold a valid state. */
export function readSession(file, options) {
  return privateSession(file, options) ? (readOutcome(file).state ?? null) : null;
}

const defaultSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `<id>.lock`, made with `wx` (never through a link) and holding a random token that tells it from another writer's. Taken, it is tried
// again every LOCK_RETRY_MS, LOCK_TRIES times; one that is a link or older than LOCK_STALE_MS is unlinked (once) and tried again. The
// release unlinks the lock only while it still holds this token. Returns `{ release }`, or `{ failed }` with the reason: busy when the
// lock stayed taken, else the error code of what could not be done (a folder that is not writable is not a busy file).
// The lock is best-effort, as decided in #19: it keeps writers that run at the same moment from losing each other's reveals, and it
// has two windows. (1) A lock left over 10 s by a crash, and two writers breaking it at the same instant: one can unlink the lock the
// other has just taken, and both go in. (2) A holder paused for more than 10 s whose lock was broken writes over the one that broke it
// (its release leaves that writer's lock alone). Both need a crash or a stalled process, and a lost change is fixed by the next command.
function takeLock(file, { sleep = defaultSleep, now = Date.now } = {}) {
  const lock = file.replace(/\.json$/, ".lock");
  const token = `${randomUUID()}\n`;
  let broke = false;
  for (let tries = 0; tries < LOCK_TRIES; tries += 1) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return {
        release: () => {
          try {
            if (fs.lstatSync(lock).isFile() && fs.readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
          } catch {
            // gone already: nothing of ours to remove
          }
        },
      };
    } catch (err) {
      if (err.code !== "EEXIST") return { failed: err.code ?? "the lock could not be made" };
    }
    try {
      const stat = fs.lstatSync(lock);
      if (!broke && (stat.isSymbolicLink() || now() - stat.mtimeMs > LOCK_STALE_MS)) {
        broke = true;
        fs.unlinkSync(lock);
        tries -= 1;
        continue;
      }
    } catch {
      // gone between the two calls: the next try takes it
    }
    sleep(LOCK_RETRY_MS);
  }
  return { failed: "the session file is busy" };
}

/**
 * Read, change, write, one writer at a time (the lock). `change` gets a copy and returns the new state; the result is written only
 * if it is valid. Returns `{ state }` with what was written, or `{ refused }` with the text to print when nothing was.
 * @returns {{ state: object } | { refused: string }}
 */
export function updateSession(file, change, options) {
  if (!privateSession(file, options)) return { refused: notUsable(file) };
  const { release, failed } = takeLock(file, options);
  if (!release) return { refused: writeFailure(file, failed) };
  try {
    const { state: current, reason } = readOutcome(file);
    if (!current) return { refused: readFailure(file, reason) };
    const next = validState(change(structuredClone(current)));
    if (!next) return { refused: writeFailure(file, "the new state is not valid") };
    // A change that changes nothing writes nothing: the file keeps its time and its inode, and the sweep is not told the session is alive.
    if (JSON.stringify(next) === JSON.stringify(current)) return { state: current };
    try {
      writeAtomic(file, next);
    } catch (err) {
      return { refused: writeFailure(file, err.code ?? "write failed") };
    }
    return { state: next };
  } finally {
    release();
  }
}

// The helpers below are for `change`: each returns the state with one thing changed, and leaves a server that is not in the
// session alone.
const withServer = (state, server, edit) => (Object.hasOwn(state.servers, server) ? { ...state, servers: { ...state.servers, [server]: edit(state.servers[server]) } } : state);

/** Reveals tools: the union of what was and what is added, so two changes one after the other keep both (at the same moment they take turns on the lock). */
export const enableTools = (state, server, tools) => withServer(state, server, (entry) => ({ ...entry, enabled: [...new Set([...entry.enabled, ...tools])] }));
/** Hides tools again; no tools means all of them. */
export const disableTools = (state, server, tools) => withServer(state, server, (entry) => ({ ...entry, enabled: tools?.length ? entry.enabled.filter((tool) => !tools.includes(tool)) : [] }));
/** Back to the sentinel only, for one server or, without a name, for every server. */
export const resetTools = (state, server) => (server === undefined ? { ...state, servers: Object.fromEntries(Object.entries(state.servers).map(([name, entry]) => [name, { ...entry, enabled: [] }])) } : disableTools(state, server));
/** The deferred instructions of a server have been shown once in this session. */
export const markInstructionsShown = (state, server) => withServer(state, server, (entry) => ({ ...entry, instructionsShown: true }));

// Removes the session's own files in the folder; anything else there is left alone. `lstat` and `unlink` never follow a link: a link
// is removed only under a name no valid session file has as a link (`<uuid>.json`, `<uuid>.lock`).
function removeOwned(root, matches, options) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!matches(name)) continue;
    const target = path.join(root, name);
    try {
      const stat = fs.lstatSync(target);
      const removable = stat.isFile() || (stat.isSymbolicLink() && /\.(?:json|lock)$/.test(name));
      if (removable && (!posix || stat.uid === ownerOf(options))) fs.unlinkSync(target);
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/** Says the session is alive: its modification time is now, so the sweep does not take it for one a crash left behind. */
export function touchSession(file, options, now = new Date()) {
  if (!privateSession(file, options)) return false;
  try {
    fs.utimesSync(file, now, now);
  } catch {
    return false;
  }
  // Its instructions files are as alive as it is: the sweep goes by each file's own time.
  const id = SESSION_FILE.exec(path.basename(file))[1];
  const root = path.dirname(file);
  try {
    for (const name of fs.readdirSync(root)) {
      if (OWNED_FILE.exec(name)?.[1] !== id || !name.endsWith(".instructions.txt")) continue;
      const target = path.join(root, name);
      if (fs.lstatSync(target).isFile()) fs.utimesSync(target, now, now);
    }
  } catch {
    // an instructions file that went meanwhile: nothing to refresh
  }
  return true;
}

/** The most of a server's deferred instructions that is read: what the proxy writes is cut at this size. */
export const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

/**
 * The instructions the proxy of `server` saved next to the session file (`<id>.<server>.instructions.txt`), or null when there are none
 * or the file cannot be trusted: the session must be a private session file of this user, the server one of its own, and the file a plain
 * file of the user's, closed to the others, of a size the proxy could have written. Stored as received: the caller decides how to show it.
 */
export function readInstructions(file, server, options) {
  if (!privateSession(file, options) || typeof server !== "string" || !SAFE_SERVER.test(server)) return null;
  const target = path.join(path.dirname(file), `${SESSION_FILE.exec(path.basename(file))[1]}.${server}.instructions.txt`);
  if (!privateEntry(target, "file", ownerOf(options))) return null;
  try {
    if (fs.lstatSync(target).size > MAX_INSTRUCTIONS_BYTES) return null;
    return fs.readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

/** The session ends: its state file, its temp files and its instructions files go, under the lock. Never throws. */
export function removeSession(file, options) {
  if (!isSessionFile(file, options) || !privateRoot(options)) return;
  const id = SESSION_FILE.exec(path.basename(file))[1];
  const { release } = takeLock(file, options);
  if (!release) return; // taken (or not writable), so the files stay for the sweep
  try {
    removeOwned(path.dirname(file), (name) => name !== `${id}.lock` && OWNED_FILE.exec(name)?.[1] === id, options);
  } finally {
    release();
  }
}

/** Removes the files of this user in the sessions folder that nothing has touched for a week: a crashed launch leaves them. */
export function sweepSessions({ now = Date.now(), maxAgeMs = SWEEP_MAX_AGE_MS, ...options } = {}) {
  const root = sessionsRoot(options);
  if (!privateRoot(options)) return;
  removeOwned(root, (name) => {
    if (!OWNED_FILE.test(name)) return false;
    try {
      return now - fs.lstatSync(path.join(root, name)).mtimeMs > maxAgeMs;
    } catch {
      return false;
    }
  }, options);
}
