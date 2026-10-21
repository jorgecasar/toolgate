// Claude-style rules as opencode's `permission`: the mapping, what does not map, the environment and the launch.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as opencode from "../src/adapters/opencode.js";
import { opencodeEnv, toOpencode } from "../src/permissions/opencode.js";
import { run } from "../src/cli.js";
import { loadApprovals, unitKey } from "../src/assets/approval.js";
import { grantHash, grantKeyOf, readPermissions } from "../src/permissions/install.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-oc-${name}-`)));
  made.push(dir);
  return dir;
};
const rules = (extra = {}) => ({ deny: [], ask: [], allow: [], ...extra });

test("Bash: exact commands and `*` patterns map; allow is written first, ask next and deny last (the last match wins)", () => {
  const { permission, unmapped } = toOpencode(rules({ deny: ["Bash(rm *)", "Bash(git push*)"], ask: ["Bash(git *)"], allow: ["Bash(git status)", "Bash(npm test)"] }));
  assert.deepEqual(unmapped, []);
  assert.deepEqual(Object.entries(permission.bash), [["git status", "allow"], ["npm test", "allow"], ["git", "ask"], ["git *", "ask"], ["rm", "deny"], ["rm *", "deny"], ["git push*", "deny"]]);
  assert.deepEqual(Object.values(permission.bash).slice(-2), ["deny", "deny"], "denies are last");
});

test("a whole tool, with no specifier or a match-everything one, is the pattern `*`", () => {
  for (const rule of ["Bash", "Bash()", "Bash(*)", "Bash(**)", "Bash(:*)"]) assert.deepEqual(toOpencode(rules({ deny: [rule] })).permission, { bash: { "*": "deny" } }, rule);
  assert.deepEqual(toOpencode(rules({ ask: ["WebFetch"], deny: ["Write"] })).permission, { webfetch: { "*": "ask" }, edit: { "*": "deny" } });
  assert.deepEqual(toOpencode(rules({ deny: ["Edit", "Write", "MultiEdit"] })).permission, { edit: { "*": "deny" } }, "Edit, Write and MultiEdit are one permission");
});

test("paths and domains: deny and ask widen the pattern (that only narrows); allow does not map because it would grant more", () => {
  const narrow = toOpencode(rules({ deny: ["Read(./.env)", "Edit(/etc/**)", "Read(~/.ssh/*)", "Read(*.pem)", "WebFetch(domain:example.com)"], ask: ["Edit(src/**)"] }));
  assert.deepEqual(narrow.unmapped, []);
  assert.deepEqual(narrow.permission.read, { "*.env": "deny", "~/.ssh/*": "deny", "*.pem": "deny" });
  assert.deepEqual(narrow.permission.edit, { "*src/**": "ask", "/etc/**": "deny" });
  assert.deepEqual(narrow.permission.webfetch, { "*example.com*": "deny" });
  const grant = toOpencode(rules({ allow: ["Read(./docs/**)", "WebFetch(domain:example.com)", "Edit(src/**)", "Bash(git status)"] }));
  assert.deepEqual(Object.keys(grant.permission), ["bash"], "only the exact one is applied");
  assert.deepEqual(grant.unmapped.map((u) => u.rule), ["Read(./docs/**)", "WebFetch(domain:example.com)", "Edit(src/**)"]);
  assert.ok(grant.unmapped.every((u) => u.list === "allow" && /cannot express this allow rule exactly/.test(u.reason)));
});

