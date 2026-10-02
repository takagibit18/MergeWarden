# ADR 0016 — Deterministic structural dispatch

Status: experimental implementation contract. Baseline main: 60b745d.

`executionStrategy` is independent of RoutingMode. Omitted/`advisory` preserves
existing behavior. `dispatch_v1` requires explicit evaluation routing, G1 and
prepared_only. Signals, thresholds, Graph v4, resolver, scope and construction
budgets stay frozen. No online audit, labels, semantic judge or model fallback.

Rules select the investigation type only. The host completes a request from
observed changed paths/ranges, resolves an exact HEAD entity, executes bounded
definite relations and reads candidate source. The agent interprets source,
forms findings and explicitly selects evidence. Execution completion is neither
an answered question nor a safety claim. Missing/deleted HEAD anchors remain
missing; ambiguous scopes remain ambiguous. No base graph or global name fallback.

Every locate, traversal and source operation uses the same Engine admission queue
as model tools: permissions, run state, cancellation, shared total budget and
result recording. Host operations have a separate ledger and never impersonate
assistant tool calls. Hooks await dispatch after the original tool job settles;
no queued job may await a child job queued behind itself.

Frozen v1 limits: 2 episodes, 4 structural operations/episode, 6/run;
3 automatic source reads/episode; existing 200 lines/32 KiB per read;
24 KiB/package. Shared review limit includes both origins. No live budget tuning.

Templates: caller = exact callable -> incoming CALLS, one hop. Inheritance = exact
class -> INHERITS both directions, one hop (no MRO/runtime type inference).
Import = exact module -> outgoing IMPORTS targets -> incoming IMPORTS consumers,
plus direct module consumers. IMPORTS points from importing scope to target.
General = exact observed changed function/class -> CALLS/IMPORTS/INHERITS both
directions, three hops. No CONTAINS dependency inference.

Frozen candidate ordering: definite rooted paths only; source not yet shown,
unchanged paths, depth/path/line/entity ID. Three unique windows maximum; prefer
the relation site in the entity, otherwise its definition. Windows are at most
80 lines. Disclose omitted candidates/ranges. Omit whole pages when the package
would exceed its limit; never slice text while preserving the old hash.

Pi remains 0.84.1. Installed docs/extensions.md and core/agent-session.js specify
tool_result after execution and sendMessage deliverAs=steer after the tool batch,
before the next model call. appendEntry is private, not context. Independent
native custom messages preserve original tool results. before_provider_request
checks exact package text in the serialized payload before evidence eligibility.
No followUp, recursive prompt or second loop. A submission generated before pending
context is consumed returns recoverable CONTEXT_PENDING. Other same-batch reads
are not attributed as influenced by the new package.

Host evidence stages: read -> packaged -> observed in provider request -> selected.
Only actual provider exposure grants registry/source-read eligibility. Unknown,
cross-run/snapshot, omitted and undelivered refs fail closed. Reports retain full
EvidenceRef and atomic final acceptance. Persistence failure poisons the run.

Every accepted request terminates as context_returned, no_definite_relation,
anchor_missing, anchor_ambiguous, coverage_limited, budget_exhausted, cancelled or
error. Partial positive edges and existing source survive later budget exhaustion;
empty results never prove absence. No semantic success/safety labels.

Dispatch attribution has a separate versioned adapter; v3 model attribution is
unchanged. Native custom content proves exposure; private execution/delivery
entries assist verification. Model-selected Graph and host-dispatched assistance
are counted separately. Simultaneous automatic Graph/source delivery cannot meet
the historical Graph-then-model-source metric. No historical score backfill.

Acceptance uses real Pi SDK, scripted HTTP, Engine and temporary prepared graphs,
then exact fixed-snapshot diagnostics. Optional live requires authorized quota and
all gates; maximum 8 first attempts. No reserve/formal is started by this work.
