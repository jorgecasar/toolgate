// Approvals: the one place that says "this user, on this machine, accepted this exact content". A unit of a kind that
// runs something or widens what the agent may do (`review: true` on its descriptor: hooks, permissions) is applied
// only when its content hash is approved here. The store lives in the user's config folder, never in a repository: a
// committed lock, a teammate's install or a message from an agent is not an approval. An approval is asked once, when
// the unit is first seen, and holds while the hash does not change.
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "./common.js";

export const APPROVALS_FILE = "approvals.json";

/** The key of an approval: the project (real path), the level, the kind and the name of the unit. */
export function unitKey({ projectDir, level = "project", kind, name }) {
  let project = projectDir;
  try {
    project = fs.realpathSync(projectDir);
  } catch {
    // a project that does not exist yet keeps the path it was given
  }
  return JSON.stringify([project, level, kind, name]);
}

const clean = (data) => {
  const approvals = {};
  if (data !== null && typeof data === "object" && !Array.isArray(data) && data.approvals !== null && typeof data.approvals === "object" && !Array.isArray(data.approvals)) {
    for (const [key, entry] of Object.entries(data.approvals)) {
      if (entry !== null && typeof entry === "object" && typeof entry.hash === "string" && /^[0-9a-f]{64}$/.test(entry.hash)) approvals[key] = { hash: entry.hash };
    }
  }
  return approvals;
};

/**
 * @param {string} userDir The user config folder (`approvals.json` lives in it)
 * @returns {{ file: string, problem: string | null, has: (key: string, hash: string) => boolean, approve: (key: string, hash: string) => void, revoke: (key: string) => void, save: () => void }}
 */
export function loadApprovals(userDir) {
  const file = path.join(userDir, APPROVALS_FILE);
  let approvals = {};
  let problem = null;
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (info) {
    // A file that cannot be trusted approves nothing: every unit asks again, which is the safe direction.
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) problem = `${file} is a link, not a file or too big, so it approves nothing`;
    else {
      try {
        approvals = clean(parseJson(fs.readFileSync(file, "utf8")));
      } catch {
        problem = `${file} is not valid JSON, so it approves nothing`;
      }
    }
  }
  let changed = false;
  return {
    file,
    problem,
    has: (key, hash) => Object.hasOwn(approvals, key) && approvals[key].hash === hash,
    approve(key, hash) {
      approvals[key] = { hash };
      changed = true;
    },
    revoke(key) {
      if (Object.hasOwn(approvals, key)) {
        delete approvals[key];
        changed = true;
      }
    },
    /** Writes the file only when something changed: atomically, readable by the user alone. */
    save() {
      if (!changed) return;
      const linked = fs.lstatSync(file, { throwIfNoEntry: false });
      if (linked && (linked.isSymbolicLink() || !linked.isFile())) throw new Error(`${file} is a link or not a file; approvals were not saved`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.rmSync(temp, { force: true });
      const sorted = Object.fromEntries(Object.entries(approvals).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      fs.writeFileSync(temp, `${JSON.stringify({ version: 1, approvals: sorted }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, file);
      changed = false;
    },
  };
}

/** Whether this run may ask: a terminal, not `--yes`, not CI. Otherwise nothing is approved. */
export const canAsk = ({ yes = false, interactive = false, env = process.env } = {}) => interactive === true && yes !== true && !env.CI;

/**
 * Shows each unit that is waiting and asks for a typed `yes`. Returns the names approved (recorded in `approvals`, not
 * yet saved) and the ones left waiting. Without a terminal nothing is shown as approved and nothing is recorded.
 * @param {Object} options
 * @param {Array<{ name: string, hash: string, key: string, question?: string }>} options.waiting
 * @param {{ approve: Function }} options.approvals
 * @param {(item: object) => string} options.show The text to print for a unit (its normalized content or a diff)
 * @param {(question: string) => Promise<string | null>} [options.ask]
 * @param {(text: string) => void} options.print
 * @param {boolean} options.allowed Whether this run may ask (see `canAsk`)
 */
export async function reviewWaiting({ waiting, approvals, show, ask, print, allowed }) {
  const approved = [];
  const left = [];
  for (const item of waiting) {
    print(`${show(item)}\n`);
    if (!allowed || !ask) {
      left.push(item.name);
      continue;
    }
    const answer = await ask(item.question ?? `Apply ${item.name}? Type yes to approve this content: `);
    // Exactly `yes`: not "yes " or "Yes". A caller that reads a line removes the line ending itself.
    if (answer === "yes") {
      approvals.approve(item.key, item.hash);
      approved.push(item.name);
    } else {
      left.push(item.name);
    }
  }
  return { approved, left };
}
