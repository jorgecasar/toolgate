// Shared QMD HTTP daemon lifecycle (SPEC §7.2 / DESIGN "Router").
// One `qmd mcp --http --daemon` process serves every agent, so the embedding, reranker and
// query-expansion models are loaded once instead of once per agent session.
// Idempotent: starting an already healthy daemon is a no-op.
import { execFileSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printable } from "./assets/common.js";
import { LOCAL_HOSTS, validPort } from "./configFile.js";
import { qmdVersion, readStamp, removeStamp, writeStamp, xdgDir } from "./daemonStamp.js";
import { withProgress } from "./progress.js";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_PORT = 8181;

// Health polls (500 ms apart) after spawning. The default is short so a daemon that never comes up does
// not hold back a launch; commands that start the daemon on purpose wait for a cold start, which loads
// the embedding models and takes up to a minute.
export const DEFAULT_START_ATTEMPTS = 20;
export const COLD_START_ATTEMPTS = 120;


/**
 * @param {number|string} [port]
 * @returns {{ health: string, mcp: string }}
 */
export function daemonUrls(port = DEFAULT_PORT) {
  const base = `http://localhost:${port}`;
  return { health: `${base}/health`, mcp: `${base}/mcp` };
}

/** The program toolgate runs as qmd: `qmd.bin` (already vetted when the layers were merged) or `qmd` on the PATH. */
export const qmdBinOf = (config) => config?.qmd?.bin ?? "qmd";


/**
 * Port of the daemon toolgate is allowed to manage, or null when the endpoint is remote or
 * the daemon is disabled (`router.qmdUrl: null`). The one place that decides it, in this order:
 * `flagPort` (`toolgate daemon --port`) > `router.qmdUrl` > `QMD_SHARED_PORT` > `qmd.port` > 8181.
 * @param {Object} [config]
 * @param {Record<string, string | undefined>} [env]
 * @param {{ flagPort?: number }} [options]
 * @returns {number|null}
 */
export function managedPort(config, env = process.env, { flagPort } = {}) {
  if (flagPort) return flagPort;
  const configured = config?.router?.qmdUrl;
  if (configured === null) return null;
  if (typeof configured === "string") {
    try {
      const url = new URL(configured);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !LOCAL_HOSTS.has(url.hostname)) return null;
      return Number(url.port) || DEFAULT_PORT;
    } catch {
      return null;
    }
  }
  return Number(env.QMD_SHARED_PORT) || validPort(config?.qmd?.port) || DEFAULT_PORT;
}

/**
 * The origin (scheme, host and port: never a path, query or credentials) of a `router.qmdUrl` that parses and does not point
 * at this machine, which toolgate does not manage; null for anything else: a string that does not parse, a scheme that is
 * not http or https (whose origin would print as "null" or name a server toolgate never talks to).
 * @param {{ router?: { qmdUrl?: unknown } }} [config]
 * @returns {string|null}
 */
