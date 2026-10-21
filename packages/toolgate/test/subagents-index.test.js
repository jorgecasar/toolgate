// Subagents in the shared index: cards of their own kind, the corpus around them, search, route, need and the Step 0 rule.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { corpusDocCount } from "../src/daemonFreshness.js";
import { formatNeed, resolveNeed } from "../src/need.js";
import { createQmdBackend, registerBackend, resetBackends, route, withoutCollection } from "../src/router.js";
import { CARD_MARKER, SUBAGENTS_DIR, assertCorpusLocation, parseCard, renderIndex, staleCards, writeCorpus } from "../src/skills/corpus.js";
import { fingerprint, syncCollection } from "../src/skills/collection.js";
import { scanCommands, scanSkills, scanSubagents } from "../src/skills/scan.js";
import { searchSkills } from "../src/skills/search.js";

beforeEach(() => resetBackends());
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-subidx-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};
const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
const commandMd = (description) => `---\ndescription: ${description}\n---\nDo it.\n`;
const agentMd = (description, extra = "") => `---\ndescription: ${description}\n${extra}---\nYou are a specialist.\n`;

function project() {
  const root = tmp("proj");
  put(root, "skills/review/SKILL.md", skillMd("review", "Review code changes"));
  put(root, "commands/review.md", commandMd("Review a pull request by number"));
  put(root, "subagents/review.md", agentMd("Reviews pull requests in depth", "tools: Read, Grep\nmcps: [github]\n"));
  put(root, "subagents/scout.md", agentMd("Scouts the codebase"));
  return {
    root,
    sources: [{ dir: path.join(root, "skills") }],
    commandSources: [{ dir: path.join(root, "commands") }],
    subagentSources: [{ dir: path.join(root, "subagents") }],
  };
}

test("scanSubagents: reads every .md, carries the tools each gets, resolves levels like commands", () => {
  const { subagentSources } = project();
  const found = scanSubagents(subagentSources);
  assert.deepEqual(found.map((s) => [s.name, s.effectiveTools, s.toolsDefault]), [["review", ["Read", "Grep"], false], ["scout", ["Read", "Grep", "Glob"], true]]);
  const user = tmp("user");
  put(user, "scout.md", agentMd("Personal scout"));
  assert.deepEqual(scanSubagents([...subagentSources, { dir: user, level: "user" }]).find((s) => s.name === "scout").shadows, ["user"]);
  assert.deepEqual(scanSubagents([]), []);
  assert.throws(() => scanSubagents([{ dir: user, level: "nope" }]), /unknown subagents level/);
});

test("writeCorpus: a subagent, a command and a skill with one name get three cards, and the cards say what they are", () => {
  const { sources, commandSources, subagentSources } = project();
  const corpus = path.join(tmp("corpus"), "corpus");
  const items = [...scanSkills(sources), ...scanCommands(commandSources), ...scanSubagents(subagentSources)];
  writeCorpus(items, corpus);
  for (const card of ["review.md", "commands/review.md", "subagents/review.md", "subagents/scout.md", "_index.md"]) assert.ok(fs.existsSync(path.join(corpus, card)), card);
  const skillCard = fs.readFileSync(path.join(corpus, "review.md"), "utf8");
  const card = fs.readFileSync(path.join(corpus, "subagents/review.md"), "utf8");
  assert.match(card, /- Kind: subagent\n- Tools: Read, Grep\n- Level: project\n/);
  assert.doesNotMatch(card, /Tools default/);
  assert.match(fs.readFileSync(path.join(corpus, "subagents/scout.md"), "utf8"), /- Tools: Read, Grep, Glob\n- Tools default: yes\n/);
  assert.doesNotMatch(skillCard, /Kind:|Tools:/, "skill cards are unchanged");
  assert.deepEqual([parseCard(card).kind, parseCard(card).tools, parseCard(card).toolsDefault, parseCard(card).mcps], ["subagent", ["Read", "Grep"], false, ["github"]]);
  assert.deepEqual([parseCard(skillCard).kind, parseCard(skillCard).tools], ["skill", undefined]);
  assert.match(renderIndex(items), /\*\*review\*\* — Reviews pull requests in depth \| level: project \| kind: subagent \|/);
  assert.equal(corpusDocCount(corpus), 5); // the skill card, the command card, two subagent cards and the catalog
});

