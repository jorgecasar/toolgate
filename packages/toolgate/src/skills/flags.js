// Which flags each `toolgate skills <action>` really uses. A flag outside its action is refused before anything is written,
// not accepted and ignored in silence.
const USES = Object.freeze({
  index: ["--force"],
  search: ["--json", "--kind"],
  status: ["--json", "--remote", "--check"],
  recommended: ["--json"],
  install: ["--force", "--user", "--local", "--ref", "--path", "--exclude", "--dry-run", "--json"],
  update: ["--dry-run", "--force", "--prune", "--accept-license", "--source", "--user", "--local", "--json"],
  remove: ["--dry-run", "--force", "--keep-overrides", "--source", "--user", "--local", "--json"],
});
const CHECKED = [...new Set(Object.values(USES).flat())];

/**
 * The first flag of `argv` that `action` does not use, as a message, or null. Words after `--` are not flags.
 * @param {string} action
 * @param {string[]} argv the arguments after `skills`
 */
export function unsupportedFlag(action, argv) {
  const uses = USES[action];
  if (!uses) return null;
  const end = argv.indexOf("--");
  for (const arg of end === -1 ? argv : argv.slice(0, end)) {
    const flag = arg.split("=")[0];
    if (!CHECKED.includes(flag) || uses.includes(flag)) continue;
    const applies = Object.keys(USES).filter((name) => USES[name].includes(flag));
    return `toolgate skills ${action}: ${flag} is not supported here (it applies to ${applies.join(", ")})`;
  }
  return null;
}
