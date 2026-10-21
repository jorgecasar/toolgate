// The session state module (#19 T4): modes, links, owner, the folder it must be under, atomic writes, the union and the sweep.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_ENABLED, createSession, disableTools, enableTools, isSessionFile, markInstructionsShown, readSession, refusal, removeSession,
  resetTools, sessionsRoot, cleanBaseline, inspectSession, missingFailure, readInstructions, MAX_INSTRUCTIONS_BYTES, readFailure, sweepSessions, updateSession, validState, writeFailure, LOCK_STALE_MS, LOCK_TRIES,
} from "../src/session.js";
import { applyChange } from "../src/configFile.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const sandbox = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-session-")));
  made.push(dir);
  return { dir, options: { env: { XDG_STATE_HOME: path.join(dir, "state"), HOME: path.join(dir, "home") }, homedir: path.join(dir, "home") } };
};
const mode = (target) => fs.statSync(target).mode & 0o777;
const wrapped = ["repo", "docs"];

test("the folder follows XDG_STATE_HOME, a relative one is ignored, and HOME is the fallback", () => {
  assert.equal(sessionsRoot({ env: { XDG_STATE_HOME: "/x/state" } }), "/x/state/toolgate/sessions");
  assert.equal(sessionsRoot({ env: { XDG_STATE_HOME: "rel", HOME: "/h" } }), "/h/.local/state/toolgate/sessions");
  assert.equal(sessionsRoot({ env: {}, homedir: "/hd" }), "/hd/.local/state/toolgate/sessions");
});

test("a new session is a 600 file in a 700 folder, one entry per wrapped server, nothing revealed", () => {
  const { options } = sandbox();
  const made1 = createSession(wrapped, options);
  assert.match(path.basename(made1.file), /^[0-9a-f-]{36}\.json$/);
  assert.equal(path.dirname(made1.file), sessionsRoot(options));
  assert.equal(mode(path.dirname(made1.file)), 0o700);
  assert.equal(mode(made1.file), 0o600);
  assert.deepEqual(readSession(made1.file, options), {
    version: 1,
    servers: { repo: { enabled: [], baseline: [], instructionsShown: false }, docs: { enabled: [], baseline: [], instructionsShown: false } },
  });
  assert.notEqual(createSession(wrapped, options).file, made1.file, "a UUID each time");
  assert.deepEqual(fs.readdirSync(sessionsRoot(options)).filter((name) => name.endsWith(".tmp")), [], "no temp file left");
});

test("a server name that is not a plain name is never written", () => {
  const { options } = sandbox();
  const { file } = createSession(["ok", "../evil", "a b", "__proto__"], options);
  assert.deepEqual(Object.keys(readSession(file, options).servers), ["ok"]);
});

test("a sessions folder that is a link, not private, or not a folder is refused, and nothing is written", () => {
  for (const [label, prepare] of [
    ["link", (root, dir) => { fs.mkdirSync(path.join(dir, "elsewhere")); fs.mkdirSync(path.dirname(root), { recursive: true }); fs.symlinkSync(path.join(dir, "elsewhere"), root); }],
    ["open mode", (root) => { fs.mkdirSync(root, { recursive: true }); fs.chmodSync(root, 0o755); }],
    ["a file", (root) => { fs.mkdirSync(path.dirname(root), { recursive: true }); fs.writeFileSync(root, ""); }],
  ]) {
    const { dir, options } = sandbox();
    const root = sessionsRoot(options);
    prepare(root, dir);
    const result = createSession(wrapped, options);
    assert.equal(result.refused, refusal(root), label);
    assert.equal(result.file, undefined);
    if (label === "link") assert.deepEqual(fs.readdirSync(path.join(dir, "elsewhere")), [], "nothing written through the link");
  }
});

