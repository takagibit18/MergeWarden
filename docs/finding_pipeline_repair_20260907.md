# Finding 生成链路修复记录（2026-09-07）

本文记录本轮在 `MergeWarden-recovered` 中落地的 finding 生成、证据校验、修复回路和评测口径修复。三个反复调试的 fixture 仍属于 development/validation 集，不当作 held-out；工程修复本身不修改 gold、推送或发布。历史真实载荷与本次修复后的新实验严格分开，单样本只用于链路验收，不能外推模型质量。

## 1. 复核到的故障边界

此前一批真实运行已经能产生候选，但“最终提交、策略过滤、verifier、修复、发布、matcher”混在不同事件和不同口径中。典型问题是：

- producer 解析仍可能把带结构化字段的 finding 当成 schema 1.0；
- manifest、图索引或工具历史被误当作模型实际看到的证据；请求正文被裁剪后仍可能登记完整源码；
- `location`、cause/contract/trigger/impact 和 `supports` 没有共享同一规范化边界；
- `needs_repair` 只被记录，没有进入一次有界修复；schema 修复和 guard 修复需要同一份报告额度；
- process metrics 曾从旧字段读取 `evidence_complete_count`，无法和最终结果对账；
- 旧 semantic-v3 只有单一命中结果，无法区分展示定位和根因角色质量。

这些边界没有通过提高 confidence、降低阈值、清空 evidence 或改写 gold 处理。

## 2. 已落地的链路

```text
model output
  -> producer/schema normalization
  -> canonical v2 contract gaps
  -> policy routing
  -> exact serialized request assembly
  -> delivered evidence ledger
  -> integrity binding
  -> one shared repair budget
  -> final publication
```

### 2.1 Canonical finding contract

`src/analyzer/finding_contract.py` 现在是 producer payload、`ReviewIssue`、`FindingDraft` 和 verifier 的适配边界。v2 核心结构化字段出现或显式指定 `schema_version="2.0"` 时统一进入 canonical contract，即使模型省略版本号或填 `1.0` 也不能让完整结构化载荷回到旧要求；仅供 legacy policy 入口使用的 `cause_evidence` 锚点不会被误升级。严格风险 finding 需要 `finding_id`、观察行为、因果机制、不变量、trigger、impact、repair intent、角色 evidence 和逐角色 support；location 与 `primary_anchor` 冲突会产生明确 gap。

`finding_id`、candidate identity、artifact identity、snapshot、revision 和 context hash 由 runtime 绑定。模型输入 schema 不允许用自填身份替代运行时事实；旧格式仍经显式 legacy adapter 保持兼容。

运行时在候选首次进入 funnel 时生成稳定的 `cand_...` `candidate_id`；
`logical_identity_hash` 只描述这个运行时候选，`content_hash` 描述可变的
finding 版本。severity、anchor、finding 文本、evidence 或 suggestion 改变
都不能生成新的候选或改变修复目标。修复输入单独使用
`target_candidate_id`，必须精确命中一个仍需修复的候选；unknown、duplicate、
cross-candidate、passed 和省略目标均不自动映射。

### 2.2 实际发送证据 ledger

`ContextState.evidence_ledger` 只接收成功 provider request 中可解析、完整出现的 body：

- 完整 diff hunk、完整 file context、tool result、带 body 的 manifest span 才能登记；
- selected-but-dropped、summary、header-only manifest、handoff/request shortening marker 不登记为完整证据；
- tool evidence 必须按实际 `tool_call_id` 与 wire result body 对上，缺 body 或被裁剪的 tool message 不计入；
- 每条记录保留 artifact、path/range、side、snapshot、revision、content/body hash、source tool call 和 `delivered` lifecycle；
- `EvidenceLedger.covers` 仍要求完整行范围、正确 side、身份和 hash，范围外或中间有缺口继续拒绝。

因此“内部规划过”与“模型实际看到过”是两个状态。首次完整请求和后续 submit/repair 请求都经过同一解析入口，已交付记录只做去重合并，不把新计划自动升格为 delivered。

### 2.3 统一请求预算与共享修复额度

`RequestAssembler` 对消息、历史、工具 schema 和 provider 控制生成一次实际 wire payload，并在此 envelope 上执行预算；`ModelClient` 复用同一序列化形状进行请求 telemetry。final submit、schema validation repair、guard repair 和 length recovery 均走完整 request cap。

