# Harness 减薄与契约统一：实施交付

日期：2026-09-10。基线：`7045c1b`。本交付记录的是先前在本地离线 mock 和全量回归上完成的实现，不是只读方案；原文撰写时尚未执行真实模型。随后授权执行的真实 Python A/B 及本轮离线重评分见第 10 节，不能把两者的结论混为一谈。

## 1. P0–P5 本轮返工状态（仅离线工程闭环）

本节不宣称“P0–P5 全部完成”。本轮只对已复现的 v3 阻断项完成了代码、离线
端到端回归和发布边界收口；真实模型语义准确率、provider 兼容性、真实成本以及
全仓 formatter 基线仍需单独验证。

| 阶段 | 已落地内容 | 主要入口 |
|---|---|---|
| P0 契约冻结 | v3 字段所有权、状态真值、兼容映射、证据与版本边界 | `docs/architecture.md`、`docs/shared_contracts.md`、`docs/finding_contract_field_ownership.md` |
| P1 精简与唯一写入 | `FindingContentV3`、严格 patch/null/delete 语义、registry 的 save/revise/finish、v3 模型动作 | `src/analyzer/finding_schema.py`、`src/analyzer/finding_contract.py`、`src/analyzer/finding_delivery.py`、`src/orchestrator/tool_schemas.py` |
| P2 独立 Verifier | fresh system/session、批量 verdict、receipt、版本与相关 evidence digest 绑定；integrity 不再等价 semantic | `src/analyzer/semantic_verifier.py`、`src/orchestrator/agent_loop.py` |
| P3 有界调查与修复 | `needs_revision` 才能触发一次具体调查；最多两次只读工具调用；Verifier → Reviewer 定向 patch → integrity 重验 → 独立 semantic 重审只允许一轮且受报告级预算约束 | `src/orchestrator/agent_loop.py`、`src/analyzer/semantic_verifier.py` |
| P4 下游迁移 | CLI/API/artifact/GitHub/journal/summary/telemetry 使用 v3 public payload；历史 v2 适配器保留但不能绕过 v3 semantic gate | `cli.py`、`src/api/app.py`、`src/platform/artifacts.py`、`src/integrations/`、`src/analyzer/run_summary.py` |
| P5 清理与验收 | v3 去除 confidence/文本形式代理/旧 draft 仪式；集中式离线交付组覆盖 action、Verifier、repair、receipt、预算和 Publisher 门 | `tests/test_harness_slimming_v3.py`、本文件与关联契约文档 |

v3 真实 review action 的模型可见链路为：

```text
save_finding(body)
  -> runtime returns opaque handle + mechanical gaps
revise_finding(handle, patch)  # optional; runtime binds the current version
  -> same CandidateRegistry content/version
finish_review(summary)                       # no finding body
  -> registry-owned set -> integrity -> independent semantic verifier
  -> needs_revision: one Reviewer patch -> integrity -> independent recheck
  -> report_ready only with runtime-bound receipts
```

`repair_review` 只在兜底事务开放，使用相同的 v3 patch semantics；模型只接触
opaque handle，事务的基础版本由 runtime 持有和校验。旧 v2 的
`submit_review`/legacy repair 仅由 `FINDING_CONTRACT_VERSION=2.0` 兼容路径使用。

## 2. 字段所有权对照

| 类别 | 字段/对象 | 处理 |
|---|---|---|
| 保留为模型必填 | `anchor`、`description`、`evidence_refs`、`severity` | v3 `ModelFindingInputV3`；模型只选择已送达的 evidence id |
| 保留为模型可选 | `suggestion`、`related_locations` | 省略表示保留；删除必须用白名单 `delete_fields`，不能用 null |
| 合并 | `observed_behavior`、`causal_mechanism`、`violated_invariant`、`trigger`、`impact` | 合并为一段 `description`；runtime 不把 description 伪造回五段文字 |
| 合并 | `cause/contract/trigger/impact` support 与四类 evidence 数组 | 合并为 `evidence_refs` + immutable `EvidenceLedger`；不复制四套权威 evidence |
| 程序生成 | `candidate_id`、`finding_id`、opaque handle、content version | CandidateRegistry 生成、保存、版本检查；模型不能指定或猜测 |
| 程序绑定 | snapshot、revision、path/range、artifact/hash、evidence provenance、相关 evidence digest | 只从本次实际送达 ledger 解析；未知/未送达/过期引用 fail closed |
| 程序记录 | semantic receipt、candidate disposition、processing complete、`report_ready`、external publish status | 分开记录，不把 integrity verified 改名成 semantic accepted |
| v3 模型删除 | `confidence`、五段 narrative、role statements、`repair_intent`、candidate/version/provenance、snapshot/hash | 不出现在 v3 模型 schema；公共 v3 payload 也不填假值 |
| v3 主路径删除 | `record_draft_finding -> update -> validate full report -> submit full report` 的强制仪式 | v3 使用 save/revise/finish；草稿和 v2 recovery 仍只服务兼容/崩溃恢复 |

