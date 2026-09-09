# MergeWarden finding 交付链路：自然缺口一次 repair 复核（2026-09-09）

## 结论先行

离线跨阶段回放证明：自然 Haystack 缺口可以在一次应用内
`repair_review` 中安全修复并完成交付；补丁只修改缺口字段，事务、版本、证据上下文和
registry 绑定均保持有效。

Discount 的结构性缺口也可以进入一次 repair，合法补入 contract role 后完整性重验通过，
但它仍被独立 policy gate 以 `critical_evidence_not_specific` 拒绝，所以最终不能发布。
这不是 repair、事务或 registry 失败。

本轮没有发起新的真实 provider 调用：当前请求只在获得本轮明确授权后允许执行两条自然真实路径，
旧轮次已经使用过的额度不被推定为新授权。因此，“自然模型缺口经过一次 repair 后的真实最终交付”
仍待授权后的两次各一次实测；本报告不把离线合成 repair 响应冒充模型输出，也不把上轮受控
`1/1` 混入自然成功率。

## 1. 范围、基线与上轮条件

- 已核对 HEAD：`3ad48764a73c2f9c61a8c773c47625913ce8252a`
  （`3ad4876 fix: isolate runtime finding repair delivery`）。
- 本轮真实验证没有新 run、没有新 provider 输出目录，没有读取或修改 `.env`，没有 push。
- 上轮两个正常场景均为 `review_repair_max_attempts=0`、`retry_invalid=false`、
  `attempted_run_count=1`；受控 Discount 缺少 `causal_mechanism` 为
  `review_repair_max_attempts=1`、`attempted_run_count=1`。
- provider 是显式 `zhipu`、`https://open.bigmodel.cn/api/paas/v4`、
  `glm-5.3-flash`、temperature `0.0`。上轮进程用 `MODEL_MAX_RETRIES=1`，因此每个
  logical model call 只有一次 provider attempt；这和 `retry_invalid=false` 的 fixture
  级不重跑、以及应用内 bounded repair 是三个不同控制面。

上轮原始摘要的成本与 gold 结果如下；gold 匹配独立于交付结果：

| 场景 | provider attempts | total tokens | 端到端延迟 | gold | published / delivery | 说明 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Haystack 正常 | 4 | 48,211 | 48.360s | 0/1 | 0 / false | `needs_repair`，未开启 repair |
| Discount 正常 | 4 | 27,650 | 38.859s | 0/1 | 0 / false | `needs_repair`，未开启 repair |
| Discount 受控缺 causal | 5 | 37,460 | 59.718s | 1/1 | 1 / true | 单独的受控实验，不计入自然成功率 |

上轮三个结果的 provider failed attempts 和 unknown usage 均为 0。受控事件虽然记录了
真实 `repair_review`、事务 accepted、candidate verified 和 published=1，但同一原始事件也
记录了 `policy_rejected_count=1`、`critical_evidence_not_specific`。这暴露出最终输出阶段
没有再次执行独立 policy gate；本轮已用离线回放确认并修复该状态不一致。因而上轮
`published=1` 只作为历史证据保存，不把它当作当前修复后代码的重新验证结果。

原始事实来源：

- Haystack event log：`eval/outputs/event_logs/golden_deepset-ai_haystack_pr12208_reverse_f5e84b4e-2781-4300-aa4c-5e754e4eacdd.jsonl`
- Discount 正常 event log：`eval/outputs/event_logs/development_agent_search_cross_file_22b62d9d-dd66-4f98-a980-7a796fa17c0b.jsonl`
- 受控 event log：`eval/outputs/event_logs/development_agent_search_cross_file_2e1ac434-b73d-4bfa-a8e0-b964d1599bb2.jsonl`
- 三个 run journal：各自 `eval/outputs/finding-delivery-next-round-*/run_journals/`
- 上轮配置和摘要：`eval/variants/finding-delivery-next-round-*.yaml`、
  `eval/experiments/finding-delivery-next-round-*-summary.json`

## 2. 两条自然缺口的原始诊断

### 2.1 Haystack：六个结构缺口不是身份安全错误

原始 candidate `cand_10dcd1ab1bb0479f872e` 的完整性结果是
`needs_repair`，不是 `invalid`。原始 `finding_verification_completed` 中的六条缺口为：

1. `finding_contract_incomplete`：缺少 `violated_invariant`。
2. `role_claim_missing`：`contract_evidence` 为空，但引用的 source 已送达；这是缺 role claim，
   不是要求重新读取同一 source。
3. `finding_contract_invalid`：`supports[1].role` 重复 `cause`。
4. `finding_contract_invalid`：`supports[2].role` 重复 `cause`。
5. `support_role_missing`：canonical `supports` 缺少 `contract` envelope。
6. 第二条 `role_claim_missing`：最终绑定后的 `contract_evidence` role claim 仍缺失。

原始 candidate 的 supports 是三个独立 `cause` envelope，加上 `trigger` 和 `impact`，没有
contract。三个 cause 的 evidence refs 在 event log 中分别存在，不能因为 role 重复就静默
丢掉其中两个有效引用。