test("a session file that is a link, open to others, or not a session path is not read or changed", () => {
  const { dir, options } = sandbox();
  const { file } = createSession(wrapped, options);
  assert.ok(readSession(file, options));
  fs.chmodSync(file, 0o644);
  assert.equal(readSession(file, options), null, "group/other can read it");
  assert.match(updateSession(file, (state) => state, options).refused, /is not a private file of yours/);
  fs.chmodSync(file, 0o600);
  const real = path.join(dir, "real.json");
  fs.copyFileSync(file, real);
  const linked = path.join(sessionsRoot(options), "11111111-1111-4111-8111-111111111111.json");
  fs.symlinkSync(real, linked);
  assert.equal(readSession(linked, options), null, "a link");
  assert.equal(readSession(real, options), null, "outside the folder");
  const elsewhere = path.join(dir, path.basename(file));
  fs.copyFileSync(file, elsewhere);
  assert.equal(readSession(elsewhere, options), null, "a uuid name, but outside the folder");
  const odd = path.join(sessionsRoot(options), "x.json");
  fs.copyFileSync(file, odd);
  assert.equal(readSession(odd, options), null, "in the folder, but not a uuid name");
  assert.equal(readSession(`${sessionsRoot(options)}/../sessions/${path.basename(file)}`, options), null, "not normalised");
  assert.equal(readSession(path.relative(process.cwd(), file), options), null, "relative");
  assert.equal(isSessionFile(`${file}\0`, options), false);
  assert.equal(isSessionFile(undefined, options), false);
  assert.equal(isSessionFile(file, options), true);
});

test("a folder or file that another user owns is refused", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const other = { ...options, uid: process.getuid() + 1 };
  assert.equal(readSession(file, other), null);
  assert.match(updateSession(file, (state) => state, other).refused, /is not a private file of yours/);
  assert.match(createSession(wrapped, other).refused, /is not a private file of yours/);
  assert.ok(readSession(file, options));
});

test("a state that is not valid is not trusted: version, shape, names, sizes and types", () => {
  const entry = { enabled: [], baseline: [], instructionsShown: false };
  const good = { version: 1, servers: { repo: entry } };
  assert.ok(validState(good));
  for (const bad of [
    null, [], { version: 2, servers: {} }, { version: 1 }, { version: 1, servers: [] },
    { version: 1, servers: { "a b": entry } }, { version: 1, servers: { repo: [] } },
    { version: 1, servers: { repo: { ...entry, enabled: "x" } } },
    { version: 1, servers: { repo: { ...entry, enabled: ["ok", "bad name"] } } },
    { version: 1, servers: { repo: { ...entry, enabled: [1] } } },
    { version: 1, servers: { repo: { ...entry, enabled: Array.from({ length: MAX_ENABLED + 1 }, (_, i) => `t${i}`) } } },
    { version: 1, servers: { repo: { ...entry, instructionsShown: 1 } } },
    { version: 1, servers: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`s${i}`, entry])) },
  ]) assert.equal(validState(bad), null, JSON.stringify(bad)?.slice(0, 80));
  assert.deepEqual(validState({ version: 1, servers: { repo: { ...entry, enabled: ["a", "a"], extra: 1 } } }).servers.repo, { ...entry, enabled: ["a"] }, "duplicates and unknown fields dropped");
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  fs.writeFileSync(file, "{not json");
  assert.equal(readSession(file, options), null);
  fs.writeFileSync(file, `{"version":1,"servers":{}}${" ".repeat(2 * 1024 * 1024)}`, { mode: 0o600 });
  assert.equal(readSession(file, options), null, "over the size cap");
});

