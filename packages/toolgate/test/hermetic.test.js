// The preload of test/support/hermetic.js is what keeps the suite away from the user's real qmd; without it this fails.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("a test process runs with a throwaway home, a port that is not the user's daemon, and a fake qmd", () => {
  const sandboxDir = path.dirname(process.env.HOME);
  assert.match(path.basename(sandboxDir), /^toolgate-hermetic-/);
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR"]) {
    assert.equal(path.dirname(process.env[name] ?? "/"), sandboxDir, `${name} is inside the sandbox`);
  }
  assert.ok(process.env.QMD_SHARED_PORT && process.env.QMD_SHARED_PORT !== "8181", "QMD_SHARED_PORT is not 8181");
  // Read, not run: running it is exactly what the guard fails a test for.
  const first = process.env.PATH.split(path.delimiter)[0];
  assert.match(fs.readFileSync(path.join(first, "qmd"), "utf8"), /GUARD/, "the first qmd on PATH is the fake");
});
// The preload run in a child process, in a sandbox root of its own, to see what it does on exit and on a signal.
const HERMETIC = path.resolve(import.meta.dirname, "support", "hermetic.js");
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const root = (name = "toolgate-hs-") => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  made.push(dir);
  return dir;
};
const child = (code, rootDir, { args = [] } = {}) =>
  spawnSync(process.execPath, ["--import", HERMETIC, ...args, "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: rootDir }, timeout: 20000 });
const leftover = (rootDir) => fs.readdirSync(rootDir).filter((name) => name.startsWith("toolgate-hermetic-"));
test("the sandbox also holds TMPDIR, XDG_DATA_HOME and XDG_STATE_HOME", () => {
  const out = child("console.log(JSON.stringify([process.env.TMPDIR, process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME, require('node:os').tmpdir()]))", root());
  const [tmpdir, data, state, osTmp] = JSON.parse(out.stdout);
  const sandboxDir = path.dirname(tmpdir);
  assert.match(path.basename(sandboxDir), /^toolgate-hermetic-/);
  for (const dir of [data, state]) assert.equal(path.dirname(dir), sandboxDir, dir);
  assert.equal(osTmp, tmpdir);
});
test("a deleted sandbox does not make the exit hook throw", () => {
  const rootDir = root();
  const out = child("require('node:fs').rmSync(require('node:path').dirname(process.env.HOME), { recursive: true, force: true })", rootDir);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, "");
});
test("a call to the fake qmd fails the process when it exits, and the sandbox is removed", () => {
  const rootDir = root();
  const out = child("try { require('node:child_process').execFileSync('qmd', ['query', 'x'], { stdio: 'pipe' }) } catch {}", rootDir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /GUARD: this test process reached qmd without a fake execFn:\nqmd query x/);
  assert.deepEqual(leftover(rootDir), []);
});
test("the fake qmd logs even when the sandbox path has a single quote", () => {
  const rootDir = root("toolgate-q'uote-");
  const out = child("try { require('node:child_process').execFileSync('qmd', ['a'], { stdio: 'pipe' }) } catch {}", rootDir);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /qmd a/);
});
test("the agent CLIs are not installed in a test process", () => {
  const out = child("const { spawnSync } = require('node:child_process'); console.log(JSON.stringify(['claude', 'codex', 'agy', 'opencode', 'kj'].map((bin) => spawnSync(bin, ['--version']).status)))", root());
  assert.deepEqual(JSON.parse(out.stdout), [127, 127, 127, 127, 127]);
  assert.equal(out.status, 0, "a probe of an agent CLI is not a qmd violation");
});
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  test(`${signal} removes the sandbox and exits ${code}`, async () => {
    const rootDir = root();
    const proc = spawn(process.execPath, ["--import", HERMETIC, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { env: { ...process.env, TG_TEST_SANDBOX_ROOT: rootDir }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve) => proc.stdout.once("data", resolve));
    assert.equal(leftover(rootDir).length, 1, "the sandbox exists while it runs");
    const exited = new Promise((resolve) => proc.once("exit", (status, sig) => resolve({ status, sig })));
    proc.kill(signal);
    assert.deepEqual(await exited, { status: code, sig: null });
    assert.deepEqual(leftover(rootDir), []);
  });
}
test("a sandbox left by a process that is gone is swept at preload; one of a live process is kept", () => {
  const rootDir = root();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const stale = path.join(rootDir, `toolgate-hermetic-${gone}-abc123`);
  const live = path.join(rootDir, `toolgate-hermetic-${process.pid}-abc123`);
  const other = path.join(rootDir, "toolgate-hermetic-notapid");
  for (const dir of [stale, live, other]) fs.mkdirSync(path.join(dir, "home"), { recursive: true });
  const out = child("", rootDir);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.existsSync(stale), false, "the folder of a dead process is removed");
  assert.equal(fs.existsSync(live), true, "the folder of a live process is kept");
  assert.equal(fs.existsSync(other), true, "a folder without a pid in its name is not ours to remove");
  assert.deepEqual(leftover(rootDir).sort(), [path.basename(live), path.basename(other)].sort(), "the child's own sandbox is gone");
});
test("test processes that start together and find the same stale sandbox all start", async () => {
  const rootDir = root();
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  const make = () => {
    for (let i = 0; i < 40; i++) fs.mkdirSync(path.join(rootDir, `toolgate-hermetic-${Number(gone) + 100000 + i}-x`, "a", "b"), { recursive: true });
  };
  make();
  const run = () => new Promise((resolve) => spawn(process.execPath, ["--import", HERMETIC, "-e", ""], { env: { ...process.env, TG_TEST_SANDBOX_ROOT: rootDir }, stdio: "pipe" }).once("exit", resolve));
  const codes = await Promise.all(Array.from({ length: 8 }, run));
  assert.deepEqual(codes, Array(8).fill(0));
  assert.deepEqual(leftover(rootDir), []);
});
// The fetch guard: refused URLs throw, are logged and fail the process at exit; the underlying fetch is a stub that records what reaches it.
const stubDir = root("toolgate-stub-");
const STUB = path.join(stubDir, "stub-fetch.mjs");
fs.writeFileSync(STUB, "globalThis.reached = []; globalThis.fetch = async (input) => { globalThis.reached.push(String(input?.url ?? input)); return new Response('stub'); };\n");
const guarded = (code, env = {}) =>
  spawnSync(process.execPath, ["--import", STUB, "--import", HERMETIC, "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "", ...env }, timeout: 20000 });
const tryFetch = (urls) => `
(async () => {
  const out = [];
  for (const url of ${JSON.stringify(urls)}) {
    try { await fetch(url); out.push('ok'); } catch (err) { out.push(err instanceof TypeError ? err.message : 'other: ' + err.message); }
  }
  console.log(JSON.stringify({ out, reached: globalThis.reached }));
})();`;
const REFUSED = ["http://localhost:8181/health", "http://127.0.0.1:8281/", "http://[::1]:8200/x", "https://example.com", "http://192.168.1.5:3000/", "http://localhost.:9000/"];
test("fetch to 8181-8281 on loopback or to a host that is not loopback throws the exact text, is logged, reaches nothing, and fails the process at exit", () => {
  const out = guarded(tryFetch(REFUSED));
  const { out: messages, reached } = JSON.parse(out.stdout);
  assert.deepEqual(messages, REFUSED.map((url) => `hermetic: real fetch to ${new URL(url).href} is not allowed in tests`));
  assert.deepEqual(reached, [], "no connection was attempted");
  assert.equal(out.status, 1, "the process fails even though the error was swallowed");
  assert.match(out.stderr, /GUARD: this test process made a real fetch without a fake status or fetchFn:\nfetch http:\/\/localhost:8181\/health\nfetch http:\/\/127\.0\.0\.1:8281\/\n/);
  for (const url of REFUSED) assert.ok(out.stderr.includes(`fetch ${new URL(url).href}`), url);
});
test("a URL object and a Request are checked too", () => {
  const out = guarded(`(async () => { const seen = []; for (const input of [new URL('http://localhost:8181/a'), new Request('http://localhost:8200/b')]) { try { await fetch(input); } catch (err) { seen.push(err.message); } } console.log(JSON.stringify({ seen, reached: globalThis.reached })); })();`);
  const { seen, reached } = JSON.parse(out.stdout);
  assert.deepEqual(seen, ["hermetic: real fetch to http://localhost:8181/a is not allowed in tests", "hermetic: real fetch to http://localhost:8200/b is not allowed in tests"]);
  assert.deepEqual(reached, []);
});
test("loopback on other ports, 8180 and 8282 included, is not refused by the range rule, and reaches the underlying fetch", () => {
  const allowed = ["http://localhost:8180/", "http://127.0.0.1:8282/", "http://[::1]:30123/x", "http://localhost/", "http://localhost:9/"];
  const out = guarded(tryFetch(allowed));
  const { out: results, reached } = JSON.parse(out.stdout);
  assert.deepEqual(results, allowed.map(() => "ok"));
  assert.deepEqual(reached, allowed);
  assert.equal(out.status, 0, out.stderr);
});
test("a fetch to a loopback server the test starts on a random port succeeds (no stub)", () => {
  const out = spawnSync(
    process.execPath,
    ["--import", HERMETIC, "-e", "const s = require('node:http').createServer((q, r) => r.end('hello')).listen(0, '127.0.0.1', async () => { console.log(await (await fetch('http://127.0.0.1:' + s.address().port + '/')).text()); s.close(); });"],
    { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "" }, timeout: 20000 },
  );
  assert.equal(out.stdout.trim(), "hello");
  assert.equal(out.status, 0, out.stderr);
});
test("a child that runs one refused fetch and swallows the error exits non-zero through the exit hook", () => {
  const out = guarded("fetch('http://localhost:8181/health').catch(() => {})");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /fetch http:\/\/localhost:8181\/health/);
});
test("a value that is not a URL is left to fetch, and a qmd call and a fetch are reported apart", () => {
  const out = guarded("fetch('not a url').catch(() => {}); fetch('http://localhost:8181/').catch(() => {}); try { require('node:child_process').execFileSync('qmd', ['x'], { stdio: 'pipe' }) } catch {}");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /reached qmd without a fake execFn:\nqmd x\n/);
  assert.match(out.stderr, /made a real fetch without a fake status or fetchFn:\nfetch http:\/\/localhost:8181\/\n/);
  assert.doesNotMatch(out.stderr, /not%20a%20url|not a url/);
});
test("TG_HERMETIC_FETCH=record prints each refused URL at once, still throws, never connects, and does not fail the exit", () => {
  const out = guarded(tryFetch(["http://localhost:8181/health", "https://example.com/"]), { TG_HERMETIC_FETCH: "record" });
  const { out: messages, reached } = JSON.parse(out.stdout);
  assert.deepEqual(messages, ["hermetic: real fetch to http://localhost:8181/health is not allowed in tests", "hermetic: real fetch to https://example.com/ is not allowed in tests"]);
  assert.deepEqual(reached, []);
  assert.equal(out.status, 0);
  assert.equal(out.stderr, "GUARD fetch: http://localhost:8181/health\nGUARD fetch: https://example.com/\n");
});
// The net guard: every TCP connect of the process goes through net.Socket.prototype.connect. A preload that runs first replaces it with a
// recorder that passes on to the real one, so the test sees which connects were really attempted (a refused one never gets there).
const NET_STUB = path.join(stubDir, "stub-connect.mjs");
// Records every connect that reaches it. It passes on to the real one only for a pipe or for loopback outside 8000-8999, so even a mutated guard
// cannot make a test connect to the daemon's ports; every other call is recorded and goes nowhere.
fs.writeFileSync(
  NET_STUB,
  `import net from 'node:net'; const real = net.Socket.prototype.connect; globalThis.attempted = [];
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = a !== null && typeof a === 'object' ? a : typeof a === 'string' && Number.isNaN(Number(a)) ? { path: a } : { port: a, host: args[1] };
  globalThis.attempted.push(o.path ? String(o.path) : String(o.host) + ':' + String(o.port));
  const safe = o.path || (['localhost', '127.0.0.1', '::1', 'undefined'].includes(String(o.host)) && !(Number(o.port) >= 8000 && Number(o.port) <= 8999));
  return safe ? Reflect.apply(real, this, args) : this;
};
`,
);
const netChild = (code, env = {}, cwd = undefined) =>
  spawnSync(process.execPath, ["--import", NET_STUB, "--import", HERMETIC, "-e", code], { cwd, encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "", ...env }, timeout: 20000 });
