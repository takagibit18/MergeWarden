# MergeWarden Harness v3 全链路版本兼容矩阵

日期：2026-09-10

后续更新：本矩阵的“Graph A/B pilot v2-only”记录已由 `docs/finding-delivery-python-three-v3-20260910.md` 所述小范围适配取代。pilot 现支持兼容 matcher 下的 v3 review 配对生命周期，仍拒绝不兼容 matcher 和 v3 debug；生产 root-cause consolidation 的 v3 隔离不变。
范围：版本传播、数据适配、消费语义、验收覆盖。未调用真实模型、付费 provider 或真实发布接口；没有修改原始 finding、gold、receipt、.env 或全局 Git 配置。Harness v3 仍保持非默认状态。

## 先固定各版本轴

| 轴 | 实际事实源 | 本轮含义 | 不允许的替代 |
|---|---|---|---|
| Finding contract | src.config.Settings.finding_contract_version、ReviewReport.schema_version、FindingContentV3 | 1.0/2.0 是历史报告外壳；3.0 是 slim finding：anchor、description、evidence_refs、severity、可选 suggestion/related_locations | 不用字段形状、是否有 anchor 或 issue 数量推断版本；不把 v3 填回五段 narrative |
| Matcher | eval.schemas.EVAL_MATCHER_CONTRACT_COMPATIBILITY | semantic-v2、semantic-v3 保留历史语义；semantic-v4 只支持 v2；semantic-v3-content-v1 是 v3 的新评分适配器 | 数字相同不代表兼容；不把历史 semantic-v3 改名冒充新 v3 语义 |
| Runtime approval | CandidateRegistry、integrity 版本、独立 semantic verifier receipt | 决定 finding 能否进入“已批准可评分/可发布”集合 | gold、位置重叠、description 相似度都不能替代批准 |
| Verifier policy / receipt | AgentOrchestrator._run_semantic_verifier、CandidateRegistry.record_semantic_receipt | 记录 candidate_id、内容版本、evidence digest、输入/请求/响应/provider attempt 绑定和 verdict | 不拼接多个旧 accept receipt；receipt 缺失或过期不补造 |
| Public payload | ReviewResponse.contract_payload()、ReviewReport.contract_payload() | 可显示、可重新导入的 slim v3 载荷，不含 runtime 私有身份和批准材料 | public payload 不能反向变成“已批准” |
| Audit / evaluation payload | model_dump()、EvalResult.raw_output、离线 rescore JSON | 用于审计、重验证、评估适配；可比 public payload 携带更多内部事实 | 不要求模型携带 runtime 版本；不把评估适配写回生产 finding |
| Journal / summary | finding funnel、RunSummary、ReviewProcessMetrics | 记录实际运行版本、状态、usage 和未知证据 | natural stop 不等于零 finding；ready 不等于 external publish 成功 |

## 边界矩阵

每行同时记录生产者、消费者、版本来源、字段、转换约束、空/缺/未知/混合行为，以及验证结论。

