# MergeWarden finding 交付链路 v4 交付报告（2026-09-09）

## 结论

本轮已实际落地 finding 交付链路修复，并完成离线全量回归与有界真实模型验证。实现提交基线为 `f8d9c7b`；本报告所在后续本地提交固化 provider 契约、最终状态收口、测试与实验摘要。

真实模型验证没有启动 Phase 2。原因是首轮两条 measured run 发现运行时继承了本地非 zhipu 兼容分支，GLM-5.3 的 submit-only 请求被服务端以 400/code 1210 拒绝；修正为显式 zhipu endpoint 后，重新执行了同一批两个 Python fixture，各 1 次 A-agent-search。随后又按复核要求在 `c2ec014` 上对这两个 fixture 各重跑 1 次；所有回放均未启用自动无效重试，Phase 2 仍未扩展。

修正后的 zhipu 回放已经出现真实最终发布证据：两个 fixture 均 `final_published_count=1`、`integrity_verified_count=1`、`evidence_complete_count=1`、`evidence_validated_count=1`，且无 repair 协议错误。随后按本次复核要求，在 `c2ec014` 上对同两个 Python fixture 做了新的 post-final rerun：Haystack 再次得到 `final_published_count=1`、`delivery_complete=true`、`finding_run_status=complete`；Discount 因真实模型返回非法的 repair 结构被严格契约拒绝，保持 `final_published_count=0`、`delivery_complete=false`，没有发布不可信 finding。

## 1. 实施内容

### 1.1 Finalization 收口

- 探索达到 `max_iterations`、draft stagnation 或 no-effective-action 时，先保留 pending draft，不提前关闭交付状态。
- 探索结束后最多执行一次只暴露 `submit_review` 的 submit-only finalization，不再暴露普通探索工具。
- 合法最终提交后，pending draft 只转为 `evidence_sufficient` 或 `disproved`；清除 provisional exploration reason，并清除旧 placeholder 的 incomplete 状态。
- final response 以最终提交报告为权威来源，确保已验证 candidate 不会因上一轮 placeholder 被丢掉；`final_published_count`、`delivery_complete`、`finding_run_status` 和 journal 彼此对账。

### 1.2 Format recovery

- 结构化提交格式恢复保留原始 semantic/evidence body、candidate identity、snapshot/revision 和 response 关联。
- 恢复 payload 改变 evidence ref、semantic 字段或 candidate identity 时拒绝恢复，保留原始输入的可审计 salvage 状态，不把恢复结果当作合法 submit。
- `format_recovery` journal 记录 raw payload（脱敏）、输入/恢复 response id、校验错误、保留引用、候选映射和最终处置。

### 1.3 Repair protocol

- repair 输入改为严格 patch-only：`target_candidate_id`、`candidate_content_version`、`repair_status`、`repair_reason`、`repair_patch`。
- `repaired` 必须携带非空 patch；repair payload 不得重复携带完整 finding semantic/evidence 顶层字段。
- runtime 精确校验 candidate/version/patch，拒绝 unknown、duplicate、cross-candidate、旧版本和伪造身份；patch 合并后沿用原 candidate 的可信 support role，再走同一 canonical contract 与 integrity guard。
- format/source/contract/evidence repair 共用同一报告级 repair budget，不因不同缺口重新开额度。

### 1.4 Real-model runner contract

`eval/graph_ab_pilot.py` 现在允许 validation config 显式声明 `provider` 与 `base_url`，并在当前进程运行时注入，而不修改 `.env`。本轮 zhipu config 固定为 `zhipu` + `https://open.bigmodel.cn/api/paas/v4`，避免仅凭 `glm-5.3-flash` 模型名误选 DashScope 兼容控制。

## 2. 阶段契约