test("what does not map is returned with its list and the reason, never dropped: MCP names, unknown tools, other WebFetch forms", () => {
  const { permission, unmapped } = toOpencode(rules({ deny: ["mcp__github", "mcp__github__get_issue", "LSP", "WebFetch(https://x)", "Bash(rm *)"], allow: ["mcp__github"] }));
  assert.deepEqual(permission, { bash: { rm: "deny", "rm *": "deny" } });
  assert.deepEqual(unmapped.map((u) => [u.rule, u.list]), [["mcp__github", "deny"], ["mcp__github__get_issue", "deny"], ["LSP", "deny"], ["WebFetch(https://x)", "deny"], ["mcp__github", "allow"]]);
  const reasons = Object.fromEntries(unmapped.map((u) => [u.rule + u.list, u.reason]));
  assert.match(reasons["mcp__githubdeny"], /MCP tools is not verified/);
  assert.match(reasons["LSPdeny"], /has no permission for LSP/);
  assert.match(reasons["WebFetch(https://x)deny"], /only the `domain:` form/);
  assert.match(toOpencode(rules({ deny: ["not a rule!"] })).unmapped[0].reason, /not a Tool or Tool\(specifier\) rule/);
  const proto = toOpencode(rules({ deny: ["constructor", "__proto__", "toString(x)"] }));
  assert.deepEqual(Object.keys(proto.permission), [], "names of Object.prototype are not tools");
  assert.equal(proto.unmapped.length, 3);
});

test("the prefix form `cmd:*` of Claude is the command alone or followed by anything: two patterns, so a deny covers both", () => {
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(git push:*)"] })).permission, { bash: { "git push": "deny", "git push *": "deny" } });
  assert.deepEqual(toOpencode(rules({ ask: ["Bash(npm run test:*)"] })).permission, { bash: { "npm run test": "ask", "npm run test *": "ask" } });
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(:*)"] })).permission, { bash: { "*": "deny" } });
});

test("a restriction that cannot be written leaves no allow of the same tool applied, and it is said; other tools keep theirs", () => {
  const a = toOpencode(rules({ deny: ["Bash(foo", "WebFetch(https://x)"], allow: ["Bash(git status)", "Read"] }));
  assert.deepEqual(a.unmapped.map((u) => u.rule), ["Bash(foo", "WebFetch(https://x)"], "an unparsable rule has no tool: the allows stay");
  assert.deepEqual(a.permission, { bash: { "git status": "allow" }, read: { "*": "allow" } });
  const b = toOpencode(rules({ deny: ["WebFetch(https://x)"], allow: ["WebFetch", "Bash(ls)"] }));
  assert.deepEqual(b.permission, { bash: { ls: "allow" } }, "the webfetch allow could cover the url the deny names");
  assert.match(b.unmapped.at(-1).reason, /a restriction of the same tool could not be written, and this allow could cover it/);
  const c = toOpencode(rules({ ask: ["WebFetch(https://x)"], allow: ["WebFetch"] }));
  assert.deepEqual(c.permission, {}, "an ask that cannot be written holds the allow too");
});

test("a deny stays after the allow rules even when its pattern was first written as an allow (the last match wins)", () => {
  const { permission } = toOpencode(rules({ allow: ["Bash(ls)", "Bash(*)"], deny: ["Bash(ls)"] }));
  assert.deepEqual(Object.entries(permission.bash), [["*", "allow"], ["ls", "deny"]]);
});

test("a pattern in two lists keeps the strictest; an empty set maps to nothing", () => {
  assert.deepEqual(toOpencode(rules({ allow: ["Bash(ls)"], ask: ["Bash(ls)"], deny: ["Bash(ls)"] })).permission, { bash: { ls: "deny" } });
  assert.deepEqual(toOpencode(rules({ allow: ["Bash(ls)"], ask: ["Bash(ls)"] })).permission, { bash: { ls: "ask" } });
  assert.deepEqual(toOpencode(rules()), { permission: {}, unmapped: [] });
  assert.deepEqual(opencodeEnv(rules()), { env: {}, unmapped: [], note: null }, "no rule: the environment is not touched");
});

