// Claude-style permission rules as opencode's `permission` object. opencode takes `permission.<tool>` as a map of patterns to
// `allow` | `ask` | `deny`, and the LAST matching pattern wins, so the rules are written allow first, then ask, then deny:
// a deny always beats an allow. Checked with `opencode debug config` (1.18.4); what does not map is returned, never dropped.
//   - `deny` and `ask` may match MORE than the Claude rule did (a path pattern gets a leading `*`): that only narrows.
//   - `allow` is mapped only where the pattern is exact. Where it could not be (a path, a domain), it is not applied.
//   - MCP tool names (`mcp__server__tool`) are not verified in opencode, so those rules are reported, not guessed.
const TOOL_KEY = new Map(Object.entries({ Bash: "bash", Read: "read", Edit: "edit", Write: "edit", MultiEdit: "edit", NotebookEdit: "edit", WebFetch: "webfetch", WebSearch: "websearch", Glob: "glob", Grep: "grep", Task: "task", Skill: "skill" }));
// Every tool opencode gates: a plain string for `permission` as a whole stands for all of them.
const GATED = ["read", "grep", "glob", "list", "edit", "bash", "webfetch", "websearch", "task", "lsp", "skill"];
const ORDER = ["allow", "ask", "deny"];
const RULE = /^([A-Za-z]\w*)(?:\(([\s\S]*)\))?$/;
const strictest = (a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

// The patterns one Claude rule stands for in opencode, or why there are none.
function patterns(tool, specifier, list) {
  if (specifier === undefined || specifier === "" || specifier === "*" || specifier === "**") return { patterns: ["*"] };
  if (tool === "bash") {
    // Claude's `cmd:*` is a prefix match: the command alone, or followed by anything.
    if (specifier === ":*") return { patterns: ["*"] };
    if (specifier.endsWith(":*")) return { patterns: [specifier.slice(0, -2), `${specifier.slice(0, -2)} *`] };
    // `rm *` may not match a bare `rm`: a restriction also names the command alone. An allow stays as exact as it was written.
    const bare = specifier.endsWith(" *") ? specifier.slice(0, -2).trimEnd() : "";
    if (bare && list !== "allow") return { patterns: [bare, specifier] };
    return { patterns: [specifier] };
  }
  // Paths and URLs: a pattern that matches at least what the rule matched is safe for deny and ask, but would grant more than
  // the rule said for allow.
  if (list === "allow") return { reason: "opencode cannot express this allow rule exactly" };
  if (tool === "webfetch") {
    const domain = specifier.startsWith("domain:") ? specifier.slice("domain:".length) : null;
    return domain ? { patterns: [`*${domain}*`] } : { reason: "only the `domain:` form of WebFetch is mapped" };
  }
  if (["read", "edit", "glob", "grep"].includes(tool)) {
    const bare = specifier.replace(/^\.\//, "");
    return { patterns: [bare.startsWith("/") || bare.startsWith("~") || bare.startsWith("*") ? bare : `*${bare}`] };
  }
  return { reason: "opencode has no pattern for this tool" };
}

/**
 * @param {{ deny: string[], ask: string[], allow: string[] }} rules Claude-style rules
 * @returns {{ permission: Record<string, Record<string, string>>, unmapped: Array<{ rule: string, list: string, reason: string }> }}
 */
export function toOpencode(rules) {
  const byTool = new Map();
  const unmapped = [];
  // A restriction (deny or ask) that cannot be written leaves the tool it belongs to uncertain: no allow of that tool is applied
  // then, because it could cover what the restriction forbids. A rule of another tool, or of no tool opencode has, is disjoint.
  const uncertain = new Set();
  const entries = (tool) => byTool.get(tool) ?? byTool.set(tool, new Map()).get(tool);
  for (const list of ["deny", "ask", "allow"]) {
    for (const rule of rules[list] ?? []) {
      const match = RULE.exec(rule);
      if (!match) {
        unmapped.push({ rule, list, reason: "not a Tool or Tool(specifier) rule" });
        continue;
      }
      const [, name, specifier] = match;
      const tool = TOOL_KEY.get(name);
      const fail = (reason) => {
        unmapped.push({ rule, list, reason });
        if (list !== "allow" && tool) uncertain.add(tool);
      };
      if (rule.startsWith("mcp__")) fail("opencode's naming of MCP tools is not verified, so the rule is not guessed");
      else if (!tool) fail(`opencode has no permission for ${name}`);
      else {
        const mapped = patterns(tool, specifier, list);
        if (mapped.reason) fail(mapped.reason);
        else for (const pattern of mapped.patterns) {
          const map = entries(tool);
          map.set(pattern, map.has(pattern) ? strictest(map.get(pattern), list) : list);
        }
      }
    }
  }
  const permission = {};
  for (const [tool, map] of byTool) {
    const held = uncertain.has(tool);
    const list = [...map].filter(([, value]) => !(held && value === "allow"));
    for (const [pattern, value] of map) {
      if (held && value === "allow") unmapped.push({ rule: `${pattern} (${tool})`, list: "allow", reason: "not applied: a restriction of the same tool could not be written, and this allow could cover it" });
    }
    // Allow first, then ask, then deny: the last match wins, so a restriction always beats an allow.
    list.sort(([, a], [, b]) => ORDER.indexOf(a) - ORDER.indexOf(b));
    if (list.length) permission[tool] = Object.fromEntries(list);
  }
  return { permission, unmapped };
}

/**
 * The environment of an opencode launch for these rules: `OPENCODE_CONFIG_CONTENT` outranks the project's `opencode.json`, and
 * objects deep-merge with the user's own. The user's own value of that variable is kept and merged so that NOTHING OF OURS
 * LOOSENS IT: our allow entries go before everything the user wrote (their rules, later, win over them), our ask and deny
 * entries after (they win over the user's), and for a pattern both have the stricter value stays. A plain string for a tool (or
 * for `permission` as a whole) is the pattern `*` of the user, and is kept as such. One that is not a JSON object is left out, the
 * launch goes on with toolgate's permissions only, and `note` says so (it never shows the content).
 * @returns {{ env: Record<string, string>, unmapped: object[], note: string | null }}
 */
export function opencodeEnv(rules, userEnv = {}) {
  const { permission, unmapped } = toOpencode(rules);
  if (Object.keys(permission).length === 0) return { env: {}, unmapped, note: null };
  let theirs = {};
  let note = null;
  if (userEnv.OPENCODE_CONFIG_CONTENT !== undefined && userEnv.OPENCODE_CONFIG_CONTENT !== "") {
    try {
      theirs = JSON.parse(userEnv.OPENCODE_CONFIG_CONTENT);
      if (theirs === null || typeof theirs !== "object" || Array.isArray(theirs)) throw new TypeError("not an object");
    } catch (err) {
      theirs = {};
      note = `your settings OPENCODE_CONFIG_CONTENT could not be read (${err instanceof SyntaxError ? "not valid JSON" : "not a JSON object"}); started with toolgate's permissions only`;
    }
  }
  const given = theirs.permission;
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  // `permission: "deny"` as a whole says "deny" for every tool: written out per tool, it survives the merge with our object.
  const merged = typeof given === "string" ? Object.fromEntries(GATED.map((tool) => [tool, given])) : isMap(given) ? { ...given } : {};
  for (const [tool, ours] of Object.entries(permission)) {
    const existing = merged[tool];
    const theirEntries = typeof existing === "string" ? [["*", existing]] : isMap(existing) ? Object.entries(existing) : [];
    const theirs2 = new Map(theirEntries);
    const strictOf = (pattern, value) => (theirs2.has(pattern) && ORDER.includes(theirs2.get(pattern)) ? strictest(theirs2.get(pattern), value) : value);
    // opencode lets the LAST matching pattern win, so the order decides who wins. Nothing of ours may loosen what the user wrote,
    // and our restrictions must hold, so: our new allow first (every rule of the user, later, wins over it); then the user's allow
    // and ask entries as they were; then our ask (it wins over their allow, not over their deny); then the user's deny; our deny last.
    const finalValue = new Map(Object.entries(ours).map(([pattern, value]) => [pattern, strictOf(pattern, value)]));
    const ourAllow = [];
    const ourAsk = [];
    const ourDeny = [];
    for (const [pattern, value] of finalValue) {
      const fromTheirs = theirs2.has(pattern) && theirs2.get(pattern) === value;
      if (fromTheirs) continue; // the user's own entry already says it, and stays where it was
      (value === "allow" ? ourAllow : value === "ask" ? ourAsk : ourDeny).push([pattern, value]);
    }
    const kept = theirEntries.filter(([pattern]) => !finalValue.has(pattern) || finalValue.get(pattern) === theirs2.get(pattern));
    const middle = kept.filter(([, value]) => value !== "deny");
    const theirDeny = kept.filter(([, value]) => value === "deny");
    merged[tool] = Object.fromEntries([...ourAllow, ...middle, ...ourAsk, ...theirDeny, ...ourDeny]);
  }
  return { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...theirs, permission: merged }) }, unmapped, note };
}
