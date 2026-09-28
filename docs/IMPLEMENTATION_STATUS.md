# 当前实现状态 · 2026-09-28

## 变更感知结构调查与真实 PR 评测

变更区间已绑定到 Python 声明，结构调查按声明身份维护有界导航队列，并为候选选择保留调用、继承与导入关系上下文。该能力沿用 ADR 0017 的显式评测配置；CLI 默认导航策略不变。

40 个真实 PR 的文本／Graph 配对评测已完成，包含 12 个 Python 仓库。统一语义审核后的全量 F1 为 67.8% → 77.4%；复杂依赖与跨文件审查场景的 10 例 F1 为 63.6% → 83.3%，Token 减少 18.3%。配置、审核方式、样本范围和成本口径见 [完整评测](experiments/CODE_GRAPH_EVAL.md)。

README 以 CLI 产品工作流组织使用场景、图导航、证据读取、模型访问与报告管理。以下保留各阶段的实现与验证记录。

ChangeUnit Semantic Intent Router 的 eval-only shadow 已完成到私有准入停止点，见
[实验契约](experiments/SEMANTIC_INTENT_ROUTER.md)。公开准入为 7 defect + 13 clean；
20 次独立首轮请求得到 15 个格式有效输出、5 个格式失败、0 个 provider failure。
预测冻结后，36 个合法 oracle plans 各重放两次，仅 1 个 defect structurally actionable，
低于要求的 4 个。状态为 **INCONCLUSIVE — INSUFFICIENT STRUCTURALLY ACTIONABLE ROUTE MISSES**。
未执行预测计划评分、Candidate Choice、small model、Hybrid Shadow 或 Review E2E，产品运行时不变。
最新完整验证为 478 passed / 0 failed / 0 skipped；历史 Attribution v3 与 dispatch_v2 Gate 1 包 hash 保持一致。
下一阶段仅建议 **C. EXPAND STRUCTURALLY ACTIONABLE DATASET**，本轮不自动扩展或重跑。

## dispatch_v2 工程阶段 · 2026-09-26

新增内部实验策略 `dispatch_v2`，架构见 [ADR 0017](adr/0017-progressive-structural-investigation.md)。
生产接入包括稳定 ChangeUnit/Investigation、逐 hint 精确解析、多 root 共享预算、
Gate2B 共享探索实现、CandidateCatalog、一个预取源码、主 Agent 候选展开、
缓存与独立 v2 归因。默认 advisory、dispatch_v1、历史 Attribution v3 与 ADR 0016 保持原语义。

本轮 main 基线为 PR #11 合并提交 `35c382c`：438 passed / 0 failed / 0 skipped。
最新完整 `npm run verify` 为 456 passed / 0 failed / 0 skipped。
新增真实 Pi SDK 离线 HTTP 测试覆盖展开取证、提前提交、伪造引用和展开持久化故障；
这些是工程测试，不是实际模型审查成绩。

Gate 1 的 24 个历史前缀强制末尾诊断中，V1 为 7 resolved / 14 ambiguous / 3 missing；
V2 为 15 resolved / 8 partial / 0 ambiguous / 1 missing，23 个启动 Graph、17 个交付目录。
实际确定性路由仅触发 3 个案例：V1 3 个 ambiguous，V2 2 个 resolved / 1 个 ambiguous，
2 个启动 Graph、1 个交付目录。强制末尾诊断不能冒充实际路由覆盖或 Graph 审查价值。
独立性能产物完成 24 × 100 次诊断重放及 3 × 100 次实际触发重放，包字节均稳定。
24 个诊断案例 p50 的中位数为 9.10 ms，最差单例 p95 为 44.62 ms，最大 74.08 ms；
最大包 24,503 bytes、最大队列 26，采样 heap 最大约 168.1 MiB。
延迟不含 prepared graph 加载/索引初始化，heap 是进程采样而非隔离分配量。
34 条历史 Attribution v3 会话双次重放与原存档逐字节相同，未回填历史分数。

Gate 2 在既有 full-context 数据集和预登记 D3/D4/D6 上执行公开准入：15 个登记项中
2 个重复；13 个独立项中 8 个无路由、2 个 root ambiguous、1 个候选池仅 1 项、
2 个公开条件合格。公开准入上限 2 < 6，因此未打开私有 target、未调用模型、
未运行 source-fact scoring 或 Gate 3。不能宣称候选选择或 Review 质量通过。
当前首要限制是 Router 的真实触发覆盖，另有 Investigation 同名范围歧义；
没有通过调整 selector、Graph schema 或强制路由补足样本。

