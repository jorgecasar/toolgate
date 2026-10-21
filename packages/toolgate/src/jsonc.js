// JSON with comments (`//`, `/* */`) and trailing commas, the form of opencode.jsonc. One pass over the text, no regular expression and no
// rewriting of what was already read: the files come from a repository, so the time must grow with their size and nothing else.

const BLANKS = " \t\n\r";

/** The JSON text of a JSONC text: comments become nothing, a comma before `}` or `]` goes, and strings are left as they are. */
export function stripJsonc(text) {
  const parts = [];
  let i = 0;
  // The index in `parts` of the last comma that is followed only by blanks so far, or -1.
  let comma = -1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      parts.push(text.slice(i, j + 1));
      i = j + 1;
      comma = -1;
    } else if (char === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError("unterminated comment");
      i = end + 2;
    } else {
      if (char === ",") comma = parts.length;
      else if ((char === "}" || char === "]") && comma !== -1) {
        parts[comma] = "";
        comma = -1;
      } else if (!BLANKS.includes(char)) comma = -1;
      parts.push(char);
      i += 1;
    }
  }
  return parts.join("");
}

/** The value of a JSONC text; throws like JSON.parse. */
export const parseJsonc = (text) => JSON.parse(stripJsonc(text));
