# MergeWarden 2

基于 Pi 的只读代码审查引擎。当前在 v0.1 审查闭环上实现 **v0.2 Python CodeGraph 与可复现评测**：同一个 Agent 按需使用文本和图工具，最终 finding 仍引用不可变源码。Graph v4 prepared-only 协议、8 个真实快照热查询门槛和 18/18 reserve pilot 已通过。RealGolden40 正式三臂实验已保留全部 120 个首轮结果，但 BigModel GLM-5.3-Flash 在第 5 次起返回余额/资源包不足，最终仅 4/120 完成交付；这不足以比较 Graph 质量或成本。另行完成的 Codex 独立静态复审在 36 个严格盲样本上得到 finding precision 75.0%、recall 30.0%、F1 42.9%，说明当前结果偏向少报、报准，但它不是三臂实验，也不能证明 Graph 增益。实测范围见 [验证记录](docs/VALIDATION.md)。**尚无证据证明 Graph 提高了审查质量**，v0.2 暂不打版本标签。

## 开始使用

要求 Node.js **22.19+**、Git 和 npm。完整开发验证与真实语料构造工具另需 **Python 3.10+**（仅标准库，不执行被审项目代码）。

```sh
npm run setup
npm run verify
npm run cli -- help
npm run cli -- models
```

安装使用三个锁定依赖文件且禁用安装脚本。测试不需要 API Key，不访问真实模型。`models` 读取固定 Pi 版本内置目录及应用注册的智谱 Flash 配置；目录存在表示接入能力，不表示该供应商已实测。

配置和首次验收见 **[真实模型验收指南](docs/LIVE_ACCEPTANCE.md)**。API Key 只从命令行明确指定的环境变量读取；订阅登录通过 `login --provider openai-codex` 和审查时的 `--auth oauth` 显式启用。复用 Pi 原生授权、凭据存储和刷新，凭据位于数据目录的 `auth/auth.json`；不自动采用仓库配置、`.pi` 或现有 Pi/Codex 登录。

模型接入复用 Pi 原生目录、兼容声明和协议适配器。目录缺失的模型以 Pi 原生格式集中补充在 `integrations/pi/src/model-catalog.ts`；新增供应商无需向审查引擎增加条件分支。正式运行和评测共用 `model-policy.ts` 选择本次策略，不在请求钩子里翻译供应商参数。依赖和补充目录固定版本，运行时不联网刷新目录或读取被审仓库配置。

`review` / `rerun` 可指定 `--thinking low|high|max`（实际可选档位由所选模型决定）及 `--max-output-tokens N`。GLM-5.3-Flash 默认明确使用 `low`，仅支持 `low/high/max`；不支持的显式档位在联网前报错。默认本次输出预算 8192、上下文上限 65536，均不超过模型声明能力；输出预算包含思考，不保证工具调用时间。模型能力与本次预算分别写入运行清单。Pi 原生会话中的 `mergewarden.provider-request.v1` 记录每次最终请求的摘要及非内容参数，不复制消息、源码或密钥。这是发送前观测，不代表服务端已经接受请求。

旧实验的配置和结果保持冻结；使用新模型声明必须重新准备实验锁，不能把旧 `provider-default` 或内部 `medium` 当作新配置继续运行。`eval/budget-gate` 是保留的历史请求对照，其冻结字节约束不适用于新接入配置。离线协议测试不等于新配置已通过真实服务验收。

```sh
npm run cli -- review --repo /path/to/repository --base BASE_SHA --head HEAD_SHA --provider PROVIDER --model MODEL_ID --api-key-env MERGEWARDEN_API_KEY
```

Windows 默认数据目录是 `%LOCALAPPDATA%/MergeWarden2`，其他环境为 `~/MergeWarden2`；可用 `--state PATH` 指定。数据必须位于被审仓库之外。JSON 结果写到标准输出，过程信息写到标准错误。结果为 `completed` 且报告和交付记录保存成功才算完整交付；缺失最终提交、预算耗尽、错误或取消会明确区分。无改动返回 `no_changes`，不创建模型会话。

## 当前模块

| 模块 | 能力 |
|---|---|
| `src/snapshot` | 提交比较、HEAD→index、HEAD→已保存磁盘内容；显式选择未跟踪文件；冻结及复用、源码、差异分页、文本搜索 |
| `src/engine` | 单次审查、最终候选校验、证据完整性、覆盖检查、预算、取消、原快照重跑 |
| `integrations/pi` | 原生会话与业务 CustomEntry、启动前落盘、同步检查、模型工具循环、精确工具白名单 |
| `src/cli` | 审查、模型目录、报告历史、证据读取、环境诊断、死进程遗留锁清理 |
| `integrations/tree-sitter` | 固定 Python grammar → 普通语法事实；file/class/function、import、call 与 inheritance site |
| `src/graph` | LocAgent 风格实体层级；保守作用域/import resolver；core/all HEAD 图；可恢复构建、不可变 SQLite generation、取消、分页与覆盖说明 |
| `eval` / `src/eval` | 冻结受控 r2；独立 RealGolden40 任务/gold/audit；原始 Git 快照、T0/G0/G1 批跑与续跑、开放标签评分及 reserve pilot 准入锁 |

CLI 的 `--scope staged` / `--scope worktree` 已有底层回归测试；VS Code 的选择界面、证据跳转、stale 提示及 Windows/WSL 产品验收留到后续版本。忽略文件和未保存缓冲区不纳入。文本工具不会执行仓库代码。

默认预算 **10 分钟、100 次工具调用**，可用 `--timeout-ms` / `--max-tools` 调整。记录 token 用量，不估算未知价格。候选通过结构和证据 hash 校验后作为人工复核建议保存，这不证明缺陷语义成立。

