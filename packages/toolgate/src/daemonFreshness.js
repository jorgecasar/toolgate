// A running qmd daemon can serve fewer documents than its index holds, and nothing tells the caller:
// a query just returns less. The `status` tool reports how many documents each collection has, and
// the corpus that `toolgate skills index` writes says how many there should be, so the two can be
// compared. A difference is reported (route) or repaired by restarting the daemon (index, install).
import fs from "node:fs";
import path from "node:path";
import { daemonUrls, managedPort, qmdBinOf, restartDaemon } from "./daemon.js";

import { createDaemonClient } from "./qmdClient.js";
import { COMMANDS_DIR, DEFAULT_CORPUS_DIR, SUBAGENTS_DIR, defaultCollection } from "./skills/corpus.js";

export { restartDaemon };

/** Markdown files of the corpus: one card per skill and per command, plus the catalog. `null` when there is no corpus. */
export function corpusDocCount(corpusDir, readdirFn = fs.readdirSync) {
  const count = (dir) => readdirFn(dir).filter((name) => name.endsWith(".md")).length;
  let total;
  try {
    total = count(corpusDir);
  } catch {
    return null;
  }
  for (const folder of [COMMANDS_DIR, SUBAGENTS_DIR]) {
    try {
      total += count(path.join(corpusDir, folder));
    } catch (err) {
      // no such folder is a corpus without that kind; anything else must not shrink the count silently
      if (err.code !== "ENOENT") return null;
    }
  }
  return total;
}

/** Documents the daemon reports for `collection`, or `null` when it cannot say. */
export async function daemonDocCount({ url, collection, fetchFn = globalThis.fetch, timeoutMs = 3000, client }) {
  try {
    const result = await (client ?? createDaemonClient({ url, fetchFn, timeoutMs })).callTool("status", {});
    const found = result?.structuredContent?.collections?.find((entry) => entry.name === collection);
    return typeof found?.documents === "number" ? found.documents : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<{ state: "fresh" | "stale" | "unknown", expected: number | null, actual: number | null }>}
 */
export async function checkFreshness({ url, collection, corpusDir, fetchFn, client, readdirFn }) {
  const expected = corpusDocCount(corpusDir, readdirFn);
  if (expected === null) return { state: "unknown", expected, actual: null };
  const actual = await daemonDocCount({ url, collection, fetchFn, client });
  if (actual === null) return { state: "unknown", expected, actual };
  // Only fewer documents than the corpus means skills are missing; more (a deleted skill not yet
  // dropped, other files in the collection) cannot hide anything from a query.
  return { state: actual < expected ? "stale" : "fresh", expected, actual };
}

export const staleMessage = ({ collection, expected, actual }) =>
  `the qmd daemon serves ${actual} of the ${expected} documents of "${collection}"; run "toolgate daemon restart"`;

/** The corpus exists but the daemon could not say how many documents it serves: it may be an old or foreign index. */
export const unknownMessage = ({ collection }) =>
  `could not check whether the qmd daemon serves every document of "${collection}"; run "toolgate daemon restart"`;

/** The collection and corpus a project's skills use, resolved the same way `skills index` does. */
export function skillsLocation(config, cwd) {
  return {
    collection: config?.skills?.collection ?? defaultCollection(cwd),
    corpusDir: path.resolve(cwd, config?.skills?.corpusDir ?? DEFAULT_CORPUS_DIR),
  };
}

/**
 * After the skills index changed: when the managed daemon does not serve the same documents as the
 * corpus, restart it so the new skills are found, and say so. Silent when it is fine, not running,
 * remote, or when there is no way to tell.
 */
export async function refreshDaemonIfStale({
  cwd,
  config,
  env = process.env,
  stdout,
  stderr,
  daemon = {},
  fetchFn,
  readdirFn,
}) {
  const port = managedPort(config, env);
  if (port === null) return "skipped";
  const status = await (daemon.status ?? (async () => ({ running: false })))({ port });
  if (!status.running) return "skipped";

  const { collection, corpusDir } = skillsLocation(config, cwd);
  const url = daemonUrls(port).mcp;
  const check = await checkFreshness({ url, collection, corpusDir, fetchFn, readdirFn });
  if (check.state !== "stale") return check.state;

  stdout.write(`toolgate: ${staleMessage({ collection, ...check })}; restarting it\n`);
  const result = await restartDaemon({ port, qmdBin: qmdBinOf(config), env, stderr, stopFn: daemon.stop, ensureFn: daemon.ensure, statusFn: daemon.status, holderFn: daemon.holder, sleepFn: daemon.sleep });
  if (!result.running) {
    stderr.write(`toolgate: could not restart the qmd daemon (${result.reason}); run "toolgate daemon restart"\n`);
    return "failed";
  }
  const after = await checkFreshness({ url, collection, corpusDir, fetchFn, readdirFn });
  if (after.state === "stale") {
    stderr.write(`toolgate: the restarted daemon still serves ${after.actual} of ${after.expected} documents of "${collection}"; run "toolgate skills index --force"\n`);
    return "failed";
  }
  stdout.write("toolgate: qmd daemon restarted\n");
  return "restarted";
}