| 阶段 | 权威身份 | 允许模型提供 | runtime 完成条件 | 失败语义 |
| --- | --- | --- | --- | --- |
| Draft | `draft_id` | 假设、最小 claim、已交付 evidence ref | 调查检查点有 journal 状态 | `pending` / `incomplete`，不等于可发布 |
| Preflight | runtime candidate/version + delivered ledger | contract/policy gap 与合法 evidence catalog | 当前 payload 已过 canonical 检查 | gap 不自动生成 repair target |
| Initial submit | runtime 生成 `cand_...` + canonical finding | semantic finding 与精确 evidence ref | candidate registered，进入 integrity | 未注册或未提交不得计 published |
| Format recovery | 原始 response id + 原始 candidate 输入 | 仅格式修复 | semantic/evidence/identity 完整保真 | 改变内容则 `rejected_preserved_input` |
| Repair | 精确 candidate/version + 完整 gap | patch-only 字段补丁 | patch 合并后同一 guard 再验证 | `unchanged` / `incomplete` / `deferred` 不覆盖原 finding |
| Finalization | 最终 submitted report + verified candidates | 只提交最终报告 | submit-only 成功，草稿状态关闭， provisional incomplete 清除 | `submit_failed` / `incomplete` |
| Publish | verified candidate + delivered evidence | publisher payload 与审计 | `integrity=verified` 且最终 finding 可回放 | `publish_blocked` |

## 3. 有界真实模型验证

### 3.1 首轮（发现 provider 兼容性问题）

实验：`finding-delivery-repair-v4-phase1-20260909`；两个 Python fixture、A-agent-search 各 1 次。实际模型请求已发生，但运行时从本地环境继承了非 zhipu 兼容 profile，最终 submit 的 `thinking=off` 被 GLM-5.3 服务端拒绝（400/code 1210，提示应使用 `low/high/max`）。两条记录均为 `run_error + placeholder_output + schema_invalid`，最终发布为 0；这批结果不作为模型质量结论。

摘要：[`eval/experiments/finding-delivery-repair-v4-phase1-20260909-zhipu-summary.json`](../eval/experiments/finding-delivery-repair-v4-phase1-20260909-zhipu-summary.json)

### 3.2 显式 zhipu 修正回放

实验：`finding-delivery-repair-v4-phase1-zhipu-20260909`；无自动重试、无 Phase 2。以下数据来自真实 provider journal 和 event log：

| Fixture | run_id | Runner/schema | Provider | Finding funnel | Gold 结果 | 成本 |
| --- | --- | --- | --- | --- | --- | --- |
| Haystack PR12208 | `dcce7943-57d7-4cb5-9d45-ae713ff8ba7f` | valid / schema valid | 4 attempts，失败 0 | candidate 1；evidence complete 1；integrity verified 1；final published 1 | hit 0/1；warning finding 的语义命中未通过 | 48,865 tokens；119.879 s |
| Discount synthetic | `94e8b607-03c1-49a4-b569-72adffac415a` | valid / schema valid | 4 attempts，失败 0 | candidate 1；evidence complete 1；integrity verified 1；final published 1 | hit 1/1 | 31,827 tokens；50.598 s |

修正回放摘要：[`eval/experiments/finding-delivery-repair-v4-phase1-zhipu-20260909-summary.json`](../eval/experiments/finding-delivery-repair-v4-phase1-zhipu-20260909-summary.json)

原始结果：[`eval/outputs/finding-delivery-repair-v4-phase1-zhipu-20260909.json`](../eval/outputs/finding-delivery-repair-v4-phase1-zhipu-20260909.json)

完整 journal 位于 `eval/outputs/finding-delivery-repair-v4-phase1-zhipu-20260909/run_journals/`；对应 event log 位于 `eval/outputs/event_logs/`。原始结果目录按仓库 `.gitignore` 保持本地，不把大体量 deferred workspace 或凭据带入提交。

### 3.3 Phase 2 决策

