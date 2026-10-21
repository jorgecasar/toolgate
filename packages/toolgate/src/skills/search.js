// `toolgate skills search`: qmd hybrid query (lex + vec) over the skills collection. When qmd
// cannot be run, an explicit keyword match over the generated `_index.md` takes over and the
// result says so (`source: "fallback"`), so the degradation is never silent.
import fs from "node:fs";
import path from "node:path";
import { defaultExec } from "../daemon.js";
import { COMMANDS_DIR, INDEX_FILE, RESERVED_NAMES, SUBAGENTS_DIR, cardPath, parseCard } from "./corpus.js";

// Terms shorter than 3 characters ("a", "to", "of") are noise for keyword matching.
const tokenize = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 3);

/** Values of `--kind`. */
export const KINDS = ["skill", "command", "subagent", "all"];

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function parseIndexLine(line) {
  if (!line.startsWith("- **")) return null;
  const nameEnd = line.indexOf("** — ");
  if (nameEnd === -1) return null;
  const fields = line.slice(nameEnd + 5).split(" | ");
  if (fields.length < 4) return null;
  const [file, mcps, tags] = [fields.pop(), fields.pop(), fields.pop()];
  // Lines of skills have no `kind:` field, and indexes written before levels existed no `level:` one.
  const kind = fields.at(-1)?.startsWith("kind: ") ? fields.pop().slice("kind: ".length) : "skill";
  const level = fields.at(-1)?.startsWith("level: ") ? fields.pop() : "level: project";
  const strip = (value, prefix) => (value.startsWith(prefix) ? value.slice(prefix.length) : null);
  const parsed = {
    level: strip(level, "level: "),
    tags: strip(tags, "tags: "),
    mcps: strip(mcps, "mcps: "),
    path: strip(file, "path: "),
  };
  if (Object.values(parsed).includes(null)) return null;
  return { name: line.slice(4, nameEnd), description: fields.join(" | ").replaceAll("\\|", "|"), kind, ...parsed };
}

/**
 * Keyword match over the catalog; entries sharing no term with the query are dropped.
 * @param {string} query
 * @param {string} corpusDir
 * @returns {Array<{ name: string, description: string, kind: string, level: string, path: string, score: number }>}
 */
export function searchIndex(query, corpusDir) {
  const indexFile = path.join(corpusDir, INDEX_FILE);
  if (!fs.existsSync(indexFile)) {
    throw new Error(`skills index not found at ${indexFile}; run "toolgate skills index" first`);
  }
  const terms = new Set(tokenize(query));
  return fs
    .readFileSync(indexFile, "utf8")
    .split("\n")
    .map(parseIndexLine)
    .filter(Boolean)
    .map(({ name, description, kind, level, tags, mcps, path: file }) => {
      const words = new Set(tokenize(`${name} ${description} ${tags} ${mcps}`));
      return { name, description, kind, level, path: file, score: [...terms].filter((t) => words.has(t)).length };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.name, b.name));
}

// The kind of a hit is in its folder: `commands/`, `subagents/`, or the corpus root for a skill.
function hitKind(file) {
  const relative = file.replace(/^qmd:\/\/[^/]+\//, "");
  if (relative.startsWith(`${COMMANDS_DIR}/`)) return "command";
  return relative.startsWith(`${SUBAGENTS_DIR}/`) ? "subagent" : "skill";
}

// qmd answers with `qmd://<collection>/<skill>.md`, or `.../commands/<command>.md` for a command (and `subagents/`);
// the corpus file name is the name. An unreadable card is reported in `warnings` instead of
// leaving the hit silently without a level.
function searchQmd(query, { qmdBin, collection, execFn, asked, limit, kind, corpusDir }) {
  const out = execFn(qmdBin, ["query", query, "-c", collection, "--json", "-n", String(asked)]);
  const warnings = [];
  // The kind of a hit is in its path, so the wrong kind is dropped and the list cut to `limit`
  // before any card is read.
  const results = JSON.parse(out)
    .map((hit) => {
      const file = String(hit.file ?? hit.path);
      return { hit, file, name: path.basename(file, ".md"), kind: hitKind(file) };
    })
    .filter(({ name, kind: found }) => !RESERVED_NAMES.has(name) && (kind === "all" || found === kind))
    .slice(0, limit)
    .map(({ hit, file, name, kind: found }) => {
      const card = cardPath(found, name);
      const base = { name, file, score: hit.score, snippet: hit.snippet };
      try {
        const { kind, level, shadows } = parseCard(fs.readFileSync(path.join(corpusDir, card), "utf8"));
        return { ...base, kind, level, shadows };
      } catch {
        warnings.push(`skills card ${card} unreadable in ${corpusDir}; run "toolgate skills index"`);
        return base;
      }
    });
  return { results, warnings };
}

/**
 * @param {string} query
 * @param {Object} options
 * @param {string} options.corpusDir
 * @param {"skill" | "command" | "subagent" | "all"} [options.kind] Only hits of this kind (default all)
 * @returns {{ source: "qmd" | "fallback", reason?: string, results: object[] }}
 */
export function searchSkills(
  query,
  { corpusDir, collection, qmdBin = "qmd", execFn = defaultExec, limit = 5, kind = "all" }
) {
  if (typeof query !== "string" || !query.trim()) throw new Error("a non-empty search query is required");
  if (!KINDS.includes(kind)) throw new Error(`--kind must be ${KINDS.join(", ")}, not "${kind}"`);
  try {
    // qmd cannot filter by kind, so a filtered search asks for four times the hits and keeps the
    // right ones. If the first 4 x limit hits are all of the other kind it can still come back
    // short; widen `limit` to see further.
    const asked = kind === "all" ? limit : limit * 4;
    const { results, warnings } = searchQmd(query, { qmdBin, collection, execFn, asked, limit, kind, corpusDir });
    return { source: "qmd", ...(warnings.length ? { warnings } : {}), results };
  } catch (err) {
    const reason = `qmd unavailable: ${String(err.message).split("\n")[0]}`;
    const found = searchIndex(query, corpusDir).filter((hit) => kind === "all" || hit.kind === kind);
    return { source: "fallback", reason, results: found.slice(0, limit) };
  }
}
