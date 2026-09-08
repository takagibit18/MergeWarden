# GLM-5.3 Flash Graph A/B 真实模型采集（2026-09-06）

## 结论

本轮完成 18 条真实 provider 测量：`A-agent-search` 与 `B2-graph-hybrid-warm` 各 9 条，配对误差为 0，18/18 条 runtime contract 有效。

这三组 fixture 是规划文档定义的机制回归样本，不是 60 个 held-out fixture，不能用于证明 Graph 默认启用优势。当前结果不满足默认启用门槛：B2 的平均 provider token 为 A 的 1.276 倍，端到端 p95 为 A 的 1.207 倍；两种模式最终语义命中均为 0/9。部分 finding 进入了最终风险结果，但没有命中对应 gold root cause。

## 实验契约

- Config: `eval/variants/graph-ab-glm53-flash-post-optimization-20260904.yaml`
- Model: `glm-5.3-flash`
- Temperature: `0.0`
- Measured variants: A agent search、B2 graph hybrid warm
- Fixtures: `development_agent_search_cross_file`、`golden_deepset-ai_haystack_pr12257_reverse`、`golden_deepset-ai_haystack_pr12162_reverse`
- Repetitions: 3 per fixture/variant
- Seed: `20260906`
- Priming: B2 cold priming 单列，未计入 measured provider token

本次进程显式使用 `MODEL_PROVIDER=zhipu` 匹配 BigModel endpoint；仓库 `.env` 未修改。GLM-5.3 Flash 要求 `reasoning_effort=low/high/max`，错误的 legacy `dashscope` profile 会使最终工具请求返回 400。

## 总体对比

| 指标 | A-agent-search | B2-graph-hybrid-warm | B2/A |
|---|---:|---:|---:|
| 有效 runtime runs | 9/9 | 9/9 | — |
| 平均 successful total tokens | 59,709 | 76,215 | 1.276x |
| 平均 provider attempts | 3.667 | 3.889 | 1.061x |
| 平均端到端延迟 | 98.63 s | 128.47 s | 1.303x |
| 端到端 p95 | 167.12 s | 201.65 s | 1.207x |
| provider cache hit rate | 21.2% | 22.9% | — |
| 最终 matched findings | 0/9 | 0/9 | — |
| overall/root-cause recall | 0 / 0 | 0 / 0 | — |

B2 每条 measured run 的 Graph reviewer context 平均约 7,316 tokens，manifest 平均约 18,047 tokens；9 条 measured run 均为 `graph_status=ready`、`graph_cache_mode=warm`、cache hit，未发生 graph fallback 或配对缺失。

## Fixture 级平均

| Fixture | A tokens | B2 tokens | B2/A | A e2e | B2 e2e | B2/A |
|---|---:|---:|---:|---:|---:|---:|
| development cross-file | 21,742 | 27,722 | 1.275x | 31.88 s | 35.87 s | 1.125x |
| Haystack PR12257 reverse | 72,828 | 98,350 | 1.350x | 98.74 s | 164.93 s | 1.670x |
| Haystack PR12162 reverse | 84,557 | 102,574 | 1.213x | 165.26 s | 184.61 s | 1.117x |

## 质量与失败漏斗

两边 schema-valid 与非 placeholder 的 runtime completion 均为 9/9。模型确实产生了部分候选并有少量 finding 进入最终风险结果，但没有一个通过 gold root-cause matcher：

- A：12 个 verifier candidate 中 6 个通过、6 个被拒绝，最终风险结果 6 个，但 gold 命中 0 个。
- B2：9 个 verifier candidate 中 1 个通过、8 个被拒绝，最终风险结果 1 个，但 gold 命中 0 个。
- 常见拒绝原因是模型输出缺少 `location`、`suggestion`、`confidence`、证据角色字段，或出现非法行号；这些拒绝均保留在 raw/journal 中。
- 进入最终结果的部分 legacy-shaped finding 仍缺少完整的 cause/contract/trigger/impact evidence，因此 `evidence_complete_count` 仍为 0。

因此本轮只能证明 runtime、Graph warm contract 和成本/延迟差异，不能证明 Graph 对语义质量有提升。

## 原始证据

- Raw: `eval/outputs/graph-ab-current-20260906-final/raw.json`
- Compact summary: `eval/outputs/graph-ab-current-20260906-final/summary.json`
- Checkpoint: `eval/outputs/graph-ab-current-20260906-final/checkpoint.jsonl`
- Run journals: `eval/outputs/graph-ab-current-20260906-final/run_journals/`

## 验证

`tests/test_evidence_ledger.py`、`tests/test_graph_hybrid_token_optimization.py`、`tests/test_inference_engine.py`：54 passed。
