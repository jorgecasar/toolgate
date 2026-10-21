import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "toolgate.js");

// Opt-in: it calls the real `claude` (network, quota). Run with TOOLGATE_REAL_CLAUDE=1.
test("toolgate claude -p runs the real claude and returns its exit code", { skip: !process.env.TOOLGATE_REAL_CLAUDE }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "toolgate-real-"));
  const result = spawnSync(process.execPath, [BIN, "--no-route", "claude", "-p", "Reply with exactly: ok"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.toLowerCase(), /ok/);
});
