# 单 fixture 真实模型 A/B 结果（2026-09-07）

## 结论

本轮在优化后的 finding pipeline 上完成了 `development_agent_search_cross_file` 的真实 provider paired A/B：A=`agent_search`，B2=`graph_hybrid warm`；每个 treatment 3 次，配对误差为 0，runner readiness 为 PASS。

该 fixture 的 gold 为每次 1 个 finding。历史兼容口径 `semantic-v3` 下，A 和 B2 的有效 runtime run 均为 0 命中；本轮不能证明 Graph 带来质量提升。B2 另有 1/3 次模型自然停止但没有提交 `submit_review`，因此被标记为 placeholder/runtime invalid。

## 结果对比

| 指标 | A-agent-search | B2-graph-hybrid-warm |
|---|---:|---:|
| runtime 有效 | 3/3 | 2/3 |
| semantic-v3 matched finding | 0/3 | 0/2（另 1 次无有效提交） |
| overall/root-cause recall | 0/3 | 0/2 |
| 有效 run 平均 successful total tokens | 23,643 | 27,248 |
| 有效 run 平均端到端延迟 | 47.74 s | 47.02 s |
| provider attempts（全部 3 次平均） | 3.33 | 3.67 |
| evidence complete / validated | 0 / 0 | 0 / 0 |
| final published / final risk finding | 0 / 0 | 0 / 0 |

为避免 survivor bias，B2 把无效的第 1 次也计入成本时，平均为 28,623 successful total tokens、52.02 s、3.67 provider attempts；相对 A 分别约为 `1.21x`、`1.09x`、`1.10x`。因此当前样本中 B2 没有质量收益，且有效率与成本更差。

## 运行事实

- 六个 run instance 均真正到达 provider；A 总 provider attempts 为 10，B2 为 11，失败的 B2 run 不是网络失败，而是 `natural_model_stop` 且没有 `submit_review`。
- B2 三次均为 `graph_status=ready`、`graph_cache_mode=warm`、cache hit，未发生 Graph fallback；每次选择 6 条 reviewer graph paths、约 2,151 个 Graph reviewer context tokens，角色覆盖为 `execution_flow` 与 `related_test`。
- A 的 3 个有效 run 都生成了 1 个候选但最终未通过完整性校验；B2 的 2 个有效 run 也各生成 1 个候选但未通过。主要拒绝事实集中在 evidence identity/complete、support role/reference 和 finding contract 缺口。
- 这是单 fixture、3 paired samples 的诊断性结果，不作默认启用 Graph 的总体结论。

## 复现入口

- Config: `eval/variants/graph-ab-development-agent-search-cross-file-20260907.yaml`
- Raw: `eval/outputs/graph-ab-development-agent-search-cross-file-20260907-zhipu-no-socks/raw.json`
- Compact summary: `eval/outputs/graph-ab-development-agent-search-cross-file-20260907-zhipu-no-socks/summary.json`
- Checkpoint: `eval/outputs/graph-ab-development-agent-search-cross-file-20260907-zhipu-no-socks/checkpoint.jsonl`

本次仅在进程内使用 `MODEL_PROVIDER=zhipu` 匹配现有 BigModel endpoint，未修改 `.env`；`ALL_PROXY` 也只在本次进程内移除。
