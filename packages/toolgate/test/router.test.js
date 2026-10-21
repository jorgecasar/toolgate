import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applyRouting } from "../src/cli.js";
import { formatNeed, resolveNeed } from "../src/need.js";
import { CARD_MARKER, defaultCollection } from "../src/skills/corpus.js";
import {
  route,
  registerBackend,
  getBackend,
  resetBackends,
  createQmdBackend,
  parseQmdJson,
} from "../src/router.js";

beforeEach(() => resetBackends());

const baseConfig = {
  skills: { collection: "skills" },
  baseline: ["docs"],
  keywords: {
    repo: ["pull request", "\\bPR\\b", "branch", "merge"],
    tasks: ["\\bticket\\b", "sprint", "backlog"],
  },
  serverMeta: {
    repo: { tier: "expensive" },
    tasks: { tier: "expensive" },
  },
};

test("route: regex backend matches keyword patterns in the prompt", async () => {
  const result = await route("review this pull request please", baseConfig);
  assert.deepEqual(result.servers, ["repo"]);
  assert.match(result.reason, /pull request/);
});

test("route: regex backend matches self-match (server name as a word)", async () => {
  const result = await route("check the repo for issues", baseConfig);
  assert.deepEqual(result.servers, ["repo"]);
  assert.match(result.reason, /self-match for repo/);
});

test("route: regex backend is case-insensitive", async () => {
  const result = await route("CHECK THE REPO FOR ISSUES", baseConfig);
  assert.deepEqual(result.servers, ["repo"]);
});

test("route: no match returns empty servers list", async () => {
  const result = await route("what is the weather today", baseConfig);
  assert.deepEqual(result.servers, []);
  assert.equal(result.reason, "No keyword matches found");
});

test("route: baseline servers are excluded from the result (cheap tier)", async () => {
  const result = await route("docs is my favorite server", baseConfig);
  assert.ok(!result.servers.includes("docs"));
});

test("route: servers marked tier=cheap in serverMeta are excluded", async () => {
  const config = {
    baseline: [],
    keywords: { cheapo: ["hello"], expenso: ["world"] },
    serverMeta: { cheapo: { tier: "cheap" }, expenso: { tier: "expensive" } },
  };
  const result = await route("hello world", config);
  assert.ok(!result.servers.includes("cheapo"));
  assert.ok(result.servers.includes("expenso"));
});

test("route: servers without serverMeta entry are treated as expensive (routed)", async () => {
  const config = {
    baseline: [],
    keywords: { foo: ["bar"] },
    serverMeta: {},
  };
  const result = await route("bar", config);
  assert.deepEqual(result.servers, ["foo"]);
});

test("route: output includes reason and escalations fields", async () => {
  const result = await route("pull request please", baseConfig);
  assert.ok(typeof result.reason === "string");
  assert.ok(Array.isArray(result.escalations));
});

test("route: escalations is always an empty array for regex backend", async () => {
  const result = await route("hello world", baseConfig);
  assert.deepEqual(result.escalations, []);
});

test("route: throws on empty prompt", async () => {
  await assert.rejects(() => route("", baseConfig), /non-empty string/);
});

test("route: throws on non-string prompt", async () => {
  await assert.rejects(() => route(undefined, baseConfig), /non-empty string/);
});

test("route: throws on unknown backend", async () => {
  await assert.rejects(() => route("hello", baseConfig, { backend: "nonexistent" }), /unknown backend/);
});

test("registerBackend/getBackend: custom backend can be registered and used", async () => {
  registerBackend("custom", {
    match(prompt) {
      return {
        servers: prompt.includes("magic") ? ["custom-server"] : [],
        reason: prompt.includes("magic") ? "magic word found" : "no magic",
      };
    },
  });
  const result = await route("say the magic word", baseConfig, { backend: "custom" });
  assert.deepEqual(result.servers, ["custom-server"]);
  assert.equal(result.reason, "magic word found");
});

test("getBackend returns null for unregistered backend", async () => {
  assert.equal(getBackend("nonexistent"), null);
});

test("registerBackend throws if plugin lacks match function", async () => {
  assert.throws(() => registerBackend("bad", {}), /match\(\) function/);
});

test("resetBackends restores defaults and clears custom backends", async () => {
  registerBackend("custom", { match: () => ({ servers: [], reason: "" }) });
  resetBackends();
  assert.equal(getBackend("custom"), null);
  assert.ok(getBackend("regex") !== null);
});