test("the corpus around the subagent cards: stale cards are listed, only toolgate's own cards are removed, a file or a link called subagents is handled", () => {
  const { sources, subagentSources } = project();
  const corpus = path.join(tmp("corpus"), "corpus");
  writeCorpus([...scanSkills(sources), ...scanSubagents(subagentSources)], corpus);
  assert.deepEqual(staleCards(corpus), []);
  put(corpus, "subagents/old.md", "# old\n\nwithout the marker\n");
  assert.deepEqual(staleCards(corpus), ["subagents/old.md"]);

  put(corpus, "subagents/mine.md", "my own notes, not a card\n");
  writeCorpus(scanSkills(sources), corpus);
  assert.ok(fs.existsSync(path.join(corpus, "subagents/mine.md")), "a file of the user's in subagents/ stays");
  assert.ok(!fs.existsSync(path.join(corpus, "subagents/review.md")), "toolgate's own subagent cards are removed on rebuild");

  const filed = path.join(tmp("corpus"), "corpus");
  put(filed, "subagents", "a file");
  assert.throws(() => writeCorpus(scanSkills(sources), filed), /subagents is a file; refusing to use/);

  const linked = path.join(tmp("corpus"), "corpus");
  const outside = tmp("outside");
  put(outside, "keep.md", `${CARD_MARKER}\n# keep\n`);
  fs.mkdirSync(linked, { recursive: true });
  fs.symlinkSync(outside, path.join(linked, SUBAGENTS_DIR));
  writeCorpus(scanSkills(sources), linked);
  assert.ok(fs.existsSync(path.join(outside, "keep.md")), "a link is removed, never followed");
  assert.ok(!fs.existsSync(path.join(linked, SUBAGENTS_DIR)));
});

test("the corpus folder cannot be, hold or sit inside the subagents store or its lock", () => {
  const root = tmp("own");
  for (const bad of [".toolgate/subagents", ".toolgate/subagents/x", ".toolgate/subagents.lock.json"]) {
    assert.throws(() => assertCorpusLocation(path.join(root, bad), root), /overlaps .*which toolgate keeps for something else/, bad);
  }
  assert.doesNotThrow(() => assertCorpusLocation(path.join(root, ".toolgate/skills-index/corpus"), root));
});

test("fingerprint and syncCollection: subagent sources are part of the index, a project with subagents only still indexes, and one without any keeps its old fingerprint", () => {
  const { root, sources, commandSources, subagentSources } = project();
  const calls = [];
  const execFn = (bin, args) => {
    calls.push(args.join(" "));
    if (args[1] === "show") return `Path: ${path.join(root, "corpus")}`;
    return "";
  };
  const without = fingerprint(sources, execFn, commandSources);
  assert.equal(fingerprint(sources, execFn, commandSources, [], undefined, []), without, "no subagent source: nothing changes");
  const withAgents = fingerprint(sources, execFn, commandSources, [], undefined, subagentSources);
  assert.notEqual(withAgents, without);
  assert.notEqual(fingerprint(sources, execFn, commandSources, [], undefined, subagentSources.map((s) => ({ ...s, dialect: "opencode" }))), withAgents);

  const options = { sources, commandSources, subagentSources, corpusDir: path.join(root, "corpus"), stateFile: path.join(root, "state.json"), collection: "c", execFn };
  assert.deepEqual(syncCollection(options), { indexed: true, count: 4, commands: 1, subagents: 2 });
  assert.deepEqual(syncCollection(options), { indexed: false, count: 4, commands: 1, subagents: 2 });
  put(root, "subagents/new.md", agentMd("Something new"));
  assert.deepEqual(syncCollection(options), { indexed: true, count: 5, commands: 1, subagents: 3 });

  const only = { subagentSources, sources: [], commandSources: [], corpusDir: path.join(root, "corpus2"), stateFile: path.join(root, "state2.json"), collection: "d", execFn };
  assert.deepEqual(syncCollection(only), { indexed: true, count: 3, commands: 0, subagents: 3 });
  assert.throws(() => syncCollection({ ...options, projectDir: root, corpusDir: path.join(root, ".toolgate", "x", "..", "..", "subagents") }), /must be a folder inside/);
});

