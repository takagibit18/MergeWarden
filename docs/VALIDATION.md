# 实测记录 · 2026-09-20


## Evidence & Attribution Contract · 2026-09-24

基线为用户本地 Routing 开发 HEAD `26e6535`，工作树干净；本地 main 为 `8b170a0`，远端 main 经只读查询确认为 `2571aef`。从当前工作树继续，未覆盖已有提交。基线 verify 为 289 passed / 0 failed / 0 skipped（174 core + 45 Pi + 50 Tree-sitter + 20 Python）。

P0 在开始 Registry 前独立通过 307 项完整检查。原 Routing v1 16-run 和 ABC 18-run 的原生会话、最终报告、raw findings 与 v2 结果只读保留，v3 对全部 34 条运行重复分析，字节稳定且输入 digest 不变。ABC 中 P1/C、P4/B 从 ambiguous 重分类为严格 incoming-call assisted，因为早期失败提交不再污染后来完整 accepted evidence。P2/B、P2/C 最终缺少 adapter.py/api.py evidence，继续不给严格 credit。Routing v1 的另外两项变化分别是 entity-search 分类与后续精确 source range 关联修正。计量重分类不等于模型能力提升。

Registry 和原子接受完成后，首次完整 verify 为 325 passed / 0 failed / 0 skipped（201 core + 54 Pi + 50 Tree-sitter + 20 Python），三组类型检查、demo、status 通过。P1 后的历史重放与 P0 冻结 v3 输出逐字节相同。测试数量只用于记录验收范围，不是质量分数。

跨层 fixture 使用真实 Pi SDK、离线 scripted provider、真实不可变快照与 prepared-only Graph、ReviewEngine、PiSessionJournal 和 native session.jsonl，然后交给 v3 analyzer。覆盖 ID 展开至报告、未知 ID 后修正、未选择 Graph source 不自动附加、先文本后 Graph、partial definite edge、Graph error 后 text fallback，以及 final batch 写入前/写入后确认失败。八种情形均通过。

先运行的 fault-injection 确认旧多事件 final batch 可以留下半接受状态；新 composite event 在一次 reducer transition 中完成接受和 coverage。Controller 在任何 append 失败后保持 poisoned，Engine 中止，不允许把持久化错误作为参数纠正而重试。旧事件与 incremental 模式恢复测试保留。

所有日志、原始重放、摘要和实施报告位于 checkout 外 `../output/evidence-attribution-contract-hardening-20260924/`。可选四个既有正例的单 variant live 只用于 Evidence ID 交付确认，单独 identity、单次尝试；不是 F1、reserve 或 formal 实验，不能追求 4/4 Graph-assisted。Graph v4、Routing 触发/预算、B/C 原措辞、模型配置和 RealGolden 标签不变。

### 最终交付补充

四个 live 名额已使用并冻结在独立 delivery-smoke identity。P1 在首个工具调用前因沙箱网络 EACCES 失败，保留原尝试、没有补跑；P2/P3/P4 在获准网络环境中完成。三个 main claims 经冻结后源码核对均有支持，模型明确选择的 Evidence ID 全部展开为最终完整 EvidenceRef；P2/P3 是 text_only，只有 P4 是 strict incoming-call assisted。P2 另一个 bytes 语义 claim 缺少契约支持，依旧不算正确 finding。三例各有一次 SDK schema 纠正，其中一次为 ID 与 legacy 字段混写，另两次为旧式不合法 hash；没有为此放宽校验。此记录不构成质量比较。

Live 冻结后补测发现参数数组错误仍被旧 identity 检查误判为 fatal。最终 decoder 将这种普通输入错误限定在 call；依赖该无效调用的证据链仍拒绝，真正损坏的 active native message 仍 fatal。新增真实 SDK 参数数组错误后恢复 fixture，跨层情形共 9 个。最终完整验证为 328 passed / 0 failed / 0 skipped（203 core + 55 Pi + 50 Tree-sitter + 20 Python）；历史 34 条和 live 4 条实际结果均未重分类。最终日志为 checkout 外 acceptance-final-verify.log。

工程契约可进入新的有限 reserve，但本轮没有自动启动 reserve/formal。Evidence relevance 与 unsupported claims 仍需语义审核；后续保留 schema retry 与证据选择遗漏观察项，不以 finding/Graph 调用数量判胜。

## 图稳定性层 · 2026-09-22

工作基线为干净的 `feat/realgolden40-corpus` / `092ba457ad42f28a1bb11afa33b24a02fa66ce1f`；提示词所列 `0dd80b2` 不在本地对象库，本地 `main` 为 `8b170a0`，因此没有回退或覆盖当前两项 Graph harness 后续修正。修改前 `npm run verify` 退出码 0：142 core + 18 Pi + 38 Tree-sitter + 20 RealGolden，三组类型检查、demo、status 均通过；日志保存在 checkout 外 `../mergewarden2-graph-upgrade-baseline-verify.log`。

稳定性层保持原四类关系语义，迁移到 schema v3：分文件 checkpoint、不可变 generation、原子 manifest、ready/partial 分离、预算身份、确定性失败缓存、单 builder、损坏单次隔离、跨 generation 游标拒绝，以及单 review worker/只读句柄复用。取消路径在工具接纳时扣减预算，分别记录 requested/accepted/executed/rejected；deadline 后关闭接纳，并对 Pi abort、工具队列和 Graph worker 做有界清理。V8 old-generation 限制不再表述为进程总内存上限。

修改后完整 `npm run verify` 退出码 0：143 core + 18 Pi + 38 Tree-sitter + 20 RealGolden，0 failed / 0 skipped，三组类型检查、demo、status 均通过。新增故障测试验证完整文件容量部分发布、checkpoint 恢复不重提取、确定性 resolver 容量失败不重复、并发单 builder、损坏 generation 恢复、跨 generation 游标拒绝、冷构建取消后恢复，以及忽略 abort 的 runtime 仍在有界时间交付 cancelled 报告。日志保存在 checkout 外 `../mergewarden2-graph-upgrade-change-a-verify.log`。这一步没有运行付费模型，也不构成 Graph 审查质量证据。

## 实体图 v4 与真实快照测量 · 2026-09-22

Change B 在 Change A 提交 `598c9bc` 上将图升级为 schema v4 / resolver `python-entities-streaming-5` / scope policy `python-core-scope-2`。实体固定为 directory/file/class/function，method 由 `functionKind` 区分；可遍历关系固定为 CONTAINS/IMPORTS/CALLS/INHERITS。普通标识符读取不再由提取器生成，也不进入 checkpoint 或最终库；绑定、遮蔽、重新赋值、import 和作用域事实仍用于保守解析。最终 generation 只保存文件目录、实体、dependency site、聚合关系和逐 site 来源，不保存整文件 facts/payload。设计、来源与 faithful/adapted/not-used 差异分别见 [ADR-0014](adr/0014.md)、[来源](SOURCES.md) 和 `eval/locagent/entity-graph-v4-fidelity.json`。