test("route: regex backend skips invalid regex patterns gracefully", async () => {
  const config = {
    baseline: [],
    keywords: { bad: ["[unclosed"], good: ["hello"] },
    serverMeta: {},
  };
  const result = await route("hello world", config);
  assert.deepEqual(result.servers, ["good"]);
});

test("route: deduplicates matched servers", async () => {
  const config = {
    baseline: [],
    keywords: {
      dup: ["hello", "hello"],
    },
    serverMeta: {},
  };
  const result = await route("hello", config);
  assert.deepEqual(result.servers, ["dup"]);
});


test("route: selects backend from config.router.backend when options.backend is unset", async () => {
  const config = {
    ...baseConfig,
    router: { backend: "regex" },
  };
  const result = await route("pull request", config);
  assert.deepEqual(result.servers, ["repo"]);
});

test("route: config.router.backend falls back to regex when absent", async () => {
  const result = await route("pull request", baseConfig);
  assert.deepEqual(result.servers, ["repo"]);
});

// --- QMD Backend Tests ---

test("parseQmdJson: parses pure JSON arrays", async () => {
  const input = '[{"score": 0.9, "file": "skills/test/SKILL.md"}]';
  const parsed = parseQmdJson(input);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].score, 0.9);
});

test("parseQmdJson: extracts JSON array from CLI progress logs", async () => {
  const input = `Expanding query... (10ms)
├─ project context
Searching 4 queries...
Embedding 4 queries... (50ms)
[
  {
    "score": 0.95,
    "file": "./.rulesync/skills/project-context/SKILL.md",
    "snippet": "name: project-context\\ndescription: Summarize context"
  }
]`;
  const parsed = parseQmdJson(input);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].score, 0.95);
  assert.equal(parsed[0].file, "./.rulesync/skills/project-context/SKILL.md");
});

test("parseQmdJson: returns empty array on invalid or missing JSON", async () => {
  assert.deepEqual(parseQmdJson(""), []);
  assert.deepEqual(parseQmdJson("No matches found"), []);
  assert.deepEqual(parseQmdJson("[malformed json"), []);
});

test("route: qmd backend matches skills and expensive servers", async () => {
  const mockOutput = JSON.stringify([
    {
      score: 0.92,
      file: "./.rulesync/skills/project-context/SKILL.md",
      snippet: "name: project-context\ndescription: Summarize context",
    },
  ]);

  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      execFn: () => mockOutput,
    })
  );

  const result = await route("review pull request and summarize project context", baseConfig, {
    backend: "qmd",
  });

  assert.deepEqual(result.servers, ["repo"]);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "project-context");
  assert.equal(result.skills[0].path, "./.rulesync/skills/project-context/SKILL.md");
  assert.equal(result.skills[0].score, 0.92);
  assert.match(result.reason, /QMD matched skill project-context/);
});

test("route: qmd backend filters out skills below minScore threshold", async () => {
  const mockOutput = JSON.stringify([
    {
      score: 0.35,
      file: "./.rulesync/skills/low-score/SKILL.md",
    },
  ]);

  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      execFn: () => mockOutput,
      minScore: 0.6,
    })
  );

  const result = await route("check low score", baseConfig, { backend: "qmd" });
  assert.equal(result.skills.length, 0);
});

test("route: qmd backend degrades gracefully when execFn fails", async () => {
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      execFn: () => {
        throw new Error("Command failed: qmd not found");
      },
    })
  );

  const result = await route("pull request", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.servers, ["repo"]);
  assert.deepEqual(result.skills, []);
  assert.match(result.reason, /QMD lookup failed/);
});

test("route: qmd backend finds project-context for a task about project context", async () => {
  // A fake qmd answers: this used to ask the user's real index, which a test must not reach.
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      execFn: () => JSON.stringify([{ score: 0.9, file: "./.rulesync/skills/project-context/SKILL.md", snippet: "name: project-context\ndescription: Summarize context" }]),
    })
  );
  const result = await route("summarize project context and key constraints", baseConfig, {
    backend: "qmd",
  });
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].name, "project-context");
  assert.ok(result.skills[0].score > 0);
});

// What a healthy daemon answers on /health, which the router probes before it queries.
const healthResponse = () => ({ ok: true, status: 200, json: async () => ({ status: "ok", uptime: 1 }) });

