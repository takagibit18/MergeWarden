# Real zhipu / glm-5.3-flash — recent high-value fixture A/B

## Selection

This run selected the three most recently completed positive golden fixtures in the formal-readiness checkpoint, ordered by their last recorded completion time:

1. `golden_pydantic_pydantic_pr12117`
2. `golden_vybestack_llxprt-code_pr3012_reverse`
3. `golden_deepset-ai_haystack_pr12208_reverse`

Negative controls and the synthetic development smoke fixture were excluded. The paired variants were the same post-repair contract used in the prior real-model run: `A-agent-search` versus `B2-graph-hybrid-warm`. The model provider was real `zhipu` with `glm-5.3-flash`; invalid provider payload retries were disabled.

## Measured results

| Fixture | Variant | Gold / quality | Token cost | Latency | Termination / boundary |
| --- | --- | --- | ---: | ---: | --- |
| Pydantic PR12117 | A | hit 0/1; verifier 0 accepted / 1 rejected | 45,099 | 96.276 s | `repair_target_unmatched` |
| Pydantic PR12117 | B2 warm | hit 0/1; verifier 0 accepted / 1 rejected | 54,512 | 89.463 s | `natural_model_stop`; 17,082 graph nodes, 83,163 edges |
| llxprt PR3012 reverse | A | hit 0/1; 1 evidence-complete false-positive candidate | 68,196 | 91.073 s | `support_role_missing` |
| llxprt PR3012 reverse | B2 warm | hit 0/1; verifier 0 accepted / 1 rejected | 70,592 | 115.129 s | `support_role_missing`; graph had no required production path |
| Haystack PR12208 reverse | A | hit 0/1; verifier 0 accepted / 2 rejected | 58,272 | 71.194 s | `finding_contract_incomplete` |
| Haystack PR12208 reverse | B2 warm | hit 0/1; verifier 0 accepted / 1 rejected | 52,162 | 102.191 s | `repair_target_unmatched`; 10,140 graph nodes, 80,833 edges |

Totals across the three measured fixtures:

- A: 13 provider attempts, 171,567 successful total tokens.
- B2 warm: 12 provider attempts, 177,266 successful total tokens.
- Runner readiness: PASS; pairing errors: 0; invalid measured runs: 0.
- Provider-reported dollar cost was unavailable; token usage and latency are retained instead.
- Formal paired A/B readiness remains false because this is one sample per fixture and all three semantic gold matches were misses.

One real model payload was rejected during the pydantic run because `issues[0].supports[0].evidence_refs` was empty. The runner preserved the failure and continued; it did not treat the rejected payload as a successful finding.

The raw run is kept locally under `eval/outputs/graph-ab-glm53-flash-recent-high-value-20260909-zhipu/`; the compact summary is committed at `eval/experiments/graph-ab-glm53-flash-recent-high-value-20260909-zhipu-summary.json`.
