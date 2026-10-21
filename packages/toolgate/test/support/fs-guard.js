// The read guard of the real home (#306). A test must never read what the developer keeps in the folders toolgate and the agents own:
// `<config>/toolgate`, `<state>/toolgate`, `<cache>/qmd`, `<cache>/toolgate`, `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.agents`, `~/.gemini`,
// `~/.config/opencode`, `~/.opencode` and `~/.toolgate`. The rest of the real home is not refused (the repository may live under it, and node
// resolves modules there). `installFsGuard` wraps the read entry points of `node:fs` (sync, callback and promise forms): a read under a refused
// folder throws `hermetic: real home read <path> is not allowed in tests` (`existsSync` answers false), is written to the violations log,
// and the process fails when it exits. Writes are not covered: they already go to the sandbox.
// A child process is guarded with `--import fs-guard-preload.js`, which reads the folders and the log from its environment.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLED = Symbol.for("toolgate.hermetic.fsGuard");
const absolute = (value) => (typeof value === "string" && path.isAbsolute(value) ? value : null);

/**
 * The folders of the real home that a test must not read. `home` is the real home (`TG_HERMETIC_REAL_HOME` in the guard's own tests,
 * else the account's); the XDG folders are the ones the environment names, else the defaults under `home`.
 */
export function refusedFolders({ env = process.env, homedir = os.homedir } = {}) {
  const fake = absolute(env.TG_HERMETIC_REAL_HOME);
  const home = fake ?? homedir();
  const xdg = (name, fallback) => (fake ? null : absolute(env[name])) ?? path.join(home, fallback);
  const config = xdg("XDG_CONFIG_HOME", ".config");
  const state = xdg("XDG_STATE_HOME", ".local/state");
  const cache = xdg("XDG_CACHE_HOME", ".cache");
  const data = xdg("XDG_DATA_HOME", ".local/share");
  return [
    path.join(config, "toolgate"),
    path.join(state, "toolgate"),
    path.join(data, "toolgate"),
    path.join(cache, "qmd"),
    path.join(cache, "toolgate"),
    path.join(home, ".claude"),
    path.join(home, ".claude.json"),
    path.join(home, ".codex"),
    path.join(home, ".agents"),
    path.join(home, ".gemini"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".opencode"),
    path.join(home, ".toolgate"),
  ];
}

const pathOf = (value) => {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  return null;
};

export function installFsGuard({ folders, log, record = false }) {
  if (globalThis[INSTALLED]) return;
  globalThis[INSTALLED] = true;
  // The originals, kept before anything is wrapped: the guard reads and writes with these only.
  const realpath = fs.realpathSync;
  const append = fs.appendFileSync;
  // Each folder as written and as the file system resolves it (a home behind a link), once.
  const roots = new Set();
  for (const folder of folders) {
    roots.add(path.resolve(folder));
    try {
      roots.add(realpath(folder));
    } catch {
      // A folder that does not exist has no other name.
    }
    try {
      roots.add(path.join(realpath(path.dirname(folder)), path.basename(folder)));
    } catch {
      // Neither has its parent.
    }
  }
  const under = (target) => [...roots].some((root) => target === root || target.startsWith(root + path.sep));
  // The path as text when the guard refuses it, else null (a descriptor or anything that is not a path is not the guard's to judge).
  const refusedPath = (value) => {
    const text = pathOf(value);
    if (text === null || text === "") return null;
    const resolved = path.resolve(text);
    return under(resolved) ? resolved : null;
  };
  const record_ = (shown) => {
    const line = String(shown).replace(/[\r\n]/g, " ");
    try {
      append(log, `fs ${line}\n`);
    } catch {
      // The sandbox was deleted under us: the refusal still stands.
    }
    if (record) process.stderr.write(`GUARD fs: ${line}\n`);
  };
  const error = (shown) => new Error(`hermetic: real home read ${String(shown).replace(/[\r\n]/g, " ")} is not allowed in tests`);

  const wrapSync = (target, name, { answers } = {}) => {
    const original = target[name];
    if (typeof original !== "function") return;
    const wrapped = function (first, ...rest) {
      const shown = refusedPath(first);
      if (shown === null) return Reflect.apply(original, this, [first, ...rest]);
      record_(shown);
      if (answers !== undefined) return answers;
      throw error(shown);
    };
    Object.defineProperty(wrapped, "name", { value: name });
    for (const key of Object.keys(original)) wrapped[key] = original[key];
    target[name] = wrapped;
  };
  const wrapCallback = (name, { exists = false } = {}) => {
    const original = fs[name];
    if (typeof original !== "function") return;
    const wrapped = function (first, ...rest) {
      const shown = refusedPath(first);
      if (shown === null) return Reflect.apply(original, this, [first, ...rest]);
      record_(shown);
      const callback = rest.findLast((arg) => typeof arg === "function");
      if (callback) process.nextTick(callback, ...(exists ? [false] : [error(shown)]));
      return undefined;
    };
    Object.defineProperty(wrapped, "name", { value: name });
    for (const key of Object.keys(original)) wrapped[key] = original[key];
    fs[name] = wrapped;
  };
  const wrapPromise = (name) => {
    const original = fs.promises[name];
    if (typeof original !== "function") return;
    const wrapped = async function (first, ...rest) {
      const shown = refusedPath(first);
      if (shown === null) return Reflect.apply(original, this, [first, ...rest]);
      record_(shown);
      throw error(shown);
    };
    Object.defineProperty(wrapped, "name", { value: name });
    fs.promises[name] = wrapped;
  };

  for (const name of ["readFileSync", "readdirSync", "statSync", "lstatSync", "openSync", "accessSync", "realpathSync", "readlinkSync", "opendirSync", "createReadStream"]) wrapSync(fs, name);
  wrapSync(fs, "existsSync", { answers: false });
  wrapSync(fs.realpathSync, "native");
  for (const name of ["readFile", "readdir", "stat", "lstat", "open", "access", "realpath", "readlink", "opendir"]) wrapCallback(name);
  wrapCallback("exists", { exists: true });
  wrapSync(fs.realpath, "native");
  for (const name of ["readFile", "readdir", "stat", "lstat", "open", "access", "realpath", "readlink", "opendir"]) wrapPromise(name);
  // `import { readFileSync } from "node:fs"` and `node:fs/promises` follow what was replaced above.
  syncBuiltinESMExports();
}