| 边界：生产者 → 消费者/入口 | 版本来源与消费字段 | 转换与禁止降级 | 空、缺失、未知、混合行为 | 代码与测试证据 / 结论 |
|---|---|---|---|---|
| 配置 → CLI/API/AgentOrchestrator | src/config.py 的 FINDING_CONTRACT_VERSION，默认仍为 2.0；eval.runner.run_single 读取 matcher 与该配置。 | 运行版本只从 settings/context 传递；AgentOrchestrator.format_result 把它显式传给 ResultProcessor。v3 必须显式选用 v3 matcher。 | settings 的未知值由类型校验拒绝；新运行的 contract/matcher 不兼容在工作区和 provider 调用前拒绝；空报告仍用显式 report envelope。 | src/config.py、eval/runner.py::run_single、src/orchestrator/agent_loop.py::format_result；test_v3_compatibility_regressions.py 的 matcher/版本回归。**已修复**。 |
| Prompt/tool schema → parser | src/analyzer/prompts.py::build_v3_finding_action_tool_schemas、InferenceEngine._submit_tool_name、_parse_tool_calls。v3 消费 save_finding/revise_finding/finish_review。 | v3 不接受 legacy submit_review；不会因为它失败再启动 v2 submit repair 或 JSON fallback。v2 继续使用旧 submit 工具。 | v3 finish_review 可产生零 finding 的 schema_version=3.0 报告；错误工具、错误参数、缺少版本都保留显式诊断。 | src/analyzer/inference_engine.py；测试覆盖 v3 submit_review 被拒且无 fallback。**已修复**。 |
| Parser → normalized report | InferenceEngine._normalize_review_payload、_normalize_structured_report、normalize_model_finding_v3_payload。 | 声明的 schema_version 必须等于 active contract；只做 evidence catalog 解析和 anchor/location 的已声明适配，不用 shape inference，不伪造旧字段。 | 显式未知 report schema、v2/v3 混合 issue、声明与上下文冲突均失败；历史 v1/v2 仍按原 matcher 回放。 | src/analyzer/output_formatter.py::ReviewReport._validate_contract_envelope、src/analyzer/inference_engine.py；test_unknown_report_version...、test_mixed_finding_contracts...。**已修复**。 |
| Parser → CandidateRegistry → integrity | CandidateRegistry.save_finding/commit_verified_version/snapshot、FindingIntegrityGuard，以及评估侧复用的 eval.runner._v3_eval_eligibility。 | v3 只消费 candidate_id、当前内容版本、anchor/description/evidence_refs/severity/suggestion/related_locations 和 evidence ledger；批准还需 integrity 版本与 digest 一致。 | 缺 candidate、重复注册、过期/改变内容、missing/changed evidence、非 verified/published、缺或多 receipt 均不进入 approved 集合。空 v3 只有在没有 candidate 且生命周期完成时才是正常空报告。 | src/analyzer/finding_delivery.py、src/analyzer/finding_integrity.py、eval/runner.py；v3 eligibility/receipt/evidence 失效测试。**已正确兼容**。 |
| CandidateRegistry → semantic Verifier/receipt | AgentOrchestrator._run_semantic_verifier 产生 receipt，registry 绑定 receipt；发布和评估重新检查绑定。 | receipt 是最终批准必要条件，但不是 gold 命中。匹配器只在这个边界之后工作。 | accept + completed 之外的 verdict、输入/请求/响应/provider attempt 或 evidence digest 缺失，都是未批准；相同内容版本多个 receipt 明确 ambiguous。 | src/integrations/github_publisher.py::validate_v3_publish_binding、eval.runner._v3_eval_eligibility；receipt ambiguity、过期和 evidence 变化回归。**已修复/保持独立**。 |
| revise/repair → final candidate | AgentOrchestrator._apply_v3_repair_patch、_merge_repaired_report、repair transaction。 | v3 repair 只允许 patch schema 的 v3 字段；正文、anchor、severity、evidence refs、suggestion 或 related locations 改变会形成新内容版本并重新走 integrity/verifier。 | 未改变内容是 no-progress；非法 patch 被拒，原 finding 不伪造为新批准。旧 v2 repair 仍走旧路径。 | src/orchestrator/agent_loop.py；现有 v3 repair/replay 回归。**已正确兼容**。 |
| Root-cause consolidation → report | RootCauseConsolidator.consolidate；其 _merge_members 仍生成 v2 schema。 | v2 合并逻辑保留；v3 不进入会制造 v2 shape、改正文/证据的合并路径。 | 含 v3 risk finding 时返回原报告深拷贝，写入 v3_root_cause_consolidation_unsupported 隔离拒绝；不会拼接旧 accept receipt。v3 info passthrough 不改变内容。 | src/analyzer/root_cause.py；test_v3_root_cause_merge_is_explicitly_isolated。**已隔离**，本轮不扩展新去重工作流。 |
| Final report → formatter/merge | ResultProcessor.format_review、merge_review_reports、AgentOrchestrator.format_result。 | report envelope 是唯一版本源；v3 merge key 包含 runtime identity 和完整 v3 public content，不再用 legacy 的 severity/location/suggestion 静默吞掉不同 description/evidence。 | 空 v3 仍为 schema_version=3.0；v2/v3 merge、issue 混合、报告版本冲突明确失败。 | src/analyzer/result_processor.py、src/analyzer/output_formatter.py；test_v3_result_merge_does_not_deduplicate_through_legacy_fields。**已修复**。 |
| Final response → CLI/API/artifact | cli.py、src/api/app.py::review、ArtifactStore._jsonable。 | v3 使用 ReviewResponse.contract_payload()：保留 schema、description、anchor、related locations、suggestion、evidence refs；内部 model_dump() 仍保留审计/重验证事实。 | public payload 可显示和重新导入，但缺 candidate registry/ledger/receipt，导入后不能成为 approved；未知/混合 report 不被降级。v2 输出保持历史形态。 | src/analyzer/schemas.py::ReviewResponse.contract_payload、src/platform/artifacts.py；test_public_v3_payload_is_reimportable_but_not_approval_bound。**已修复**。 |
| Final response → GitHub adapter/publisher | github_adapter.build_github_advisory_payload 展示 description/evidence_refs 的 v3 分支；GitHubPublisher.publish 在非 dry-run 前调用 validate_v3_publish_binding。 | v3 展示分支保留；dry-run 只生成本地计划，ready 不被改写为 published。真实发布仍需 receipt、内容版本和 evidence digest。 | 空 v3 需 complete、delivery_complete、report_ready 才可被判为 ready；缺批准不能进真实发布；legacy v2 分支保留。 | src/integrations/github_adapter.py、src/integrations/github_publisher.py；现有 GitHub v3/legacy dry-run 回归及空报告测试。**已修复/正确兼容**。 |
| Funnel/journal → summary/status/cost | AgentOrchestrator._record_finding_funnel、src.analyzer.run_summary.RunSummary、eval.run_summary.extract_review_process_metrics、ReviewProcessMetrics。 | 版本从 finding funnel/response 的实际运行字段取；Reviewer、Verifier、调查、repair、provider attempt 分开计数。缺 usage 保持 unknown。 | report_ready、delivery_complete、external_publish_status 各自保留；natural stop 由 termination reason 表示，不由 finding 数量推断；malformed 历史证据不足不补造。 | src/analyzer/run_summary.py、eval/run_summary.py、四条 journal/event log；离线报告 token/accounting 和 Haystack A 诊断。**已修复/历史限制明确**。 |
| Main eval entry → matcher | eval.runner.run_single/run_suite 先用 settings 做兼容预检，再在解析后用明确 report schema 二次校验。 | semantic-v2/历史 semantic-v3 的旧语义保持冻结；semantic-v3-content-v1 只消费 v3 自有内容。 | semantic-v4 + 3.0、历史 matcher + 3.0 等不支持组合启动前拒绝；混合 report 不评分；gold 只进入评分，不进入 registry/verifier/effective selection。 | eval/schemas.py::validate_eval_matcher_contract、eval/runner.py::_match_issues_for_version；首轮错配回归和新 content matcher 回归。**已修复**。 |
| New v3 matcher → dimensions | eval.runner._match_issues_v3_content、_v3_content_dimensions。 | 逐维消费 location（anchor/related locations）、severity floor、description/suggestion semantic、repair suggestion、affected paths、evidence refs；一对一分配。`semantic-v3-content-v1-conservative-v3` 只把去除首尾空白并统一换行后的完整文本相等作为正向证明。 | 不同文本一律 undetermined；不做极性、动作方向、词项序列或主题启发式判断；不以位置重叠即命中。简单候选排序若存在也不影响 matched/undetermined 或可靠 duplicate。 | EvalIssueMatch.role_match_diagnostics、EvalResult 新维度字段；严格版逐维产物见新增 `finding-delivery-python-ab-20260910-v3-offline-rescore-v4.json`。**已修复并版本化**。 |
| Eval result → Core Eval | eval.core_eval.match_review_findings 保留 v2 _extract_generated_findings；v3 用 CORE_V3_MATCHER_VERSION，要求完整 ReviewResponse、report_ready、delivery_complete 和 runtime approval。 | v3 Core 只读 description/suggestion，不读 confidence/旧 narrative；v3 public slim payload 可显示但不可独立评分。 | raw dict 有 v3 issue 但无显式 report schema 直接拒绝；Core report 的 runs 混合 2.0/3.0 或 explicit/unknown 拒绝；图 A/B pilot 明确 v2-only。 | eval/core_eval.py、eval/graph_ab_pilot.py；Core 历史测试和 v3 approval/description 回归。**已修复/图 pilot 明确不支持 v3**。 |
| Raw experiment → offline rescore | eval.offline_rescore.rescore_experiment 读取原始 final response、runtime registration/receipt、journal 和 event log；新 adapter 为 v3-runtime-boundary-v1，评分为 semantic-v3-content-v1。 | 只做带来源的评估适配；不写回 finding、receipt 或原始产物。source matcher 与 scoring matcher 分开记录。`offline-rescore-v2`、`offline-rescore-v3` 均保留历史冻结结果；严格版使用 `offline-rescore-v4` 新文件。 | report 不是 3.0、记录不完整或 fixture 缺失会失败/列出 missing；Haystack A 保留 historical_evidence_insufficient_for_field_level_diagnosis。只有共享 evidence 且完整位置/范围、正文、建议、severity 等关键字段严格一致才计 duplicate；其余共享证据关系单列 candidate pair。重复执行输出相同。 | eval/offline_rescore.py、历史 `finding-delivery-python-ab-20260910-v3-offline-rescore-v2.json`/`...-v3.json`、新增 `finding-delivery-python-ab-20260910-v3-offline-rescore-v4.json`；test_offline_rescore.py。**已修复/可追溯**。 |
| Eval result → suite report/summary | eval.metrics.build_eval_report、EvalReport、EvalRunSummaryReport。 | report 同时携带 matcher 和 finding contract；MetricSummary 聚合 approved、severity、semantic-undetermined、duplicate 等字段。 | matcher 或 contract 混合、explicit 与 unknown 混合不能生成伪 mixed report；没有版本证据则保留 unknown，不伪称 v2/v3。 | eval/metrics.py、eval/schemas.py、eval/run_summary.py；test_eval_report_builder_rejects_mixed_contracts_and_matchers。**已修复**。 |

