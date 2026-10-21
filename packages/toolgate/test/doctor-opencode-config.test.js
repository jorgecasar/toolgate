// `toolgate doctor` on opencode's own config (#1 T3): servers toolgate-proxy does not wrap, and config files that are links. Throwaway project
// and HOME, a fake opencode on the PATH of the doctor (execFn), the real ~/.config/opencode never read.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import * as opencode from "../src/adapters/opencode.js";

const made = [];
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-doc-oc-")));
  made.push(dir);
  return dir;
};
test.after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const put = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};
const wrapped = (name) => ({ type: "local", command: ["toolgate-proxy"], environment: { TOOLGATE_UPSTREAM_CMD: "node", TOOLGATE_SERVER: name } });
const registry = () => ({ has: (name) => name === "opencode", get: async () => opencode });

async function report({ project = {}, home = {}, installed = true, env = {} } = {}) {
  const cwd = tmp();
  const homedir = tmp();
  for (const [root, map] of [[cwd, project], [homedir, home]]) for (const [name, content] of Object.entries(map)) put(path.join(root, name), content);
  const out = [];
  await run(["doctor", "--json"], {
    cwd,
    env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "", ...env },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    doctor: { homedir, registry: registry(), execFn: () => { if (!installed) throw new Error("ENOENT"); }, daemon: { status: async () => ({ running: false }) } },
  });
  return { checks: JSON.parse(out.join("")).checks, cwd, homedir };
}
const findings = (checks) => checks.filter((c) => (c.id === "mcp.dynamic" && c.message.includes("(opencode)")) || c.id === "opencode.config").map((c) => [c.level, c.id, c.message, c.hint]);

test("a server opencode defines that is not wrapped, and one wrapped without TOOLGATE_SERVER, are warnings with their fix; a wrapped one is not", async () => {
  const { checks } = await report({
    project: { "opencode.json": { mcp: { ok: wrapped("ok"), plain: { type: "local", command: ["node", "s.js"] }, unnamed: { type: "local", command: ["toolgate-proxy"], environment: { TOOLGATE_UPSTREAM_CMD: "node" } }, other: wrapped("elsewhere"), remote: { type: "remote", url: "https://x" } } } },
  });
  assert.deepEqual(findings(checks), [
    ["warn", "mcp.dynamic", "plain (opencode) is not wrapped by toolgate-proxy, so its tools cannot be revealed without a restart", 'wrap it with toolgate-proxy: "command": ["toolgate-proxy"] and the server it runs in "environment" (docs/getting-started.md, "Reveal tools without a restart")'],
    ["warn", "mcp.dynamic", 'unnamed (opencode) is wrapped by toolgate-proxy but its entry does not set TOOLGATE_SERVER to "unnamed", so its tools cannot be revealed without a restart', 'add "TOOLGATE_SERVER": "<the server name>" to its "environment" (docs/getting-started.md, "Reveal tools without a restart")'],
    ["warn", "mcp.dynamic", 'other (opencode) is wrapped by toolgate-proxy but its entry does not set TOOLGATE_SERVER to "other", so its tools cannot be revealed without a restart', 'add "TOOLGATE_SERVER": "<the server name>" to its "environment" (docs/getting-started.md, "Reveal tools without a restart")'],
  ]);
});

test("the servers are read from every file opencode reads (a .jsonc with comments, the user's folder, OPENCODE_CONFIG), and a server wrapped in all of them says nothing", async () => {
  const named = tmp();
  const file = put(path.join(named, "named.json"), { mcp: { viaEnv: { type: "local", command: ["node"] } } });
  const { checks } = await report({
    project: { "opencode.jsonc": '{ // servers\n "mcp": { "fromJsonc": { "type": "local", "command": ["node",], }, }, }' },
    home: { ".config/opencode/opencode.json": { mcp: { fromHome: { type: "local", command: ["node"] }, fine: wrapped("fine") } } },
    env: { OPENCODE_CONFIG: file },
  });
  assert.deepEqual(findings(checks).map(([, , message]) => message.split(" ")[0]), ["fromHome", "viaEnv", "fromJsonc"]);
  const clean = await report({ project: { "opencode.json": { mcp: { a: wrapped("a"), b: wrapped("b") } } } });
  assert.deepEqual(findings(clean.checks), []);
});

test("a config file that is a symbolic link is a warning that names it, and what it defines is not checked", async () => {
  const cwd = tmp();
  const homedir = tmp();
  const target = put(path.join(tmp(), "real.json"), { mcp: { plain: { type: "local", command: ["node"] } } });
  fs.symlinkSync(target, path.join(cwd, "opencode.json"));
  fs.mkdirSync(path.join(homedir, ".config", "opencode"), { recursive: true });
  fs.symlinkSync(target, path.join(homedir, ".config", "opencode", "opencode.jsonc"));
  const out = [];
  await run(["doctor", "--json"], {
    cwd,
    env: { TOOLGATE_DEFAULTS: path.join(homedir, "none.json"), PATH: "" },
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    doctor: { homedir, registry: registry(), execFn: () => {}, daemon: { status: async () => ({ running: false }) } },
  });
  assert.deepEqual(findings(JSON.parse(out.join("")).checks), [
    ["warn", "opencode.config", "~/.config/opencode/opencode.jsonc is a symbolic link; toolgate does not read it, so its servers were not checked", "toolgate never follows a link: put the servers in a regular file"],
    ["warn", "opencode.config", "opencode.json is a symbolic link; toolgate does not read it, so its servers were not checked", "toolgate never follows a link: put the servers in a regular file"],
  ]);
});

test("without opencode on the PATH, its config is not checked", async () => {
  const { checks } = await report({ installed: false, project: { "opencode.json": { mcp: { plain: { type: "local", command: ["node"] } } } } });
  assert.deepEqual(findings(checks), []);
});
