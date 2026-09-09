# MergeWarden finding 交付链路本轮验证报告

日期：2026-09-09
工作目录：`E:\PycharmProjects\MergeWarden-recovered`
当前 HEAD：`f4f80c0 docs: record natural repair validation`
对照基线：`3ad4876 fix: isolate runtime finding repair delivery`
本轮前一项相关提交：`51a7610 fix: close finding repair delivery gates`

## 结论摘要

本轮没有发起真实模型调用。当前请求要求“在有明确本轮模型授权时”才执行真实调用，但本轮没有给出新的明确额度授权，因此没有把旧轮次已使用的授权延伸到本轮，也没有产生新的 provider、token 或延迟证据。

离线证据已经确认：自然 Discount 的原始 finding 同时有结构性缺口和 policy 表达缺口。真实送达的 evidence catalog 含有足够定位 `src/checkout.py`、`src/discounts.py` 和测试文件的证据，但自然 finding 没有 contract role 绑定；同时其自由文本没有命中当前 `has_specific_code_evidence` 的启发式规则。更重要的是，保持事实、severity、confidence、位置、supports 和引用不变，只改变 evidence 的表达形式，就可以改变 policy 结果；甚至只有 `` `x()` `` 这样的无实质证据文本也会被判为 specific。

因此，当前最直接的剩余阻断不是已证实的 repair 事务机制失效，而是：

1. 自然 finding 的结构化 contract 绑定缺失；
2. policy 对自由文本的表达形式敏感，并忽略结构化 evidence 绑定；
3. 本轮没有真实自然模型调用，不能据此判断 Haystack/Discount 的自然模型补丁质量或自然 repair 的真实成功率。

本轮不修改生产 policy、阈值、gold、matcher、Graph、语言支持、检索策略或交付架构。

## 1. 已核对的真实材料

离线回放使用了真实历史文件，不用交付摘要替代原始事实：

- 自然 Haystack event log：`eval/outputs/event_logs/golden_deepset-ai_haystack_pr12208_reverse_f5e84b4e-2781-4300-aa4c-5e754e4eacdd.jsonl`。
- 自然 Discount event log：`eval/outputs/event_logs/development_agent_search_cross_file_22b62d9d-dd66-4f98-a980-7a796fa17c0b.jsonl`。
- 自然 Discount journal：`eval/outputs/finding-delivery-next-round-discount-normal-20260909/run_journals/development_agent_search_cross_file_A-agent-search_22b62d9d-dd66-4f98-a980-7a796fa17c0b_journal.jsonl`。
- 受控成功 event log：`eval/outputs/event_logs/development_agent_search_cross_file_2e1ac434-b73d-4bfa-a8e0-b964d1599bb2.jsonl`，仅作为历史对照，不计入本轮自然成功率。
- policy 实现：`src/analyzer/review_policy.py`。
- evidence specificity 实现：`src/analyzer/output_formatter.py`。
- repair、integrity、最终发布实现：`src/orchestrator/agent_loop.py`、`src/analyzer/finding_integrity.py` 及相关 contract/registry 代码。

仓库根目录没有适用于本仓库的 `AGENTS.md`；递归发现的同名文件位于生成的隔离 fixture 仓库中，不适用于本次工作目录。

## 2. 上轮条件的准确解释

上轮两个正常场景的 `review_repair_max_attempts=0`，所以 Haystack 和 Discount 的 `published=0` 证明的是“禁用应用内 repair 时首次交付为 0/2”，不是自然缺口经过一次 repair 仍然失败。

上轮受控 Discount 使用 `review_repair_max_attempts=1`，真实 `repair_review` 被调用，transaction accepted，integrity verified，并记录了 `published=1`；但同时仍有 `policy_rejected_count=1`。它证明了真实 repair 接口、事务绑定、patch 应用和字段保真曾经成功，不证明满足全部 policy 条件的端到端正式交付，也不计入本轮自然成功率。

本轮准备的自然 repair 配置为：

