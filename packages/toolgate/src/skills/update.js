// `toolgate skills update`: moves what toolgate installed to the current upstream of the ref its
// lock recorded. It never adds an item, never touches one the lock does not know, and writes
// nothing at all for a source that cannot be fetched.
import { unitKey } from "../assets/approval.js";
import fs from "node:fs";
import path from "node:path";
import { SAFE_NAME, printable } from "../assets/common.js";
import { assertPlainStore, clearStaging, copyLicenses, filesOf, hashOrNull, licenseFilesOf, locateBase, readLock, recordedOf, replaceUnit, slug, storeFor, writeLock } from "./install.js";
import { checkRef, fetchSource, lockSourceUrl, redactCredentials } from "./remote.js";

const isText = (file) => /\.(md|mdx|txt)$/i.test(file);

// Lines in one text that are not in the other, both ways: a rough size of the change.
function linesChanged(before, after) {
  const was = new Set(before.split("\n"));
  const now = new Set(after.split("\n"));
  return [...now].filter((line) => !was.has(line)).length + [...was].filter((line) => !now.has(line)).length;
}

// Files added, removed and changed between the copy on disk and the new upstream folder, and the
// things in them that change what the agent will do.
function diffUnit(kind, from, to) {
  const before = new Set(from ? filesOf(from) : []);
  const after = new Set(filesOf(to));
  const diff = { added: [], removed: [], changed: [], notable: [] };
  for (const file of after) {
    if (!before.has(file)) {
      diff.added.push(file);
      continue;
    }
    const old = fs.readFileSync(path.join(from, file));
    const now = fs.readFileSync(path.join(to, file));
    if (!old.equals(now)) diff.changed.push({ file, lines: isText(file) ? linesChanged(old.toString("utf8"), now.toString("utf8")) : null });
  }
  for (const file of before) if (!after.has(file)) diff.removed.push(file);
  for (const file of [...diff.added, ...diff.changed.map((c) => c.file)]) {
    if (!isText(file)) diff.notable.push(`${file} is not a text file; toolgate never runs it, but the agent might if the skill says so`);
  }
  if (from && kind.describe) {
    try {
      const was = kind.describe(from);
      const now = kind.describe(to);
      if (was.description !== now.description) diff.notable.push("the description changed");
      const gained = now.mcps.filter((m) => !was.mcps.includes(m));
      const lost = was.mcps.filter((m) => !now.mcps.includes(m));
      if (gained.length) diff.notable.push(`now requires the MCP server ${gained.join(", ")}`);
      if (lost.length) diff.notable.push(`no longer requires the MCP server ${lost.join(", ")}`);
    } catch {
      // The old copy may be unreadable; the file lists above still tell the story.
    }
  }
  return diff;
}

// The same for a kind whose unit is a single normalized text (a command): the copy on disk against the text
// the new upstream file would be installed as.
function diffText(kind, from, item) {
  const diff = { added: [], removed: [], changed: [], notable: [] };
  const file = kind.fileName ? kind.fileName(item.name) : item.name;
  const after = item.text;
  if (!from) diff.added.push(file);
  else if (kind.unitText(from) !== after) diff.changed.push({ file, lines: linesChanged(kind.unitText(from), after) });
  if (from && kind.describe) {
    try {
      const was = kind.describe(from);
      const now = kind.describe(item.dir);
      if (was.description !== now.description) diff.notable.push("the description changed");
      const gained = now.mcps.filter((m) => !was.mcps.includes(m));
      const lost = was.mcps.filter((m) => !now.mcps.includes(m));
      if (gained.length) diff.notable.push(`now requires the MCP server ${gained.join(", ")}`);
      if (lost.length) diff.notable.push(`no longer requires the MCP server ${lost.join(", ")}`);
    } catch {
      // The old copy may be unreadable; the line counts above still tell the story.
    }
  }
  return diff;
}
const diffOf = (kind, from, item) => (kind.unitText ? diffText(kind, from, item) : diffUnit(kind, from, item.dir));