`REVIEW_REPAIR_MAX_ATTEMPTS` 是报告级共享额度：schema validation repair 先消耗额度时，guard 不会重新获得一份额度；guard repair 已预留额度时，其内部模型响应不会再触发 schema repair。canonical 本地转换不计入额度。达到上限时保留明确的 incomplete/needs-repair 事实，不静默发布。

新的 validation profile 显式记录有效 wire 配置：exploration/validation
`max_tokens=12288`、submit-only `max_tokens=4096`；prompt input 64,000，
soft/hard cumulative budget 为 120,000/160,000，final serialized request
budget 为 8,000，repair 为报告级共享 1 次，recoverable tool error 上限为
3 次。每个阶段和总预算都从事件与 summary 读取，不能只看 YAML 中的旧
`max_output_tokens`。

provider 失败但没有 usage 时保留 `failed_attempt_count` 与
`failed_unknown_usage_count`，不把未知成本当成零，也不把启动失败归因于
模型质量。

### 2.4 独立漏斗与状态

`finding_funnel_completed` 分别输出：

| 层次 | 计数含义 |
|---|---|
| `logical_candidate_count` | 进入 verifier 的逻辑候选 |
| `submitted_finding_count` / `submitted_attempt_count` | 最终报告 finding 数与提交尝试次数 |
| `provider_attempt_count` | provider 实际 attempts，包含失败与 retry |
| `policy_passed_count` / `policy_rejected_count` | 策略层通过与拒绝 |
| `risk_candidate_count` | 进入风险验证的候选 |
| `integrity_checked_count` / `integrity_verified_count` | guard 检查与身份/范围/证据绑定通过 |
| `integrity_needs_repair_count` / `integrity_invalid_count` | 可修缺口与不可修身份/结构失败 |
| `repair_attempted_count` / `repair_succeeded_count` | 报告级修复尝试与真正修复后通过的候选 |
| `evidence_complete_count` / `evidence_validated_count` | 角色 evidence 完整与实际 binding 验证通过，二者不混用 |
| `final_published_count` / `final_risk_finding_count` | 最终发布总数与其中的风险数 |

`eval/run_summary.py` 同时保留 nested funnel 和兼容的 direct fields，并从最终 funnel 对账 `evidence_complete_count`。运行合法、schema 可解析、review complete、integrity verified、gold 命中是不同维度。

### 2.5 引用与工具错误的可恢复性

模型引用被分成：未解析的 protocol/ID、已知但未交付的 catalog 引用、
显式错误的身份/快照/版本/hash、以及越界位置。前两类只生成单一的
reference/catalog gap，并保留 `reference_id` 与 `resolution_status`；不会
级联成空 provenance、location 或 identity 错误。后两类是真实 untrusted
identity，继续拒绝且不做 nearest/auto repair。角色缺失属于 contract gap，
只有实际源代码缺失才属于 source gap。

工具结果现在带有结构化 `error_type`、`failure_class`、`recoverable` 和
`recommended_next_step`。file-vs-directory、参数、可修路径和有限超时错误
可以带纠正动作重试，workspace/permission/policy 错误不能绕过；同一工具、
错误类别和参数的重复 recoverable 错误在上限后结束，不再使用任意
`any(not ok)` 作为唯一阻断条件。

### 2.6 最终提交的证据边界

final submit 使用实际序列化 request 中的 delivered catalog：相关必需
catalog entry 全部保留，每个 entry 原子裁剪，不再使用任意前 40 条；
历史 ledger 记录不等于本次暴露的 catalog。序列化后会再次校验预算与每个
必需精确 ID；缺失时记录 `final_submit_context_insufficient`，不调用 provider。
这项交付可靠性与 Graph 选择/语义质量分开统计。

## 3. 评测口径

历史 semantic-v2 和已使用的 semantic-v3 行为保持不变。新的 `semantic-v4` 只显式 opt-in：

- 只把最终 `integrity_status="verified"` 的风险 finding 放入有效集合；
- 分开计算 display location 与 root-cause role 命中；
- 对 mechanism、invariant、trigger、impact、repair unit、affected paths 和 root-cause id 分别保留诊断；
- 跨文件路径只能来自验证过的角色 evidence，不以“同文件”代替因果链；
- partial match 只用于审计诊断，不自动算成完整命中。

当前 YAML 默认 `matcher_version: semantic-v3`，以保护历史可比性；将副本显式改为 `semantic-v4` 后再运行分层评分。三个 validation fixture 仍不是 held-out。

