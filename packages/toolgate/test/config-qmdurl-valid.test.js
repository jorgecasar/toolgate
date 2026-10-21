// router.qmdUrl decides where the task text is sent, so it must be an http or https URL with a host, or null (#236).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { mergeConfigLayers } from "../src/config.js";
import { applyChange, isQmdUrl } from "../src/configFile.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qu-")));
  made.push(dir);
  return dir;
};
const META = (tracked = false) => [{ name: "project" }, { name: "user" }, { name: "local", tracked: () => tracked }];
const TEXT = "router.qmdUrl must be an http or https URL, or null";
test("isQmdUrl: an http or https URL with a host is valid; nothing else is", () => {
  for (const good of ["http://localhost:8181/mcp", "https://qmd.example.com/mcp", "HTTP://Host/mcp", "https://u:p@h:9443/x?y=1#z", "http://[::1]:9/mcp", "http://10.0.0.5"]) assert.equal(isQmdUrl(good), true, good);
  for (const bad of ["file:///x", "ftp://h/", "ws://h/", "data:text/plain,x", "javascript:alert(1)", "http://", "qmd", "", " http://h/", "http://h/ ", "\thttp://h/", "http://h/\n", "http://h/\0", "http://h/\x7f", "http://ho st/", 5, null, undefined, {}, []]) assert.equal(isQmdUrl(bad), false, JSON.stringify(bad));
});
test("config set router.qmdUrl: the user and local layers take a valid URL or null and refuse the rest with the exact text; the project layer is refused first", () => {
  for (const layer of ["user", "local"]) {
    for (const good of ["https://qmd.example.com/mcp", null]) {
      const data = {};
      assert.equal(applyChange(data, { action: "set", key: "router.qmdUrl", value: good, layer }), true);
      assert.equal(data.router.qmdUrl, good);
    }
    for (const bad of ["file:///x", "ftp://h/", "javascript:alert(1)", "http://", " http://h/", "qmd", ""]) {
      const data = { router: { qmdUrl: "https://keep.example.com/mcp" } };
      assert.throws(() => applyChange(data, { action: "set", key: "router.qmdUrl", value: bad, layer }), { message: TEXT }, bad);
      assert.equal(data.router.qmdUrl, "https://keep.example.com/mcp", "the data is unchanged");
    }
  }
  assert.throws(() => applyChange({}, { action: "set", key: "router.qmdUrl", value: "file:///x", layer: "project" }), /^Error: router\.qmdUrl is ignored in the project layer \(.*\); use --user or --local$/);
});
test("config unset router.qmdUrl works on an invalid stored value", () => {
  const data = { router: { qmdUrl: "file:///x" } };
  assert.equal(applyChange(data, { action: "unset", key: "router.qmdUrl", layer: "user" }), true);
  assert.equal(Object.hasOwn(data.router ?? {}, "qmdUrl"), false);
});
test("merging: an invalid value from a trusted layer is dropped with reason invalid and the earlier valid one stays; a tracked local layer says tracked", () => {
  const merged = mergeConfigLayers([null, { router: { qmdUrl: "https://good.example.com/mcp" } }, { router: { qmdUrl: "file:///x" } }], META());
  assert.equal(merged.router.qmdUrl, "https://good.example.com/mcp");
  assert.deepEqual(merged.ignored, [{ key: "router.qmdUrl", layer: "local", reason: "invalid" }]);
  const alone = mergeConfigLayers([null, { router: { qmdUrl: "qmd" } }, null], META());
  assert.equal(Object.hasOwn(alone.router, "qmdUrl"), false);
  assert.deepEqual(alone.ignored, [{ key: "router.qmdUrl", layer: "user", reason: "invalid" }]);
  const nulled = mergeConfigLayers([null, { router: { qmdUrl: "https://good.example.com/mcp" } }, { router: { qmdUrl: null } }], META());
  assert.equal(nulled.router.qmdUrl, null);
  assert.equal(nulled.ignored, undefined);
  const tracked = mergeConfigLayers([null, null, { router: { qmdUrl: "file:///x" } }], META(true));
  assert.deepEqual(tracked.ignored.map((e) => e.reason), ["tracked"]);
});
test("route and doctor warn with the exact text for an invalid router.qmdUrl in the user file, and qmd.bin keeps its own text", async () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  fs.writeFileSync(path.join(cwd, ".toolgate", "config.json"), JSON.stringify({ defaultAgent: "claude-code", router: { backend: "regex" } }));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ router: { qmdUrl: "file:///x" }, qmd: { bin: "./relative" } }));
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const out = [];
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  const warnings = JSON.parse(out.join("")).warnings;
  assert.ok(warnings.includes("router.qmdUrl in the user config is ignored: it must be an http or https URL, or null"), warnings.join("\n"));
  assert.ok(warnings.includes("qmd.bin in the user config is ignored: it must be a command name or an absolute path"), warnings.join("\n"));
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const checks = JSON.parse(text.join("")).checks.filter((c) => c.id === "config.ignored");
  const url = checks.find((c) => c.message.startsWith("router.qmdUrl"));
  assert.equal(url.message, "router.qmdUrl in the user config is ignored: it must be an http or https URL, or null");
  assert.match(url.fix ?? url.hint ?? JSON.stringify(url), /toolgate config set router\.qmdUrl <http or https URL, or null> --user/);
  assert.ok(checks.some((c) => c.message === "qmd.bin in the user config is ignored: it must be a command name or an absolute path"));
});