function daemonResponse(body, { sessionId = "s1", status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([
      ["content-type", "application/json"],
      ["mcp-session-id", sessionId],
    ]),
    text: async () => JSON.stringify(body),
  };
}

test("route: qmd backend queries the shared daemon over MCP HTTP", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    if (url.endsWith("/health")) return healthResponse();
    const body = JSON.parse(init.body);
    calls.push({ url, body, session: init.headers["mcp-session-id"] });
    if (body.method === "tools/call") {
      return daemonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: {
            results: [
              {
                file: "skills/project-context/SKILL.md",
                score: 0.93,
                snippet: "4: name: project-context\n5: description: Summarize",
              },
            ],
          },
        },
      });
    }
    return daemonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
  };
  const execFn = () => {
    throw new Error("CLI must not be used when the daemon answers");
  };
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://localhost:9999/mcp", fetchFn, execFn }));

  const result = await route("summarize project context", baseConfig, { backend: "qmd" });

  assert.deepEqual(
    calls.map((c) => c.body.method),
    ["initialize", "notifications/initialized", "tools/call"]
  );
  assert.equal(calls[2].url, "http://localhost:9999/mcp");
  assert.equal(calls[2].session, "s1");
  assert.equal(calls[2].body.params.name, "query");
  assert.deepEqual(calls[2].body.params.arguments.collections, ["skills"]);
  assert.equal(result.skills[0].name, "project-context");
  assert.equal(result.skills[0].score, 0.93);
});

test("route: with no url given the qmd backend queries the port of qmd.port, and QMD_SHARED_PORT wins over it", async () => {
  const saved = process.env.QMD_SHARED_PORT;
  try {
    for (const [env, expected] of [[undefined, 18282], ["18283", 18283]]) {
      if (env === undefined) delete process.env.QMD_SHARED_PORT;
      else process.env.QMD_SHARED_PORT = env;
      const urls = [];
      const fetchFn = async (url, init) => {
        if (url.endsWith("/health")) return healthResponse();
        const body = JSON.parse(init.body);
        urls.push(url);
        return daemonResponse({ jsonrpc: "2.0", id: body.id, result: body.method === "tools/call" ? { structuredContent: { results: [] } } : {} });
      };
      registerBackend("qmd", createQmdBackend({ fetchFn, execFn: () => "" }));
      await route("summarize project context", { ...baseConfig, qmd: { port: 18282 } }, { backend: "qmd" });
      assert.ok(urls.length > 0 && urls.every((url) => url === `http://localhost:${expected}/mcp`), `${env}: ${urls}`);
    }
  } finally {
    if (saved === undefined) delete process.env.QMD_SHARED_PORT;
    else process.env.QMD_SHARED_PORT = saved;
  }
});

test("route: qmd backend reuses the daemon session across calls", async () => {
  const methods = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    return daemonResponse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [] } } });
  };
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn }));

  await route("one", baseConfig, { backend: "qmd" });
  await route("two", baseConfig, { backend: "qmd" });

  assert.equal(methods.filter((m) => m === "initialize").length, 1);
  assert.equal(methods.filter((m) => m === "tools/call").length, 2);
});

