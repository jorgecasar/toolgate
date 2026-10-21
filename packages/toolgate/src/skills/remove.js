// `toolgate skills remove`: deletes only what toolgate installed (a name in the lock), only a copy
// nobody edited unless forced, and cleans up the lock, the licence and the skill's overrides.
import fs from "node:fs";
import path from "node:path";
import { configLayerPaths } from "../config.js";
import { overridesFor, readConfigFile, writeConfigFile } from "../configFile.js";
import { SAFE_NAME, printable } from "../assets/common.js";
import { assertPlainStore, hashOrNull, readLock, slug, storeFor, writeLock } from "./install.js";

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * @param {Object} options
 * @param {string[]} [options.names]
 * @param {string} [options.source] Remove every item of this source
 * @param {boolean} [options.force] Delete an edited copy
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.keepOverrides]
 * @param {Array<{ name: string, path: string }>} [options.configLayers]
 */
export function removeAssets(kind, { projectDir, userDir, level = "project", names = [], source, force = false, dryRun = false, keepOverrides = false, configLayers, env }) {
  const { root, storeDir, lockFile: lockPath } = storeFor(kind, level, { projectDir, userDir });
  const lockFile = path.join(root, lockPath);
  // A cloned repository can ship `.toolgate/skills` as a symlink to a folder of yours: nothing is deleted through it.
  assertPlainStore(root, storeDir);
  const lock = readLock(lockFile, kind.lockKey);
  const locked = lock[kind.lockKey];
  const result = { level, removed: [], refused: [], overrides: { removed: [], elsewhere: [], error: null }, sources: [] };

  if (source && names.length > 0) {
    result.refused.push({ name: source, reason: "use either --source or names, not both" });
    return result;
  }
  const wanted = [...new Set(source ? Object.keys(locked).filter((n) => locked[n].source === source) : names)];
  if (wanted.length === 0) {
    result.refused.push({ name: source ?? "(none)", reason: source ? `nothing installed from ${source} at the ${level} level` : "no name given" });
    return result;
  }

  const storeAbs = path.join(root, storeDir);
  const storeReal = fs.existsSync(storeAbs) ? fs.realpathSync(storeAbs) : storeAbs;
  const origin = new Map();

  for (const name of wanted) {
    const refusal = refusalFor({ kind, name, level, locked, storeAbs, storeReal, force });
    if (refusal) {
      result.refused.push({ name, reason: refusal });
      continue;
    }
    if (!dryRun) {
      try {
        fs.rmSync(path.join(storeAbs, kind.fileName?.(name) ?? name), { recursive: true, force: true });
      } catch (err) {
        result.refused.push({ name, reason: `could not delete it: ${err.message.split("\n")[0]}` });
        continue;
      }
    }
    result.removed.push(name);
    origin.set(name, locked[name].source);
    if (!dryRun) delete locked[name];
  }

  // A source is dropped, with its license, when nothing else comes from it. In a dry run the lock
  // still holds the removed entries, so they are left out of the count.
  const stillThere = new Set(Object.entries(locked).filter(([name]) => dryRun ? !result.removed.includes(name) : true).map(([, entry]) => entry.source));
  result.sources = [...new Set(origin.values())].filter((spec) => !stillThere.has(spec));
  if (!dryRun && result.removed.length) {
    for (const spec of result.sources) {
      delete lock.sources[spec];
      fs.rmSync(path.join(storeAbs, ".licenses", slug(spec)), { recursive: true, force: true });
    }
    writeLock(lockFile, lock, kind.lockKey);
  }

  if (!keepOverrides && result.removed.length) {
    const layers = configLayers ?? configLayerPaths({ cwd: projectDir, env: env ?? process.env });
    // The copies and the lock are already gone: a config that cannot be read is reported (and the
    // exit code says so), but the caller still reindexes and the other layers are still cleaned.
    removeOverrides(result, layers, level, dryRun);
  }
  return result;
}

