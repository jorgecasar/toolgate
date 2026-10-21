import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_CLASS, CLASS_BEHAVIOR, resolveClientClass, classBehavior } from "../src/capability.js";
import { capability as claudeCode } from "../src/adapters/claude-code.js";
import { capability as codex } from "../src/adapters/codex.js";
import { capability as antigravity } from "../src/adapters/antigravity.js";
import { capability as karajan } from "../src/adapters/karajan.js";

test("DEFERRED class: tool schemas deferred, routing over per-tool filtering", () => {
  const behavior = CLASS_BEHAVIOR.DEFERRED;
  assert.equal(behavior.defersToolSchemas, true);
  assert.equal(behavior.filterTools, false);
  assert.equal(behavior.route, true);
});

test("LAUNCHED class: all tool schemas at launch, per-tool filtering saves tokens", () => {
  const behavior = CLASS_BEHAVIOR.LAUNCHED;
  assert.equal(behavior.defersToolSchemas, false);
  assert.equal(behavior.filterTools, true);
  assert.equal(behavior.route, false);
});

test("resolveClientClass maps the adapter default to a class", () => {
  assert.equal(resolveClientClass(true), CLIENT_CLASS.DEFERRED);
  assert.equal(resolveClientClass(false), CLIENT_CLASS.LAUNCHED);
});

test("resolveClientClass: a boolean override wins over the adapter default", () => {
  assert.equal(resolveClientClass(true, false), CLIENT_CLASS.LAUNCHED);
  assert.equal(resolveClientClass(false, true), CLIENT_CLASS.DEFERRED);
});

test("resolveClientClass: null/undefined override falls back to the adapter default", () => {
  assert.equal(resolveClientClass(true, null), CLIENT_CLASS.DEFERRED);
  assert.equal(resolveClientClass(false, undefined), CLIENT_CLASS.LAUNCHED);
});

test("classBehavior returns the descriptor for a known class", () => {
  assert.equal(classBehavior(CLIENT_CLASS.DEFERRED), CLASS_BEHAVIOR.DEFERRED);
  assert.equal(classBehavior(CLIENT_CLASS.LAUNCHED), CLASS_BEHAVIOR.LAUNCHED);
});

test("classBehavior fails loudly on an unknown class", () => {
  assert.throws(() => classBehavior("Z"), /unknown client class/i);
});

test("every adapter declares capability metadata resolving to a class", () => {
  assert.equal(resolveClientClass(claudeCode.defersToolSchemas), CLIENT_CLASS.DEFERRED);
  assert.equal(resolveClientClass(codex.defersToolSchemas), CLIENT_CLASS.LAUNCHED);
  assert.equal(resolveClientClass(antigravity.defersToolSchemas), CLIENT_CLASS.LAUNCHED);
  assert.equal(resolveClientClass(karajan.defersToolSchemas), CLIENT_CLASS.LAUNCHED);
});

test("a config override flips an adapter's resolved class", () => {
  assert.equal(resolveClientClass(claudeCode.defersToolSchemas, false), CLIENT_CLASS.LAUNCHED);
  assert.equal(resolveClientClass(codex.defersToolSchemas, true), CLIENT_CLASS.DEFERRED);
});

test("behavior descriptors are frozen (immutable data model)", () => {
  assert.throws(() => {
    "use strict";
    CLASS_BEHAVIOR.DEFERRED.filterTools = true;
  }, TypeError);
});

import { computeTier, whatWouldRaise, validateCapability } from "../src/capability.js";

const cap = (patch) =>
  Object.freeze({
    defersToolSchemas: false,
    rules: { kind: "none" },
    launchGating: "none",
    exclusiveMcpConfig: false,
    resume: { supported: false },
    dynamicTools: false,
    passthrough: "args",
    ...patch,
  });

test("tiers stack: rules, launch gating, resume, dynamic tools", () => {
  const rules = { kind: "projectFile", path: "r.md" };
  assert.equal(computeTier(cap({})), 0);
  assert.equal(computeTier(cap({ rules })), 1);
  assert.equal(computeTier(cap({ rules, launchGating: "configFile" })), 2);
  assert.equal(computeTier(cap({ rules, launchGating: "configFile", resume: { supported: true, arg: "-c" } })), 3);
  assert.equal(
    computeTier(cap({ rules, launchGating: "settingsFlag", resume: { supported: true, arg: "-c" }, dynamicTools: true })),
    4,
  );
  assert.equal(computeTier(cap({ launchGating: "configFile" })), 0, "gating without rules stays at tier 0");
});

test("whatWouldRaise says unknown instead of guessing, and null at the top", () => {
  assert.match(whatWouldRaise(cap({ rules: { kind: "unknown" } })), /unknown whether/);
  assert.match(whatWouldRaise(cap({})), /needs an agent that can/);
  const top = cap({
    rules: { kind: "launchInjection" },
    launchGating: "flagOverrides",
    resume: { supported: true, arg: "x" },
    dynamicTools: true,
  });
  assert.equal(whatWouldRaise(top), null);
});

test("validateCapability accepts unknown values", () => {
  assert.deepEqual(validateCapability(cap({ dynamicTools: "unknown", resume: { supported: "unknown" } })), []);
});