LocAgent 对照固定在官方提交 `4935b557326c154bad8e8dcf3747cc8d32d1f387`（Apache-2.0）。受控 5 文件样例的官方分析器输出已单独冻结：目录/文件/类/函数、包含、明确 import、`app.run → helper` 和多继承正常映射；invokes→CALLS 及 `Child.__init__` 的方法归属为明确适配；上游对参数遮蔽和 wildcard 名称产生的两条启发式调用边被本项目保守拒绝；`pendingDefect=[]`。差分测试只执行经检查的参考分析器来解析惰性样例，没有导入或执行被审项目代码。

### 固定输入与口径

profile 从既有任务清单读取以下完整 SHA，不使用最新分支，也不读取 hidden gold、fix 或模型结果。HEAD 图使用 reviewed SHA；表中同时保留 base 以绑定原任务。

| 快照 | case | base SHA | reviewed SHA |
|---|---|---|---|
| Requests | RG2-9a9c0b930264 | `317f64a11f56d89119baf5db3af65c0343464bc1` | `35ec6bb613669dbbbba2afcc7aac4e467a5b4db8` |
| pytest | RG2-36fc7cf7f8d0 | `15ac0349b2c7d8dc48fe2e25a1b4fa47c9fda25c` | `0bc9ffcc8782fd126d0a9ce95ce130d1d760d2cb` |
| Certbot | RG-C035 | `c96420dbe0b9c6950b4fd862cd5a43e565b14834` | `2584184819410ce0eedf8a72a126bd3db5162fd3` |
| NetworkX | RG-C008 | `2b01a30d6967cc94a0f8caca2252bce7817b2b1c` | `b446ef128ee25c420c6c1e8707e24cc1dfff6f94` |
| xarray | RG2-8a20ce3c59fd | `8389fe6e8c86a04d57f25fe137b6f2db77065523` | `5868aed40b520e87bef501361bdc2beb7eb0b26c` |
| scikit-learn | RG2-1f682ac2d7bb | `d3d09c383cf25f987e54c063c546b3bfeac971cb` | `770204c63d978ae093c355004de26f2e284066dd` |
| SymPy 旧快照 | RG2-7b899db872f4 | `84d6ea85c2d07b4cad614b1257af6ed36cff9524` | `6c94701dd4e05894d54836ac35f539edce82f111` |
| SymPy 现代快照 | RG2-ae0ac5357175 | `37c6d80a6080e8f72f33565fea1956c3ff28dfcf` | `ffe040d815fe0738e298c6336e3fd14c5ddb98be` |

最终测量在 Windows NT 10.0.26200、Node 24.12.0 / npm 11.6.2 上顺序运行，默认预算为 250,000 extraction facts、400,000 relations、单文件 25,000 facts / 15 秒。首轮固定快照预检表明 200,000 facts 会截断两个 SymPy core；随后将普通引用移出提取器，并用公开范围策略 v2 精确排除源码头声明自动生成的现代 SymPy `sympy/integrals/rubi/rules/`，再把默认总量一次性调到 250,000 并更换缓存身份。普通 `rules/` 目录不受该例外影响；这不是按已知答案裁剪。最终旧 SymPy core 完整，现代 SymPy 仍在安全上限处发布可信 partial，没有继续抬高上限或放宽解析。

“保留行”是最终库的 entities + dependency sites + aggregate relations + relation sites；它与 extraction facts 是不同口径。所有容量停止都以完整文件为原子单位。

| core 快照 | 状态 | 已索引/计划文件 | extraction facts | 保留行 | 实体 | 调用位置 | 聚合关系 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Requests | ready | 38/38 | 5,356 | 4,047 | 459 | 1,471 | 818 |
| pytest | ready | 76/76 | 24,913 | 16,152 | 2,056 | 7,069 | 2,578 |
| Certbot | ready | 246/246 | 30,695 | 20,561 | 2,577 | 9,235 | 3,161 |
| NetworkX | ready | 284/284 | 44,341 | 27,893 | 2,548 | 15,126 | 4,160 |
| xarray | ready | 99/99 | 37,922 | 27,002 | 2,709 | 11,192 | 5,452 |
| scikit-learn | ready | 288/288 | 73,432 | 50,782 | 4,383 | 22,262 | 9,497 |
| SymPy 旧快照 | ready | 561/561 | 208,673 | 155,170 | 13,770 | 67,108 | 29,451 |
| SymPy 现代快照 | partial | 530/671 | 249,165 | 190,634 | 17,408 | 86,647 | 34,240 |

现代 SymPy 的 141 个未完成 core 文件全部明确记为 omitted production；changed 文件为 1/1 已纳入。停止原因是 `Graph fact budget reached before sympy/printing/str.py`。其全仓 1,308 个 Python 文件中，core 另明确排除 555 test、34 example、29 benchmark、19 source-declared generated、0 vendor。其余七个 core 没有省略计划文件。

### 存储、查询与观测内存

MiB 均为 1,048,576 bytes。generation 是可查询最终库，checkpoint 是不可查询、可恢复的提取/关系 staging；“content 文档”是 G1 共享的非重叠文件片段正文总量，不是持久化数据库大小。内容索引还包含 sparse postings，完整 documents/terms/postings/tokens 统计在原始 JSON 中。冷构建从空的最终 profile state 开始；首次打开包含不可变 generation 身份、计数、foreign-key 和 SQLite quick-check；hot p95 是同一只读句柄连续 25 次精确 lookup。

| core 快照 | generation MiB | checkpoint MiB | content 文档 MiB / 建索引 ms | 冷构建 s | 首次打开 ms | hot p95 ms | 峰值 RSS / heap / external MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Requests | 3.27 | 3.10 | 0.22 / 192.4 | 0.546 | 29.4 | 0.8 | 99.7 / 22.5 / 41.6 |
| pytest | 12.55 | 13.14 | 1.05 / 858.0 | 2.243 | 99.6 | 1.3 | 156.7 / 43.8 / 48.2 |
| Certbot | 16.64 | 17.86 | 1.71 / 1,152.2 | 3.061 | 111.3 | 1.3 | 183.9 / 69.1 / 48.2 |
| NetworkX | 22.28 | 25.03 | 3.13 / 1,781.8 | 4.263 | 192.9 | 1.6 | 224.6 / 65.6 / 49.4 |
| xarray | 21.21 | 20.68 | 2.16 / 1,184.1 | 3.540 | 152.6 | 1.4 | 313.4 / 84.0 / 54.6 |
| scikit-learn | 40.81 | 42.14 | 4.70 / 2,882.7 | 10.614 | 306.6 | 3.8 | 336.5 / 103.1 / 62.6 |
| SymPy 旧快照 | 122.08 | 120.32 | 8.38 / 4,693.1 | 356.926 | 1,040.8 | 124.9 | 382.2 / 209.1 / 66.8 |
| SymPy 现代快照 | 151.07 | 150.20 | 9.03 / 6,457.6 | 560.137 | 1,430.3 | 167.2 | 485.7 / 265.0 / 70.5 |

