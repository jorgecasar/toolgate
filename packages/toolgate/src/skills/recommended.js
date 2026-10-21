// Recommended skill sources: a list shipped with the package (the lowest layer) that any config
// layer can extend through `skills.recommended`. Listing a recommendation installs nothing.
import { printable } from "../assets/common.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isValidOverride, overridesFor, readConfigFile, writeConfigFile } from "../configFile.js";
import { LOCK_FILE, readLock } from "./install.js";
import { lockSourceUrl } from "./remote.js";

export const RECOMMENDED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "recommended-skills.json");

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[\w.-]+(\/[\w.-]+)*$/;
const isStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");

const NAME = /^(?!\.+$)[\w.-]+$/;
const names = (value) => Array.isArray(value) && value.every((item) => typeof item === "string" && NAME.test(item));

/** The skills a recommendation installs: the reviewed list minus what it excludes. */
export const reviewedSkills = (entry) => entry.skills.filter((name) => !(entry.exclude ?? []).includes(name));

/**
 * Throws a message naming the entry when it is not a safe, complete recommendation: the commit
 * must be a full SHA (never a branch or tag), the source a github: or https:// one, the skills an
 * explicit non-empty list of plain names, and `path` a folder that stays inside the repository.
 * @param {Record<string, any>} entry
 */
export function validateRecommendation(entry, { allowFile = false, projectDir, env, homedir } = {}) {
  const where = `recommendation "${entry?.id}"`;
  const fail = (message) => {
    throw new Error(`${where}: ${message}`);
  };
  if (!entry || typeof entry.id !== "string" || !ID.test(entry.id)) fail("id is missing or not valid");
  if (entry.disabled === true) return;
  let url;
  try {
    // The same check a lock's source gets: not an address on this machine or its network, unless the user allows the host.
    url = lockSourceUrl(entry.source, undefined, { allowFile, projectDir, env, homedir });
  } catch (err) {
    // The host is kept on the error so that a list can leave this one entry out instead of failing as a whole.
    throw Object.assign(new Error(`${where}: ${err.message}`), err.privateHost === undefined ? {} : { privateHost: err.privateHost });
  }
  if (!allowFile && (url.startsWith("ssh://") || url.startsWith("git@"))) fail("only github: and https:// sources can be recommended");
  if (!SHA.test(entry.commit ?? "")) fail("commit must be a full 40-character SHA");
  if (!names(entry.skills) || entry.skills.length === 0) fail("skills must list the skills that were reviewed, as plain names");
  if (entry.exclude !== undefined && !names(entry.exclude)) fail("exclude must be a list of plain names");
  if (reviewedSkills(entry).length === 0) fail("exclude leaves no reviewed skill to install");
  if (entry.path !== undefined && (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes(".."))) {
    fail("path must be a relative folder inside the repository");
  }
  // The overrides are written into a config file and applied to the index: they must be what the index
  // can apply (the same schema `config add` uses), for a skill the entry lists.
  if (entry.overrides !== undefined) {
    const valid = Array.isArray(entry.overrides) && entry.overrides.every((o) => isValidOverride(o) && NAME.test(o.skill) && entry.skills.includes(o.skill));
    if (!valid) fail("overrides must be {skill, tags, mcps, description} for a skill of the entry, with at least one of the others");
  }
  if (typeof entry.license !== "string" || entry.license === "") fail("license is missing");
}

/**
 * Why fetching a pinned commit failed, from git's message: "gone" when the pin, the repository or
 * the access to it is not there any more (a deleted or private repository is as broken as a
 * deleted commit), "unreachable" when the network or the server did not answer and nothing is known.
 * @returns {"gone" | "unreachable"}
 */
export function classifyFetchFailure(message) {
  const gone = /not our ref|couldn't find remote ref|unadvertised object|repository .*not found|does not exist|not found|authentication failed|could not read username|permission denied|returned error: (401|403|404|410)|access denied/i;
  return gone.test(message) ? "gone" : "unreachable";
}

let shipped;

/** The shipped list, validated (read once per process). */
export function shippedRecommendations(file = RECOMMENDED_FILE) {
  if (file === RECOMMENDED_FILE && shipped) return shipped;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.version !== 1 || !Array.isArray(data.recommended)) throw new Error(`${file} is not a version 1 recommendations list`);
  data.recommended.forEach((entry) => validateRecommendation(entry));
  if (file === RECOMMENDED_FILE) shipped = data.recommended;
  return data.recommended;
}

/**
 * Shipped entries followed by the ones from config; the same id later replaces the earlier one and
 * `disabled` hides it. A config entry that is not valid is an error naming it. Only the user's own
 * config may replace a shipped entry: a project (or local) config is committed by someone else, and
 * an entry that took a reviewed id would put its own source behind a name the user has read as reviewed.
 * @param {Array<Record<string, any>>} [fromConfig]
 */