兼容 `ReviewIssue` 仍有旧字段，这是下游物化外壳而不是第二份可变权威。v3
`contract_payload()` 会显式过滤这些兼容字段。

## 3. 状态真值表

| 状态 | 事实含义 | 能否单独发布 |
|---|---|---|
| processing complete | 本轮 reviewer/integrity 工作已结束 | 不能 |
| candidate disposition | 每个候选为 accept/reject/needs_revision/unresolved | 不能 |
| report ready | 必需 integrity 与 semantic receipt 均完成 | 仅表示内部报告就绪 |
| external publish status | adapter 的 not_requested/ready/published/failed | 只有 `published` 表示外部成功 |

语义模型错误、缺 verdict、超时、预算耗尽均转为 `unresolved`，不会降级为
guard-only 发布。severity correction 会转成 `needs_revision`，不能静默接受旧
content version。

## 4. 负担与重复的可复现指标

测量方法：当前代码导出的 JSON schema 使用紧凑 `json.dumps`；prompt 取
`review_system_prompt("graph_hybrid", contract_version=...)`；内部字段数取
`ReviewIssue.model_fields`。结果如下：

| 指标 | v2/旧边界 | v3/新边界 | 变化 |
|---|---:|---:|---:|
| model submit tool schema bytes | 3715 | 2464 | -33.7% |
| finding item properties | 13 | 6 | -53.8% |
| repair tool schema bytes | 4820 | 2435 | -49.5% |
| graph-hybrid system prompt chars | 8543 | 914 | -89.3% |
| `ReviewIssue` internal compatibility fields | 37 | 37 | 不变，避免破坏旧消费者 |

v3 的三个 action schema 合计 3665 bytes；这个数字不能与单个 v2/v3 submit
envelope 直接比较，因为它包含 save、revise、finish 三个职责。它带来的主要
收益是传输次数与职责边界：初次 `save_finding` 传一次正文，`revise_finding`
只传 patch，`finish_review` 传 0 个 finding body，v3 repair 也只传 patch。
旧 v2 的普通 submit 和 submit-only recovery 都可能再次传完整 report，legacy
repair 还携带完整兼容 issue；因此 v3 成功路径的 finish 阶段全文重复次数为
0，而旧路径至少有一次完整 submit、在 recovery/repair 场景可能再次重复。

## 5. 清理清单

- v3 policy 不再用 confidence 阈值、反引号/代码块 specificity、risk keyword
  代理或五段/四 role 完整性作为语义放行条件。
- v3 real agent tool list 不暴露旧 draft/whole-report preflight ritual；v2
  replay 和 crash recovery 保留在明确兼容边界。
- semantic verifier 与 integrity guard 分成独立计数、receipt、状态和发布门；
  v3 实际 Publisher 在任何外部 client 方法前校验 runtime approval binding，
  没有由缺省布尔标记提供的 verifier bypass。
- receipt 绑定最终实际序列化请求的 input digest、request hash、provider response
  digest、provider request id、内容版本和相关 evidence digest；调查新增来源会进入
  重审/repair 可见材料。新增无关 ledger entry 不会误伤其他 candidate，相关来源、
  版本或已批准正文改变会使 receipt 失效。
- old matcher 与 gold/threshold 未修改；历史 journal 的 integrity 事实不回放成
  semantic accepted。

## 6. 验收与兼容

实际执行结果（原交付阶段）：

- `tests/test_harness_slimming_v3.py`：46 passed。
- 受影响 registry/repair/provider/publisher/artifact 集合：165 passed。
- 全量 `pytest -q`：1015 passed、1 skipped、3 warnings。
- `ruff check .`：通过。
- `python -m mypy src`：通过（94 source files）。
- `python -m compileall -q src cli.py tests`：通过。
- `git diff --check`：通过；仅有 Git 的 LF/CRLF 提示。
- `ruff format --check`：全仓和本轮触及文件集合仍报告既有格式/换行基线，
  全仓报告 155 个、触及集合报告 6 个文件需要重排；本轮没有机械重排，避免混入
  无关 diff。

