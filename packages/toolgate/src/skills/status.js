// `toolgate skills status`: what is installed at each level, where it came from, and whether it
// still matches the lock. Read-only; offline unless `remote` is set.
import { SAFE_NAME, printable } from "../assets/common.js";
import fs from "node:fs";
import path from "node:path";
import { defaultExec } from "../daemon.js";
import { SKILL_KIND, hashOrNull, readLock, storeFor } from "./install.js";
import { lockSourceUrl, remoteHead } from "./remote.js";
import { mergeOverrides, scanSkills } from "./scan.js";

const LEVELS = ["user", "project", "local"];
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const levelRank = (level) => LEVELS.indexOf(level);

/**
 * @param {Object} options
 * @param {import("./install.js").SKILL_KIND} [options.kind]
 * @param {string} options.projectDir
 * @param {string} [options.userDir]
 * @param {string[]} [options.levels] Which levels to read the stores of (all by default)
 * @param {Array<{ dir: string, level?: string }>} [options.sources] What the index reads
 * @param {Array<{ skill: string }>} [options.overrides]
 * @param {string[]} [options.disabledLevels]
 * @param {boolean} [options.remote] Ask each source's remote for its current commit
 * @param {Function} [options.execFn] Runs git (a test seam)
 * @param {boolean} [options.allowFile] Accept file:// sources (tests only)
 * @returns {{ rows: Array<Record<string, any>>, upstream: Array<Record<string, any>>, problems: string[] }}
 */
