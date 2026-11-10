# ADR 0023 — 分层语言包与候选线索

状态：提议（草案）。未实现，未评测。产品默认不变。
基线：`main` `06f63d2`（PR #105，ADR 0022 之后）。
修订：ADR-0002 与 ADR-0014 中"禁止按全仓同名回退"一条的适用范围（见"与既有决策的关系"）。

## 背景

ADR 0022 给建图引入了语言描述符，扩展新语言不再需要改建图主流程。但每种语言仍要写完整的
Extractor（CST → SyntaxFacts，含作用域与绑定）和 Resolver（模块解析 + 导入导出语义）。
TypeScript v1 的粘合代码约 570 行（Extractor 328、Resolver 141、模块适配 48、描述符 52），
另有测试。这条路线精确，但扩展速度受限于手写代码量。

同时，当前图对模型的暴露是"只给确定的部分"：

- `graph_neighbors` 只返回 `relations` 表中的 resolved 边。
- candidate/unresolved 调用点存进了 `dependency_sites`（含 `expression` 与 resolver 给出的
  `candidateTargetIds`），但没有任何工具把它们交给模型。

也就是说，最需要推理的那部分（有歧义的调用）被系统丢掉了，而模型恰恰擅长读源码消歧。

两点观察决定了本 ADR 的方向：

1. **图精度决定成本，不决定正确性。** finding 成立依赖 `read_source` 得到的源码与
   EvidenceRef，而不是图边（ADR-0015）。错误的导航线索让模型多读几个文件，但无法让一个
   没有源码证据的 finding 通过门禁。前提是确定性业务逻辑只使用 resolved 边，且交给模型的
   线索带明确标签。
2. **外部做法与证据。**
   - 主流开源 code graph 工具大多只用 Tree-sitter 抽取名字级定义和引用，再用启发式规则连边，
     由模型消歧，例如 Aider repo map、RepoGraph、codebase-memory-mcp。
   - 精确方案要么依赖编译器或语言服务器（SCIP、Kythe、CodeQL、Serena），要么为每种语言
     手写规则（GitHub stack-graphs，2025-09 归档）。前者需要构建、可能执行仓库代码，
     与 ADR-0009 和不可变快照边界冲突。
   - 语言服务器与 grep 的对照研究显示：语义导航带来的精度收益随 grep 噪声增大而增大，
     名字干净时没有收益；把引用行内联返回能减少后续读取。
   - 多项检索研究认为，结构检索、语义检索和 agent 搜索是互补关系，不能互相替代。
   - 本项目已测得的 Graph 收益（40 PR，F1 67.8% → 77.4%）是在精确解析下得到的，
     名字级导航能保留多少尚未测量。

## 决策

### D1 两层语言包

| 层 | 名称 | 产出 | 每种语言的粘合 |
|---|---|---|---|
| L0 | `names` | file/class/function 实体、调用点、名字；**不产出任何 resolved 边** | 一份项目自有的 Tree-sitter 查询文件 + 文件分类规则 |
| L1 | `precise` | 现有语言包：作用域、模块解析、resolved 边 | 现有 Extractor + Resolver |

- 描述符新增 `tier: "names" | "precise"`。一个路径由拥有它的最高层语言负责。现有的
  Python 与 TypeScript 为 `precise`，行为不变。
- L0 的 `capabilities.relations` 只声明 `CONTAINS`。`CALLS`、`IMPORTS`、`INHERITS` 报告为
  未构建（not built），不能报告为空。调用点照常写入 `dependency_sites`，`resolution` 恒为
  `unresolved`，`ruleSource = "names_tier_unresolved"`。
- L0 不产出作用域与绑定事实，因此永远不会产生 resolved 边。

### D2 L0 查询文件归项目所有

- 查询放在 `integrations/tree-sitter/queries/<language>/tags.scm`，按 `@definition.class`、
  `@definition.function` / `@definition.method`、`@reference.call` 与 `@name` 捕获。
  其他捕获被忽略。
- 不直接使用语法包自带的查询。实测：`tree-sitter-python@0.25.0` 自带的 `tags.scm` 把模块级
  常量也标成定义；`tree-sitter-typescript@0.23.2` 自带的 `tags.scm` 只有 TS 特有的
  签名、接口等少量规则，函数和类的规则要从 JavaScript 语法继承，自带的 `locals.scm`
  只有两行参数定义。直接使用会让覆盖范围取决于第三方包。
- 查询文件的 SHA-256 与语法锁一起进入该语言的 `parser` 版本串，因此改一份查询会改变图身份。
- 查询只在 CST 上匹配，不执行任何仓库代码。查询文件由本项目编写和审查，不来自被审查的仓库。

### D3 候选线索（candidate leads）

候选线索指"某个调用点可能指向某些定义"的提示。线索交给模型，但永远不成为图边。

**来源**，按可信度排列：

1. `resolver_candidate`：L1 resolver 已经给出的 `candidateTargetIds`，例如条件绑定、
   多来源的星号 re-export。
2. `name_match`：调用点的被调名与同一快照、同一 generation 内同名的 class/function 实体匹配。

**生成方式**：

- 线索在**查询时计算**，不写入 `relations`，不参与 generation 的计数与校验。现有 L1 的图内容
  不变；但 D3 新增的 `calleeName` 需要 schema 升版，现有缓存会按新身份重建一次（见"影响"）。
- 被调名由 Extractor 从 CST 取得，存为调用点的新字段 `calleeName`。L0 来自 `@name` 捕获，
  L1 来自现有调用节点。不从 `expression` 文本切分得到。
- 以下 L1 调用点**不产生** `name_match` 线索：在作用域内已经确定是局部绑定、参数或遮蔽的
  （例如 `ruleSource` 为 `shadowed_or_reassigned`），以及外部依赖。具体放行清单在实现时
  逐条列出，并用测试固定。