原交付阶段测试只使用离线脚本模型与不会联网的假 Publisher client；当时未调用真实模型或外部
平台。受影响集合首轮曾因宿主 Git signing 配置失败 1 项，随后仅在测试进程注入
`commit.gpgSign=false` 与 `safe.directory` 后重跑通过；没有修改全局 Git 配置。

formatter 基线是本交付明确保留的未完成项；宿主正常运行仍可能受到其 Git
signing 配置影响。

回滚方式：保持默认 `FINDING_CONTRACT_VERSION=2.0`，或显式设置该值回到 `2.0`；
回滚不需要迁移 journal。切换到 v3 只需显式设置 `FINDING_CONTRACT_VERSION=3.0`，
仍需保证新 API/GitHub 消费者读取 v3 `contract_payload()`。

## 7. 原交付时的真实模型与未完成项

原交付阶段没有运行真实模型或付费 provider：当时用户请求只授权本地实施和离线验证，
没有授权新的模型额度。mock verifier 证明了独立会话、批处理、拒绝、未决、调查上限、
版本绑定和不可绕过的状态路由，但不能证明真实模型的因果准确率、延迟、token
成本或 provider tool-call 兼容性。

真实 A/B 产物已在后续授权运行中保存并于第 10 节完成离线重评分；仍尚需另行验证
真实模型的因果准确率、固定 provider/model/参数下的稳定性、实际成本以及外部
GitHub/API 客户端兼容，再决定是否把默认迁移值从 v2 切到 v3。不能用离线重评分
冒充真实语义质量结论。

## 8. 最终问题回答

1. 模型负担减少在字段从 13 个 finding properties 收敛到 6 个、prompt 从 8543
   字符收敛到 914、四类 evidence/五段 narrative 合并，以及 finish/repair 不再
   重复全文。
2. 独立 semantic verifier 已真实存在：独立模块、独立 system/fresh conversation、
   独立 receipt；v3 实际 Publisher 的 runtime approval binding 要求它完成，
   guard-only 或缺省标记不能发布。
3. 只有 `needs_revision` 给出具体问题才调查；一次 round、最多两次 readonly
   tool call，获得足够信息立即停止；无疑问为 0 次。
4. save/revise/repair 都在 CandidateRegistry 的同一内容版本上运行；revise/repair
   使用 opaque handle 与 runtime 事务绑定版本，过期版本原子拒绝，模型不再搬运
   `candidate_content_version`，semantic receipt 绑定版本和相关 evidence digest。
5. v3 移除了 confidence/文本形式/旧 role completeness 等判断；来源真实性、快照、
   版本、权限、预算由 integrity/runtime，因果真实性由独立 semantic verifier，
   changed-line/inlining 资格由 publisher 承担。
6. CLI、API、artifact、GitHub adapter/publisher、journal、summary 和 telemetry
   已同步；旧 v2 通过显式适配兼容，不可绕过 v3 门禁。v3 发布前还要核对正文、
   位置、来源、严重性、证据上下文和 provider receipt 的 runtime 绑定。
7. 离线测试证明契约、版本、来源、调查边界、状态和下游投影；真实模型准确率、
   provider 行为、token/延迟以及全仓 formatter 基线仍未验证/未清理。

## 9. 逐项交付表

