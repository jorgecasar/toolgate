// What toolgate knows about the qmd daemon it started: which qmd, which process, when. One small file per port under
// `$XDG_STATE_HOME/toolgate/` (else `~/.local/state/toolgate/`), shared by every project. It is only written after
// toolgate started a daemon that answered, and only read to tell whether qmd was upgraded since (#136).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @param {number} port
 * @param {{ env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string}
 */
export function stampPath(port, { env = process.env, homedir = os.homedir() } = {}) {
  const state = xdgDir(env.XDG_STATE_HOME) || path.join(env.HOME || homedir, ".local", "state");
  return path.join(state, "toolgate", `daemon-${port}.json`);
}

/** An XDG base directory is an absolute path; a relative one is to be ignored (XDG spec), and then the default applies. */
export const xdgDir = (value) => (typeof value === "string" && path.isAbsolute(value) ? value : undefined);
/** The longest qmd version toolgate keeps or prints: a stamp file is not trusted to be short. */
export const VERSION_MAX = 64;
const isStamp = (value, port) =>
  value !== null &&
  typeof value === "object" &&
  Number.isSafeInteger(value.pid) &&
  value.pid > 0 &&
  (value.version === null || typeof value.version === "string") &&
  value.port === port &&
  typeof value.startedAt === "string";

/**
 * The stamp of the daemon on `port`, or null when there is none or the file does not hold one.
 * @returns {{ pid: number, version: string|null, port: number, startedAt: string }|null}
 */
export function readStamp(port, options) {
  try {
    const value = JSON.parse(fs.readFileSync(stampPath(port, options), "utf8"));
    return isStamp(value, port) ? { ...value, version: value.version === null ? null : value.version.slice(0, VERSION_MAX) } : null;
  } catch {
    return null;
  }
}

/** Never throws: a state folder that cannot be written only means the next launch cannot compare versions. */
export function writeStamp(port, { pid, version, startedAt = new Date().toISOString() }, options) {
  try {
    const file = stampPath(port, options);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Whole or not at all, and for the user only: written next to the stamp and renamed over it.
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ pid, version, port, startedAt })}\n`, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

export function removeStamp(port, options) {
  try {
    fs.rmSync(stampPath(port, options), { force: true });
  } catch {
    // nothing to remove, or it cannot be removed: the stamp is then discarded the next time it is read as invalid
  }
}

/**
 * First line of `<bin> --version`, trimmed; null when qmd cannot be run or prints nothing.
 * @param {string} bin
 * @param {(bin: string, args: string[]) => string} execFn
 * @returns {string|null}
 */
export function qmdVersion(bin, execFn) {
  try {
    return String(execFn(bin, ["--version"])).split("\n")[0].trim().slice(0, VERSION_MAX) || null;
  } catch {
    return null;
  }
}
