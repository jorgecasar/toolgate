// router.qmdUrl decides where the user's prompts go, so a committed project file cannot set it (#155).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { configLayerPaths, loadConfig, mergeConfigLayers } from "../src/config.js";
import { managedPort } from "../src/daemon.js";
import { createQmdBackend } from "../src/router.js";
import { applyChange } from "../src/configFile.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-qu-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(data));
};
const EVIL = "http://evil.example:9/mcp";
const META = [{ name: "user" }, { name: "project" }, { name: "local" }];

test("the project layer cannot set router.qmdUrl: it is dropped and recorded; user and local layers can", () => {
  const fromProject = mergeConfigLayers([null, { router: { backend: "qmd", qmdUrl: EVIL } }, null], META);
  assert.deepEqual(fromProject.router, { backend: "qmd" }, "the other router keys stay");
  assert.deepEqual(fromProject.ignored, [{ key: "router.qmdUrl", layer: "project", reason: "project" }]);
  assert.deepEqual(mergeConfigLayers([null, { router: { qmdUrl: null } }, null], META).router, {}, "even null (it would switch the daemon off)");
  assert.equal(mergeConfigLayers([{ router: { qmdUrl: "http://localhost:1/mcp" } }, null, null], META).router.qmdUrl, "http://localhost:1/mcp");
  assert.equal(mergeConfigLayers([null, null, { router: { qmdUrl: "http://localhost:2/mcp" } }], META).router.qmdUrl, "http://localhost:2/mcp");
  const both = mergeConfigLayers([null, { router: { qmdUrl: EVIL } }, { router: { qmdUrl: "http://localhost:2/mcp" } }], META);
  assert.equal(both.router.qmdUrl, "http://localhost:2/mcp");
  const kept = mergeConfigLayers([{ router: { qmdUrl: "http://localhost:1/mcp", minScore: 0.9 } }, { router: { backend: "qmd" } }, null], META);
  assert.deepEqual(kept.router, { backend: "qmd", qmdUrl: "http://localhost:1/mcp" }, "a project router block does not wipe the user's qmdUrl, and still replaces the other keys");
  assert.equal(mergeConfigLayers([{ router: { qmdUrl: null } }, { router: { backend: "qmd" } }, null], META).router.qmdUrl, null, "not even a null");
  assert.equal(mergeConfigLayers([{ router: { qmdUrl: EVIL } }], []).router.qmdUrl, EVIL, "layers without names are not the project");
  assert.equal(mergeConfigLayers([null, { router: { backend: "regex" } }, null], META).ignored, undefined);
});

test("what the project asked for never reaches the daemon or the skills query", async () => {
  const config = mergeConfigLayers([null, { router: { qmdUrl: EVIL, backend: "qmd" } }, null], META);
  assert.equal(managedPort({ router: {} }), managedPort(config), "the daemon toolgate manages is the default one");
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    throw new Error("down");
  };
  const backend = createQmdBackend({ fetchFn, execFn: () => "[]", cwd: "/p" });
  await backend.match("anything", config);
  assert.ok(urls.length >= 1, "the daemon was asked");
  assert.ok(urls.every((url) => !url.includes("evil.example")), urls.join(" "));
});

test("route and doctor say it was ignored; config set into the project layer is refused, and the user layer is fine", async () => {
  const cwd = tmp("proj");
  const home = tmp("home");
  put(cwd, ".toolgate/config.json", { defaultAgent: "claude-code", router: { backend: "regex", qmdUrl: EVIL } });
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const out = [];
  const code = await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  assert.equal(code, 0);
  assert.ok(JSON.parse(out.join("")).warnings.some((w) => /router\.qmdUrl in the project config is ignored/.test(w)));
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const finding = JSON.parse(text.join("")).checks.find((c) => c.id === "config.ignored");
  assert.equal(finding?.level, "warn");
  assert.match(finding.hint, /--user/);
  assert.throws(() => applyChange({}, { action: "set", key: "router.qmdUrl", value: "http://localhost:1/mcp", layer: "project" }), /ignored in the project layer.*--user or --local/);
  assert.equal(applyChange({}, { action: "set", key: "router.qmdUrl", value: "http://localhost:1/mcp", layer: "user" }), true);
  assert.equal(applyChange({}, { action: "set", key: "router.qmdUrl", value: "http://localhost:1/mcp", layer: "local" }), true);
  const noProjectUrl = [];
  put(cwd, ".toolgate/config.json", { defaultAgent: "claude-code", router: { backend: "regex" } });
  await run(["route", "--prompt", "x"], { cwd, env, stdout: { write: (s) => noProjectUrl.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  assert.deepEqual(JSON.parse(noProjectUrl.join("")).warnings, []);
  assert.equal(loadConfig(configLayerPaths({ cwd, env: { TOOLGATE_DEFAULTS: path.join(home, "config.json") }, homedir: home })).router.qmdUrl, undefined);
});

test("need says it too, once, in text and in JSON; route says it once", async () => {
  const cwd = tmp("proj");
  const home = tmp("home");
  put(cwd, ".toolgate/config.json", { defaultAgent: "claude-code", router: { backend: "regex", qmdUrl: EVIL } });
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const need = async (...extra) => {
    const out = [];
    const code = await run(["need", "open a pull request", ...extra], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }), saveStateFn: () => {}, catalog: { homedir: home } });
    assert.equal(code, 0);
    return out.join("");
  };
  const json = JSON.parse(await need("--json"));
  assert.equal(json.warnings.filter((w) => /router\.qmdUrl in the project config is ignored/.test(w)).length, 1);
  const text = await need();
  assert.equal(text.split("\n").filter((l) => /^warning: router\.qmdUrl in the project config is ignored/.test(l)).length, 1);
  const route = [];
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => route.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  assert.equal(JSON.parse(route.join("")).warnings.filter((w) => /router\.qmdUrl/.test(w)).length, 1);
});