| 问题 | 根因 | 修复位置 | 新增回归 | 实际测试结果 | 剩余风险 |
|---|---|---|---|---|---|
| 1. 重复 save 后新 finding 覆盖旧候选 | v3 save 复用了 source index 更新语义，去重后索引与候选数量脱钩 | `src/analyzer/finding_delivery.py`、`src/orchestrator/agent_loop.py` | A→A→B、同批/跨批重复、失败后新增、顺序变化、响应重放 | v3 集成组通过；registry 保留 A/B 且 handle/version 独立 | legacy `register_issue` 仍服务 v2/recovery，不能作为 v3 路由入口 |
| 2. 重审错误 handle 被绑定 | 重审直接取结果首项，未按预期 handle 做严格关联 | `src/analyzer/semantic_verifier.py` | 错 handle、混合 handle、重复冲突、缺 verdict、多工具调用、顺序变化 | 相关 fail-closed 回归通过，错误关联不生成 accept | 未做真实 provider 畸形输出分布验证 |
| 3. 发布门可被缺省标记绕过 | Publisher 只看 `semantic_verifier_required` 与 `report_ready`，未校验 runtime 批准材料 | `src/integrations/github_publisher.py` | 实际 `publish()` 假客户端覆盖未验证、缺 receipt、正文/位置/来源/严重性篡改、合法发布、dry-run | 真实 Publisher 回归通过；阻断发生在任何外部 client 方法前 | 未联网验证真实 GitHub API；dry-run 只计划不宣称发布 |
| 4. Verifier→repair→重审未闭环 | needs_revision 只落 incomplete，未进入一次定向 Reviewer patch 与独立重审 | `src/orchestrator/agent_loop.py`、`src/analyzer/semantic_verifier.py` | 实际 `run_review()` 脚本化 Reviewer/Verifier/repair/recheck；severity correction、reject、partial/unresolved | stage 为 reviewer→verify→repair→recheck；46 项 v3 组及全量回归通过 | 真实模型修复质量与 provider 行为未验证；预算不足/修复失败按 unresolved 停止 |
| 5. Verifier 内部消耗不受报告预算控制 | 仅阶段入口记账，批次/调查/重审之间未共享剩余额度与 timeout；输入成本未纳入下一次请求前置判断 | `src/analyzer/semantic_verifier.py`、`src/orchestrator/agent_loop.py` | 可控 usage/时钟、批次耗尽、调查后不重审、请求上限、慢调用、provider attempts 对账；输入成本超过剩余额度时零 provider 调用；输出上限扣除已组装输入 | 预算回归通过；logical call 与 provider attempt 分开统计；发送请求满足 `estimated_input + max_tokens <= remaining_total` | provider 未上报 usage 时只能按请求输入保守计数，真实成本仍未测 |
| 6. Receipt 未绑定最终实际输入 | receipt 继续引用初始 digest，调查来源与重审 payload 未进入同一绑定 | `src/analyzer/semantic_verifier.py`、`src/orchestrator/agent_loop.py`、`src/orchestrator/run_journal.py` | 首轮/调查后实际 input digest、证据变化、无关来源、journal request/receipt 对账 | receipt 含 input/request/response/provider/evidence 绑定；全量通过 | journal 只保存可回放摘要，不保存原始敏感 prompt 或隐藏推理 |
| 7. v3 revise 要求模型搬运版本 | v3 action 与历史 repair schema 混用 `base_version`/`candidate_content_version` | `src/analyzer/finding_contract.py`、`src/orchestrator/tool_schemas.py`、`docs/shared_contracts.md` | schema 无 content version、opaque handle 旧版本拒绝、patch/null/delete | v3 schema 与 registry 回归通过；v2 兼容字段仍隔离保留 | legacy v2 repair 仍会看到版本字段，这是明确兼容边界 |
| 8. 调查器依赖自然语言正则 | 只从问题文本提取 path:line，缺失时静默回到 anchor | `src/analyzer/semantic_verifier.py`、`src/orchestrator/agent_loop.py` | 实际调查适配器走显式只读 action；无定位信息返回 unresolved；零调用/最多两次边界 | investigation adapter 与全量回归通过 | 没有足够路径/符号/range 时仍需 unresolved 或上游补充明确 action |

## 10. 真实 A/B 事实核验与离线重评分（本轮返工）

本节对应同一组已经保存的真实 provider 运行；本轮没有再次请求模型，也没有连接外部
发布端。原始运行 ID、raw、checkpoint、journal 和 event log 均只读使用，重评分结果另存为
带版本的 [offline-rescore-v1 产物](../eval/experiments/finding-delivery-python-ab-20260910-v3-offline-rescore-v1.json)。

### 10.1 “全部未交付”结论的更正

旧评估器的 `_effective_review_issues()` 把 v3 `ReviewIssue` 的兼容外壳当成 v2
finding 处理：v3 合法 finding 的 `confidence` 默认是 `0.0`，旧 `evidence` 文本为空，
因此在 `_match_issues_v3()` 之前被过滤。它没有读取 runtime 已完成的 integrity、独立
semantic receipt、内容版本和相关 evidence digest。新的评分适配边界只接受 runtime 已绑定
的最终 finding，再交给独立 gold matcher；不回填 confidence、不拼接 evidence，也不把
semantic accept 直接当作 gold 命中。

