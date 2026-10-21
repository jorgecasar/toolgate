# toolgate-proxy

A dependency-free stdio proxy that filters an MCP server's `tools/list` response to an allow list. See `docs/DESIGN.md` for its contract.

## Fixtures

- `fixtures/fake-upstream.js`: a small server for the integration tests.
- `fixtures/fat-upstream.js`: a server with 30 tools (each with a description and an input schema) and 4,096 characters of instructions, to measure what a client loads at session start (#19). It never touches the network, a file or a real agent.

Run the fat one on its own, or behind the proxy as a `.mcp.json` entry (the proxy takes the command in `TOOLGATE_UPSTREAM_CMD` and `TOOLGATE_UPSTREAM_ARGS`, and the allow list in `TOOLGATE_ALLOWED_TOOLS`):

```json
{
  "mcpServers": {
    "fat": {
      "command": "node",
      "args": ["packages/toolgate-proxy/bin/toolgate-proxy.js"],
      "env": {
        "TOOLGATE_UPSTREAM_CMD": "node",
        "TOOLGATE_UPSTREAM_ARGS": "[\"packages/toolgate-proxy/fixtures/fat-upstream.js\"]",
        "TOOLGATE_ALLOWED_TOOLS": "fat_tool_01"
      }
    }
  }
}
```

Without `toolgate-proxy`, point `command` and `args` at `fat-upstream.js` directly. Leave `TOOLGATE_ALLOWED_TOOLS` out to let every tool through.
