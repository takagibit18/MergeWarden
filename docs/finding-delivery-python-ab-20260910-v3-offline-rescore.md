# Harness v3 真实 A/B 离线重评分（修正版）

日期：2026-09-10  
本报告已按 [全链路版本兼容矩阵](finding-contract-compatibility-matrix-20260910.md) 修正。它只读消费四条已保存的运行产物，不调用模型/provider/发布接口，也不修改原始 finding、gold、receipt 或 journal。

## 结论

原报告把前三条运行的 `actual_count=0` 解释成位置/严重性未命中。实际原因是旧评估路径在 gold matcher 前用 v2 的 `confidence/evidence` 门槛过滤了 v3 finding；v3 的这两个兼容字段本来就是 `0/空`。修复后的评估先复用 runtime 的批准绑定，再使用明确版本 `semantic-v3-content-v1` 逐维评分。

| 运行 | raw | runtime approved | gold matched | location | severity | semantic/root | repair | duplicate | 状态 / ready / external |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Pydantic A (`A-agent-search`) | 2 | 2 | 0 | 1 | 1 | 0 | 1 | 1 | `complete / true / ready` |
| Pydantic B2 (`B2-graph-hybrid-warm`) | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 1 | `complete / true / ready` |
| Haystack B2 (`B2-graph-hybrid-warm`) | 3 | 3 | 1 | 1 | 1 | 1 | 1 | 2 | `complete / true / ready` |
| Haystack A (`A-agent-search`) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | `incomplete / false / not_requested` |

这里的 `gold matched` 不是 verifier accept。Pydantic 的位置和严重性各自通过，但 v3 description 的“未知键丢失”与 gold 的“私有属性重新分类”是不同机制，因此不命中；Haystack B2 的三个位置是同一 unsafe `file_path` metadata access 根因，只计一个 gold 命中，另计两个 duplicate。Haystack A 的 malformed/unresolved 历史响应缺少原始 verifier response/request 关联，字段级原因保持证据不足，不能补造。

## 版本与适配

- Finding contract：`3.0`，版本来自 response report envelope。
- Source matcher：原始产物记录为 `semantic-v3`，其旧语义保留但不直接评分 slim v3。
- Rescore matcher：`semantic-v3-content-v1`，只消费 v3 的 `description`、`anchor/related_locations`、`severity`、`suggestion`、`evidence_refs`。
- Approval adapter：`v3-runtime-boundary-v1`，检查 candidate identity、content version、integrity 状态、唯一 accept receipt、provider attempt 和 evidence digest。
- `ready` 只是内部报告就绪；四条产物均未 external publish。`natural_stop`、`delivery_complete`、`report_ready` 分别保留，不由 finding 数量推断。

完整逐 finding 决策、每个维度的 reason、token accounting、source hashes 和 malformed 边界见 [离线重评分 JSON](../eval/reports/finding-delivery-python-ab-20260910-v3-offline-rescore-v2.json)。

## 验证

- `tests/test_v3_compatibility_regressions.py`：report envelope、public payload、parser、merge、root-cause 隔离、Core 入口。
- `tests/test_offline_rescore.py`：同一输入重复执行相同、四条运行的 approved/location/severity/semantic/repair/duplicate 分维度对账、token 对账和 Haystack A 历史证据不足。
- `eval/offline_rescore.py`：model-free，读取原始 artifact，不生成 receipt。
- `python -m compileall -q -i -`（仅列出源码/测试 Python 文件，排除历史 eval 输出缓存）：通过。
- 本地默认 `FINDING_CONTRACT_VERSION` 仍为 `2.0`；v3 非默认状态保留。
