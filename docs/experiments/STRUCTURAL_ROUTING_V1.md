# Structural Navigation Routing v1

Internal evaluation policy, default `none`. Product CLI, T0, G0, and ordinary G1 retain their current exposure and prompts. Only `evaluation.tools = text+locagent` accepts `routing = pi_structural_v1`. Graph schema/resolver/scope/budgets, prepared-only, gold, finding schema, and source evidence checks are unchanged.

## Motivation and mechanism

Prior observed ABC diagnostics found zero Graph calls with text present, autonomous Graph use after removing text, and successful source discovery with explicit structural instructions. This is a tool-selection hypothesis, not evidence that every cross-file review benefits from Graph.

The implementation follows Pi **0.84.1** public [extensions](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/docs/extensions.md), [plan-mode](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/examples/extensions/plan-mode/index.ts), [tools](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/examples/extensions/tools.ts), and [dynamic-tools](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/examples/extensions/dynamic-tools.ts) mechanisms. Conditional extra investigation and retrieval feedback are design influences; no additional agent, model, planning round, or hidden Graph query is introduced.

Register the full immutable allowlist with the SDK (`tools` is also a registration filter). At `session_start`, activate only read_diff/read_source/search_text/submit_review. A successful triggering `tool_result` enables search_entity/traverse_graph once, appends one advisory content block, and persists CustomEntry state. No extra model turn. Guidance and graph output are never finding evidence.

## State and thresholds

IDLE → RECOMMENDED (signal and tool activation) → ACTIVE (actual admitted structural request) → VERIFIED (Graph-first untouched candidate followed by successful HEAD read_source covering its range). Failed/unavailable structure or incomplete empty relationship results enter DEGRADED; use text/source. SUPPRESSED records unavailable tools, text verification, an existing investigation, or budget exhaustion. Tools stay active after activation; the hook still limits execution.

`pi-structural-routing-1` freezes three consecutive searches without a new untouched source read, or an identifier-like search with truncation / at least eight distinct paths, as search pressure. Reading untouched source prevents mechanical count-based escalation for the current investigation. For symbol-specific high-confidence routes, a prior matching text query and successful untouched source read suppress redundant activation.

High-confidence Python cues: same-name callable parameter change, callable removal (including obvious rename, without guessing the new target), same-name class base change, explicit `__all__` or package initializer import/re-export change. Return annotation and obvious literal shape changes are weak only. Arithmetic, scalar return edits, assertions, comments, and recognized docstrings do not activate.

Diff pages are cached by path/offset and de-duplicated. Signals are evaluated only after the entire file diff is available; repeated pages cannot repeat the route. Identity is route type + target hint + changed path. Defaults: two episodes, four structural calls per episode, six total; optional evaluation overrides can only lower limits. Concurrent signals are suppressed while an episode is active, keeping attribution unambiguous. A verified episode ends its structural allowance; a later distinct high-confidence cue can open the second episode.

## Safety, persistence, and telemetry

The safety extension and executor retain the immutable allowlist. The routing hook never queries Graph. Blocked requests are accounted by the ReviewEngine and consume its request budget; routing exhaustion alone does not abort the review. Cancellation, submitted state, lifecycle status, and executor budgets remain authoritative.

Every transition and observation is checkpointed using `mergewarden-structural-routing-v1`; CustomEntry does not enter model context. Restore uses only the current session branch and matching snapshot/version, including observations, counts, candidates, and deduplication state. Product session resume is not added.

Independent metrics distinguish triggered signals, activated episodes, structural attempts, verified routes, degradation, suppression, reasons, and first activation ordinal. Existing navigation/Graph/trace metrics remain. Native trace decoding recognizes the separate routing guidance block but parses only original JSON data; strict graph-assisted evidence attribution is unchanged.

Additional requests after VERIFIED or DEGRADED retain that terminal resolution and record one private suppression reason per episode. The generic structural block response remains unchanged. Graph request counts from native traces include blocked calls; actual executed queries are reported separately by the engine's graphToolCalls metric.

## Validation and development protocol

Pure signal tests, actual Pi + intercepted HTTP provider requests, six positive/negative end-to-end fixtures, pagination, restore, allowlist, source range, prepared-only, budget accounting, cancellation, and existing evidence tests precede `npm run verify` (zero failed/skipped).

`node --experimental-strip-types eval/structural-routing.mjs prepare OUTSIDE_CHECKOUT` freezes eight synthetic development cases, snapshots, prepared Graph generations, code commit/fingerprint, model, budgets, thresholds, and counterbalanced A/B order. Record successful deterministic acceptance in `offline-results.json` before running `run OUTSIDE_CHECKOUT CASE A|B`. Each first attempt is reserved before starting its model run; retries/overwrites are rejected. `analyze OUTSIDE_CHECKOUT` emits routing-analysis.json; protocol.json and live-results.json preserve raw identities and results.

A is unchanged G1 (navigation system policy present); B starts with the same baseline review prompt but defers that capability to tool definitions and the route hint. This intentional prompt/exposure difference is part of the policy treatment. Both arms share the same review request, snapshot, Graph generation, model, 450-second/100-tool limit, 16,384 max tokens and low provider reasoning effort. Run each case/arm once, A→B and B→A alternating. Stop if more than one negative activates. Never restart the stopped formal 120-run.

Development thresholds: at least 3/4 positive signals, at most 1/4 unnecessary negative activation, at least two positive novel relationship→source chains. Report waste and unattempted recommendations, finding sanity only, no eight-case F1. Even a pass requires a separate decision, reserve, lock, and output directory before any formal experiment.

## Known limits

Signals are conservative lexical Python diff cues, not semantic parsing. Multiline declarations, ambiguous repeated method names, a diff starting inside a long docstring, dynamic exports, and complex return shapes can be missed or ambiguous. Graph limitations remain visible; no dynamic MRO claim or wildcard fallback. Search pressure treats the review's current text investigation as one episode and conservatively suppresses after an untouched read; it may miss a later independent unresolved question. Full file diff collection can delay activation. Candidate source verification does not prove a defect, and routing success alone does not make a finding graph-assisted.