test("OPENCODE_CONFIG_CONTENT: ours go in; the user's own value is kept; a value that is not JSON is left alone", () => {
  const plain = opencodeEnv(rules({ deny: ["Bash(rm *)"] }), {});
  assert.deepEqual(JSON.parse(plain.env.OPENCODE_CONFIG_CONTENT), { permission: { bash: { rm: "deny", "rm *": "deny" } } });
  const theirs = JSON.stringify({ model: "x", permission: { bash: { "cat *": "ask", "rm *": "ask" }, read: { "*.env": "deny" } } });
  const merged = JSON.parse(opencodeEnv(rules({ deny: ["Bash(rm *)"], allow: ["Bash(ls)"], ask: ["WebFetch"] }), { OPENCODE_CONFIG_CONTENT: theirs }).env.OPENCODE_CONFIG_CONTENT);
  assert.equal(merged.model, "x", "their other keys stay");
  assert.deepEqual(Object.entries(merged.permission.bash), [["ls", "allow"], ["cat *", "ask"], ["rm", "deny"], ["rm *", "deny"]], "our allow first, theirs next, our restrictions last; the stricter value for a shared pattern");
  assert.deepEqual(merged.permission.read, { "*.env": "deny" });
  assert.deepEqual(merged.permission.webfetch, { "*": "ask" });
  for (const [bad, reason] of [["{ nope", "not valid JSON"], ["[]", "not a JSON object"], ["null", "not a JSON object"], ["5", "not a JSON object"], ['"text"', "not a JSON object"]]) {
    const result = opencodeEnv(rules({ deny: ["Write"] }), { OPENCODE_CONFIG_CONTENT: bad });
    assert.deepEqual(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT), { permission: { edit: { "*": "deny" } } }, `${bad}: the user's value is left out, ours go on alone`);
    assert.equal(result.note, `your settings OPENCODE_CONFIG_CONTENT could not be read (${reason}); started with toolgate's permissions only`, bad);
  }
  const secret = opencodeEnv(rules({ deny: ["Write"] }), { OPENCODE_CONFIG_CONTENT: '{ "k": "TOP-SECRET" ' });
  assert.ok(!secret.note.includes("TOP-SECRET") && !secret.env.OPENCODE_CONFIG_CONTENT.includes("TOP-SECRET"), "the content is never shown or passed on");
  assert.equal(opencodeEnv(rules({}), { OPENCODE_CONFIG_CONTENT: "{ nope" }).note, null, "no rules of ours: nothing to say, the user's value is not touched");
  assert.equal(opencodeEnv(rules({ deny: ["Write"] }), { OPENCODE_CONFIG_CONTENT: "{}" }).note, null, "a readable one says nothing");
  assert.deepEqual(JSON.parse(opencodeEnv(rules({ deny: ["Write"] }), { OPENCODE_CONFIG_CONTENT: "" }).env.OPENCODE_CONFIG_CONTENT), { permission: { edit: { "*": "deny" } } }, "an empty value is no value");
});