const tryConnect = (calls) => `
const net = require('node:net');
(async () => {
  const out = [];
  for (const call of ${JSON.stringify(calls)}) {
    out.push(await new Promise((resolve) => {
      const socket = call.options ? net.connect(call.options) : net.connect(...call.args);
      socket.once('error', (err) => resolve(err.message));
      socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    }));
  }
  console.log(JSON.stringify({ out, attempted: globalThis.attempted }));
})();`;
const NET_REFUSED = [
  { args: [8181, "127.0.0.1"], shown: "127.0.0.1:8181" },
  { options: { port: 8281, host: "localhost" }, shown: "localhost:8281" },
  { args: [443, "example.com"], shown: "example.com:443" },
  { options: { port: 8200 }, shown: "localhost:8200" },
  { args: ["8181"], shown: "localhost:8181" },
  { options: { port: 9000, host: "192.168.1.5" }, shown: "192.168.1.5:9000" },
  { options: { port: 8200, host: "::1" }, shown: "::1:8200" },
];
test("net.connect to 8181-8281 or to a host that is not loopback is destroyed with the exact text, logged, never attempted, and fails the process at exit", () => {
  const out = netChild(tryConnect(NET_REFUSED));
  const { out: messages, attempted } = JSON.parse(out.stdout);
  assert.deepEqual(messages, NET_REFUSED.map((c) => `hermetic: real connection to ${c.shown} is not allowed in tests`));
  assert.deepEqual(attempted, [], "the real connect was never called");
  assert.equal(out.status, 1, "the process fails even though the error was swallowed");
  assert.match(out.stderr, /GUARD: this test process tried a real connection:\nconnect 127\.0\.0\.1:8181\nconnect localhost:8281\nconnect example\.com:443\n/);
  for (const c of NET_REFUSED) assert.ok(out.stderr.includes(`connect ${c.shown}`), c.shown);
});
test("the edges of the range: 8180 and 8282 are not refused by it", () => {
  const out = netChild("const net = require('node:net'); net.connect(8180, '127.0.0.1').on('error', () => {}); net.connect(8282, '127.0.0.1').on('error', () => {}); console.log(JSON.stringify(globalThis.attempted)); process.exit(0);");
  assert.deepEqual(JSON.parse(out.stdout), ["127.0.0.1:8180", "127.0.0.1:8282"]);
  assert.equal(out.status, 0, out.stderr);
});
// Direct calls, positional or with options, decided on a copy of what was passed. The recorder never connects, so a wrong decision shows as a list.
const SHAPES = `
const net = require('node:net');
const results = [];
const run = (label, fn) => { const before = globalThis.attempted.length; let error = null; const s = new net.Socket(); s.on('error', (e) => { error = e.message; }); try { fn(s); } catch (e) { error = 'threw ' + e.message; } results.push({ label, attempted: globalThis.attempted.slice(before), refused: s.destroyed }); };
`;
test("path is read as node reads it: a falsy path does not make a TCP connect a pipe", () => {
  const out = netChild(`${SHAPES}
for (const path of ['', 0, false, null, undefined]) run('path ' + String(path), (s) => s.connect({ path, port: 8181, host: 'localhost' }));
run('real path', (s) => s.connect({ path: 'x.sock', port: 8181 }));
console.log(JSON.stringify(results)); process.exit(0);`);
  const results = JSON.parse(out.stdout);
  for (const r of results.slice(0, 5)) assert.deepEqual([r.label, r.attempted, r.refused], [r.label, [], true]);
  assert.deepEqual(results[5].attempted, ["x.sock"], "a truthy path is a pipe and stays open");
});
test("the options are read once: a getter that answers another port the second time does not get past the guard, and the real connect gets the copy", () => {
  const out = netChild(`${SHAPES}
let n = 0; let reads = 0;
run('port getter', (s) => s.connect({ get port() { reads++; return n++ === 0 ? 39000 : 8181; }, host: '127.0.0.1' }));
run('host getter', (s) => { let h = 0; s.connect({ port: 39001, get host() { return h++ === 0 ? '127.0.0.1' : 'example.com'; } }); });
run('proxy', (s) => { let k = 0; s.connect(new Proxy({ port: 39002, host: '127.0.0.1' }, { get: (t, key) => (key === 'port' && k++ > 0 ? 8181 : t[key]) })); });
run('host toString', (s) => { let h = 0; s.connect({ port: 39005, host: { toString: () => (h++ === 0 ? '127.0.0.1' : 'example.com') } }); });
run('path getter', (s) => { let p = 0; s.connect({ get path() { return p++ === 0 ? '' : 'x.sock'; }, port: 8181, host: 'localhost' }); });
run('inherited port and host', (s) => s.connect(Object.create({ port: 8181, host: 'localhost' })));
run('inherited loopback port', (s) => s.connect(Object.create({ port: 39008, host: '127.0.0.1' })));
run('null host is localhost', (s) => s.connect({ port: 39006, host: null }));
run('array built by node, getter at index 0', (s) => { const arr = net._normalizeArgs([{ port: 39007, host: '127.0.0.1' }]); let k = 0; Object.defineProperty(arr, 0, { get: () => (k++ === 0 ? { port: 39007, host: '127.0.0.1' } : { port: 8181, host: 'localhost' }) }); s.connect(arr); });
run('positional pipe', (s) => s.connect('x.sock'));
run('throwing getter', (s) => s.connect({ get port() { throw new Error('boom'); } }));
console.log(JSON.stringify(results)); process.exit(0);`);
  const results = JSON.parse(out.stdout);
  for (const r of results) assert.ok(r.attempted.every((a) => !/:8181$|example\.com/.test(a)), `${r.label}: the real connect never saw another answer`);
  assert.deepEqual(results.map((r) => r.attempted), [["127.0.0.1:39000"], ["127.0.0.1:39001"], ["127.0.0.1:39002"], ["127.0.0.1:39005"], [], [], ["127.0.0.1:39008"], ["undefined:39006"], ["127.0.0.1:39007"], ["x.sock"], []]);
  assert.equal(results[4].refused, true, "a path that is falsy the first time is read as no path");
  assert.equal(results[5].refused, true, "inherited port and host are read as node reads them");
  assert.equal(results[10].refused, true, "a shape that cannot be read is refused");
});
test("an array without node's internal symbol is an options object to node, not [options, callback]; the one node builds is unwrapped", () => {
  const out = netChild(`${SHAPES}
const a = ['x']; a.port = 8181; a.host = 'localhost';
run('plain array', (s) => s.connect(a));
const b = [{ port: 39004, host: '127.0.0.1' }]; b.port = 8181; b.host = 'localhost';
run('array holding options, with its own port', (s) => s.connect(b));
const viaNode = net._normalizeArgs([{ port: 39003, host: '127.0.0.1' }, () => {}]);
run('node array', (s) => s.connect(viaNode));
const bad = net._normalizeArgs([{ port: 8181, host: 'localhost' }]);
run('node array to 8181', (s) => s.connect(bad));
console.log(JSON.stringify(results)); process.exit(0);`);
  const results = JSON.parse(out.stdout);
  assert.deepEqual([results[0].attempted, results[0].refused], [[], true]);
  assert.deepEqual([results[1].attempted, results[1].refused], [[], true], "node reads port and host off the array itself");
  assert.deepEqual(results[2].attempted, ["127.0.0.1:39003"]);
  assert.deepEqual([results[3].attempted, results[3].refused], [[], true]);
});
test("positional connects and the loopback set: localhost, 127.0.0.1, ::1 and [::1] and an empty host pass; 127.0.0.2, 0.0.0.0 and a name do not", () => {
  const out = netChild(`${SHAPES}
const calls = [[39010], [39011, 'localhost'], [39012, '127.0.0.1'], [39013, '::1'], [39014, '[::1]'], [39015, ''], [39016, 'LOCALHOST'], ['39017', '127.0.0.1'], [39018, '127.0.0.2'], [39019, '0.0.0.0'], [39020, 'example.com'], [39021, 'localhost.'], [8181], [8281, '127.0.0.1'], ['8200', '::1']];
for (const c of calls) run(JSON.stringify(c), (s) => s.connect(...c));
console.log(JSON.stringify(results)); process.exit(0);`);
  const results = JSON.parse(out.stdout);
  const allowed = results.slice(0, 8).map((r) => r.attempted.length);
  assert.deepEqual(allowed, Array(8).fill(1), "allowed loopback forms reach the real connect");
  for (const r of results.slice(8)) assert.deepEqual([r.label, r.attempted, r.refused], [r.label, [], true]);
});
test("TG_HERMETIC_FETCH=record prints each refused connect at once, still refuses, never connects, and does not fail the exit", () => {
  const out = netChild(tryConnect(NET_REFUSED.slice(0, 3)), { TG_HERMETIC_FETCH: "record" });
  const { out: messages, attempted } = JSON.parse(out.stdout);
  assert.equal(messages.length, 3);
  assert.deepEqual(attempted, []);
  assert.equal(out.status, 0);
  assert.equal(out.stderr, "GUARD connect: 127.0.0.1:8181\nGUARD connect: localhost:8281\nGUARD connect: example.com:443\n");
});
test("loopback servers on a random port are reached through net.connect, http.get and fetch, and a Unix socket in the sandbox too", () => {
  const sockDir = root("toolgate-sock-");
  const out = netChild(
    `
const net = require('node:net'); const http = require('node:http');
const server = http.createServer((q, r) => r.end('hello'));
const unixPath = 's.sock'; // relative: a socket path is limited to about 100 characters
const unix = net.createServer((c) => c.end('unix'));
const read = (socket) => new Promise((resolve, reject) => { let d = ''; socket.on('data', (b) => (d += b)); socket.on('end', () => resolve(d)); socket.on('error', reject); });
server.listen(0, '127.0.0.1', () => unix.listen(unixPath, async () => {
  const port = server.address().port;
  const viaNet = await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve('connected'); }); s.on('error', reject); });
  const viaHttp = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port }, (res) => { let d = ''; res.on('data', (b) => (d += b)); res.on('end', () => resolve(d)); }).on('error', reject));
  const viaFetch = await (await fetch('http://127.0.0.1:' + port + '/')).text();
  const viaUnix = await read(net.connect(unixPath));
  console.log(JSON.stringify({ viaNet, viaHttp, viaFetch, viaUnix, attempted: globalThis.attempted.length }));
  server.close(); unix.close(); process.exit(0);
}));`,
    {},
    sockDir,
  );
  assert.equal(out.status, 0, out.stderr);
  const got = JSON.parse(out.stdout);
  assert.deepEqual({ ...got, attempted: undefined }, { viaNet: "connected", viaHttp: "hello", viaFetch: "hello", viaUnix: "unix", attempted: undefined });
  assert.ok(got.attempted >= 4);
});
test("a 302 from a loopback server to 127.0.0.1:8181 fails at the second hop with the guard's text, and the real connect is never called for 8181 (nothing listens there)", () => {
  const out = netChild(`
const http = require('node:http');
const server = http.createServer((q, r) => { r.writeHead(302, { Location: 'http://127.0.0.1:8181/' }); r.end(); });
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  let cause = 'no error';
  try { await fetch('http://127.0.0.1:' + port + '/'); } catch (err) { cause = String(err.cause?.message ?? err.message); }
  console.log(JSON.stringify({ cause, port, attempted: globalThis.attempted }));
  server.close();
});`);
  const { cause, port, attempted } = JSON.parse(out.stdout);
  assert.equal(cause, "hermetic: real connection to 127.0.0.1:8181 is not allowed in tests");
  assert.ok(attempted.includes(`127.0.0.1:${port}`), "the first hop connected");
  assert.equal(attempted.filter((a) => /:8[12]\d\d$/.test(a)).length, 0, "nothing was attempted in 8181-8281");
  assert.equal(out.status, 1, "the refused hop fails the process at exit");
  assert.match(out.stderr, /connect 127\.0\.0\.1:8181\n/);
});
test("a child that makes one refused connect and swallows the error exits non-zero through the exit hook", () => {
  const out = netChild("require('node:net').connect(8181, '127.0.0.1').on('error', () => {})");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /connect 127\.0\.0\.1:8181/);
});