新实验仅写入 checkout 外 `../output/progressive-structural-investigation-20260926/`。
首次 Windows 隔离启动失败及首次元数据超限失败均保留，修复使用新的实验目录。

## 历史状态 · 2026-09-24

当前开发基线继承本地 Routing v1 / ABC 提交 c857941、26e6535，未回退到远端 main。Routing 产品默认 none；pi_structural_v1、pi_structural_v2_investigate、pi_structural_v2_synthesize 的触发、预算与 B/C 卡措辞保持冻结。Graph v4、prepared-only、RealGolden 和模型配置未修改。

当前运行时已统一单 JSON 工具结果与 `_mergewarden` 宿主 metadata；G0/G1 共用 Attribution v3 的 model-visible provenance；普通失败提交不会全局污染后续完整 accepted evidence。每个 run 的 Evidence Registry 仅展开模型明确选择的证据 ID，最终 Finding/报告仍是完整 EvidenceRef。final_only 接受改为一个 final_batch.accepted 事件，任何持久化失败禁止重试与成功交付，历史事件仍可 restore。

P0 先通过 307 项完整验证与 34 条历史会话双次字节稳定重放，才开始 Registry。新增真实 Pi SDK 离线链路覆盖 ID、纠错、无自动证据、先文本后 Graph、partial positive、错误回退以及两种持久化故障。完整最终验证、历史差异和可选四例交付 smoke 见 [VALIDATION](VALIDATION.md)；此轮是工程契约验收，不是新的质量实验或 formal/reserve 运行。

最终完整验证 328 passed / 0 failed / 0 skipped。四个 limited-live 名额中 3 个完成、1 个首工具前连接失败；完成运行的显式 Evidence ID 均无损进入报告，P2/P3 保持 text_only、P4 为 incoming-call assisted。P2 额外 unsupported claim 保留为语义风险，不影响工程契约与正确性标签的分离。未启动 reserve/formal。