## P0 错配的修正口径

旧的 eval.runner._issue_matches_expected_location_v3 在位置检查后仍比较 mechanism_pattern/invariant_pattern 与 causal_mechanism/violated_invariant。v3 这些兼容字段为空，所以七条真实 finding 的旧语义失败不能被归因为位置/严重性失败；_v4_root_cause_matches 也不能作为 v3 修复。

本轮保留上述历史 matcher 的可复现路径，并新增明确声明的 `semantic-v3-content-v1` 保守评分规则 `semantic-v3-content-v1-conservative-v3`。新的匹配结果按以下顺序解释：

1. approved_finding_count：是否通过运行时批准绑定；不看 gold。
2. location_matched_count：anchor、primary anchor 或 related location 是否满足 gold 位置。
3. severity_matched_count：severity 是否达到 gold floor。
4. root_cause_matched_count / semantic_status：只比较 gold 评分适配与 v3 description；仅去除首尾空白、统一换行后的完整文本相等才给正向证明，不同文本保持 undetermined。
5. repair_unit_matched_count：只比较 v3 suggestion 与 gold repair unit；同样只接受边界规范化后的完整文本相等，不凭词汇推断相反修复。
6. matched_count：以上必需维度完整满足后的 gold 一对一命中；不是位置重叠计数。
7. duplicate_actual_count：同一运行内只有在共享非空 evidence refs 且完整位置/范围（含适用的 related locations）、description、suggestion、severity 等关键字段严格一致时才计重复；不确定关系单列 candidate pair，独立于 recall，不删除 finding。

