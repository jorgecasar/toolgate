// The permission reader: rules in Claude Code syntax, what is dropped, and the hostile cases.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_PERMISSION_FILE_BYTES, MAX_RULES, MAX_RULE_LENGTH, parsePermission, renderPermission } from "../src/permissions/parse.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-perm-")));
made.push(root);
let count = 0;
const write = (data, name = `perm${count++}.json`) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
  return file;
};
const ok = (data, options) => parsePermission(write({ description: "Narrows the agent", deny: ["Bash(rm *)"], ...data }), options);
const refused = (data, pattern) => assert.throws(() => parsePermission(write({ description: "d", deny: ["Read"], ...data })), pattern, JSON.stringify(data).slice(0, 80));

test("a permission: the three lists, the name from the file, defaultMode and the rest dropped and listed", () => {
  const p = ok({ name: "safe", ask: ["WebFetch"], allow: ["Read(./docs/**)", "mcp__github", "mcp__github__get_issue"], defaultMode: "bypassPermissions", additionalDirectories: ["/"], disableBypassPermissionsMode: "disable", extra: 1 });
  assert.deepEqual([p.name, p.deny, p.ask, p.allow, p.kind], ["safe", ["Bash(rm *)"], ["WebFetch"], ["Read(./docs/**)", "mcp__github", "mcp__github__get_issue"], "permission"]);
  assert.deepEqual(p.dropped, ["additionalDirectories", "defaultMode", "disableBypassPermissionsMode", "extra"]);
  const file = write({ description: "d", deny: ["Read"] }, "from-file.json");
  assert.equal(parsePermission(file).name, "from-file");
  assert.equal(parsePermission(file, { relative: "team/x.json" }).name, "team-x", "relative is used when given, folders joined with a dash");
  assert.deepEqual(ok({ deny: ["Read", "Read"] }).deny, ["Read"], "a rule twice is one");
});

test("rules: Tool or Tool(specifier), or an mcp__ rule without parentheses; anything else is refused", () => {
  for (const rule of ["Bash", "Bash(git *)", "Read(./.env)", "Edit(**/src/**)", "WebFetch(domain:example.com)", "Bash(npm run test:*)"]) assert.deepEqual(ok({ deny: [rule] }).deny, [rule], rule);
  for (const rule of ["mcp__github", "mcp__github__get_issue", "mcp__my-server__do_it"]) assert.deepEqual(ok({ deny: [rule] }).deny, [rule], rule);
  for (const rule of ["mcp__github(x)", "mcp__", "mcp__a b", "mcp__*"]) refused({ deny: [rule] }, /is not valid: an mcp__ rule/);
  for (const rule of ["", "1Bash", "Bash(", "(x)", "Ba sh", "Bash\n(x)", "*"]) refused({ deny: [rule] }, /plain text|is not valid: use Tool/);
  refused({ allow: [5] }, /a "allow" rule must be plain text/);
  refused({ deny: "Read" }, /"deny" must be a list of rules/);
  refused({ deny: [], ask: [], allow: [] }, /has no rule/);
  refused({ deny: ["Bash(a\u001b[31m)"] }, /plain text/);
});

test("names, description and caps", () => {
  for (const name of ["index", "_index", "__proto__", "toolgate", "..", "a/b", "x\u001b[31m", 5]) refused({ name }, /cannot be used as a permission name/);
  refused({ description: "" }, /needs a "description"/);
  refused({ description: "a\nb" }, /needs a "description"/);
  refused({ deny: Array.from({ length: MAX_RULES + 1 }, (_, i) => `Bash(c${i})`) }, /more than 200 rules/);
  assert.equal(ok({ deny: Array.from({ length: MAX_RULES }, (_, i) => `Bash(c${i})`) }).deny.length, 200);
  refused({ deny: [`Bash(${"x".repeat(MAX_RULE_LENGTH)})`] }, /plain text of at most 512 characters/);
  assert.throws(() => parsePermission(write({ description: "d", deny: ["Read"], pad: "x".repeat(MAX_PERMISSION_FILE_BYTES) })), /larger than 16384 bytes/);
});

test("hostile files: invalid JSON, not an object, __proto__, a symlink, a folder", () => {
  assert.throws(() => parsePermission(write("{ nope")), /not valid JSON/);
  assert.throws(() => parsePermission(write("[]")), /must hold an object/);
  assert.throws(() => parsePermission(write("null")), /must hold an object/);
  const proto = parsePermission(write('{"__proto__":{"polluted":1},"description":"d","deny":["Read"]}'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(proto.dropped, []);
  const real = write({ description: "d", deny: ["Read"] });
  const link = path.join(root, "linked.json");
  fs.symlinkSync(real, link);
  assert.throws(() => parsePermission(link), /a symlink is not followed/);
  const folder = path.join(root, "folder.json");
  fs.mkdirSync(folder);
  assert.throws(() => parsePermission(folder), /regular file/);
});

test("the normalized text is stable and reads back to itself; an allow rule is never moved to another list", () => {
  const p = ok({ name: "n", allow: ["Read"], ask: ["Write"], defaultMode: "x" });
  const text = renderPermission(p);
  assert.match(text, /"name": [^\n]*\n[^\n]*"description": [^\n]*\n[^\n]*"deny": [\s\S]*"ask": [\s\S]*"allow": /, "a fixed order of keys");
  assert.deepEqual(JSON.parse(text), { name: "n", description: "Narrows the agent", deny: ["Bash(rm *)"], ask: ["Write"], allow: ["Read"] });
  const again = parsePermission(write(text, "round.json"));
  assert.equal(renderPermission(again), text);
  assert.deepEqual(again.dropped, []);
  assert.equal(renderPermission(parsePermission(write('{"allow":["Read"],"description":"Narrows the agent","ask":["Write"],"deny":["Bash(rm *)"],"name":"n"}', "reordered.json"))), text);
});
