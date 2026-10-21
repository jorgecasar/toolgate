// Checks that every pinned commit of the shipped recommendations still exists upstream and holds
// the skills that were reviewed. A network failure is reported apart from a broken pin.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFetchFailure, shippedRecommendations } from "../packages/toolgate/src/skills/recommended.js";
import { gitEnv, sourceUrl } from "../packages/toolgate/src/skills/remote.js";

// `node scripts/check-recommended.js [list.json]`: another list in the same format, to try the three outcomes.
const list = process.argv[2] ? shippedRecommendations(path.resolve(process.argv[2])) : shippedRecommendations();
let broken = 0;
let unreachable = 0;
for (const entry of list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recommended-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf8", timeout: 120000, env: gitEnv() });
  try {
    git("init", "-q");
    try {
      git("fetch", "--depth", "1", "--", sourceUrl(entry.source), entry.commit);
    } catch (err) {
      const message = String(err.stderr ?? err.message);
      if (classifyFetchFailure(message) === "gone") throw new Error(`pinned commit ${entry.commit} or its repository is gone upstream: ${message.split("\n")[0]}`);
      unreachable += 1;
      console.error(`UNREACHABLE ${entry.id}: ${message.split("\n")[0]}`);
      continue;
    }
    git("checkout", "-q", "FETCH_HEAD");
    const missing = entry.skills.filter((name) => !fs.existsSync(path.join(dir, entry.path ?? "skills", name, "SKILL.md")));
    if (missing.length) throw new Error(`missing at the pin: ${missing.join(", ")}`);
    console.log(`ok ${entry.id}`);
  } catch (err) {
    broken += 1;
    console.error(`BROKEN ${entry.id}: ${err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// Nothing checked is not a pass: if no entry could be reached the run proves nothing.
const entries = list.length;
if (entries > 0 && unreachable === entries) console.error("no recommended source could be reached, nothing was checked");
process.exit(broken > 0 || (entries > 0 && unreachable === entries) ? 1 : 0);
