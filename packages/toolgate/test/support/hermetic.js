// Preloaded into every test process (`node --test --import ./test/support/hermetic.js`). A test must never reach the
// user's real qmd index: this gives the process a throwaway HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME, a QMD_SHARED_PORT other than 8181, and puts a fake
// `qmd` first on PATH. The fake records the call and exits 97, and the process fails when it exits if any call was
// recorded, even if the test swallowed the error. A test that needs qmd passes its own fake execFn. The agent CLIs
// (claude, codex, agy, opencode, kj) are faked as "not installed" so `doctor` and `init` do not depend on the machine.
// TMPDIR, XDG_DATA_HOME and XDG_STATE_HOME are inside the sandbox too, and it is removed on SIGINT and SIGTERM as well.
// `fetch` and every TCP connect are guarded too (net-guard.js, which also holds the rules): a port from 8181 to 8281 (the user's qmd daemon and the
// range init picks from), on any host, or any host that is not loopback, is refused before anything is sent. The refusal is written to the same log
// and so fails the process when it exits, even if the test swallowed the error. Loopback on other ports and Unix sockets stay open: tests start
// their own servers on random ports. A test that needs the daemon's answer passes its own fake (`status`, `fetchFn`).
// `TG_HERMETIC_FETCH=record` is a switch for listing the leaks: each refusal is also printed at once, and the exit does not fail. It never lets
// a request through. Every child process a test starts gets the same guard (see CHILD_PRELOADS), and its refusals reach this log too.
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { installFsGuard, refusedFolders } from "./fs-guard.js";
import "./net-guard.js";