内存值来自同一 Node 进程顺序跑 8 个快照时每 25 ms 的进程级采样，不是隔离 benchmark 或硬上限；前序 V8/SQLite/WASM 状态、GC 时点和文件缓存会影响后续值。原始 JSON另存每次 peak/end 的 RSS、heapUsed、external、ArrayBuffers，以及内容源加载/索引前后值；个别增量因 GC 可为负，不能解释成索引释放了固定内存。现代 SymPy 的显式 all 构建期间实际观察到约 529.4 MiB RSS，再次证明 512 MiB old-generation 参数不等于整个进程、WASM 或 ArrayBuffer 的总内存限制。大型库的最终关系/位置写入使两份 SymPy 的冷构建达到数分钟，是当前明确瓶颈，不包装成低延迟结果。

### core 与显式 all 分层（独立变化）

下表只展示从默认 core 到独立 `scope=all` generation 的增量，因此不把普通引用移除的收益算进文件分层。Requests all 虽完成 42/42，旧语法测试文件 `tests/test_requests_async.py` 存在 parse error，所以状态为 partial；旧 SymPy all 在 `sympy/diffgeom/tests/test_class_structure.py` 前达到预算。现代 SymPy core 已用满预算，all 因相同 changed→production→supplemental 顺序没有再加入补充文件。

| 快照 | all 状态/文件 | +文件 | +facts | +实体 | +dependency sites | +聚合关系 | +generation / checkpoint MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Requests | partial 42/42 | 4 | 435 | 37 | 207 | 59 | 0.30 / 0.32 |
| pytest | ready 244/244 | 168 | 35,633 | 3,677 | 13,520 | 4,034 | 20.06 / 20.19 |
| Certbot | ready 362/362 | 116 | 35,681 | 3,075 | 15,323 | 3,267 | 19.79 / 21.79 |
| NetworkX | ready 631/631 | 347 | 63,347 | 4,966 | 29,699 | 6,146 | 39.05 / 42.88 |
| xarray | ready 165/165 | 66 | 62,166 | 3,451 | 31,754 | 9,119 | 46.96 / 47.16 |
| scikit-learn | ready 742/742 | 454 | 98,537 | 4,217 | 51,408 | 13,114 | 69.04 / 74.06 |
| SymPy 旧快照 | partial 684/1,013 | 123 | 41,325 | 2,250 | 26,702 | 5,693 | 35.34 / 36.29 |
| SymPy 现代快照 | partial 530/1,308 | 0 | 0 | 0 | 0 | 0 | 0 / 0 |

### 普通 REFERENCES 移除消融（独立变化）

另用 Change A `598c9bc` 的旧提取器，对最终 v4 core **实际完成的同一文件集合**重新提取 ordinary `references`，不运行目标代码。保守存储下界 = 同一文件 facts JSON 中 references 的 UTF-8 增量 + 旧 schema v3 `sites` 表实际 SQLite 增量；它排除了 REFERENCES 关系行和与其他表的页面交互，所以不是旧库总大小，也不是文件分层收益。

| 快照 | core 文件 | 旧 ordinary reference sites | 保守存储下界 MiB |
|---|---:|---:|---:|
| Requests | 38 | 2,688 | 4.17 |
| pytest | 76 | 17,475 | 26.14 |
| Certbot | 246 | 20,991 | 34.64 |
| NetworkX | 284 | 32,218 | 51.73 |
| xarray | 99 | 27,822 | 41.44 |
| scikit-learn | 288 | 49,495 | 79.47 |
| SymPy 旧快照 | 561 | 172,947 | 261.12 |
| SymPy 现代快照 | 530 | 181,891 | 280.39 |

### 关键关系保真与保守断边

- xarray 确定 CALLS 路径仍存在：`xarray.core.computation.where → apply_ufunc`（`xarray/core/computation.py:1835`, resolved_scoped）→ `apply_dataset_vfunc`（`:1167`, resolved_scoped）→ `xarray.core.merge.merge_attrs`（`:471`, resolved_import_alias），3 hops。
- scikit-learn 明确调用仍存在：`sklearn.multiclass.OneVsOneClassifier.fit → sklearn.utils.multiclass.check_classification_targets`，`sklearn/multiclass.py:494`，resolved_import_alias。
- 清楚的继承边仍存在：`sklearn.naive_bayes.ComplementNB → sklearn.naive_bayes.BaseDiscreteNB`，`sklearn/naive_bayes.py:735`，resolved_scoped，父类声明顺序 0。
- 旧 SymPy 的 `sympy.simplify.simplify.ratsimpmodprime` 在 `sympy/simplify/simplify.py:933` 调用 `solve`，但根 `sympy` 包通过 wildcard 重导出 solver 名称。该位置被保留为 dependency site，结果为 `unresolved / module_member_unavailable`，因此 `ratsimpmodprime → solve` 路径为空。没有为通过验收而做全仓同名补边。

### 故障注入与完整验证

新增测试覆盖：完整文件容量 partial 与明确 omitted 范围；提取和关系 checkpoint 分别恢复且不重复已完成工作；确定性 relation 容量失败缓存；resolver 失败不把 staging 暴露为图且保留上一 generation；模拟 ENOSPC 记录 transient 原因、删除候选库并零重提取恢复；单缓存身份只有一个 builder；core/all generation 相互独立；损坏、版本、parser、coverage 和缺边库有界隔离；跨 generation cursor 拒绝；冷构建取消后可恢复。绑定/遮蔽、循环/通配 import、单/多/别名继承、动态父类、`__init__` 归属、partial 中缺失候选不升级确定边均有真实 grammar 测试。G1 另验证共享文件片段、内容索引单独降级、循环/菱形去重和先长后短路径仍能展开。trace attribution 升为 `trace-attribution-2`，新语义只将确定 incoming CALLS 计作 caller 发现；历史产物保留原版本，不改写旧锁。

Change B 最终完整 `npm run verify` 退出码 0：**147 core + 18 Pi + 49 Tree-sitter + 20 RealGolden = 234 passed，0 failed，0 skipped**；核心、Pi、Tree-sitter 三组类型检查以及 demo/status 全部通过。日志在 checkout 外 `../mergewarden2-graph-upgrade-change-b-verify.log`。第一次完整运行在 Pi Stage B 的中性工具描述契约处失败：更新后的 `traverse_graph` 说明漏掉“untouched/relevant code”字样；工具执行本身未失败。补回不带强制引导的能力说明后，单项和从头完整验证均通过；首次失败日志保留为 `../mergewarden2-graph-upgrade-change-b-first-failure.log`，没有用重跑覆盖证据。

最终机器可读产物位于 checkout 外：`../mergewarden2-graph-v4-final-measurements.json`、`../mergewarden2-graph-v4-final-reference-ablation.json`；构建状态与 generation 位于 `../.mergewarden2-graph-profile-v4-final/`。脚本和复现命令见 `eval/graph-profile.mjs`、`eval/graph-reference-ablation.mjs` 与 `eval/README.md`。这些数据证明范围、容量、恢复和静态关系口径，不证明 Graph 提高审查质量；本轮没有运行付费模型、RealGolden40 正式 A/B 或 reserve。

## Golden r2 修订验证

用户授权 Agent 复核后修订为 `controlled-python-v02-20-r2`。本次先运行完整基线验证（152 passed），修改后 `npm run verify` 为 **101 core + 16 Pi + 38 grammar = 155 passed，0 failed，0 skipped**，三组类型检查、demo/status 通过。新增检查覆盖旧语料字节保留/版本混用拒绝、severity 与源码范围一致性，以及全部 revised base/head 的真实 grammar 解析。20 例均重新构建并核对固定 Git SHA，经真实 SnapshotStore 读取。没有执行被审 Python。

