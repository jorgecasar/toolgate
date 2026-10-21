import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAllowList } from "../src/allowlist.js";

function tmpConfigFile(contents) {
  const file = path.join(
    os.tmpdir(),
    `toolgate-proxy-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

test("TOOLGATE_ALLOWED_TOOLS env wins and is parsed as CSV", () => {
  const { tools, source } = resolveAllowList({ TOOLGATE_ALLOWED_TOOLS: "foo, bar ,baz" });
  assert.equal(source, "env");
  assert.deepEqual([...tools].sort(), ["bar", "baz", "foo"]);
});

test("TOOLGATE_ALLOWED_TOOLS wins over a present config file", () => {
  const configPath = tmpConfigFile({ servers: { repo: { default: ["fromConfig"] } } });
  const { tools, source } = resolveAllowList({
    TOOLGATE_ALLOWED_TOOLS: "fromEnv",
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(source, "env");
  assert.deepEqual([...tools], ["fromEnv"]);
  fs.unlinkSync(configPath);
});

test("falls back to config file keyed by server + profile when TOOLGATE_ALLOWED_TOOLS is absent", () => {
  const configPath = tmpConfigFile({
    servers: { repo: { default: ["listPRs", "getPR"], review: ["listPRs"] } },
  });

  const defaultProfile = resolveAllowList({
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(defaultProfile.source, "config");
  assert.deepEqual([...defaultProfile.tools].sort(), ["getPR", "listPRs"]);

  const reviewProfile = resolveAllowList({
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
    TOOLGATE_PROFILE: "review",
  });
  assert.equal(reviewProfile.source, "config");
  assert.deepEqual([...reviewProfile.tools], ["listPRs"]);

  fs.unlinkSync(configPath);
});

test("falls back to config file also treats empty TOOLGATE_ALLOWED_TOOLS as absent", () => {
  const configPath = tmpConfigFile({ servers: { repo: { default: ["listPRs"] } } });
  const { tools, source } = resolveAllowList({
    TOOLGATE_ALLOWED_TOOLS: "",
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(source, "config");
  assert.deepEqual([...tools], ["listPRs"]);
  fs.unlinkSync(configPath);
});

test("fail-open when no env and no config file are given", () => {
  const { tools, source } = resolveAllowList({});
  assert.equal(tools, null);
  assert.equal(source, "fail-open");
});

test("fail-open when config file path is set but the server/profile key is missing", () => {
  const configPath = tmpConfigFile({ servers: { other: { default: ["x"] } } });
  const { tools, source } = resolveAllowList({
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(tools, null);
  assert.equal(source, "fail-open");
  fs.unlinkSync(configPath);
});

test("fail-open when config file path does not exist (never breaks the server)", () => {
  const { tools, source } = resolveAllowList({
    TOOLGATE_PROXY_CONFIG: "/nonexistent/toolgate-proxy-config.json",
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(tools, null);
  assert.equal(source, "fail-open");
});

test("fail-open when config file is malformed JSON", () => {
  const configPath = tmpConfigFile("not json");
  fs.writeFileSync(configPath, "{ this is not valid json");
  const { tools, source } = resolveAllowList({
    TOOLGATE_PROXY_CONFIG: configPath,
    TOOLGATE_SERVER: "repo",
  });
  assert.equal(tools, null);
  assert.equal(source, "fail-open");
  fs.unlinkSync(configPath);
});