// The read guard of the real home (#306): `TG_HERMETIC_REAL_HOME` points "the real home" at a disposable folder, so nothing of the developer's is touched.
const FS_GUARD = path.resolve(import.meta.dirname, "support", "fs-guard-preload.js");
const HOME_FOLDERS = [
  ".config/toolgate", ".local/state/toolgate", ".local/share/toolgate", ".cache/qmd", ".cache/toolgate", ".claude", ".claude.json", ".codex", ".agents", ".gemini", ".config/opencode", ".opencode", ".toolgate",
];
const fakeHome = () => {
  const home = root("toolgate-realhome-");
  for (const rel of HOME_FOLDERS) {
    const target = path.join(home, rel);
    fs.mkdirSync(rel.endsWith(".json") ? path.dirname(target) : target, { recursive: true });
    if (rel.endsWith(".json")) fs.writeFileSync(target, "{}");
    else fs.writeFileSync(path.join(target, "config.json"), "{}");
  }
  fs.mkdirSync(path.join(home, "Developer", "repo"), { recursive: true });
  fs.writeFileSync(path.join(home, "Developer", "repo", "file.txt"), "mine");
  return home;
};
const withHome = (code, home, extra = {}) =>
  spawnSync(process.execPath, ["--import", HERMETIC, "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_REAL_HOME: home, ...extra }, timeout: 20000 });
// Tries one read in every form and reports what each said (the message, or "ok" / the answer).
const tryAll = (target) => `
  const fs = require('node:fs');
  const out = {};
  const attempt = (label, fn) => { try { const r = fn(); out[label] = r === false || r === true ? String(r) : 'ok'; } catch (e) { out[label] = e.message.replace(${JSON.stringify(target)}, '<p>'); } };
  for (const name of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync', 'accessSync', 'realpathSync', 'readlinkSync', 'opendirSync', 'createReadStream']) attempt(name, () => fs[name](${JSON.stringify(target)}));
  attempt('realpathSync.native', () => fs.realpathSync.native(${JSON.stringify(target)}));
  attempt('existsSync', () => fs.existsSync(${JSON.stringify(target)}));
  attempt('URL', () => fs.readFileSync(new URL('file://' + ${JSON.stringify(target)})));
  attempt('Buffer', () => fs.readFileSync(Buffer.from(${JSON.stringify(target)})));
  (async () => {
    for (const name of ['readFile', 'readdir', 'stat', 'lstat', 'open', 'access', 'realpath', 'readlink', 'opendir']) {
      out['promises.' + name] = await fs.promises[name](${JSON.stringify(target)}).then(() => 'ok', (e) => e.message.replace(${JSON.stringify(target)}, '<p>'));
      out['callback.' + name] = await new Promise((resolve) => fs[name](${JSON.stringify(target)}, (e) => resolve(e ? e.message.replace(${JSON.stringify(target)}, '<p>') : 'ok')));
    }
    out['callback.exists'] = await new Promise((resolve) => fs.exists(${JSON.stringify(target)}, (answer) => resolve(String(answer))));
    console.log(JSON.stringify(out));
  })();`;
test("a read of the real home's toolgate folder is refused in every form, logged, and fails the process when it exits", () => {
  const home = fakeHome();
  const target = path.join(home, ".config", "toolgate", "config.json");
  const out = withHome(tryAll(target), home);
  const said = JSON.parse(out.stdout);
  const message = "hermetic: real home read <p> is not allowed in tests";
  for (const [label, answer] of Object.entries(said)) {
    if (label === "existsSync" || label === "callback.exists") assert.equal(answer, "false", label);
    else assert.equal(answer, message, label);
  }
  assert.equal(Object.keys(said).length, 33, Object.keys(said).join(","));
  assert.equal(out.status, 1);
  assert.match(out.stderr, /GUARD: this test process read the real home \(give the test its own HOME \/ XDG folders\):\nfs .*config\.json/);
});
test("every folder of the list is refused, with what is inside it, and nothing else of the real home is", () => {
  const home = fakeHome();
  const code = `
    const fs = require('node:fs'); const path = require('node:path');
    const refused = []; const open = [];
    for (const rel of ${JSON.stringify(HOME_FOLDERS)}) for (const sub of ['', ...(rel.endsWith('.json') ? [] : ['/config.json', '/deep/er/x'])]) {
      try { fs.statSync(path.join(${JSON.stringify(home)}, rel + sub)); open.push(rel + sub); } catch (e) { if (/hermetic: real home read/.test(e.message)) refused.push(rel + sub); }
    }
    const fine = [];
    for (const rel of ['Developer/repo/file.txt', 'Developer/repo', '.config', '.config/toolgate-other', '.local/share', '.cache', '.cache/other']) {
      try { fs.statSync(path.join(${JSON.stringify(home)}, rel)); fine.push(rel); } catch (e) { fine.push(rel + ': ' + e.message.split(':')[0]); }
    }
    console.log(JSON.stringify({ refused, open, fine }));`;
  const out = withHome(code, home, { TG_HERMETIC_FS: "record" });
  const { refused, open, fine } = JSON.parse(out.stdout);
  assert.deepEqual(open, [], "no listed folder is left open");
  assert.equal(refused.length, HOME_FOLDERS.length * 3 - 2, "each folder, its files and a path deeper in it (a file has only itself)");
  assert.equal(fine[0], "Developer/repo/file.txt", "the repository under the real home is readable");
  assert.equal(fine[1], "Developer/repo");
  assert.ok(fine.every((entry) => !entry.includes("hermetic")), JSON.stringify(fine));
  assert.equal(out.status, 0, "record mode does not fail the exit");
});
test("the sandbox, the temporary folder and the repository are read as usual; a missing file is still ENOENT", () => {
  const home = fakeHome();
  const out = withHome(`
    const fs = require('node:fs'); const path = require('node:path');
    fs.writeFileSync(path.join(process.env.HOME, 'mine.txt'), 'x');
    let missing; try { fs.readFileSync(path.join(process.env.HOME, 'nope')); } catch (e) { missing = e.code; }
    console.log(JSON.stringify([fs.readFileSync(path.join(process.env.HOME, 'mine.txt'), 'utf8'), fs.existsSync(process.env.TMPDIR), fs.readdirSync(${JSON.stringify(path.resolve(import.meta.dirname, ".."))}).includes('package.json'), missing]));`, home);
  assert.deepEqual(JSON.parse(out.stdout), ["x", true, true, "ENOENT"]);
  assert.equal(out.status, 0, out.stderr);
});
test("the XDG folders the environment names are the ones refused, and the defaults under the home when they are not set", () => {
  const home = fakeHome();
  const elsewhere = root("toolgate-xdg-");
  fs.mkdirSync(path.join(elsewhere, "toolgate"));
  fs.writeFileSync(path.join(elsewhere, "toolgate", "config.json"), "{}");
  const code = (target) => `try { require('node:fs').readFileSync(${JSON.stringify(target)}); console.log('read'); } catch (e) { console.log(/hermetic/.test(e.message) ? 'refused' : e.code); }`;
  // `TG_HERMETIC_REAL_HOME` replaces the whole environment's idea of the real home, XDG included.
  assert.equal(withHome(code(path.join(elsewhere, "toolgate", "config.json")), home, { XDG_CONFIG_HOME: elsewhere, TG_HERMETIC_FS: "record" }).stdout.trim(), "read");
  const real = spawnSync(process.execPath, ["--import", HERMETIC, "-e", code(path.join(elsewhere, "toolgate", "config.json"))], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_REAL_HOME: "", XDG_CONFIG_HOME: elsewhere }, timeout: 20000 });
  assert.equal(real.stdout.trim(), "refused", "without the test switch the XDG_CONFIG_HOME of the environment is the real one");
  assert.equal(real.status, 1);
});
test("TG_HERMETIC_FS=record prints each read at once, still refuses it, and does not fail the exit", () => {
  const home = fakeHome();
  const target = path.join(home, ".claude", "config.json");
  const out = withHome(`try { require('node:fs').readFileSync(${JSON.stringify(target)}); } catch (e) { console.log(e.message); }`, home, { TG_HERMETIC_FS: "record" });
  assert.equal(out.stdout.trim(), `hermetic: real home read ${target} is not allowed in tests`);
  assert.equal(out.stderr, `GUARD fs: ${target}\n`);
  assert.equal(out.status, 0);
});
test("a child process that imports the guard module with the folders in its environment is guarded too", () => {
  const home = fakeHome();
  const log = path.join(root(), "violations.log");
  fs.writeFileSync(log, "");
  const target = path.join(home, ".codex", "config.json");
  const out = spawnSync(process.execPath, ["--import", FS_GUARD, "-e", `try { require('node:fs').readFileSync(${JSON.stringify(target)}); console.log('read'); } catch (e) { console.log(e.message); }`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, TG_HERMETIC_FS_REFUSED: JSON.stringify([path.join(home, ".codex")]), TG_HERMETIC_FS_LOG: log },
    timeout: 20000,
  });
  assert.equal(out.stdout.trim(), `hermetic: real home read ${target} is not allowed in tests`);
  assert.equal(fs.readFileSync(log, "utf8"), `fs ${target}\n`, "the parent's log gets the line");
  const plain = spawnSync(process.execPath, ["--import", FS_GUARD, "-e", `console.log(require('node:fs').readFileSync(${JSON.stringify(target)}, 'utf8'))`], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20000 });
  assert.equal(plain.stdout.trim(), "{}", "without the variables the module does nothing");
});
test("a sample of the CLI tests passes with extra skills, hooks and settings in the real home, and none of their reads was refused", { timeout: 240000 }, () => {
  const home = fakeHome();
  // What a developer has at the user level: skills, a hook, settings of the agent, a toolgate config.
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
  };
  for (const name of ["one", "two", "three", "four"]) put(`.config/toolgate/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: the ${name} skill\n---\n`);
  put(".config/toolgate/config.json", JSON.stringify({ baseline: ["extra"], skills: { sources: [{ dir: path.join(home, ".config/toolgate/skills") }] } }));
  put(".config/toolgate/hooks/h/hook.json", "{}");
  put(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [] }, permissions: { allow: ["Bash(*)"] } }));
  put(".claude.json", JSON.stringify({ mcpServers: { extra: { command: "x" } } }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")), HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_DATA_HOME: path.join(home, ".local/share"), TG_HERMETIC_REAL_HOME: "", TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FS: "" };
  // The tests of the skills that count what they index (the ones that failed with a developer's own skills), then doctor whole (init.test.js is left out: nested in the full suite it waits out its 100 s, alone or as a file of the suite it passes).
  const runs = [
    ["--test-name-pattern=skills index|user-level sources|copies a remote|names, --exclude|default source dirs", "test/skills-cli.test.js"],
    ["test/doctor.test.js"],
  ];
  for (const args of runs) {
    // The report goes to a file: a runner that ends on a failure can lose what it still had in a pipe.
    const report = path.join(root(), "report.txt");
    const out = spawnSync(process.execPath, ["--test", `--test-reporter=spec`, `--test-reporter-destination=${report}`, "--import", HERMETIC, ...args], { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", env, timeout: 100000 });
    const text = fs.existsSync(report) ? fs.readFileSync(report, "utf8") : "";
    const failed = text.split("\n").filter((line) => /^\s*✖/.test(line)).join("\n");
    assert.equal(out.status, 0, `${failed}\n${out.stderr.slice(-1200)}`);
    assert.doesNotMatch(out.stdout + out.stderr + text, /GUARD: this test process read the real home/);
    assert.match(text, /ℹ fail 0/);
    assert.doesNotMatch(text, /ℹ pass 0\b/);
  }
});
test("a read through a named import of node:fs or node:fs/promises is refused too", () => {
  const home = fakeHome();
  const target = path.join(home, ".agents", "config.json");
  const code = `
    import { readFileSync, existsSync } from 'node:fs';
    import { readFile } from 'node:fs/promises';
    const said = [];
    try { readFileSync(${JSON.stringify(target)}); said.push('read'); } catch (e) { said.push(/hermetic/.test(e.message) ? 'refused' : e.code); }
    said.push(String(existsSync(${JSON.stringify(target)})));
    said.push(await readFile(${JSON.stringify(target)}).then(() => 'read', (e) => (/hermetic/.test(e.message) ? 'refused' : e.code)));
    console.log(JSON.stringify(said));`;
  const out = spawnSync(process.execPath, ["--import", HERMETIC, "--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_REAL_HOME: home, TG_HERMETIC_FS: "record" }, timeout: 20000 });
  assert.deepEqual(JSON.parse(out.stdout), ["refused", "false", "refused"]);
});
// Child processes: whatever `env` a test passes, a child gets the guards (net-guard.js) through NODE_OPTIONS, and what it refuses reaches the log
// of the process that started it. The starting process here is a hermetic child of its own (a sandbox root of its own), so its exit code and its
// stderr show what the log held, and this test process is not failed by the refusals it provokes on purpose.
const GUARD_URL = new URL("./support/net-guard.js", import.meta.url).href;
const OWN_STUB = path.join(stubDir, "stub-connect-own.mjs");
fs.writeFileSync(
  OWN_STUB,
  "import net from 'node:net'; const real = net.Socket.prototype.connect; globalThis.attempted = []; net.Socket.prototype.connect = function (...args) { const a = Array.isArray(args[0]) ? args[0][0] : args[0]; const o = a !== null && typeof a === 'object' ? a : { port: a, host: args[1] }; globalThis.attempted.push(String(o.host) + ':' + String(o.port)); return Reflect.apply(real, this, args); };\n",
);
// `inner` runs in the starting process, which reports a JSON line; the starting process is hermetic and exits 1 when its log holds a refusal.
function starter(inner) {
  const out = spawnSync(process.execPath, ["--import", HERMETIC, "-e", inner], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "" }, timeout: 40000 });
  return { ...out, json: out.stdout ? JSON.parse(out.stdout.trim().split("\n").pop()) : undefined };
}
const CONNECT_8181 = "const s = require('node:net').connect(8181, '127.0.0.1'); s.on('error', (e) => { console.log(e.message); process.exit(0); });";
test("a child started with env: {} is refused a connect to 8181, with the guard's text, and the refusal reaches the log of the process that started it", () => {
  const r = starter(`const r = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(CONNECT_8181)}], { env: {}, encoding: 'utf8' }); console.log(JSON.stringify({ out: r.stdout.trim(), status: r.status }));`);
  assert.equal(r.json.out, "hermetic: real connection to 127.0.0.1:8181 is not allowed in tests");
  assert.equal(r.json.status, 0);
  assert.equal(r.status, 1, "the starting process fails at exit, though the child swallowed the error");
  assert.match(r.stderr, /GUARD: this test process tried a real connection:\nconnect 127\.0\.0\.1:8181\n/);
});
test("a child keeps its own NODE_OPTIONS and gets the guard after them, and the real connect is never called for the range", () => {
  const inner = `
const net = require('node:net');
const server = net.createServer((c) => c.end('ok')).listen(0, '127.0.0.1', () => {
  const ok = net.connect(server.address().port, '127.0.0.1', () => { ok.destroy();
    const bad = net.connect(8200, '127.0.0.1'); bad.on('error', (e) => { console.log(JSON.stringify({ options: process.env.NODE_OPTIONS, attempted: globalThis.attempted, error: e.message })); server.close(); process.exit(0); });
  });
});`;
  const r = starter(`const r = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { env: { NODE_OPTIONS: '--no-warnings --import ${pathToFileURL(OWN_STUB).href}' }, encoding: 'utf8' }); console.log(JSON.stringify(JSON.parse(r.stdout.trim()))); `);
  const { options, attempted, error } = r.json;
  assert.ok(options.startsWith(`--no-warnings --import ${pathToFileURL(OWN_STUB).href} `), "the child's own options come first");
  assert.ok(options.includes(`--import ${GUARD_URL}`), "the guard is added after them");
  assert.ok(options.endsWith(`--import ${new URL("./support/fs-guard-preload.js", import.meta.url).href}`), "the read guard of the real home follows it");
  assert.equal(error, "hermetic: real connection to 127.0.0.1:8200 is not allowed in tests");
  assert.equal(attempted.length, 1, "only the loopback connect on a random port reached the real one");
  assert.doesNotMatch(attempted[0], /:8[12]\d\d$/);
});
test("a grandchild, started by a shell, is refused too", () => {
  const script = path.join(root("toolgate-gc-"), "connect.js");
  fs.writeFileSync(script, CONNECT_8181);
  const r = starter(`const r = require('node:child_process').spawnSync('/bin/sh', ['-c', 'exec "$0" "$1"', process.execPath, ${JSON.stringify(script)}], { env: {}, encoding: 'utf8' }); console.log(JSON.stringify({ out: r.stdout.trim() }));`);
  assert.equal(r.json.out, "hermetic: real connection to 127.0.0.1:8181 is not allowed in tests");
  assert.match(r.stderr, /connect 127\.0\.0\.1:8181\n/);
});
test("every way of starting a child gives it the guard: spawn, spawnSync, execFile, execFileSync, fork, exec, execSync, and the promisified exec and execFile", () => {
  const script = path.join(root("toolgate-fk-"), "connect.js");
  fs.writeFileSync(script, CONNECT_8181);
  const q = JSON.stringify(process.execPath);
  const inner = `
const cp = require('node:child_process'); const { promisify } = require('node:util');
const script = ${JSON.stringify(script)}; const node = ${q}; const results = {};
const text = (v) => String(v).trim();
const bin = '"' + node + '" "' + script + '"';
(async () => {
  results.spawnSync = text(cp.spawnSync(node, [script], { env: {}, encoding: 'utf8' }).stdout);
  results.execFileSync = text(cp.execFileSync(node, [script], { env: {}, encoding: 'utf8' }));
  results.execSync = text(cp.execSync(bin, { env: {}, encoding: 'utf8' }));
  results.noOptions = text(cp.execFileSync(node, [script]));
  results.noOptionsSpawnSync = text(cp.spawnSync(node, [script]).stdout);
  results.noOptionsExecSync = text(cp.execSync(bin));
  results.nullOptions = text(cp.execFileSync(node, [script], null));
  const collect = (child) => new Promise((resolve) => { let out = ''; child.stdout.on('data', (d) => (out += d)); child.on('close', () => resolve(text(out))); });
  results.spawn = await collect(cp.spawn(node, [script], { env: {} }));
  results.spawnNoArgs = await collect(cp.spawn(bin, { shell: true, env: {} }));
  results.fork = await new Promise((resolve) => { const c = cp.fork(script, [], { env: {}, silent: true }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', () => resolve(text(out))); });
  results.execFile = await new Promise((resolve) => cp.execFile(node, [script], { env: {} }, (e, out) => resolve(text(out))));
  results.execFileCb = await new Promise((resolve) => cp.execFile(node, [script], (e, out) => resolve(text(out))));
  results.exec = await new Promise((resolve) => cp.exec(bin, { env: {} }, (e, out) => resolve(text(out))));
  results.execCb = await new Promise((resolve) => cp.exec(bin, (e, out) => resolve(text(out))));
  results.pExec = text((await promisify(cp.exec)(bin, { env: {} })).stdout);
  results.pExecFile = text((await promisify(cp.execFile)(node, [script], { env: {} })).stdout);
  console.log(JSON.stringify(results));
})();`;
  const r = starter(inner);
  const want = "hermetic: real connection to 127.0.0.1:8181 is not allowed in tests";
  const names = ["spawnSync", "execFileSync", "execSync", "noOptions", "noOptionsSpawnSync", "noOptionsExecSync", "nullOptions", "spawn", "spawnNoArgs", "fork", "execFile", "execFileCb", "exec", "execCb", "pExec", "pExecFile"];
  assert.deepEqual(Object.fromEntries(names.map((n) => [n, r.json[n]])), Object.fromEntries(names.map((n) => [n, want])));
});
test("a child reaches a loopback server on a random port, and a child that is itself a hermetic process is left as it is", () => {
  const inner = `const net = require('node:net'); const server = net.createServer((c) => c.end('hi')).listen(0, '127.0.0.1', () => { const s = net.connect(server.address().port, '127.0.0.1'); let d = ''; s.on('data', (b) => (d += b)); s.on('end', () => { console.log(d); server.close(); }); });`;
  const r = starter(`const cp = require('node:child_process'); const a = cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { env: {}, encoding: 'utf8' }); const b = cp.spawnSync(process.execPath, ['--import', ${JSON.stringify(HERMETIC)}, '-e', 'console.log(process.env.NODE_OPTIONS ?? "none")'], { env: { TG_TEST_SANDBOX_ROOT: ${JSON.stringify(root())} }, encoding: 'utf8' }); console.log(JSON.stringify({ a: a.stdout.trim(), b: b.stdout.trim(), status: a.status }));`);
  assert.deepEqual([r.json.a, r.json.b, r.json.status], ["hi", "none", 0]);
  assert.equal(r.status, 0, "nothing was refused, so the starting process exits 0");
});
// An argument list that is undefined or null, with the options behind it, keeps its options: `spawn(cmd, undefined, { cwd })`.
test("a child started with an undefined or null argument list and options after it keeps its options and gets the guard", () => {
  const dir = root("toolgate-hole-");
  fs.writeFileSync(path.join(dir, "connect.js"), CONNECT_8181);
  const inner = `
const cp = require('node:child_process'); const dir = ${JSON.stringify(dir)}; const node = ${JSON.stringify(process.execPath)};
const bin = '"' + node + '" connect.js'; const text = (v) => String(v).trim(); const results = {};
const collect = (child) => new Promise((resolve) => { let out = ''; child.stdout.on('data', (d) => (out += d)); child.on('close', () => resolve(text(out))); });
(async () => {
  results.spawnSyncUndefined = text(cp.spawnSync(bin, undefined, { shell: true, cwd: dir, env: {}, encoding: 'utf8' }).stdout);
  results.spawnSyncNull = text(cp.spawnSync(bin, null, { shell: true, cwd: dir, env: {}, encoding: 'utf8' }).stdout);
  results.execFileSyncUndefined = text(cp.execFileSync(bin, undefined, { shell: true, cwd: dir, env: {}, encoding: 'utf8' }));
  results.spawnUndefined = await collect(cp.spawn(bin, undefined, { shell: true, cwd: dir, env: {} }));
  results.forkNull = await new Promise((resolve) => { const c = cp.fork('connect.js', null, { cwd: dir, env: {}, silent: true }); let out = ''; c.stdout.on('data', (d) => (out += d)); c.on('close', () => resolve(text(out))); });
  results.execFileUndefined = await new Promise((resolve) => cp.execFile(bin, undefined, { shell: true, cwd: dir, env: {} }, (e, out) => resolve(text(out))));
  results.execFileUndefinedCallback = await new Promise((resolve) => cp.execFile('/bin/pwd', undefined, (e, out) => resolve(text(out) === text(process.cwd()) ? 'ran' : 'did not run')));
  results.execUndefinedOptions = await new Promise((resolve) => cp.exec('cd ' + JSON.stringify(dir) + ' && ' + bin, undefined, (e, out) => resolve(text(out))));
  results.names = [cp.spawn.name, cp.execFile.name, cp.exec.name, cp.spawn.length];
  console.log(JSON.stringify(results));
})();`;
  const r = starter(inner);
  const want = "hermetic: real connection to 127.0.0.1:8181 is not allowed in tests";
  const names = ["spawnSyncUndefined", "spawnSyncNull", "execFileSyncUndefined", "spawnUndefined", "forkNull", "execFileUndefined", "execUndefinedOptions"];
  assert.deepEqual(Object.fromEntries(names.map((n) => [n, r.json[n]])), Object.fromEntries(names.map((n) => [n, want])));
  assert.equal(r.json.execFileUndefinedCallback, "ran", "a callback behind an undefined list is still the callback");
  assert.deepEqual(r.json.names, ["spawn", "execFile", "exec", 3], "the wrappers keep the name and the length of what they wrap");
});
// Children and the read guard of the real home (#306): a child started with any `env` gets fs-guard-preload.js through NODE_OPTIONS, and what it is
// refused reaches the log of the process that started it, which then fails at exit.
const startedWithHome = (inner, home, extra = {}) =>
  spawnSync(process.execPath, ["--import", HERMETIC, "-e", inner], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_REAL_HOME: home, TG_HERMETIC_FS: "", ...extra }, timeout: 40000 });
