# ADR 0021 — Read-only navigation view

Status: accepted. Implemented; effect on review comprehension not measured.
Baseline: `main` after PR #104 (ADR 0020).

## Context

Reviewers cannot see which structure a review looked at. The Workbench shows findings and frozen
evidence, but not the graph lookups, caller traversals or host investigations behind them. AGENTS.md
excluded "a graph UI" from foundational work; this ADR narrows that exclusion instead of ignoring it.

Two facts shaped the design. The product path (`text+graph`) navigates through model graph tools;
`dispatch_v2` is an evaluation-only host path. Both leave traces only inside Pi session JSONL, which
Pi owns and which `src/application` must not depend on.

## Decision

1. **Scope (D1).** Allowed: a read-only view of one delivered run's recorded navigation. Not allowed:
   a repository-wide graph browser, graph editing, or a view that builds or queries a live graph.
2. **Host-owned record (D2).** `src/engine/navigation-recorder.ts` records structural navigation at the
   engine boundary: model `graph_lookup`/`graph_neighbors` pages and errors, and dispatch_v2
   `context_delivered`/`candidate_expanded` events through a read-only observer on
   `ProgressiveInvestigation`. Model LocAgent retrieval calls are not recorded; the record says so in
   `limitations`.
3. **Delivery and failure (D3).** `deliver()` writes `report.json`, `report.md`, then
   `navigation.json`, then `run.json`, which commits `navigation: { state: "recorded", sha256, … }`.
   A write failure, an oversized record (> 8 MiB) or an internal recorder fault records
   `navigation: { state: "unavailable", reason }` and the report is still delivered. Text-only and
   historical runs have no navigation field (`not_recorded`).
4. **Self-contained (D4).** The record stores entity and relation facts, not only ids. Endpoint
   entities that a neighbors page names only by id are described afterwards from the already
   published generation (`LazyCodeGraph.describe`), bounded to 5 s. Describing never builds a graph
   and is not counted as a graph tool call. Limits: 200 steps, 2,000 entities, 5,000 relations;
   exceeding one sets `truncated`.
5. **No model-visible change (D5).** The recorder copies pages after they are computed; tool results
   and prompts are byte-identical with or without it. Observer exceptions are swallowed.
6. **Location, not attribution (D6).** `evidence_overlap` marks entities whose location overlaps a
   finding's head evidence. It is not graph-assisted discovery; Attribution v3 remains the only
   causal measure.
7. **One DTO, several renderers (D7).** `navigationResponseSchema` (zod) is the contract. The
   Workbench renders it with React Flow and ELK in a lazily loaded chunk; `navigationMermaid()`
   renders it as deterministic Mermaid for the CLI (`navigation --run ID`). `report.md` is unchanged.
8. **Read-only server (D8).** `GET …/runs/:id/navigation` returns the projection after the report
   and navigation hash gates; `GET …/runs/:id/navigation/entities/:entityId/source` returns head
   source only for an entity the verified record shows, within the existing 200-line read limit.

## Consequences

- Reviewers can follow the order of structural navigation and jump to entity source.
- A tampered, replaced or symlinked `navigation.json` fails as `REPORT_INTEGRITY`, like a report.
- The view states coverage limits, truncation, missing entity facts and unrecorded paths explicitly.
- Not measured: whether the view improves reviewer comprehension or review speed.