// --- Does a grant ever loosen what the user, or a restriction of ours, says? An emulation of opencode's decision (the last
// matching pattern wins) over the config toolgate produces, for many commands and the user's own config in many shapes.
const regex = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
const RANK = { default: -1, allow: 0, ask: 1, deny: 2 };
function decide(config, tool, input) {
  const given = config?.permission;
  const value = typeof given === "string" ? given : given?.[tool];
  if (typeof value === "string") return value;
  let result = "default";
  for (const [pattern, v] of Object.entries(value ?? {})) if (regex(pattern).test(input)) result = v;
  return result;
}
// What Claude does with the same rules: any matching deny beats ask beats allow.
function claude(rules, input) {
  const matches = (rule) => {
    const specifier = /^Bash\((.*)\)$/.exec(rule)?.[1] ?? "*";
    if (specifier.endsWith(":*")) return input === specifier.slice(0, -2) || input.startsWith(`${specifier.slice(0, -2)} `);
    return regex(specifier).test(input);
  };
  for (const list of ["deny", "ask", "allow"]) if ((rules[list] ?? []).some(matches)) return list;
  return "default";
}
const COMMANDS = ["ls", "git status", "git push origin main", "git push", "git log", "rm -rf x", "rm", "cat x", "npm run test", "npm run test:unit", "npm run build", "curl http://x"];
const USERS = {
  none: undefined,
  specific: { permission: { bash: { "git push *": "deny" } } },
  rm: { permission: { bash: { "rm *": "deny" } } },
  star: { permission: { bash: { "*": "ask" } } },
  both: { permission: { bash: { "git push *": "deny", "*": "ask" } } },
  stringDeny: { permission: { bash: "deny" } },
  stringAsk: { permission: { bash: "ask" } },
  global: { permission: "deny" },
  globalAsk: { permission: "ask" },
  other: { permission: { bash: { "cat *": "ask" } } },
  stringAllow: { permission: { bash: "allow" } },
};
const SETS = {
  grantGit: rules({ allow: ["Bash(git *)"] }),
  grantAll: rules({ allow: ["Bash(*)"], deny: ["Bash(rm *)"] }),
  grantStatus: rules({ allow: ["Bash(git status)", "Bash(ls)"], deny: ["Bash(rm *)"] }),
  prefixDeny: rules({ allow: ["Bash(git push)"], deny: ["Bash(git push:*)"] }),
  prefixDenyWide: rules({ allow: ["Bash(git *)"], deny: ["Bash(git push:*)"] }),
  prefixDenyAll: rules({ allow: ["Bash(*)"], deny: ["Bash(git push:*)", "Bash(rm *)"] }),
  askAndAllow: rules({ allow: ["Bash(npm run *)"], ask: ["Bash(npm run test:*)"] }),
  onlyDeny: rules({ deny: ["Bash(rm *)"] }),
};
const BASH_FOR = (user, set) => {
  const env = opencodeEnv(set, user ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(user) } : {}).env.OPENCODE_CONFIG_CONTENT;
  return env ? JSON.parse(env) : user;
};

test("no grant ever loosens a restriction, whatever the user's own config looks like: the decision for every command is at least as strict as the user's alone and as ours alone", () => {
  for (const [userName, user] of Object.entries(USERS)) {
    for (const [setName, set] of Object.entries(SETS)) {
      const config = BASH_FOR(user, set);
      for (const input of COMMANDS) {
        const got = decide(config, "bash", input);
        const theirs = decide(user, "bash", input);
        const ours = claude(set, input);
        const why = `${userName} + ${setName}: "${input}" -> ${got} (user alone ${theirs}, ours alone ${ours})`;
        if (theirs !== "default") assert.ok(RANK[got] >= RANK[theirs], `looser than the user: ${why}`);
        if (ours === "deny" || ours === "ask") assert.ok(RANK[got] >= RANK[ours], `looser than our restriction: ${why}`);
      }
    }
  }
});

test("the grant still works where nothing forbids it: the user's own config does not mention the command", () => {
  const config = BASH_FOR({ permission: { bash: { "cat *": "ask" } } }, SETS.grantStatus);
  assert.equal(decide(config, "bash", "git status"), "allow");
  assert.equal(decide(config, "bash", "ls"), "allow");
  assert.equal(decide(config, "bash", "rm -rf x"), "deny");
  assert.equal(decide(config, "bash", "cat x"), "ask");
  assert.equal(decide(BASH_FOR(undefined, SETS.prefixDeny), "bash", "git push"), "deny", "the prefix deny covers the command alone");
  assert.equal(decide(BASH_FOR(undefined, SETS.prefixDeny), "bash", "git push origin"), "deny", "and with arguments");
});

test("the user's own order is kept where nothing of ours changes it, and an entry of theirs that we make stricter moves after theirs", () => {
  const entries = (user, set) => Object.entries(JSON.parse(opencodeEnv(set, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: user } }) }).env.OPENCODE_CONFIG_CONTENT).permission.bash);
  assert.deepEqual(entries({ "*": "ask", "git *": "allow" }, rules({ allow: ["Bash(git *)"] })), [["*", "ask"], ["git *", "allow"]], "their exception after their default stays after it");
  assert.deepEqual(entries({ "git *": "allow", "*": "allow" }, rules({ ask: ["Bash(git *)"] })), [["*", "allow"], ["git", "ask"], ["git *", "ask"]], "our ask goes after their allow");
});