test("route: qmd backend parses SSE daemon responses", async () => {
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    const payload = {
      jsonrpc: "2.0",
      id: body.id,
      result: { structuredContent: { results: [{ file: "skills/a/SKILL.md", score: 0.8 }] } },
    };
    return {
      ok: true,
      status: 200,
      headers: new Map([
        ["content-type", "text/event-stream"],
        ["mcp-session-id", "s"],
      ]),
      text: async () => `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
    };
  };
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn }));

  const result = await route("anything", baseConfig, { backend: "qmd" });
  assert.equal(result.skills[0].name, "a");
});

test("route: qmd backend falls back to CLI search when the daemon is down", async () => {
  const execCalls = [];
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: "http://x/mcp",
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      execFn: (bin, args) => {
        execCalls.push(args);
        return JSON.stringify([{ file: "skills/b/SKILL.md", score: 0.9 }]);
      },
    })
  );

  const result = await route("anything", baseConfig, { backend: "qmd" });
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0][0], "search");
  assert.equal(result.skills[0].name, "b");
  assert.match(result.reason, /daemon unavailable/);
});

test("route: config.router.qmdUrl=null disables the daemon", async () => {
  let fetched = false;
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: "http://x/mcp",
      fetchFn: async () => {
        fetched = true;
      },
      execFn: () => "[]",
    })
  );
  await route("anything", { ...baseConfig, router: { qmdUrl: null } }, { backend: "qmd" });
  assert.equal(fetched, false);
});

// --- Mandatory bindings (Step 0a) ---

test("route: mandatory binding short-circuits the backend", async () => {
  let backendCalled = false;
  registerBackend("spy", {
    match() {
      backendCalled = true;
      return { servers: [], reason: "spy" };
    },
  });
  const config = {
    ...baseConfig,
    router: {
      backend: "spy",
      bindings: [
        {
          pattern: "\\breview (the )?PR\\b",
          skill: "review-pr",
          path: ".toolgate/commands/review-pr.md",
          servers: ["repo"],
        },
      ],
    },
  };

  const result = await route("please review the PR #12", config);

  assert.equal(backendCalled, false);
  assert.deepEqual(result.servers, ["repo"]);
  assert.deepEqual(result.skills, [{ name: "review-pr", path: ".toolgate/commands/review-pr.md", score: 1 }]);
  assert.equal(result.binding, "\\breview (the )?PR\\b");
  assert.match(result.reason, /mandatory binding/);
});

test("route: bindings that do not match fall through to the backend", async () => {
  const config = { ...baseConfig, router: { bindings: [{ pattern: "doctor", skill: "doctor" }] } };
  const result = await route("pull request", config);
  assert.deepEqual(result.servers, ["repo"]);
  assert.deepEqual(result.skills, []);
  assert.equal(result.binding, null);
});

test("route: invalid binding patterns are skipped", async () => {
  const config = {
    ...baseConfig,
    router: {
      bindings: [
        { pattern: "[invalid", skill: "x" },
        { pattern: "hello", skill: "greet" },
      ],
    },
  };
  const result = await route("hello", config);
  assert.equal(result.skills[0].name, "greet");
});

test("route: bound servers still respect the cheap tier", async () => {
  const config = { ...baseConfig, router: { bindings: [{ pattern: "hello", servers: ["docs", "tasks"] }] } };
  const result = await route("hello", config);
  assert.deepEqual(result.servers, ["tasks"]);
});

test("route: qmd backend resolves skill paths against the skills roots", async () => {
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      cwd: "/repo",
      existsFn: (p) => p === "/repo/.rulesync/skills/project-context/SKILL.md",
      execFn: () => JSON.stringify([{ file: "skills/project-context/SKILL.md", score: 0.9 }]),
    })
  );
  const result = await route("anything", baseConfig, { backend: "qmd" });
  assert.equal(result.skills[0].path, ".rulesync/skills/project-context/SKILL.md");
});

test("route: qmd backend keeps the QMD path when no root contains the skill", async () => {
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      existsFn: () => false,
      execFn: () => JSON.stringify([{ file: "skills/x/SKILL.md", score: 0.9 }]),
    })
  );
  const result = await route("anything", baseConfig, { backend: "qmd" });
  assert.equal(result.skills[0].path, "skills/x/SKILL.md");
});

// The `skills` collection holds the normalized corpus written by `toolgate skills index`:
// one `<name>.md` card per skill plus an `_index.md` catalog.
const CARD = (name, mcps, skillPath, level = "project") =>
  `${CARD_MARKER}\n# ${name}\n\nA skill.\n\n- Tags: none\n- Required MCPs: ${mcps}\n- Level: ${level}\n- Path: ${skillPath}\n`;

function corpusBackend(hits, cards) {
  return createQmdBackend({
    daemonUrl: null,
    cwd: "/repo",
    execFn: () => JSON.stringify(hits),
    readFn: (file) => {
      const card = cards[file];
      if (card === undefined) throw new Error(`ENOENT ${file}`);
      return card;
    },
  });
}

test("route: corpus hits resolve to the real SKILL.md path and drop the _index.md catalog", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/_index.md", score: 1 },
        { file: "skills/index.md", score: 1 }, // how qmd reports the catalog
        { file: "skills/pdf-export.md", score: 0.8 },
      ],
      { "/repo/.toolgate/skills-index/corpus/pdf-export.md": CARD("pdf-export", "none", "/abs/pdf-export/SKILL.md") }
    )
  );
  const result = await route("export a pdf", baseConfig, { backend: "qmd" });
  assert.deepEqual(
    result.skills.map(({ name, path }) => ({ name, path })),
    [{ name: "pdf-export", path: "/abs/pdf-export/SKILL.md" }]
  );
});

