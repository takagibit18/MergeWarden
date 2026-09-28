# ChangeUnit semantic intent router shadow evaluation

Experiment identity: `changeunit-semantic-intent-shadow-1`.
This is an eval-only capability experiment at an existing frozen public checkpoint.
It does not establish product invocation timing, source-fact coverage or review quality.
The active deterministic router, Pi tools, Graph, candidate ordering, evidence and
dispatch defaults remain unchanged.

## Contract

The model chooses zero to two unique `(changeUnitId, intent)` pairs. Intents are
CALLER_CHECK, IMPORT_CHECK, INHERITANCE_CHECK and RELATIONSHIP_CHECK. The last maps
to the existing STRUCTURAL_ESCALATION template. It cannot supply entity IDs,
paths, graph parameters, source windows or candidate references. Empty arrays are valid.
Rationale is diagnostic only, at most 240 characters, and never a scoring input.

Public ChangeUnits come from complete frozen diff pages and the existing exact
HEAD resolver. The card contains observed changed-side snippets, not unseen bodies.
Function units support caller/general plans; class units support caller/inheritance/
general plans because the existing Python resolver supports constructor CALLS;
file units support import/general plans. Unresolved units cannot become roots.

## Phases and isolation

1. Verify the clean baseline. Deduplicate the frozen route-recall universe. Exclude
   deterministic route hits from semantic model calls. Recheck exact prefix hashes,
   replay real deterministic routing twice, resolve units twice, and check immutable
   prepared graph/snapshot identities. Require at least six defect and eight clean
   public no-route cases before any model request.
2. Freeze the prompt/schema/configuration, deterministic SHA256 case order, opaque
   SR/CU aliases and public inputs. Use one independent BigModel GLM-5.3-Flash call
   per admitted case. Tools are empty, temperature zero, top_p one, existing medium
   thinking, 180-second timeout, no retry/repair. Node permissions deny private
   targets, previous semantic predictions and the label-bearing universe.
3. Freeze every first attempt before reading historical necessary targets. Enumerate
   at most 32 legal plans per defect in public unit/intent order. Each oracle plan
   gets normal single-investigation bounds; its cumulative cost is not product cost.
   Require four structurally actionable defects before predicted-plan scoring.
4. Execute the frozen model plans in order, sharing two route episodes and six total
   structural calls. Each investigation retains the product's 30-node/200-edge/
   200-state/two-predecessor limits, one prefetch, 80-line window and 24-KiB package.
   Compare exact snapshot/path/range containment in delivered-format catalogs.

`eval/intent-router/execute.mjs` is a narrow eval adapter from an already resolved
public ChangeUnit to host APIs. It uses LocAgentRetrieval's resolver/investigate,
hostStructuralInvestigation, candidateCard, candidateSource and packInvestigation.
It does not clone the traversal/selector algorithm or create a review session.
Tests compare its catalog byte-for-byte with the product dispatcher on controlled
input. Every real oracle/prediction execution also repeats deterministically.

## Gate and interpretation

OpportunityRecall is recovered actionable defects divided by actionable defects,
not all defects and not finding recall. Require at least 75%, at least three recovered
cases, zero format/provider failures, mean clean plans at most 0.5 and at most one
clean case with two plans. Clean investigation is a cost, not an invented false positive.
Non-actionable defects and insufficient private targets are reported separately.

Public shortage, private actionability shortage and operational/provider failures
are INCONCLUSIVE. Oracle/prediction execution drift stops the experiment as a
mechanical error. No tuning or replacement of scored first attempts is permitted.
Even a PASS only permits a later, separately authorized CandidateCatalog selection
experiment. Small models, active semantic routing and Review E2E remain outside scope.

## Entry points

All output paths must be new directories outside the checkout. The preparation
launcher requires `baseline.json` and a successful `baseline-exit.txt` there.

```sh
node --experimental-strip-types eval/intent-router/prepare-launch.mjs OUTPUT ROUTE_RECALL_OUTPUT
node --experimental-strip-types eval/intent-router/model-launch.mjs OUTPUT
```

Private target preparation is allowed only after `phase-b/prediction-freeze.json`
validates. Oracle and scoring then use the following commands; scoring refuses a
failed private actionability gate:

```sh
node --experimental-strip-types eval/intent-router/prepare-targets.mjs OUTPUT ROUTE_RECALL_OUTPUT
node --experimental-strip-types eval/intent-router/audit.mjs OUTPUT
node --experimental-strip-types eval/intent-router/oracle.mjs OUTPUT
node --experimental-strip-types eval/intent-router/prediction-execute-launch.mjs OUTPUT
node --experimental-strip-types eval/intent-router/score.mjs OUTPUT
```

The prediction executor runs in a separate permission process which cannot read
private targets or the oracle. If the private actionability gate fails, stop before
that executor; `finalize-inconclusive.mjs OUTPUT` records NOT_RUN downstream stages.

Outputs include first-attempt raw responses, public/prediction/oracle/scoring freezes,
anti-leakage audits, candidate reach, clean costs and a separately labelled hybrid
shadow funnel. Original experiment artifacts remain immutable.

## Measured status — 2026-09-26

Baseline `e60aa37`: 456 passed / 0 failed / 0 skipped. Final full regression:
478 passed / 0 failed / 0 skipped, including 22 new eval tests. Product files are
unchanged. Gate 1's 24 diagnostic and three actual-trigger package hashes match
the prior run after 100 replays each; 34 Attribution v3 sessions replay identically.

The 28-case frozen universe has 8 defect and 13 clean route misses. Public admission
accepts 7 defects and all 13 clean cases; one deletion-only defect has no resolved
unit. All 20 independent first attempts finish: 15 format-valid, 5 format failures,
zero provider failures, 235,102 observed tokens. No retries or repairs occur.

After prediction freeze, exact historical requiredUntouched targets are available
for all seven defects. The oracle executes all 36 legal plans twice, with no omitted
plans or resolution failures. Only one defect is structurally actionable; six are
not actionable under the frozen legal plans and budgets. The minimum is four.

Status: **INCONCLUSIVE — INSUFFICIENT STRUCTURALLY ACTIONABLE ROUTE MISSES**.
Predicted-plan execution, Primary OpportunityRecall, clean Graph costs and hybrid
simulation are NOT_RUN. Static comparison for the single actionable case finds the
same ChangeUnit but CALLER_CHECK instead of the oracle-success RELATIONSHIP_CHECK.
This is a diagnostic, not a scored Phase D result. Among nine format-valid clean
outputs, three select zero plans, four select one and two select two. Four additional
clean outputs are invalid, not zero-plan decisions. Their eight valid plans imply a
full-13-case lower bound of 8/13, already above the 0.5 planning-cost threshold.

Next-stage choice: **C. EXPAND STRUCTURALLY ACTIONABLE DATASET**. No Candidate
Selection, small model, active semantic router or Review E2E is run or enabled.
Artifacts remain outside the checkout in
`../output/changeunit-semantic-intent-shadow-20260926/`.