test("the string forms of the user are kept as the pattern `*`, and `permission: \"deny\"` as a whole stays a deny for the tools we do not touch", () => {
  const strings = JSON.parse(opencodeEnv(rules({ deny: ["Bash(rm *)"] }), { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "deny" } }) }).env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(strings.permission.bash, { "*": "deny", rm: "deny", "rm *": "deny" });
  const global = JSON.parse(opencodeEnv(rules({ deny: ["Bash(rm *)"] }), { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "deny" }) }).env.OPENCODE_CONFIG_CONTENT);
  assert.equal(global.permission.read, "deny");
  assert.equal(global.permission.edit, "deny");
  assert.equal(global.permission.webfetch, "deny");
  assert.deepEqual(global.permission.bash, { "*": "deny", rm: "deny", "rm *": "deny" });
  assert.equal(decide(global, "read", "x"), "deny");
  const allowed = JSON.parse(opencodeEnv(rules({ deny: ["Bash(rm *)"] }), { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { bash: "allow" } }) }).env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(allowed.permission.bash, { "*": "allow", rm: "deny", "rm *": "deny" }, "their allow-all is kept, our deny after it wins");
});

test("the opencode adapter gives the launch its environment: the permission config, next to its own OPENCODE_CONFIG, and nothing when there is none", async () => {
  const run1 = (applied) => {
    const spawned = [];
    const child = new EventEmitter();
    const spawnFn = (cmd, args, options) => {
      spawned.push(options.env);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    };
    return opencode.launch({ prompt: "go", config: {}, state: { extras: [], toolExtras: {}, pendingRestart: false }, spawnFn, tmpDir: tmp("cfg"), projectDir: tmp("project"), applied }).then(() => spawned[0]);
  };
  const withRules = await run1({ settings: {}, env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"edit":{"*":"deny"}}}' } });
  assert.equal(withRules.OPENCODE_CONFIG_CONTENT, '{"permission":{"edit":{"*":"deny"}}}');
  assert.ok(withRules.OPENCODE_CONFIG, "its own config is still there");
  const without = await run1({ settings: {}, env: {}, cleanup() {} });
  assert.equal(without.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_CONFIG_CONTENT);
  const none = await run1(undefined);
  assert.equal(none.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_CONFIG_CONTENT);
});

