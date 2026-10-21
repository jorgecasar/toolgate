// Importing a unit that is built from a local file (the settings of an agent) through the same gate as an install: it is
// written to the store, and locked with a `local:` source, only when its exact content is approved here. Without an approval it
// waits, and nothing is written or locked. Same rules as the other imports for what is already there.
import fs from "node:fs";
import path from "node:path";
import { unitKey } from "./approval.js";
import { assertPlainStore, clearStaging, hashOrNull, readLock, recordedOf, replaceUnit, storeFor, writeLock } from "../skills/install.js";

/**
 * @returns {{ imported: string[], updated: string[], unchanged: string[], skipped: object[], waiting: object[] }}
 */
export function importReviewed(kind, { item, label, level, projectDir, userDir, approvals, force = false, dryRun = false }) {
  const result = { imported: [], updated: [], unchanged: [], skipped: [], waiting: [] };
  const { root, storeDir, lockFile: lockPath } = storeFor(kind, level, { projectDir, userDir });
  assertPlainStore(root, storeDir);
  const lockFile = path.join(root, lockPath);
  const lock = readLock(lockFile, kind.lockKey);
  const locked = lock[kind.lockKey];
  const storeAbs = path.join(root, storeDir);
  if (!dryRun) clearStaging(path.join(root, path.dirname(storeDir), ".staging"), { storeAbs, locked, kind });
  const spec = `local:${label}`;
  // The same name at two levels is an error, as for install: a unit never hides another.
  const clash = kind.clash?.(item.name, { level, projectDir, userDir });
  if (clash) {
    result.skipped.push({ name: item.name, reason: `already exists at the ${clash} level; remove one (a ${kind.noun} never hides another)` });
    return result;
  }
  const target = path.join(storeAbs, kind.fileName?.(item.name) ?? item.name);
  const entry = Object.hasOwn(locked, item.name) ? locked[item.name] : undefined;
  const present = fs.existsSync(target);
  let current;
  try {
    current = present ? hashOrNull(target, kind.hash) : undefined;
  } catch (err) {
    result.skipped.push({ name: item.name, reason: `could not be read: ${err.message.split("\n")[0]}` });
    return result;
  }
  if (present && !force) {
    if (!entry) result.skipped.push({ name: item.name, reason: "already exists and was not installed by toolgate (use --force to replace it)" });
    else if (entry.source !== spec) result.skipped.push({ name: item.name, reason: `installed from ${entry.source} (use --force to replace it)` });
    else if (current !== entry.hash) result.skipped.push({ name: item.name, reason: "edited since it was imported (use --force to overwrite it)" });
    if (result.skipped.length) return result;
  }
  const hash = kind.sourceHash(item.dir, item);
  // Whatever the user approves is this exact content, on this machine: without it the unit waits.
  const key = unitKey({ projectDir, level, kind: kind.noun, name: item.name });
  if (approvals?.has(key, hash) !== true) {
    result.waiting.push({ name: item.name, hash, key, preview: kind.preview?.(item) ?? null, before: null, ...(kind.waitingExtra?.(item) ?? {}) });
    return result;
  }
  if (present && entry?.hash === hash && entry.source === spec && current === hash) {
    result.unchanged.push(item.name);
    return result;
  }
  (present ? result.updated : result.imported).push(item.name);
  if (dryRun) return result;
  try {
    replaceUnit(kind, { root, storeDir, name: item.name, from: item.dir, item });
  } catch (err) {
    (present ? result.updated : result.imported).pop();
    result.skipped.push({ name: item.name, reason: `could not be written: ${err.code ?? err.message}` });
    return result;
  }
  locked[item.name] = { source: spec, path: label, hash, ...recordedOf(item) };
  lock.sources[spec] = { path: label, local: true };
  writeLock(lockFile, lock, kind.lockKey);
  return result;
}
