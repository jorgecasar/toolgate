// A checkout that has skills but no skills index (a new git worktree: `.toolgate/skills-index/` is git-ignored).
import fs from "node:fs";
import path from "node:path";
import { settings } from "./cli.js";
import { INDEX_FILE } from "./corpus.js";
import { scanSkills } from "./scan.js";
/** What `need` and `route` say (in `warnings`) and doctor says, when skills exist but are not indexed here. */
export const NOT_INDEXED = "skills are not indexed in this checkout; run toolgate skills index";
/**
 * True when `toolgate skills index` would index at least one skill from this checkout and the corpus folder
 * (`skills.corpusDir` honoured) has no `_index.md`. An unreadable folder or a scan that fails says nothing.
 * @returns {boolean}
 */
export function skillsButNoIndex(config, cwd, env = process.env, { existsFn = fs.existsSync } = {}) {
  try {
    const options = settings(config, cwd, env);
    if (existsFn(path.join(options.corpusDir, INDEX_FILE))) return false;
    return options.sources.length > 0 && scanSkills(options.sources, options.overrides).length > 0;
  } catch {
    return false;
  }
}