test("route: a matched skill's Required MCPs are activated, except cheap-tier ones", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/triage.md", score: 0.9 }], {
      "/repo/.toolgate/skills-index/corpus/triage.md": CARD("triage", "repo, docs", "/abs/triage/SKILL.md"),
    })
  );
  const result = await route("triage this", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.servers, ["repo"]); // `docs` is baseline, so it is already on
  assert.match(result.reason, /requires repo/);
});

test("route: the corpus dir comes from config.skills.corpusDir", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/a.md", score: 0.9 }], {
      "/repo/custom/corpus/a.md": CARD("a", "none", "/abs/a/SKILL.md"),
    })
  );
  const result = await route("x", { ...baseConfig, skills: { collection: "skills", corpusDir: "custom/corpus" } }, { backend: "qmd" });
  assert.equal(result.skills[0].path, "/abs/a/SKILL.md");
});

test("route: a corpus hit whose card cannot be read is reported, not given a made-up path", async () => {
  registerBackend("qmd", corpusBackend([{ file: "skills/gone.md", score: 0.9 }], {}));
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.skills, []);
  assert.match(result.reason, /skills card gone\.md unreadable/);
});

test("route: without a configured collection the qmd backend queries the project's own", async () => {
  const seen = [];
  registerBackend(
    "qmd",
    createQmdBackend({
      daemonUrl: null,
      cwd: "/work/app",
      execFn: (bin, args) => (seen.push(args), "[]"),
    })
  );
  await route("anything", { baseline: [] }, { backend: "qmd" });
  assert.equal(seen[0][seen[0].indexOf("-c") + 1], defaultCollection("/work/app"));
});

test("route: each skill reports the level it comes from", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/mine.md", score: 0.9 },
        { file: "skills/team.md", score: 0.8 },
      ],
      {
        "/repo/.toolgate/skills-index/corpus/mine.md": CARD("mine", "none", "/abs/mine/SKILL.md", "user"),
        "/repo/.toolgate/skills-index/corpus/team.md": CARD("team", "none", "/abs/team/SKILL.md"),
      }
    )
  );
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.skills.map((s) => [s.name, s.level]), [["mine", "user"], ["team", "project"]]);
});

const installedWith = (...servers) => ({ servers, source: "/repo/.mcp.json" });
const needsRepo = (extra = {}) => ({ ...baseConfig, router: { bindings: [{ pattern: "pull request", servers: ["repo", "tasks"], ...extra }] } });

test("route: a required server the agent has not configured is reported as missing, with its install hint", async () => {
  const config = {
    ...needsRepo(),
    serverMeta: { repo: { tier: "expensive" }, tasks: { tier: "expensive", install: "npx tasks-mcp" } },
  };
  const result = await route("open a pull request", config, { installed: installedWith("repo") });
  assert.deepEqual(result.servers, ["repo", "tasks"]);
  assert.deepEqual(result.missing, [{ server: "tasks", install: "npx tasks-mcp", checkedIn: "/repo/.mcp.json" }]);
});

test("route: a missing server without a known install hint says null", async () => {
  const result = await route("open a pull request", needsRepo(), { installed: installedWith() });
  assert.deepEqual(result.servers, ["repo", "tasks"]);
  assert.deepEqual(
    result.missing.map(({ server, install }) => [server, install]),
    [["repo", null], ["tasks", null]]
  );
});

test("route: nothing is reported missing when the installed servers are unknown", async () => {
  for (const installed of [undefined, null]) {
    const result = await route("open a pull request", needsRepo(), { installed });
    assert.deepEqual(result.servers, ["repo", "tasks"]);
    assert.deepEqual(result.missing, []);
  }
});

test("route: baseline servers are never reported missing", async () => {
  const config = { ...needsRepo(), baseline: ["docs", "repo"] };
  const result = await route("open a pull request", config, { installed: installedWith() });
  assert.deepEqual(result.missing.map((m) => m.server), ["tasks"]);
});

