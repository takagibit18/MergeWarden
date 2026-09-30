# MergeWarden 2

> 面向开发者的 AI 代码审查 CLI：从 Git 变更出发，连接跨文件依赖，将行为风险整理为有源码证据的审查结论。

MergeWarden 在终端中完成代码审查：读取提交差异、暂存区或工作区变更，通过文本搜索与 Python CodeGraph 查找相关上下文，输出包含问题、触发条件、影响和源码位置的 JSON / Markdown 报告。

基于 Pi 的 Agent 运行时，MergeWarden 将代码导航、审查预算、证据校验和报告管理整合在同一条 CLI 工作流中。

[快速开始](#quick-start) · [性能表现](#performance) · [完整评测](docs/experiments/CODE_GRAPH_EVAL.md) · [常用命令](#commands)

Review Skills 可在审查之间从已交付运行和反馈中提炼仓库级检查方法，供后续审查按需读取；质量收益须另行评测。默认行为、反馈、停用、回滚及恢复命令见 [Review Skills 接口](docs/REVIEW_SKILLS.md)。

Codex 可通过本地 STDIO MCP 调用同一套 Pi 审查引擎：启动审查后返回 taskId，查询原生状态与结构化报告，读取 finding 的冻结证据，并查询历史或取消任务。配置与工具说明见 [Codex MCP 接入](integrations/mcp/README.md)。

## 为什么使用 MergeWarden

代码审查不止是检查修改的几行。一次参数调整可能影响调用方，一次继承变化可能破坏子类约定，一次返回值修改可能改变其他模块的行为。MergeWarden 围绕这些依赖关系寻找上下文，并将结论关联到可直接核查的源码。

它适合：

- **提交前审查：** 检查暂存区与已保存的工作区变更。
- **合并前审查：** 比较指定 Git 提交，梳理变更引入的行为风险。
- **跨文件契约检查：** 追踪调用、继承和导入关系，核对调用方与实现是否一致。
- **审查结果复核：** 在终端查看历史报告、读取具体证据，并对同一份代码快照重新审查。

## 核心能力

### 以行为变化为中心的代码审查

Agent 读取差异、搜索相关实现并核对源码，将问题描述、触发条件、严重程度、影响和证据位置组织为结构化 finding。报告同时记录已审查的文件范围，便于开发者结合实际修改逐项确认。

### Python CodeGraph 结构导航

使用 Tree-sitter 解析 Python 代码，组织文件、类、函数及其调用、继承和导入关系。Agent 可以将文本搜索与图查询结合，从变更位置定位相关声明和依赖源码，检查跨文件接口约定。

图按源码快照管理，按需构建并复用 SQLite 索引。图提供导航线索，源码读取提供最终证据；关系查询与文本搜索共同服务于同一次审查。

### 可追溯的源码证据

每条证据关联代码版本、文件路径、行号范围和内容摘要。报告保存后，可以通过 `evidence` 命令重新读取当时的源码，不受后续工作区修改影响。引擎检查引用范围与内容完整性，让审查结论能够回到明确的代码位置。

### 有预算的 Agent 探索

通过时间和工具操作预算控制审查投入，接近上限时进入收尾阶段，为最终报告保留提交空间。原生会话记录工具调用和 Token 用量，便于分析审查过程及成本。

### 完整的本地交付

审查结果以 JSON 和 Markdown 两种格式保存，并附带运行信息。CLI 提供历史查询、证据读取、同快照重跑和运行诊断；退出码区分正常完成、配置错误与未完成审查，方便接入本地脚本。

<a id="performance"></a>

## Code Graph 性能表现

在 **40 个真实 PR、12 个 Python 开源仓库**的 A/B 评测中，对比**基于 Pi 的文本探索基线**与**变更感知 Code Graph 配置**。

复杂依赖与跨文件审查场景的 **10 例 PR** 中，**F1 从 63.6% 提升至 83.3%（+19.7 个百分点）**，同时 **Token 开销降低 18.3%、工具探索轮次减少 19.4%**。

| 评测场景 | 样本数 | F1：文本 → Graph | Token 变化 | 探索轮次变化 |
|---|---:|---:|---:|---:|
| 全部跨文件任务 | 12 | 78.6% → **82.8%** | **−4.5%** | **−8.9%** |
| 核心跨文件依赖 | 9 | 78.3% → **83.3%** | **−9.2%** | **−12.5%** |
| 复杂依赖与跨文件审查 | 10 | 63.6% → **83.3%** | **−18.3%** | **−19.4%** |

全量 40 例的 F1 为 **67.8% → 77.4%**，Precision 为 **80.0% → 85.7%**，Token 增加 19.6%。场景表反映子集表现，指标按经逐条语义审核确认的缺陷统一计分。A/B 共用 Pi 与本项目审查流程，比较 Code Graph 配置的增量表现。

**[查看完整评测：配置、场景选择、样本清单与逐例对比矩阵 →](docs/experiments/CODE_GRAPH_EVAL.md)** · [评测数据](eval/results/code-graph-20260928.json)

## 工作方式

```mermaid
flowchart LR
    A[Git 提交 / 暂存区 / 工作区] --> B[固定审查范围与源码快照]
    B --> C[Pi 审查 Agent]
    C <--> D[差异 / 文本搜索 / 源码读取]
    C <--> E[Python CodeGraph 导航]
    C --> F[提交 findings 与覆盖信息]
    F --> G[证据完整性校验]
    G --> H[JSON / Markdown 报告]
```

审查以只读方式访问代码。模型接入、会话与工具循环由 Pi 承载；MergeWarden 管理源码快照、导航工具、操作预算、证据校验和报告交付。

<a id="quick-start"></a>

## 快速开始

需要 **Node.js 22.19+、Git 和 npm**。在 MergeWarden 项目目录中安装依赖并查看可用模型：

```sh
npm run setup
npm run cli -- help
npm run cli -- models
```

### 1. 配置模型访问

支持 API Key 和 OAuth 登录。使用 OpenAI Codex 的 OAuth 接入时：

```sh
npm run cli -- login --provider openai-codex
npm run cli -- auth-status --provider openai-codex
npm run cli -- models --provider openai-codex
```

按终端提示完成授权，并从模型目录中选择账号可访问的 `MODEL_ID`。

### 2. 审查提交

```sh
npm run cli -- review --repo /path/to/repository --base BASE_SHA --head HEAD_SHA --provider openai-codex --model MODEL_ID --auth oauth
```

将仓库路径、两个提交和模型 ID 替换为实际值。运行结束后，终端输出包含报告路径的 JSON 结果；审查进度单独输出，便于脚本读取结果。

### 3. 查看报告与证据

```sh
npm run cli -- history
npm run cli -- show --run RUN_ID
npm run cli -- evidence --run RUN_ID --finding FINDING_ID
```

`show` 查看已保存报告，`evidence` 读取指定问题关联的源码。

### 使用 API Key

在当前终端中设置 `MERGEWARDEN_API_KEY` 环境变量，再指定供应商和模型：

```sh
npm run cli -- review --repo /path/to/repository --base BASE_SHA --head HEAD_SHA --provider PROVIDER --model MODEL_ID --api-key-env MERGEWARDEN_API_KEY
```

API Key 从明确指定的环境变量读取。OAuth 凭据独立保存在应用数据目录中，并通过 `--auth oauth` 选择使用。

<a id="commands"></a>

## 常用命令

以下示例使用 OAuth；使用 API Key 时，将认证参数替换为 `--api-key-env MERGEWARDEN_API_KEY`，并选择对应的供应商与模型。

### 审查暂存区或工作区

```sh
npm run cli -- review --repo /path/to/repository --scope staged --provider openai-codex --model MODEL_ID --auth oauth
npm run cli -- review --repo /path/to/repository --scope worktree --provider openai-codex --model MODEL_ID --auth oauth
```

`staged` 比较 HEAD 与暂存区；`worktree` 比较 HEAD 与已保存的工作区内容。工作区模式可通过 `--include-untracked PATH` 纳入指定的未跟踪文件，该参数可重复使用；忽略文件不纳入审查。

### 对同一份源码重新审查

```sh
npm run cli -- rerun --repo /path/to/repository --run RUN_ID --provider openai-codex --model MODEL_ID --auth oauth
```

`rerun` 使用原审查快照创建新会话。供应商、模型和推理配置需与原运行一致；原运行显式指定的 `--thinking`、`--max-output-tokens` 参数也应一并传入。

### 命令索引

| 命令 | 用途 |
|---|---|
| `models` | 查看模型目录，可用 `--provider NAME` 筛选 |
| `login` / `auth-status` / `logout` | 管理指定供应商的 OAuth 授权 |
| `review` | 审查提交、暂存区或工作区变更 |
| `history` | 查询已保存的审查记录 |
| `show --run ID` | 查看指定运行的报告 |
| `evidence --run ID --finding ID` | 读取问题关联的源码证据 |
| `rerun --repo PATH --run ID` | 基于原快照重新审查 |
| `doctor --repo PATH` | 检查本地运行状态 |
| `unlock --repo PATH` | 清理已退出进程遗留的运行锁 |

## 审查配置与输出

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--timeout-ms` | `600000` | 单次审查时间预算，单位为毫秒 |
| `--max-tools` | `100` | 单次审查工具操作预算 |
| `--thinking` | 由模型策略决定 | 使用所选模型支持的推理档位 |
| `--max-output-tokens` | `8192` | 模型单次响应的输出预算 |
| `--state` | 应用数据目录 | 保存报告、快照、会话与授权信息 |

输出预算受模型能力约束。Windows 默认数据目录为 `%LOCALAPPDATA%/MergeWarden2`，其他环境为 `~/MergeWarden2`；自定义目录必须位于被审仓库之外。使用自定义目录时，后续查询命令也需传入相同的 `--state PATH`。

每次审查保存：

- **JSON 报告：** 结构化问题、源码证据引用与审查覆盖信息。
- **Markdown 报告：** 便于阅读和分享的问题描述、触发条件、影响与证据。
- **运行信息：** 模型配置、预算、Token 用量与结束状态。
- **会话记录：** 审查过程和工具调用，便于复核与成本分析。

退出码 `0` 表示正常完成、只读查询成功或无变更；`2` 表示输入或持久化错误；`3` 表示审查未完成、失败或取消。

## 只读审查与数据管理

MergeWarden 以只读工具访问被审仓库，不执行项目导入、构建脚本或仓库扩展。代码修改与合并由开发者决定。

报告、源码快照和会话保存在本地应用数据目录。模型审查会将所需代码上下文发送给所选供应商，请按代码的访问要求配置模型与凭据。详见 [安全说明](SECURITY.md)。

## 开发与文档

完整开发验证另需 Python 3.10+：

```sh
npm run verify
```

- [Code Graph 完整评测](docs/experiments/CODE_GRAPH_EVAL.md)
- [评测工具使用说明](eval/README.md)
- [Python 解析与关系导航](integrations/tree-sitter/README.md)
- [Pi 运行时集成](integrations/pi/README.md)
- [变更感知结构调查设计](docs/adr/0017-progressive-structural-investigation.md)
- [开发约定](AGENTS.md)
