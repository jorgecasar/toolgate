// SHA-256 of every /toolgate bridge file (`<agent folder>/toolgate.md`) that `toolgate commands bridge` has written, oldest first.
// `toolgate update` replaces a bridge only when the file is byte-identical to one of these; anything else was edited by the
// user (or is not toolgate's) and stays. When the text of the bridge changes, ADD the new hash: never remove one.
export const KNOWN_BRIDGE_SHA256 = Object.freeze([
  "c46a2c61f90d59c5e8dd88150fb58ecbf91ada526622403246e9729f52f1b7de", // eb9b7d6 the bridge command (Markdown; the Gemini TOML was removed in a3f4432)
]);