test("a child started with env: {} is refused a read of the real home, and the refusal makes the process that started it fail at exit", () => {
  const home = fakeHome();
  const target = path.join(home, ".config", "toolgate", "config.json");
  const read = "try { require('node:fs').readFileSync(" + JSON.stringify(target) + "); console.log('read'); } catch (e) { console.log(e.message); }";
  const r = startedWithHome(`const r = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(read)}], { env: {}, encoding: 'utf8' }); console.log(JSON.stringify({ out: r.stdout.trim(), status: r.status }));`, home);
  const { out, status } = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out, `hermetic: real home read ${target} is not allowed in tests`);
  assert.equal(status, 0, "the child swallowed the error");
  assert.equal(r.status, 1, "the starting process fails at exit, though the child swallowed the error");
  assert.match(r.stderr, /GUARD: this test process read the real home[^\n]*\nfs .*config\.json/);
});
test("a child with its own NODE_OPTIONS keeps them, an async child is guarded, and a read outside the real home's folders is not refused", async () => {
  const home = fakeHome();
  const target = path.join(home, ".claude", "settings.json");
  const open = path.join(home, "Developer", "repo", "file.txt");
  const code = `
    const cp = require('node:child_process');
    const read = ${JSON.stringify(`const fs = require('node:fs'); let a; try { fs.readFileSync(${JSON.stringify(target)}); a = 'read'; } catch (e) { a = /hermetic/.test(e.message) ? 'refused' : e.code; } console.log(a + ' ' + fs.readFileSync(${JSON.stringify(open)}, 'utf8') + ' ' + process.env.NODE_OPTIONS.includes('--no-warnings'));`)};
    const sync = cp.spawnSync(process.execPath, ['-e', read], { env: { NODE_OPTIONS: '--no-warnings' }, encoding: 'utf8' });
    const child = cp.spawn(process.execPath, ['-e', read], { env: {}, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; child.stdout.on('data', (c) => (out += c));
    child.on('close', () => console.log(JSON.stringify([sync.stdout.trim(), out.trim()])));`;
  const r = startedWithHome(code, home, { TG_HERMETIC_FS: "record" });
  // the first child kept its own `--no-warnings`; the second had `env: {}` and still got the guard
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), ["refused mine true", "refused mine false"]);
});
test("TG_HERMETIC_FS=record reaches the children: they print what they are refused, and nothing fails the process that started them", () => {
  const home = fakeHome();
  const target = path.join(home, ".agents", "config.json");
  const read = "try { require('node:fs').readFileSync(" + JSON.stringify(target) + "); } catch {}";
  const inner = `const r = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(read)}], { env: {}, encoding: 'utf8' }); console.log(JSON.stringify({ stderr: r.stderr, status: r.status }));`;
  const recording = startedWithHome(inner, home, { TG_HERMETIC_FS: "record" });
  assert.deepEqual(JSON.parse(recording.stdout.trim().split("\n").pop()), { stderr: `GUARD fs: ${target}\n`, status: 0 });
  assert.equal(recording.status, 0);
  const enforcing = startedWithHome(inner, home);
  assert.deepEqual(JSON.parse(enforcing.stdout.trim().split("\n").pop()), { stderr: "", status: 0 }, "without the switch the child says nothing of its own");
  assert.equal(enforcing.status, 1, "and the process that started it fails at exit");
});

