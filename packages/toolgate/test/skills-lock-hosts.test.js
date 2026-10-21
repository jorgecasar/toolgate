// A lock is a file in the repository: it must not make `update` or `status --remote` contact this machine or its network (#164).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKILL_KIND, writeLock } from "../src/skills/install.js";
import { assetStatus } from "../src/skills/status.js";
import { updateAssets } from "../src/skills/update.js";
import { gitEnv, hostOfSource, lockSourceUrl, privateHostReason } from "../src/skills/remote.js";
import { execFileSync } from "node:child_process";
import { run } from "../src/cli.js";
import { configLayerPaths, loadConfig } from "../src/config.js";
import { applyChange } from "../src/configFile.js";
import { git } from "./support/git.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-lh-${name}-`)));
  made.push(dir);
  return dir;
};
const COMMIT = "a".repeat(40);

// A project whose lock names `url` for a skill; `execFn` records every call to git.
function project(url, { user = null } = {}) {
  const projectDir = tmp("proj");
  const home = tmp("home");
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg"), TOOLGATE_DEFAULTS: path.join(home, "config.json") };
  if (user) fs.writeFileSync(env.TOOLGATE_DEFAULTS, JSON.stringify(user));
  fs.mkdirSync(path.join(projectDir, ".toolgate/skills/alpha"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".toolgate/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: a\n---\nbody\n");
  const lockFile = path.join(projectDir, ".toolgate/skills.lock.json");
  writeLock(lockFile, { version: 1, sources: { [url]: { url, commit: COMMIT } }, skills: { alpha: { source: url, path: "skills/alpha", hash: "sha256:00" } } });
  const calls = [];
  const execFn = (bin, args, options) => (calls.push({ args, env: options?.env }), (() => { throw new Error("fatal: unable to access"); })());
  return { projectDir, home, env, calls, execFn };
}
const BAD = ["https://127.0.0.1/x/y", "https://localhost/x/y", "https://169.254.169.254/x/y", "https://10.1.2.3/x/y", "https://192.168.0.5/x/y", "https://[::1]/x/y", "https://2130706433/x/y", "https://0x7f.1/x/y", "ssh://git@127.0.0.1/x/y.git", "ssh://git@localhost/x/y.git", "ssh://git@[fd00::1]/x/y.git", "git@192.168.1.4:x/y.git", "https://app.localhost/x/y"];
// Spellings of the same addresses that git, curl and ssh still read as this machine (#165 review).
const SPELLINGS = {
  percentEncoded: ["https://%31%32%37.0.0.1/x/y", "https://127.0.0.%31/x/y", "ssh://git@%31%32%37.0.0.1/x/y.git", "git@127.0.0.%31:x/y"],
  trailingDot: ["https://localhost./x/y", "ssh://git@localhost./x/y.git", "git@localhost.:x/y", "https://127.0.0.1./x/y"],
  ipv6Forms: ["https://[0:0:0:0:0:0:0:1]/x/y", "https://[::0001]/x/y", "https://[::127.0.0.1]/x/y", "https://[::ffff:7f00:1]/x/y", "https://[::ffff:127.0.0.1]/x/y", "https://[::ffff:0:127.0.0.1]/x/y", "https://[::ffff:0:7f00:1]/x/y", "git@[::ffff:0:7f00:1]:x/y", "ssh://git@[0:0:0:0:0:0:0:1]/x/y.git"],
  embedded: ["https://[64:ff9b::7f00:1]/x/y", "https://[64:ff9b::a00:1]/x/y", "https://[2002:7f00:1::]/x/y", "https://[2002:c0a8:1::1]/x/y", "https://[64:ff9b:1::1]/x/y"],
  numericForms: ["ssh://git@4294967296/x/y.git", "git@4294967296:x/y", "ssh://git@4294967297/x/y.git", "ssh://git@0x100000000/x/y.git", "ssh://git@0x.1/x/y.git", "git@0x.1:x/y", "ssh://git@0x/x/y.git", "ssh://git@1.2.3.4.5/x/y.git", "ssh://git@99999999999/x/y.git", "git@0300.0250.0.1:x/y"],
  leadingZeros: ["ssh://git@010.0.0.1/x/y.git", "git@0127.0.0.1:x/y", "ssh://git@00127.0.0.1/x/y.git", "ssh://git@0251.0.0.1/x/y.git", "git@0254.0.0.1:x/y", "ssh://git@8.8.8.08/x/y.git", "ssh://git@01.2.3.4/x/y.git"],
  leadingZeroTails: ["git@[::ffff:0127.0.0.1]:o/r.git", "git@[::ffff:010.0.0.1]:o/r.git", "git@[::010.0.0.1]:o/r.git", "git@[64:ff9b::010.0.0.1]:o/r.git", "git@[::ffff:8.8.8.08]:o/r.git", "git@[::ffff:172.016.0.1]:o/r.git", "git@[64:ff9b::1.2.3.010]:o/r.git", "git@[::ffff:1.02.3.4]:o/r.git"],
  leadingZeroLabels: ["ssh://git@172.016.0.1/x/y.git", "git@1.2.3.010:x/y", "ssh://git@1.02.3.4/x/y.git", "git@8.8.08.8:x/y"],
  scpIpv6: ["git@[::1]:x/y", "git@[fd00::1]:x/y", "git@[fe80::1]:x/y", "git@[::ffff:127.0.0.1]:x/y"],
};

test("update and status --remote never start git for a lock that names this machine or its network", () => {
  for (const url of BAD) {
    const t = project(url);
    const update = updateAssets(SKILL_KIND, { projectDir: t.projectDir, userDir: t.home, cache: tmp("cache"), execFn: t.execFn, env: t.env, homedir: t.home });
    assert.match(update.sources[0].error, /is (localhost|a loopback, private or link-local address|a host that resolvers read differently[^:]*): a lock file is not trusted to name it/, url);
    const status = assetStatus({ projectDir: t.projectDir, userDir: t.home, levels: ["project"], remote: true, execFn: t.execFn, env: t.env, homedir: t.home });
    assert.match(status.upstream[0].error, /a lock file is not trusted to name it/, url);
    assert.deepEqual(t.calls, [], `git was started for ${url}`);
  }
});

test("every spelling of this machine is refused in update and status --remote: percent-encoded, trailing dot, IPv6 forms, embedded IPv4, scp-like IPv6", () => {
  for (const [family, urls] of Object.entries(SPELLINGS)) {
    for (const url of urls) {
      const t = project(url);
      const update = updateAssets(SKILL_KIND, { projectDir: t.projectDir, userDir: t.home, cache: tmp("cache"), execFn: t.execFn, env: t.env, homedir: t.home });
      assert.match(update.sources[0].error, /a lock file is not trusted to name it/, `${family}: ${url}`);
      const status = assetStatus({ projectDir: t.projectDir, userDir: t.home, levels: ["project"], remote: true, execFn: t.execFn, env: t.env, homedir: t.home });
      assert.match(status.upstream[0].error, /a lock file is not trusted to name it/, `${family}: ${url}`);
      assert.deepEqual(t.calls, [], `git was started for ${url}`);
    }
  }
});

test("what a lock may name: a DNS name, a canonical public IPv4 or a canonical public IPv6; everything else is refused, and says why", () => {
  const accepted = ["https://github.com/a/b", "https://git.example.org/a/b", "ssh://git@git2.example.org/a/b.git", "ssh://git@v1.example.org/a/b.git", "git@host-10.example.org:a/b", "ssh://git@host.0a.example/a/b.git", "ssh://git@01.example.org/a/b.git", "git@007.example.org:a/b", "ssh://git@git.example.org./a/b.git", "ssh://git@8.8.8.8/a/b.git", "https://8.8.8.8/a/b", "https://[2606:4700::1111]/a/b", "https://[2001:db8::1]/a/b", "git@[2606:4700::1111]:a/b", "git@[::ffff:808:808]:a/b", "git@[64:ff9b::808:808]:a/b", "https://[2002:808:808::1]/a/b", "https://[2001:DB8::1]/a/b"];
  for (const url of accepted) assert.equal(privateHostReason(hostOfSource(url)), null, url);
  const private_ = ["https://127.0.0.1/a/b", "https://10.1.2.3/a/b", "https://169.254.169.254/a/b", "https://[::1]/a/b", "git@[fd00::1]:a/b", "https://[::ffff:7f00:1]/a/b", "https://localhost/a/b", "https://a.localhost/a/b", "ssh://git@localhost./a/b.git"];
  for (const url of private_) assert.match(privateHostReason(hostOfSource(url)), /localhost|loopback, private or link-local/, url);
  const ambiguous = [
    "https://%67ithub.com/a/b", "https://%zz.example/a/b", "https://127.0.0.%31/a/b", // percent escapes are never decoded
    "ssh://git@4294967296/a/b.git", "ssh://git@0x100000000/a/b.git", "ssh://git@0x.1/a/b.git", "ssh://git@0x/a/b.git", "https://2130706433/a/b", "https://0x7f.1/a/b", "https://127.1/a/b", "ssh://git@1.2.3.4.5/a/b.git", // numbers, hex, short forms
    "ssh://git@010.0.0.1/a/b.git", "git@0127.0.0.1:a/b", "ssh://git@8.8.8.08/a/b.git", "ssh://git@172.016.0.1/a/b.git", "git@1.2.3.010:a/b", // leading zeros
    "https://256.1.1.1/a/b", "https://[0:0:0:0:0:0:0:1]/a/b", "https://[::0001]/a/b", "git@[::ffff:127.0.0.1]:a/b", "git@[::ffff:8.8.8.8]:a/b", "git@[::ffff:0127.0.0.1]:a/b", "git@[64:ff9b::1.2.3.4]:a/b", "https://[1:2:3:4:5:6:7:8:9]/a/b", "https://[g::1]/a/b", "git@[::1:x/y", "git@[fe80::1%25en0]:a/b", // not canonical IPv6
    "https://-bad.example/a/b", "https://under_score.example/a/b",
  ];
  for (const url of ambiguous) assert.match(privateHostReason(hostOfSource(url)) ?? "NOT REFUSED", /resolvers read differently/, url);
});

test("a public host still works, and ssh is run with strict host key checking", () => {
  const t = project("ssh://git@git.example.org/x/y.git");
  updateAssets(SKILL_KIND, { projectDir: t.projectDir, userDir: t.home, cache: tmp("cache"), execFn: t.execFn, env: t.env, homedir: t.home });
  assetStatus({ projectDir: t.projectDir, userDir: t.home, levels: ["project"], remote: true, execFn: t.execFn, env: t.env, homedir: t.home });
  assert.ok(t.calls.length >= 2, "git was started for a public host");
  for (const call of t.calls) assert.match(call.env.GIT_SSH_COMMAND, /-o BatchMode=yes -o StrictHostKeyChecking=yes$/);
  assert.doesNotMatch(gitEnv().GIT_SSH_COMMAND, /StrictHostKeyChecking/, "a source the user types keeps the user's own ssh settings");
});

test("a host the user lists in their own config is allowed; the same list in the project config is not", () => {
  const url = "https://192.168.0.5/x/y";
  const allowed = project(url, { user: { skills: { allowedHosts: ["192.168.0.5"] } } });
  updateAssets(SKILL_KIND, { projectDir: allowed.projectDir, userDir: allowed.home, cache: tmp("cache"), execFn: allowed.execFn, env: allowed.env, homedir: allowed.home });
  assert.ok(allowed.calls.length > 0, "the user's own list allows it");
  const local = project(url);
  fs.writeFileSync(path.join(local.projectDir, ".toolgate/config.local.json"), JSON.stringify({ skills: { allowedHosts: ["192.168.0.5"] } }));
  updateAssets(SKILL_KIND, { projectDir: local.projectDir, userDir: local.home, cache: tmp("cache"), execFn: local.execFn, env: local.env, homedir: local.home });
  assert.ok(local.calls.length > 0, "and so does the local, gitignored one");
  const committed = project(url);
  fs.writeFileSync(path.join(committed.projectDir, ".toolgate/config.json"), JSON.stringify({ skills: { allowedHosts: ["192.168.0.5"] } }));
  const refused = updateAssets(SKILL_KIND, { projectDir: committed.projectDir, userDir: committed.home, cache: tmp("cache"), execFn: committed.execFn, env: committed.env, homedir: committed.home });
  assert.match(refused.sources[0].error, /not trusted to name it/);
  assert.deepEqual(committed.calls, []);
  assert.throws(() => applyChange({}, { action: "add", key: "skills.allowedHosts", value: "192.168.0.5", layer: "project" }), /use --user or --local/);
  assert.equal(applyChange({}, { action: "add", key: "skills.allowedHosts", value: "192.168.0.5", layer: "user" }), true);
});

test("a local config that git versions cannot allow a host, as a committed one cannot", () => {
  const url = "https://192.168.0.5/x/y";
  const tracked = project(url);
  const file = path.join(tracked.projectDir, ".toolgate/config.local.json");
  fs.writeFileSync(file, JSON.stringify({ skills: { allowedHosts: ["192.168.0.5"] } }));
  git(tracked.projectDir, "init", "-q");
  git(tracked.projectDir, "add", "-f", ".toolgate/config.local.json");
  const refused = updateAssets(SKILL_KIND, { projectDir: tracked.projectDir, userDir: tracked.home, cache: tmp("cache"), execFn: tracked.execFn, env: tracked.env, homedir: tracked.home });
  assert.match(refused.sources[0].error, /not trusted to name it/);
  assert.deepEqual(tracked.calls, [], "git was not started for it");
  // The same file, in a repository that does not version it, does allow it.
  const own = project(url);
  fs.writeFileSync(path.join(own.projectDir, ".toolgate/config.local.json"), JSON.stringify({ skills: { allowedHosts: ["192.168.0.5"] } }));
  git(own.projectDir, "init", "-q");
  updateAssets(SKILL_KIND, { projectDir: own.projectDir, userDir: own.home, cache: tmp("cache"), execFn: own.execFn, env: own.env, homedir: own.home });
  assert.ok(own.calls.length > 0, "an unversioned local file allows it");
});

test("the classifier on bare hosts, and what hostOfSource reads", () => {
  for (const host of ["localhost", "a.localhost", "127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::1", "::", "fe80::1", "fd12::1", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:c0a8:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "2001:0:1::1", "fec0::1", "ff02::1"]) {
    assert.ok(privateHostReason(host) && !/resolvers read differently/.test(privateHostReason(host)), host);
  }
  for (const host of ["github.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "192.169.0.1", "2001:db8::1", "1:2:3:4:5:6:7:8", "::ffff:0:808:808", "2001:db8::1:0:0:1", "2001:db8:0:1:1:1:1:1", null, ""]) {
    assert.equal(privateHostReason(host), null, String(host));
  }
  assert.match(privateHostReason(undefined), /resolvers read differently/);
  for (const url of ["ssh://git@/x/y.git", "ssh://git@:22/x/y.git", "https://:8443/x/y"]) assert.equal(hostOfSource(url), undefined, url);
  for (const host of ["2001:db8::1::1", "2001:db8:::1", "2001:0db8::1", "2001:db8:0:0:0:0:0:1", "::ffff:1.2.3.4"]) assert.match(privateHostReason(host), /resolvers read differently/, host);
  assert.equal(hostOfSource("https://user@Example.org:8443/a/b"), "example.org");
  assert.equal(hostOfSource("git@Host.example:a/b.git"), "host.example");
  assert.equal(hostOfSource("ssh://git@[fd00::1]:22/a"), "fd00::1");
  assert.equal(hostOfSource("file:///tmp/x"), null);
  assert.equal(lockSourceUrl("file:///tmp/x", {}, { allowFile: true }), "file:///tmp/x");
});