| 运行 | 原报告 finding 数 | 原 `actual_count` | 重评分有效数 | semantic accept | 内部最终集合 | delivery complete | external 状态 | gold matched |
|---|---:|---:|---:|---:|---:|---|---|---:|
| Pydantic A | 2 | 0 | 2 | 2 | 2 | true | ready（未发布） | 0 |
| Pydantic B2 | 2 | 0 | 2 | 2 | 2 | true | ready（未发布） | 0 |
| Haystack A | 0 | 0 | 0 | 0 | 0 | false | not_requested | 0 |
| Haystack B2 | 3 | 0 | 3 | 3 | 3 | true | ready（未发布） | 0 |

`natural_model_stop` 只表示 reviewer 的停止原因，不代表没有 finding；`ready` 只表示
内部发布门已经具备条件，也不代表外部客户端被调用或发布成功。三条运行的最终 finding
仍然没有命中本次 fixture 的 gold 位置/严重性匹配；这与“有无最终 finding”是两个独立指标。

### 10.2 Finding contract、matcher 与评分输入

重评分显式记录了 `finding_contract_version=3.0`、`matcher_version=semantic-v3` 和
`adapter_version=v3-runtime-boundary-v1`，不因名称都含 v3 就默认兼容。四条运行统一使用
同一适配器和同一 gold matcher。缺失 receipt、旧内容版本、相关 evidence digest 改变、
semantic unresolved 或 delivery 未完成都会被标成不可评分；新增无关 ledger 来源不会改变
相关候选的 digest。历史 v2 与冻结 matcher 测试未切换到该适配器。

Pydantic 两次运行的 finding 在自动结构检查中出现同文件且行区间重叠，Haystack B2 的
三个 finding 在同一文件、相邻范围且共享部分 evidence 引用；这些只是可审计的 overlap
signal，不自动断言“同一根因”或“真实误报”。重评分产物对每条 finding 记录了纳入/排除
原因、location、evidence refs、内容版本与 receipt 的 digest/id/attempt 摘要。

### 10.3 Token 口径核对

历史 `EvalResult.total_tokens` 只汇总了 reviewer 的 provider attempt；`phase_end` 的
`successful_total_tokens` 才包含 reviewer 加 independent verifier。本轮没有把 warm
priming 混入 measured run，也没有价格依据，因此只报告 token：

| 运行 | reviewer 成功 tokens | verifier tokens | measured 成功总 tokens | 组件和是否对账 | warm priming |
|---|---:|---:|---:|---|---|
| Pydantic A | 28196 | 4224 | 32420 | yes | 不适用 |
| Pydantic B2 | 35870 | 9388 | 45258 | yes | 20.004s，token 未记录 |
| Haystack A | 27943 | 5066 | 33009 | yes | 不适用 |
| Haystack B2 | 36076 | 16566 | 52642 | yes | 36.602s，token 未记录 |

逻辑模型调用与 provider attempt 分开记录：四条历史运行各有 3 次 reviewer logical
`analyze`、1 次 verifier logical call，phase-end attempt 数为 4；Haystack A 的旧 journal
没有保存 verifier provider request id，因此其 verifier attempt identity 仍为 unknown，不能
伪造为 1。失败 attempt 或未知 usage 保持单独统计，不记为零。新的 run summary 同时保存
reviewer/verifier stage token 字段；请求/响应诊断不保存隐藏推理。

### 10.4 Haystack A malformed decision 诊断边界

离线回放能确定的只有：verifier 对 opaque handle
`vh_3cc41e9f52354fd8894d` 产生了 `semantic_verifier_malformed_decision`，随后安全转为
unresolved，未生成 accept receipt，流程以 `semantic_verifier_unresolved` 停止。历史
journal 没有保存 semantic provider 的原始 response body、request hash、response digest、
provider request id 或 attempt 关联，因此无法从现有证据恢复“具体是哪一个字段/哪一条
schema 约束”失败；本报告不猜测字段。运行时现已把这些安全摘要字段沿 malformed 路径
传递到 receipt/journal，后续运行可定位错误但不会记录隐藏推理或敏感源码。

### 10.5 本轮验证边界

本轮证明了评分输入、指标映射、runtime receipt 绑定、历史产物可重复重评分和 malformed
诊断证据边界；没有重新验证真实模型的因果准确率、provider 兼容性、实际成本，也没有把
未命中 gold 自动宣称为真实误报。聚焦集合为 101 passed；全量 pytest 在仅当前进程
禁用宿主 Git signing 后为 1021 passed、1 skipped、3 warnings；ruff check、mypy src、
compileall 和 diff check 通过；formatter check 仍是 10 个本轮触及文件的既有基线，
未做机械重排。v3 仍保持非默认、非正式外部发布状态；真实发布和真实语义质量需要
另行授权与独立实验。