Graph context failure、工具/客户端 failure、schema/contract failure、
integrity rejection、runner invalid 和 semantic gold miss 分列记录。没有向
prompt、catalog、gold 或 matcher 注入答案；一次样本即使通过也只能证明该次
链路可交付，不能证明 Graph 质量。

## 4. 本地验证与真实评测入口

已加入脱敏最小重放：[`eval/replays/finding_funnel_minimal.jsonl`](../eval/replays/finding_funnel_minimal.jsonl)。本轮离线验证命令为：

```powershell
pytest -q tests/test_finding_funnel_replay.py tests/test_finding_contract.py tests/test_evidence_ledger.py tests/test_request_assembler.py tests/test_semantic_v4.py
```

真实 validation 入口为（不会把凭据写入参数或日志）：

```powershell
python -m eval.graph_ab_pilot `
  --config eval/variants/graph-ab-glm53-flash-post-optimization-20260904.yaml `
  --suite validation `
  --samples 3 `
  --no-resume `
  --output-json eval/outputs/finding-pipeline-repair/raw.json `
  --summary-json eval/outputs/finding-pipeline-repair/summary.json `
  --resume eval/outputs/finding-pipeline-repair/checkpoint.jsonl
```

该配置包含完整 request budget、共享 repair cap、A/B context mode 和三个已知 validation fixture；YAML 当前以 semantic-v3 作为历史比较口径。要测 semantic-v4，应复制配置并仅把 `matcher_version` 改为 `semantic-v4`，重新计算 checkpoint identity，不能覆盖旧结果。Graph 仅是可选 context treatment；构建/读取失败时保留 fallback reason 并走 `agent_search`，所有 Graph 证据仍受有界 context budget 控制。

此前未授权阶段没有执行上述命令，因此当时没有声称新的模型质量结果；已有 2026-09-06 真实运行报告仍作为历史基线：[`graph-ab-glm53-flash-post-optimization-20260906.md`](./graph-ab-glm53-flash-post-optimization-20260906.md)。

## 5. 相关实现

- `src/config.py`：显式进程环境优先于历史 `.env`，并集中声明阶段/总预算；
- `src/analyzer/finding_contract.py`：canonical contract、角色 gap 与引用状态；
- `src/analyzer/evidence_ledger.py`：实际交付证据与范围覆盖；
- `src/models/request_assembler.py`：完整 provider request envelope；
- `src/analyzer/finding_integrity.py`：候选身份、三态 integrity binding 与 repair gap；
- `src/orchestrator/agent_loop.py`：修复回路、工具可恢复性、最终 guard、独立漏斗；
- `eval/runner.py` / `eval/run_summary.py` / `eval/schemas.py`：版本化 matcher、阶段状态与成本指标；
- `eval/graph_ab_checkpoint.py` / `eval/graph_ab_pilot.py`：带 hash 的结果 artifact、运行契约与恢复身份。

## 6. 2026-09-08 历史真实载荷（修复前基线）

下表是本次修复之前已存在的真实载荷投影。它们用于定位现场缺陷，不是
修复后的回归结果；`.env` 历史上选择 `dashscope`，旧运行通过独立进程尝试
provider 切换。provider 失败、客户端启动失败和模型未提交的记录均保留在
独立 checkpoint 中。

| 配对运行 | runner 结果 | Agent Search | Graph hybrid warm |
|---|---|---|---|
| 折扣重复样本 | PASS；无 pairing error | 1/1 合法，1 个 finding 完成并发布，gold 命中 1/1；33,111 tokens、5 次 provider attempt、约 55.30 s | 1/1 合法，但 finding `incomplete`，1 个候选被真实性/契约检查拒绝；24,498 tokens、3 次 provider attempt、约 43.32 s |
| Haystack PR12257 | FAIL；A 侧模型未形成提交 | provider 有响应但最终为 placeholder，`unrecoverable_error` + `incomplete_draft_findings`；49,757 tokens、2 次 provider attempt | runner 合法，但 finding `incomplete`，因 evidence identity/binding、契约、位置和 support 引用问题拒绝；101,762 tokens、4 次 provider attempt |

结果文件：[`discount-http-raw.json`](../eval/outputs/graph-ab-glm53-flash-single-round-20260908/discount-http-raw.json)、[`discount-http-summary.json`](../eval/experiments/graph-ab-glm53-flash-single-round-20260908-discount-http-summary.json)、[`haystack-http-raw.json`](../eval/outputs/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908/haystack-http-raw.json)、[`haystack-http-summary.json`](../eval/experiments/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-haystack-http-summary.json)。

这组数据只证明了旧路径中确实存在候选绑定、提交上下文、工具错误和引用
身份混淆；Haystack 两侧均未形成可比较的 gold 命中，不能据此宣称 Graph
质量提升或回退。修复后的新运行记录在下一节单独落盘。

## 7. 修复后新实验记录

修复后最终验收使用 `repair-v3` 配置和新输出目录；此前的 `repair-v1`、
`repair-v2` 仍保留为中间诊断，不作为最终结果，也没有覆盖第 6 节历史载荷：

- `eval/variants/graph-ab-glm53-flash-single-round-20260908-repair-v1.yaml`
- `eval/variants/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-repair-v1.yaml`
- `eval/variants/graph-ab-glm53-flash-single-round-20260908-repair-v2.yaml`
- `eval/variants/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-repair-v2.yaml`
- `eval/variants/graph-ab-glm53-flash-single-round-20260908-repair-v3.yaml`
- `eval/variants/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-repair-v3.yaml`

### 7.1 Discount cross-file fixture

raw：[`discount-http-raw.json`](../eval/outputs/graph-ab-glm53-flash-single-round-20260908-repair-v3/discount-http-raw.json)；summary：[`discount-http-summary.json`](../eval/experiments/graph-ab-glm53-flash-single-round-20260908-repair-v3-discount-http-summary.json)。`pairing_errors=[]`，但 runner readiness 为 `FAIL`，因为 Agent Search 这次没有形成提交。

| Variant | Runner/schema | 生命周期 | Finding / guard / gold | 成本（provider attempts；tokens；latency） | Graph telemetry |
| --- | --- | --- | --- | --- | --- |
| Agent Search | invalid；schema invalid；`max_iterations` + `incomplete_draft_findings` | ready=1，submitted=0，complete=0 | 0 finding；未进入 gold 比较 | 3；21,722；29.771 s；repair 0 | disabled |
| Graph warm | valid；schema valid | ready=1，submitted=1，complete=1 | 1 finding；integrity verified=1，published=1；gold hit=1/1 | 4；32,846；49.859 s；repair 0 | 8 available/8 selected，2 production，2,868 graph-context tokens |

### 7.2 Haystack PR12257 fixture

raw：[`haystack-http-raw.json`](../eval/outputs/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-repair-v3/haystack-http-raw.json)；summary：[`haystack-http-summary.json`](../eval/experiments/graph-ab-glm53-flash-single-round-haystack-pr12257-20260908-repair-v3-haystack-http-summary.json)。同样 `pairing_errors=[]`，runner readiness 为 `FAIL`，原因是 Agent Search 的最终 serialized request 无法容纳 19 个相关必需 catalog entry 中的 8 个，因此安全地停止 submit。

| Variant | Runner/schema | 生命周期 | Finding / guard / gold | 成本（provider attempts；tokens；latency） | Graph / catalog telemetry |
| --- | --- | --- | --- | --- | --- |
| Agent Search | invalid；schema invalid；`final_submit_context_insufficient` | ready=0，submitted=0，complete=0 | 0 finding；不计 gold miss | 3；88,041；61.769 s；repair 0 | Graph disabled；historical ledger=53，exposed catalog=19，required=19，included=11，missing=8 |
| Graph warm | valid；schema valid | ready=1，submitted=1，complete=1；finding status=`incomplete` | 0 finding；integrity needs_repair=1；repair attempted=1/succeeded=0；gold miss=0/1 | 4；78,606；116.705 s；final submit=2 | 772 available/20 selected，18 required production paths，11,516 graph-context tokens；required catalog 6/6 included |

两组最终运行中 provider failure=0、unknown usage=0；因此上表 tokens 是
provider 返回的成功使用量，模型未提交/上下文不足仍按运行失败维度保留。
这些单样本结果只能说明修复后的回放和交付边界确实生效：没有把
`evidence_sufficient`、完整 Graph catalog 或 runtime `review_complete` 误当作
可发布 finding，也没有把未比较运行填成 gold miss。它们不能证明 Graph 的
召回或语义质量提升；质量实验需要更多样本和独立设计。

客户端构造检查在进程内设置 `MODEL_PROVIDER=zhipu` 后通过，使用
`glm-5.3-flash`，保留 `HTTP_PROXY/HTTPS_PROXY`，移除大小写两种
`ALL_PROXY`；仓库 `.env` 未修改。脱敏回放和完整回归均通过；完整回归为
`911 passed, 1 skipped`（3 个依赖/框架 warning）。
