import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../../../scripts/check-recommended.js", import.meta.url).pathname;

// A `git` that answers `init` and fails `fetch` with the message of a real failure.
function run(stderr) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-"));
  const git = path.join(bin, "git");
  fs.writeFileSync(git, `#!/bin/sh\ncase "$*" in\n  *fetch*) printf '%s\\n' ${JSON.stringify(stderr)} >&2; exit 128;;\n  *) exit 0;;\nesac\n`);
  fs.chmodSync(git, 0o755);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-tmp-")) } });
  return { code: result.status, text: `${result.stdout}${result.stderr}` };
}

test("the weekly check fails (BROKEN) when the repository is gone, private or the commit was removed", () => {
  for (const message of ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r/' not found", "fatal: Authentication failed for 'https://github.com/o/r/'", "fatal: remote error: upload-pack: not our ref abc"]) {
    const { code, text } = run(message);
    assert.equal(code, 1, text);
    assert.match(text, /BROKEN/);
  }
});

test("the weekly check does not call a network failure broken, but fails when no source could be reached at all", () => {
  const { code, text } = run("fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com");
  assert.match(text, /UNREACHABLE/);
  assert.doesNotMatch(text, /BROKEN/);
  assert.match(text, /no recommended source could be reached/);
  assert.equal(code, 1, "the only shipped source was unreachable: nothing was checked");
});

test("the weekly check runs git in English, so that a machine in another language still reads a gone repository as BROKEN", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-"));
  const git = path.join(bin, "git");
  // What git prints depends on the locale it is given, as on a real machine.
  const body = `#!/bin/sh
case "$*" in
  *fetch*) if [ "$LC_ALL" = C ] && [ "$LANGUAGE" = C ]; then printf '%s\\n' "fatal: repository 'https://github.com/o/r/' not found" >&2; else printf '%s\\n' "fatal: repositorio 'https://github.com/o/r/' no encontrado" >&2; fi; exit 128;;
  *) exit 0;;
esac
`;
  fs.writeFileSync(git, body);
  fs.chmodSync(git, 0o755);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, LC_ALL: "es_ES.UTF-8", LANGUAGE: "es", PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-tmp-")) } });
  assert.match(`${result.stdout}${result.stderr}`, /BROKEN/);
  assert.equal(result.status, 1);
});

test("the weekly check takes another list: a reachable pin is ok, a missing commit and a missing repository are BROKEN, in one run", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-"));
  const git = path.join(bin, "git");
  // What GitHub answers: the repository is not found, or the server does not have the commit; anything else works.
  fs.writeFileSync(git, `#!/bin/sh
case "$*" in
  *this-repo-does-not-exist*) printf '%s\\n' "remote: Repository not found." "fatal: repository 'https://github.com/o/gone/' not found" >&2; exit 128;;
  *fetch*0000000000000000000000000000000000000000*) printf '%s\\n' "fatal: remote error: upload-pack: not our ref 0000000000000000000000000000000000000000" >&2; exit 128;;
  *checkout*) mkdir -p "$2/skills/alpha" && : > "$2/skills/alpha/SKILL.md"; exit 0;;
  *) exit 0;;
esac
`);
  fs.chmodSync(git, 0o755);
  const entry = (id, source, commit) => ({ id, source, commit, license: "MIT", skills: ["alpha"] });
  const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-list-")), "list.json");
  fs.writeFileSync(list, JSON.stringify({ version: 1, recommended: [entry("t/ok", "github:o/ok", "a".repeat(40)), entry("t/bad-sha", "github:o/ok", "0".repeat(40)), entry("t/gone", "github:o/this-repo-does-not-exist", "b".repeat(40))] }));
  const result = spawnSync(process.execPath, [script, list], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-fakegit-tmp-")) } });
  const text = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, text);
  assert.match(text, /BROKEN t\/bad-sha: pinned commit 0{40} or its repository is gone upstream/);
  assert.match(text, /BROKEN t\/gone: [\s\S]*Repository not found/);
  assert.doesNotMatch(text, /BROKEN t\/ok/);
});
