# PR service / GitHub App — deferred

Immutable commit identity, webhook authentication, redelivery idempotency, task supersession, isolation, least-privilege credentials and stale comment handling are required. No remote writes are implemented.

Reuse the engine boundary in `src/protocol/contracts.ts`; do not fork the review loop.