模型工具和宿主图检索共用操作额度。统一收尾策略 `review-closeout-1` 在默认额度剩 20 次或时间剩 180 秒时提醒，剩 10 次或时间剩 90 秒时关闭新调查，只允许 `submit_review` 提交及校验失败后的修正。被收尾规则拒绝的调查不扣提交保留额度，实际执行的失败提交仍扣额度；硬上限仍为 100 次/600 秒。其他额度按操作上限的 10%（向下取整，至少 1 次、最多 10 次；上限为 1 时不预留）和时间上限的 15%（最多 90 秒）计算保留量，提醒阈值为保留量的两倍。每轮请求记录当前阶段，最终清单记录终止原因；收尾不会补造证据、降低差异覆盖要求或保证模型一定提交，未完成仍为 `partial`。

图工具只有 `graph_lookup`（精确 entity/限定名）和 `graph_neighbors`（指定关系、方向和分页的一跳查询）。实体为 directory/file/class/function，method 作为 function 子类；可遍历关系为 CONTAINS/IMPORTS/CALLS/INHERITS。普通名称引用不建图，应使用 `search_text`。图只索引当前快照的 **head**，不会把 base/head 混在一起。返回 resolution、coverage 和 warnings；空结果不能证明没有调用者。图查询后的 finding 证据仍须用 `read_source` 实际读取和核对。动态 receiver、外部依赖、复杂动态绑定保持不确定；[解析边界](integrations/tree-sitter/README.md)。

图不存在时延迟构建；未调用图工具的审查不会加载 parser 或创建图数据库。默认 `core` 始终纳入 changed Python 与生产代码，排除未变更 test/example/benchmark/generated/vendor；显式 `all` 使用独立缓存身份。schema v4 身份绑定 snapshot、resolver、固定 parser、范围策略与资源预算；v2/v3 缓存不迁移而按新身份重建。提取和关系结果按完整文件保存到不可查询的 checkpoint；最终库只保留紧凑实体、dependency site、聚合关系与逐 site 来源，不重复保存 facts JSON。通过校验后才以不可变 generation + 原子 manifest 发布 ready/partial。损坏 generation 从 checkpoint 有界恢复，确定性容量失败不会被每次查询重复执行。图是可选导航能力：查询失败会在 manifest 和报告摘要中记录 navigation degraded，Agent 可回退到文本/源码工具；已满足差异覆盖、证据和最终提交门槛的 review 不会仅因可选图失败被降级。设计与来源边界见 [ADR-0014](docs/adr/0014.md)。

评测命令见 [评测说明](eval/README.md)。`npm run eval -- --offline --all --output /outside/checkout/eval-run` 运行真实 Pi SDK 加脚本 provider，仅验证工程路径。`--live` 使用固定配置与明确环境变量；逐例语义匹配完成后才能汇总真实质量。Text-only 是内部消融，CLI 产品没有模式切换。

`eval:traces` 从实际工具轨迹派生 finding 的 `discoveryPath`，保留 Graph → 新 caller → 源码读取 → accepted evidence 链，不采信模型自述，也不更改 finding 证据协议。`eval:human-review` 生成不含模型结果的逐例审核页；只有实际人工作答并通过 corpus/SHA 校验，才能生成审核后的 `annotationProvenance`。原始 case 与答案不会被这两个工具改写。

原版 r1 的完整 20-case GLM A/B 已实跑一次：两组按当时标签各命中 11/12 个缺陷，完整交付 Text 18/20、Graph 17/20。50 次 Graph 调用未形成严格的 graph_assisted finding。随后 Agent 源码复核发现一个 clean 反例、接口范围和 severity 问题，已授权修订为独立冻结的 r2；旧语料及分数保留，不作为 r2 成绩。5 次超时请求存在 usage 缺口，tokens 不等于完整计费记录。[版本与修订边界](eval/README.md) · [历史验证与 trace 指标](docs/VALIDATION.md)。

## 验证与后续

- `npm run verify`：核心、CLI、快照、引擎、两个适配器、类型检查及明确标注的 synthetic demo。
- [实现状态](docs/IMPLEMENTATION_STATUS.md) · [验证记录](docs/VALIDATION.md) · [分版本路线](docs/ROADMAP.md) · [决策](docs/DECISIONS.md)。
- [开发约束](AGENTS.md) · [安全边界](SECURITY.md)。仓库保持私有，公共许可证尚未选择。
- [原架构正文](docs/ARCHITECTURE.md) 和 [DOCX](docs/MergeWarden2_Top_Level_Design.docx) 是输入骨架的历史材料；当前实现以状态表为准。

VSIX、WSL 产品验收、独立人工复核的真实项目黄金集及 3 对公开项目提交评测尚未交付。当前 r2 在其模型调用前冻结，但作者已见过 r1 结果，不能称作独立 holdout 或人工标注。没有 Marketplace 发布、自动修复、自动合并、PR 评论或 Jev 调用。


## LocAgent retrieval 内部实验

内部 G1 通过 search_entity（exact／BM25／fuzzy）与受控 traverse_graph 调用同一冻结 Graph，read_source 继续负责 finding evidence。产品仍默认原有图工具；没有新增产品模式。运行方式与适配限制见 [实验协议](docs/experiments/LOCAGENT_REPLICATION.md)。

r2 的 8-case × T0/G0/G1 实测已完成：F1 为 1.00／1.00／0.889，完整交付 7/8／4/8／5/8，Graph-assisted 与 novel→source 均为 0。未达到扩大实验门槛，未执行 full 20×3。该受控小样本不能证明真实大仓库的 Graph 价值；详见 [验证记录](docs/VALIDATION.md)。
