// `route` and `need` with a catalog: what a search by meaning adds after the words (the seam `catalogSearch`), and that the catalog is never searched through qmd.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/cli.js";
import { createQmdBackend, registerBackend, resetBackends, route } from "../src/router.js";
import { catalogForRoute } from "../src/catalog/read.js";
import { renderCatalog } from "../src/catalog/render.js";
import { formatNeed } from "../src/need.js";

const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tmp = (name) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `toolgate-cs-${name}-`)));
  made.push(dir);
  return dir;
};
const put = (root, file, data) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof data === "string" ? data : JSON.stringify(data));
};
const entry = (server, tools) => renderCatalog({ server, transport: "stdio", auth: "none", instructionsChars: 0, tools }, new Map());
const tool = (name, description) => ({ name, description });

const daemonResponse = (body) => ({ ok: true, status: 200, headers: new Map([["content-type", "application/json"], ["mcp-session-id", "s1"]]), text: async () => JSON.stringify(body) });
function routeProject() {
  const cwd = tmp("proj");
  const home = tmp("home");
  put(home, ".claude.json", {});
  put(cwd, ".mcp.json", { mcpServers: { github: { command: "x" }, slack: { command: "x" }, calendar: { command: "x" } } });
  for (const [server, d] of [["github", "Open a pull request"], ["slack", "Post a chat message"], ["calendar", "List events"]]) put(cwd, `.toolgate/catalog/servers/${server}.md`, entry(server, [tool("do_it", d)]));
  return { cwd, catalog: catalogForRoute({ config: {}, cwd, homedir: home }) };
}

test("route adds what qmd found by meaning after what the words found, within the cap, only for servers the catalog read has", async () => {
  const p = routeProject();
  const search = async () => [{ server: "slack", score: 0.6 }, { server: "ghost", score: 0.99 }, { server: "calendar", score: 0.9 }];
  const routed = await route("open a pull request", {}, { catalog: p.catalog, catalogSearch: search });
  assert.deepEqual(routed.servers, ["github", "calendar", "slack"], "words first, then meaning by score; the unknown server is ignored");
  assert.deepEqual(routed.catalog.map((c) => [c.server, c.tools.length > 0]), [["github", true], ["calendar", false], ["slack", false]]);
  assert.match(routed.reason, /catalog matched calendar by meaning/);
  const twice = await route("open a pull request", { router: { catalogMaxServers: 2 } }, { catalog: p.catalog, catalogSearch: async () => [{ server: "github", score: 0.99 }, { server: "calendar", score: 0.9 }] });
  assert.deepEqual(twice.servers, ["github", "calendar"], "a server found by words is not found again by meaning, and does not take a slot");
  assert.equal(twice.catalog.filter((c) => c.server === "github").length, 1);
  const capped = await route("open a pull request", { router: { catalogMaxServers: 2 } }, { catalog: p.catalog, catalogSearch: search });
  assert.deepEqual(capped.servers, ["github", "calendar"]);
  const off = await route("open a pull request", { router: { catalogMaxServers: 0 } }, { catalog: p.catalog, catalogSearch: search });
  assert.deepEqual(off.servers, []);
  let asked = false;
  const bound = await route("open a pull request", { router: { bindings: [{ pattern: "open a pull request", servers: ["slack"] }] } }, { catalog: p.catalog, catalogSearch: async () => { asked = true; return []; } });
  assert.equal(asked, false, "a binding skips the search too");
  assert.deepEqual(bound.servers, ["slack"]);
});

test("when the search fails, the words still work and the reason says so; a baseline server is not added by meaning", async () => {
  const p = routeProject();
  const down = async () => { throw new Error("qmd is down\nmore"); };
  const routed = await route("open a pull request", {}, { catalog: p.catalog, catalogSearch: down });
  assert.deepEqual(routed.servers, ["github"]);
  assert.match(routed.reason, /catalog search unavailable \(qmd is down\); matched by words/);
  const baseline = await route("zzz unrelated", { baseline: ["calendar"] }, { catalog: p.catalog, catalogSearch: async () => [{ server: "calendar", score: 0.9 }] });
  assert.deepEqual(baseline.catalog ?? [], []);
  const quiet = await route("zzz unrelated", {}, { catalog: p.catalog, catalogSearch: down });
  assert.match(quiet.reason ?? "", /catalog search unavailable/);
});

// The daemon's score is the rank of the document (1, 0.5, 0.33, ...) for any query, so every document looks relevant.
const rankScores = (files) => async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.method === "tools/call") return daemonResponse({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: files.map((file, i) => ({ file, score: Math.round(100 / (i + 1)) / 100 })) } } });
  return daemonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
};

test("with the qmd backend and a daemon that scores by rank, an unrelated task adds no catalog server, and the catalog is never searched through qmd", async (t) => {
  const p = routeProject();
  const asked = [];
  const files = ["calendar", "slack", "github"].map((n) => `x/${n}.md`);
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.method === "tools/call") asked.push("daemon");
    return rankScores(files)(url, init);
  };
  const execFn = (bin, args) => {
    asked.push("cli");
    return JSON.stringify(files.map((file, i) => ({ file, score: 1 / (i + 1) })));
  };
  // The skills side of `need` runs the registered qmd backend; it gets a fake so no real qmd is reached.
  registerBackend("qmd", createQmdBackend({ execFn: () => "[]" }));
  t.after(resetBackends);
  for (const [prompt, expected] of [["bake a chocolate cake", []], ["open a pull request", ["github"]]]) {
    const out = [];
    const code = await run(["need", prompt, "--json"], {
      cwd: p.cwd,
      env: { TOOLGATE_DEFAULTS: path.join(p.cwd, "t.json"), HOME: p.cwd },
      stdout: { write: (s) => out.push(s) },
      stderr: { write: () => {} },
      loadConfigFn: () => ({ router: { backend: "qmd", qmdUrl: null } }),
      loadStateFn: () => ({ extras: [], toolExtras: {}, pendingRestart: false, subagentExtras: [] }),
      saveStateFn: () => {},
      catalog: { homedir: p.cwd },
      catalogSearch: { fetchFn, execFn },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.join("")).servers.map((s) => s.server), expected, prompt);
  }
  assert.deepEqual(asked, [], "neither the daemon nor the qmd CLI was asked about the catalog");
});
