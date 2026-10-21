import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_KIND, installSkills, readLock, writeLock } from "../src/skills/install.js";
import { formatUpdate, updateAssets, updateExitCode } from "../src/skills/update.js";
import { git as hermeticGit } from "./support/git.js";

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-upd-${name}-`));
const git = (cwd, ...args) => hermeticGit(cwd, ...args);
const skillMd = (name, body = "body", extra = "") => `---\nname: ${name}\ndescription: the ${name} skill\n${extra}---\n${body}\n`;
const write = (root, file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

function setup() {
  const remote = tmp("remote");
  git(remote, "init", "-q", "-b", "main");
  for (const name of ["alpha", "beta", "gamma"]) write(remote, `skills/${name}/SKILL.md`, skillMd(name));
  write(remote, "LICENSE", "MIT v1\n");
  const commit = (message = "change") => {
    git(remote, "add", "-A");
    git(remote, "commit", "-q", "-m", message);
    return git(remote, "rev-parse", "HEAD").trim();
  };
  const first = commit("init");
  const env = { projectDir: tmp("project"), cache: tmp("cache"), allowFile: true };
  const spec = `file://${remote}`;
  installSkills({ spec, ...env });
  const update = (extra = {}) => updateAssets(SKILL_KIND, { ...env, ...extra });
  const lock = () => readLock(path.join(env.projectDir, ".toolgate/skills.lock.json"));
  const copy = (name, file = "SKILL.md") => path.join(env.projectDir, ".toolgate/skills", name, file);
  return { remote, spec, env, commit, first, update, lock, copy };
}
const report = (result) => result.sources[0];

test("update: nothing changed upstream is all unchanged and writes nothing", () => {
  const t = setup();
  const before = JSON.stringify(t.lock());
  const result = t.update();
  assert.deepEqual(report(result).unchanged, ["alpha", "beta", "gamma"]);
  assert.equal(JSON.stringify(t.lock()), before);
  assert.equal(updateExitCode(result), 0);
});

test("update: a changed upstream skill is replaced and the lock moves to the new commit and hash", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  const second = t.commit();
  const result = t.update();
  assert.deepEqual(report(result).updated, ["alpha"]);
  assert.deepEqual(report(result).unchanged, ["beta", "gamma"]);
  assert.match(fs.readFileSync(t.copy("alpha"), "utf8"), /new body/);
  assert.equal(t.lock().skills.alpha.commit, second);
  assert.equal(t.lock().sources[t.spec].commit, second);
});

test("update --dry-run shows the diff and highlights, and writes nothing", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body", "mcps: [chrome-devtools]\n"));
  write(t.remote, "skills/alpha/scripts/run.sh", "#!/bin/sh\n");
  t.commit();
  const before = JSON.stringify(t.lock());
  const result = t.update({ dryRun: true });
  assert.deepEqual(report(result).updated, ["alpha"]);
  assert.equal(JSON.stringify(t.lock()), before);
  assert.doesNotMatch(fs.readFileSync(t.copy("alpha"), "utf8"), /new body/);
  const text = formatUpdate(result, { dryRun: true });
  assert.match(text, /\+ scripts\/run\.sh/);
  assert.match(text, /~ SKILL\.md/);
  assert.match(text, /! scripts\/run\.sh is not a text file/);
  assert.match(text, /! now requires the MCP server chrome-devtools/);
});

