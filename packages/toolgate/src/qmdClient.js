// Minimal MCP client for the shared QMD HTTP daemon (`qmd mcp --http --daemon`).

// Streamable-HTTP MCP replies may be plain JSON or an SSE stream of `data:` lines.
async function readRpcResponse(res) {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
  return events.find((e) => "result" in e || "error" in e) ?? {};
}

/**
 * Minimal MCP client for the shared QMD HTTP daemon (`qmd mcp --http --daemon`).
 * Reuses one session per backend instance; re-initializes once if it expires.
 */
export function createDaemonClient({ url, fetchFn, timeoutMs }) {
  let sessionId = null;
  let nextId = 1;

  async function post(body) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    return fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function initialize() {
    sessionId = null;
    const res = await post({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "toolgate-router", version: "0.1.0" },
      },
    });
    if (!res.ok) throw new Error(`QMD daemon initialize failed: HTTP ${res.status}`);
    sessionId = res.headers.get("mcp-session-id");
    await readRpcResponse(res);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function callTool(name, args, retried = false) {
    if (!sessionId) await initialize();
    const res = await post({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (!res.ok) {
      if (!retried && (res.status === 400 || res.status === 404)) {
        sessionId = null;
        return callTool(name, args, true);
      }
      throw new Error(`QMD daemon ${name} failed: HTTP ${res.status}`);
    }
    const msg = await readRpcResponse(res);
    if (msg.error) throw new Error(`QMD daemon ${name} error: ${msg.error.message}`);
    return msg.result;
  }

  return { callTool };
}