Phase 2（Pydantic A-agent-search、Haystack B2 graph warm）未执行。首轮存在 submit provider compatibility failure；修正回放阶段的 measured budget 已达到 4，本次 post-final rerun 也只复核原有两个 Python fixture，没有扩展到 Phase 2，因此没有把不满足前置条件的结果扩成 Graph/模型质量结论。

### 3.4 `c2ec014` 后的 post-final rerun

实验：`finding-delivery-repair-v4-postfinal-zhipu-20260909`；显式 zhipu endpoint、两个既有 Python fixture、A-agent-search 各 1 次、无自动无效重试。Runner `valid_runs=2`、`invalid_runs=0`；8 次 provider attempt 全部成功。

| Fixture | run_id | 最终交付 | Finalization / repair | 成本与终止 |
| --- | --- | --- | --- | --- |
| Haystack PR12208 | `0feb6a45-9b8d-4e42-a73f-dd7c3552af2e` | `final_published=1`；`integrity_verified=1`；`evidence_complete=1`；`delivery_complete=true`；`finding_run_status=complete` | `finalization_status=already_submitted`；repair 0；`natural_model_stop` | 34,868 tokens；61.2039 s |
| Discount synthetic | `4cb51c11-3aef-4766-bbbe-5bbdffd0facd` | `final_published=0`；`integrity_verified=0`；`evidence_complete=0`；`delivery_complete=false`；`finding_run_status=incomplete` | repair attempted 1 / succeeded 0；模型把 semantic/evidence 字段放在 repair issue 顶层而不是 `repair_patch`，被严格 patch-only 契约拒绝 | 39,656 tokens；119.9942 s；`model_incomplete` |

这次 rerun 直接验证了最终状态收口：合法最终提交的 Haystack run 在 event log 中同时记录 `finding_funnel_completed`（`final_published_count=1`、`run_status=complete`）和 `phase_end(review_complete)`（`finalization_status=already_submitted`、`delivery_complete=true`）。Discount 的失败是模型 repair payload 不符合协议，不是 provider 调用失败；系统保留候选为 needs-repair 并阻断发布，因而不能把本轮宣称为两个 fixture 全部交付成功。

本次摘要：[`eval/experiments/finding-delivery-repair-v4-postfinal-zhipu-20260909-summary.json`](../eval/experiments/finding-delivery-repair-v4-postfinal-zhipu-20260909-summary.json)

本次配置：[`eval/variants/finding-delivery-repair-v4-postfinal-zhipu-20260909.yaml`](../eval/variants/finding-delivery-repair-v4-postfinal-zhipu-20260909.yaml)

本次 raw pilot：[`eval/outputs/finding-delivery-repair-v4-postfinal-zhipu-20260909.json`](../eval/outputs/finding-delivery-repair-v4-postfinal-zhipu-20260909.json)；对应 event log 仍位于 `eval/outputs/event_logs/`。

## 4. 离线验证

- 完整测试：`937 passed, 1 skipped, 3 warnings`。
- 新增/受影响组合：`116 passed`。
- `ruff check src tests`：通过。
- `mypy src`：`Success: no issues found in 93 source files`。
- `python -m compileall -q src tests`：通过。

3 个 warning 为既有 FastAPI/Starlette deprecation warning，不是本轮失败。

## 5. 交付边界与保留项

- 没有修改 Graph 语言支持、parser、retrieval、construction、gold 或 confidence 规则。
- 没有读取或修改 `.env`，没有 push；provider/base URL 只写入评测子进程环境。
- `导学-MergeWarden.md`、`面经-MergeWarden.md` 是用户已有未跟踪文件，本轮未 stage、未改写、未删除。
- post-final rerun 已证明 Haystack 在修复后的最终状态收口中真实完成发布；Discount 的模型 repair payload 违反 patch-only 契约，系统按安全语义保持未发布。两个 fixture 的结果均已落盘，不能以单个 fixture 的成功推断本轮整体 2/2 交付完成。