test("update: an edit with no upstream change is kept; an edit with an upstream change is a conflict until --force", () => {
  const t = setup();
  fs.appendFileSync(t.copy("beta"), "my edit\n");
  fs.appendFileSync(t.copy("alpha"), "my edit\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "upstream"));
  const second = t.commit();
  const result = t.update();
  assert.deepEqual(report(result).kept, ["beta"]);
  assert.deepEqual(report(result).conflicts, ["alpha"]);
  assert.match(fs.readFileSync(t.copy("alpha"), "utf8"), /my edit/);
  assert.notEqual(t.lock().sources[t.spec].commit, second, "the source stays behind while a conflict is open");
  assert.equal(updateExitCode(result), 1, "an open conflict means the update is not complete, even with other items applied");
  const forced = t.update({ force: true });
  assert.deepEqual(report(forced).updated, ["alpha", "beta"], "--force also reverts the edit that upstream did not touch");
  assert.doesNotMatch(fs.readFileSync(t.copy("alpha"), "utf8"), /my edit/);
});

test("update: a conflict alone exits 1", () => {
  const t = setup();
  fs.appendFileSync(t.copy("alpha"), "my edit\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "upstream"));
  t.commit();
  assert.equal(updateExitCode(t.update({ names: ["alpha"] })), 1);
});

test("update: a missing copy is restored; a name the lock does not know is reported", () => {
  const t = setup();
  fs.rmSync(path.join(t.env.projectDir, ".toolgate/skills/gamma"), { recursive: true });
  const result = t.update({ names: ["gamma", "nope"] });
  assert.deepEqual(report(result).restored, ["gamma"]);
  assert.deepEqual(result.unknown, ["nope"]);
  assert.ok(fs.existsSync(t.copy("gamma")));
  assert.equal(updateExitCode(result), 1);
});

test("update: removed upstream is reported and kept, --prune deletes it, an edited one needs --force", () => {
  const t = setup();
  git(t.remote, "rm", "-rq", "skills/gamma");
  git(t.remote, "rm", "-rq", "skills/beta");
  t.commit();
  fs.appendFileSync(t.copy("beta"), "my edit\n");
  const first = t.update();
  assert.deepEqual(report(first).removedUpstream.sort(), ["beta", "gamma"]);
  assert.ok(fs.existsSync(t.copy("gamma")));
  const pruned = t.update({ prune: true });
  assert.deepEqual(report(pruned).pruned, ["gamma"]);
  assert.deepEqual(report(pruned).removedUpstream, ["beta"]);
  assert.equal(fs.existsSync(t.copy("gamma")), false);
  assert.equal("gamma" in t.lock().skills, false);
  assert.ok(fs.existsSync(t.copy("beta")));
});

test("update: an invalid upstream skill is skipped and the installed copy stays", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", "---\ndescription: no name\n---\nbody\n");
  t.commit();
  const before = fs.readFileSync(t.copy("alpha"), "utf8");
  const result = t.update();
  assert.match(report(result).skipped[0].reason, /invalid upstream/);
  assert.equal(fs.readFileSync(t.copy("alpha"), "utf8"), before);
});

test("update: new upstream skills are listed, never installed; excluded ones are not even listed", () => {
  const t = setup();
  write(t.remote, "skills/delta/SKILL.md", skillMd("delta"));
  t.commit();
  const result = t.update();
  assert.deepEqual(report(result).newUpstream, ["delta"]);
  assert.equal(fs.existsSync(t.copy("delta")), false);
  assert.match(formatUpdate(result), /new upstream, not installed: delta/);
});

test("update: a source that cannot be fetched is reported and the others still update", () => {
  const t = setup();
  const other = tmp("other");
  git(other, "init", "-q", "-b", "main");
  write(other, "skills/zeta/SKILL.md", skillMd("zeta"));
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "init");
  installSkills({ spec: `file://${other}`, ...t.env });
  fs.rmSync(other, { recursive: true });
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const result = t.update();
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.find((r) => r.source.endsWith(path.basename(other))).error);
  assert.deepEqual(result.sources.find((r) => r.source === t.spec).updated, ["alpha"]);
  assert.equal(updateExitCode(result), 1);
  assert.deepEqual(updateAssets(SKILL_KIND, { ...t.env, source: t.spec }).sources.map((r) => r.source), [t.spec]);
});