function licenseChanged(checkout, installedDir) {
  if (!fs.existsSync(installedDir)) return false;
  const names = licenseFilesOf(checkout);
  return names.some((n) => {
    const kept = path.join(installedDir, n);
    return !fs.existsSync(kept) || !fs.readFileSync(kept).equals(fs.readFileSync(path.join(checkout, n)));
  });
}

const newReport = (source, info) => ({
  // What the report shows, in every output format, never carries a password or token of the URL.
  source: redactCredentials(source),
  from: info.commit ?? null,
  to: null,
  error: null,
  updated: [],
  restored: [],
  unchanged: [],
  kept: [],
  conflicts: [],
  removedUpstream: [],
  pruned: [],
  skipped: [],
  newUpstream: [],
  details: {},
  licenseChanged: false,
  licenseAccepted: [],
  licenseSkipped: [],
  waiting: [],
});

/** How many items of a source were brought up to date or are as they should be. */
const appliedCount = (r) => r.updated.length + r.restored.length + r.unchanged.length + r.kept.length + r.pruned.length;

/**
 * What to do with an item that is still upstream, from three facts: the copy exists, it was edited
 * (differs from the lock) and upstream differs from the lock.
 * @returns {"unchanged" | "kept" | "conflict" | "update"}
 */
function classify({ present, edited, same, force }) {
  if (present && !edited && same) return "unchanged";
  if (edited && !force) return same ? "kept" : "conflict";
  return "update";
}

/**
 * Brings the items of one source in the lock up to the checkout, filling `report`. Returns whether
 * every item could be handled (a conflict or an invalid upstream item keeps the source behind).
 */