当前 `classify_integrity_failure` 将上述四类具体结构码归为 `contract_gap`；
`FindingIntegrityResult.status` 因此为 `needs_repair`。所以在 repair budget=1 时，这个候选
可以进入 `repair_review`，不会因为通用字符串 `finding_contract_invalid` 被过早归为不可修复。
身份绑定不匹配、snapshot/revision 不一致、repository path 越界/不存在、未送达或伪造的
evidence identity 仍走 `untrusted_identity` 或 reference error 的严格路径；本轮没有扩大
这些安全错误的放行范围。

### 2.2 Discount：source 已送达，但提交没有建立 contract claim

原始 candidate `cand_c037f02d416d47f9a96a` 的 supports 只有 `cause`、`trigger`、`impact`，
`contract_evidence=[]`，完整性缺口为：

- `role_claim_missing`（contract evidence source 已送达但没有 role claim）；
- `support_role_missing`（缺 contract envelope）；
- 再一条绑定后的 `role_claim_missing`。

这里没有发生 runtime 字段丢失。Discount journal 的 evidence catalog 实际送达了
`src/discounts.py` 的 `read_file`、`tests/test_checkout.py` 的 `read_file`、checkout 的
file context 和 diff；这些内容足以支持单次 discount 的 contract 事实，但模型没有把它们
作为 contract role 绑定到 finding。合成回放因此只补合法的 contract role，不改 evidence
正文、confidence、阈值、其他角色或已有 refs。

policy gate 在完整性验证前已经记录：`severity=critical`、`confidence=0.95`，但
`evidence_specific=false`、`risk_pattern_matched=false`，唯一拒绝原因是
`critical_evidence_not_specific`。上轮 funnel 同时显示 `pre_verifier_rejected_count=1`
和 `integrity_checked_count=1`：policy rejection 不是 provider 错误，也没有阻止我们诊断
后续完整性缺口；但它不能被 repair 成功后绕过。

## 3. 本轮最小实现修复

只改了 `src/orchestrator/agent_loop.py` 的两个交付边界：

1. 最终输出阶段使用 repair 后已经绑定的 issue 再执行 `evaluate_issue_filter`，而不是使用
   未修复的 raw issue 或信任之前的 policy 结果。这样 repair 只能修复被允许的结构缺口，不能
   让 policy rejection 静默进入最终报告。
2. `review_repair_max_attempts=0` 且存在待修复 candidate 时，记录
   `decision/finding_repair`，`reason=configured_zero_budget`、`repair_disabled=true`、
   `repair_attempted_count=0`。预算关闭与 repair 尝试失败不再混淆。

没有改 CandidateRegistry、opaque `target_handle`、事务绑定、patch-only 主体结构、Graph、
语言支持、检索、gold、matcher、confidence 阈值、模型策略或 repair 次数上限。

## 4. 离线跨阶段回放

新增 `tests/test_natural_finding_repair_replay.py`。输入是上一轮自然 journal 的脱敏最小投影；
测试执行真实 `AgentOrchestrator.run_review` 的 submit → integrity → transaction →
`repair_review` → patch merge → 完整重验 → finalization 路径。合成的合法 repair response
在测试代码中明确标注为 fixture，不是模型输出，也没有 provider 请求。

| 回放 | 初始缺口 | repair budget | 实际 repair | 完整性重验 | policy / 最终交付 | 关键不变量 |
| --- | ---: | ---: | --- | --- | --- | --- |
| Haystack 脱敏自然缺口 | 6 | 1 | 1 次，1 个 transaction，1 个 repair model-call fixture | verified=1 | policy pass，published=1，delivery=true | cause 三个 refs 全保留；新增 invariant 和 contract role；registry=verified |
| Discount 脱敏自然缺口 | 3 | 1 | 1 次，patch 应用 | verified=1 | `critical_evidence_not_specific`；published=0，delivery=false | 只增加 contract role；confidence、evidence、cause/trigger/impact 保持不变 |
| Haystack 脱敏自然缺口 | 6 | 0 | 0 次 | 未进入 repair，原候选不发布 | 显式 `configured_zero_budget` / `repair_disabled=true` | 不是“repair 尝试失败” |

同一组及既有回放还覆盖：

- opaque target 不存在、candidate 版本过期、evidence context 变化、重复 handle 和重复
  response 的拒绝；
- 未送达/伪造 evidence reference、candidate/evidence identity mismatch、越界路径和
  未观察 source 的严格阻断；
- patch 省略字段时继承原值，支持 role patch 不丢已有有效 refs，重复 role 可通过显式
  role replacement 纠正而不删除其他 role；
- 未修好时保留原 candidate、原版本和完整失败原因。

## 5. 有界真实验证状态

本轮真实 provider 调用数为 **0**。原因是当前请求要求“存在明确适用的本轮真实模型授权”后
才可运行；旧轮次授权和已经消耗的额度不被推定为新的无限授权。没有用提示词、历史结果或
配置文件中的 provider 名称替代授权。