test("a change is read, changed and written whole, in a 600 file, with no temp left, and an invalid result writes nothing", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const inode = fs.statSync(file).ino;
  const { state: next } = updateSession(file, (state) => enableTools(state, "repo", ["a", "b"]), options);
  assert.deepEqual(next.servers.repo.enabled, ["a", "b"]);
  assert.deepEqual(readSession(file, options), next);
  assert.equal(mode(file), 0o600);
  assert.notEqual(fs.statSync(file).ino, inode, "renamed over, not edited in place");
  assert.deepEqual(fs.readdirSync(sessionsRoot(options)).filter((name) => name.endsWith(".tmp")), []);
  const before = fs.readFileSync(file, "utf8");
  for (const change of [(state) => enableTools(state, "repo", ["bad name"]), () => ({ nope: true })]) {
    assert.equal(updateSession(file, change, options).refused, writeFailure(file, "the new state is not valid"));
  }
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("enable is a union, disable and reset narrow, a server that is not in the session is left alone", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  let state = readSession(file, options);
  state = enableTools(enableTools(state, "repo", ["a", "b"]), "repo", ["b", "c"]);
  assert.deepEqual(state.servers.repo.enabled, ["a", "b", "c"]);
  assert.deepEqual(disableTools(state, "repo", ["b"]).servers.repo.enabled, ["a", "c"]);
  assert.deepEqual(disableTools(state, "repo").servers.repo.enabled, [], "no tool is all of them");
  assert.deepEqual(disableTools(state, "repo", []).servers.repo.enabled, []);
  const both = enableTools(state, "docs", ["z"]);
  assert.deepEqual(resetTools(both, "docs").servers.docs.enabled, []);
  assert.deepEqual(resetTools(both, "docs").servers.repo.enabled, ["a", "b", "c"]);
  assert.deepEqual(Object.values(resetTools(both).servers).map((entry) => entry.enabled), [[], []]);
  assert.equal(enableTools(state, "ghost", ["x"]), state);
  assert.equal(enableTools(state, "constructor", ["x"]), state, "an inherited name is not a server");
  assert.equal(markInstructionsShown(state, "repo").servers.repo.instructionsShown, true);
  assert.equal(state.servers.repo.instructionsShown, false, "the input is not changed");
});

test("two changes one after the other keep both (the union)", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  updateSession(file, (state) => enableTools(state, "repo", ["a"]), options);
  updateSession(file, (state) => enableTools(state, "repo", ["b"]), options);
  assert.deepEqual(readSession(file, options).servers.repo.enabled, ["a", "b"]);
});

test("the end removes the session's own files and nothing else", () => {
  const { options } = sandbox();
  const one = createSession(wrapped, options);
  const two = createSession(wrapped, options);
  const root = sessionsRoot(options);
  const id = path.basename(one.file, ".json");
  fs.writeFileSync(path.join(root, `${id}.repo.instructions.txt`), "x", { mode: 0o600 });
  fs.writeFileSync(path.join(root, `${id}.json.1.abcd1234.tmp`), "x", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "notes.txt"), "mine");
  removeSession(one.file, options);
  assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(two.file), "notes.txt"].sort());
  removeSession(path.join(path.dirname(root), "x.json"), options);
  removeSession(one.file, options);
});

test("the sweep removes this user's session files older than 7 days, by mtime, and no others", () => {
  const { options } = sandbox();
  const old = createSession(wrapped, options);
  const fresh = createSession(wrapped, options);
  const root = sessionsRoot(options);
  const oldId = path.basename(old.file, ".json");
  const oldInstructions = path.join(root, `${oldId}.repo.instructions.txt`);
  fs.writeFileSync(oldInstructions, "x", { mode: 0o600 });
  const stranger = path.join(root, "keep.json");
  fs.writeFileSync(stranger, "{}");
  const dayAgo = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);
  for (const target of [old.file, oldInstructions, stranger]) fs.utimesSync(target, dayAgo(8), dayAgo(8));
  fs.utimesSync(fresh.file, dayAgo(6), dayAgo(6));
  sweepSessions(options);
  assert.deepEqual(fs.readdirSync(root).sort(), ["keep.json", path.basename(fresh.file)].sort());
  const linkTarget = path.join(root, "..", "outside.json");
  fs.writeFileSync(linkTarget, "{}");
  const link = path.join(root, "22222222-2222-4222-8222-222222222222.json");
  fs.symlinkSync(linkTarget, link);
  fs.lutimesSync(link, dayAgo(9), dayAgo(9));
  sweepSessions(options);
  assert.equal(fs.existsSync(linkTarget), true, "a link target is never touched");
  const none = sandbox();
  sweepSessions(none.options);
});

