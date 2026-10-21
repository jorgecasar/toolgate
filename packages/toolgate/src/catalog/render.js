// The catalog file of one server: the front matter of SPEC §7.1 and one section per tool. Everything that came from the
// server is already one clean line (`oneLine`); values are written as JSON strings, which are also YAML double-quoted
// strings, so no value can open a key or end the front matter.
import { MAX_DESCRIPTION, SAFE_TOOL, oneLine } from "./sanitize.js";

const WHEN_MAX = 300;

/** What `whenToUse` says when nobody wrote it: the first sentence of the description. */
export function placeholder(description) {
  const first = /^(.+?[.!?])(\s|$)/.exec(description)?.[1] ?? description;
  return oneLine(first, WHEN_MAX);
}

const q = (value) => JSON.stringify(value);

/**
 * @param {{ server: string, transport: string, auth: string, instructionsChars: number, tools: { name: string, description: string }[] }} entry
 * @param {Map<string, string>} manual The `whenToUse` a person wrote, by tool name
 */
export function renderCatalog({ server, transport, auth, instructionsChars, tools }, manual = new Map()) {
  const rows = tools.map((raw) => {
    // Whatever the caller hands over is made one clean line again here, so the file cannot be broken from any caller.
    const tool = { name: oneLine(raw.name, 128), description: oneLine(raw.description, MAX_DESCRIPTION) };
    const written = manual.get(tool.name);
    return { ...tool, whenToUse: written ?? placeholder(tool.description), generated: written === undefined };
  });
  const front = [
    "---",
    `server: ${q(server)}`,
    `transport: ${q(transport)}`,
    `auth: ${q(auth)}`,
    `instructionsChars: ${Number(instructionsChars) || 0}`,
    `toolCount: ${rows.length}`,
    rows.length ? "tools:" : "tools: []",
    ...rows.flatMap((r) => [`  - name: ${q(r.name)}`, `    description: ${q(r.description)}`, `    whenToUse: ${q(r.whenToUse)}`, ...(r.generated ? ["    whenToUseGenerated: true"] : [])]),
    "---",
  ];
  const body = [`# ${server}`, "", ...rows.flatMap((r) => [`## ${r.name}`, "", `Description: ${r.description}`, "", `When to use: ${r.whenToUse}`, ""])];
  return `${front.join("\n")}\n\n${body.join("\n")}`;
}

/** The server a catalog file was written for, or null. */
export function catalogServer(text) {
  const match = /^---\nserver: (".*")\n/.exec(text);
  try {
    return match ? JSON.parse(match[1]) : null;
  } catch {
    return null;
  }
}

// The whole head `renderCatalog` writes, not only its first line: a file of a repository that starts with `server: "` is not ours.
const HEAD = /^---\nserver: ".*"\ntransport: ".*"\nauth: ".*"\ninstructionsChars: \d+\ntoolCount: \d+\ntools(?:: \[\]|:)\n/;
/** Whether a file is one this module wrote. */
export const isCatalogFile = (text) => HEAD.test(text);

/**
 * The tools of a file we wrote: `{ name, description, whenToUse, generated }`. Only the front matter is read, line by line,
 * in the shape `renderCatalog` writes: nothing is evaluated. A `whenToUse` counts as generated when it is the placeholder of
 * the description beside it (or empty), whatever the `whenToUseGenerated` line says: the text decides, not a flag a person
 * may have left behind.
 */
export function parseTools(text) {
  const tools = [];
  if (!isCatalogFile(text)) return tools;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return tools;
  let current = null;
  for (const line of text.slice(0, end).split("\n")) {
    const read = (prefix) => {
      try {
        const value = JSON.parse(line.slice(prefix.length));
        return typeof value === "string" ? value : null;
      } catch {
        return null;
      }
    };
    if (line.startsWith("  - name: ")) {
      const name = read("  - name: ");
      current = name !== null && SAFE_TOOL.test(name) ? { name, description: "", whenToUse: "", generated: true } : null;
      if (current) tools.push(current);
    } else if (current && line.startsWith("    description: ")) current.description = oneLine(read("    description: ") ?? "", MAX_DESCRIPTION);
    else if (current && line.startsWith("    whenToUse: ")) {
      current.whenToUse = oneLine(read("    whenToUse: ") ?? "", WHEN_MAX);
      current.generated = current.whenToUse === "" || current.whenToUse === placeholder(current.description);
    }
  }
  return tools;
}

/** The `whenToUse` a person wrote in a file we wrote earlier, by tool name. */
export function readManual(text) {
  return new Map(parseTools(text).filter((tool) => !tool.generated).map((tool) => [tool.name, tool.whenToUse]));
}

export { MAX_DESCRIPTION };
