import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledQmdDir, qmdOnPath, useBundledQmd } from "../src/qmdPath.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-qmdpath-"));

// A folder holding an executable `qmd`, like `bin/` of the real package.
function withQmd(executable = true) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "qmd"), "#!/bin/sh\n");
  fs.chmodSync(dir + "/qmd", executable ? 0o755 : 0o644);
  return dir;
}

// A fake installed package: `<root>/dist/index.js` is its import entry and `<root>/bin/qmd` its launcher.
function fakePackage({ launcher = true } = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, "dist"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "");
  if (launcher) {
    fs.writeFileSync(path.join(root, "bin", "qmd"), "#!/usr/bin/env node\n");
    fs.chmodSync(path.join(root, "bin", "qmd"), 0o755);
  }
  return { root, resolveFn: () => pathToFileURL(path.join(root, "dist", "index.js")).href };
}

test("qmdOnPath: finds an executable qmd in any PATH folder, and ignores a file that cannot run", () => {
  const good = withQmd();
  assert.equal(qmdOnPath({ PATH: ["/nowhere", good].join(path.delimiter) }), true);
  assert.equal(qmdOnPath({ PATH: withQmd(false) }), false);
  assert.equal(qmdOnPath({ PATH: tmp() }), false);
  assert.equal(qmdOnPath({ PATH: "" }), false);
  assert.equal(qmdOnPath({}), false);
});

test("bundledQmdDir: the bin folder of the package found through its import entry", () => {
  const pkg = fakePackage();
  assert.equal(bundledQmdDir({ resolveFn: pkg.resolveFn }), path.join(pkg.root, "bin"));
});

test("bundledQmdDir: null when the package is not installed or has no launcher", () => {
  const missing = () => {
    throw new Error("Cannot find package '@tobilu/qmd'");
  };
  assert.equal(bundledQmdDir({ resolveFn: missing }), null);
  assert.equal(bundledQmdDir({ resolveFn: fakePackage({ launcher: false }).resolveFn }), null);
});

test("useBundledQmd: a qmd on the PATH wins and the PATH is left alone", () => {
  const env = { PATH: withQmd() };
  const before = env.PATH;
  assert.equal(useBundledQmd(env, { resolveFn: fakePackage().resolveFn }), "path");
  assert.equal(env.PATH, before);
});

test("useBundledQmd: without one, the bundled bin goes at the end of the PATH", () => {
  const pkg = fakePackage();
  const env = { PATH: ["/usr/bin", "/bin"].join(path.delimiter) };
  assert.equal(useBundledQmd(env, { resolveFn: pkg.resolveFn }), "bundled");
  assert.equal(env.PATH, ["/usr/bin", "/bin", path.join(pkg.root, "bin")].join(path.delimiter));
  assert.equal(qmdOnPath(env), true, "and qmd is now found");
});

test("useBundledQmd: an empty PATH becomes the bundled folder, and nothing happens without a bundled copy", () => {
  const pkg = fakePackage();
  const env = {};
  assert.equal(useBundledQmd(env, { resolveFn: pkg.resolveFn }), "bundled");
  assert.equal(env.PATH, path.join(pkg.root, "bin"));

  const bare = { PATH: "/usr/bin" };
  assert.equal(
    useBundledQmd(bare, {
      resolveFn: () => {
        throw new Error("not installed");
      },
    }),
    "none"
  );
  assert.equal(bare.PATH, "/usr/bin");
});