已准备但未执行的新配置：

- `eval/variants/finding-delivery-natural-repair-haystack-20260909.yaml`
- `eval/variants/finding-delivery-natural-repair-discount-20260909.yaml`

两份配置均是新 experiment id、A-agent-search、单 fixture、`review_repair_max_attempts=1`、
显式 zhipu endpoint 和上轮关键参数。获授权后只执行 Haystack 一次、Discount 一次；调用时
需在进程级设置 `MODEL_MAX_RETRIES=1` 并传 `--no-retry-invalid`，每个 checkpoint 从新目录
开始，确认 `attempted_run_count=1`，不自动重跑、不故障注入、不补跑受控场景。审计必须同时
看到：真实 `repair_review` provider attempt（若自然缺口触发）、transaction accepted/rejected、
applied patch fingerprint、base version/context、重验状态、最终 published/delivery，以及
原始和最终未修改字段对账。

因此本轮没有新的 provider token、延迟或真实 repair attempted/accepted 数；不能把离线
`repair model-call fixture=1` 写成真实模型调用。

## 6. 测试与环境结果

- 新增自然回放：`4 passed`。
- 受影响 focused suite（最终代码）：`67 passed`；新增回放单独复跑也是 `4 passed`。
- 全量：`957 passed, 1 skipped, 3 failed`。
- 三个失败全部是隔离 Git fixture 在创建本地 commit 时继承了用户全局 SSH signing，报错
  `No private key found for "C:/Users/Lenovo/.ssh/id_ed25519"`：
  `tests/integration/test_agent_openai_compatible.py::test_real_agent_uses_http_provider_tools_and_finding_guard`、
  `tests/integration/test_runtime_offline_regression.py::test_full_signed_webhook_agent_publish_artifact_runtime`、
  `tests/test_revision_pinned_review.py::test_queued_revision_a_stays_pinned_when_repository_head_is_b`。
  这是测试环境阻塞，不是本轮代码断言失败；没有读取私钥、修改全局 Git 配置或修改 fixture
  来掩盖它。
- `ruff`、`mypy`、目标文件 `compileall`、`git diff --check` 和两份新 YAML 解析/variant
  校验均通过。全量中的 3 个环境失败之外，没有发现代码测试失败。

## 7. 分阶段漏斗与失败分类

本轮离线结果应分开读：

1. 首次完整性通过率：Haystack `0/1`、Discount `0/1`（两者都从自然缺口开始）。
2. 自然缺口中具备 repair 条件：Haystack `1`、Discount `1`；均为具体 contract gaps，
   不是 untrusted identity。
3. repair 实际启动：budget=1 回放 `2/2`；budget=0 回放 `0/1`，原因明确为
   `configured_zero_budget`。
4. repair attempted/accepted/rejected/deferred：Haystack `1/1/0/0`；Discount
   `1/1/0/0`（其中 Discount 的最终政策拒绝独立于 repair transaction）；budget=0 为
   `0/0/0/0`。
5. 最终交付：Haystack `published=1, delivery_complete=true`；Discount
   `published=0, delivery_complete=false`，原因是 policy gate；不是证据丢失或事务失败。
6. provider/token/latency：本轮离线均为 0/不适用；上轮真实数值见第 1 节。
7. 字段与证据保真：Haystack 原 cause 三 refs、severity/location/evidence/suggestion/
   confidence/anchor/trigger/impact 保持；Discount 只新增 contract role，其余保持。
8. gold：本轮未运行自动 gold；上轮 Haystack 和自然 Discount 各 `0/1`，受控实验单独
   `1/1`，不并入自然率。

失败分类：上轮正常样本是“首次内容结构缺口 + repair 未获预算”；本轮离线 Discount 是
“结构 repair 成功但独立政策拒绝”；身份、过期事务和证据上下文错误是安全拒绝；全量三条
是 Git signing 环境错误；本轮没有 provider/网络错误。

## 8. 最终回答与下一步

对问题“自然产生的缺口，在允许一次应用内 repair 时，能否被新链路安全修复并完成交付？”：

- **Haystack 类自然缺口：能。** 离线真实编排回放已完成一次有界 repair，六个缺口均被
  明确反馈，补丁应用、事务绑定、证据保真、registry 更新、完整重验和同一版本发布均通过。
- **Discount 本次自然缺口：只能修好完整性，不能完成交付。** contract role 可以安全补入，
  但 evidence-specific policy 仍拒绝；具体卡点是最终 policy gate，不是 repair 链路。
- **自然真实模型结论尚未完成。** 需要用户明确授权后，按两份新配置各执行一次，才能回答
  GLM 自然输出是否真的调用新 `repair_review` 并产出合规 patch。若两次自然初始提交都直接
  通过，也必须报告“本轮没有获得自然 repair 触发证据”，不能人为制造 repair。

下一步只建议执行这两次有界自然实测，并按上述审计字段验收；不建议继续扩展架构或增加
repair 次数。