r2 离线 `--all` 已完成 **20 Text + 20 Graph，40/40 完整交付**，20 对 snapshot/有效配置一致，运行期间实现摘要未变。使用真实 Pi SDK 与 scripted-offline provider，空预测及 tokens 为合成，不能作为模型质量证据。日志与原始结果在仓库外 `../output/mergewarden-v02/golden-r2-verify.log`、`../output/mergewarden-v02/golden-r2-offline-all20/`。离线实验完成后仅校正一条 clean-none 的修订说明，不改变冻结 cases/hash 或可执行代码。本次新增改动的远端 CI 尚未执行。

旧 r1 按原字节保存在 `eval/corpora/controlled-python-v02-20/`，hash 仍为 `ef748a3c5916190857e5cb8e4753b23274f7206833ada681763dd328b2b44939`；r2 hash 为 `07491d7803a4a25ded06e58d4acfae052e6ec2bd7575cff9867c9adf0c9f62d9`。旧 raw/mapping/metrics 不改写。执行、评分、trace 匹配与审核工具支持显式 `--corpus`，错配版本会拒绝。

修订纠正 clean-guard 的正小数反例，明确三个 clean 的公开 API 边界，增强三个过易负例，将重复多跳单位转换替换为重试次数契约；10 项 defect 重评 medium，2 项 high 保留限定理由。[语料修订清单](../eval/corpus-revision.json) 逐例保存 lineage、SHA 和 Agent provenance。结论来自 Agent 静态推导，未冒充独立人工或 Python 执行验证。作者已见过 r1 结果，r2 不是独立 holdout；**r2 尚未跑真实模型 A/B，下文所有历史质量数据都属于 r1，不能转用为 r2 成绩。**

## v0.2 本地验收

修改前在完整 ReviewEngine 提交 5422ba7 跑过全部验证：**90 passed，0 failed，0 skipped**。随后开发分支安全快进到同树的 v0.1 合并提交 9258306；未改写 main。初始 6 处用户文档改动已另存仓库外补丁并保留。

图工程初次验收时 Windows / Node 24.12.0 的 `npm run verify` 退出码 **0**：核心/CLI/快照/引擎/评测 **77**、真实 Pi SDK **16**、真实 Python grammar/resolver/store/Golden **37**，共 **130 passed，0 failed，0 skipped**；三组类型检查、demo 和 status 均通过。原 90 项用例继续保留；声明限定名增加模块前缀，原 grammar 断言随 contract 更新。

新增验证包括同名隔离、嵌套/类作用域、遮蔽、六种 import、解析缺口、动态 receiver/metaclass；snapshot 隔离、确定性重建、损坏/未完成/版本过期/覆盖篡改缓存、分页、工作线程取消；Graph 错误阻止 completed clean、真实 Pi 工具循环、Graph 后伪造 source hash 仍须实际 read_source；Text-only 不建图；20 例 Git SHA 重建与快照读取、指标及一对一语义匹配。

### Tool trace 归因与人工复核工具

