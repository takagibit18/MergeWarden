# Finding delivery Python fixture A/B round — 2026-09-09

## Scope

This is one bounded real-provider A/B round over two repository-backed Python
fixtures. It uses `zhipu / glm-5.3-flash`, `temperature=0`, one sample per
fixture and variant, `semantic-v3`, and `retry_invalid=false`. The warm graph
priming calls are recorded separately and are not counted as measured samples.

| Fixture | Repository snapshot | Expected finding |
| --- | --- | --- |
| `golden_pydantic_pydantic_pr12117` | `pydantic/pydantic` PR #12117, `2dcb1ff1689ccd64de0d1570dbff002dc66f7439` | `BaseModel.model_copy(update=...)` drops unknown update keys while marking them as set |
| `golden_deepset-ai_haystack_pr12208_reverse` | `deepset-ai/haystack` PR #12208, `4d9082be92d11d11e82c14030073ee70c64fdb53` | `JSONConverter` uses a missing `file_path` key while handling source errors |

The runner completed with `Runner readiness: PASS`: 4 measured runs, 2 warm
priming records, no automatic retries, no pairing errors, and implementation
commit `6f1e8b6bcdfc28a279eabddd0d8d8dbbe7436eb8`.

## Measured results

`repair` is shown as `attempted/succeeded`; `published` is the final finding
count after verifier and repair gates.

| Fixture | Variant | Schema / run | Candidate | Submitted | Repair | Published | Terminal reason | Provider attempts | Tokens | Latency |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
| Pydantic | A-agent-search | invalid / incomplete | 0 | 0 | 0/0 | 0 | `iteration_guard`, placeholder output | 3 | 46,893 | 47.19s |
| Pydantic | B2-graph-hybrid-warm | valid / incomplete | 1 | 1 | 1/0 | 0 | `finding_delivery_incomplete` | 4 | 52,418 | 94.83s |
| Haystack | A-agent-search | valid / incomplete | 1 | 1 | 1/0 | 0 | `repair_target_unknown` | 5 | 59,869 | 79.51s |
| Haystack | B2-graph-hybrid-warm | valid / incomplete | 1 | 1 | 1/0 | 0 | `finding_delivery_incomplete` | 5 | 68,512 | 103.12s |

All provider attempts completed without provider failures or unknown-usage
accounting. B2 warm priming took 23.64s for Pydantic and 42.94s for Haystack;
both measured graph runs reported persistent graph-cache hits and no missing
production paths.

## Delivery-chain reading

- The evidence catalogs were emitted and their records were marked
  `delivered` in all four journals. This round therefore did not reproduce an
  evidence transport loss.
- Pydantic A produced a draft, but the model spent the three allowed
  iterations on additional search and never reached `submit_review`; the
  runtime correctly classified it as a placeholder/iteration-guard run.
- Pydantic B2 registered one candidate, but the repair transaction ended with
  `role_claim_missing` / `support_role_missing` and an unresolved support
  reference. It was not guessed or force-published.
- Haystack A registered the expected converter finding, but its repair path
  ended in `repair_target_unknown`; the candidate remained `needs_repair`.
- Haystack B2 registered one candidate, but the submitted support references
  remained unresolved, so the repair transaction ended with
  `support_reference_unresolved` and the finding stayed unpublished.

The measured A/B result is therefore operationally useful for the delivery
chain, but it is not evidence of a quality win: final publication was `0/4`
and the aggregate hit rate was `0.0`. The summary also marks the experiment as
not ready for a formal paired A/B claim because one measured run was invalid and
no expected finding reached final publication.

## Artifacts

- Config: `eval/variants/finding-delivery-python-ab-20260909.yaml`
- Compact summary: `eval/experiments/finding-delivery-python-ab-20260909-zhipu-summary.json`
- Raw/checkpoint/journals: `eval/outputs/finding-delivery-python-ab-20260909-zhipu/`

The raw output directory remains ignored and local. No `.env` file, source
implementation, prior experiment output, or user-owned untracked document was
modified.
