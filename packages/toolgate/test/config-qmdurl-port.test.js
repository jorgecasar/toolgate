// A router.qmdUrl on this machine must name its port (#236 T3): toolgate starts its daemon on 8181 for such a URL while the
// router would call port 80, 443 or 0.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { mergeConfigLayers } from "../src/config.js";
import { applyChange, invalidWhy, isQmdUrl, qmdUrlProblem } from "../src/configFile.js";
import { managedPort, remoteQmdOrigin } from "../src/daemon.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qp-")));
  made.push(dir);
  return dir;
};
const META = [{ name: "project" }, { name: "user" }, { name: "local", tracked: () => false }];
const TEXT = "router.qmdUrl on this machine must name its port, for example http://localhost:8181/mcp";
const GENERIC = "router.qmdUrl must be an http or https URL, or null";
const NO_PORT = ["http://localhost/mcp", "http://localhost", "http://127.0.0.1/mcp", "http://[::1]/mcp", "https://localhost/mcp", "http://localhost:0/mcp", "http://127.0.0.1:0", "http://localhost:80/mcp", "https://localhost:443/mcp"];
test("qmdUrlProblem: a local URL without a port or with port 0 is port; a bad URL is invalid; a named port and any remote URL are fine", () => {
  for (const value of NO_PORT) assert.equal(qmdUrlProblem(value), "port", value);
  for (const value of ["http://localhost:8181/mcp", "http://127.0.0.1:1/mcp", "http://[::1]:65535", "https://localhost:9443/x", "http://qmd.example.com/mcp", "https://10.0.0.5", "http://localhost.:80/mcp"]) assert.equal(qmdUrlProblem(value), null, value);
  for (const value of ["file:///x", "http://", "localhost:8181", "", " http://localhost/", null, 8181]) assert.equal(qmdUrlProblem(value), "invalid", String(value));
  assert.equal(isQmdUrl("http://localhost/mcp"), false);
});
test("config set router.qmdUrl refuses a local URL without a port with the exact text, in the user and local layers; other bad values keep the generic text", () => {
  for (const layer of ["user", "local"]) {
    for (const bad of NO_PORT) {
      const data = { router: { qmdUrl: "http://localhost:8181/mcp" } };
      assert.throws(() => applyChange(data, { action: "set", key: "router.qmdUrl", value: bad, layer }), { message: TEXT }, bad);
      assert.equal(data.router.qmdUrl, "http://localhost:8181/mcp");
    }
    assert.throws(() => applyChange({}, { action: "set", key: "router.qmdUrl", value: "ftp://localhost/", layer }), { message: GENERIC });
    assert.equal(applyChange({}, { action: "set", key: "router.qmdUrl", value: "http://localhost:8181/mcp", layer }), true);
    assert.equal(applyChange({}, { action: "set", key: "router.qmdUrl", value: "https://qmd.example.com/mcp", layer }), true);
  }
});
test("config unset works on a stored local URL without a port", () => {
  const data = { router: { qmdUrl: "http://localhost/mcp" } };
  assert.equal(applyChange(data, { action: "unset", key: "router.qmdUrl", layer: "user" }), true);
  assert.equal(Object.hasOwn(data.router ?? {}, "qmdUrl"), false);
});
test("merging: a local URL without a port is dropped with reason port and the earlier valid one stays; a bad URL keeps reason invalid", () => {
  const merged = mergeConfigLayers([null, { router: { qmdUrl: "http://localhost:9000/mcp" } }, { router: { qmdUrl: "http://localhost/mcp" } }], META);
  assert.equal(merged.router.qmdUrl, "http://localhost:9000/mcp");
  assert.deepEqual(merged.ignored, [{ key: "router.qmdUrl", layer: "local", reason: "port" }]);
  assert.deepEqual(mergeConfigLayers([null, { router: { qmdUrl: "http://[::1]:0" } }, null], META).ignored, [{ key: "router.qmdUrl", layer: "user", reason: "port" }]);
  assert.deepEqual(mergeConfigLayers([null, { router: { qmdUrl: "file:///x" } }, null], META).ignored, [{ key: "router.qmdUrl", layer: "user", reason: "invalid" }]);
  assert.equal(mergeConfigLayers([null, { router: { qmdUrl: "https://qmd.example.com/mcp" } }, null], META).ignored, undefined);
});
test("invalidWhy: the port reason has its own text, the default and qmd.bin keep theirs", () => {
  assert.equal(invalidWhy("router.qmdUrl", "port"), TEXT);
  assert.equal(invalidWhy("router.qmdUrl"), "it must be an http or https URL, or null");
  assert.equal(invalidWhy("qmd.bin", "port"), "it must be a command name or an absolute path");
});
test("route and doctor warn with the exact text for a hand-written local URL without a port, and use the managed daemon", async () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ defaultAgent: "claude-code", router: { backend: "regex" } }));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ router: { qmdUrl: "http://localhost/mcp" } }));
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const out = [];
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  const warnings = JSON.parse(out.join("")).warnings;
  assert.ok(warnings.includes(`router.qmdUrl in the user config is ignored: ${TEXT}`), warnings.join("\n"));
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const entry = JSON.parse(text.join("")).checks.find((c) => c.id === "config.ignored" && c.message.startsWith("router.qmdUrl"));
  assert.equal(entry.message, `router.qmdUrl in the user config is ignored: ${TEXT}`);
  assert.match(JSON.stringify(entry), /toolgate config set router\.qmdUrl <http or https URL, or null> --user/);
});
test("managedPort: a scheme that is not http or https is no managed daemon, like a remote or unparseable value", () => {
  for (const value of ["file:///x", "ftp://localhost:8181/", "ws://localhost:8181/", "data:text/plain,x", "javascript:alert(1)", "https://qmd.example.com/mcp", "not a url"]) assert.equal(managedPort({ router: { qmdUrl: value } }, {}), null, value);
  assert.equal(managedPort({ router: { qmdUrl: "http://localhost:9000/mcp" } }, {}), 9000);
  assert.equal(managedPort({ router: { qmdUrl: "https://127.0.0.1:9443/mcp" } }, {}), 9443);
});
test("remoteQmdOrigin: a scheme that is not http or https gives no origin even when the config reaches it without the merge", () => {
  for (const value of ["file:///x", "data:text/plain,x", "javascript:alert(1)", "ftp://qmd.example.com/", "ws://qmd.example.com/"]) assert.equal(remoteQmdOrigin({ router: { qmdUrl: value } }), null, value);
  assert.equal(remoteQmdOrigin({ router: { qmdUrl: "https://qmd.example.com:9443/mcp" } }), "https://qmd.example.com:9443");
});