function updateSource(kind, ctx, { spec, owned, info, checkout, fetched, located, covers }, report) {
  const { root, storeDir, locked, dryRun, force, prune, acceptLicense, lock, review, approvals, keyOf } = ctx;
  const { items, skipped } = kind.discover(located.base);
  const byName = new Map(items.map((i) => [i.name, i]));
  const invalid = new Map(skipped.map((s) => [s.name, s.reason]));
  let complete = true;

  for (const [name, entry] of owned) {
    const target = path.join(root, storeDir, kind.fileName?.(name) ?? name);
    const present = fs.existsSync(target);
    const current = present ? hashOrNull(target, kind.hash) : null;
    const edited = present && current !== entry.hash;
    const item = byName.get(name);

    if (!item) {
      const reason = invalid.get(kind.skippedName ? kind.skippedName(entry, located) : path.basename(entry.path ?? name));
      if (reason) {
        report.skipped.push({ name, reason: `invalid upstream: ${reason}` });
        complete = false;
      } else if (prune && (!edited || force) && review) {
        // Removing a unit of a kind that needs review can widen what is allowed (a deny rule), so it is never done on its own.
        report.waiting.push({ name, hash: null, key: keyOf(name), reason: "removed upstream" });
      } else if (prune && (!edited || force)) {
        report.pruned.push(name);
        if (!dryRun) {
          fs.rmSync(target, { recursive: true, force: true });
          delete locked[name];
          ctx.lockChanged = true;
        }
      } else {
        report.removedUpstream.push(name);
      }
      continue;
    }

    const upstreamHash = (kind.sourceHash ?? kind.hash)(item.dir, item);
    // A copy that already is what upstream has (a run died after replacing it, before the lock was
    // written) is not an edit: only the lock catches up.
    const adopted = present && edited && current === upstreamHash;
    const action = adopted ? "adopt" : classify({ present, edited, same: upstreamHash === entry.hash, force });
    // A kind that needs review changes nothing on its own: a new content waits for an approval of its hash, `--force` included.
    if (review && !["unchanged", "kept", "conflict"].includes(action) && approvals?.has(keyOf(name), upstreamHash) !== true) {
      // What the user is asked about: the new content, and the copy it would replace.
      const before = present ? (() => { try { return kind.preview?.(kind.parse?.(target) ?? null, { stored: true, dir: target }) ?? null; } catch { return null; } })() : null;
      report.waiting.push({ name, hash: upstreamHash, key: keyOf(name), preview: kind.preview?.(item) ?? null, before, ...(kind.waitingExtra?.(item) ?? {}) });
      continue;
    }
    if (action === "adopt") {
      report.updated.push(name);
      report.details[name] = { added: [], removed: [], changed: [], notable: ["the copy already matched upstream; only the lock was brought up to date"] };
      if (!dryRun) {
        locked[name] = { source: spec, commit: fetched.commit, path: path.relative(checkout, item.dir), hash: upstreamHash, ...recordedOf(item) };
        ctx.lockChanged = true;
      }
    } else if (action === "unchanged") report.unchanged.push(name);
    else if (action === "kept") report.kept.push(name);
    else if (action === "conflict") {
      report.conflicts.push(name);
      report.details[name] = diffOf(kind, target, item);
      complete = false;
    } else {
      (present ? report.updated : report.restored).push(name);
      report.details[name] = diffOf(kind, present ? target : null, item);
      if (!dryRun) {
        replaceUnit(kind, { root, storeDir, name, from: item.dir, item });
        locked[name] = { source: spec, commit: fetched.commit, path: path.relative(checkout, item.dir), hash: upstreamHash, ...recordedOf(item) };
        ctx.lockChanged = true;
      }
    }
  }

  const excluded = new Set(info.exclude ?? []);
  report.newUpstream = items.filter((i) => !Object.hasOwn(locked, i.name) && !excluded.has(i.name)).map((i) => i.name);
  report.licenseChanged = licenseChanged(checkout, path.join(root, storeDir, ".licenses", slug(spec)));
  // The source's commit moves only when every item of the source (not only the ones asked for)
  // reached it. Each item also records the commit it
  // came from, so after a partial update the entries are the truth and the source says where the
  // last complete update stopped.
  if (!dryRun && complete && covers && appliedCount(report) > 0) {
    lock.sources[spec] = { ...info, commit: fetched.commit, path: located.subdir };
    ctx.lockChanged = true;
  }
  // The license is copied with the skills that moved, and, only when asked, on its own: a change nobody accepts is never applied.
  const accepting = acceptLicense && report.licenseChanged;
  // Not part of the report's fields (it is not in --json): the license of the skills that moved is already the new one.
  const copiedWithSkills = () => Object.defineProperty(report, "licenseCopied", { value: true, enumerable: false });
  if (dryRun) {
    if (accepting) report.licenseAccepted = licenseFilesOf(checkout);
    else if (report.licenseChanged && (report.updated.length || report.restored.length)) copiedWithSkills();
  } else if (report.updated.length || report.restored.length || accepting) {
    const copied = copyLicenses(checkout, root, spec, storeDir);
    report.licenseSkipped = copied.skipped;
    if (accepting && copied.dir) report.licenseAccepted = licenseFilesOf(checkout).filter((name) => !copied.skipped.some((skip) => skip.name === name));
    else if (copied.dir) copiedWithSkills();
  }
}

/**
 * @param {Object} options
 * @param {string[]} [options.names] Only these items (all of the lock when empty)
 * @param {string} [options.source] Only this source
 * @param {boolean} [options.dryRun] Fetch and report, write nothing outside the cache
 * @param {boolean} [options.force] Overwrite an edit and take items of another origin
 * @param {boolean} [options.prune] Delete what upstream removed
 * @param {boolean} [options.acceptLicense] Copy the upstream license files when they changed, even if no item did
 * @returns {{ level: string, sources: Array<Record<string, any>>, unknown: string[], unknownSource: string | null }}
 */