test("route: servers a skill requires through its card are checked against the installed ones", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/devtools.md", score: 0.9 }], {
      "/repo/.toolgate/skills-index/corpus/devtools.md": CARD("devtools", "chrome-devtools", "/abs/devtools/SKILL.md"),
    })
  );
  const result = await route("inspect the console", baseConfig, { backend: "qmd", installed: installedWith("repo") });
  assert.deepEqual(result.servers, ["chrome-devtools"]);
  assert.deepEqual(result.missing.map((m) => m.server), ["chrome-devtools"]);
});

// A corpus folder with `count` markdown files (the last is the catalog) and no commands or subagents folder.
function corpusListing(count) {
  return (dir) => {
    if (["commands", "subagents"].includes(path.basename(String(dir)))) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return [...Array.from({ length: count - 1 }, (_, i) => `s${i}.md`), "_index.md"];
  };
}
// A daemon whose `query` finds one skill and whose `status` reports `documents` for the collection.
function daemonServing(documents) {
  const methods = [];
  const fetchFn = async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method === "tools/call" ? body.params.name : body.method);
    if (body.method !== "tools/call") return daemonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
    const structuredContent =
      body.params.name === "status"
        ? { collections: documents === undefined ? [] : [{ name: "skills", documents }] }
        : { results: [{ file: "skills/devtools.md", score: 0.9 }] };
    return daemonResponse({ jsonrpc: "2.0", id: body.id, result: { structuredContent } });
  };
  return { fetchFn, methods };
}

const corpusOf = (count) => ({
  cwd: "/repo",
  readdirFn: corpusListing(count),
  readFn: () => `${CARD_MARKER}\n# devtools\n\nd\n\n- Required MCPs: none\n- Path: /abs/devtools/SKILL.md\n`,
});

test("route: warns when the daemon serves fewer documents than the corpus holds", async () => {
  const daemon = daemonServing(2);
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: daemon.fetchFn, ...corpusOf(26) }));
  const result = await route("inspect the console", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.warnings, ['the qmd daemon serves 2 of the 26 documents of "skills"; run "toolgate daemon restart"']);
  assert.deepEqual(daemon.methods, ["initialize", "notifications/initialized", "query", "status"]);
  assert.equal(result.skills[0].name, "devtools", "the skills found are still returned");
});

test("route: no warning when the daemon and the corpus agree, or when the daemon cannot count", async () => {
  const agree = daemonServing(26);
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: agree.fetchFn, ...corpusOf(26) }));
  assert.deepEqual((await route("x", baseConfig, { backend: "qmd" })).warnings, []);

});
test("route: a corpus the daemon cannot count against says so, with the command; no corpus says nothing", async () => {
  const want = ['could not check whether the qmd daemon serves every document of "skills"; run "toolgate daemon restart"'];
  // the daemon lists other collections only (an old or foreign index), so the project's one is not found
  const unknown = daemonServing(undefined);
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: unknown.fetchFn, ...corpusOf(26) }));
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.warnings, want);
  assert.equal(result.skills[0].name, "devtools", "the skills found are still returned");

  // a `status` that fails is the same: the check cannot run
  const failing = async (url, init) => (JSON.parse(init.body).params?.name === "status" ? Promise.reject(new Error("status down")) : daemonServing(26).fetchFn(url, init));
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: failing, ...corpusOf(26) }));
  assert.deepEqual((await route("x", baseConfig, { backend: "qmd" })).warnings, want);

  // no corpus on disk: nothing to compare with, no warning
  const none = daemonServing(undefined);
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: none.fetchFn, cwd: "/repo", readFn: corpusOf(1).readFn, readdirFn: () => { throw new Error("ENOENT"); } }));
  assert.deepEqual((await route("x", baseConfig, { backend: "qmd" })).warnings, []);
});

test("route: warnings is always present, and the regex backend has none", async () => {
  assert.deepEqual((await route("pull request", baseConfig, { backend: "regex" })).warnings, []);
});

test("route: the daemon is not asked for its status when there is no corpus to compare with", async () => {
  const daemon = daemonServing(2);
  registerBackend("qmd", createQmdBackend({ daemonUrl: "http://x/mcp", fetchFn: daemon.fetchFn, cwd: "/repo", readdirFn: () => { throw new Error("ENOENT"); } }));
  await route("x", baseConfig, { backend: "qmd" });
  assert.ok(!daemon.methods.includes("status"));
});

