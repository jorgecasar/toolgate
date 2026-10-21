// F7 (SPEC-dynamic-activation-and-routing §8): the client's permission classifier is semantic, so a
// name toolgate injects or reveals that sounds sensitive can be auto-denied. A name is split into
// words (`reveal_secret`, `revealSecret`, `reveal-secret`) and a term matches a whole word, with an
// optional `s`, `ed` or `ing` ending: `tokens` matches, `tokenizer` does not.
export const NAMING_DENYLIST = Object.freeze([
  "secret",
  "password",
  "passwd",
  "token",
  "credential",
  "apikey",
  "reveal",
  "exfiltrate",
  "exfil",
  "dump",
  "leak",
  "steal",
  "bypass",
]);

// `apikey` also matches the two words `api key`.
const PATTERNS = { apikey: "api ?key" };

const words = (name) =>
  String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** The denylisted terms `name` contains, in list order. */
export function deniedTerms(name, denylist = NAMING_DENYLIST) {
  const text = words(name);
  return denylist.filter((term) => new RegExp(`(^| )${PATTERNS[term] ?? term}(s|ed|ing)?( |$)`).test(text));
}