test("the sweep does nothing in a folder that is not private", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  fs.chmodSync(path.dirname(file), 0o755);
  fs.utimesSync(file, new Date(0), new Date(0));
  sweepSessions(options);
  assert.equal(fs.existsSync(file), true);
});


test("the two texts: a refused file, and a cap or a failed write", () => {
  const { dir, options } = sandbox();
  const root = sessionsRoot(options);
  assert.equal(refusal("/x/\u001b[31m"), "toolgate: /x/\\u001b[31m is not a private file of yours; its tools are revealed only by a restart this session");
  assert.equal(writeFailure("/x/f", "EACCES"), "toolgate: the session file /x/f could not be written (EACCES); its tools are revealed only by a restart this session");
  const many = createSession(Array.from({ length: 257 }, (_, i) => `s${i}`), options);
  assert.equal(many.refused, writeFailure(root, "more than 256 servers"));
  assert.equal(createSession(Array.from({ length: 256 }, (_, i) => `s${i}`), options).file !== undefined, true, "256 is the cap, not 255");
  for (const bad of [undefined, null, "repo", { length: 1 }]) assert.match(createSession(bad, options).refused, /could not be written \(no list of servers\)/);
  assert.deepEqual(Object.keys(readSession(createSession([1, null, "ok"], options).file, options).servers), ["ok"], "a non-string is left out, not thrown on");
  fs.chmodSync(root, 0o500);
  if (process.getuid() !== 0) assert.match(createSession(wrapped, options).refused, /^toolgate: the session file .* could not be written \(EACCES\); its tools/);
  fs.chmodSync(root, 0o700);
  assert.ok(dir);
});

test("the folders above the sessions folder are made 700 too, whatever the umask", () => {
  const { dir, options } = sandbox();
  const before = process.umask(0);
  try {
    createSession(wrapped, options);
  } finally {
    process.umask(before);
  }
  const state = path.join(dir, "state");
  for (const folder of [state, path.join(state, "toolgate"), sessionsRoot(options)]) assert.equal(mode(folder), 0o700, folder);
  fs.mkdirSync(path.join(dir, "open"), { mode: 0o755 });
  const existing = { env: { XDG_STATE_HOME: path.join(dir, "open") } };
  createSession(wrapped, existing);
  assert.equal(mode(path.join(dir, "open")), 0o755, "an existing folder is left as it is");
  assert.equal(mode(path.join(dir, "open", "toolgate")), 0o700);
});

const CHILD = `
import { enableTools, updateSession } from ${JSON.stringify(new URL("../src/session.js", import.meta.url).href)};
const [file, who, count] = process.argv.slice(1);
let lost = 0;
for (let i = 0; i < Number(count); i += 1) {
  const result = updateSession(file, (state) => enableTools(state, "repo", [\`p\${who}t\${i}\`]), { env: { XDG_STATE_HOME: process.env.XDG_STATE_HOME } });
  if (!result.state) lost += 1;
}
process.exit(lost === 0 ? 0 : 3);
`;

test("4 processes x 40 enables at once keep all 160, and leave no lock or temp file", async () => {
  const { options } = sandbox();
  const { file } = createSession(["repo"], options);
  const codes = await Promise.all(
    [0, 1, 2, 3].map(
      (who) =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, file, String(who), "40"], { env: { PATH: process.env.PATH, XDG_STATE_HOME: options.env.XDG_STATE_HOME }, stdio: "ignore" });
          child.on("exit", resolve);
        }),
    ),
  );
  assert.deepEqual(codes, [0, 0, 0, 0], "no write gave up");
  assert.equal(readSession(file, options).servers.repo.enabled.length, 160);
  assert.deepEqual(fs.readdirSync(sessionsRoot(options)).filter((name) => /\.(lock|tmp)$/.test(name)), []);
});