// Command cards live in `commands/` of the corpus, so a command and a skill may share a name.
const COMMAND_CARD = (name, mcps, commandPath, hint) =>
  `${CARD_MARKER}\n# ${name}\n\nA command.\n\n- Tags: none\n- Required MCPs: ${mcps}\n- Kind: command\n${hint ? `- Argument hint: ${hint}\n` : ""}- Level: project\n- Path: ${commandPath}\n`;
const CORPUS = "/repo/.toolgate/skills-index/corpus";

test("route: a command hit goes to `commands`, with its path, hint and servers, and not to `skills`", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/commands/review-pr.md", score: 0.9 }], {
      [`${CORPUS}/commands/review-pr.md`]: COMMAND_CARD("review-pr", "repo, docs", "/abs/commands/review-pr.md", "<number>"),
    })
  );
  const result = await route("review a pr", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.skills, []);
  assert.equal(result.commands.length, 1);
  assert.deepEqual(
    { ...result.commands[0], snippet: undefined },
    { name: "review-pr", path: "/abs/commands/review-pr.md", argumentHint: "<number>", level: "project", shadows: [], description: "A command.", score: 0.9, snippet: undefined }
  );
  assert.deepEqual(result.servers, ["repo"]);
  assert.match(result.reason, /QMD matched command review-pr/);
});

test("route: a skill and a command with the same name are both returned, each in its own array", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/review.md", score: 0.9 },
        { file: "skills/commands/review.md", score: 0.8 },
      ],
      {
        [`${CORPUS}/review.md`]: CARD("review", "none", "/abs/review/SKILL.md"),
        [`${CORPUS}/commands/review.md`]: COMMAND_CARD("review", "none", "/abs/commands/review.md"),
      }
    )
  );
  const result = await route("review", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.skills.map((s) => s.path), ["/abs/review/SKILL.md"]);
  assert.deepEqual(result.commands.map((c) => c.path), ["/abs/commands/review.md"]);
  assert.equal("argumentHint" in result.commands[0], false);
});

test("route: with only skills in the corpus (an index from before commands) `commands` is empty", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/pdf-export.md", score: 0.8 }], {
      [`${CORPUS}/pdf-export.md`]: CARD("pdf-export", "none", "/abs/pdf-export/SKILL.md"),
    })
  );
  const result = await route("export a pdf", baseConfig, { backend: "qmd" });
  assert.equal(result.skills.length, 1);
  assert.deepEqual(result.commands, []);
});

test("route: an unreadable command card is reported and skipped, and a reserved name is ignored", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/commands/gone.md", score: 0.9 },
        { file: "skills/commands/index.md", score: 0.9 },
      ],
      {}
    )
  );
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.skills, []);
  assert.match(result.reason, /command card commands\/gone\.md unreadable/);
});

test("route: a mandatory binding and the regex backend return no commands", async () => {
  const bound = { ...baseConfig, router: { bindings: [{ pattern: "release", skill: "ship", path: "/s/ship/SKILL.md" }] } };
  const viaBinding = await route("cut a release", bound, { backend: "regex" });
  assert.deepEqual(viaBinding.commands, []);
  assert.deepEqual(viaBinding.skills.map((s) => s.name), ["ship"]);
  assert.deepEqual((await route("pull request", baseConfig, { backend: "regex" })).commands, []);
});

test("launch: the prompt gets one hint line for skills and one for commands, none when there are no commands", async () => {
  const stderr = { write() {} };
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const run = async (result) => {
    registerBackend("stub", { match: () => ({ servers: [], reason: "", ...result }) });
    return (await applyRouting({ prompt: "do it", config: {}, state, backend: "stub", stderr })).prompt;
  };
  assert.equal(
    await run({ skills: [{ name: "s", path: "/s/SKILL.md" }], commands: [{ name: "c", path: "/c/c.md" }] }),
    "do it\n\n[toolgate] Relevant skills, read before starting: /s/SKILL.md\n[toolgate] Relevant commands, read and follow them with the request as arguments: /c/c.md"
  );
  assert.equal(await run({ skills: [{ name: "s", path: "/s/SKILL.md" }] }), "do it\n\n[toolgate] Relevant skills, read before starting: /s/SKILL.md");
  assert.equal(await run({ skills: [] }), "do it");
});

