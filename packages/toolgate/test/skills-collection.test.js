import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncCollection } from "../src/skills/collection.js";
import { defaultCollection } from "../src/skills/corpus.js";
import { scanSkills } from "../src/skills/scan.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");
const sources = [{ dir: FIXTURES }];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-collection-"));
const options = (work, execFn, extra = {}) => ({
  sources,
  corpusDir: path.join(work, "corpus"),
  stateFile: path.join(work, "state.json"),
  execFn,
  collection: "skills",
  ...extra,
});

// A qmd that remembers what was registered, like the real one: `show` reports the folder passed to
// `collection add`, and fails while nothing is registered.
function fakeQmd() {
  let corpus = null;
  return (bin, args) => {
    if (args[1] === "add") corpus = args[2];
    if (args[1] !== "show") return "";
    if (corpus === null) throw new Error(`Collection not found: ${args[2]}`);
    return `Collection: ${args[2]}\n  Path:     ${corpus}\n`;
  };
}

function qmdRecorder(script = fakeQmd()) {
  const calls = [];
  return {
    calls,
    execFn: (bin, args) => {
      calls.push([bin, ...args].join(" "));
      return script(bin, args);
    },
  };
}

// A qmd where the collection name is already taken and `show` says where it points.
const takenAt = (pointsAt) => (bin, args) => {
  if (args[1] === "add") {
    const err = new Error("Command failed");
    err.stderr = "Collection 'skills' already exists.";
    throw err;
  }
  return args[1] === "show" ? `Collection: skills\n  Path:     ${pointsAt}\n  Include:  yes\n` : "";
};

test("syncCollection: registers once and skips while the fingerprint is unchanged", () => {
  const work = tmp();
  const { calls, execFn } = qmdRecorder();

  assert.deepEqual(syncCollection(options(work, execFn)), { indexed: true, count: 2, commands: 0, subagents: 0 });
  assert.match(calls.find((c) => c.includes("collection add")), /--name skills --mask \*\*\/\*\.md/);
  assert.ok(calls.includes("qmd update") && calls.includes("qmd embed -c skills"));

  const before = calls.length;
  assert.deepEqual(syncCollection(options(work, execFn)), { indexed: false, count: 2, commands: 0, subagents: 0 });
  // One git HEAD lookup per source, plus the check that qmd still has the collection.
  assert.equal(calls.length, before + sources.length + 1);
  assert.equal(calls.at(-1), "qmd collection show skills");
});

test("syncCollection: reindexes when qmd no longer has the collection, even if nothing changed", () => {
  const work = tmp();
  let registered = false;
  const { calls, execFn } = qmdRecorder((bin, args) => {
    if (args[1] === "add") registered = true;
    if (args[1] === "show") {
      if (!registered) throw new Error("Collection not found: skills");
      return `Collection: skills\n  Path:     ${path.join(work, "corpus")}\n`;
    }
    return "";
  });
  assert.equal(syncCollection(options(work, execFn)).indexed, true);
  assert.equal(syncCollection(options(work, execFn)).indexed, false);

  registered = false; // the collection is removed from qmd; the local state is untouched
  assert.equal(syncCollection(options(work, execFn)).indexed, true);
  assert.equal(calls.filter((c) => c.includes("collection add")).length, 2);
});

test("syncCollection: a changed file mtime triggers a re-index", () => {
  const work = tmp();
  fs.cpSync(FIXTURES, path.join(work, "src"), { recursive: true });
  const { execFn } = qmdRecorder();
  const opts = options(work, execFn, { sources: [{ dir: path.join(work, "src") }] });

  assert.equal(syncCollection(opts).indexed, true);
  assert.equal(syncCollection(opts).indexed, false);

  const touched = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(work, "src", "alpha", "SKILL.md"), touched, touched);
  assert.equal(syncCollection(opts).indexed, true);
});

