import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";

function project(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-cli-config-"));
  fs.mkdirSync(path.join(cwd, ".toolgate"));
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(cwd, ".toolgate", name), typeof value === "string" ? value : JSON.stringify(value));
  }
  const defaults = path.join(cwd, "defaults.json");
  fs.writeFileSync(defaults, JSON.stringify({ baseline: ["docs"], keywords: { repo: ["pull request"] } }));

  const out = [];
  const err = [];
  return {
    out: () => out.join(""),
    err: () => err.join(""),
    deps: {
      cwd,
      env: { TOOLGATE_DEFAULTS: defaults },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
    },
  };
}

test("config print --json shows the resolved config and the origin of each key", async () => {
  const t = project({
    "config.json": { keywords: { repo: ["merge"] } },
    "config.local.json": { baseline: ["repo"] },
  });
  assert.equal(await run(["config", "print", "--json"], t.deps), 0);
  const { config, origins, layers } = JSON.parse(t.out());
  assert.deepEqual(config.baseline, ["repo"]);
  assert.deepEqual(config.keywords.repo, ["pull request", "merge"]);
  assert.deepEqual(origins.baseline, ["user", "local"]);
  assert.deepEqual(origins["keywords.repo"], ["user", "project"]);
  assert.deepEqual(
    layers.map((layer) => layer.name),
    ["user", "project", "local"]
  );
});

