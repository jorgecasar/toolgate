// SKILL.md reader: YAML frontmatter plus the "Required MCPs" section of the body.
import fs from "node:fs";
import { asList, descriptionOf, extractRequiredMcps, parseFrontmatter } from "../assets/common.js";

export { extractRequiredMcps, parseFrontmatter };

/** @typedef {{ name: string, description: string, tags: string[], mcps: string[], path: string }} Skill */

/**
 * @param {string} filePath
 * @returns {Skill}
 */
export function parseSkill(filePath) {
  let parsed;
  try {
    parsed = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`${filePath}: ${err.message.split("\n")[0]}`, { cause: err });
  }
  const { data, body } = parsed;
  // A skill without a description is accepted (and reported by `doctor`); one without a name cannot be told apart.
  if (!data.name || typeof data.name !== "string") {
    throw new Error(`${filePath}: frontmatter is missing "name"`);
  }
  const declared = asList(data.mcps, "mcps", filePath);
  return {
    name: data.name,
    description: descriptionOf(data),
    tags: asList(data.tags, "tags", filePath),
    mcps: declared.length ? declared : extractRequiredMcps(body),
    path: filePath,
  };
}