test("update: a changed license is reported and re-copied", () => {
  const t = setup();
  write(t.remote, "LICENSE", "MIT v2\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const licenseCopy = path.join(t.env.projectDir, ".toolgate/skills/.licenses", fs.readdirSync(path.join(t.env.projectDir, ".toolgate/skills/.licenses"))[0], "LICENSE");
  assert.equal(report(t.update({ dryRun: true })).licenseChanged, true);
  t.update();
  assert.equal(fs.readFileSync(licenseCopy, "utf8"), "MIT v2\n");
});

test("update: no accept-it hint when the license was copied with the skills that moved; a license that changed alone keeps it", () => {
  const t = setup();
  write(t.remote, "LICENSE", "MIT v2\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const dry = t.update({ dryRun: true });
  assert.equal(report(dry).licenseChanged, true);
  assert.doesNotMatch(formatUpdate(dry, { dryRun: true }), /accept it with/);
  const done = t.update();
  assert.deepEqual(report(done).updated, ["alpha"]);
  assert.equal(report(done).licenseChanged, true, "the field is as it was");
  assert.doesNotMatch(formatUpdate(done, {}), /accept it with/);
  assert.ok(!JSON.stringify(report(done)).includes("licenseCopied"), "and no new field in the JSON");
  const alone = setup();
  write(alone.remote, "LICENSE", "MIT v3\n");
  alone.commit();
  assert.match(formatUpdate(alone.update(), {}), /the license changed upstream \(accept it with:/);
});

test("update: works on the user and local levels and leaves the project alone", () => {
  const t = setup();
  const userDir = tmp("user");
  installSkills({ spec: t.spec, ...t.env, userDir, level: "user", names: ["alpha"] });
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const result = t.update({ userDir, level: "user" });
  assert.deepEqual(report(result).updated, ["alpha"]);
  assert.match(fs.readFileSync(path.join(userDir, "skills/alpha/SKILL.md"), "utf8"), /new body/);
  assert.doesNotMatch(fs.readFileSync(t.copy("alpha"), "utf8"), /new body/);
});

test("update: an empty lock says so", () => {
  const env = { projectDir: tmp("empty"), cache: tmp("cache"), allowFile: true };
  assert.equal(formatUpdate(updateAssets(SKILL_KIND, env)), "toolgate: nothing installed at the project level\n");
});

test("update: a partial update leaves the source behind and each item at the commit it came from", () => {
  const t = setup();
  fs.appendFileSync(t.copy("beta"), "my edit\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  write(t.remote, "skills/beta/SKILL.md", skillMd("beta", "upstream beta"));
  const second = t.commit();
  const result = t.update();
  assert.deepEqual(report(result).updated, ["alpha"]);
  assert.deepEqual(report(result).conflicts, ["beta"]);
  assert.equal(t.lock().skills.alpha.commit, second);
  assert.equal(t.lock().skills.beta.commit, t.first, "the conflicting item still says where it came from");
  assert.equal(t.lock().sources[t.spec].commit, t.first, "the source did not reach the new commit");
  assert.match(formatUpdate(result), /updated 1, restored 0, unchanged 1, kept 0, conflicts 1, skipped 0/);
});

test("update --source: filters to one source; an unknown source or name is reported and exits 1", () => {
  const t = setup();
  const unknownSource = t.update({ source: "github:nope/nope" });
  assert.equal(unknownSource.sources.length, 0);
  assert.equal(unknownSource.unknownSource, "github:nope/nope");
  assert.match(formatUpdate(unknownSource), /nothing was installed from github:nope\/nope/);
  assert.equal(updateExitCode(unknownSource), 1);
  assert.deepEqual(report(t.update({ source: t.spec, names: ["alpha"] })).unchanged, ["alpha"]);
});

test("updateExitCode: errors, unknown names, bad lock names and any open conflict fail", () => {
  const ok = { unchanged: ["a"], updated: [], restored: [], kept: [], pruned: [], conflicts: [], skipped: [], error: null };
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], unknownSource: null, sources: [ok] }), 0);
  assert.equal(updateExitCode({ unknown: ["x"], unknownSource: null, sources: [ok] }), 1);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], unknownSource: null, sources: [{ ...ok, error: "offline" }, ok] }), 1);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], unknownSource: null, sources: [{ ...ok, unchanged: [], conflicts: ["a"] }] }), 1);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], unknownSource: null, sources: [{ ...ok, conflicts: ["b"] }] }), 1);
  assert.equal(updateExitCode({ unknown: [], invalidNames: [], unknownSource: null, invalidNames: ["../x"], sources: [ok] }), 1);
});