test("search: --kind subagent over the catalog (fallback) and over qmd hits", () => {
  const { sources, commandSources, subagentSources } = project();
  const corpus = path.join(tmp("corpus"), "corpus");
  writeCorpus([...scanSkills(sources), ...scanCommands(commandSources), ...scanSubagents(subagentSources)], corpus);
  const failing = () => {
    throw new Error("no qmd");
  };
  const all = searchSkills("review pull requests", { corpusDir: corpus, collection: "c", execFn: failing });
  assert.equal(all.source, "fallback");
  assert.deepEqual(all.results.map((r) => r.kind).sort(), ["command", "skill", "subagent"]);
  const only = searchSkills("review pull requests", { corpusDir: corpus, collection: "c", execFn: failing, kind: "subagent" });
  assert.deepEqual(only.results.map((r) => [r.name, r.kind]), [["review", "subagent"]]);
  assert.throws(() => searchSkills("x", { corpusDir: corpus, collection: "c", kind: "agent" }), /--kind must be skill, command, subagent, all/);

  const qmd = JSON.stringify([
    { file: "qmd://c/subagents/review.md", score: 0.9 },
    { file: "qmd://c/commands/review.md", score: 0.8 },
    { file: "qmd://c/review.md", score: 0.7 },
  ]);
  const found = searchSkills("review", { corpusDir: corpus, collection: "c", execFn: () => qmd, kind: "subagent" });
  assert.equal(found.source, "qmd");
  assert.deepEqual(found.results.map((r) => [r.name, r.kind]), [["review", "subagent"]]);
});

const CORPUS = "/repo/.toolgate/skills-index/corpus";
const SKILL_CARD = (name, path_) => `${CARD_MARKER}\n# ${name}\n\nA skill.\n\n- Tags: none\n- Required MCPs: none\n- Level: project\n- Path: ${path_}\n`;
const COMMAND_CARD = (name, path_) => `${CARD_MARKER}\n# ${name}\n\nA command.\n\n- Tags: none\n- Required MCPs: none\n- Kind: command\n- Level: project\n- Path: ${path_}\n`;
const SUBAGENT_CARD = (name, path_, { mcps = "none", tools = "Read, Grep", isDefault = false, level = "project" } = {}) =>
  `${CARD_MARKER}\n# ${name}\n\nA subagent.\n\n- Tags: none\n- Required MCPs: ${mcps}\n- Kind: subagent\n- Tools: ${tools}\n${isDefault ? "- Tools default: yes\n" : ""}- Level: ${level}\n- Path: ${path_}\n`;
const backendOf = (hits, cards) =>
  createQmdBackend({
    daemonUrl: null,
    cwd: "/repo",
    execFn: () => JSON.stringify(hits),
    readFn: (file) => {
      if (cards[file] === undefined) throw new Error(`ENOENT ${file}`);
      return cards[file];
    },
  });
const config = { skills: { collection: "skills" }, baseline: [], serverMeta: { github: { tier: "expensive", install: "npx github-mcp" } } };

test("route: a subagent is returned apart from a skill and a command with the same name, with its tools and servers", async () => {
  registerBackend(
    "qmd",
    backendOf(
      [
        { file: "skills/review.md", score: 0.9 },
        { file: "skills/commands/review.md", score: 0.8 },
        { file: "skills/subagents/review.md", score: 0.7 },
      ],
      {
        [`${CORPUS}/review.md`]: SKILL_CARD("review", "/abs/review/SKILL.md"),
        [`${CORPUS}/commands/review.md`]: COMMAND_CARD("review", "/abs/commands/review.md"),
        [`${CORPUS}/subagents/review.md`]: SUBAGENT_CARD("review", "/abs/subagents/review.md", { mcps: "github", isDefault: true, tools: "Read, Grep, Glob" }),
      },
    ),
  );
  const result = await route("review", config, { backend: "qmd" });
  assert.deepEqual(result.skills.map((s) => s.path), ["/abs/review/SKILL.md"]);
  assert.deepEqual(result.commands.map((c) => c.path), ["/abs/commands/review.md"]);
  assert.deepEqual(result.subagents.map((s) => [s.name, s.path, s.tools, s.toolsDefault]), [["review", "/abs/subagents/review.md", ["Read", "Grep", "Glob"], true]]);
  assert.deepEqual(result.servers, ["github"], "the servers a subagent needs are asked for like any other asset's");
});

