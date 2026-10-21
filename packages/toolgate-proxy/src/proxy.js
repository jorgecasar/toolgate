import { spawn } from "node:child_process";
import os from "node:os";
import { resolveAllowList } from "./allowlist.js";
import { createDynamic } from "./dynamic.js";
import { renamedEnvNames } from "./names.js";

const FORWARD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// Implements docs/DESIGN.md "Proxy contract": spawns TOOLGATE_UPSTREAM_CMD, passes stdio through
// byte-for-byte, and rewrites only the tools/list response to the resolved allow list.
export function runProxy(opts = {}) {
  const {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    exit = (code) => process.exit(code),
    spawnFn = spawn,
  } = opts;

  // An old name alone is never read, and never silently ignored: a renamed allow list must not fail open.
  const renamed = renamedEnvNames(env);
  if (renamed.length) {
    for (const [oldName, newName] of renamed) stderr.write(`toolgate-proxy: ${oldName} was renamed to ${newName}; run toolgate update\n`);
    return exit(1);
  }

  const upstreamCmd = env.TOOLGATE_UPSTREAM_CMD;
  if (!upstreamCmd) {
    stderr.write("toolgate-proxy: TOOLGATE_UPSTREAM_CMD is required\n");
    return exit(1);
  }

  let upstreamArgs = [];
  if (env.TOOLGATE_UPSTREAM_ARGS) {
    try {
      upstreamArgs = JSON.parse(env.TOOLGATE_UPSTREAM_ARGS);
    } catch {
      stderr.write("toolgate-proxy: TOOLGATE_UPSTREAM_ARGS must be a JSON array\n");
      return exit(1);
    }
  }

  const { tools: allowList } = resolveAllowList(env);

  const child = spawnFn(upstreamCmd, upstreamArgs, {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const signalHandlers = FORWARD_SIGNALS.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  });

  const pendingToolsListIds = new Set();
  // With a session of toolgate's for this server the tools offered change while the agent runs (see dynamic.js); without one this is
  // the static proxy, unchanged.
  const dynamic = createDynamic({ env, stderr, write: (line) => stdout.write(line + "\n") });
  dynamic?.start();

  const stdinFramer = makeLineFramer((line) => {
    if (dynamic) {
      const reply = dynamic.fromClient(line);
      if (reply !== null) {
        stdout.write(reply + "\n");
        return;
      }
    } else {
      trackToolsListRequest(line, pendingToolsListIds);
    }
    child.stdin.write(line + "\n");
  });
  stdin.on("data", (chunk) => stdinFramer.push(chunk));
  stdin.on("end", () => {
    stdinFramer.flush();
    child.stdin.end();
  });

  const stdoutFramer = makeLineFramer((line) => {
    stdout.write((dynamic ? dynamic.fromUpstream(line) : processStdoutLine(line, pendingToolsListIds, allowList, stderr)) + "\n");
  });
  child.stdout.on("data", (chunk) => stdoutFramer.push(chunk));

  child.on("error", (err) => {
    dynamic?.stop();
    stderr.write(`toolgate-proxy: failed to start upstream: ${err.message}\n`);
    exit(1);
  });

  child.on("exit", (code, signal) => {
    dynamic?.stop();
    stdoutFramer.flush();
    for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
    if (signal) {
      exit(128 + (os.constants.signals[signal] ?? 0));
    } else {
      exit(code ?? 0);
    }
  });
}

function makeLineFramer(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) onLine(line);
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer);
        buffer = "";
      }
    },
  };
}

// Requests only: records the id of tools/list calls so the matching response can be
// filtered later. JSON-RPC responses carry only an id, not the method, hence the tracking.
function trackToolsListRequest(line, pendingToolsListIds) {
  const msg = tryParse(line);
  if (msg && !Array.isArray(msg) && "id" in msg && msg.method === "tools/list") {
    pendingToolsListIds.add(msg.id);
  }
}

// Responses (and everything else) from the upstream: passthrough verbatim unless this
// line is the tracked tools/list response, in which case filter result.tools and
// re-serialize. Anything unparseable, notifications, and arrays/batches pass through raw.
function processStdoutLine(line, pendingToolsListIds, allowList, stderr) {
  const msg = tryParse(line);
  if (!msg || Array.isArray(msg) || !("id" in msg) || !pendingToolsListIds.has(msg.id)) {
    return line;
  }
  pendingToolsListIds.delete(msg.id);

  if (!msg.result || !Array.isArray(msg.result.tools)) {
    return line;
  }
  if (allowList === null) {
    return line; // fail-open: no filtering
  }

  const advertised = new Set(msg.result.tools.map((t) => t.name));
  for (const wanted of allowList) {
    if (!advertised.has(wanted)) {
      stderr.write(`toolgate-proxy: allow-list entry "${wanted}" matches no advertised tool\n`);
    }
  }

  const filteredTools = msg.result.tools.filter((t) => allowList.has(t.name));
  const filtered = { ...msg, result: { ...msg.result, tools: filteredTools } };
  return JSON.stringify(filtered);
}

function tryParse(line) {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