export function remoteQmdOrigin(config) {
  const configured = config?.router?.qmdUrl;
  if (typeof configured !== "string") return null;
  try {
    const url = new URL(configured);
    return (url.protocol === "http:" || url.protocol === "https:") && !LOCAL_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/** True when nothing listens on the port of this machine: a server can bind it (and is closed at once). */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * The first port from `from` up to `last` where `probe` says nothing listens, or null when there is none.
 * @param {number} [from]
 * @param {{ probe?: (port: number) => Promise<boolean>, last?: number }} [options]
 * @returns {Promise<number|null>}
 */
export async function nextFreePort(from = 8182, { probe = portIsFree, last = 8281 } = {}) {
  for (let port = from; port <= last; port++) if (await probe(port)) return port;
  return null;
}

export function defaultExec(bin, args, options = {}) {
  return withProgress(bin, args, () =>
    execFileSync(bin, args, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    }),
  );
}

/**
 * @param {{ port?: number, fetchFn?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<{ running: boolean, state: "up"|"down"|"hung", port: number, url: string, uptime?: number }>} `state`: up (2xx), down (refused or unreachable), hung (timed out, or answered without 2xx).
 */
export async function daemonStatus({
  port = DEFAULT_PORT,
  fetchFn = globalThis.fetch,
  timeoutMs = 1000,
} = {}) {
  const { health, mcp } = daemonUrls(port);
  try {
    // `manual`: a redirect is an answer, not a place to go. Following it would let whatever holds the port send this probe to another one.
    const res = await fetchFn(health, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    // It answered but not with 2xx (a 3xx included): something holds the port and is not a healthy daemon.
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { running: false, state: "hung", port, url: mcp };
    }
    const body = await res.json().catch(() => ({}));
    return { running: true, state: "up", port, url: mcp, uptime: body.uptime };
  } catch (err) {
    // A probe that ran out of time means something holds the port and does not answer; any other failure is a refused or unreachable port.
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { running: false, state: timedOut ? "hung" : "down", port, url: mcp };
  }
}

/**
 * Make sure the shared daemon answers on `port`, starting it when it does not.
 * Never throws: the caller decides what a failure means.
 *
 * A daemon toolgate started leaves a stamp (see daemonStamp.js). When the stamp is that daemon's (its pid holds the port)
 * and the installed qmd is not the one that started it, the daemon is restarted so an upgrade takes effect. A stamp that
 * is not valid any more is discarded and nothing is restarted.
 * @param {Object} [options]
 * @param {number} [options.port]
 * @param {string} [options.qmdBin]
 * @param {(bin: string, args: string[]) => string} [options.execFn]
 * @param {typeof fetch} [options.fetchFn]
 * @param {(ms: number) => Promise<void>} [options.sleepFn]
 * @param {number} [options.attempts] Health polls after spawning.
 * @param {number} [options.intervalMs]
 * @param {Record<string, string | undefined>} [options.env] Where the stamp and qmd's pid file live.
 * @param {string} [options.homedir]
 * @param {{ write: (text: string) => unknown }} [options.stderr]
 * @returns {Promise<{ running: boolean, started: boolean, port: number, url: string, reason?: string }>}
 */
export async function ensureDaemon({
  port = DEFAULT_PORT,
  qmdBin = "qmd",
  execFn = defaultExec,
  fetchFn = globalThis.fetch,
  sleepFn = delay,
  attempts = DEFAULT_START_ATTEMPTS,
  intervalMs = 500,
  env = process.env,
  homedir = os.homedir(),
  stderr = process.stderr,
} = {}) {
  const where = { env, homedir };
  let current = await daemonStatus({ port, fetchFn });

  const stamp = readStamp(port, where);
  if (stamp) {
    // The stamp is the daemon's only while its pid is alive, holds the port and is the pid qmd itself manages: `qmd mcp stop`
    // stops the pid in qmd's file, so a stamp that disagrees with it must never trigger a restart.
    if (!current.running || stamp.pid !== verifiedManagedPid(env, { port, homedir, execFn }) || !portOwners(port, { execFn }).includes(stamp.pid)) {
      removeStamp(port, where);
    } else {
      const installed = qmdVersion(qmdBin, execFn);
      if (installed && stamp.version && installed !== stamp.version) {
        stderr.write(`toolgate: qmd changed from ${printable(stamp.version)} to ${printable(installed)}; restarting the qmd daemon\n`);
        return restartDaemon({
          port,
          qmdBin,
          env,
          homedir,
          stderr,
          stopFn: (options) => stopDaemon({ ...options, execFn, homedir }),
          ensureFn: (options) => ensureDaemon({ port, qmdBin, execFn, fetchFn, sleepFn, intervalMs, env, homedir, stderr, ...options }),
          statusFn: (options) => daemonStatus({ ...options, fetchFn }),
          holderFn: (holderPort) => portHolder(holderPort, { env, execFn }),
          sleepFn,
        });
      }
    }
  }
  if (current.running) return { ...current, started: false };

  let alreadyAlive = false;
  try {
    execFn(qmdBin, ["mcp", "--http", "--daemon", "--port", String(port)]);
  } catch (err) {
    // qmd refuses to start a second daemon while its pid is alive: that process may just be
    // slow to answer, so keep polling instead of reporting a failure.
    const detail = `${err.stderr ?? ""}${err.message ?? ""}`;
    alreadyAlive = /already running/i.test(detail);
    if (!alreadyAlive) {
      return {
        running: false,
        started: false,
        port,
        url: current.url,
        reason: `could not start qmd daemon: ${detail.trim()}`,
      };
    }
  }

  for (let i = 0; i < attempts; i++) {
    await sleepFn(intervalMs);
    const status = await daemonStatus({ port, fetchFn });
    if (status.running) {
      // Only a daemon toolgate itself started is stamped: one that was already alive may have been started by anyone.
      const pid = alreadyAlive ? null : managedPid(env);
      if (pid !== null) writeStamp(port, { pid, version: qmdVersion(qmdBin, execFn) }, where);
      return { ...status, started: !alreadyAlive };
    }
  }
  return {
    running: false,
    started: !alreadyAlive,
    port,
    url: current.url,
    reason: `qmd daemon did not answer on port ${port} after ${attempts * intervalMs}ms`,
  };
}

/**
 * Stop the daemon through qmd itself (it owns the pid file). Stopping a daemon that is not
 * running is not an error: `ok` is only false when qmd could not be run. With a `port`, the stamp
 * of the daemon on that port goes away with it.
 * @param {{ qmdBin?: string, execFn?: (bin: string, args: string[]) => string, port?: number, env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {{ ok: boolean, stopped: boolean, message: string }}
 */
export function stopDaemon({ qmdBin = "qmd", execFn = defaultExec, port, env = process.env, homedir = os.homedir() } = {}) {
  try {
    const message = execFn(qmdBin, ["mcp", "stop"]).trim();
    if (port !== undefined) removeStamp(port, { env, homedir });
    return { ok: true, stopped: !/not running/i.test(message), message };
  } catch (err) {
    const detail = `${err.stderr ?? ""}${err.message ?? ""}`.trim();
    return { ok: false, stopped: false, message: `could not stop qmd daemon: ${detail}` };
  }
}

// Decimal digits only: `Number` would also take "0x10" or "1e3" as a pid.
const pidOf = (text) => {
  if (typeof text !== "string" || !/^\d+$/.test(text)) return null;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};
const unique = (pids) => [...new Set(pids.filter((pid) => pid !== null))];
// What each platform's tool prints for "who listens on this port"; each parser gives every pid, in the order printed.
const LOOKUPS = {
  lsof: (port) => ["lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (out) => unique(out.split("\n").map((line) => pidOf(line.trim())))],
  ss: (port) => ["ss", ["-ltnpH", `sport = :${port}`], (out) => unique([...out.matchAll(/\bpid=(\d+)/g)].map((match) => pidOf(match[1])))],
  // A listening line has no remote peer (`0.0.0.0:0` or `[::]:0`): that is told by the address, not by the word
  // LISTENING, which Windows translates.
  netstat: (port) => [
    "netstat",
    ["-ano"],
    (out) =>
      unique(
        out.split("\n").map((line) => {
          const columns = line.trim().split(/\s+/);
          const listening = columns.length >= 5 && ["0.0.0.0:0", "[::]:0"].includes(columns[2]) && columns[1].endsWith(`:${port}`);
          return listening ? pidOf(columns[4]) : null;
        })
      ),
  ],
};
/**
 * Every pid listening on a port, in the order the platform tool prints them: several when a parent and its workers
 * share the socket. Empty when there is none or it cannot be told. darwin and linux use `lsof` (linux falls back to
 * `ss` without it), win32 uses `netstat`. It only looks; it never stops anything.
 * @param {number} port
 * @param {{ platform?: string, execFn?: (bin: string, args: string[]) => string }} [options]
 * @returns {number[]}
 */
export function portOwners(port, { platform = process.platform, execFn = defaultExec } = {}) {
  if (validPort(port) === null) return [];
  const tools = platform === "win32" ? ["netstat"] : platform === "linux" ? ["lsof", "ss"] : ["lsof"];
  for (const tool of tools) {
    const [bin, args, parse] = LOOKUPS[tool](port);
    try {
      return parse(String(execFn(bin, args)));
    } catch {
      // This tool is missing or failed: try the next one, and give no pid when none works.
    }
  }
  return [];
}
/** The first pid listening on a port, or null (see `portOwners`). */
export function portOwner(port, options) {
  return portOwners(port, options)[0] ?? null;
}
/**
 * The pid in the file qmd keeps for the daemon it started: `$XDG_CACHE_HOME/qmd/mcp.pid`, else `~/.cache/qmd/mcp.pid`,
 * the same rule as qmd. Null when there is no such file or it holds no pid.
 * @param {Record<string, string | undefined>} [env]
 * @returns {number|null}
 */
export function managedPid(env = process.env) {
  const cache = xdgDir(env.XDG_CACHE_HOME) || path.join(env.HOME || os.homedir(), ".cache");
  try {
    return pidOf(fs.readFileSync(path.join(cache, "qmd", "mcp.pid"), "utf8").trim());
  } catch {
    return null;
  }
}
/** How long a process has run, in ms, from `ps -o etime=` ([[dd-]hh:]mm:ss, no locale or time zone in it); null when it cannot be told. */
function elapsedMs(pid, execFn) {
  try {
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(String(execFn("ps", ["-o", "etime=", "-p", String(pid)])).trim());
    if (!match) return null;
    const [, days = 0, hours = 0, minutes, seconds] = match;
    return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  } catch {
    return null;
  }
}
/**
 * `managedPid`, but only while the process is still the daemon qmd wrote the pid for: a pid in a stale `mcp.pid` can be reused
 * by any other process, and that one must not count as toolgate's (it would never be told apart, and `qmd mcp stop` would
 * signal it). The daemon was running before its pid was written to the file, and before toolgate stamped it, so a process
 * that started after that moment is another one. The moment is the stamp's `startedAt` when the stamp is for this pid, else
 * the modification time of `mcp.pid` (also when the stamp's time is unusable or in the future). When `ps` is missing or its answer is not
 * understood nothing can be checked, and the file is trusted as it was before this check. Windows has no `ps`: the same.
 * @returns {number|null}
 */
export function verifiedManagedPid(env = process.env, { port, homedir = os.homedir(), platform = process.platform, execFn = defaultExec, nowFn = Date.now } = {}) {
  const pid = managedPid(env);
  if (pid === null || platform === "win32") return pid;
  const stamp = port === undefined ? null : readStamp(port, { env, homedir });
  let reference = stamp?.pid === pid ? Date.parse(stamp.startedAt) : NaN;
  if (Number.isNaN(reference) || reference > nowFn()) {
    try {
      const cache = xdgDir(env.XDG_CACHE_HOME) || path.join(env.HOME || os.homedir(), ".cache");
      reference = fs.statSync(path.join(cache, "qmd", "mcp.pid")).mtimeMs;
    } catch {
      return null;
    }
  }
  const elapsed = elapsedMs(pid, execFn);
  // ps counts whole seconds, and the stamp is written once the daemon answers: allow a few seconds either way.
  return elapsed === null || nowFn() - elapsed <= reference + START_TOLERANCE_MS ? pid : null;
}
const START_TOLERANCE_MS = 3000;
/**
 * Who holds the port, as far as toolgate can tell: `pid` is the listener (null when it cannot be told) and `foreign`
 * says the port is not toolgate's: none of the listeners is the pid qmd keeps in `mcp.pid` (null when unknown). With
 * several listeners the port is toolgate's when any of them is that pid; otherwise `pid` is the first one. It only looks.
 * @param {number} port
 * @param {{ env?: Record<string, string | undefined>, platform?: string, execFn?: Function }} [options]
 * @returns {{ pid: number|null, foreign: boolean|null }}
 */
export function portHolder(port, { env = process.env, platform, execFn, homedir, nowFn } = {}) {
  const pids = portOwners(port, { platform, execFn });
  if (pids.length === 0) return { pid: null, foreign: null };
  const managed = verifiedManagedPid(env, { port, platform, execFn, homedir, nowFn });
  return pids.includes(managed) ? { pid: managed, foreign: false } : { pid: pids[0], foreign: true };
}
/** The command to give the user for stopping a process toolgate did not start (toolgate never does it). */
export const killHint = (pid, platform = process.platform) => (platform === "win32" ? `taskkill /PID ${pid}` : `kill ${pid}`);
/** Why a daemon cannot be started: the port is held by a process toolgate cannot stop. `pid` is null when unknown. */
export function heldMessage(port, pid, platform = process.platform) {
  return pid === null
    ? `port ${port} still answers after stopping the daemon, and toolgate cannot tell which process holds it; stop that process and run "toolgate daemon start"`
    : `port ${port} is held by pid ${pid}, which toolgate did not start; stop it with "${killHint(pid, platform)}" and run "toolgate daemon start"`;
}
/**
 * Stops the daemon, waits until it no longer answers (stopping is not instant, and starting while the
 * old one still answers would keep it), and starts it again. Resolves to the start result.
 */
export async function restartDaemon({
  port,
  qmdBin,
  env = process.env,
  homedir = os.homedir(),
  stderr,
  stopFn = stopDaemon,
  ensureFn = ensureDaemon,
  statusFn = daemonStatus,
  sleepFn = delay,
  holderFn = () => ({ pid: null, foreign: null }),
  platform = process.platform,
  stopAttempts = 20,
  intervalMs = 250,
}) {
  // A successful stop removes the stamp; it is put back when the old daemon turns out to still be serving.
  const old = readStamp(port, { env, homedir });
  const stopped = stopFn({ qmdBin, port, env });
  if (!stopped.ok) return { running: false, started: false, port, reason: stopped.message };
  let answering = (await statusFn({ port })).running;
  for (let i = 0; i < stopAttempts && answering; i++) {
    await sleepFn(intervalMs);
    answering = (await statusFn({ port })).running;
  }
  // Still answering: starting now would report a restart while the old process kept serving its old index. A process qmd's
  // pid file does not know holds the port, and toolgate never stops what it did not start. When it is qmd's own daemon, or
  // its holder cannot be told, the stamp goes back so that the next launch sees the old version again and retries.
  if (answering) {
    const holder = holderFn(port);
    const unknown = holder.foreign === null || managedPid(env) === null;
    if (holder.foreign === true && !unknown) return { running: false, started: false, port, reason: heldMessage(port, holder.pid, platform) };
    // Only the stamp of qmd's own daemon goes back: one whose pid is not the managed one belongs to something else.
    if (old && old.pid === managedPid(env)) writeStamp(port, old, { env, homedir });
    const reason = unknown
      ? heldMessage(port, null, platform)
      : `the qmd daemon (pid ${holder.pid}) is still running after "qmd mcp stop"; stop it with "${killHint(holder.pid, platform)}" and run "toolgate daemon start"`;
    return { running: false, started: false, port, reason };
  }
  const result = await ensureFn({ port, qmdBin, env, stderr, attempts: COLD_START_ATTEMPTS });
  if (result.running && result.started) {
    const holder = holderFn(port);
    if (holder.foreign === true) return { running: false, started: false, port, reason: heldMessage(port, holder.pid, platform) };
  }
  return result;
}