- `eval/variants/finding-delivery-natural-repair-haystack-20260909.yaml`；
- `eval/variants/finding-delivery-natural-repair-discount-20260909.yaml`。

两份配置均固定 `zhipu`、`glm-5.3-flash`、`temperature=0`、`review_repair_max_attempts=1`，并要求实际运行时使用 `MODEL_MAX_RETRIES=1` 与 `--no-retry-invalid`。由于没有本轮真实调用授权，这些只是保留的实验配置，不是新的模型结果。

## 3. Haystack 离线缺口与路由诊断

自然 Haystack 候选的完整缺口不是单一字段遗漏，共识别出 6 项：

| 缺口 | 诊断 |
|---|---|
| `violated_invariant` 缺失 | finding 主体信息不完整，但属于可由 repair 明确补齐的内容结构问题 |
| contract role/role claim 缺失（两项） | contract 证据没有以所需 role claim 送入 finding |
| `supports` 中重复 cause role envelope（两项） | role 结构有重复，不能靠静默丢弃其中一项解决 |
| contract support 缺失 | contract 关联未形成有效 support 绑定 |

这些缺口被分类为可修复的内容结构问题，进入 `needs_repair`，而不是因为通用 `finding_contract_invalid` 直接归为不可修复。身份伪造、跨快照、非法来源、非法目标和无效引用仍由 integrity/transaction 约束拒绝，不能因为存在某个可修复字段就放行。

离线使用实际 orchestrator 的 repair budget=1 回放了“自然缺口 → 分类 → transaction → repair 请求 → patch 校验 → registry 更新 → 重验 → 发布”完整链路。合成的合法 patch 明确标记为测试输入，不冒充模型输出；它一次补齐多个合法结构缺口，保留已有 cause 引用、trigger、impact 等非目标内容，事务接受、registry 版本有效，重验通过并发布。预算为 0 的回放则记录 `configured_zero_budget`/`repair_disabled`，而不是伪装成 repair 尝试失败；未修好场景保留原候选、原版本和完整失败原因。

这证明当前离线 repair 机制能够表达 Haystack 所需的多缺口修复。它不等于本轮真实模型已经完成 Haystack repair，因为本轮没有 provider 调用。

## 4. Discount 真实 finding、证据和修复对象

从自然 Discount event log 的 `candidate_registered` 事件读取原始 candidate，从自然 journal 的最新 `evidence_catalog` 读取已送达 evidence。原始候选为 `cand_c037f02d416d47f9a96a`，critical、confidence `0.95`，已有 `cause`、`trigger`、`impact` 三个 support，但没有 `contract` support。原始 evidence 文本是：

> `src/discounts.py:2 shows apply_discount returns total - total*rate; the diff adds '- total * rate' in checkout, so checkout(100, 0.2) evaluates to 60 instead of 80.`

自然 journal 的实际送达 catalog 至少包含以下与该 finding 相关的记录：

- `ev_75b55ca728b7114fe5e75ebe`：`src/checkout.py` read-file 证据；
- `ev_7245344ae1bea12b944e618c`：`src/checkout.py` file context；
- `ev_493d801ca85f159b5eeaa912`：`src/checkout.py` diff；
- `ev_c83c5ddeb0b321bf1cabfd06`：`src/discounts.py` read-file 证据；
- `ev_e4742bca8657586f05475976`：`tests/test_checkout.py` read-file 证据。

因此，不能把该 finding 简化为“没有真实证据”。更准确的结论是：送达证据足以支撑相关代码事实，但自然模型没有把 contract claim 绑定为 contract role；与此同时，当前 policy 的自由文本 specificity 启发式也没有识别这段普通 prose。

离线构造的 repair 对象只补充合法 contract role，并引用实际送达的 `ev_c83c5ddeb0b321bf1cabfd06` 与 `ev_e4742bca8657586f05475976`。severity、confidence、primary anchor、原始 evidence 和原有三种 role 均保持不变。该对象的 policy 结果仍为 `critical_evidence_not_specific`，说明补充结构化 contract role 不能绕过当前 policy 的自由文本判断。