test("update: a lock cannot make --prune delete outside the store, or point at a file:// source", () => {
  const t = setup();
  const outside = tmp("outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "x");
  const lockFile = path.join(t.env.projectDir, ".toolgate/skills.lock.json");
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  lock.skills["../../.."] = { ...lock.skills.alpha };
  lock.skills["a/b"] = { ...lock.skills.alpha };
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  const result = t.update({ prune: true, force: true });
  assert.deepEqual(result.unknown, []);
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  assert.deepEqual(report(result).unchanged, ["alpha", "beta", "gamma"]);
  const asked = t.update({ names: ["../../.."] });
  assert.deepEqual(asked.unknown, ["../../.."]);

  lock.sources[t.spec].url = "ext::sh -c touch /tmp/pwned";
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  const refused = updateAssets(SKILL_KIND, { ...t.env, allowFile: false, execFn: () => assert.fail("git must not run") });
  assert.match(report(refused).error, /not a supported/);
});

test("update: dry-run notes list gained MCP servers and non-text files", () => {
  const t = setup();
  write(t.remote, "skills/beta/SKILL.md", skillMd("beta", "body", "mcps: [chrome-devtools]\n"));
  write(t.remote, "skills/beta/bin/tool", "binary-ish");
  t.commit();
  const text = formatUpdate(t.update({ dryRun: true }), { dryRun: true });
  assert.match(text, /! now requires the MCP server chrome-devtools/);
  assert.match(text, /! bin\/tool is not a text file/);
  assert.match(text, /~ SKILL\.md \(\d+ lines? changed\)/);
});

test("replaceUnit-based update keeps the old copy aside until the new one is in place", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  t.update();
  const staging = path.join(t.env.projectDir, ".toolgate/.staging");
  assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
  assert.match(fs.readFileSync(t.copy("alpha"), "utf8"), /new body/);
});
test("update with names: the source commit stays behind while a skill it holds was not asked for", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new alpha"));
  write(t.remote, "skills/beta/SKILL.md", skillMd("beta", "new beta"));
  const second = t.commit();
  t.update({ names: ["alpha"] });
  assert.equal(t.lock().skills.alpha.commit, second);
  assert.equal(t.lock().skills.beta.commit, t.first);
  assert.equal(t.lock().sources[t.spec].commit, t.first);
  t.update();
  assert.equal(t.lock().sources[t.spec].commit, second);
});
test("update: the old copy stays aside until the new one is in place, so a run that dies in between loses nothing", () => {
  const t = setup();
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const real = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => {
    // The first rename moves the old copy aside; the second would put the new one in its place.
    if (++renames === 2) throw new Error("the process died here");
    return real(from, to);
  };
  try {
    assert.match(report(t.update()).error, /died here/);
  } finally {
    fs.renameSync = real;
  }
  const staging = path.join(t.env.projectDir, ".toolgate/.staging");
  const kept = fs.readdirSync(staging, { recursive: true }).filter((name) => name.endsWith("skills-alpha.old"));
  assert.equal(kept.length, 1, "the old copy is in staging");
  assert.match(fs.readFileSync(path.join(staging, kept[0], "SKILL.md"), "utf8"), /body/);
  assert.doesNotMatch(fs.readFileSync(path.join(staging, kept[0], "SKILL.md"), "utf8"), /new body/);
});
test("update: a store or .toolgate that is a symlink is refused, and --prune --force deletes nothing outside", () => {
  const t = setup();
  const outside = tmp("outside");
  write(outside, "alpha/SKILL.md", skillMd("alpha", "precious"));
  fs.rmSync(path.join(t.env.projectDir, ".toolgate/skills"), { recursive: true });
  fs.symlinkSync(outside, path.join(t.env.projectDir, ".toolgate/skills"));
  assert.throws(() => t.update({ prune: true, force: true }), /symlink/);
  assert.match(fs.readFileSync(path.join(outside, "alpha/SKILL.md"), "utf8"), /precious/);
});
test("updateExitCode: an invalid upstream item (skipped) alone fails the run", () => {
  const clean = { unknown: [], unknownSource: null, invalidNames: [], invalidEntries: [] };
  assert.equal(updateExitCode({ ...clean, sources: [{ error: null, conflicts: [], skipped: [{ name: "x", reason: "r" }] }] }), 1);
  assert.equal(updateExitCode({ ...clean, sources: [{ error: null, conflicts: [], skipped: [] }] }), 0);
});
test("update: the license is copied again only when something was updated, never on a run that changes nothing", () => {
  const t = setup();
  const licenses = path.join(t.env.projectDir, ".toolgate/skills/.licenses");
  const licenseCopy = path.join(licenses, fs.readdirSync(licenses)[0], "LICENSE");
  fs.writeFileSync(licenseCopy, "touched by hand\n");
  t.update();
  assert.equal(fs.readFileSync(licenseCopy, "utf8"), "touched by hand\n", "nothing changed: nothing is copied");
});
test("redactCredentials: the whole userinfo goes, even with an @ in the password, and so does a token in the query or fragment", async () => {
  const { redactCredentials } = await import("../src/skills/remote.js");
  assert.equal(redactCredentials("https://user:p@ss@github.com/o/r"), "https://***@github.com/o/r");
  assert.equal(redactCredentials("fatal: unable to access 'https://u:SECRET@h/x/': bad"), "fatal: unable to access 'https://***@h/x/': bad");
  assert.doesNotMatch(redactCredentials("https://github.com/o/r?token=SECRET"), /SECRET/);
  assert.doesNotMatch(redactCredentials("https://github.com/o/r#SECRET"), /SECRET/);
  assert.equal(redactCredentials("github:o/r@abc"), "github:o/r@abc", "not a URL: unchanged");
  assert.equal(redactCredentials("https://github.com/o/r"), "https://github.com/o/r");
});