// The listen guard (#319): `net.Server.prototype.listen` is refused on a TCP port from 8181 to 8281, on any host or none. A stub loaded before the
// guard records the calls that get through (it opens nothing), so a mutated guard cannot bind a port of the user's.
const LISTEN_STUB = path.join(stubDir, "stub-listen.mjs");
fs.writeFileSync(
  LISTEN_STUB,
  `import net from 'node:net'; globalThis.reached = [];
net.Server.prototype.listen = function (...args) { globalThis.reached.push(JSON.stringify(args.map((a) => (typeof a === 'function' ? 'fn' : a)))); return this; };
`,
);
const listenChild = (code, env = {}) =>
  spawnSync(process.execPath, ["--import", LISTEN_STUB, "--import", HERMETIC, "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "", ...env }, timeout: 20000 });
// Each call is made on a server of its own; the answer is the error it emitted (message and code), or "none" when the call went through to the stub.
const tryListen = (calls) => `
const net = require('node:net');
(async () => {
  const out = [];
  for (const call of ${JSON.stringify(calls)}) {
    const server = net.createServer();
    const answer = new Promise((resolve) => { server.once('error', (e) => resolve(e.code + ' ' + e.message)); setTimeout(() => resolve('none'), 50); });
    const args = call.map((a) => (a === '<fn>' ? () => {} : a));
    const returned = server.listen(...args);
    out.push([await answer, returned === server]);
  }
  console.log(JSON.stringify({ out, reached: globalThis.reached }));
})();`;
const LISTEN_REFUSED = (target) => [`EACCES hermetic: listening on ${target} is not allowed in tests`, true];
test("listen on 8181 to 8281 is refused in every form, with an asynchronous EACCES, and opens nothing", () => {
  const cases = [
    [[8200], ":::8200"], [[8181, "127.0.0.1"], "127.0.0.1:8181"], [[8281, "localhost"], "localhost:8281"], [[8200, "0.0.0.0", "<fn>"], "0.0.0.0:8200"],
    [[{ port: 8200 }], ":::8200"], [[{ port: "8250", host: "::1" }], "::1:8250"], [["8200"], ":::8200"], [[8200, "<fn>"], ":::8200"],
    [[{ port: 8200, host: "127.0.0.1" }, "<fn>"], "127.0.0.1:8200"],
    // node looks at the port before the path, and unwraps `_handle` / `handle`: so does the guard
    [[{ port: 8200, path: "/tmp/x.sock" }], ":::8200"], [[{ handle: { port: 8200 } }], ":::8200"], [[{ _handle: { port: 8200, host: "127.0.0.1" } }], "127.0.0.1:8200"],
    [[{ _handle: { port: 8200 }, handle: { port: 0 } }], ":::8200"],
    // the object names a port of the range next to a handle: not the guard's to guess which one node would use
    [[{ handle: { fd: 4 }, port: 8200 }], ":::8200"], [[{ _handle: {}, port: 8250, host: "localhost" }], "localhost:8250"],
    [[{ handle: { fd: 4 }, path: "/tmp/p.sock", port: 8200 }], ":::8200"],
  ];
  const out = listenChild(tryListen(cases.map(([call]) => call)), { TG_HERMETIC_FETCH: "record" });
  const { out: answers, reached } = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.deepEqual(answers, cases.map(([, target]) => LISTEN_REFUSED(target)));
  assert.deepEqual(reached, [], "no call reached the real listen");
});
test("listen on any other port, on a path or a pipe, on a handle, or on no port reaches the real listen untouched", () => {
  const calls = [[0], [8180], [8282], ["0"], [30000, "127.0.0.1"], [{ port: 0 }], [{ path: "/tmp/x.sock" }], ["/tmp/y.sock"], [{ fd: 3 }], [], ["<fn>"], [{ path: "/tmp/z.sock", port: undefined }], [{ handle: { fd: 4 } }], [{ _handle: {} }], [{ handle: { port: 0 }, _handle: { port: 0 } }], [{ _handle: { port: 0 }, handle: { port: 8200 } }], [{ handle: { path: "/tmp/h.sock" } }]];
  const out = listenChild(tryListen(calls), { TG_HERMETIC_FETCH: "record" });
  const { out: answers, reached } = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.deepEqual(answers.map(([said]) => said), calls.map(() => "none"));
  assert.equal(reached.length, calls.length, "every one of them reached the real listen");
  assert.equal(out.stderr, "", "and nothing was logged");
  assert.equal(out.status, 0);
});
test("a refused listen is logged and fails the process when it exits, and with TG_HERMETIC_FETCH=record it is printed at once and the exit stays 0", () => {
  const code = tryListen([[8200, "127.0.0.1"], [8201]]);
  const enforcing = listenChild(code);
  assert.equal(enforcing.status, 1);
  assert.match(enforcing.stderr, /GUARD: this test process tried a real listener:\nlisten 127\.0\.0\.1:8200\nlisten :::8201\n/);
  const recording = listenChild(code, { TG_HERMETIC_FETCH: "record" });
  assert.equal(recording.status, 0);
  assert.equal(recording.stderr, "GUARD listen: 127.0.0.1:8200\nGUARD listen: :::8201\n");
});
test("the guard decides on the values it hands to listen: a getter that answers a safe port first and 8200 after reaches the real listen as the safe one", () => {
  const code = `
    const net = require('node:net');
    for (const [first, then] of [[0, 8200], [8200, 0]]) {
      let reads = 0;
      const options = { get port() { reads++; return reads === 1 ? first : then; }, host: '127.0.0.1' };
      const server = net.createServer();
      server.once('error', (e) => console.log(JSON.stringify({ refused: e.message })));
      server.listen(options);
    }
    setTimeout(() => console.log(JSON.stringify({ reached: globalThis.reached })), 30);`;
  const out = listenChild(code, { TG_HERMETIC_FETCH: "record" });
  const lines = out.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], { refused: "hermetic: listening on 127.0.0.1:8200 is not allowed in tests" }, "8200 first: refused");
  assert.deepEqual(lines[1], { reached: ['[{"port":0,"host":"127.0.0.1"}]'] }, "0 first: the real listen got 0, never the 8200 of the second read");
});
test("the error comes after listen returns: a handler attached to what listen returned still gets it", () => {
  const code = `
    const net = require('node:net');
    const server = net.createServer().listen(8200, '127.0.0.1');
    server.on('error', (e) => console.log(e.code));`;
  const out = listenChild(code, { TG_HERMETIC_FETCH: "record" });
  assert.equal(out.stdout.trim(), "EACCES", out.stderr);
  assert.equal(out.status, 0);
});
test("a listen whose arguments cannot be read is refused, like any shape the guard does not know", () => {
  const code = `
    const net = require('node:net');
    const shapes = [{ get port() { throw new Error('boom'); } }, new Proxy({}, { get() { throw new Error('proxy'); } })];
    for (const shape of shapes) {
      const server = net.createServer();
      server.once('error', (e) => console.log(e.message));
      server.listen(shape);
    }
    setTimeout(() => console.log(JSON.stringify(globalThis.reached)), 30);`;
  const out = listenChild(code, { TG_HERMETIC_FETCH: "record" });
  assert.deepEqual(out.stdout.trim().split("\n"), ["hermetic: listening on unrecognized arguments is not allowed in tests", "hermetic: listening on unrecognized arguments is not allowed in tests", "[]"]);
});
test("portIsFree(8200) under the guard answers false at once, and a free port of the test range answers true", async () => {
  const daemon = pathToFileURL(path.resolve(import.meta.dirname, "..", "src", "daemon.js")).href;
  const code = `
    const { portIsFree } = await import(${JSON.stringify(daemon)});
    const started = Date.now();
    const busy = await portIsFree(8200);
    const elapsed = Date.now() - started;
    const free = await portIsFree(0);
    console.log(JSON.stringify({ busy, elapsed, free }));`;
  const out = spawnSync(process.execPath, ["--import", HERMETIC, "--input-type=module", "-e", code], { encoding: "utf8", env: { ...process.env, TG_TEST_SANDBOX_ROOT: root(), TG_HERMETIC_FETCH: "record" }, timeout: 20000 });
  const { busy, elapsed, free } = JSON.parse(out.stdout.trim());
  assert.equal(busy, false);
  assert.ok(elapsed < 1000, `${elapsed} ms`);
  assert.equal(free, true);
});
test("a child process that listens on 8200 is refused too, and the process that started it fails at exit", () => {
  const inner = "const s = require('node:net').createServer(); s.once('error', (e) => console.log(e.code)); s.listen(8200, '127.0.0.1');";
  const r = starter(`const r = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { env: {}, encoding: 'utf8' }); console.log(JSON.stringify({ out: r.stdout.trim(), status: r.status }));`);
  assert.deepEqual(r.json, { out: "EACCES", status: 0 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GUARD: this test process tried a real listener:\nlisten 127\.0\.0\.1:8200\n/);
});