test("a lock that stays taken fails the write as busy, after LOCK_TRIES tries, and is not removed", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const lock = file.replace(/\.json$/, ".lock");
  fs.writeFileSync(lock, "1\n", { mode: 0o600 });
  const sleeps = [];
  const result = updateSession(file, (state) => enableTools(state, "repo", ["a"]), { ...options, sleep: (ms) => sleeps.push(ms) });
  assert.equal(result.refused, writeFailure(file, "the session file is busy"));
  assert.equal(sleeps.length, LOCK_TRIES);
  assert.ok(sleeps.every((ms) => ms === 50));
  assert.equal(fs.existsSync(lock), true, "someone else's lock stays");
  assert.deepEqual(readSession(file, options).servers.repo.enabled, [], "nothing written");
});

test("a lock older than 10 s is broken once; a lock that is a link is unlinked, not followed", () => {
  const { dir, options } = sandbox();
  const { file } = createSession(wrapped, options);
  const lock = file.replace(/\.json$/, ".lock");
  fs.writeFileSync(lock, "999999\n", { mode: 0o600 });
  const old = new Date(Date.now() - LOCK_STALE_MS - 2000);
  fs.utimesSync(lock, old, old);
  assert.deepEqual(updateSession(file, (state) => enableTools(state, "repo", ["a"]), options).state.servers.repo.enabled, ["a"]);
  assert.equal(fs.existsSync(lock), false, "released");
  fs.writeFileSync(lock, "1\n", { mode: 0o600 });
  const young = new Date(Date.now() - LOCK_STALE_MS + 5000);
  fs.utimesSync(lock, young, young);
  assert.match(updateSession(file, (state) => state, { ...options, sleep: () => {} }).refused, /busy/, "a younger lock is respected");
  fs.rmSync(lock);
  const target = path.join(dir, "target.txt");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, lock);
  assert.ok(updateSession(file, (state) => enableTools(state, "repo", ["b"]), options).state);
  assert.equal(fs.readFileSync(target, "utf8"), "keep", "not written through the link");
  assert.equal(fs.existsSync(lock), false);
});

test("while a change runs the lock exists, mode 600, holding a random token", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const lock = file.replace(/\.json$/, ".lock");
  let seen;
  updateSession(file, (state) => {
    seen = { mode: mode(lock), text: fs.readFileSync(lock, "utf8") };
    return state;
  }, options);
  assert.equal(seen.mode, 0o600);
  assert.match(seen.text, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/);
  assert.notEqual(seen.text, `${process.pid}\n`, "no pid in it");
});

test("the lock is released when the change throws", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  assert.throws(() => updateSession(file, () => { throw new Error("boom"); }, options), /boom/);
  assert.equal(fs.existsSync(file.replace(/\.json$/, ".lock")), false);
});