// A license-only change upstream: no skill moves, the LICENSE does.
const licenseOnly = (t, text = "MIT v2\n") => {
  write(t.remote, "LICENSE", text);
  t.commit();
  const licenses = path.join(t.env.projectDir, ".toolgate/skills/.licenses");
  return path.join(licenses, fs.readdirSync(licenses)[0], "LICENSE");
};
test("update --accept-license: a license-only change is applied only when asked, and the notice names the flag", () => {
  const t = setup();
  const copy = licenseOnly(t);
  const plain = t.update();
  assert.equal(report(plain).licenseChanged, true);
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v1\n", "nothing is accepted by itself");
  assert.match(formatUpdate(plain), /the license changed upstream \(accept it with: toolgate skills update --accept-license\)/);
  assert.equal(updateExitCode(plain), 0, "a notice is not a failure");
  const lockBefore = JSON.stringify(t.lock());
  const accepted = t.update({ acceptLicense: true });
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v2\n");
  assert.deepEqual(report(accepted).licenseAccepted, ["LICENSE"]);
  assert.deepEqual(report(accepted).licenseSkipped, []);
  assert.match(formatUpdate(accepted), /accepted the license of github:|accepted the license of file:/);
  assert.equal(updateExitCode(accepted), 0);
  assert.equal(JSON.stringify(t.lock()), lockBefore, "accepting writes nothing to the lock: the items and the source stay as the plain update left them");
  // Accepted: the next run has nothing to say.
  assert.doesNotMatch(formatUpdate(t.update()), /license/);
});
test("update --accept-license --dry-run says what it would accept and writes nothing", () => {
  const t = setup();
  const copy = licenseOnly(t);
  const dry = t.update({ acceptLicense: true, dryRun: true });
  assert.match(formatUpdate(dry, { dryRun: true }), /would accept the license of .* \(LICENSE\)/);
  assert.deepEqual(report(dry).licenseAccepted, ["LICENSE"], "in a dry run: the files that would be copied");
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v1\n");
});
test("update --accept-license: nothing changed means nothing to accept; a skill updated at the same time brings the license once", () => {
  const t = setup();
  const copy = path.join(t.env.projectDir, ".toolgate/skills/.licenses", fs.readdirSync(path.join(t.env.projectDir, ".toolgate/skills/.licenses"))[0], "LICENSE");
  const idle = t.update({ acceptLicense: true });
  assert.deepEqual(report(idle).licenseAccepted, []);
  assert.doesNotMatch(formatUpdate(idle), /license/);
  write(t.remote, "LICENSE", "MIT v2\n");
  write(t.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  t.commit();
  const both = t.update({ acceptLicense: true });
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v2\n");
  assert.deepEqual(report(both).updated, ["alpha"]);
  assert.deepEqual(report(both).licenseAccepted, ["LICENSE"]);
});
test("update --accept-license replaces a hand-edited copy, and a link planted where the license goes is refused with exit 1", () => {
  const t = setup();
  const copy = licenseOnly(t);
  fs.writeFileSync(copy, "my edit\n");
  assert.equal(report(t.update()).licenseChanged, true, "a hand edit differs from upstream");
  t.update({ acceptLicense: true });
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v2\n");
  // A symlink in place of the folder: nothing is written through it.
  const victim = tmp("victim");
  write(victim, "LICENSE", "keep me\n");
  const folder = path.dirname(copy);
  fs.writeFileSync(copy, "different\n");
  fs.rmSync(folder, { recursive: true });
  fs.symlinkSync(victim, folder);
  const refused = t.update({ acceptLicense: true });
  assert.equal(fs.readFileSync(path.join(victim, "LICENSE"), "utf8"), "keep me\n");
  assert.deepEqual(report(refused).licenseAccepted, []);
  assert.ok(report(refused).licenseSkipped.length > 0);
  assert.match(formatUpdate(refused), /license not copied: /);
  assert.equal(updateExitCode(refused), 1, "it was asked and not done");
});
test("update --accept-license: --source and names limit it to the source asked for; a license removed upstream is not deleted", () => {
  const t = setup();
  const copy = licenseOnly(t);
  const elsewhere = t.update({ acceptLicense: true, source: "github:nobody/else" });
  assert.deepEqual(elsewhere.sources, [], "a source nothing was installed from accepts nothing");
  assert.equal(elsewhere.unknownSource, "github:nobody/else");
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v1\n");
  assert.deepEqual(report(t.update({ acceptLicense: true, names: ["alpha"] })).licenseAccepted, ["LICENSE"], "a name of the source puts its license in scope");
  fs.rmSync(path.join(t.remote, "LICENSE"));
  t.commit();
  const gone = t.update({ acceptLicense: true });
  assert.equal(report(gone).licenseChanged, false);
  assert.equal(fs.readFileSync(copy, "utf8"), "MIT v2\n", "the local copy stays");
});
test("update without --accept-license exits 0 even when a planted link keeps the license from being copied; with the flag the same run exits 1", () => {
  const plant = (t) => {
    const copy = licenseOnly(t);
    const victim = tmp("victim");
    write(victim, "LICENSE", "keep me\n");
    const folder = path.dirname(copy);
    fs.rmSync(folder, { recursive: true });
    fs.symlinkSync(victim, folder);
    return victim;
  };
  // License-only change: no flag means nothing is tried, so nothing is refused.
  const only = setup();
  const victimOnly = plant(only);
  const noFlag = only.update();
  assert.equal(updateExitCode(noFlag), 0);
  assert.equal(fs.readFileSync(path.join(victimOnly, "LICENSE"), "utf8"), "keep me\n");
  // A skill moves too: the license copy is tried with it, refused, and said, but the update itself succeeded.
  const both = setup();
  const victimBoth = plant(both);
  write(both.remote, "skills/alpha/SKILL.md", skillMd("alpha", "new body"));
  both.commit();
  const withSkill = both.update();
  assert.deepEqual(report(withSkill).updated, ["alpha"]);
  assert.ok(report(withSkill).licenseSkipped.length > 0);
  assert.match(formatUpdate(withSkill), /license not copied: /);
  assert.equal(updateExitCode(withSkill), 0, "the flag was not given: a notice, not a failure");
  assert.equal(fs.readFileSync(path.join(victimBoth, "LICENSE"), "utf8"), "keep me\n");
  // The same with the flag is the failure the user asked about.
  const asked = setup();
  plant(asked);
  assert.equal(updateExitCode(asked.update({ acceptLicense: true })), 1);
});

// A run that died between the two renames of a replace: the old copy is set aside in the staging folder of a pid that no
// longer runs, and the store has no copy while the lock still lists it.
function dieMidReplace(t, name = "alpha") {
  write(t.remote, `skills/${name}/SKILL.md`, skillMd(name, "new body"));
  t.commit();
  const real = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => {
    if (++renames === 2) throw new Error("the process died here");
    return real(from, to);
  };
  try {
    assert.match(report(t.update()).error, /died here/);
  } finally {
    fs.renameSync = real;
  }
  const staging = path.join(t.env.projectDir, ".toolgate/.staging");
  const [run] = fs.readdirSync(staging);
  const dead = path.join(staging, "2147483646-aa11bb22");
  fs.renameSync(path.join(staging, run), dead);
  return { staging, dead, aside: path.join(dead, `skills-${name}.old`) };
}
test("update puts back the copy a dead run had set aside when the store lost it, and says so", () => {
  const t = setup();
  const { aside, dead } = dieMidReplace(t);
  assert.equal(fs.existsSync(path.join(t.env.projectDir, ".toolgate/skills/alpha")), false, "the replace died: the store has no alpha");
  assert.ok(fs.existsSync(aside), "the old copy is set aside");
  const next = t.update();
  assert.deepEqual(next.recovered, ["alpha"]);
  assert.match(formatUpdate(next), /toolgate: recovered alpha \(an earlier run died while replacing it; the copy it had set aside is back\)/);
  // Back in the store, alpha is an item to update; without the recovery it would be a missing copy to restore.
  assert.deepEqual(report(next).updated, ["alpha"]);
  assert.deepEqual(report(next).restored, []);
  assert.match(fs.readFileSync(t.copy("alpha"), "utf8"), /new body/);
  assert.equal(fs.existsSync(dead), false, "the dead run's folder is gone");
});
test("a copy set aside is not put back over an item the store has, for a name the lock does not list, for a link, for another store, or in a dry run", () => {
  const t = setup();
  const staging = path.join(t.env.projectDir, ".toolgate/.staging");
  const dead = path.join(staging, "2147483646-aa11bb22");
  fs.mkdirSync(dead, { recursive: true });
  // The item is in the store: the copy aside is dropped, not copied over it.
  write(dead, "skills-alpha.old/SKILL.md", "stale aside\n");
  // Not in the lock; a name that is not a plain one; another store's prefix; a link.
  write(dead, "skills-ghost.old/SKILL.md", skillMd("ghost"));
  write(dead, "skills-....old/SKILL.md", "x\n");
  write(dead, "skills.local-beta.old/SKILL.md", skillMd("beta"));
  fs.rmSync(t.copy("beta"), { recursive: true, force: true });
  fs.rmSync(path.join(t.env.projectDir, ".toolgate/skills/beta"), { recursive: true, force: true });
  const outside = tmp("outside");
  write(outside, "SKILL.md", skillMd("gamma"));
  fs.rmSync(path.join(t.env.projectDir, ".toolgate/skills/gamma"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(dead, "skills-gamma.old"));
  // An entry of a store with another name whose remainder would be a name of this lock.
  write(dead, "locals-gamma.old/SKILL.md", skillMd("gamma"));
  // A lock that lists a name that is not a plain one: even then nothing is put back into a path made of it.
  const lock = t.lock();
  lock.skills["..."] = { ...lock.skills.alpha };
  writeLock(path.join(t.env.projectDir, ".toolgate/skills.lock.json"), lock);
  const dry = t.update({ dryRun: true });
  assert.deepEqual(dry.recovered, []);
  assert.ok(fs.existsSync(dead), "a dry run removes nothing");
  const real = t.update();
  assert.deepEqual(real.recovered, [], "nothing qualified");
  const store = path.join(t.env.projectDir, ".toolgate/skills");
  assert.match(fs.readFileSync(t.copy("alpha"), "utf8"), /body/, "alpha was not overwritten by the stale copy");
  assert.equal(fs.existsSync(path.join(store, "ghost")), false);
  assert.equal(fs.existsSync(path.join(store, "...")), false);
  assert.equal(fs.existsSync(path.join(outside, "..")), true);
  assert.equal(fs.existsSync(dead), false, "the dead run's folder goes");
});
test("install puts back what a dead run set aside too, and reports it", () => {
  const t = setup();
  const dead = path.join(t.env.projectDir, ".toolgate/.staging/2147483646-aa11bb22");
  fs.mkdirSync(dead, { recursive: true });
  fs.renameSync(path.join(t.env.projectDir, ".toolgate/skills/alpha"), path.join(dead, "skills-alpha.old"));
  const again = installSkills({ spec: t.spec, ...t.env });
  assert.deepEqual(again.recovered, ["alpha"]);
  assert.deepEqual(again.unchanged.includes("alpha"), true, "it is back, so the install finds it as it was");
  assert.equal(fs.existsSync(dead), false);
});
