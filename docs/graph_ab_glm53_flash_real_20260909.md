# Real zhipu / glm-5.3-flash A/B delivery record — 2026-09-09

## Scope

Ran the existing v3 paired runner against the real `zhipu` provider with `glm-5.3-flash`, one validation sample per variant, and invalid provider payload retries disabled. The API key and raw request/response bodies are not included in the repository report.

The runner recorded `f681122` as `HEAD` because the experiment ran before the final implementation commit. The second-stage working-tree changes were present during the run; the delivered implementation is `61ccf60`. This distinction is kept explicit so the experiment is not misattributed to a commit that did not yet exist.

## Results

| Fixture | Variant | Quality | Tokens / latency | Delivery boundary |
| --- | --- | --- | --- | --- |
| Discount | Agent Search | hit 1/1, precision 1.0, evidence complete 1, repair-unit accuracy 1.0 | 26,891 total; 35.864 s; 4 provider attempts | valid finding |
| Discount | Graph Hybrid Warm | hit 1/1, precision 1.0, evidence complete 1, repair-unit accuracy 1.0 | 31,106 total; 32.406 s; 4 provider attempts; cache hit rate 0.75 | valid finding; 2 selected production paths |
| Haystack PR12257 | Agent Search | hit 0/1, root-cause recall 0.0, evidence complete 0 | 73,390 total; 250.097 s; 4 provider attempts | verifier rejected 2 candidates; terminated `support_role_missing`; one invalid submit payload lacked `issues[0].evidence` |
| Haystack PR12257 | Graph Hybrid Warm | hit 0/1, root-cause recall 0.0, evidence complete 0 | 69,336 total; 138.441 s; 3 provider attempts | terminated `natural_model_stop`; no verifier candidates; graph had 18 required paths and 0 missing paths |

Provider-reported dollar cost was not available, so the report preserves token usage and latency rather than inventing a monetary cost. `ready_for_formal_paired_ab` remains false: this was one sample per variant and runner evidence only.

## Verification after implementation commit

- Full regression: `917 passed, 1 skipped, 3 warnings`.
- v3 replay and semantic regression: `6 passed`.
- Delivery-contract focused regression: `117 passed`.
- `ruff check .`: passed.
- `mypy src/`: passed.
- Real `ModelClient` construction/close smoke test: passed under the host proxy environment; only `ALL_PROXY` / `all_proxy` were bypassed during HTTP client construction, while HTTP/HTTPS/NO_PROXY settings were preserved and restored.
- Repository-wide `ruff format --check .` remains a pre-existing formatting gate with 139 files needing reformatting; no unrelated bulk rewrite was made.

## Delivery state

Local commits, in order:

1. `b4daf4e` — integrate existing analyzer/finding delivery hardening.
2. `f681122` — record the delivery-stage contract before implementation.
3. `61ccf60` — enforce evidence dependencies, atomic repair protocol, budget sequencing, phase-specific schemas, validator truthfulness, and proxy-safe client construction.

The configured target base is an ancestor of this branch, so the local integration is complete. Remote PR/merge could not be asserted because the available GitHub CLI credentials returned HTTP 401; no remote merge claim is made. The two pre-existing root documents `导学-MergeWarden.md` and `面经-MergeWarden.md` remain untracked and were not included in any commit.
