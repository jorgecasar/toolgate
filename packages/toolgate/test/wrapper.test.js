import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { exitCode, extractPrompt, forwardSignals, isSubcommand, splitAgentArgs, splitLaunchArgs, withResume } from "../src/wrapper.js";

const spec = {
  bin: "agent",
  subcommands: ["mcp", "doctor", "update"],
  valueFlags: ["--model", "--settings"],
  booleanFlags: ["-p", "--print", "-c", "--continue"],
};
const isAgent = (name) => ["claude", "codex"].includes(name);

test("splitAgentArgs: toolgate flags go before the agent, the rest is untouched", () => {
  assert.deepEqual(splitAgentArgs(["claude", "--resume"], isAgent), { before: [], agent: "claude", after: ["--resume"] });
  assert.deepEqual(splitAgentArgs(["--no-route", "--adapter", "codex", "claude", "--model", "haiku", "hi"], isAgent), {
    before: ["--no-route", "--adapter", "codex"],
    agent: "claude",
    after: ["--model", "haiku", "hi"],
  });
});

test("splitAgentArgs: commands and bare prompts are not the wrapper form", () => {
  assert.equal(splitAgentArgs(["init"], isAgent), null);
  assert.equal(splitAgentArgs(["do the thing"], isAgent), null);
  assert.equal(splitAgentArgs(["--json", "route", "--prompt", "claude"], isAgent), null);
  assert.equal(splitAgentArgs([], isAgent), null);
});

test("isSubcommand: only the first argument counts", () => {
  assert.equal(isSubcommand(["mcp", "list"], spec), true);
  assert.equal(isSubcommand(["-p", "mcp"], spec), false);
  assert.equal(isSubcommand([], spec), false);
});

test("extractPrompt: unambiguous cases", () => {
  assert.equal(extractPrompt(["-p", "fix it"], spec), "fix it");
  assert.equal(extractPrompt(["--print", "fix it"], spec), "fix it");
  assert.equal(extractPrompt(["fix it"], spec), "fix it");
  assert.equal(extractPrompt(["--model", "haiku", "hi"], spec), "hi");
  assert.equal(extractPrompt(["--model=haiku", "-c", "hi"], spec), "hi");
  assert.equal(extractPrompt(["--", "hi"], spec), "hi");
});

test("extractPrompt: when in doubt there is no prompt", () => {
  assert.equal(extractPrompt([], spec), undefined);
  assert.equal(extractPrompt(["--resume"], spec), undefined);
  assert.equal(extractPrompt(["--model", "haiku"], spec), undefined, "a flag value is not a prompt");
  assert.equal(extractPrompt(["--unknown", "hi"], spec), undefined, "unknown arity");
  assert.equal(extractPrompt(["--add-dir", "a", "b", "hi"], spec), undefined);
  assert.equal(extractPrompt(["hi", "--model", "haiku"], spec), undefined, "not trailing");
});

test("withResume appends the resume argument once", () => {
  assert.deepEqual(withResume(["-p", "x"], "--continue", true), ["-p", "x", "--continue"]);
  assert.deepEqual(withResume(["--continue"], "--continue", true), ["--continue"]);
  assert.deepEqual(withResume(["x"], "--continue", false), ["x"]);
  assert.deepEqual(withResume(["x"], undefined, true), ["x"]);
});

test("exitCode: the child's code, 128 + signal, or 0", () => {
  assert.equal(exitCode({ code: 3, signal: null }), 3);
  assert.equal(exitCode({ code: null, signal: "SIGTERM" }), 128 + 15);
  assert.equal(exitCode({ code: null, signal: null }), 0);
});

test("forwardSignals relays signals to the child and stops when asked", () => {
  const source = new EventEmitter();
  const killed = [];
  const stop = forwardSignals({ kill: (signal) => killed.push(signal) }, source);
  source.emit("SIGTERM");
  source.emit("SIGINT");
  stop();
  source.emit("SIGTERM");
  assert.deepEqual(killed, ["SIGTERM", "SIGINT"]);
});
test("splitLaunchArgs: a flag that takes a value keeps it, so a session id is not read as the task", () => {
  assert.deepEqual(splitLaunchArgs(["--model", "opus"], spec), { prompt: undefined, agentArgs: ["--model", "opus"] });
  assert.deepEqual(splitLaunchArgs(["--model", "opus", "do it"], spec), { prompt: "do it", agentArgs: ["--model", "opus"] });
  assert.deepEqual(splitLaunchArgs(["do it", "--model=opus", "-p"], spec), { prompt: "do it", agentArgs: ["--model=opus", "-p"] });
  assert.deepEqual(splitLaunchArgs([], spec), { prompt: undefined, agentArgs: [] });
  assert.deepEqual(splitLaunchArgs(["--", "-x"], spec), { prompt: undefined, agentArgs: ["-x"] });
});

// A flag with an optional value (claude's `--resume [value]`): the next word is the value unless it starts with `-`.
const optionalSpec = { ...spec, optionalValueFlags: ["--resume", "-r", "--from-pr", "--teleport"] };
test("an optional-value flag takes the next word as its value, and a flag after it means it has none", () => {
  // [args, prompt of splitLaunchArgs, agentArgs of splitLaunchArgs, prompt of extractPrompt (the trailing one)]
  const cases = [
    [["--resume"], undefined, ["--resume"], undefined],
    [["--resume", "abc-123"], undefined, ["--resume", "abc-123"], undefined],
    [["--resume", "abc-123", "do it"], "do it", ["--resume", "abc-123"], "do it"],
    [["--resume", "do it"], undefined, ["--resume", "do it"], undefined],
    [["-r", "do it"], undefined, ["-r", "do it"], undefined],
    [["-r", "abc", "do it"], "do it", ["-r", "abc"], "do it"],
    [["--resume=abc", "do it"], "do it", ["--resume=abc"], "do it"],
    [["--resume", "--model", "x", "do it"], "do it", ["--resume", "--model", "x"], "do it"],
    [["--resume", "--unknown", "do it"], "do it", ["--resume", "--unknown"], undefined],
    [["do it", "--resume"], "do it", ["--resume"], undefined],
    [["--from-pr", "12", "do it"], "do it", ["--from-pr", "12"], "do it"],
    [["--teleport", "do it"], undefined, ["--teleport", "do it"], undefined],
    [["--resume", "--", "do it"], undefined, ["--resume", "do it"], "do it"],
  ];
  for (const [args, prompt, agentArgs, trailing] of cases) {
    assert.deepEqual(splitLaunchArgs(args, optionalSpec), { prompt, agentArgs }, `split ${JSON.stringify(args)}`);
    assert.equal(extractPrompt(args, optionalSpec), trailing, `extract ${JSON.stringify(args)}`);
  }
});
test("a flag that is not declared optional keeps its arity: the next word is not its value", () => {
  assert.deepEqual(splitLaunchArgs(["--resume", "abc"], spec), { prompt: "abc", agentArgs: ["--resume"] });
  assert.equal(extractPrompt(["--resume", "abc"], spec), undefined, "unknown arity");
});
