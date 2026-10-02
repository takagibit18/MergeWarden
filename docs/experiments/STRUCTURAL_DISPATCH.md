# Structural dispatch experiment

## Progressive dispatch v2 (2026-09-26)

Contract: [ADR 0017](../adr/0017-progressive-structural-investigation.md).
Use the same internal configuration below with `executionStrategy: "dispatch_v2"`.
The host executes structural work; the model sees a compact catalog and one
prefetched source, then may call `expand_structural_candidate` with a delivered
reference. Direct graph tools remain inactive. The product default is unchanged.

The shared implementation is `src/experiments/locagent/host-investigation.ts`.
New public-only evaluation entry points:

```sh
node --experimental-strip-types eval/investigation-gate1-launch.mjs NEW_OUTPUT HISTORICAL_UTILITY_OUTPUT
node --experimental-strip-types eval/investigation-admission-launch.mjs NEW_OUTPUT HISTORICAL_FULL_CONTEXT_OUTPUT PASSED_GATE1_OUTPUT
```

Both refuse an existing output directory, freeze implementation/public inputs,
run under Node filesystem permission isolation, verify private scorer denial,
and hash-freeze generated outputs. Gate 1 separates actual activation from the
historical forced-END diagnostic. No scorer or model runtime enters generation.

Baseline verification: 438 passed. V2 mechanical verification: 456 passed, zero
failures/skips. Controlled identity/root/evidence/queue/packing and native Pi HTTP
checks pass. Historical V1 dispatcher, Attribution v3 decoder, evidence registry
and OperationGate source files remain unchanged.

Gate 1: historical diagnostic whole-request ambiguity 14/24 -> 0/24; V2 has
15 resolved, 8 partial and 1 missing, with 23 graph starts and 17 catalogs.
Actual route timing: only 3/24 activate; V2 has 2 graph starts and 1 catalog.
These mechanical results do not establish review value.
An independently named performance successor repeated all 24 diagnostics 100 times
and the three activated cases 100 times: byte-stable task/root/catalog/package output.
Median p50 across 24 diagnostic cases: 9.10 ms; worst case p95: 44.62 ms; max: 74.08 ms, excluding graph
load/index creation. Max package: 24,503 bytes; max queue: 26; sampled heap: 168.1 MiB.
The 34-session Attribution v3 two-pass replay is byte-identical to its historical archive.

Gate 2 admission: the pre-existing 12 RealGolden registrations plus D3/D4/D6
produce 13 independent cases. Eight never route, two have ambiguous named roots,
one has a one-card catalog, and two satisfy public prerequisites. This upper
bound is below six even before private target membership is checked. Stop here:
strong/small model arms, target-aware scoring and Review E2E are NOT_RUN.
F0–F5, finding precision/recall and necessary-fact coverage are unmeasured.

Outputs: `../output/progressive-structural-investigation-20260926/` outside the
checkout. Original failed attempts and all older experiment directories remain.

## Historical dispatch v1 contract

Contract: [ADR 0016](../adr/0016-structural-dispatch.md). Pi stays at the three
existing lockfiles, including pi-coding-agent 0.84.1. Product default is unchanged.

Enable only through ReviewEngine's internal evaluation configuration:

```ts
evaluation: {
  tools: "text+locagent",
  graphMode: "prepared_only",
  routing: "pi_structural_v2_investigate",
  executionStrategy: "dispatch_v1"
}
```

Omitting executionStrategy, or using advisory, retains the old behavior. Dispatch
requires routing and a prepared G1 graph. It does not prepare graphs, invoke another
model, read labels, or launch reserve/formal experiments.

Responsibilities:

| Module | Responsibility |
|---|---|
| Pi structural-routing | Existing signal/threshold decisions; transport bridge |
| dispatch-anchors | Observed changed positions and source-window intersections |
| LocAgent locate | Strict read-only file/name/kind/scope/range metadata lookup |
| dispatch-retrieval | Fixed directions, definite relations, exact generation |
| dispatch-service | Deduplication, bounded candidates, source and exposure lifecycle |
| operations + ReviewEngine | Shared admission, permissions, total budget, cancellation |
| Pi structural-dispatch | Await then native steer message; provider-payload inspection |
| provenance/dispatch | Separate host-dispatch-attribution-1 offline measurement |

Frozen limits are exported as DISPATCH_LIMITS. Every locate, traversal and source
read is a charged operation. Each traversal has 30 nodes/8192 bytes; general
exploration has 3 hops; import inspection selects at most 4 targets. The package
has a 24 KiB ceiling, source windows have 80 lines, and original source hashes are
never reused for sliced text. A route budget can reduce the original 2/4/6 caps.
The pre-existing per-read source ceiling remains 200 lines/32 KiB.

Run manifests keep model tool counters and dispatch operation counters separately.
`graphToolCalls` counts model-issued Graph requests; `graph.calls` includes actual
Graph backend requests from both origins. Dispatch metrics separately include
`sourceReads` (host read requests), `sourceReadOperations` (admitted source service invocations), execution terminals, delivered bytes and host latency. Synthetic
provider token usage is never a real model cost measurement.

Host source is first recorded privately, then placed in a bounded native custom
message. Only exact package text observed in before_provider_request grants final
reference eligibility. submit_review rejects pending context, and the next model
response may submit explicitly chosen IDs. The package includes the entity and
relation path, exact source and EvidenceRef ID. Read source not selected by the
model is never attached automatically. Persistence failure is terminal.

`eval/dispatch-diagnostic.mjs DATASET EXTERNAL_OUTPUT CASE_ID...` copies exact
snapshots, source blobs and published generations into a separate diagnostic state.
It replays existing C read-only observations through the first route activation
(all read-only observations for untriggered controls), using real Pi HTTP
serialization with a scripted response. It compares advisory and dispatch on that
same prefix; it calls no model and makes no semantic submission. Cases, budgets
and prefixes are written before execution. Original snapshots/generations are
hash-checked again afterward. Audit comparison must happen outside this program,
after outputs are frozen. Output must be outside the checkout.

Acceptance runs `npm run verify`, the real Pi dispatch tests and unchanged historical
v3 replay. A successful transport chain does not imply decisive context retrieval,
a correct finding, complete dynamic dispatch, MRO or shared-configuration coverage.