// Why a name cannot be removed, or null when it can.
function refusalFor({ kind, name, level, locked, storeAbs, storeReal, force }) {
  if (!SAFE_NAME.test(name)) return "not a valid skill name";
  if (!Object.hasOwn(locked, name)) return `not installed by toolgate at the ${level} level (delete your own skills by hand)`;
  // A hand-edited lock: an entry without a source (or with a hash that is not text) cannot be tied to anything, so
  // nothing is deleted for it, with or without --force. This is decided before any file is touched.
  if (typeof locked[name].source !== "string" || (locked[name].hash !== undefined && typeof locked[name].hash !== "string")) return "its lock entry is incomplete or malformed (fix .toolgate/skills.lock.json, or delete the folder by hand)";
  // A unit is a folder (a skill, a hook) or, for a kind with `fileName`, one file (a command, a permission).
  const asFile = kind.fileName !== undefined;
  const dir = path.join(storeAbs, kind.fileName?.(name) ?? name);
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return null; // Already gone: the lock entry is still cleaned up.
  }
  if (stat.isSymbolicLink() || !(asFile ? stat.isFile() : stat.isDirectory()) || !inside(storeReal, fs.realpathSync(dir))) return asFile ? "its file is not a plain file inside the store" : "its folder is not a plain directory inside the store";
  if (!force && hashOrNull(dir, kind.hash) !== locked[name].hash) return "edited since it was installed (use --force to delete it)";
  return null;
}

// The override of a removed skill goes from the config of the same level; another layer's is left
// and mentioned.
function removeOverrides(result, layers, level, dryRun) {
  const errors = [];
  // One layer at a time, each on its own: a layer that cannot be read does not stop the others.
  for (const layer of layers) {
    try {
      const { data } = readConfigFile(layer.path);
      let changed = false;
      for (const name of result.removed) {
        const { list, mine } = overridesFor(data, name);
        if (mine.length === 0) continue;
        if (layer.name !== level) {
          result.overrides.elsewhere.push({ name, layer: layer.name });
          continue;
        }
        result.overrides.removed.push(name);
        if (dryRun) continue;
        data.skills.overrides = list.filter((entry) => entry?.skill !== name);
        if (data.skills.overrides.length === 0) delete data.skills.overrides;
        if (Object.keys(data.skills).length === 0) delete data.skills;
        changed = true;
      }
      if (changed) writeConfigFile(layer.path, data);
    } catch (err) {
      errors.push(`${layer.name} config: ${err.message.split("\n")[0]}`);
    }
  }
  if (errors.length) result.overrides.error = errors.join("; ");
}

export function formatRemove(result, { dryRun } = {}) {
  // Names come from the command line and the lock, sources from the lock, errors from files: none is printed raw.
  const p = (value) => printable(value);
  const list = (names) => names.map(p).join(", ");
  const lines = [];
  if (result.removed.length) lines.push(`toolgate: ${dryRun ? "would remove" : "removed"} ${list(result.removed)} (${result.level} level)`);
  for (const { name, reason } of result.refused) lines.push(`toolgate: ${p(name)}: ${p(reason)}`);
  for (const spec of result.sources) lines.push(`  ${dryRun ? "would drop" : "dropped"} ${p(spec)} and its license: nothing else comes from it`);
  if (result.overrides.removed.length) lines.push(`  ${dryRun ? "would remove" : "removed"} the overrides of ${list(result.overrides.removed)} from the ${result.level} config`);
  if (result.overrides.error) lines.push(`  the overrides were not cleaned up: ${p(result.overrides.error)}`);
  for (const { name, layer } of result.overrides.elsewhere) lines.push(`  ${p(name)} still has an override in the ${layer} config; remove it there if it is no longer needed`);
  return `${lines.join("\n")}\n`;
}

// A refusal, or overrides that could not be cleaned up, both leave something for the user to do.
export const removeExitCode = (result) => (result.refused.length > 0 || result.overrides.error ? 1 : 0);
