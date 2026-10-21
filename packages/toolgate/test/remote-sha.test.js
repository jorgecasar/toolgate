import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchSource } from "../src/skills/remote.js";
import { git as hermeticGit } from "./support/git.js";

const cleanups = [];
const tmp = (name) => (cleanups.push(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-sha-${name}-`))), cleanups.at(-1));
after(() => cleanups.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const git = (cwd, ...args) => hermeticGit(cwd, ...args).trim();

// A real git server (upload-pack over file://) with two commits on main: `old` is reachable but not advertised.
function server() {
  const bare = path.join(tmp("srv"), "srv.git");
  git(os.tmpdir(), "init", "-q", "--bare", bare);
  const work = tmp("work");
  git(work, "init", "-q", "-b", "main");
  git(work, "commit", "-q", "--allow-empty", "-m", "one");
  const old = git(work, "rev-parse", "HEAD");
  git(work, "commit", "-q", "--allow-empty", "-m", "two");
  const tip = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", bare, "main");
  return { url: `file://${bare}`, bare, old, tip };
}
// Servers that speak protocol v0 refuse an object no ref points at, unless they are told otherwise; v2 (the default, and
// what github.com speaks) serves any reachable one. The environment carries the setting to the git that fetchSource runs.
const protocolV0 = () => {
  const before = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.version", GIT_CONFIG_VALUE_0: "0" });
  return () => {
    for (const [name, value] of [["GIT_CONFIG_COUNT", before.count], ["GIT_CONFIG_KEY_0", before.key], ["GIT_CONFIG_VALUE_0", before.value]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

test("a pinned commit is fetched by its SHA, also an old one nothing points at any more (protocol v2, as github.com)", () => {
  const s = server();
  const fetched = fetchSource({ url: s.url, ref: s.old, cache: tmp("cache"), allowFile: true });
  assert.equal(fetched.commit, s.old);
  assert.equal(git(fetched.dir, "rev-parse", "HEAD"), s.old);
  // Again, into the same cache folder: it is refreshed, not an error.
  assert.equal(fetchSource({ url: s.url, ref: s.old, cache: tmp("cache"), allowFile: true }).commit, s.old);
});

test("a server that refuses commits no branch points at says so with its own words, and the tip still works", () => {
  const s = server();
  git(s.bare, "config", "uploadpack.allowAnySHA1InWant", "false");
  git(s.bare, "config", "uploadpack.allowReachableSHA1InWant", "false");
  const restore = protocolV0();
  try {
    assert.throws(
      () => fetchSource({ url: s.url, ref: s.old, cache: tmp("cache"), allowFile: true }),
      (error) => error.message.includes("does not serve commits by SHA") && error.message.includes(s.old) && /Server does not allow request for unadvertised object/.test(error.message),
    );
    assert.equal(fetchSource({ url: s.url, ref: s.tip, cache: tmp("cache"), allowFile: true }).commit, s.tip, "an advertised commit is served");
  } finally {
    restore();
  }
});

test("a commit the server never had is told apart from a server that refuses SHAs", () => {
  const s = server();
  const missing = "0".repeat(40);
  assert.throws(
    () => fetchSource({ url: s.url, ref: missing, cache: tmp("cache"), allowFile: true }),
    (error) => error.message.includes(`the pinned commit ${missing} no longer exists`) && !error.message.includes("does not serve commits by SHA"),
  );
});
