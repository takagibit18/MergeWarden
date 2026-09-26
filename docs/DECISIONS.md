# 顶层决策索引

新增实验契约：[ADR 0017：渐进式结构调查](adr/0017-progressive-structural-investigation.md)。
`dispatch_v2` 已实现稳定调查、多 root、有界候选目录和主 Agent 候选展开。
2026-09-26 工程回归与 Gate 1 通过；Gate 2 公开样本准入上限为 2，未达到 6，模型实验及 Gate 3 未运行。产品默认不变。

新增实验契约：[ADR 0016：规则路由后的宿主结构检索](adr/0016-structural-dispatch.md)。默认 advisory 保持不变，dispatch_v1 仅由显式内部实验配置启用。

“已确定”指讨论中的明确方向，不代表代码实现完成；“待验证”不是默认产品行为。

| ID | 议题 | 状态 |
|---|---|---|
| [ADR-0001](adr/0001.md) | 单一 Agentic Review 与按需图工具 | 已确定（用户方向） |
| [ADR-0002](adr/0002.md) | 真实语法分析与可核验代码关系 | v0.2 Python 全量图与查询已实现；质量增益待评测 |
| [ADR-0003](adr/0003.md) | Pi runtime 与集中业务 Controller | 已确定（底座）；接入待联调 |
| [ADR-0004](adr/0004.md) | 原生 JSONL 与恢复边界 | 已确定（持久化方向）；强保证待验收 |
| [ADR-0005](adr/0005.md) | Finding 提交协议仍需对照 | 待验证；不采纳强制假设草稿 |
| [ADR-0006](adr/0006.md) | Jev 后置与 DecisionAdvisor 扩展点 | 已确定（后置 shadow）；用途待验证 |
| [ADR-0007](adr/0007.md) | 独立引擎与可替换产品入口 | 已确定；VS Code + 独立引擎，保留 CLI |
| [ADR-0008](adr/0008.md) | 不可变快照与版本化证据 | 已采纳；冻结快照已实现 |
| [ADR-0009](adr/0009.md) | 安全与 advisory-only 发布边界 | 已采纳；advisory-only，发布后置 |
| [ADR-0010](adr/0010.md) | 分阶段验收与有限实现范围 | 已确定（交付范围）；产品功能待实现 |
| [ADR-0011](adr/0011.md) | 可复现开发仓库与真实集成 smoke | 已实施（M0）；M1 尚未完成 |
| [ADR-0012](adr/0012.md) | MVP 快照、原生持久化、可靠交付和版本验收 | 已实施 v0.1 离线闭环；真实模型待配置 |
| [ADR-0013](adr/0013.md) | 可恢复图 generation 与严格停止 | 已实施；实体图语义层见 ADR-0014 |
| [ADR-0014](adr/0014.md) | LocAgent 风格实体图与分层范围 | 已实施；真实仓库容量已测，质量增益未证明 |