test("the sweep removes old <uuid>.json links and old locks, with lstat and unlink, and not what they point to", () => {
  const { dir, options } = sandbox();
  const { file } = createSession(wrapped, options);
  const root = sessionsRoot(options);
  const target = path.join(dir, "elsewhere.txt");
  fs.writeFileSync(target, "keep");
  const staleLink = path.join(root, "33333333-3333-4333-8333-333333333333.json");
  const freshLink = path.join(root, "44444444-4444-4444-8444-444444444444.json");
  const staleLock = path.join(root, "55555555-5555-4555-8555-555555555555.lock");
  fs.symlinkSync(target, staleLink);
  fs.symlinkSync(target, freshLink);
  fs.writeFileSync(staleLock, "1");
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.lutimesSync(staleLink, old, old);
  fs.utimesSync(staleLock, old, old);
  sweepSessions(options);
  assert.equal(fs.existsSync(target), true);
  assert.equal(fs.lstatSync(staleLink, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.lstatSync(staleLock, { throwIfNoEntry: false }), undefined);
  assert.ok(fs.lstatSync(freshLink).isSymbolicLink(), "a young link stays");
  assert.ok(fs.existsSync(file));
  const other = { ...options, uid: process.getuid() + 1 };
  fs.lutimesSync(freshLink, old, old);
  sweepSessions(other);
  assert.ok(fs.lstatSync(freshLink).isSymbolicLink(), "another user's files are not ours to remove");
  sweepSessions(options);
  assert.equal(fs.lstatSync(freshLink, { throwIfNoEntry: false }), undefined, "now it is old");
});

test("a holder that was paused past 10 s does not remove the lock of the writer that broke it", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const lock = file.replace(/\.json$/, ".lock");
  const result = updateSession(file, (state) => {
    fs.rmSync(lock);
    fs.writeFileSync(lock, "someone-else\n", { mode: 0o600 });
    return enableTools(state, "repo", ["a"]);
  }, options);
  assert.deepEqual(result.state.servers.repo.enabled, ["a"], "the write already done stands");
  assert.equal(fs.readFileSync(lock, "utf8"), "someone-else\n", "the other writer's lock stays");
  const link = path.join(path.dirname(lock), "keep.txt");
  fs.writeFileSync(link, "x");
  fs.rmSync(lock);
  fs.symlinkSync(link, lock);
  updateSession(file, (state) => {
    fs.rmSync(lock);
    fs.symlinkSync(link, lock);
    return state;
  }, options);
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true, "a link in its place is left alone too");
  assert.equal(fs.readFileSync(link, "utf8"), "x");
});

test("ending a session takes the lock: a taken one leaves the files for the sweep, a free one is released and gone", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const root = sessionsRoot(options);
  const id = path.basename(file, ".json");
  fs.writeFileSync(path.join(root, `${id}.repo.instructions.txt`), "x", { mode: 0o600 });
  const lock = file.replace(/\.json$/, ".lock");
  fs.writeFileSync(lock, "other\n", { mode: 0o600 });
  removeSession(file, { ...options, sleep: () => {} });
  assert.equal(fs.existsSync(file), true, "busy: nothing removed");
  assert.equal(fs.readFileSync(lock, "utf8"), "other\n");
  fs.rmSync(lock);
  removeSession(file, options);
  assert.deepEqual(fs.readdirSync(root), [], "state, instructions and lock all gone");
});

test("a corrupt or oversize session file is refused as unreadable and never overwritten", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const lock = file.replace(/\.json$/, ".lock");
  for (const [content, reason] of [["{not json", "not valid"], ['{"version":2,"servers":{}}', "not valid"], [`{"version":1,"servers":{}}${" ".repeat(2 * 1024 * 1024)}`, "too large"]]) {
    fs.writeFileSync(file, content, { mode: 0o600 });
    const result = updateSession(file, (state) => enableTools(state, "repo", ["a"]), options);
    assert.equal(result.refused, readFailure(file, reason));
    assert.equal(fs.readFileSync(file, "utf8"), content, "left as it was");
    assert.equal(fs.existsSync(lock), false, "the lock is released");
  }
  assert.equal(readFailure("/x/f", "not valid"), "toolgate: the session file /x/f could not be read (not valid); its tools are revealed only by a restart this session");
});

test("each entry keeps the baseline the launcher stored, and the project folder is recorded", () => {
  const { options } = sandbox();
  const { file } = createSession([{ server: "repo", baseline: ["list", "get", "list"] }, "docs", { server: "../bad", baseline: ["x"] }], { ...options, projectDir: "/work/proj" });
  const state = readSession(file, options);
  assert.deepEqual(state, { version: 1, projectDir: "/work/proj", servers: { repo: { enabled: [], baseline: ["list", "get"], instructionsShown: false }, docs: { enabled: [], baseline: [], instructionsShown: false } } });
  assert.deepEqual(enableTools(state, "repo", ["merge"]).servers.repo.baseline, ["list", "get"], "a change keeps it");
  const without = createSession(["repo"], options);
  assert.equal("projectDir" in readSession(without.file, options), false);
});