因此，“位置/严重性失败”的旧诊断已修正为逐维事实；Pydantic 的未知键丢失不足以证明与 gold 的私有键重新分类属于同一 semantic，保守保持 undetermined，而不是位置重叠命中。自动未判定不等于真实漏检或误报。

## 四条固定真实产物的离线结果

输入固定为现有 raw.json、summary.json、checkpoint.jsonl、四份 journal/event log 和现有 fixtures。下表中的 A/B2 由 variant_id 区分；未修改任何输入。

| 运行 | raw finding | runtime approved | matched | location | severity | semantic/root | repair | semantic undetermined | duplicate | duplicate candidates | status / ready / external |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Pydantic A (A-agent-search) | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 1 | 0 | 1 | complete / true / ready |
| Pydantic B2 (B2-graph-hybrid-warm) | 2 | 2 | 0 | 1 | 1 | 0 | 0 | 1 | 0 | 1 | complete / true / ready |
| Haystack B2 (B2-graph-hybrid-warm) | 3 | 3 | 0 | 1 | 1 | 0 | 0 | 1 | 0 | 3 | complete / true / ready |
| Haystack A (A-agent-search) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | incomplete / false / not_requested |

解释：

- Pydantic 两个 approved finding 位于同一根问题相关区域，但 v3 description 是“未知键丢失”，gold 是“私有属性重新分类”；保守规则没有足够正文证据，因此 semantic 为 undetermined，不强行维持旧分数。位置和严重性各自通过，不能折叠成“位置失败”，也不能位置重叠即命中。
- Pydantic A/B2 的共享 evidence 关系均不满足完整严格 fingerprint，只列候选（各 1），不计 duplicate；Haystack B2 的 3 对共享 evidence 关系同样全部列 candidate，不自动计 duplicate。
- Haystack A 的历史记录能证明 malformed verifier decision 和 unresolved；没有原始 verifier response/request 绑定，字段级原因不可恢复，保持 unknown/证据不足。
- 三条已完成内部交付的 external 状态都是 ready 而非 published；本轮没有调用发布接口。