## 5. policy 表达敏感性成对测试

测试文件为 `tests/test_review_policy_expression_sensitivity.py`。每个成对样本只改变 `evidence` 字符串，断言 severity、confidence、位置、supports、引用和其他对象字段完全相同。结果如下：

| 样本 | `evidence_specific` | policy verdict | 命中/未命中原因 |
|---|---:|---:|---|
| 历史自然文本 | `false` | reject | 没有命中 diff、行首代码或 inline-code 规则，返回 `critical_evidence_not_specific` |
| 同一事实加 inline backticks | `true` | pass | `` `checkout(100, 0.2)` `` 命中 inline code/function-call 规则 |
| 同一事实把调用移到行首 | `true` | pass | `checkout(100, 0.2)` 命中行首代码模式 |
| 同一事实放入普通 code block | `true` | pass | 不是因为普通 Markdown fence 本身，而是 block 内行首调用命中行首代码模式；只有 ` ```diff ` 有专门 diff 处理 |
| 同一事实的等义普通语言 | `false` | reject | 事实未变，但没有命中当前正则启发式 |
| 空 evidence | `false` | reject | 空文本没有 specificity |
| 只有 `` `x()` `` | `true` | pass | inline function-call 规则命中，虽没有实质事实、有效引用或完整语义 |

这直接回答了“事实不变、仅格式变化是否改变 policy 结果”：是。它也暴露了一个反例：纯格式化的代码片段可以通过局部 policy 判断，而自然、具体、可定位的普通 prose 可能被拒绝。

当前 `evaluate_issue_filter` 的关键判断是对 `issue.evidence` 调用 `has_specific_code_evidence`；它不读取 supports 的 role、evidence_refs 或 evidence catalog 来判断 specificity。因此，当前 policy 在这一点上主要检查自由文本，忽略结构化证据绑定。

## 6. policy 与 integrity 的边界

两者职责不同：

- policy 是交付前的确定性输出过滤。当前 critical finding 主要要求高 confidence 和文本 evidence 命中 specificity 启发式，并给出 `critical_evidence_not_specific` 等 reason code。
- integrity 检查候选 schema、角色完整性、候选身份、repo/snapshot/revision、目标绑定、证据引用是否实际送达且可解析、事务与 registry 版本等。它验证的是“这个对象是否安全、可追溯、与当前上下文绑定”。

两者不存在可互相替代的关系：policy pass 不能让未送达引用可发布，integrity verified 也不能把 policy rejection 变成 pass。离线负向测试把所有 supports 改成未送达的 `ev-not-delivered`，同时将 evidence 改为 `` `checkout()` ``；结果是 policy 局部 pass，但 integrity 仍拒绝，failure code 为 `support_reference_unresolved` 或 `support_reference_missing`。这证明 policy 局部结果不等于完整发布链路结果。

当前实现已在最终发布前对修复后的权威 bound issue 再执行 policy；所以“repair accepted”或“integrity verified”不会单独触发发布。若 policy 仍拒绝，最终不得发布，`delivery_complete` 也不能被写成完成。

## 7. 测试执行结果

本轮新增和受影响测试均已实际执行：

- policy 表达敏感性：`9 passed`。
- 受影响回归集合（policy 新测试、自然 finding repair replay、finding delivery replay/integrity/delivery、agent loop）：`105 passed`。
- 静态检查：ruff 通过；mypy 对 5 个源文件通过；compileall 通过；`git diff --check` 通过。
- 全量 pytest：`966 passed, 1 skipped, 3 failed`，总耗时约 203 秒。

全量的 3 个失败是：

1. `tests/integration/test_agent_openai_compatible.py::test_real_agent_uses_http_provider_tools_and_finding_guard`；
2. `tests/integration/test_runtime_offline_regression.py::test_full_signed_webhook_agent_publish_artifact_runtime`；
3. `tests/test_revision_pinned_review.py::test_queued_revision_a_stays_pinned_when_repository_head_is_b`。

三者均在隔离 fixture 创建基础 commit 时失败，错误为 `git commit --quiet -m base` 找不到全局 SSH signing key `C:/Users/Lenovo/.ssh/id_ed25519`。本轮未读取私钥、未修改全局 Git 配置、未把该环境阻塞伪称为代码断言失败。其余测试通过；1 个 skip 和 3 个环境失败按 pytest 原样保留。

## 8. 真实模型验证状态与指标

本轮真实模型调用数为 0，原因是没有明确的本轮授权。故以下真实运行指标为“未执行/不适用”，不是成功或失败的零值：

| 指标 | Haystack | Discount |
|---|---:|---:|
| provider attempts / failures | 未执行 | 未执行 |
| token / latency | 未执行 | 未执行 |
| 初次完整性通过 | 未执行 | 未执行 |
| 自然缺口中具备 repair 条件 | 离线确认 6 项结构缺口可分类为可修复 | 离线确认 contract role/support 缺口可修复；policy 仍独立拒绝 |
| repair 启动、accepted、rejected、deferred | 未进行真实调用；离线合成 patch 启动并接受 | 未进行真实调用；离线 contract patch 可构造，policy 仍 reject |
| 最终 published / delivery_complete | 未执行真实样本 | 未执行真实样本 |
| gold 匹配 | 未执行本轮真实样本 | 未执行本轮真实样本 |

历史受控 Discount 的 `repair accepted`、`integrity verified`、`published=1` 与同时存在的 policy rejection 单独保留，不并入自然结果，也不改写为全政策端到端成功。

## 9. 是否需要改代码与最小建议

本轮没有发现必须立即修改生产代码的 repair/transaction/registry 缺陷；生产 policy 也没有修改。新增内容只有本轮诊断测试和本报告。

最小建议是后续单独评审 policy 语义，而不是通过改阈值或补造 evidence 让样本变绿：对 critical evidence specificity 优先使用已经通过 integrity 验证的结构化证据（事实、role、实际送达引用和上下文），或者引入不依赖 Markdown 位置的语义规则；同时明确禁止只有格式化短片段就通过。无论采用哪种方案，都应保留当前 integrity gate 和最终 policy recheck，并新增对应的负向回归样本。本轮不擅自实现该语义变更。

若要完成用户要求的真实自然 repair 验证，需要新的明确授权：Haystack 一次、Discount 一次，每个最多一次应用内 repair；provider 单次请求尝试，`retry_invalid=false`，fixture 不自动重跑。只有这两次真实运行完成后，才能报告真实 `repair_review` 调用数、transaction、patch 字段保真、integrity、policy、published、provider token/延迟及 gold 匹配。

## 最终回答

“自然产生的缺口，在允许一次应用内 repair 时，能否被新链路安全修复并完成交付？”

离线链路答案是：Haystack 的多缺口结构修复可以安全进入 repair、绑定事务、应用 patch、保留非目标字段并在重验后交付；Discount 的 contract role 可以用真实送达引用补齐，但当前 evidence 文本仍会触发 policy 拒绝，不能完成正式发布。当前没有真实自然模型调用证据，所以不能把离线合成 patch 推广成自然成功结论。

“当前剩余阻断来自 repair 机制、模型补丁质量、真实证据不足，还是 policy 的表达敏感性？”

- repair 机制：目前没有直接失败证据；离线全链路通过，历史受控真实 repair 也证明接口、事务和 patch 应用可工作。
- 模型补丁质量：本轮未执行真实模型，不能作自然场景质量结论；历史受控 patch 的 integrity/字段保真成功，但 policy 仍拒绝。
- 真实证据不足：Discount 不是“catalog 没有证据”；catalog 有真实送达的源文件/差异/测试证据，但自然 finding 缺少 contract role 绑定，这是结构化交付缺口。
- policy 表达敏感性：已被成对测试直接确认，是当前 Discount 修复后仍然阻断发布的直接原因；事实不变的格式变化可以从 reject 变 pass，而纯 `` `x()` `` 也能局部 pass。
