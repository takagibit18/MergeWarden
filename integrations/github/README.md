# GitHub

The GitHub Actions channel is implemented as a reusable workflow, not a GitHub App:
[`.github/workflows/mergewarden-channel.yml`](../../.github/workflows/mergewarden-channel.yml), the `github` CLI commands
and `src/channels/github.ts`. Design: [ADR 0024](../../docs/adr/0024-github-actions-channel.md). Setup: [docs/github-actions.md](../../docs/github-actions.md).

A PR service or GitHub App (webhook authentication, redelivery handling, task supersession, isolated workers) remains deferred.
Reuse the engine boundary in `src/protocol/contracts.ts`; do not fork the review loop.