const root = process.env.TG_TEST_SANDBOX_ROOT || os.tmpdir();
// The owner's pid is in the name: a process killed while stuck in synchronous code cannot clean up, and the next run sweeps what it left.
const PREFIX = "toolgate-hermetic-";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
};
for (const name of fs.readdirSync(root)) {
  const owner = /^toolgate-hermetic-(\d+)-/.exec(name)?.[1];
  if (!owner || alive(Number(owner))) continue;
  const stale = path.join(root, name);
  try {
    if (fs.lstatSync(stale).isDirectory()) fs.rmSync(stale, { recursive: true, force: true });
  } catch {
    // Another test process swept it first: the folder is gone, which is what we wanted.
  }
}
const sandbox = fs.mkdtempSync(path.join(root, `${PREFIX}${process.pid}-`));
const log = path.join(sandbox, "qmd-violations.log");
const bin = path.join(sandbox, "bin");
fs.mkdirSync(bin);
fs.mkdirSync(path.join(sandbox, "home"));
fs.mkdirSync(path.join(sandbox, "t"));
fs.writeFileSync(log, "");
const shellQuoted = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
for (const name of ["claude", "codex", "agy", "opencode", "kj"]) {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "GUARD: ${name} is not installed in tests" >&2\nexit 127\n`, { mode: 0o755 });
}
fs.writeFileSync(path.join(bin, "qmd"), `#!/bin/sh\nprintf '%s\\n' "qmd $*" >> ${shellQuoted(log)}\necho "GUARD: a test reached the real qmd: qmd $*" >&2\nexit 97\n`, { mode: 0o755 });
// The real home and XDG folders are read here, before they are replaced: what a test must not read is under them.
const refused = refusedFolders();
process.env.TG_HERMETIC_FS_REFUSED = JSON.stringify(refused);
process.env.TG_HERMETIC_FS_LOG = log;
process.env.HOME = path.join(sandbox, "home");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.XDG_CACHE_HOME = path.join(sandbox, "cache");
process.env.XDG_DATA_HOME = path.join(sandbox, "data");
process.env.XDG_STATE_HOME = path.join(sandbox, "state");
process.env.TMPDIR = path.join(sandbox, "t");
// Never the default 8181: a test that starts a daemon (or finds one) must not meet the user's own. One port per process.
// 30000-49999 does not overlap init's free-port range (8182-8281); if that range ever moves above 30000, move this one too.
process.env.QMD_SHARED_PORT = String(30000 + (process.pid % 20000));
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;


// The same switch lists the reads of the real home: `TG_HERMETIC_FS=record` prints each one at once and does not fail the exit.
installFsGuard({ folders: refused, log, record: process.env.TG_HERMETIC_FS === "record" });
const record = process.env.TG_HERMETIC_FETCH === "record";
// The fetch and TCP guards live in net-guard.js, which a child process loads too: what they refuse is appended to this log.
process.env.TG_HERMETIC_LOG = log;
// Every child process a test starts gets the guards, whatever `env` the test passes (`env: {}` included, or one built by hand): its `NODE_OPTIONS`
// is the child's own, if any, followed by `--import` of each module below. A grandchild started by a shell or by the CLI inherits them too, and a
// child that is not node ignores them. A child that is itself a hermetic test process (it loads this file with `--import`) is left as it is: it
// installs everything by itself, and in the order its test wants. A future Worker must pass `execArgv: ["--import", <module>]` for each.
const CHILD_PRELOADS = [new URL("./net-guard.js", import.meta.url).href, new URL("./fs-guard-preload.js", import.meta.url).href];
const OWN_PRELOAD = /[\\/]support[\\/]hermetic\.js$/;
function guardedOptions(options) {
  const base = options.env ?? process.env;
  const own = base.NODE_OPTIONS ?? "";
  const missing = CHILD_PRELOADS.filter((url) => !own.includes(url));
  const NODE_OPTIONS = [own, ...missing.map((url) => `--import ${url}`)].filter(Boolean).join(" ");
  // The read guard of the real home takes its folders and its log from the child's environment (see fs-guard-preload.js): the ones of this process,
  // unless the test's own `env` names others.
  return { ...options, env: { TG_HERMETIC_FS_REFUSED: JSON.stringify(refused), TG_HERMETIC_FS_LOG: log, ...(process.env.TG_HERMETIC_FS === "record" ? { TG_HERMETIC_FS: "record" } : {}), ...base, NODE_OPTIONS, TG_HERMETIC_LOG: log } };
}
// The options are the argument after the command and after its argument list, when the call takes one (`exec` and `execSync` take none). An
// argument list that is `undefined` or `null` with more arguments behind it is still a list slot: `spawn(cmd, undefined, { cwd })` has its options
// third. One is added when the call has none.
const TAKES_ARGS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "fork"]);
function withChildGuards(args, name) {
  if (args.some((arg) => Array.isArray(arg) && arg.some((word) => typeof word === "string" && OWN_PRELOAD.test(word)))) return args;
  const out = [...args];
  const listSlot = TAKES_ARGS.has(name) && (Array.isArray(out[1]) || ((out[1] === undefined || out[1] === null) && out.length > 2));
  const at = listSlot ? 2 : 1;
  const given = out[at];
  if (typeof given === "function") out.splice(at, 0, guardedOptions({}));
  else if (given === undefined || given === null) out[at] = guardedOptions({});
  else if (typeof given === "object") out[at] = guardedOptions(given);
  return out;
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "fork", "exec", "execSync"]) {
  const original = childProcess[name];
  const wrapped = function (...args) {
    return Reflect.apply(original, this, withChildGuards(args, name));
  };
  Object.defineProperties(wrapped, { name: { value: name }, length: { value: original.length } });
  // `util.promisify(exec)` and `(execFile)` use their own implementation, which would start the child without the guards.
  const custom = original[promisify.custom];
  if (custom) Object.defineProperty(wrapped, promisify.custom, { value: (...args) => Reflect.apply(custom, undefined, withChildGuards(args, name)) });
  childProcess[name] = wrapped;
}
syncBuiltinESMExports();
process.on("exit", () => {
  let calls = "";
  try {
    calls = fs.readFileSync(log, "utf8").trim();
  } catch {
    // The sandbox was deleted under us: nothing was recorded that we can read.
  }
  const lines = calls ? calls.split("\n") : [];
  const qmdCalls = lines.filter((line) => !line.startsWith("fetch ") && !line.startsWith("connect ") && !line.startsWith("listen ") && !line.startsWith("fs "));
  const listens = lines.filter((line) => line.startsWith("listen "));
  const reads = lines.filter((line) => line.startsWith("fs "));
  const fetches = lines.filter((line) => line.startsWith("fetch "));
  const connects = lines.filter((line) => line.startsWith("connect "));
  if (qmdCalls.length) {
    process.stderr.write(`\nGUARD: this test process reached qmd without a fake execFn:\n${qmdCalls.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (fetches.length && !record) {
    process.stderr.write(`\nGUARD: this test process made a real fetch without a fake status or fetchFn:\n${fetches.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (reads.length && process.env.TG_HERMETIC_FS !== "record") {
    process.stderr.write(`\nGUARD: this test process read the real home (give the test its own HOME / XDG folders):\n${reads.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (connects.length && !record) {
    process.stderr.write(`\nGUARD: this test process tried a real connection:\n${connects.join("\n")}\n`);
    process.exitCode = 1;
  }
  if (listens.length && !record) {
    process.stderr.write(`\nGUARD: this test process tried a real listener:\n${listens.join("\n")}\n`);
    process.exitCode = 1;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});
// process.exit runs the exit hook above, so an interrupted run does not leave the sandbox behind.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) process.on(signal, () => process.exit(code));