test("route: nothing for subagents without them in the corpus, a binding, a card of another kind, a nested path or a reserved name", async () => {
  registerBackend("qmd", backendOf([{ file: "skills/pdf.md", score: 0.8 }], { [`${CORPUS}/pdf.md`]: SKILL_CARD("pdf", "/abs/pdf/SKILL.md") }));
  assert.deepEqual((await route("pdf", config, { backend: "qmd" })).subagents, [], "an index from before subagents");

  registerBackend(
    "qmd",
    backendOf(
      [
        { file: "skills/subagents/command-card.md", score: 0.9 },
        { file: "skills/subagents/deep/nested.md", score: 0.9 },
        { file: "skills/subagents/index.md", score: 0.9 },
        { file: "skills/subagents/gone.md", score: 0.9 },
        { file: "skills/subagents/../review.md", score: 0.9 },
      ],
      {
        [`${CORPUS}/subagents/command-card.md`]: COMMAND_CARD("command-card", "/abs/x.md"),
        [`${CORPUS}/subagents/index.md`]: SUBAGENT_CARD("index", "/abs/index.md"),
      },
    ),
  );
  const result = await route("anything", config, { backend: "qmd" });
  assert.deepEqual(result.subagents, [], "a valid card called index (the catalog's name) is not returned either");
  assert.match(result.reason, /subagent card subagents\/command-card\.md is not a subagent card/);
  assert.match(result.reason, /subagents card subagents\/gone\.md unreadable|subagent card subagents\/gone\.md unreadable/);
  assert.match(result.warnings.join(" "), /unreadable/);

  registerBackend("qmd", backendOf([{ file: "skills/subagents/s.md", score: 0.9 }], { [`${CORPUS}/subagents/s.md`]: SUBAGENT_CARD("s", "/abs/s.md") }));
  const bound = await route("deploy now", { ...config, router: { bindings: [{ pattern: "deploy", servers: [] }] } }, { backend: "qmd" });
  assert.deepEqual(bound.subagents, []);
});