当前数据流见 [Current Runtime Contract](ARCHITECTURE.md#current-runtime-contract--2026-09-24)，精确定义见 [ADR 0015](adr/0015-evidence-attribution-contract.md) 和 [Attribution v3 protocol](../eval/attribution-v3.md)。

## 历史状态 · 2026-09-23

Python 图已升级为 schema v4 的 LocAgent 风格实体图：directory/file/class/function 与 CONTAINS/IMPORTS/CALLS/INHERITS；method 作为 function 子类，普通名称引用不建图。默认 core 覆盖 changed 与生产 Python，all 为显式独立 generation。两遍流式 resolver、逐文件关系 checkpoint、聚合关系和无 facts/payload 的紧凑最终库已落地。prepared-only 协议把构图和模型 loop 永久分离，并以 receipt/lock 绑定 generation、源码快照和 runtime。8 个固定真实快照的 core 为 7 ready + 1 预算内 partial；G0/G1 热查询的 p95/max 均低于 500/2000 ms 门槛。最终完整验证 237/237 通过，规模、性能、分层和引用消融数据见 VALIDATION。

RealGolden40 的 18/18 reserve pilot 完成交付并生成 READY 正式锁。正式 T0/G0/G1 计划的 120 个 first-attempt 均已落盘，但模型供应商从第 5 次运行起持续返回 1113“余额不足或无可用资源包”；仅 4/120 完成交付，116 次失败，不能原地重试或覆盖。唯一可裁定 finding 与 reference 匹配，但 1/72 的 reference recall、1/1 precision 和各 arm 差异都不具备质量比较意义。当前结论是工程门槛通过、正式实验保全通过、运行完成率门槛失败；v0.2 不打标签。

随后使用 Codex 对 40 个唯一 PR 做独立静态复审：先冻结 prediction，再揭盲裁定。排除 4 个可能受早期上下文影响的样本后，36 个严格盲样本的任务级 precision/recall/F1 为 87.5%/35.0%/50.0%，finding 级为 75.0%/30.0%/42.9%，clean FPR 为 6.25%。结果显示当前审查形态偏向低噪声、低召回，untouched 1-hop 跨文件缺陷 recall 仅 12.5%。该复审没有 T0/G0/G1 分组，也未暴露精确 token、单次延迟和工具调用统计，只能补充总体质量判断，不能证明 Graph 增益。完整复审产物保存在 checkout 外 `../output/mergewarden2-codex-review-20260923/`。

RealGolden 三臂 harness 已分离“审查完成”与“结构导航可用性”：G0/G1 共享同一中性 `NAVIGATION_POLICY_PROMPT`，各自 capability 只说明工具名、调用关系和机械语义；T0 不接收该 system policy 且仍只暴露四个文本/提交工具。Graph/retrieval 错误保留显式 tool error/warning、`metrics.navigation` 诊断和报告限制说明，但不再单独 poison 已满足差异覆盖、源码证据、最终提交与交付门槛的业务完成态。正式 RealGolden 锁固定 `first_attempt`，reserve 保留 operational retry；盲审包将 arm、run key、Graph 调用与 trace 保留在私有映射中，不展示给裁定者。

实验性 LocAgent retrieval scaffold 已接入同一 ReviewEngine，限定为内部 T0/G0/G1 配置，产品工具默认不变。固定 r2 的 8-case × 3-arm GLM 对照已完成，完整交付 T0 7/8、G0 4/8、G1 5/8；按 accepted findings 评分 TP 为 5/5/4，FP 均为 0。Graph-assisted 和 novel→source 转化均为 0，未启动 full 20-case。原始运行固定在 c9584d0，后续边界/trace 修正单独记录；[协议与适配边界](experiments/LOCAGENT_REPLICATION.md)。下文 r1/r2 初次验收数字为历史阶段记录。

v0.2 的 Python 图与评测工程路径已接在 v0.1 上，修订 Golden 前本地 152 项测试和 Windows/Linux × Node 22/24 远端 CI 已通过。真实 GLM CLI 审查/重跑通过；原 r1 的完整 20-case A/B 中 Text-only 完整交付 18/20，Text+Graph 17/20，两组按原 gold 均命中 11/12。50 次 Graph 调用未产生严格归因的 graph_assisted finding。用户改为委托 Agent 复核后，发现 clean 反例、接口范围和 severity 问题，已另冻 r2，保留旧版字节和成绩。Agent 状态不冒充独立人工审核，修订时 r2 尚无真实模型成绩；现已完成上面的八例挑战，记录见 VALIDATION。未打版本标签。

| 模块 | 状态 | 未完成边界 |
|---|---|---|
| 快照 | 提交、暂存区、已保存工作区；仓库外内容存储；版本身份；冻结竞争检查 | VS Code 的用户选择及产品验收 |
| 文本取证 | 源码行号/hash、差异分页、字面搜索；明确截断/不支持文件 | 非文本内容的语义审查 |
| 业务引擎 | final_only；候选结构/证据/覆盖核验；统一模型/宿主操作预算；分阶段提醒、保留提交额度及硬截止；明确终止原因 | 缺陷语义正确性须人工判断；新收尾策略已通过原生 Pi 离线验收，真实模型完成率待后继实验验证 |
| Pi | 单会话内置供应商及国内 BigModel GLM-5.3-Flash；明确 API Key 或显式 Pi 原生 OAuth；Codex 登录及真实模型调用已在受控采样中跑通；精确工具白名单；不加载仓库指令/扩展 | 不保证账号具有目录内全部模型权限；既有采样不证明新收尾策略或图模式质量收益 |
| 原生日志 | 独占空文件经公开 SessionManager.open 初始化；首条回复前持久化；fsync 和写入故障检查 | 不宣称数据库级事务或 exactly-once |
| 报告和恢复 | JSON/Markdown 原子替换；交付清单最后写入；历史校验；原快照新 run | 中断模型会话不续接；运行中硬退出可能留锁 |
| CLI | review/rerun/models/history/show/evidence/doctor/unlock；login/auth-status/logout 管理仓库外专属 OAuth 凭据 | VS Code UI 尚未实现 |
| Python 图 | 固定 grammar；directory/file/class/function；CONTAINS/IMPORTS/CALLS/INHERITS；core/all 分层；两遍流式保守 resolver；可恢复 checkpoint、紧凑不可变 generation 原子发布、失败缓存、单 review 可终止 worker | 只索引 head；动态 receiver、全类型推断、高级 import 根及跨 snapshot 增量更新不支持 |
| VS Code/WSL | 路线和契约确定 | 扩展、VSIX 及正式环境验收待后续 |
| 评测 | 当前 r2 的 20 例 Git SHA/源码/hash；12 defect + 8 clean；r1 按原字节归档；r2 的 8-case T0/G0/G1 挑战已实跑；RealGolden40 120 个正式 first-attempt 已保全，4 completed / 116 provider failures；逐例语义 mapping 与 native trace 派生归因 | 本轮正式结果因余额耗尽不能用于三臂质量/成本比较；须充值后另建 successor lock/output，不得覆盖本轮；样本仍由 Agent 审核、非独立 holdout |

资源上限：单文件 1 MiB，捕获最多 10,000 个路径、100 MiB 内容，最多 200 个变更路径；源码最多每次 200 行/32 KiB，差异按页读取，搜索最多 100 个结果。超限会拒绝、明确不可审查或返回截断；不能据此认定无缺陷。工作区符号链接路径拒绝读取；提交/index 的符号链接、子模块、二进制、超大文件不能计入文本审查覆盖。

持久化故障会使本次 run 无法确认交付。历史只把清单及产物 hash 一致的记录当作已交付；`running` 仅是最后写入状态，不代表进程仍活跃。`doctor` 检查锁拥有者，`unlock` 仅清理已退出进程的锁。临时文件可能在硬退出后遗留；不自动删除历史快照和报告。

Graph contract 不含 Tree-sitter CST 类型。实体类型固定为 directory/file/class/function，method 用 `functionKind` 区分；关系固定为 CONTAINS/IMPORTS/CALLS/INHERITS。普通引用索引为 `not_built`，文本引用由 `search_text` 提供。provenance 保存源码范围、site id、snapshot 和 resolver 版本；candidate/unresolved call 或 inheritance 只保留 dependency site，不生成可遍历边。禁止按全仓同名回退。发布需要事务完成、外键、计数、源码范围与 SQLite quick-check；热查询固定在同一已验证 generation。解析、文件或容量有缺口的 generation 只能是 partial，并在查询状态与覆盖摘要中继续显式暴露。

默认构图预算为 250,000 facts、400,000 relations，单文件另有 25,000 facts / 15 秒上限；预算与 core/all 范围都属于缓存身份。250,000 是在首轮固定快照测量后，为完整覆盖旧 SymPy production core 做的有界调整；现代 SymPy 源码明确标注自动生成的 `integrals/rubi/rules` 精确路径由范围策略 v2 归入 generated，规则不泛化到所有 `rules/` 目录。完整文件提取和关系解析分别逐文件真实提交到 staging；最终 schema v4 仅保存文件元数据、实体、dependency site、聚合 relation 与 relation site，不保存整文件 facts/payload。只有校验后的不可变 generation 可查询；容量不足可以发布范围明确的 partial。工作线程的 512 MiB 参数只限制 V8 old generation，不代表进程 RSS、WASM 或 ArrayBuffer 的总内存硬上限。每页最多 100 项/32 KiB，warnings 有界。一个 review 复用同一 worker、只读 SQLite 句柄及检索索引；损坏 generation 单次隔离后从 checkpoint 恢复。

审查 deadline、显式取消和工具预算会关闭新工具接纳，预算在接纳时原子扣减；manifest 分别记录请求、接纳、执行和拒绝数量。runtime abort、工具队列与 worker 清理均有界，取消后不再启动新工具；本地中断不证明供应商已经停止远端计费。

Trace 分析仅作事后评测，不参与 Pi 决策，不改变 FindingCandidate。graph_assisted 要求 resolved incoming caller 在文本中尚未暴露，Graph 返回后另行读取源码，且 accepted evidence 包含该位置。图返回的精确 GLM tokens 不可得；字符/4 粗估单列。中断响应的全零 SDK usage 明确标为不完整，不能视作零费用。人工审核 receipt 绑定所选 corpus/SHA；r2 的 Agent 修订清单明确 humanReviewed=false，不自动升级人工状态。

分支基线：v0.2 从 5422ba7（完整 feat/review-engine）开始。读取远端时 main=916ebf2，只合入快照；完整引擎已合入 feat/immutable-snapshots=9258306。main 与引擎当时分叉 1/3 提交；没有强推、改写 main 或覆盖用户的未提交文档。

RealGolden 使用独立的 public/hidden/audit/lock contract，入口为 `eval:real:admission` 与 `eval:real-live`。RealCorpusAdapter 仅获取精确 Git 对象并交给现有 SnapshotStore/ReviewEngine/Pi；三种 arm 只存在于评测配置。模型循环不读取 hidden/audit。源码、父链与人工/Agent 身份独立保存；当前冻结标注为 Agent source_reviewed，不冒充 human_reviewed。正式运行要求 reserve pilot 通过并产生 READY experiment lock，语料冻结本身不代表模型质量或运行准入。操作见 [评测协议](../eval/README.md)。
