// The fetch and TCP guards of the test processes, in a module of their own so that a child process can load them too (`node --import net-guard.js`,
// which `hermetic.js` puts in the `NODE_OPTIONS` of every child it starts). Nothing else is in here: no sandbox, no change to HOME or XDG.
// `fetch`: a request to a port from 8181 to 8281 (the user's qmd daemon and the range init picks from), on any host, or to any host that is not
// loopback (localhost, 127.0.0.1, [::1]) is refused with a TypeError. Loopback on other ports stays open: tests start their own servers on random ports.
// The same rule holds one level lower, for every TCP connect of the process (`net.connect`, `http(s).request`, undici, WebSocket, and each hop of a
// redirect): `net.Socket.prototype.connect` destroys the socket with an error, before any packet is sent. Unix sockets and named pipes (a `path`)
// stay open. Each refusal is appended to the file named by `TG_HERMETIC_LOG` (the violations log of the test process that started this one), so
// that process fails when it exits even if the error was swallowed here. `TG_HERMETIC_FETCH=record` lists the leaks instead: each refusal is also
// printed at once. It never lets a request through. Not covered: non-node children that open sockets themselves, DNS lookups, UDP.
// `net.Server.prototype.listen` is guarded for the same range: a listener on a TCP port from 8181 to 8281, on any host or none, is refused. The
// refused call opens no socket; it emits `error` on the server asynchronously (code EACCES), so a probe written like `portIsFree` resolves
// "busy" instead of waiting, and the attempt goes to the same log as a `listen` line. Port 0, the test range and Unix sockets or pipes pass.
// Read as node reads it: `options._handle || options.handle || options`, then the port before the path (`{port, path}` is a TCP listener). Known
// limits, left out on purpose: `dgram` sockets (`bind`), the internal `_listen2`, and `listen({ fd })` of a descriptor that is already bound.
import fs from "node:fs";
import net from "node:net";