export function updateAssets(kind, { approvals = null, projectDir, userDir, level = "project", cache, names = [], source, dryRun = false, force = false, prune = false, acceptLicense = false, execFn, allowFile = false, env, homedir }) {
  const { root, storeDir, lockFile: lockPath } = storeFor(kind, level, { projectDir, userDir });
  const lockFile = path.join(root, lockPath);
  const lock = readLock(lockFile, kind.lockKey);
  const locked = lock[kind.lockKey];
  // Names come from a file that may be committed by someone else: nothing that is not a plain name
  // is ever turned into a path.
  const safe = Object.keys(locked).filter((name) => SAFE_NAME.test(name));
  const unknown = names.filter((n) => !safe.includes(n));
  const invalidNames = Object.keys(locked).filter((name) => !SAFE_NAME.test(name)).map(redactCredentials);
  const allSpecs = [...new Set(safe.map((name) => locked[name].source))].sort();
  const invalidEntries = lock.invalid.map(redactCredentials);
  const result = { level, acceptLicense, sources: [], unknown, invalidNames, invalidEntries, unknownSource: source && !allSpecs.includes(source) ? redactCredentials(source) : null };
  assertPlainStore(root, storeDir);
  // What an interrupted replace left aside goes back to the store before anything is compared with upstream.
  result.recovered = dryRun ? [] : clearStaging(path.join(root, path.dirname(storeDir), ".staging"), { storeAbs: path.join(root, storeDir), locked, kind });
  const ctx = { root, storeDir, locked, lock, dryRun, force, prune, acceptLicense, lockChanged: false, review: kind.review === true, approvals, keyOf: (name) => unitKey({ projectDir, level, kind: kind.noun, name }) };

  for (const spec of allSpecs.filter((s) => !source || s === source)) {
    const ofSource = safe.filter((name) => locked[name].source === spec);
    const owned = ofSource.filter((name) => names.length === 0 || names.includes(name)).map((name) => [name, locked[name]]);
    if (owned.length === 0) continue;
    const info = lock.sources[spec] ?? {};
    const report = newReport(spec, info);
    result.sources.push(report);
    // Something imported from a local folder has no remote: it is brought up to date by importing it again.
    if (info.local || spec.startsWith("local:")) {
      report.local = true;
      continue;
    }
    try {
      // The recorded URL is checked like a typed one: a lock cannot point toolgate at file:// or ext::, nor at an address on
      // this machine or its network, and ssh only talks to hosts already in known_hosts.
      const url = lockSourceUrl(spec, info, { allowFile, projectDir, env, homedir });
      const fetched = fetchSource({ url, ref: checkRef(info.ref ?? undefined), cache, execFn, allowFile, strictHostKeys: true });
      const checkout = fs.realpathSync(fetched.dir);
      report.to = fetched.commit;
      const located = locateBase(checkout, info.path, kind.plural, kind.defaultBases);
      // A kind can read a source differently depending on what the lock recorded for it (a command's dialect).
      const sourceKind = kind.forSource ? kind.forSource(info) : kind;
      updateSource(sourceKind, ctx, { spec, owned, info, checkout, fetched, located, covers: owned.length === ofSource.length }, report);
    } catch (err) {
      report.error = redactCredentials(err.message.split("\n")[0]);
    }
    // One source at a time: what was brought up to date stays recorded if a later source fails or the run dies.
    if (ctx.lockChanged) {
      writeLock(lockFile, lock, kind.lockKey);
      ctx.lockChanged = false;
    }
  }
  return result;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function formatUpdate(result, { dryRun, command = "toolgate skills" } = {}) {
  // Names, paths, sources and errors come from a lock and a remote repository: nothing is printed raw
  // (a newline would start a fake line in what an agent reads), and a password in a URL is hidden.
  const p = (value) => printable(redactCredentials(value));
  const list = (names) => names.map(p).join(", ");
  const lines = [];
  const verb = dryRun ? "would update" : "updated";
  for (const r of result.sources) {
    const move = r.to && r.from !== r.to ? `${p((r.from ?? "").slice(0, 7))} -> ${p(r.to.slice(0, 7))}` : p((r.to ?? "").slice(0, 7));
    lines.push(`toolgate: ${p(r.source)} ${move}${dryRun ? " (dry run, nothing written)" : ""}`);
    if (r.local) {
      lines.push(`  imported from a local folder, there is no remote to update from; run \`${command} import\` to take its changes`);
      continue;
    }
    if (r.error) {
      lines.push(`  could not update: ${p(r.error)}`);
      continue;
    }
    lines.push(`  ${verb} ${r.updated.length}, restored ${r.restored.length}, unchanged ${r.unchanged.length}, kept ${r.kept.length}, conflicts ${r.conflicts.length}, skipped ${r.skipped.length}`);
    for (const name of [...r.updated, ...r.restored, ...r.conflicts]) {
      const d = r.details[name];
      const conflict = r.conflicts.includes(name);
      lines.push(
        `  ${conflict ? "conflict" : r.restored.includes(name) ? "restore" : "update"} ${p(name)}${d ? `: +${d.added.length} -${d.removed.length} ~${d.changed.length} files` : ""}${conflict ? " (edited here and changed upstream; use --force to overwrite your edit)" : ""}`,
      );
      if (dryRun && d) {
        for (const f of d.added) lines.push(`      + ${p(f)}`);
        for (const f of d.removed) lines.push(`      - ${p(f)}`);
        for (const c of d.changed) lines.push(`      ~ ${p(c.file)}${c.lines === null ? "" : ` (${plural(c.lines, "line")} changed)`}`);
      }
      for (const note of d?.notable ?? []) lines.push(`      ! ${p(note)}`);
    }
    if (r.kept.length) lines.push(`  kept ${list(r.kept)}: edited here, unchanged upstream`);
    for (const { name, reason } of r.skipped) lines.push(`  skipped ${p(name)}: ${p(reason)}`);
    if (r.waiting?.length) lines.push(`  waiting for review: ${r.waiting.map((w) => `${p(w.name)}${w.reason ? ` (${w.reason})` : ""}`).join(", ")}; nothing was changed for them`);
    if (r.removedUpstream.length) lines.push(`  removed upstream: ${list(r.removedUpstream)} (the copy was kept; --prune deletes it)`);
    if (r.pruned.length) lines.push(`  ${dryRun ? "would delete" : "deleted"} ${list(r.pruned)} (removed upstream)`);
    if (r.newUpstream.length) lines.push(`  new upstream, not installed: ${list(r.newUpstream)} (add with: ${command} install ${p(r.source)} ${r.newUpstream.map(p).join(" ")})`);
    if (r.licenseAccepted.length) lines.push(`  ${dryRun ? "would accept" : "accepted"} the license of ${p(r.source)} (${list(r.licenseAccepted)})`);
    else if (r.licenseChanged && !r.licenseCopied && !result.acceptLicense) lines.push(`  the license changed upstream (accept it with: ${command} update --accept-license)`);
    for (const { name, reason } of r.licenseSkipped) lines.push(`  license not copied: ${p(name)}: ${p(reason)}`);
  }
  if (result.recovered?.length) lines.push(`toolgate: recovered ${list(result.recovered)} (an earlier run died while replacing it; the copy it had set aside is back)`);
  if (result.invalidNames.length) lines.push(`toolgate: ignored lock entries whose name is not a plain name: ${list(result.invalidNames)}`);
  for (const what of result.invalidEntries ?? []) lines.push(`toolgate: lock: ${p(what)}`);
  for (const name of result.unknown) lines.push(`toolgate: ${p(name)} was not installed by toolgate at the ${result.level} level`);
  if (result.unknownSource) lines.push(`toolgate: nothing was installed from ${p(result.unknownSource)} at the ${result.level} level`);
  if (lines.length === 0) lines.push(`toolgate: nothing installed at the ${result.level} level`);
  return `${lines.join("\n")}\n`;
}

/**
 * Exit code: 0 when everything is current or applied, 1 on an unknown name or source, an error, a
 * conflict, an invalid upstream item or a lock entry with a bad name. What could be applied still is:
 * a failed source does not undo the others, but the run is not clean either.
 */
export function updateExitCode(result) {
  if (result.unknown.length || result.unknownSource || result.invalidNames.length || result.invalidEntries?.length) return 1;
  // A conflict or an invalid upstream item means the update is not complete, even if the rest went through.
  if (result.sources.some((r) => r.error || r.conflicts.length + r.skipped.length > 0)) return 1;
  // Asked to accept the license and a file was refused: it was asked and not done.
  if (result.acceptLicense && result.sources.some((r) => r.licenseSkipped?.length > 0)) return 1;
  // 2: something waits for a review that has not been given (CI notices it without it being an error).
  return result.sources.some((r) => r.waiting?.length > 0) ? 2 : 0;
}
