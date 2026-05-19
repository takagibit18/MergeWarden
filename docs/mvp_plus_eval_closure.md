# MVP+ Eval Closure Baseline

This note records the May 18, 2026 golden-eval closure point used as the
current MVP+ quality baseline.

## Current Baseline

Report: `eval/outputs/20260518_151719_report.json`.

| Metric | R13 | R14 | Change |
| --- | ---: | ---: | ---: |
| Schema validity | 100.00% | 100.00% | unchanged |
| Hit rate | 25.00% | 75.00% | +50.00 pp |
| False positive rate | 0.00% | 0.00% | unchanged |
| Average latency | 55.59s | 49.74s | -10.5% |
| Average tokens | 25,118 | 23,902 | -4.8% |

R14 clears the stable numeric gate target:

```bash
python -m eval.gate --report eval/outputs/20260518_151719_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5
```

## Fixture Outcomes

| Fixture | Expected | Matched | Result |
| --- | ---: | ---: | --- |
| `golden_astral-sh_ruff_pr24648` | 0 | 0 | PASS |
| `golden_NethermindEth_nethermind_pr5381` | 1 | 1 | HIT |
| `golden_pytest-dev_pytest_pr7254` | 1 | 1 | HIT |
| `golden_pytest-dev_pytest_pr8513` | 1 | 0 | MISS |
| `golden_pytest-dev_pytest_pr9350` | 1 | 1 | HIT |
| `golden_real_requests_netrc_pr7205` | 0 | 0 | PASS |

The two negative fixtures stayed clean, so the hit-rate improvement did not
come from broad false-positive relaxation. The only remaining golden miss is
`golden_pytest-dev_pytest_pr8513`, which should be handled as follow-up eval
quality hardening rather than an MVP+ release blocker.

## Recent Closure Changes

The R10-R14 improvements came from narrowing the agent-output boundary rather
than adding broader issue scraping:

- Force-submit behavior made final review submission deterministic near the
  iteration boundary, which recovered `golden_pytest-dev_pytest_pr7254` in R10
  while keeping both negative fixtures at zero false positives.
- Inline code evidence and full effective issue matching preserved the
  Nethermind `_gcKeeper` finding and allowed same-file evidence that cites the
  expected callsite line to match the golden location.
- The review prompt and `submit_review` tool schema now require summary and
  `issues[]` consistency: summaries must not mention concrete bugs,
  regressions, compatibility risks, or user-visible behavior changes unless a
  corresponding structured issue exists.
- The result filter keeps low-confidence warnings only when they are backed by
  concrete code evidence and explicit risk language. This recovered the
  Nethermind and pytest long-ID findings without reintroducing negative-sample
  false positives.
- Tool-call argument parsing tolerates provider-returned unescaped control
  characters inside JSON strings, preventing otherwise valid `submit_review`
  payloads from being dropped as raw-output failures.

## Remaining Boundary

`golden_pytest-dev_pytest_pr8513` has never been hit across the latest sampled
runs. Treat it as the next diagnostic target for Phase 2 quality work. The
current MVP+ baseline is considered complete for the numeric gate because it
achieves schema validity `1.0`, hit rate `0.75`, and false positive rate `0.0`
on the reviewed 4-positive / 2-negative golden suite.
