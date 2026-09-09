# MergeWarden finding 交付链路修复过程报告

日期：2026-09-09

本次交付完成了 finding 的 runtime identity、evidence catalog、repair transaction 和最终发布边界修复。Graph/AST/TypeScript 解析、检索策略和 construction 没有改动；没有修改 `.env`，没有向远端推送。

## 交付结果

已提交的实现为：

- `54f72df`：注册 runtime candidate identity，固定 candidate id 与 content version 的边界。
- `2835c72`：统一 evidence id/catalog、run journal、completion status 和评测字段。
- `da36196`：加入 repair transaction、候选级预算、精确 target/version 校验和最终状态持久化。
- `80f2296`：修复真实运行暴露的两个发布边界缺陷：wire request 对 `evidence_id=` 的校验，以及从 authoritative submitted report 发布 verified finding。

第一至第三阶段的完整设计说明仍在 [docs/finding_pipeline_repair_20260907.md](../docs/finding_pipeline_repair_20260907.md)。

## 三阶段实现摘要

### 1. Candidate identity 与 preflight/submit 接口

- initial submit schema 不再允许模型填写 runtime `candidate_id`、`finding_id`、repair target/status/version。
- runtime 注册 `cand_...` candidate id，并以 canonical semantic content 计算 content version；candidate identity 与可变内容版本分离。
- repair submit 必须携带 `target_candidate_id`、当前 `candidate_content_version` 和 `repair_status`。
- unknown、cross-candidate、duplicate、missing、expired、version mismatch 等 target 均保留为明确诊断，不做位置或顺序猜测。
- `repair_patch` 只允许语义字段；未指定字段继承原 finding，不能通过 patch 改写 runtime identity/provenance。

### 2. 统一 evidence catalog 与完成状态

- 每条实际送达的证据都有独立 `evidence_id`，并保留 artifact id 作为兼容 alias。
- catalog 记录 snapshot、revision、path、range、side、content hash、source、delivery request、lifecycle 和 truncation 状态。
- submit、validator、integrity guard 和最终 evidence ledger 只接受 delivered、未截断、snapshot/revision 精确匹配的证据。
- run journal 增加 candidate registration、preflight、evidence catalog、repair transaction、finding finalization 条目。
- `review_complete` 仍表示 review 流程完成；`delivery_complete` 只有在所有 candidate 均 verified 并进入最终输出时才为 true；`finding_run_status=incomplete` 会保留具体原因。

### 3. Repair transaction 与预算

- 一个 repair transaction 绑定候选集合、base version、gap codes、required/executed steps、model call count、token/time budget 和 target results。
- source exploration 与 submit 以完整序列预留预算，避免只消耗 source call 后没有 submit 预算。
- transaction 次数和模型调用次数分开统计；共享 hard token/time budget，不允许 repair 绕过总预算。
- `unchanged`、`incomplete`、`deferred` 是显式 disposition，不会被误报为“未返回”；no-progress 会被记录并保持 incomplete。

## 离线验证

最终版本验证结果：

- `933 passed, 1 skipped, 3 warnings`，全量 pytest。
- `python -m compileall -q src tests eval/schemas.py eval/run_summary.py`：通过。
- `python -m ruff check src tests eval/schemas.py eval/run_summary.py`：通过。
- `python -m mypy src`：93 个源文件，无问题。
- 相关 evidence/finding delivery/orchestrator focused tests：通过；新增回归覆盖 `evidence_id=` wire 校验和 verified submitted report 的发布。

## 真实模型验证

模型/provider：`zhipu / glm-5.3-flash`，temperature `0.0`，matcher `semantic-v3`。总 measured runs 严格为 6；warm priming 共 3 次，均单独记录，不计入 measured。没有自动重试。

配置、compact summary 和脱敏汇总：

- [eval/variants/finding-delivery-haystack-discount-20260909.yaml](../eval/variants/finding-delivery-haystack-discount-20260909.yaml)
- [eval/variants/finding-delivery-discount-postfix-20260909.yaml](../eval/variants/finding-delivery-discount-postfix-20260909.yaml)
- [eval/variants/finding-delivery-pydantic-20260909.yaml](../eval/variants/finding-delivery-pydantic-20260909.yaml)（条件配置，未执行）
- [eval/reports/finding-delivery-real-validation-20260909.json](../eval/reports/finding-delivery-real-validation-20260909.json)
- [eval/experiments/finding-delivery-haystack-discount-20260909-zhipu-summary.json](../eval/experiments/finding-delivery-haystack-discount-20260909-zhipu-summary.json)
- [eval/experiments/finding-delivery-discount-postfix-20260909-zhipu-summary.json](../eval/experiments/finding-delivery-discount-postfix-20260909-zhipu-summary.json)

### 第一批：Haystack PR12208 + Discount，各 A/B2-warm 一次

四个位都暴露同一个交付前协议阻断：模型已经给出候选判断，但最终 submit-only request 被错误判定为缺少证据，均以 `final_submit_context_insufficient` 结束；因此 schema、candidate、preflight、submit、repair、publish 都是 0。B2 的 graph warm priming 已正常生成，且单独记录了 priming latency。

这批结果定位出实现缺陷：evidence handoff 使用 `evidence_id=...`，wire validator 只识别 `id=...`。修复后没有复用旧 checkpoint，也没有自动重跑这四个位。

### 第二批：显式 post-fix Discount A/B2-warm

这两个新 measured run 使用新 experiment id/output 目录，runner readiness 为 PASS：

| fixture | variant | schema | candidate | preflight | submit_review | repair | 发布/状态 | provider attempts | tokens | latency | warm priming |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| Discount | A-agent-search | valid | 1 | 1 | 1 | 0 | candidate verified；原测量发布数 0 | 4 | 30,159 | 43.009s | — |
| Discount | B2-graph-hybrid-warm | valid | 1 | 1 | 2 | 1 | `needs_repair`；未发布 | 3 | 24,939 | 55.215s | 0.311s |

A 的 run journal 已记录 cause/contract/trigger/impact 四类角色证据（4/4），candidate integrity 为 verified。该测量发生在最终 publication fix 提交前，所以 artifact 中的 `final_published_count=0` 被原样保留；随后新增的回归测试证明 verified candidate 会从 authoritative submitted report 进入最终 response，不再被旧 placeholder response 静默丢弃。

B2 的初始 candidate 缺少 impact role，repair 回复又返回了模型自造的 `C-001-4308d0` target 和错误版本值。runtime 没有猜测映射，明确保留 `repair_target_unknown`、`repair_target_not_returned`、`support_role_missing` 和 `finding_delivery_incomplete`，这符合本次 target identity 安全契约。

所有真实 provider attempts 的 failed attempts 和 unknown usage 都为 0。v3 已验证；v4 没有执行，因为第一批已暴露同类 key protocol error，且 measured 上限已用满。按约束没有补跑 Pydantic，也没有运行 llxprt Graph。

## 持久化证据与后续边界

每个真实 run 都写入了独立的 checkpoint、run journal 和 result artifact；旧实验目录没有被覆盖。第一批与第二批的原始输出目录分别为：

- `eval/outputs/finding-delivery-haystack-discount-20260909-zhipu/`
- `eval/outputs/finding-delivery-discount-postfix-20260909-zhipu/`

当前仍需后续真实模型验证的事项只有两项：模型是否能在更多 fixture 上稳定遵守 runtime target/version repair contract，以及 v4 matcher 的行为。这两项被明确标记为未验证，没有用离线结果冒充真实模型结论。