追加 22 项确定性测试后，本地完整 `npm run verify` 为 **99 core + 16 Pi + 37 grammar = 152 passed，0 failed，0 skipped**。提交 `eeaf508` 的 [四组远端 CI](https://github.com/takagibit18/mergewarden2/actions/runs/35510896211) 全部通过，每组执行完整验证。

测试覆盖活动 native JSONL 分支、损坏/孤立结果、实际 tool result 而非模型自述、同 snapshot 的 accepted source evidence、incoming caller 新颖性、既有文本线索、同批次预发读取、candidate/unresolved、失败查询、错误 hash 与范围、语义 mapping 后的两组对照，以及缓存/中断 usage。Graph 返回量保留精确 bytes/字符数；逐工具 GLM tokens 不可得，单列字符/4 粗估，不冒充真实账单用量。`incompleteUsage` 明确标记中断或缺失响应用量；aborted 响应返回零 usage 不能证明零消耗。

人工审核工具校验 corpus hash、20 个 case 与 base/head SHA、五项判断和本人声明。测试中的签署人是明确标记的 synthetic fixture，不是真实审核；后续用户改为委托 Agent 复核与修订，记录见 r2 小节，未升级人工 provenance。生成的 receipt 与所选 corpus 绑定，允许部分复核和争议状态，不改冻结答案。预测到 golden 的 Codex 语义匹配与人工标注审查是不同记录。

### 真实 Git Snapshot 图 smoke（受控源码，真实组件）

对冻结 `cross-key` base/head 提交调用真实 SnapshotStore → Tree-sitter → resolver → SQLite → graph_lookup/graph_neighbors → source。schema=2，resolver=python-scopes-2；2 eligible / 2 indexed / 0 parse-incomplete，1 resolved call / 0 candidate / 0 unresolved。查询正确返回 view.py 到 user.user_record 的调用及其源码范围。

一次本机测量：cold build **123.688 ms**，包含工作线程启动的 cold request **226.341 ms**，同 snapshot cache 的 warm request **104.739 ms**；两次 store query 合计 **2.094 ms**。warm request 包含线程启动、数据库及内容摘要校验，不能称为纯 SQLite 查询耗时。这只是两个文件的单次 smoke，不是大仓性能结论。

### Text-only / Text+Graph 工程实验

同一冻结 20 例、相同 snapshot/模型配置/提示词基线/120 秒/40 工具预算运行两组，**40/40 完整交付**；20 对实际配置全部一致（除 graph capability），运行前后实现摘要一致。输出逐例 raw、mapping、报告、原生 Pi JSONL 与汇总指标。此处使用真实 Pi SDK 和刻意空预测的 **scripted-offline provider**，没有调用真实模型。

| 指标 | Text-only | Text+Graph |
|---|---:|---:|
| 完整交付 | 20/20 | 20/20 |
| 工具调用 / Graph 调用 | 42 / 0 | 62 / 20 |
| 实测 review latency 总计 | 27,085.019 ms | 31,744.586 ms |
| 实测 graph build 总计 | 0 ms | 2,187.914 ms |
| **合成** input/output/total tokens | 620 / 310 / 930 | 820 / 410 / 1230 |
| 脚本空预测的 precision / recall / F1 | null / 0 / 0 | null / 0 / 0 |
| 脚本 clean FPR / PR recall / cross-file recall | 0 / 0 / 0 | 0 / 0 / 0 |

以上质量数字仅检验指标计算，不描述 GLM 或 Graph 的审查质量；token 也是替身设定值，不能用于真实费用比较。逐例 Graph diagnostics 在 raw/metrics 中保留，未仅保存均值。

Gold 在模型调用前冻结：12 defect（4/4/2/2 分类）、8 hard-negative clean；corpus SHA-256 `ef748a3c5916190857e5cb8e4753b23274f7206833ada681763dd328b2b44939`。案例与理由由本次实现预先编写，尚未经独立人工标注复核，不冒充真实公开项目缺陷历史。

原始本机产物位于仓库外 `../output/mergewarden-v02/`：`baseline-verify.log`、`verify-release-candidate.log`、`smoke-release-candidate/smoke.json`、`ab-release-candidate/{raw,mapping,metrics}.json`。不把这些任务报告和运行状态加入 Git。

### 远端 CI

实现提交 `7a38870` 已推送至 `feat/python-codegraph-evaluation`，并创建 [草稿 PR #3](https://github.com/takagibit18/mergewarden2/pull/3)，基于包含完整 v0.1 引擎的 `feat/immutable-snapshots`。该提交的 [push CI](https://github.com/takagibit18/mergewarden2/actions/runs/35500506139) 四组矩阵全部通过：Windows/Linux × Node 22.19.0/24.12.0，每组执行锁定依赖安装和完整 `npm run verify`。未改写 main，未 force push。

### 真实模型 CLI 主链路与最小 A/B

2026-09-20 使用用户配置的 MERGEWARDEN_API_KEY 调用 bigmodel/glm-5.3-flash；以下为真实请求和 SDK 用量，不是 scripted provider。运行时实现提交为 `f9921cc`（运行时源码与 `7a38870` 相同），实现摘要 `baeb01671d9f8f7c68085b4da5daa6eb67dc9a4eebbafc792520445788054dc8`。运行前后摘要一致，4 对配置审计全部通过；没有修改模型、提示词、预算或 frozen labels 迁就结果。之后只同步 CLI status 的验收元数据和文档。

正式 CLI 在冻结 single-zero 案例完成 review → immutable Snapshot → Pi/GLM → read_diff/read_source/search_text/graph_lookup/graph_neighbors → submit_review → JSON/Markdown 交付，退出码 0。run `11c6f5b3-52c6-461e-a910-e45ddfe7ecd9` 找到零除回归，9 次工具调用（3 次 Graph），92.709 秒；cold build 81.756 ms，warm request 77.559/77.597 ms。CLI history/show/evidence 重新读取成功，证据 SHA 与报告 hash 均通过，doctor 无遗留锁。独立 CLI smoke 使用 180 秒、40 工具预算，不混入以下 A/B 指标。

同 snapshot rerun `f34d2d89-5177-4ffc-b86f-a294cea04c80` 也以退出码 0 完成，新旧报告均可读取；耗时 63.355 秒，7 次工具调用（1 次 Graph）。缓存复用 build=0，warm request 74.018 ms。snapshot 均为 `599c1164aefdf426bae6b43d409248cf36ac9124e16adb00915537866bf9b9fc`。

A/B 使用原先冻结的 4 个 smoke 案例（single-zero、cross-key、alias-normalize、clean-guard），3 defect + 1 clean，每组 120 秒、40 工具预算，单次运行：

| 实测指标 | Text-only | Text+Graph |
|---|---:|---:|
| 完整交付 | 4/4 | 3/4 |
| TP / FP / FN | 3 / 0 / 0 | 2 / 0 / 1 |
| Finding precision / recall / F1 | 1 / 1 / 1 | 1 / 0.667 / 0.8 |
| clean PR false-positive rate | 0 | 0 |
| PR-level recall / cross-file recall | 1 / 1 | 0.667 / 0.5 |
| input / output / total tokens | 84,996 / 16,163 / 101,159 | 123,712 / 15,719 / 139,431 |
| 工具调用 / Graph 调用 | 40 / 0 | 47 / 10 |
| 总 review latency | 413.665 秒 | 419.512 秒 |
| 总 graph build latency | 0 | 377.966 ms |

Graph 组的 alias-normalize 在第 13 次工具调用 submit_review 时因把未修改文件列入 reviewedPaths 而收到 Unknown reviewed path，随后触及 120 秒上限。索引与 Graph 查询均成功，3/3 文件、1 resolved call；报告明确 partial（Review time budget exhausted），未伪装 clean，仍计入 FN 与完整交付率分母。两个 cross-key run 也曾触发相同提交校验，但均在预算内修正成功。保留这些失败和恢复记录，未重试后覆盖原结果。

Graph 组四个索引按案例分别为 indexed 1/2/3/2，resolved calls 0/1/1/1；parse-incomplete/candidate/unresolved 均 0。cold build 为 89.982–98.291 ms，warm request 为 71.224–85.717 ms，仍包含工作线程启动和缓存校验。Text-only 未构图；其零诊断数表示未索引，不表示没有依赖。

五个已提交 finding 由本次 Codex 逐条比较 claim/trigger/impact 与冻结源码后作语义匹配，**不是独立人工复核**；两个 finding 的预测 severity 为 medium、gold 为 high，现有指标衡量缺陷身份而非严重性一致率。全部报告重开与源码证据复核通过。此次小样本中 Graph 完成率和 recall 更低、token 更多，**未观察到增益，也不足以推断普遍优劣**。

仓库外真实产物：`../output/mergewarden-v02/live-smoke-20260920/{raw,mapping,metrics,e2e-audit}.json`，以及 `cli-live-20260920/e2e-audit.json` 与各 run 原生 JSONL/报告。原 20-case 离线数据完整保留，不能与这组真实用量混合。该次 smoke 之后的完整真实集见下；独立人工标注复核、追加重复及公开项目评测仍待完成，未打 v0.2.0 标签。

### 完整 20-case 真实 GLM A/B 与工具归因

保持 bigmodel/glm-5.3-flash、Pi 0.84.1、120 秒、40 工具预算和原 prompt/corpus，顺序执行每例 Text-only 后 Text+Graph，共 **20 + 20 次真实模型调用**。执行的是 `cb63eff` 的独立冻结源码副本，运行时摘要 `0a8250945ac4deac9df23865640c872f8b5bd80b68eedf5d00b3fbdfca30f0a0`；运行前后不变，20 对实际配置审计全部通过。新的 trace/人工审核代码在另一个 checkout 中开发，仅参与事后分析，没有进入模型循环。

复用原 state/repositories 的真实路径，先前 4 个 smoke 案例的 snapshot 和有效配置均再次一致。没有覆盖旧 run，也没有为分数修改 case。40/40 报告重开通过，22 个 accepted finding 的 62 条 immutable source evidence 全部重新核验；40/40 native trace 可分析，逐响应 usage 合计与 manifest 一致。

| 指标 | Text-only | Text+Graph |
|---|---:|---:|
| 完整交付 | 18/20 | 17/20 |
| TP / FP / FN | 11 / 0 / 1 | 11 / 0 / 1 |
| Finding precision / recall / F1 | 1 / 0.917 / 0.957 | 1 / 0.917 / 0.957 |
| Clean PR FPR / PR recall | 0 / 0.917 | 0 / 0.917 |
| Cross-file recall | 6/7 | 7/7 |
| 已报告 input / output / total tokens | 371,556 / 60,039 / 431,595 | 570,895 / 73,312 / 644,207 |
| 其中 cacheRead tokens | 182,592 | 424,064 |
| 工具调用 / Graph 调用 | 183 / 0 | 231 / 50 |
| 总 review latency | 1,668.468 秒 | 1,788.131 秒 |
| 总 graph build latency | 0 | 1,873.905 ms |
| 用量可能不完整的审查 | 2 | 3 |

上述质量分数仍基于**未经独立人工复核的原始标签**；预测↔golden 由 Codex 比较 claim/trigger/impact 后匹配，不是用户的人工审核。两组均无 clean finding，但 Text clean-guard 为 partial，不能用 FPR=0 宣称所有 clean 审查完成。所有失败保留在分母中。

5 次 partial 均为时间预算耗尽：Text 的 cross-sentinel（无 finding）、clean-guard（已接受空结果）；Graph 的 cross-optional、multihop-units（各有 1 个已接受 finding）、scope-boundary（无 finding）。Graph 查询无故障；partial 中已经接受并持久化的 finding 仍按实际语义计 TP，完整交付另计。两组各发生 10 次被拒绝的 submit_review，原始失败和恢复均保留。

SDK 已报告总 tokens 的 Graph 增幅为 49.3%，**不能当作费用增幅**：input 包含不同量的缓存读取，价格未知；这 5 次中断的最后响应均为 aborted/零 usage，可能遗漏供应商消耗，不填伪造估算。两组都完整交付的 15 对（仅描述成功配对成本，不改变总质量分母）为 320,800 / 453,929 已报告 tokens，均无中断 usage 缺口。

| Trace 指标 | 实测 |
|---|---|
| 使用 Graph 的审查 | 19/20；alias-normalize 没有调用 Graph |
| 首次 Graph 调用位置 | 平均第 7.421 个 tool；序号 5–15 |
| Lookup 成功 / 非空命中 | 29/29 / 29/29 |
| Lookup → neighbors | 13/29，44.8% |
| 非空 neighbors → 后续 read_source | 1/12，8.3% |
| 新 caller 读取 / graph_assisted finding | 0 / 0 |
| Graph 组 finding 归因 | 11 text_only / 0 graph_assisted / 0 ambiguous |
| Graph 返回量 | 51,823 UTF-8 bytes / Unicode 字符；逐工具精确 GLM tokens 不可得 |
| 字符/4 粗估 | 逐 run 向上取整后合计 12,962；不是 GLM tokenizer 或账单 tokens，不包含上下文重复发送 |
| search_text：Text / Graph | 62 / 58 |
| read_source：Text / Graph | 70 / 70 |

唯一 neighbors→read_source 转化出现在 scope-boundary，读取的是已读文件，最后没有 accepted finding。cross-sentinel 虽然只有 Graph 组交付了 finding，但 caller 已由 search_text 发现，lookup 只返回已读函数，neighbors 发生在 caller 读取之后，因此归为 text_only，不能据其跨文件 recall 差异声称 Graph 新发现。multihop-units 的 Graph 返回已读 adapter，后续 service 仍由文本搜索找到。Graph 大多用于既有线索确认；增加 50 次图调用，只少了 4 次搜索、没有减少源码读取，且另多 2 次 diff 调用，净增加 48 个 tool。图构建耗时本身不足以解释全部模型耗时差异。

19 次实际使用 Graph 的审查合计 33 eligible / 33 indexed files、0 parse-incomplete、14 resolved / 0 candidate / 8 unresolved calls；均在逐 case 结果中保存。不调用图时记录的零不表示无依赖。16 次 cold build 为 96.541–157.832 ms（均值 117.119）；cold request 均值 205.656 ms。34 次 warm request 为 82.642–117.695 ms（均值 99.755），包含线程启动和完整性校验；store query 合计 42.938 ms。三个既有 snapshot cache 实际复用，其余按需构建。

单次、固定组顺序和供应商缓存均限制因果解释；同一主机上也运行过后处理开发和本地验证，不是隔离负载的性能基准。此次**未观察到严格 Graph-assisted 增量发现**，不宣称普遍无效。未追加收费重复；后续 Agent 复核发现 r1 标签问题并另冻 r2，不能再把原 gold 称作已验证正确，原分数仅保留历史含义。

全部真实产物位于仓库外 `../output/mergewarden-v02/live-full20-20260920/`：raw、mapping、metrics、trace-analysis、execution-context、e2e-audit、latency-summary、complete-pair-cost 和原生会话。人工审核页在 `../output/mergewarden-v02/human-review-20/review.html`，不展示模型答案；经本人填写并校验后才生成审核 receipt。Graph/parser/resolver 和模型 prompt 未因本次结果修改。

## v0.1 离线实现验证

历史基线：Windows，Node.js 24.12.0、npm 11.6.2、Git 2.53.0。修改前完整 `npm run verify` 退出码 0：

| 检查 | 结果 |
|---|---|
| 核心、快照、引擎和 CLI | 71 passed / 0 failed / 0 skipped |
| Pi 原生 SDK | 14 passed / 0 failed / 0 skipped |
| Python 真 grammar | 5 passed / 0 failed / 0 skipped |
| 类型检查 | 核心、Pi、Tree-sitter 全部通过 |
| demo / status | 成功；明确 synthetic 和真实模型未验收 |

共 **90 项通过**，保留原有 51 项，新增 39 项。没有真实模型调用。

新增国内 BigModel GLM-5.3-Flash 配置；3 项离线测试验证注册、实际 Pi HTTP 请求编解码/工具回合和模拟 401，无真实智谱调用。用户配置步骤见 [真实模型验收指南](LIVE_ACCEPTANCE.md)。

### 新增覆盖

- 12 个快照用例：提交身份、原快照内容、部分暂存、中文重命名/删除、显式未跟踪文件、忽略、冻结竞争、分页/范围、符号链接/二进制、内容/覆盖篡改、目录隔离、原子写失败、BOM/CRLF、unborn HEAD。
- 15 个引擎用例：有证据建议、空差异、缺失最终提交、未读/部分读取/错误 hash/重复提交、部分覆盖、模拟凭据/供应商错误、取消、时间/工具预算、业务日志失败、JSON/Markdown 写失败、交付清单前中断、原快照新 run、并发锁及产物篡改。
- 4 个 Pi 用例：首条 assistant 前持久化及恢复、截断日志后永久失败、**真实 SDK 循环连接离线 provider 替身并交付报告**、原生消息写失败阻止工具执行。
- 1 个报告呈现用例：模型提供的 Markdown 图片、链接和 HTML 均作为文本转义，防止报告打开时加载外部资源。
- 4 个 CLI 用例：帮助/状态、缺少明确凭据、历史/诊断、重复选项及密钥不回显。

错误凭据测试使用模拟异常；还没有向真实供应商发送错误密钥。Pi 循环测试证明业务接线和 SDK 行为，不证明模型质量。报告中断测试是确定性故障注入，不是物理断电或所有文件系统耐久性测试。

### 已准备，未执行

`fixtures/live-v01/fixture.json` 在真实调用前标注了一个 Python 缺陷/修复 smoke 用例；已在本地 `../mergewarden2-live-fixture` 生成三次 Git 提交。只创建样例，未调用模型。

下一步由用户按 [真实模型验收](LIVE_ACCEPTANCE.md) 配置供应商、模型及环境变量。在完成实际审查、证据核对与报告重开前，不打 v0.1.0 标签。

## CI

`.github/workflows/core.yml` 运行 Windows/Linux × Node 22.19.0/24.12.0 的相同验证流程。当前 PR 以其对应的 [GitHub Actions](https://github.com/takagibit18/MergeWarden/actions) 结果为准；本地 Windows 通过不代替 Linux 或 WSL。

M0 历史基线 51 项及首次四组矩阵通过记录：[M0 CI](https://github.com/takagibit18/mergewarden2/actions/runs/35485711680)。

## 依赖和边界

依赖与 lockfile 本轮未更换：Pi 0.84.1；web-tree-sitter 0.27.0；Python grammar 0.25.0、ABI 15，来源/hash 见 grammar lock。

M0 发现的首条 assistant 前延迟持久化已通过公开 API 的独占空文件初始化解决，原行为测试保留。当前强制同步及校验，不宣称 exactly-once 或数据库事务。

v0.2 已实现 Python resolver/SQLite 与 20 个受控案例，BigModel GLM-5.3-Flash 的真实 CLI smoke、4-case 与完整 20-case A/B 详见上方实测；其他供应商未实测。VS Code/VSIX、Windows/WSL 产品验收、独立人工黄金集及 3 对公开项目评测尚未完成。未发布 Marketplace、公共许可证或版本标签。


## LocAgent mechanism challenge · 2026-09-21

实验基线 93d9da8，官方参考 4935b557326c154bad8e8dcf3747cc8d32d1f387。底层 Graph/resolver、r2 corpus、BASE_SYSTEM_PROMPT 和 finding/report 协议保持冻结。八例（5 defect、3 clean）与轮换顺序在新调用前登记；正式 24 次运行固定在 c9584d0，GLM-5.3-Flash、Pi 0.84.1、120 秒、40 tools、8192 max tokens、实际 thinkingLevel=medium。八组三臂实际配置一致（仅能力描述不同），执行前后指纹相同。

| 实测 | T0 | G0 | G1 |
|---|---:|---:|---:|
| TP / FP / FN | 5 / 0 / 0 | 5 / 0 / 0 | 4 / 0 / 1 |
| Precision / Recall / F1 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 0.8 / 0.889 |
| Clean FPR | 0/3 | 0/3 | 0/3 |
| 完整交付 | 7/8 | 4/8 | 5/8 |
| 工具调用 | 85 | 106 | 92 |
| search_text / read_source | 25 / 37 | 28 / 40 | 26 / 40 |
| Graph/retrieval 调用 | 0 | 15 | 6 |
| Graph/retrieval 返回 bytes | 0 | 17194 | 27191 |
| Graph-assisted / novel→source | 0 / 0 | 0 / 0 | 0 / 0 |
| Review latency 总计 ms | 755567 | 846911 | 886303 |

各 arm 均存在中断 usage，因此完整 input/cacheRead/output/total 合计均为 null，不能当零消耗；逐例 SDK 已报告部分仍保留。14 条 accepted finding 的源码 SHA 与 24 份报告独立核验通过；语义匹配由 Codex 基于冻结源码与实际 claim 复核，不冒充独立人工标注。accepted partial finding 保留计分，失败仍在交付分母。G1 的 alias 候选描述正确 bug，但 reviewedPaths 含未变更文件而被拒绝，超时前未修正，最终记 FN。

G1 的 3 次 SearchEntity 均命中，entity/content BM25 各参与 4 个查询阶段，另有 1 次非法 root 的 BM25 候选提示；3 次 traversal 请求深度大于 1，但没有首次返回于深度 >=2 的新实体。真实两跳能力在独立 snapshot smoke 中验证：policy.attempts ← adapter.total_attempts ← service.schedule；3 files、0 parse-incomplete、2 resolved、0 candidate、2 unresolved。该无模型 smoke 的 build 109.569 ms、cold request 238.489 ms、warm requests 130.782–136.405 ms，非大仓性能结论。

首次 ff8c8e1 尝试因遗漏参考 invalid-root BM25 hints 而中断，保留 6 份报告和 1 次未完成尝试，未与正式 24 次混算。正式运行后单独修复大量 warnings 的小输出上限反例，并收紧 hint 曝光的 trace 归因；没有替换模型运行。v2 派生分析不改 raw/native，24 次归因结果全部不变。初次 155 项基线验证及后续本地/CI 日志均保留在仓库外；166 项最终确定性测试覆盖这些边界。

原始、mapping、integrity、v1/v2 分析在仓库外 ../output/locagent-replication/challenge-c9584d0/；机器可读 [fidelity](../eval/locagent/locagent-replication-fidelity.json) 与 [冻结协议](experiments/LOCAGENT_REPLICATION.md) 记录适配。内容分块/预览、JS Snowball、fuzzy 顺序、索引生命周期等不等同原版；这是机制实验，不是论文指标复现。未达到 Stage D 门槛，未执行 20×3，不据此断言 Graph 在真实大仓库无价值。

RealGolden 的确定性验证入口仍为 `npm run verify`。新增检查覆盖 raw Git 父链、缺失对象、真实 SnapshotStore 分页、origin/快照身份、24/16 配额、冗余 approved pool、公开任务隔离、完整 Pi prompt、批跑失败保留/续跑和开放标签 precision bounds。它们不执行目标 Python，也不调用模型。真实 reserve pilot 的 native session、report、锁和成本统计由批跑输出目录保留；正式质量必须另行裁定，不能由静态构图或脚本 provider 成功推断。

RealGolden 模型预算测试通过真实 Pi 请求构造器和离线 HTTP 截获，验证三组实际发送相同的 `max_tokens` / `reasoning_effort`，并核验产品默认 catalog 不变。Pi 客户端 thinking level 与服务端推理档位分别记录；不能仅凭 `medium` 元数据推断服务端收到该设置。预算变更须使用新 reserve 实验锁，正式实验必须沿用已通过 pilot 的模型预算。

## Graph harness / tool-selection fairness 修正 · 2026-09-21

修正前，BASE 使用 `immutable-source tools` 措辞；G0 capability 只笼统描述 Graph，没有写明 `graph_lookup` → `graph_neighbors` 的组合；G1 虽写明 upstream/downstream，但两个 Graph arm 没有共享的结构导航选择政策。同时，任一 Graph error/not_indexed 都会参与 business completion 判定，导致调用可选工具的 G0/G1 承担 T0 不存在的降级风险。旧 reserve v4 的 18 次真实运行中 G0/G1 均为 0 Graph calls；这是旧 harness 结果，不能用来冻结新实现。

修正后，BASE 改为中性 `immutable repository tools`。G0/G1 共享同一 `NAVIGATION_POLICY_PROMPT`：只在活动工具集提供结构能力时，说明 untouched-context trigger、caller/reference/consumer/dependency 发现、anti-confirmation 和 text/source fallback。G0 capability 明确 `graph_lookup` 先精确解析 symbol，再用 `graph_neighbors` 做一跳关系；G1 capability 只保留 `search_entity` / `traverse_graph` 的检索和方向语义。所有描述均保留 `read_source` 证据边界，未强制调用 Graph。

completion 现只依赖最终提交、完整差异覆盖和无 model/timeout/tool-budget 错误等既有业务门槛。Graph/retrieval 失败保留 tool error/warning、报告限制说明与 `metrics.navigation.{attempted,degraded,errors}`；成功 text/source fallback 的 finding 和 zero-finding review 可 completed，而无 submit 或 timeout 仍是 partial。正式批跑使用 `first_attempt`，reserve 仍可 operational retry。盲审包确定性排除 arm、run key、Graph metrics 和 trace，私有映射绑定 prediction/gold hash。

修改前完整 `npm run verify` 通过：核心 135、Pi 18、Tree-sitter 38、RealGolden 构造 20，另有全部类型检查、demo 与 status。修改后完整验证同样通过：核心 142、Pi 18、Tree-sitter 38、RealGolden 构造 20，0 failed/0 skipped，三组 TypeScript 检查、demo 和 status 全部成功。新回归覆盖 prompt 组合、真实 Pi active tools/工具描述、Graph 失败后有 finding/无 finding fallback、无 submit、timeout、T0 不变、Graph 不能成为 evidence、formal first-attempt 及盲审隔离。真实 reserve/formal 冻结产物保留在 checkout 外，不改写旧锁或历史结果。

## v0.2 Scheme A 收官实验 · 2026-09-23

实现固定在 `af9bc9a25b6b04cad78df7ed508ffb3b90cd09a0`。Graph preparation 对 40 个正式任务产生 40 个唯一 generation（31 ready、9 partial），receipt digest 为 `dd8b18dd0bb9b0816e17117c621214bba38a22aa80df8e17da562739055ef415`；正式实验锁状态 READY，策略为 `first_attempt`。8 个固定快照的 G0/G1 热查询共 16 组，全部通过 p95 ≤ 500 ms、max ≤ 2000 ms 门槛，0 error、0 protocol violation；最慢 G1 p95 为 44.83 ms，最慢 G0 p95 为 52.55 ms。

同配置 reserve pilot 为 18/18 完成交付，0 timeout、0 truncation、0 tool-budget error。平均每次结果如下；token 为 SDK 报告的 input + output，不把 cacheRead 再次相加。

| arm | 平均延迟 | 总 token | cacheRead | 工具调用 | Graph 调用 |
|---|---:|---:|---:|---:|---:|
| T0 | 92.35 s | 478,543 | 391,232 | 71 | 0 |
| G0 | 139.32 s | 546,800 | 437,632 | 72 | 0 |
| G1 | 107.95 s | 722,819 | 620,032 | 81 | 0 |

正式计划中的 40 tasks × 3 arms 共 120 个首轮记录全部写入，未留未开始 job；仅 4 completed，116 failed。原生 session 显示所有 116 个失败均包含 BigModel 错误 1113“余额不足或无可用资源包”，其中 7 个在最终错误前还出现 request timeout；runner 的最终 timeout 分类仍为 0。完成数为 T0 1、G0 2、G1 1，整体完整交付率 3.33%。全部 attempts 的延迟 p50/p75/p90/max 为 26.17/31.78/45.90/201.77 s；SDK 报告 input/output 为 261,028/10,254，cacheRead 205,952，工具调用 62。失败 attempt 的 usage 多数不完整，不能把这些合计当作整轮成本或三臂效率结论。

盲审包仅含 1 条 prediction；裁定为 matched，对应 SymPy 根模块 `.stats import *` 遮蔽 Euler 常量 `E`。已裁定 precision 为 1/1，reference recall 为 1/72（1.39%）；按 arm 为 T0 0/24、G0 1/24、G1 0/24。没有 completed clean run，因此 clean FPR 未定义。唯一 finding 只使用文本工具，Graph-assisted 为 0。上述数字描述数据保全情况，不构成 G0 优于其他 arm 或 Graph 无效的证据。

验收结论：Graph 工程与热性能门槛通过，reserve 准入通过，formal 的首轮不可变保全通过；formal 完成率和可比较质量/成本门槛失败。当前实验不得 resume、覆盖或选择性补跑。若补充模型余额后继续，必须新建 successor formal lock 和输出目录，并把本轮作为独立失败实验保留。文档收官后的 `npm run verify` 全部通过：核心 149、Pi 18、Tree-sitter 50、RealGolden 构造 20，共 237/237，另含三组 TypeScript 检查、demo 和 status。完整机器可读产物和五章报告位于 checkout 外 `../output/mergewarden2-v02-closeout-20260923/`。

## Codex 独立复审与外部成熟度对照 · 2026-09-23

Codex 对 RealGolden40 的 40 个唯一 PR 逐例做静态复审，在不读取 gold 的阶段冻结 defect/clean 与 finding，随后统一揭盲裁定。`predictions.blind.jsonl` 的 SHA-256 为 `78367B9F8E112971D784EF1CE29878EC523F5D75D2B6C60CD6345D5886CB9358`。4 个样本可能受早期上下文影响，主结果采用剩余 36 个严格盲样本；完整 40 个样本另列作敏感性参考。

| 口径 | TP / FP / FN / TN | Precision | Recall | F1 | Accuracy / clean FPR |
|---|---:|---:|---:|---:|---:|
| 任务级，盲 36 | 7 / 1 / 13 / 15 | 87.5% | 35.0% | 50.0% | 61.1% / 6.25% |
| Finding 级，盲 36 | 6 / 2 / 14 / — | 75.0% | 30.0% | 42.9% | — |
| Finding 级，全部 40 | 8 / 2 / 16 / — | 80.0% | 33.3% | 47.1% | — |

盲样本中，本地缺陷 task recall 为 50%，finding recall 为 40%；untouched 1-hop 跨文件缺陷的 task/finding recall 均为 12.5%。主要形态是高 precision、低 recall：已报告 finding 多数成立，但跨文件和项目不变量类缺陷漏检明显。复审接口没有暴露可核验的精确 token、逐例延迟和工具调用轮次；整批墙钟约 37 分钟且包含一次中止尝试，不能作为模型性能基准。

外部对照只判断量级，不做排行榜式比较：[S11] 的 Alibaba OpenCodeReview 在 AACR-Bench 上按模型报告 finding F1 17.9%–25.1%、precision 25.2%–37.8%、recall 11.7%–20.0%，但其 benchmark 为 200 个真实 PR、50 个项目、10 种语言，并采用自己的位置/语义匹配协议；本项目样本更小、更窄且 gold 仍主要由 Agent 审核，不能据表面数字宣称领先。[S12] 的 CodeGraph 报告 compiler-oracle 边精度 93.8%–98.7%，who-references precision/recall 0.75/0.87 和约 21 ms 查询延迟；本项目热查询同属实用毫秒级，但没有 compiler-oracle 边精度证明。[S10] 的 LocAgent 报告最高 92.7% file-level localization accuracy 和约 86% 成本下降；本项目只完成机制适配，Graph-assisted finding 仍为 0，不能声称复现其增益。

综合验收为 **实验工程收官 / conditional pass**：Graph 工程、协议、热性能和结果保全通过；独立复审 precision 与 clean FPR 尚可；跨文件 recall、独立人工 holdout、Graph 边正确性基准和 Graph 增量价值仍未达成熟方案证据强度。完整复审与成熟度对照报告位于 checkout 外 `../output/mergewarden2-codex-review-20260923/`。