const isRecord = () => process.env.TG_HERMETIC_FETCH === "record";
// The log is read when a refusal happens, so a parent can name it after this module was loaded. A log that cannot be written (the sandbox was
// deleted under us) does not stop the refusal.
function appendLog(line) {
  const file = process.env.TG_HERMETIC_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, line);
  } catch {
    // The refusal still stands.
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LOOPBACK_CONNECT_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const underlyingFetch = globalThis.fetch;
// The URL as text when the guard refuses it, else null (a value that is not a URL is left for fetch to reject).
function refusedUrl(input) {
  let url;
  try {
    url = new URL(input?.url ?? input);
  } catch {
    return null;
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return !LOOPBACK_HOSTS.has(url.hostname) || (port >= 8181 && port <= 8281) ? url.href.replace(/[\r\n]/g, " ") : null;
}
globalThis.fetch = async function fetch(input, init) {
  const refused = refusedUrl(input);
  if (refused === null) return underlyingFetch(input, init);
  appendLog(`fetch ${refused}\n`);
  if (isRecord()) process.stderr.write(`GUARD fetch: ${refused}\n`);
  throw new TypeError(`hermetic: real fetch to ${refused} is not allowed in tests`);
};

const underlyingConnect = net.Socket.prototype.connect;
const hostOf = (host) => String(host || "localhost").replace(/^\[(.*)\]$/, "$1").toLowerCase();
const isPort = (value) => typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
// Reads the arguments of a connect call once, into primitives, and returns what to decide on and what to connect with: the real connect gets the
// copy, never the caller's object, so a getter cannot answer one thing to the guard and another to node. `target` is "host:port" for a TCP connect,
// null for a pipe (a truthy `path`, as node reads it), and "unrecognized arguments" when the shape is not one node documents (failing closed).
function snapshotConnect(args) {
  try {
    const first = args[0];
    if (Array.isArray(first)) {
      // The array node's own net.connect builds is [options, callback] with an internal symbol; any other array is an options object to node.
      const symbols = Object.getOwnPropertySymbols(first);
      if (symbols.length === 0) return { target: "unrecognized arguments", args };
      const [target, copy] = snapshotOptions(first[0]);
      const normalized = [copy, first[1]];
      for (const symbol of symbols) normalized[symbol] = first[symbol];
      return { target, args: [normalized, ...args.slice(1)] };
    }
    if (first !== null && typeof first === "object") {
      const [target, copy] = snapshotOptions(first);
      return { target, args: [copy, ...args.slice(1)] };
    }
    if (isPort(first)) {
      const host = typeof args[1] === "string" ? args[1] : undefined;
      return { target: tcpTarget(host, Number(first)), args };
    }
    if (typeof first === "string") return { target: null, args };
  } catch {
    // A getter or a proxy that throws: refused below like any shape we cannot read.
  }
  return { target: "unrecognized arguments", args };
}
function snapshotOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("not options");
  // Read once each, inherited properties included, as node reads them; the copy carries the values read.
  const { path, port, host } = options;
  const copy = { ...options, path, port, host };
  if (path) return [null, copy];
  if (port !== undefined) copy.port = Number(port);
  if (host !== undefined) copy.host = host === null ? undefined : String(host);
  return [tcpTarget(copy.host, copy.port), copy];
}
function tcpTarget(host, port) {
  if (!Number.isInteger(port)) throw new TypeError("no port");
  const name = hostOf(host);
  return !LOOPBACK_CONNECT_HOSTS.has(name) || (port >= 8181 && port <= 8281) ? `${name}:${port}`.replace(/[\r\n]/g, " ") : null;
}
net.Socket.prototype.connect = function connect(...callArgs) {
  const { target, args } = snapshotConnect(callArgs);
  if (target === null) return Reflect.apply(underlyingConnect, this, args);
  appendLog(`connect ${target}\n`);
  if (isRecord()) process.stderr.write(`GUARD connect: ${target}\n`);
  return this.destroy(new Error(`hermetic: real connection to ${target} is not allowed in tests`));
};

const underlyingListen = net.Server.prototype.listen;
// Reads the arguments of a listen call once, into primitives, as snapshotConnect does. `target` is "host:port" for a TCP listener in the range, else
// null (any other port, a pipe or path, a handle, no port at all) and "unrecognized arguments" when the shape cannot be read (failing closed).
function snapshotListen(args) {
  try {
    const first = args[0];
    if (first === undefined || first === null || typeof first === "function") return { target: null, args };
    if (isPort(first)) {
      const host = typeof args[1] === "string" ? args[1] : undefined;
      return { target: listenTarget(host, Number(first)), args };
    }
    if (typeof first === "object") {
      // Node reads `options._handle || options.handle || options`, then the port before the path: so does the guard. Each value is read once,
      // inherited properties included, as node reads them; what is passed on is the copy of the values read.
      const wrapper = first._handle || first.handle;
      const options = wrapper || first;
      const { path, port, host } = options;
      // A real handle (no port) or a pipe (a path and no port) is not a TCP listener, unless the object it came in also names a port of the range:
      // which of the two node would use is then not the guard's to guess, and the call is refused.
      if (port === undefined || port === null) {
        const outer = wrapper ? first.port : undefined;
        return { target: outer === undefined || outer === null ? null : listenTarget(first.host === undefined || first.host === null ? undefined : String(first.host), Number(outer)), args };
      }
      const copy = { ...options, path, port: Number(port), host: host === undefined ? undefined : host === null ? undefined : String(host) };
      // The wrapper is what node unwraps; the copy of what it held goes in its place.
      return { target: listenTarget(copy.host, copy.port), args: [copy, ...args.slice(1)] };
    }
    if (typeof first === "string") return { target: null, args };
  } catch {
    // A getter or a proxy that throws: refused below like any shape we cannot read.
  }
  return { target: "unrecognized arguments", args };
}
function listenTarget(host, port) {
  if (!Number.isInteger(port)) throw new TypeError("no port");
  if (port < 8181 || port > 8281) return null;
  // A listener with no host is on every interface: it is named by the unspecified address, as node does.
  return `${host === undefined || host === "" ? "::" : hostOf(host)}:${port}`.replace(/[\r\n]/g, " ");
}
net.Server.prototype.listen = function listen(...callArgs) {
  const { target, args } = snapshotListen(callArgs);
  if (target === null) return Reflect.apply(underlyingListen, this, args);
  appendLog(`listen ${target}\n`);
  if (isRecord()) process.stderr.write(`GUARD listen: ${target}\n`);
  const error = Object.assign(new Error(`hermetic: listening on ${target} is not allowed in tests`), { code: "EACCES", syscall: "listen" });
  process.nextTick(() => this.emit("error", error));
  return this;
};
