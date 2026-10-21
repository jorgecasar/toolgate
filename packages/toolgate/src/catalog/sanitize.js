// Text that comes back from an MCP server is untrusted: it ends up in a file that is indexed and read by an agent.
import { exact } from "../assets/common.js";
export const MAX_DESCRIPTION = 4096;
export const MAX_TOOLS = 500;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

// A tool is searched and shown by its name, so a name has to be plain.
export const SAFE_TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
// The name of a server becomes a file name, so it is checked before anything is done with it.
export const SAFE_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Controls, line and paragraph separators, bidirectional overrides and isolates, zero-width and format characters.
const UNSAFE = /[\p{Cs}\ufffe\uffff\ufdd0-\ufdef\p{Cf}\u034f\u115f\u1160\u2800\u3164\uffa0\u00a0\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;

/** One line of plain text: every control, separator and override becomes a space; at most `max` characters. */
export function oneLine(value, max = MAX_DESCRIPTION) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  // Cutting can split a surrogate pair: what is left of it is cleaned again.
  return (cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned).replace(UNSAFE, " ");
}

export const validServerName = (name) => typeof name === "string" && SAFE_SERVER.test(name) && name !== "." && name !== "..";

export { exact };

/**
 * The text of an error with the credentials of any url in it removed, and the query and fragment of any url too: a server
 * that echoes the address it was called at would otherwise print a token that was in it.
 */
export const redact = (text) =>
  String(text)
    .replace(/\/\/[^\s/@]*@/g, "//")
    // One pass over the words, each looked at once: a pattern that tried every `http://` against the rest of the text was quadratic.
    .replace(/[^\s"'<>]+/g, (word) => {
      const url = word.search(/https?:\/\//i);
      if (url < 0) return word;
      const cut = word.slice(url).search(/[?#]/);
      return cut < 0 ? word : `${word.slice(0, url + cut)}?…`;
    });