export function loadRecommendations(fromConfig = [], shipped = shippedRecommendations(), options = {}) {
  const byId = new Map();
  // The shipped entries were validated when they were read.
  for (const entry of shipped) byId.set(entry.id, { ...entry, layer: "shipped" });
  for (const entry of fromConfig) {
    try {
      validateRecommendation(entry, options);
    } catch (err) {
      // A source on this machine or its network is left out with a warning; the rest of the list, and what follows, goes on.
      if (err.privateHost === undefined || !options.warn) throw err;
      options.warn(`recommended skill ${printable(entry.id)} in the ${printable(entry.layer ?? "project")} config is ignored: its source host ${printable(err.privateHost)} is private`);
      continue;
    }
    if (entry.layer !== "user" && entry.disabled !== true && byId.get(entry.id)?.layer === "shipped") {
      // A committed config must not put its own source behind a reviewed id; the entry is skipped, not the whole list.
      options.warn?.(`recommended entry ${printable(entry.id)} in the ${printable(entry.layer ?? "project")} config reuses a shipped id; skipped`);
      continue;
    }
    byId.set(entry.id, entry);
  }
  return [...byId.values()].filter((entry) => entry.disabled !== true);
}

/**
 * How a recommendation stands in a project, from its lock.
 * @returns {{ state: "installed" | "partial" | "none", installedCommit: string | null, newerPin: boolean }}
 */
export function recommendationStatus(entry, lock) {
  const wanted = reviewedSkills(entry);
  const have = wanted.filter((name) => Object.hasOwn(lock.skills, name) && lock.skills[name].source === entry.source);
  const state = have.length === 0 ? "none" : have.length === wanted.length ? "installed" : "partial";
  const commits = [...new Set(have.map((name) => lock.skills[name].commit))];
  return { state, installedCommit: commits[0] ?? null, newerPin: commits.some((commit) => commit !== entry.commit) };
}

export function runRecommended({ config, cwd, json, stdout, stderr, env }) {
  const entries = loadRecommendations(config?.skills?.recommended, undefined, { projectDir: cwd, env, warn: (message) => stderr?.write(`toolgate: ${message}\n`) });
  const lock = readLock(path.join(cwd, LOCK_FILE));
  const rows = entries.map((entry) => ({
    id: entry.id,
    title: entry.title ?? entry.id,
    source: entry.source,
    commit: entry.commit,
    license: entry.license,
    skills: reviewedSkills(entry),
    ...recommendationStatus(entry, lock),
  }));
  if (json) {
    stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  if (rows.length === 0) stdout.write("toolgate: no recommended skill sources\n");
  for (const row of rows) {
    const status = row.state === "none" ? "not installed" : row.state;
    const pin = row.newerPin ? `, installed at ${row.installedCommit.slice(0, 7)}` : "";
    // Entries can come from a committed config: nothing from them is printed raw.
    stdout.write(`${[row.id, `${row.source}@${row.commit.slice(0, 7)}`, row.license, `${row.skills.length} skills`, `${status}${pin}`].map(printable).join("\t")}\n`);
  }
  if (rows.length) stdout.write("Nothing is installed by this command; install one with: toolgate skills install <source> [name...]\n");
  return 0;
}

export const RECOMMENDED_PREFIX = "recommended:";

/**
 * Turns `recommended:<id>` and optional skill names into an install request: the source, the pinned
 * commit, the reviewed skills that were asked for, and what the entry excludes.
 * `allowFile` only lets tests recommend a local repository.
 */
export function resolveRecommendation(spec, names, config, { allowFile = false, projectDir, env, warn } = {}) {
  const id = spec.slice(RECOMMENDED_PREFIX.length);
  const entry = loadRecommendations(config?.skills?.recommended, undefined, { allowFile, projectDir, env, warn }).find((e) => e.id === id);
  if (!entry) throw new Error(`"${id}" is not a recommended source (see: toolgate skills recommended)`);
  const reviewed = reviewedSkills(entry);
  const unknown = names.filter((name) => !reviewed.includes(name));
  if (unknown.length) throw new Error(`${unknown.join(", ")} not in the reviewed list of ${id} (${reviewed.join(", ")})`);
  return {
    entry,
    request: { spec: entry.source, pin: entry.commit, subdir: entry.path, only: names.length ? names : reviewed, exclude: entry.exclude ?? [] },
  };
}

/**
 * Adds the recommendation's overrides for `skills` to a config file. An override that is already
 * there for a skill is the user's decision and is never replaced.
 * `added` names the skills whose override was written and `written` holds those overrides, for the message.
 * @returns {{ added: string[], kept: string[], written: object[] }}
 */
export function applyRecommendedOverrides(entry, skills, configFile, { dryRun = false } = {}) {
  const out = { added: [], kept: [], written: [] };
  const wanted = (entry.overrides ?? []).filter((o) => skills.includes(o.skill));
  if (wanted.length === 0) return out;
  const { data } = readConfigFile(configFile);
  const { list } = overridesFor(data, "");
  for (const override of wanted) {
    if (list.some((e) => e?.skill === override.skill)) {
      out.kept.push(override.skill);
    } else {
      out.added.push(override.skill);
      out.written.push(override);
      list.push(override);
    }
  }
  if (out.added.length && !dryRun) {
    data.skills = { ...data.skills, overrides: list };
    writeConfigFile(configFile, data);
  }
  return out;
}
