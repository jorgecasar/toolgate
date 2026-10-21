// qmd.bin chooses which program toolgate runs, so only the user and an unversioned local layer may set it (#136).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { mergeConfigLayers } from "../src/config.js";
import { applyChange, isQmdBin, parseValueFor } from "../src/configFile.js";
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qb-")));
  made.push(dir);
  return dir;
};
const ABS = path.resolve("/opt/qmd/bin/qmd");
const META = (tracked = false) => [{ name: "project" }, { name: "user" }, { name: "local", tracked: () => tracked }];
test("a command name without a separator or an absolute path is a valid qmd.bin; nothing else is", () => {
  for (const good of ["qmd", "qmd-2", "~", "-x", "$(id)", ABS, path.resolve("/Applications/My App/qmd")]) assert.equal(isQmdBin(good), true, good);
  for (const bad of ["./qmd", "bin/qmd", "../qmd", "a\\b", ".", "..", "", " ", "q\nmd", "q\0md", "q\tmd", "q md", ABS + "\n", ABS + "\r", ABS + "\0", ABS + "\x1b", ABS + "\x7f", 5, null, undefined, {}]) assert.equal(isQmdBin(bad), false, JSON.stringify(bad));
  assert.equal(parseValueFor("qmd.bin", "set", ABS), ABS);
});
test("config set qmd.bin: user and local take it, the project layer and a relative path are refused with the exact texts", () => {
  for (const layer of ["user", "local"]) {
    const data = {};
    assert.equal(applyChange(data, { action: "set", key: "qmd.bin", value: ABS, layer }), true);
    assert.deepEqual(data.qmd, { bin: ABS });
  }
  assert.throws(
    () => applyChange({}, { action: "set", key: "qmd.bin", value: ABS, layer: "project" }),
    /^Error: qmd\.bin is ignored in the project layer \(a repository must not choose which program toolgate runs\); use --user or --local$/,
  );
  for (const layer of ["user", "local"]) {
    assert.throws(() => applyChange({}, { action: "set", key: "qmd.bin", value: "./bin/qmd", layer }), /^Error: qmd\.bin must be a command name or an absolute path$/);
  }
});
test("qmd.bin counts from the user and an unversioned local layer; the later layer wins and qmd.port stays on its own", () => {
  const merged = mergeConfigLayers([null, { qmd: { bin: "qmd-user", port: 18282 } }, { qmd: { bin: ABS } }], META());
  assert.deepEqual(merged.qmd, { bin: ABS, port: 18282 });
  assert.equal(merged.ignored, undefined);
});
test("qmd.bin in the project layer, in a local layer git versions, or as a relative path is dropped and recorded; the user's value survives", () => {
  const fromProject = mergeConfigLayers([{ qmd: { bin: ABS } }, { qmd: { bin: "qmd-user" } }, null], META());
  assert.deepEqual(fromProject.qmd, { bin: "qmd-user" });
  assert.deepEqual(fromProject.ignored, [{ key: "qmd.bin", layer: "project", reason: "project" }]);
  const tracked = mergeConfigLayers([null, { qmd: { bin: "qmd-user" } }, { qmd: { bin: ABS } }], META(true));
  assert.deepEqual(tracked.qmd, { bin: "qmd-user" });
  assert.deepEqual(tracked.ignored, [{ key: "qmd.bin", layer: "local", reason: "tracked" }]);
  const relative = mergeConfigLayers([null, { qmd: { bin: "./qmd", port: 18282 } }, null], META());
  assert.deepEqual(relative.qmd, { port: 18282 }, "the other key stays");
  assert.deepEqual(relative.ignored, [{ key: "qmd.bin", layer: "user", reason: "invalid" }]);
  assert.deepEqual(mergeConfigLayers([{ qmd: { bin: "./qmd" } }, null, null], META()).ignored, [{ key: "qmd.bin", layer: "project", reason: "project" }], "the project reason comes first");
});
test("route and doctor say it with the exact texts: project, versioned local, relative path in a file", async () => {
  const cwd = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  const write = (file, data) => fs.writeFileSync(path.join(cwd, ".toolgate", file), JSON.stringify(data));
  write("config.json", { defaultAgent: "claude-code", router: { backend: "regex" }, qmd: { bin: ABS } });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ qmd: { bin: "./relative" } }));
  const env = { TOOLGATE_DEFAULTS: path.join(home, "config.json"), HOME: home, PATH: "" };
  const out = [];
  await run(["route", "--prompt", "open a pull request"], { cwd, env, stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, catalog: { homedir: home } });
  const warnings = JSON.parse(out.join("")).warnings;
  assert.ok(warnings.includes("qmd.bin in the project config is ignored: a repository must not choose which program toolgate runs; set it in your user or local config"), warnings.join("\n"));
  assert.ok(warnings.includes("qmd.bin in the user config is ignored: it must be a command name or an absolute path"), warnings.join("\n"));
  const text = [];
  await run(["doctor", "--json"], { cwd, env, stdout: { write: (s) => text.push(s) }, stderr: { write: () => {} }, doctor: { homedir: home, execFn: () => "1", daemon: { status: async () => ({ running: false }) } } });
  const messages = JSON.parse(text.join("")).checks.filter((c) => c.id === "config.ignored").map((c) => c.message);
  assert.ok(messages.some((m) => /^qmd\.bin in the project config is ignored: a repository must not choose which program toolgate runs$/.test(m)), messages.join("\n"));
  assert.ok(messages.some((m) => /^qmd\.bin in the user config is ignored: it must be a command name or an absolute path$/.test(m)), messages.join("\n"));
});