test("a file without baselines (written before) reads as none; a bad baseline or project folder is not trusted", () => {
  const old = { version: 1, servers: { repo: { enabled: ["a"], instructionsShown: false } } };
  assert.deepEqual(validState(old).servers.repo, { enabled: ["a"], baseline: [], instructionsShown: false });
  const entry = { enabled: [], baseline: [], instructionsShown: false };
  for (const bad of [
    { version: 1, servers: { repo: { ...entry, baseline: "list" } } },
    { version: 1, servers: { repo: { ...entry, baseline: ["bad name"] } } },
    { version: 1, servers: { repo: { ...entry, baseline: [1] } } },
    { version: 1, servers: { repo: { ...entry, baseline: Array.from({ length: MAX_ENABLED + 1 }, (_, i) => `t${i}`) } } },
    { version: 1, projectDir: "relative/dir", servers: {} },
    { version: 1, projectDir: 7, servers: {} },
    { version: 1, projectDir: "/a\0b", servers: {} },
    { version: 1, projectDir: `/${"x".repeat(5000)}`, servers: {} },
    { version: 1, projectDir: "/work/a\nb", servers: {} },
    { version: 1, projectDir: "/work/\u001b[31m", servers: {} },
    { version: 1, projectDir: "/work/\u202eevil", servers: {} },
    { version: 1, projectDir: "/work/../etc", servers: {} },
    { version: 1, projectDir: "/work//proj", servers: {} },
    { version: 1, projectDir: "/work/proj/", servers: {} },
    { version: 1, projectDir: "/work/./proj", servers: {} },
    { version: 1, projectDir: "/work/a\u2028b", servers: {} },
  ]) assert.equal(validState(bad), null, JSON.stringify(bad).slice(0, 80));
  assert.ok(validState({ version: 1, projectDir: "/ok", servers: {} }));
});

test("cleanBaseline keeps the valid distinct names up to the cap and returns what it left out", () => {
  assert.deepEqual(cleanBaseline(["a", "a", "b c", 7, "ok.tool:1", "x".repeat(129)]), { kept: ["a", "ok.tool:1"], dropped: ["b c", 7, "x".repeat(129)] });
  assert.deepEqual(cleanBaseline("nope"), { kept: [], dropped: [] });
  const many = Array.from({ length: MAX_ENABLED + 3 }, (_, i) => `t${i}`);
  const { kept, dropped } = cleanBaseline(many);
  assert.equal(kept.length, MAX_ENABLED);
  assert.deepEqual(dropped, many.slice(MAX_ENABLED));
});

test("a sessions folder that is not writable fails with the error code, not as busy", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    if (process.getuid() === 0) return;
    const result = updateSession(file, (state) => enableTools(state, "repo", ["a"]), options);
    assert.equal(result.refused, writeFailure(file, "EACCES"));
    assert.doesNotMatch(result.refused, /busy/);
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
});

test("projectDir: 4096 characters are stored and 4097 are not", () => {
  const ok = `/${"x".repeat(4095)}`;
  assert.equal(ok.length, 4096);
  assert.equal(validState({ version: 1, projectDir: ok, servers: {} }).projectDir, ok);
  assert.equal(validState({ version: 1, projectDir: `${ok}x`, servers: {} }), null);
});

test("tool names: 128 characters are valid in a baseline and in enabled, 129 are not", () => {
  const entry = (extra) => ({ version: 1, servers: { repo: { enabled: [], baseline: [], instructionsShown: false, ...extra } } });
  assert.ok(validState(entry({ baseline: ["a".repeat(128)] })));
  assert.equal(validState(entry({ baseline: ["a".repeat(129)] })), null);
  assert.ok(validState(entry({ enabled: ["a".repeat(128)] })));
  assert.equal(validState(entry({ enabled: ["a".repeat(129)] })), null);
});

