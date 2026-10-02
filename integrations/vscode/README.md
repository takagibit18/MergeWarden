# IDE adapter boundary — proposed first user-facing surface

This is NOT a loadable/published extension. No `main`, commands or mock chat UI are advertised.
First vertical slice: fixed staged/saved-workspace/commit snapshot -> separate engine process ->
progress and completed report -> native editor evidence navigation.

Use `src/protocol/contracts.ts` as the product protocol, not terminal text parsing.
Implement a versioned IPC handshake, cancellation, stale snapshot detection, workspace trust,
Remote SSH/WSL/Container placement and secret handling before UX polish.

Unsaved editor buffers are out of scope for v1. A findings card is not a live statement about a
newly edited buffer. The engine must verify snapshot identity before showing/applying anything.
Candidate UI selection remains a product recommendation, not a confirmed exclusive product direction.
