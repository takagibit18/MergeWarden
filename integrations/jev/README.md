# Jev adapter — reserved, not implemented

Domain port: `src/advisor/contracts.ts`.
Current defaults: mode=off; NoopAdvisor and RuleAdvisor are available; no Jev SDK/API calls or keys are used.

First implementation must fetch current TypeSafe docs and select a pinned SDK/API contract.
Do not invent endpoints or equate confidence with domain correctness.
Required: consent/data minimization, deadline, AbortSignal, abstain, state/catalog freshness,
provider/policy version, token/cost measurement and reproducible observations.

Shadow must not change prompts, tool visibility, tool arguments or findings. It still has latency/cost;
production shadow execution needs an isolated bounded queue. The current coordinator is awaitable,
so its unit tests prove behavioral isolation, not zero critical-path latency.

Candidate decision points: retrieval strategy, tool shortlist, skill selection, context ranking,
escalation, model tier, candidate relation. No security permission / publish / bug-truth authority.