## 已修、已隔离、不支持、未验证

### 已修复

- 主评估和 core_eval 不再让旧 narrative 静默支配 v3；版本/匹配器在入口声明并校验。
- v3 parser 不再接受 submit_review 后回退 v2；report envelope、空报告、混合报告和 public payload 版本可追踪。
- 评估 eligibility 复用 runtime approval boundary，匹配结果逐维输出；位置/严重性/semantic/repair/duplicate 分开。
- result merge、API、CLI、artifact、GitHub dry-run/publish preflight 和 summary 都以明确 report version 消费 v3。
- repair 内容变化和 evidence 变化继续要求重新绑定；receipt ambiguity 不再取“最后一条”。

### 已隔离

- v3 risk finding 的 root-cause consolidation 显式返回 unsupported，不进入 v2 merge schema。
- Core Eval v3 需要完整 runtime response；public slim payload 只可显示，不可当批准证据。
- Graph A/B pilot 保持既有 v2 研究边界，v3 组合入口显式拒绝；本轮不扩展 Graph。

### 明确不支持

- semantic-v4 + finding contract 3.0。
- 历史 semantic-v2/semantic-v3 直接评分 Harness v3 slim finding。
- 缺少 runtime approval、receipt/evidence binding 或原始 malformed response 的“恢复性”评分/发布。
- 将多个旧 accept receipt 合成为一个新 finding 的批准。

### 尚未验证

- 没有重新调用真实模型，所以没有对模型准确率、provider 兼容性、实际费用或真实 external publish 成功作结论。
- v3 root-cause 合并仍待未来单独设计和验收；当前边界是安全隔离。
- 离线语义规则未覆盖的 gold 语义保持 undetermined；严格文本相等只证明文本一致，不声称通用语义能力；人工语义审计独立于自动分数，也不把自动未判定描绘成真实漏检/误报。

## 验证命令与结果

- 聚焦兼容、主评估、Core、离线重评分、Harness v3、API/CLI、v2 回放和 artifact 回归：见 tests/test_v3_compatibility_regressions.py、tests/test_offline_rescore.py 及受影响测试集合；新增保守规则成对反例回归。
- `python -m ruff check .`：通过。
- `python -m mypy src`：通过，94 个 source files；没有用未执行的“101 个旧错误”与父提交作无证据对照。
- `python -m compileall -q eval/runner.py eval/core_eval.py eval/offline_rescore.py tests/test_v3_compatibility_regressions.py tests/test_offline_rescore.py`：通过。
- git diff --check：通过；LF/CRLF warning 是仓库工作树基线，不是代码错误。
- 新增版本化离线产物 `eval/reports/finding-delivery-python-ab-20260910-v3-offline-rescore-v4.json`，保留历史 `...-v2.json` 与 `...-v3.json`；没有真实 provider 网络调用。
