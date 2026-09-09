# MergeWarden finding 交付链路 v4 交付报告（2026-09-09）

## 结论

本轮已实际落地 finding 交付链路修复，并完成离线全量回归与有界真实模型验证。实现提交基线为 `f8d9c7b`；本报告所在后续本地提交固化 provider 契约、最终状态收口、测试与实验摘要。

真实模型验证没有启动 Phase 2。原因是首轮两条 measured run 发现运行时继承了本地非 zhipu 兼容分支，GLM-5.3 的 submit-only 请求被服务端以 400/code 1210 拒绝；修正为显式 zhipu endpoint 后，重新执行了同一批两个 Python fixture，各 1 次 A-agent-search。两批合计 4 条 measured run，未启用自动无效重试；没有再追加模型请求。

修正后的 zhipu 回放已经出现真实最终发布证据：两个 fixture 均 `final_published_count=1`、`integrity_verified_count=1`、`evidence_complete_count=1`、`evidence_validated_count=1`，且无 repair 协议错误。Discount fixture 的当次运行已同时得到 `delivery_complete=true`；Haystack fixture 在最终发布后暴露了 iteration-guard 状态残留，随后已用离线回归修复该状态收口。由于本轮真实 measured 上限已用完，没有把离线收口修复冒充成新的真实模型结果。

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

Phase 2（Pydantic A-agent-search、Haystack B2 graph warm）未执行。首轮存在相同的 submit provider compatibility failure，且修正回放之后本轮总 measured budget 已达到 4；因此没有把不满足前置条件的结果扩成 Graph/模型质量结论。

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
- 真实修正回放已经证明两个 fixture 各有一次最终发布；但 Haystack 的 `delivery_complete` 旧状态残留是在该真实回放后才由离线回归修复，因此报告不把“修复后的状态收口”伪装成新的真实模型测量。