test("route: a skill and a command asking for the same MCP list it once; one only the command needs can be missing", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/triage.md", score: 0.9 },
        { file: "skills/commands/triage.md", score: 0.8 },
        { file: "skills/commands/deploy.md", score: 0.7 },
      ],
      {
        [`${CORPUS}/triage.md`]: CARD("triage", "repo", "/abs/triage/SKILL.md"),
        [`${CORPUS}/commands/triage.md`]: COMMAND_CARD("triage", "repo", "/abs/commands/triage.md"),
        [`${CORPUS}/commands/deploy.md`]: COMMAND_CARD("deploy", "ship", "/abs/commands/deploy.md"),
      }
    )
  );
  const result = await route("triage and deploy", baseConfig, { backend: "qmd", installed: { servers: ["repo"], source: "test" } });
  assert.deepEqual(result.servers, ["repo", "ship"]);
  assert.deepEqual(result.missing.map((m) => m.server), ["ship"]);
});

test("route: a hit inside commands/ that is not a command card is dropped, and never read as a skill", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [
        { file: "skills/commands/a/b.md", score: 0.9 },
        { file: "skills/commands/../x.md", score: 0.9 },
        { file: "skills/commands/notes.txt", score: 0.9 },
        { file: "skills/commands/bad name.md", score: 0.9 },
        { file: "skills/commands/.md", score: 0.9 },
      ],
      {}
    )
  );
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual([result.skills, result.commands], [[], []]);
});

test("route: the CLI fallback reports absolute card paths, and a command is still a command", async () => {
  registerBackend(
    "qmd",
    corpusBackend(
      [{ file: `${CORPUS}/commands/review-pr.md`, score: 0.9 }],
      { [`${CORPUS}/commands/review-pr.md`]: COMMAND_CARD("review-pr", "none", "/abs/commands/review-pr.md") }
    )
  );
  const result = await route("review a pr", baseConfig, { backend: "qmd" });
  assert.deepEqual(result.skills, []);
  assert.deepEqual(result.commands.map((c) => c.path), ["/abs/commands/review-pr.md"]);
});

test("route: a card in commands/ that does not say it is a command is ignored", async () => {
  registerBackend(
    "qmd",
    corpusBackend([{ file: "skills/commands/odd.md", score: 0.9 }], {
      [`${CORPUS}/commands/odd.md`]: CARD("odd", "none", "/abs/odd/SKILL.md"),
    })
  );
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual([result.skills, result.commands], [[], []]);
  assert.match(result.reason, /command card commands\/odd\.md is not a command card/);
  assert.deepEqual(result.warnings, [`1 skill or command card is unreadable in ${CORPUS}; run "toolgate skills index"`]);
});

test("launch: a command without a path is left out of the hint instead of putting its name where a path goes", async () => {
  registerBackend("stub", { match: () => ({ servers: [], reason: "", commands: [{ name: "c", path: "" }] }) });
  const state = { extras: [], toolExtras: {}, pendingRestart: false };
  const { prompt } = await applyRouting({ prompt: "do it", config: {}, state, backend: "stub", stderr: { write() {} } });
  assert.equal(prompt, "do it");
});

test("route: a card written by an older version (no format marker) is unreadable, never read with a guess", async () => {
  // What the previous version wrote for a hint that carries a `- Tags:` line of its own.
  const old = "# x\n\nd\n\n- Tags: none\n- Required MCPs: repo\n- Kind: command\n- Argument hint: <x>\n- Tags: y\n- Required MCPs: evil\n- Kind: skill\n- Level: project\n- Path: /real/x.md\n";
  registerBackend("qmd", corpusBackend([{ file: "skills/commands/x.md", score: 0.9 }, { file: "skills/old.md", score: 0.9 }], {
    [`${CORPUS}/commands/x.md`]: old,
    [`${CORPUS}/old.md`]: old,
  }));
  const result = await route("x", baseConfig, { backend: "qmd" });
  assert.deepEqual([result.skills, result.commands, result.servers], [[], [], []]);
  assert.match(result.reason, /command card commands\/x\.md unreadable.*run "toolgate skills index"/);
  assert.match(result.reason, /skills card old\.md unreadable/);
  // One warning with the count, which `need` prints: a quiet empty answer would read as "nothing is needed".
  assert.deepEqual(result.warnings, [`2 skill or command cards are unreadable in ${CORPUS}; run "toolgate skills index"`]);
  const { result: needed } = resolveNeed(result, { state: { extras: [], toolExtras: {}, pendingRestart: false } });
  assert.match(formatNeed(needed), /^warning: 2 skill or command cards are unreadable in .*; run "toolgate skills index"$/m);
});