test("syncCollection: changing an override reindexes and regenerates the corpus; an equal one does not", () => {
  const work = tmp();
  fs.cpSync(FIXTURES, path.join(work, "src"), { recursive: true });
  const { execFn } = qmdRecorder();
  const base = options(work, execFn, { sources: [{ dir: path.join(work, "src") }] });
  const name = scanSkills(base.sources)[0].name;
  const withOverride = (override) => ({ ...base, overrides: [override] });
  assert.equal(syncCollection(withOverride({ skill: name, mcps: ["one"] })).indexed, true);
  assert.equal(syncCollection(withOverride({ skill: name, mcps: ["one"] })).indexed, false);
  assert.equal(syncCollection(withOverride({ skill: name, mcps: ["two"] })).indexed, true);
  const corpus = fs.readdirSync(path.join(work, "corpus"), { recursive: true }).map((f) => path.join(work, "corpus", String(f))).filter((f) => f.endsWith(".md") && fs.statSync(f).isFile());
  assert.ok(corpus.some((f) => /Required MCPs: two/.test(fs.readFileSync(f, "utf8"))));
});

test("syncCollection: a failing qmd is not recorded as indexed", () => {
  const work = tmp();
  const { execFn } = qmdRecorder((bin, args) => {
    if (args[0] === "embed") throw new Error("embed failed");
    return "";
  });
  const opts = options(work, execFn);
  assert.throws(() => syncCollection(opts), /embed failed/);
  assert.equal(fs.existsSync(opts.stateFile), false);
});

test("syncCollection: a taken name is fine when it already points at the corpus", () => {
  const work = tmp();
  const { execFn } = qmdRecorder(takenAt(path.join(work, "corpus")));
  assert.deepEqual(syncCollection(options(work, execFn)), { indexed: true, count: 2, commands: 0, subagents: 0 });
});

test("syncCollection: a name taken by another folder fails loudly and is not recorded", () => {
  const work = tmp();
  const { calls, execFn } = qmdRecorder(takenAt("/repo/.rulesync/skills"));
  const opts = options(work, execFn);

  assert.throws(
    () => syncCollection(opts),
    /collection "skills" points at \/repo\/\.rulesync\/skills, not at the skills corpus .*qmd collection remove skills/
  );
  assert.equal(fs.existsSync(opts.stateFile), false);
  assert.ok(!calls.includes("qmd update"));
});

test("syncCollection: other qmd errors while adding are not mistaken for a taken name", () => {
  const work = tmp();
  const { execFn } = qmdRecorder(() => {
    throw new Error("spawn qmd ENOENT");
  });
  assert.throws(() => syncCollection(options(work, execFn)), /ENOENT/);
});

// A qmd with several named collections, like the real one: global to the machine.
function multiQmd() {
  const collections = new Map();
  return {
    collections,
    execFn: (bin, args) => {
      const [, action, first] = args;
      if (args[0] !== "collection") return "";
      if (action === "add") {
        const name = args[args.indexOf("--name") + 1];
        if (collections.has(name)) throw Object.assign(new Error("failed"), { stderr: `Collection '${name}' already exists.` });
        collections.set(name, first);
      }
      if (action === "remove") collections.delete(first);
      if (action === "show") {
        if (!collections.has(first)) throw new Error(`Collection not found: ${first}`);
        return `Collection: ${first}\n  Path:     ${collections.get(first)}\n`;
      }
      return "";
    },
  };
}

test("syncCollection: two projects index side by side without colliding", () => {
  const qmd = multiQmd();
  for (const name of ["skills-a-111111", "skills-b-222222"]) {
    assert.equal(syncCollection(options(tmp(), qmd.execFn, { collection: name })).indexed, true);
  }
  assert.equal(qmd.collections.size, 2);
});

test("syncCollection: requires a collection name", () => {
  const work = tmp();
  assert.throws(() => syncCollection(options(work, fakeQmd(), { collection: undefined })), /collection name is required/);
});

test("defaultCollection: stable, readable, and different for two checkouts with the same name", () => {
  assert.equal(defaultCollection("/work/My App"), defaultCollection("/work/My App"));
  assert.match(defaultCollection("/work/My App"), /^skills-my-app-[0-9a-f]{6}$/);
  assert.notEqual(defaultCollection("/work/app"), defaultCollection("/other/app"));
  assert.match(defaultCollection("/"), /^skills-project-[0-9a-f]{6}$/);
});

test("syncCollection: qmd update and embed get a long timeout, because the first run loads the models", () => {
  const work = tmp();
  const seen = [];
  const execFn = (bin, args, opts) => {
    if (args[0] === "update" || args[0] === "embed") seen.push([args[0], opts?.timeout]);
    return args[1] === "show" ? `Collection: skills\n  Path:     ${path.join(work, "corpus")}\n` : "";
  };
  syncCollection(options(work, execFn));
  assert.deepEqual(seen, [["update", 600000], ["embed", 600000]]);
});