export function assetStatus({
  kind = SKILL_KIND,
  projectDir,
  userDir,
  levels = LEVELS,
  sources = [],
  overrides = [],
  disabledLevels = [],
  remote = false,
  execFn = defaultExec,
  allowFile = false,
  env,
  homedir,
}) {
  const problems = [];
  const rows = new Map();
  const row = (level, name) => {
    const key = `${level}\0${name}`;
    if (!rows.has(key)) rows.set(key, { name, level, origin: "own", commit: null, states: [], shadows: [], shadowedBy: null, overrides: [], ignored: disabledLevels.includes(level) });
    return rows.get(key);
  };
  const applied = mergeOverrides(overrides);
  const upstream = [];

  for (const level of levels) {
    if (level === "user" && !userDir) continue;
    const store = storeFor(kind, level, { projectDir, userDir });
    const storeAbs = path.join(store.root, store.storeDir);
    let lock;
    try {
      lock = readLock(path.join(store.root, store.lockFile), kind.lockKey);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    const locked = lock[kind.lockKey];
    for (const what of lock.invalid) problems.push(`the ${level} lock: ${what}`);
    for (const [name, entry] of Object.entries(locked)) {
      // A committed lock can name anything: only a plain name is turned into a path.
      if (!SAFE_NAME.test(name)) {
        problems.push(`the ${level} lock has an entry whose name is not a plain name, it was not checked: ${name}`);
        continue;
      }
      const r = row(level, name);
      r.origin = entry.source;
      r.commit = entry.commit ?? null;
      const dir = path.join(storeAbs, kind.fileName?.(name) ?? name);
      if (!fs.existsSync(dir)) r.states.push("missing");
      else {
        try {
          r.states.push(hashOrNull(dir, kind.hash) === entry.hash ? "ok" : "edited");
        } catch (err) {
          r.states.push("unreadable");
          problems.push(`${name} (${level}) could not be read: ${err.message.split("\n")[0]}`);
        }
      }
    }
    if (fs.existsSync(storeAbs)) {
      for (const entry of fs.readdirSync(storeAbs, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        // What a store entry stands for: a folder is a skill, a `.md` file is a command.
        const unit = kind.unitName ? kind.unitName(entry) : entry.isDirectory() || entry.isSymbolicLink() ? entry.name : null;
        if (unit !== null && !Object.hasOwn(locked, unit)) row(level, unit).states.push("unlocked");
      }
    }
    if (remote) {
      for (const [spec, source] of Object.entries(lock.sources)) {
        if (source.local) continue; // imported from a folder of this machine: there is no remote to ask
        const item = { level, source: spec, locked: source.commit, upstream: null, newer: false, error: null, pinned: false };
        try {
          const url = lockSourceUrl(spec, source, { allowFile, projectDir, env, homedir });
          item.upstream = remoteHead({ url, ref: source.ref ?? undefined, execFn, allowFile, strictHostKeys: true });
          // A pinned commit cannot be looked up by name: only that the server answers is checked.
          if (/^[0-9a-f]{40}$/.test(source.ref ?? "")) {
            remoteHead({ url, execFn, allowFile, strictHostKeys: true });
            item.pinned = true;
          }
          item.newer = item.upstream !== null && item.upstream !== source.commit;
          if (item.upstream === null) item.error = "the ref no longer exists upstream";
        } catch (err) {
          item.error = causeOf(err);
        }
        upstream.push(item);
      }
    }
  }

  if (sources.length) {
    try {
      for (const skill of kind.scan ? kind.scan(sources) : scanSkills(sources, overrides)) {
        const r = row(skill.level, skill.name);
        r.shadows = skill.shadows;
        if (skill.effectiveTools) {
          r.tools = skill.effectiveTools;
          r.toolsDefault = skill.toolsDefault;
        }
        for (const level of skill.shadows) row(level, skill.name).shadowedBy = skill.level;
        if (r.states.length === 0) r.states.push("ok");
      }
    } catch (err) {
      problems.push(`${kind.plural ?? "skills"} could not be scanned: ${err.message.split("\n")[0]}`);
    }
  }

  for (const r of rows.values()) {
    r.overrides = Object.keys(applied.get(r.name) ?? {});
    if (r.states.length === 0) r.states.push("ok");
  }
  const sorted = [...rows.values()].sort((a, b) => compare(a.name, b.name) || levelRank(a.level) - levelRank(b.level));
  return { rows: sorted, upstream, problems };
}

// The line git gives as the reason ("fatal: repository ... not found"), not the command line.
const causeOf = (err) => {
  const lines = `${err.stderr ?? ""}\n${err.message}`.split("\n").map((line) => line.trim());
  return lines.find((line) => /^(fatal|error):/.test(line)) ?? err.message.split("\n")[0];
};

/** Whether `--check` should fail: something drifted, is gone, or upstream moved. */
export function hasDrift({ rows, upstream, problems }) {
  return (
    problems.length > 0 ||
    rows.some((r) => r.states.some((s) => s === "edited" || s === "missing" || s === "unreadable")) ||
    upstream.some((u) => u.newer)
  );
}

/** `--remote` could not ask some source: not drift, but the answer is incomplete. */
export const hasUnreachable = ({ upstream }) => upstream.some((u) => u.error);

export function formatStatus({ rows, upstream, problems }, { noun = "skills" } = {}) {
  const lines = rows.map((r) => {
    const origin = r.origin === "own" ? "own" : printable(r.commit ? `${r.origin}@${r.commit.slice(0, 7)}` : r.origin);
    const extra = [
      ...(r.shadows.length ? [`shadows ${r.shadows.join(", ")}`] : []),
      ...(r.shadowedBy ? [`shadowed by ${r.shadowedBy}`] : []),
      ...(r.ignored ? ["ignored by this project"] : []),
    ];
    const notes = [...r.states.filter((s) => s !== "ok" || extra.length === 0), ...extra];
    const overrides = r.overrides.length ? `overrides: ${r.overrides.map(printable).join(", ")}` : "";
    // A subagent shows the tools it really gets.
    if (r.tools) notes.push(`tools: ${r.tools.map(printable).join(", ")}${r.toolsDefault ? " (default)" : ""}`);
    // Names, sources and errors come from folders, locks and remotes: none is printed raw.
    return [printable(r.name), r.level, origin, notes.join(", "), overrides].join("\t").trimEnd();
  });
  for (const u of upstream) {
    if (u.error) lines.push(`${printable(u.source)} (${u.level})\tcould not check upstream: ${printable(u.error)}`);
    else if (u.pinned) lines.push(`${printable(u.source)} (${u.level})\tpinned to ${u.locked?.slice(0, 7)}: the server answered, whether the commit still exists is not checked`);
    else if (u.newer) lines.push(`${printable(u.source)} (${u.level})\tupstream newer: ${u.locked?.slice(0, 7)} -> ${u.upstream.slice(0, 7)}`);
  }
  for (const problem of problems) lines.push(`problem: ${printable(problem)}`);
  return lines.length ? `${lines.join("\n")}\n` : `toolgate: no ${noun} installed\n`;
}