- 线索只做一跳，不能再以线索为起点遍历出第二跳。
- 扇出上限：一个调用点的 `name_match` 目标超过 `N` 个时（初值 8），不展开，只返回
  "ambiguous: N definitions" 和调用点本身，提示改用 `search_text` 或 `read_source`。

**工具接口**：

- `graph_neighbors` 增加可选参数 `include: "definite" | "leads"`，默认 `"definite"`，
  行为与现状一致。
- `leads` 模式下，结果中的每一项带 `resolution: "candidate"`、`leadSource`
  （`resolver_candidate` | `name_match`）、`candidateCount`，以及调用点所在行的源码文本
  （单行，有长度上限）。
- 工具描述与能力提示补一句：线索不是依赖证明，必须先 `read_source` 才能当作证据。

### D4 确定性逻辑只使用 resolved 边

以下消费者只读 `relations`，忽略线索：

- 变更感知分派（`importTarget`、change-resolution）
- 结构路由与 `dispatch_v1` / `dispatch_v2` 的宿主侧调查
- 覆盖统计与 `partial` 判定
- `graph_assisted` 归因：只有 resolved incoming caller 才能计入；经由线索发现的位置单独
  记为 `lead_assisted`

L0 语言在上述位置都表现为"能力未构建"。导航记录（ADR-0021）可以记录线索查询，但必须
保留 `resolution` 与 `leadSource`，导航视图要把线索和确定边区分显示。

### D5 默认关闭

- `ReviewOptions` 增加 `graphLeads: boolean`（默认 `false`），以及允许启用 L0 语言的开关
  （默认只启用已注册的 L1 语言）。
- 评测与历史重跑保持现状。产品默认要等 D6 的门槛通过后另行决定。

### D6 评测门槛

在现有 40 个真实 PR（Python）语料上做配对评测，指标和判定标准在跑之前冻结：

| 组 | 图 |
|---|---|
| T0 | 纯文本（现有） |
| L1 | 现有 Python 精确包 |
| L1+leads | L1 + D3 线索 |
| L0 | 同一语料用 Python 的 L0 查询建图（关闭 L1），只有线索 |

记录语义审核后的 F1、precision、recall、完整交付率、token、工具调用次数、预算进入
closeout 的次数，以及线索的使用率和转化率（线索 → `read_source` → accepted evidence）。

模型工具与宿主检索共用同一个操作上限（`ReviewBudget`）。线索带来的额外读取可能挤掉其他
调查，表现为精度不变而召回或交付下降，因此只看 precision 不够。

打开 `graphLeads` 必须**同时**满足以下条件，任意一项退步即不开启：

- precision 不低于 `L1`；
- F1 与 recall 均不低于 `L1`；
- 完整交付率不低于 `L1`。

"不低于"允许的噪声幅度（例如按配对样本的差值区间）在运行前写入预注册并冻结，不能看到
结果后再定。

`L0` 与 `L1` 的对比用来决定新语言的策略：预注册一个 F1 差值阈值，差距在阈值内，新语言
只做 L0；超过阈值，按语言的重要程度逐个投入 L1。阈值同样在运行前冻结。

## 不做

- 接入语言服务器或编译器索引。需要构建、可能执行仓库代码；除非将来有独立沙箱的 ADR。
- 在构建阶段按名字连边，或把线索写进 `relations`。
- 新增实体类型或关系类型，或建立跨语言的边（沿用 ADR 0022 D11）。
- L0.5：用 `locals.scm` 驱动 `LexicalBinder`，在 L0 上排除参数和局部遮蔽。这是一个可能把
  L1 Extractor 的一部分换成声明式查询的方向，但现成 `locals.scm` 质量参差，需要单独验证
  后另起 ADR。

## 与既有决策的关系

- ADR-0002 "禁止……仅靠同名连边"：**保持不变**。本 ADR 不连边。
- ADR-0014 "禁止按全仓同名回退补边"：**对边保持不变**。本 ADR 增加一个明确例外：同名关系
  可以作为带 `candidate` 标签的一跳线索，在 `include: "leads"` 时交给模型；它不可遍历，
  不进入确定性逻辑。
- ARCHITECTURE "不能用近似同名目标冒充确定事实"：保持。线索的标签与工具描述保证它
  不冒充事实。
- ADR-0022 D9–D13：保持。D1 只给描述符加 `tier` 字段；L0 语言参与 D12 的身份计算。

## 影响

- `dependency_sites` 增加 `calleeName` 列，schema 升版，现有缓存按新身份重建一次。这会打破
  ADR 0022 D12 的"Python 单语言图逐字节一致"，因此升版必须和本 ADR 的实现放在同一次变更里，
  并在 IMPLEMENTATION_STATUS 记录原因。
- 新语言的最小接入成本变为：一份查询文件、一条语法锁、文件分类规则，加一份一致性测试 fixture。
  L0 语言在一致性测试中应把所有需要 resolved 边的规则声明为不支持。
- 模型会面对更多噪声。线索的扇出上限、默认关闭和 D6 门槛就是为这个风险设置的。

## 未决问题

1. 扇出上限 `N` 的取值，以及是否按文件分类（test/vendor）给 `name_match` 降权或过滤。
2. L0 是否提供基于文件名的 `IMPORTS` 线索（例如按 import 字符串的最后一段匹配文件名），
   还是保持未构建。
3. L1 调用点产生 `name_match` 线索的放行清单。
4. `lead_assisted` 的归因规则是否需要和 `graph_assisted` 一样，要求被发现的位置之前没有
   出现在文本工具的结果里。
5. L0 Python 查询的编写范围：只为评测服务，还是作为正式的回退层保留。
