// `toolgate update`: the proxy's environment names became TOOLGATE_* (#19). In each MCP file toolgate reads for the agent, every entry that
// toolgate-proxy wraps has its old env keys renamed, in place; nothing else in the file changes, and the file keeps its mode. A file that is a
// link, or that git ignores (rulesync generated it), is not written: each entry is reported with where to rename it instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { printable } from "../assets/common.js";
import { isProxied } from "../proxied.js";
import { MAX_MCP_BYTES, RENAMED_PROXY_ENV, oldProxyNames } from "../proxyEnv.js";

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The MCP files of the agent that toolgate reads (see catalog/serverDefs.js): the project's `.mcp.json`, and the user's `~/.claude.json`, which
// holds servers at its top and under `projects[<this project>]`.
function mcpFiles(cwd, homedir) {
  return [
    { file: path.join(cwd, ".mcp.json"), locations: (data) => [data.mcpServers] },
    { file: path.join(homedir, ".claude.json"), userFile: true, locations: (data) => [data.mcpServers, isPlain(data.projects) && isPlain(data.projects[cwd]) ? data.projects[cwd].mcpServers : undefined] },
  ];
}

// The renames an entry needs, as `{ server, env, pairs }` for each wrapped entry that has an old name.
function pending(servers) {
  if (!isPlain(servers)) return [];
  const found = [];
  for (const [server, def] of Object.entries(servers)) {
    if (!isPlain(def) || !isProxied(def)) continue;
    const pairs = oldProxyNames(def.env);
    if (pairs.length) found.push({ server, def, pairs });
  }
  return found;
}

// The text the file would have with the keys renamed, or null when it cannot be written without changing something else: the file is
// parsed and written again, which is the same text only for the formats JSON.stringify makes (two or four spaces, or tabs).
function renamedText(raw, data, locations) {
  const tail = raw.endsWith("\n") ? "\n" : "";
  const indent = [2, 4, "\t"].find((candidate) => `${JSON.stringify(data, null, candidate)}${tail}` === raw);
  if (indent === undefined) return null;
  for (const servers of locations(data)) {
    for (const { def, pairs } of pending(servers)) {
      const rename = new Map(pairs);
      def.env = Object.fromEntries(Object.entries(def.env).map(([key, value]) => [rename.get(key) ?? key, value]));
    }
  }
  return `${JSON.stringify(data, null, indent)}${tail}`;
}

const MAX_BYTES = MAX_MCP_BYTES;

// The text of a regular file, read through the descriptor it was opened as, with the type and the size checked on that descriptor: a FIFO
// (or a link to one) that a repository holds under the name of an MCP file is not opened for reading, and so cannot make `update` wait.
// `tooBig` is called with the descriptor when the file is a regular file over the limit.
function readRegularFile(file, { tooBig } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.size > MAX_BYTES) tooBig?.(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("not a regular file of a size to read");
    return { text: fs.readFileSync(fd, "utf8"), identity: identityOf(stat) };
  } finally {
    fs.closeSync(fd);
  }
}

// What says a file is the one that was read: where it is on disk and when it was last written or changed. Nothing is written over a file
// whose identity moved.
const identityOf = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

// Whether a file too big to rewrite names one of the old keys, read in pieces: only then is it worth saying that it was not migrated.
function mentionsOldNames(fd) {
  const names = RENAMED_PROXY_ENV.map(([oldName]) => `"${oldName}"`);
  const buffer = Buffer.alloc(1024 * 1024);
  let carry = "";
  for (let position = 0; ; position += buffer.length) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) return false;
    const chunk = carry + buffer.toString("latin1", 0, read);
    if (names.some((name) => chunk.includes(name))) return true;
    carry = chunk.slice(-32);
  }
}

/**
 * @returns {Promise<{ entries: object[], renames: { file: string, server: string, renamed: string[][] }[], failed: boolean }>}
 *   `entries` are migration results for the report; `renames` is the list `--json` shows (what is or would be renamed).
 */