test("readInstructions reads the file the proxy kept, only when the session and the file can be trusted", () => {
  const { options, dir } = sandbox();
  const { file } = createSession(wrapped, options);
  const target = file.replace(/\.json$/, ".repo.instructions.txt");
  assert.equal(readInstructions(file, "repo", options), null, "none yet");
  fs.writeFileSync(target, "Hello\nWorld", { mode: 0o600 });
  assert.equal(readInstructions(file, "repo", options), "Hello\nWorld");
  // A name with a slash would reach into a folder of that name: the file is there, and still not read.
  const id = path.basename(file, ".json");
  fs.mkdirSync(path.join(path.dirname(file), `${id}.a`), { mode: 0o700 });
  fs.writeFileSync(path.join(path.dirname(file), `${id}.a`, "b.instructions.txt"), "decoy", { mode: 0o600 });
  assert.equal(readInstructions(file, "a/b", options), null);
  assert.equal(readInstructions(file, "docs", options), null, "another server's file is not there");
  for (const bad of ["../x", "a/b", "", ".a", "x".repeat(65), undefined, 7]) assert.equal(readInstructions(file, bad, options), null, String(bad));
  fs.chmodSync(target, 0o644);
  assert.equal(readInstructions(file, "repo", options), null, "open to others");
  fs.chmodSync(target, 0o600);
  assert.equal(readInstructions(file, "repo", { ...options, uid: process.getuid() + 1 }), null, "not the user's");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "secret", { mode: 0o600 });
  fs.rmSync(target);
  fs.symlinkSync(victim, target);
  assert.equal(readInstructions(file, "repo", options), null, "a link is not followed");
  fs.rmSync(target);
  fs.writeFileSync(target, "x".repeat(MAX_INSTRUCTIONS_BYTES + 1), { mode: 0o600 });
  assert.equal(readInstructions(file, "repo", options), null, "over what the proxy writes");
  fs.writeFileSync(target, "x".repeat(MAX_INSTRUCTIONS_BYTES), { mode: 0o600 });
  assert.equal(readInstructions(file, "repo", options).length, MAX_INSTRUCTIONS_BYTES);
  fs.rmSync(target);
  fs.mkdirSync(target);
  assert.equal(readInstructions(file, "repo", options), null, "a folder");
  fs.chmodSync(file, 0o644);
  fs.rmSync(target, { recursive: true });
  fs.writeFileSync(target, "text", { mode: 0o600 });
  assert.equal(readInstructions(file, "repo", options), null, "the session file itself is not private");
  assert.equal(readInstructions(path.join(dir, "x.json"), "repo", options), null, "not a session file");
});

test("a session file that is gone is said to be missing; one that fails a check is said not to be private", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  assert.ok(inspectSession(file, options).state);
  fs.chmodSync(file, 0o644);
  assert.equal(inspectSession(file, options).refused, refusal(file), "a failed check");
  assert.equal(updateSession(file, (state) => state, options).refused, refusal(file));
  fs.chmodSync(file, 0o600);
  fs.rmSync(file);
  const text = "toolgate: the session file " + file + " is missing; its tools are revealed only by a restart this session";
  assert.equal(missingFailure(file), text);
  assert.equal(inspectSession(file, options).refused, text);
  assert.equal(updateSession(file, (state) => state, options).refused, text);
  const link = path.join(path.dirname(file), "11111111-1111-4111-8111-111111111111.json");
  fs.symlinkSync("/nonexistent", link);
  assert.equal(inspectSession(link, options).refused, refusal(link), "a dangling link exists as a link: it is not private, not missing");
});

test("a change that changes nothing writes nothing: same inode, same time, the state is returned", () => {
  const { options } = sandbox();
  const { file } = createSession(wrapped, options);
  const old = new Date(Date.now() - 5 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  const before = fs.statSync(file);
  const result = updateSession(file, (state) => enableTools(state, "repo", []), options);
  assert.deepEqual(result.state, readSession(file, options));
  const after = fs.statSync(file);
  assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".lock") || name.endsWith(".tmp")), []);
  const changed = updateSession(file, (state) => enableTools(state, "repo", ["a"]), options);
  assert.deepEqual(changed.state.servers.repo.enabled, ["a"]);
  assert.notEqual(fs.statSync(file).ino, before.ino, "a real change is written");
});