test("config print lists the layers and origins as text, and warns about a malformed layer", async () => {
  const t = project({ "config.json": "{ nope" });
  assert.equal(await run(["config", "print"], t.deps), 0);
  assert.match(t.out(), /^# user: .*defaults\.json$/m);
  assert.match(t.out(), /^baseline\tuser$/m);
  assert.match(t.err(), /ignoring project layer .*config\.json/);
});

test("config without a known action exits 1", async () => {
  const t = project({});
  assert.equal(await run(["config", "bogus"], t.deps), 1);
  assert.match(t.err(), /expected print, set, unset, add or remove/);
});

const readJson = (t, file) => JSON.parse(fs.readFileSync(path.join(t.deps.cwd, file), "utf8"));
const exists = (t, file) => fs.existsSync(path.join(t.deps.cwd, file));

test("config set writes the project layer by default and --local writes the local one", async () => {
  const t = project({});
  assert.equal(await run(["config", "set", "router.backend", "regex"], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.json"), { router: { backend: "regex" } });
  assert.match(t.out(), /set router\.backend in the project layer \(.*config\.json\)/);

  assert.equal(await run(["config", "set", "router.backend", "qmd", "--local"], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.local.json"), { router: { backend: "qmd" } });
  assert.deepEqual(readJson(t, ".toolgate/config.json"), { router: { backend: "regex" } }, "project untouched");
});

test("config set --user writes the file TOOLGATE_DEFAULTS points at and keeps its other keys", async () => {
  const t = project({});
  assert.equal(await run(["config", "set", "router.minScore", "0.7", "--user"], t.deps), 0);
  assert.deepEqual(readJson(t, "defaults.json"), {
    baseline: ["docs"],
    keywords: { repo: ["pull request"] },
    router: { minScore: 0.7 },
  });
  assert.ok(!exists(t, ".toolgate/config.json"));
});

test("config add and remove edit lists, and a repeated command says nothing changed", async () => {
  const t = project({});
  assert.equal(await run(["config", "add", "skills.sources", '{"dir":"team-skills"}'], t.deps), 0);
  assert.match(t.out(), /add skills\.sources/);
  assert.deepEqual(readJson(t, ".toolgate/config.json"), { skills: { sources: [{ dir: "team-skills" }] } });

  const before = fs.readFileSync(path.join(t.deps.cwd, ".toolgate", "config.json"), "utf8");
  assert.equal(await run(["config", "add", "skills.sources", '{"dir":"team-skills"}'], t.deps), 0);
  assert.match(t.out(), /unchanged skills\.sources in the project layer/);
  assert.equal(fs.readFileSync(path.join(t.deps.cwd, ".toolgate", "config.json"), "utf8"), before);

  assert.equal(await run(["config", "remove", "skills.sources", '{"dir":"team-skills"}'], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.json"), {}, "the emptied block is removed, not left as {}");
});

test("config unset removes a key and a value with spaces stays one argument", async () => {
  const t = project({ "config.json": { router: { backend: "qmd" }, keywords: { repo: ["pull request"] } } });
  assert.equal(await run(["config", "add", "keywords.repo", "code review"], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.json").keywords.repo, ["pull request", "code review"]);
  assert.equal(await run(["config", "unset", "keywords.repo"], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.json"), { router: { backend: "qmd" } });
});

test("a config change shows up in config print with the layer it came from", async () => {
  const t = project({ "config.json": { router: { backend: "regex" } } });
  assert.equal(await run(["config", "set", "router.backend", "qmd", "--local"], t.deps), 0);
  assert.equal(await run(["config", "print", "--json"], t.deps), 0);
  const printed = JSON.parse(t.out().slice(t.out().indexOf("{\n  \"config\"")));
  assert.equal(printed.config.router.backend, "qmd");
  assert.deepEqual(printed.origins.router, ["project", "local"]);
});

test("config edit mistakes exit 1 with a message and write nothing", async () => {
  const t = project({});
  const fail = async (args, pattern) => {
    assert.equal(await run(["config", ...args], t.deps), 1, args.join(" "));
    assert.match(t.err(), pattern);
  };
  await fail(["set"], /usage: toolgate config set <key> <value>/);
  await fail(["set", "router.backend"], /usage: toolgate config set <key> <value>/);
  await fail(["set", "router.backend", "qmd", "extra"], /usage/);
  await fail(["unset"], /usage: toolgate config unset <key>/);
  await fail(["unset", "router.backend", "qmd"], /usage: toolgate config unset <key>/);
  await fail(["set", "router.backend", "qmd", "--user", "--local"], /choose one of --user and --local/);
  await fail(["set", "router.backend", "elasticsearch"], /router\.backend: expected one of "qmd", "regex"/);
  await fail(["set", "router.backnd", "qmd"], /not a key toolgate manages/);
  await fail(["add", "router.backend", "qmd"], /not a list/);
  await fail(["set", "skills.userLevel", "false", "--local"], /only counts in the project layer/);
  assert.ok(!exists(t, ".toolgate/config.json") && !exists(t, ".toolgate/config.local.json"));
});

test("config set leaves an unparsable file exactly as it was and names it", async () => {
  const t = project({ "config.json": "{ nope" });
  assert.equal(await run(["config", "set", "router.backend", "qmd"], t.deps), 1);
  assert.match(t.err(), /config\.json is not valid JSON and was left untouched/);
  assert.equal(fs.readFileSync(path.join(t.deps.cwd, ".toolgate", "config.json"), "utf8"), "{ nope");
});

test("config manages the commands block like the skills one: sources with a dialect, and the project-only switches", async () => {
  const t = project({});
  assert.equal(await run(["config", "add", "commands.sources", '{"dir":"cmds","dialect":"opencode"}'], t.deps), 0);
  assert.deepEqual(readJson(t, ".toolgate/config.json"), { commands: { sources: [{ dir: "cmds", dialect: "opencode" }] } });
  assert.equal(await run(["config", "set", "commands.userLevel", "false"], t.deps), 0);
  assert.equal(await run(["config", "add", "commands.sources", '{"dir":"x","nope":1}'], t.deps), 1);
  assert.equal(await run(["config", "set", "commands.localLevel", "false", "--user"], t.deps), 1);
});
test("config set defaultAgent: a registered adapter is accepted in any layer, an unknown name is refused and writes nothing", async () => {
  const t = project({});
  assert.equal(await run(["config", "set", "defaultAgent", "claude-code", "--local"], t.deps), 0, t.err());
  assert.equal(readJson(t, ".toolgate/config.local.json").defaultAgent, "claude-code");
  assert.equal(await run(["config", "set", "defaultAgent", "codex"], t.deps), 0, t.err());
  assert.equal(readJson(t, ".toolgate/config.json").defaultAgent, "codex");
  const before = JSON.stringify(readJson(t, ".toolgate/config.local.json"));
  assert.equal(await run(["config", "set", "defaultAgent", "emacs", "--local"], t.deps), 1);
  assert.match(t.err(), /defaultAgent: expected one of "claude-code"[\s\S]*got "emacs"/);
  assert.equal(JSON.stringify(readJson(t, ".toolgate/config.local.json")), before);
  assert.equal(await run(["config", "unset", "defaultAgent", "--local"], t.deps), 0);
  assert.equal(readJson(t, ".toolgate/config.local.json").defaultAgent, undefined);
});
test("config unset removes a sensitive key a repository put in the project config; set and add stay refused there", async () => {
  const t = project({ "config.json": { router: { qmdUrl: "https://evil.example/mcp", backend: "qmd" }, rule: { template: "evil.md" }, skills: { allowedHosts: ["evil.example"] } } });
  const file = path.join(t.deps.cwd, ".toolgate", "config.json");
  assert.equal(await run(["config", "set", "router.qmdUrl", "null"], t.deps), 1);
  assert.match(t.err(), /router\.qmdUrl is ignored in the project layer/);
  for (const key of ["router.qmdUrl", "rule.template", "skills.allowedHosts"]) assert.equal(await run(["config", "unset", key], t.deps), 0, key);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { router: { backend: "qmd" } }, "only the sensitive keys went");
});
const originsOf = (text) => Object.fromEntries(text.split("# origins\n")[1].trim().split("\n").map((line) => line.split("\t")));
test("config print (text) does not say a layer contributed a key it was not trusted with: it is marked (ignored), alone on its line", async () => {
  const t = project({ "config.json": { qmd: { port: 9 }, router: { backend: "qmd", qmdUrl: "https://evil.example/mcp" }, baseline: ["repo"] } });
  assert.equal(await run(["config", "print"], t.deps), 0);
  const origins = originsOf(t.out());
  assert.equal(origins.qmd, "project (ignored)", "everything the layer had under qmd was dropped");
  assert.equal(origins["qmd.port"], "project (ignored)");
  assert.equal(origins.router, "project", "it still contributed router.backend");
  assert.equal(origins["router.qmdUrl"], "project (ignored)");
  assert.equal(origins.baseline, "user, project", "an ordinary key is untouched");
});
test("config print (text): a trusted layer's invalid value is marked too, and a valid one is not", async () => {
  const t = project({ "config.local.json": { router: { qmdUrl: "not a url" } } });
  assert.equal(await run(["config", "print"], t.deps), 0);
  assert.equal(originsOf(t.out())["router.qmdUrl"], "local (ignored)");
  const ok = project({ "config.local.json": { router: { qmdUrl: "https://qmd.example/mcp" } } });
  assert.equal(await run(["config", "print"], ok.deps), 0);
  const origins = originsOf(ok.out());
  assert.equal(origins.router, "local");
  assert.equal(origins["router.qmdUrl"], undefined);
});
test("config print --json is exactly what it was: plain origins, no suffix, no extra entry, no new field (byte for byte against main)", async () => {
  const t = project({
    "config.json": { qmd: { port: 9 }, router: { backend: "qmd", qmdUrl: "https://evil.example/mcp" }, baseline: ["repo"] },
    "config.local.json": { router: { qmdUrl: "not a url" } },
  });
  assert.equal(await run(["config", "print", "--json"], t.deps), 0);
  const cwd = t.deps.cwd;
  // The output of the same files on main, with the temporary folder written as <DIR>/p (both spellings of it).
  const normalized = t.out().split(fs.realpathSync(cwd)).join("<DIR>/p").split(cwd).join("<DIR>/p");
  assert.equal(normalized, fs.readFileSync(new URL("./fixtures/config-print-json.main.json", import.meta.url), "utf8"));
  assert.doesNotMatch(t.out(), /\(ignored\)/);
});
