import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { applyChange } from "../src/configFile.js";
import { mergeConfigLayers } from "../src/config.js";
import { defaultDaemonUrl } from "../src/router.js";
import { managedPort } from "../src/daemon.js";

test("qmd.port is taken from the user and the untracked local layer, key by key, and the later layer wins", () => {
  const meta = [{ name: "project" }, { name: "user" }, { name: "local", tracked: () => false }];
  assert.deepEqual(mergeConfigLayers([null, { qmd: { port: 1111 } }, null], meta).qmd, { port: 1111 });
  assert.deepEqual(mergeConfigLayers([null, { qmd: { port: 1111 } }, { qmd: { port: 2222 } }], meta).qmd, { port: 2222 });
  assert.deepEqual(mergeConfigLayers([{}, {}, {}], meta).qmd, {});
  assert.equal(mergeConfigLayers([null, { qmd: { port: 1111 } }, { router: { minScore: 0.4 } }], meta).qmd.port, 1111, "another layer's router block does not wipe it");
});
test("qmd.port in the project layer, or in a local layer git versions, is ignored and said", () => {
  const meta = [{ name: "project" }, { name: "user" }, { name: "local", tracked: () => true }];
  const project = mergeConfigLayers([{ qmd: { port: 1111 } }, null, null], meta);
  assert.deepEqual(project.qmd, {});
  assert.deepEqual(project.ignored, [{ key: "qmd.port", layer: "project", reason: "project" }]);
  const tracked = mergeConfigLayers([null, { qmd: { port: 2222 } }, { qmd: { port: 3333 } }], meta);
  assert.equal(tracked.qmd.port, 2222, "the user's port survives");
  assert.deepEqual(tracked.ignored, [{ key: "qmd.port", layer: "local", reason: "tracked" }]);
});
test("the url the router and the catalog search use is on the port the daemon manages", () => {
  const config = { qmd: { port: 18282 } };
  assert.equal(defaultDaemonUrl({}, config), "http://localhost:18282/mcp");
  assert.equal(defaultDaemonUrl({ QMD_SHARED_PORT: "18283" }, config), "http://localhost:18283/mcp");
  assert.equal(defaultDaemonUrl({}), "http://localhost:8181/mcp");
  assert.equal(defaultDaemonUrl({}, config), `http://localhost:${managedPort(config, {})}/mcp`, "one function decides");
});
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qp-")));
  made.push(dir);
  return dir;
};
test("the refusal, the route warning and doctor use the exact texts for qmd.port", async () => {
  assert.throws(
    () => applyChange({}, { action: "set", key: "qmd.port", value: 18282, layer: "project" }),
    /^Error: qmd\.port is ignored in the project layer \(a repository must not choose which port toolgate manages\); use --user or --local$/,
  );
  assert.equal(applyChange({}, { action: "set", key: "qmd.port", value: 18282, layer: "user" }), true);
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ defaultAgent: "claude-code", router: { backend: "regex" }, qmd: { port: 18282 } }));
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const out = [];
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  assert.deepEqual(JSON.parse(out.join("")).warnings, ["qmd.port in the project config is ignored: a repository must not choose which port toolgate manages; set it in your user or local config"]);
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const finding = JSON.parse(text.join("")).checks.find((c) => c.id === "config.ignored");
  assert.match(finding.message, /qmd\.port in the project config is ignored: a repository must not choose which port toolgate manages/);
});