export async function migrateProxyEnv({ cwd, homedir = os.homedir(), dryRun, yes, interactive, ask, isTrackedFn, isIgnoredFn, replaceFile }) {
  const entries = [];
  const renames = [];
  let failed = false;
  const shown = (file) => (file.startsWith(`${cwd}${path.sep}`) ? path.relative(cwd, file) : file);
  for (const { file, locations, userFile } of mcpFiles(cwd, homedir)) {
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info) continue;
    let raw;
    let identity;
    let data;
    let big = false;
    try {
      ({ text: raw, identity } = readRegularFile(file, { tooBig: (fd) => (big = mentionsOldNames(fd)) }));
      data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      if (big) {
        entries.push({ id: `mcp-proxy-env:${printable(shown(file))}`, status: "skipped", note: `${printable(shown(file))} is larger than ${MAX_BYTES / 1024 / 1024} MiB; not migrated` });
      }
      continue; // not readable, not a regular file or not JSON: `doctor` says so; there is nothing here to rename
    }
    if (!isPlain(data)) continue;
    const wanted = locations(data).flatMap((servers) => pending(servers).map(({ server, pairs }) => ({ server, pairs })));
    if (!wanted.length) continue;
    // What `--json` lists is what is renamed, or would be: a file that is skipped lists nothing here (its entry says why).
    const listRenames = () => {
      for (const { server, pairs } of wanted) renames.push({ file: shown(file), server, renamed: pairs.map(([from, to]) => [from, to]) });
    };
    const entry = { id: `mcp-proxy-env:${printable(shown(file))}`, status: "stale" };
    entries.push(entry);
    // Claude Code's own file, outside the repository, rewritten by every running session: changed only on an explicit yes, and with a warning.
    const sessions = userFile ? "; close running Claude Code sessions first: they rewrite this file" : "";
    const lines = wanted.flatMap(({ server, pairs }) => pairs.map(([from, to]) => `rename ${from} to ${to} in ${printable(server)}`));
    if (info.isSymbolicLink() || !info.isFile() || isIgnoredFn(file)) {
      entry.status = "skipped";
      entry.note = wanted.flatMap(({ server, pairs }) => pairs.map(([from, to]) => `toolgate: ${printable(shown(file))} is generated or a link; rename ${from} to ${to} in its source (${printable(server)})`)).join("\n");
      continue;
    }
    // Checked before the dry run too, so that a dry run does not promise what the real run would refuse.
    const text = renamedText(raw, structuredClone(data), locations);
    if (text === null) {
      entry.status = "skipped";
      entry.note = `${printable(shown(file))} is not formatted the way JSON.stringify writes it (or starts with a byte order mark), so rewriting it would change more than the names: ${lines.join("; ")} by hand`;
      continue;
    }
    if (dryRun) {
      entry.status = "would-rename";
      entry.note = `would ${lines.join("; ")} in ${printable(shown(file))}${sessions}`;
      listRenames();
      continue;
    }
    const versioned = isTrackedFn(file); // a home folder kept in git (dotfiles) is told to commit it too
    const why = userFile ? "is Claude Code's own file" : "is versioned by git";
    if ((versioned || userFile) && !yes && !(interactive && /^y(es)?$/i.test(String((await ask(`${shown(file)} ${why}${userFile ? " (close running Claude Code sessions first: they rewrite it)" : ""}. Rename the proxy variables in it? [y/N] `)) ?? "").trim()))) {
      entry.status = "skipped";
      entry.note = `${printable(shown(file))} ${why} and was not changed: run \`toolgate update --yes\` to ${lines.join("; ")}${sessions}`;
      continue;
    }
    // Looked at right before the rename, after the new file is complete and after any question: what was written to the file meanwhile (Claude
    // Code rewrites its own) would be lost, and the line would still say it was replaced. Only a stat and the rename are left in the window.
    const unchanged = () => {
      try {
        return identityOf(fs.statSync(file)) === identity;
      } catch {
        return false;
      }
    };
    try {
      if (!replaceFile(file, text, { beforeRename: unchanged })) {
        failed = true;
        entry.status = "changed";
        entry.note = `${printable(shown(file))} changed while toolgate ran, nothing was written: run toolgate update again`;
        continue;
      }
      listRenames();
      entry.status = "replaced";
      entry.note = `${lines.join("; ")} in ${printable(shown(file))}${versioned ? "; git versions it, so commit the change" : ""}${sessions}`;
    } catch (err) {
      failed = true;
      entry.status = "failed";
      entry.note = `${printable(shown(file))} could not be changed (${printable(err.message.split("\n")[0])})`;
    }
  }
  return { entries, renames, failed };
}