test("need: a subagent is listed as not registered, with the tools it would get, and hostile card text is printed cleaned", () => {
  const routed = {
    servers: [],
    alwaysOn: [],
    missing: [],
    skills: [],
    commands: [],
    subagents: [{ name: "review", path: "/p", tools: ["Read", "Grep\u001b[31m"], toolsDefault: true, score: 0.7, description: "does reviews" }],
    warnings: [],
    binding: null,
  };
  const { result } = resolveNeed(routed, { state: { extras: [], toolExtras: {}, pendingRestart: false }, adapter: { capability: { subagents: { kind: "launchFlag", flag: "--agents" } } } });
  assert.deepEqual(result.subagents.map((s) => [s.name, s.toolsDefault]), [["review", true]]);
  const text = formatNeed(result);
  assert.match(text, /^subagent review: registered at the next launch, not in this session \(tools it would get: Read, Grep\\u001b\[31m, the read-only default\) - does reviews$/m);
  assert.doesNotMatch(text, /\u001b/);
  assert.deepEqual(resolveNeed({ ...routed, subagents: undefined }, { state: { extras: [], toolExtras: {}, pendingRestart: false } }).result.subagents, []);
});

function cli(files = {}) {
  const cwd = tmp("cli");
  const home = tmp("home");
  for (const [file, text] of Object.entries(files)) put(cwd, file, text);
  const calls = [];
  const execFn = (bin, args) => {
    calls.push([bin, ...args].join(" "));
    if (args[1] === "show") return `Path: ${path.join(cwd, ".toolgate/skills-index/corpus")}`;
    if (args[0] === "query") return JSON.stringify([{ file: "qmd://x/subagents/scout.md", score: 0.9 }]);
    return "";
  };
  const exec = async (args) => {
    const out = [];
    const err = [];
    const code = await run(args, {
      cwd,
      env: { HOME: home, TOOLGATE_DEFAULTS: path.join(home, ".config/toolgate/config.json") },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      loadConfigFn: () => ({}),
      daemon: { status: async () => ({ running: false }) },
      skills: { execFn },
    });
    return { code, out: out.join(""), err: err.join(""), calls };
  };
  return { cwd, exec };
}

test("toolgate subagents index and search, and import reindexes with the subagents counted", async () => {
  const t = cli({ ".claude/agents/scout.md": agentMd("Scouts the codebase"), ".toolgate/skills/review/SKILL.md": skillMd("review", "Review code changes") });
  const imported = await t.exec(["subagents", "import"]);
  assert.equal(imported.code, 0);
  assert.match(imported.out, /toolgate: skills index has 1 skill and 1 subagent/);
  const index = await t.exec(["subagents", "index"]);
  assert.match(index.out, /skills index up to date \(2\)/);
  const search = await t.exec(["subagents", "search", "scout", "the", "codebase"]);
  assert.match(search.out, /^scout\t/m);
  assert.ok(fs.existsSync(path.join(t.cwd, ".toolgate/skills-index/corpus/subagents/scout.md")));
  const skillsSearch = await t.exec(["skills", "search", "scout", "--kind", "subagent"]);
  assert.match(skillsSearch.out, /^scout\t/m);
  assert.match((await t.exec(["--help"])).out, /toolgate subagents <install\|update\|status\|import\|list\|index\|search>/);
});

test("route: the CLI fallback of qmd may report the path of a card relative to the project (./.toolgate/...) or absolute; the kind is still found", async () => {
  const cards = {
    [`${CORPUS}/review.md`]: SKILL_CARD("review", "/abs/review/SKILL.md"),
    [`${CORPUS}/commands/review.md`]: COMMAND_CARD("review", "/abs/commands/review.md"),
    [`${CORPUS}/subagents/review.md`]: SUBAGENT_CARD("review", "/abs/subagents/review.md"),
  };
  for (const form of ["./.toolgate/skills-index/corpus", "/repo/.toolgate/skills-index/corpus"]) {
    registerBackend("qmd", backendOf([{ file: `${form}/review.md`, score: 0.9 }, { file: `${form}/commands/review.md`, score: 0.8 }, { file: `${form}/subagents/review.md`, score: 0.7 }], cards));
    const result = await route("review", config, { backend: "qmd" });
    assert.deepEqual(result.skills.map((s) => s.path), ["/abs/review/SKILL.md"], form);
    assert.deepEqual(result.commands.map((c) => c.path), ["/abs/commands/review.md"], form);
    assert.deepEqual(result.subagents.map((s) => s.path), ["/abs/subagents/review.md"], form);
  }
  // a relative path that climbs out of the corpus is not a card
  registerBackend("qmd", backendOf([{ file: "./.toolgate/skills-index/corpus/subagents/../../../../etc/x.md", score: 0.9 }], cards));
  const escaped = await route("review", config, { backend: "qmd" });
  assert.deepEqual([escaped.subagents, escaped.commands], [[], []]);
});

test("withoutCollection: every form of a card path, and a path that leaves the corpus comes back unchanged (it is not a card)", () => {
  const corpus = "/repo/.toolgate/skills-index/corpus";
  const of = (file) => withoutCollection(file, "skills", corpus, "/repo");
  assert.equal(of("skills/commands/x.md"), "commands/x.md");
  assert.equal(of(`${corpus}/subagents/x.md`), "subagents/x.md");
  assert.equal(of("./.toolgate/skills-index/corpus/subagents/x.md"), "subagents/x.md");
  assert.equal(of("./.toolgate/skills-index/corpus/sub/../x.md"), "x.md", "climbing and landing back inside the corpus is the card x.md");
  assert.equal(of("../repo/.toolgate/skills-index/corpus/x.md"), "x.md");
  for (const out of [
    "./.toolgate/skills-index/corpus/../../../x.md",
    "./.toolgate/skills-index/corpus/../x.md",
    "../../etc/x.md",
    "./other/x.md",
    "/etc/x.md",
    `${corpus}-sibling/x.md`,
  ]) {
    assert.equal(of(out), out, `${out} is not inside the corpus`);
  }
});
