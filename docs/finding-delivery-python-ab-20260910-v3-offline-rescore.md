# MergeWarden Harness v3 真实 A/B 离线重评分报告

日期：2026-09-10  
范围：只读消费四条已保存的真实 provider 运行；本轮不调用模型、不连接外部发布端、不修改原始产物。

## 结论

原摘要把前三条运行报告为 `actual_count=0`，原因不是 Harness 没有产生最终 finding，而是旧评估器把 v3 finding 的兼容字段按 v2 规则筛选：`confidence` 默认 `0.0`、旧 `evidence` 为空，于是合法 v3 finding 在 gold matcher 前被过滤。

修复后的评分输入只接受 runtime 已完成的最终绑定：finding contract、integrity 内容版本、独立 semantic accept receipt、request/response/provider 关联和相关 evidence digest。gold 位置、描述、严重性不参与“是否有资格评分”的判断。

| 运行 | 原报告数 | 修复前有效数 | 修复后有效数 | semantic accept | 内部最终集合 | delivery complete | external 状态 | gold 命中 |
|---|---:|---:|---:|---:|---:|---|---|---:|
| Pydantic A | 2 | 0 | 2 | 2 | 2 | true | `ready`，未发布 | 0 |
| Pydantic B2 | 2 | 0 | 2 | 2 | 2 | true | `ready`，未发布 | 0 |
| Haystack A | 0 | 0 | 0 | 0 | 0 | false | `not_requested` | 0 |
| Haystack B2 | 3 | 0 | 3 | 3 | 3 | true | `ready`，未发布 | 0 |

`semantic accept` 不等于 gold 命中；`ready` 也不等于外部发布成功。三条已完成内部交付的运行，本次统一 matcher 均未命中 gold 位置/严重性条件，不能进一步把未命中自动称为真实误报。

## 可追溯输入

- 原实验 ID：`finding-delivery-python-ab-20260909`
- 原实现提交：`f353b8d44390e07cd122279c14cfb18d9192bbc4`
- 本次评分提交：`c3e187704c1a91c96dd808a48995ca7762604d10`
- Finding contract：`3.0`
- Matcher：`semantic-v3`
- 适配器：`v3-runtime-boundary-v1`
- 原始产物清单 SHA-256：`b20fc2f31a2a980fc92d1fa45fa36036e402d1d7637cd8472915eddf261f72c9`
- 逐条 finding 的纳入/排除理由及 receipt 摘要在 [版本化 JSON 产物](../eval/experiments/finding-delivery-python-ab-20260910-v3-offline-rescore-v1.json) 中。

原始 `raw.json`、`checkpoint.jsonl`、四份 journal 和四份 event log 均未覆盖；重评分直接反序列化保存的最终 `ReviewResponse` 和 runtime-owned registration/receipt，不合成 receipt。

## 跨层根因与修复

| 问题 | 根因 | 修复位置 | 回归证据 | 剩余风险 |
|---|---|---|---|---|
| v3 finding 被评分前过滤 | `_effective_review_issues()` 对 v3 兼容外壳使用 confidence/evidence 文本门槛 | `eval/runner.py`；新增 `_v3_eval_eligibility()` | 合法 v3 `confidence=0/evidence=""` 仍进入；receipt/版本/evidence 变化会排除 | 真实 gold 语义质量仍未验证 |
| contract 与 matcher 混淆 | 只有 `matcher_version`，事件中的 finding contract 没进入 eval metrics | `eval/schemas.py`、`eval/run_summary.py`、`eval/runner.py` | 产物同时记录 `finding_contract_version=3.0` 与 `matcher_version=semantic-v3` | 未覆盖未知历史 contract 的自动迁移，保持 fail-closed |
| 指标口径混用 | `EvalResult.total_tokens` 只读 provider attempt，phase-end 总量还包括 verifier | `eval/runner.py`、`eval/run_summary.py`、`src/orchestrator/agent_loop.py` | 四条运行 reviewer+verifier 与 phase-end 逐条相等 | warm priming token 历史未记录 |
| malformed 诊断不完整 | malformed 分支已有错误码，但 outcome 元数据未绑定到 unresolved receipt | `src/analyzer/semantic_verifier.py`、`src/orchestrator/run_journal.py`、`src/orchestrator/agent_loop.py` | 离线 malformed 回放保留 input/request/response/provider/attempt/预算摘要且 fail-closed | 历史 Haystack A 原始 response 已丢失，无法恢复具体字段 |

## Token 与调用口径

| 运行 | Reviewer 成功 tokens | Verifier tokens | Measured 成功总量 | 组件和对账 | Reviewer logical / provider attempt | Verifier logical / provider attempt | Warm priming |
|---|---:|---:|---:|---|---:|---:|---|
| Pydantic A | 28196 | 4224 | 32420 | yes | 3 / 3 | 1 / 1 | 无 |
| Pydantic B2 | 35870 | 9388 | 45258 | yes | 3 / 3 | 1 / 1 | 20.004s，token 未记录 |
| Haystack A | 27943 | 5066 | 33009 | yes | 3 / 3 | 1 / unknown |  无 |
| Haystack B2 | 36076 | 16566 | 52642 | yes | 3 / 3 | 1 / 1 | 36.602s，token 未记录 |

旧 `result.total_tokens` 依次是 `28196/35870/27943/36076`，正好是 Reviewer provider attempt 合计；差额依次为 `4224/9388/5066/16566`，与 semantic verifier 事件的 token 合计一致。失败 attempt 与未知 usage 独立记录，不记为零；没有价格依据，因此本报告不编造金额。

## Haystack A malformed decision

历史 journal 和 event log 能证明：opaque handle `vh_3cc41e9f52354fd8894d` 的 verifier decision 触发 `semantic_verifier_malformed_decision`，随后变为 `unresolved`，没有 accept receipt，流程以 `semantic_verifier_unresolved` 结束。

但是历史记录没有保存 semantic provider 原始 response body，也没有保存该次调用的 request hash、response digest、provider request id 或 attempt 关联。因此不能准确恢复缺失字段或具体 schema 约束，本报告明确标记为证据不足而不是猜测。新代码只保存这些安全摘要，不保存隐藏推理或敏感源码。

## Overlap 检查

- Pydantic A/B2 的 finding 在同一文件且行区间存在重叠；同一运行内 A 的两个 finding 也共享 evidence 引用并重叠。
- Haystack B2 的三个 finding 在同一文件，行距为 12–25 行，并共享部分 evidence 引用。
- 以上是自动结构 signal；输出将 `same_root_cause` 保持为 `not_determined`，不把重叠自动合并，也不把未命中 gold 自动宣称为误报。

## 验证结果

- 聚焦评估/诊断/历史重评分集合：`101 passed`。
- 全量 pytest 首轮：`1018 passed, 1 skipped, 3 failed`；3 项均在临时 Git fixture commit 阶段因宿主缺失 `C:/Users/Lenovo/.ssh/id_ed25519` 失败，未进入本轮业务逻辑。
- 全量 pytest 使用仅当前进程的 `GIT_CONFIG_*` 禁用 signing 后：`1021 passed, 1 skipped, 3 warnings`。
- `ruff check`（本轮触及文件）：通过。
- `python -m mypy src`：通过，94 个 source files。
- `python -m compileall`（本轮触及 Python 文件）：通过。
- `git diff --check`：通过；仅有仓库既有 LF/CRLF 提示。

本轮没有重新调用真实模型，因此不对真实模型准确率、provider 兼容性、实际成本或真实外部发布作结论；v3 仍保持非默认、非正式发布状态。