// The whole launch through the CLI: units in the store, approvals, and what opencode was started with.
async function launchedOpencode({ deny = [], ask = [], allow = [], granted = false, userEnv = {} }) {
  const cwd = tmp("project");
  const home = tmp("home");
  const userDir = path.join(home, ".config", "toolgate");
  fs.mkdirSync(path.join(cwd, ".toolgate/permissions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".toolgate/permissions/rules.json"), JSON.stringify({ name: "rules", description: "d", deny, ask, allow }));
  const approvals = loadApprovals(userDir);
  const [unit] = readPermissions({ projectDir: cwd, userDir }).found;
  approvals.approve(unitKey({ projectDir: cwd, level: "project", kind: "permission", name: "rules" }), unit.hash);
  if (granted) approvals.approve(grantKeyOf({ projectDir: cwd, level: "project", name: "rules" }), grantHash(unit));
  approvals.save();
  const real = await (await import("../src/adapters/index.js")).defaultRegistry.get("opencode");
  const spawned = [];
  const errors = [];
  const child = new EventEmitter();
  const launch = (options) => real.launch({ ...options, env: { ...process.env, ...userEnv }, tmpDir: tmp("cfg"), spawnFn: (cmd, args, spawnOptions) => (spawned.push(spawnOptions.env), queueMicrotask(() => child.emit("exit", 0, null)), child) });
  const code = await run(["--no-route", "go"], { cwd, env: { HOME: home, TOOLGATE_DEFAULTS: path.join(userDir, "config.json"), TOOLGATE_ADAPTER: "opencode", ...userEnv }, stdout: { write: () => {} }, stderr: { write: (s) => errors.push(s) }, loadConfigFn: () => ({}), loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {}, adapters: { opencode: () => Promise.resolve({ ...real, launch }) } });
  return { code, env: spawned[0], errors: errors.join("") };
}

test("end to end: the rules of the approved units reach opencode; deny and ask always, allow only when approved and granted; what cannot be expressed is said", async () => {
  const open = await launchedOpencode({ deny: ["Bash(rm *)", "mcp__github"], ask: ["WebFetch"], allow: ["Bash(git status)"] });
  assert.equal(open.code, 0);
  assert.deepEqual(JSON.parse(open.env.OPENCODE_CONFIG_CONTENT).permission, { webfetch: { "*": "ask" }, bash: { rm: "deny", "rm *": "deny" } }, "not granted: no allow");
  assert.match(open.errors, /toolgate: 1 permission rule cannot be applied in opencode: mcp__github \[deny\]: opencode's naming of MCP tools is not verified/);
  assert.match(open.errors, /its allow rules are not granted/);

  const granted = await launchedOpencode({ deny: ["Bash(rm *)"], allow: ["Bash(git status)", "Read(./docs/**)"], granted: true });
  assert.deepEqual(JSON.parse(granted.env.OPENCODE_CONFIG_CONTENT).permission, { bash: { "git status": "allow", rm: "deny", "rm *": "deny" } });
  assert.match(granted.errors, /Read\(\.\/docs\/\*\*\) \[allow\]: opencode cannot express this allow rule exactly/);

  const clean = await launchedOpencode({ deny: ["Bash(rm *)"] });
  assert.equal(clean.errors, "");

  const mine = await launchedOpencode({ deny: ["Bash(rm *)"], userEnv: { OPENCODE_CONFIG_CONTENT: "{ nope" } });
  assert.deepEqual(JSON.parse(mine.env.OPENCODE_CONFIG_CONTENT).permission, { bash: { rm: "deny", "rm *": "deny" } }, "the user's unreadable value is left out and toolgate's rules go on");
  assert.equal(mine.errors, "toolgate: your settings OPENCODE_CONFIG_CONTENT could not be read (not valid JSON); started with toolgate's permissions only\n", "once");
  assert.equal(mine.code, 0, "the launch goes ahead");
  for (const bad of ["[1]", "null"]) {
    const other = await launchedOpencode({ deny: ["Bash(rm *)"], userEnv: { OPENCODE_CONFIG_CONTENT: bad } });
    assert.match(other.errors, /could not be read \(not a JSON object\)/, bad);
    assert.equal((other.errors.match(/could not be read/g) ?? []).length, 1, bad);
  }
});

test("a restriction on `Bash(cmd *)` also names the bare command; an allow stays as exact as it was written", () => {
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(rm *)"] })).permission, { bash: { rm: "deny", "rm *": "deny" } });
  assert.deepEqual(toOpencode(rules({ ask: ["Bash(git push *)"] })).permission, { bash: { "git push": "ask", "git push *": "ask" } });
  assert.deepEqual(toOpencode(rules({ allow: ["Bash(git status *)"] })).permission, { bash: { "git status *": "allow" } }, "an allow is not widened to the bare command");
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(rm:*)"] })).permission, { bash: { rm: "deny", "rm *": "deny" } }, "the prefix form already did");
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(rm -rf x)"] })).permission, { bash: { "rm -rf x": "deny" } }, "an exact command is just itself");
  assert.deepEqual(toOpencode(rules({ deny: ["Bash(*)", "Bash( *)"] })).permission, { bash: { "*": "deny", " *": "deny" } }, "nothing before the star: no bare command to name");
});
