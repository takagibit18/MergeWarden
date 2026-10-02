# ADR 0017 — Progressive structural investigation

Status: experimental implementation; evaluation gates remain separate from availability.
Baseline: main at `35c382c61706ddd702b1bcb2af9dea22df74e013` (PR #11).

## Context

An observed source/search location is not the identity of a review investigation.
V1 could replace a production anchor with a recently observed test location, treat
multiple exact roots as one ambiguous request, or discard every hint after a bound
overflow. Structural metadata also cannot reliably settle semantic source choice.
The earlier Gate2B evaluation path was not the production dispatcher.

## Decision

Add opt-in `dispatch_v2` alongside `advisory` and `dispatch_v1`. The deterministic
router still decides activation; the host must execute the investigation. The
existing main review agent chooses additional source from a delivered catalog.
This implementation does not change the product default.

## Architecture

```text
immutable diff pages -> merged changed ranges -> frozen route focus
  -> per-hint exact HEAD resolution -> deduplicated ChangeUnits
  -> shared bounded hostStructuralInvestigation
  -> CandidateCatalog + at most one complete prefetched source
  -> native Pi custom context -> exact provider-payload exposure
  -> main agent expand_structural_candidate(candidateRefId)
  -> immutable source -> explicit EvidenceRef -> atomic final submission
```

`LocAgentRetrieval.investigate` and the new evaluation replay call the same shared
implementation. General escalation uses the existing deferred frontier, frozen
patterns, cap-two path retention, candidate construction and deterministic ordering.
Caller and inheritance routes use their one-hop relations. Import routes preserve
exports, direct consumers and consumers of up to four export targets.

## Why dispatch_v1 remains

V1 packages, dispatcher, anchor completion and attribution retain their original
semantics. Attribution v3 is unchanged. New results use `structural-dispatch-2`,
`mergewarden-structural-context-v2` and `host-dispatch-attribution-2`; they must not
reinterpret historical V1 results. ADR 0016 remains a historical contract.

## Investigation identity

Only complete immutable diff observations establish changed focus. Adjacent added
lines merge into ranges. Source/search observations extend visibility but cannot
replace focus. A route freezes its focus once; request and candidate identities
include the run and snapshot. A coalesced diff range can be wider than a declaration.

## Multi-root resolution

Each hint reports resolved, ambiguous, missing, deleted-head-unsupported or bounded
coverage. Exact path/name/range restrictions never widen to a global name search.
Overlapping equal scopes remain ambiguous. Independent exact declarations can
produce several roots, and repeated hunks deduplicate by entity identity.
Deletion-only hints do not query a base graph or fabricate a HEAD symbol.

At most 32 hints and 32 distinct resolved entities are admitted per resolution
request. Omitted ranges/entities remain explicit in host telemetry and limitations.
One ambiguous unit does not invalidate the others. Graph batches contain at most
five roots and share the investigation's remaining work budget.

## Candidate catalog

Opaque host-generated references bind candidates to a request. Cards contain exact
location, supporting roots, retained relation/direction sequences, visibility and
classification. Existing deterministic selection supplies display priority and one
initial prefetch; it is not a hard three-candidate gate or a relevance claim.

Function/class previews stop at the declaration colon, three lines or 512 UTF-8
bytes. File entities have no body preview. Decorator-first declarations may omit
their preview. Preview text is exploration only and never enters the registry.

## Progressive source acquisition

Only catalog references observed in an exact provider package may expand. The
small tool schema accepts just `candidateRefId`. The host determines a fixed
definition-start window of at most 80 lines, discloses the entity/returned ranges,
and caches successful reads. Longer inspection uses ordinary `read_source`.
Expansion already runs inside OperationGate and calls SnapshotStore directly;
it never queues a child operation behind itself.

## Evidence boundary

Prefetch: read -> complete package -> queued -> exact provider exposure -> eligible.
Expansion: admitted model tool -> immutable source -> normal source evidence.
Final findings must explicitly select evidence. Candidate discovery, relations and
previews alone cannot count as assistance. The V2 analyzer distinguishes selected
host-prefetched and model-expanded structural source. Hash, snapshot, generation,
catalog membership, active native branch and successful submission are checked.

## Budgets

Shared per investigation: 30 visited nodes, 200 inspected edges, 200 expanded states,
two alternative predecessors and the frozen pattern depth. Root batching does not
replenish these bounds. Existing episode/structural-call admission limits remain.
Packages stay at 24 KiB. Packing removes previews first, then redundant display
metadata, then whole low-priority cards; omissions are explicit. Complete source
pages are never sliced while retaining their hash. Expansion requests, actual reads
and source bytes have separate counters.

## Failure semantics

Partial resolution preserves exact roots and reports coverage limitations. Missing
and ambiguous units never acquire guessed identities. Cancellation closes new work.
Persistence failure poisons the run. CONTEXT_PENDING prevents final acceptance
before pending host context reaches the provider. Retrieval completion is not a
semantic finding or a proof of safety.

## Evaluation gates

Gate 0: full existing regression and synthetic A–L mechanical invariants.
Gate 1: no model calls; public frozen prefixes, equal activation moments, V1/V2
comparison, separate forced-END historical diagnostic, and 100 byte-stable replays.
Inputs and executions freeze under Node filesystem permission isolation before
scoring. Each successor uses a new output directory; failures are preserved.
Gate 2 requires Gate 1 PASS before candidate-choice model experiments. Gate 3
requires Gate 2 PASS before actual routed review comparison. Unrun stages cannot
support a quality claim. RealGolden gold/audit remain unchanged.

## Rejected alternatives

- Soft advisory only: route activation must perform bounded host execution.
- A fixed-three hard candidate gate: later semantic inspection needs the catalog.
- A second supervisor or agent loop: Pi's existing main agent owns inspection.
- Active semantic routing in this phase: route decisions stay deterministic.
- Private-target-aware retrieval: labels and scorers cannot guide public inputs.
- New ranking weights, schema/edge kinds, GNN, CFG/SSA/dataflow/taint: out of scope.
