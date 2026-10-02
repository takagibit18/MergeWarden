# ACP editor adapter — deferred

Separate editor-to-agent integration from MCP tool exposure. Pin the actual ACP protocol before implementation; this directory does not claim ACP compatibility.

Reuse the engine boundary in `src/protocol/contracts.ts`; do not fork the review loop.
