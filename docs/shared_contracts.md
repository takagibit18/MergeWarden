# 共同确认的接口与协议

本文档列出 **Analyzer Agent** 与 **Integration Agent**（及编排层）在实现前或变更时需要 **对齐并共同维护** 的契约。重大变更应先更新本文档或关联 Issue，再改代码。

**相关文档**：[README](../README.md)、[CONTRIBUTING](../CONTRIBUTING.md)、[architecture](./architecture.md)、[长期设计记录](./design_decisions.md)、execute 工具专项 [execute_tools_design.md](./execute_tools_design.md)、编排与安全契约 [cli_tools_orchestrator_contract.md](./cli_tools_orchestrator_contract.md)、Agent 约束 [agent.md](../agent.md)。

---

## 1. 分层责任边界

### v3 收尾与 repair 交接补充（2026-09-10）

- semantic repair 合并只是暂存：任一合并失败或目标未实际修复，整批不得提交 registry，不得登记成功或启动成功后的独立重审；未改变但 integrity 合法的原内容不是修复成功证据。

- v3 轮数上限限制 Reviewer 主循环，不强制占用最后一轮作为模型提交仪式；在剩余资源允许时，最后一轮仍可调查、保存或修订。停止后由运行时交接 Registry 当前内容，不得用 summary 推断或补造 finding。此约定于 2026-09-11 替代此前的“末轮必须 save+finish”。
- repair 的目标及具体请求作为独立、不可静默裁剪的交接消息，不与普通证据摘要争抢展示空间；未知句柄仍拒绝，不自动猜测映射。
- Verifier schema 与运行时均允许 `unresolved`。校验失败仅记录字段位置和错误类型，不记录字段内容或隐藏推理；格式失败不得成为批准。

| 区域 | 主要职责 | 典型路径 |
|------|----------|----------|
| 入口 | 解析用户输入、展示结果 | `cli.py` |
| 编排 | 5 阶段循环、串联状态与工具 | `src/orchestrator/` |
| 分析 | 推理、格式化报告、状态模型定义 | `src/analyzer/` |
| 工具 | 注册、Schema、具体读写与执行 | `src/tools/`、`src/security/` |
| 模型 | LLM 调用与 Provider 抽象 | `src/models/` |
| 配置 | 环境变量与全局设置 | `src/config.py` |

**共同原则**：模块间交互以 **Pydantic 模型** 与 **明确的工具契约** 为准；避免在未协商的情况下修改对方依赖的字段名或语义。

---

## 2. 工具层协议（Tool Calling）

实现参考：`src/tools/base.py`。

### 2.1 安全分级 `ToolSafety`

| 取值 | 含义 | 执行策略（约定） |
|------|------|------------------|
| `readonly` | 无副作用读操作 | 可并发；无需用户确认 |
| `write` | 写文件或改仓库 | 串行；需确认或隔离策略 |
| `execute` | 运行命令 | 沙箱、超时、工作目录限制；见 `src/security/` |

新增工具时必须选定一级，并在 PR 中说明理由。

**Execute 工具清单与可见性**：当前实现了 `run_command`（通用，首词白名单 + `shlex` argv 化 + `shell=False`）与 `run_tests`（`pytest`/`unittest` 便捷封装）。两者均走同一 `src/security/exec_policy.py` + `src/security/backends.py` 管道。**仅 Debug 模式**通过 `create_default_registry(include_execute=True)` 暴露给模型；Review 模式不暴露 execute 工具。策略违规统一抛 `CommandNotAllowedError(ToolError)`，经高危门控拒绝/未通过 policy 时均在 `ContextState.errors` 中以 `category="security"` 记录。

### 2.2 工具规格 `ToolSpec`

- `name`：全局唯一，与注册表键一致。
- `description`：供模型与用户理解的说明。
- `parameters`：JSON-Schema 风格字典，描述调用参数（与 `execute(**kwargs)` 对齐）。
- `safety`：上述 `ToolSafety`。

### 2.3 抽象基类 `BaseTool`

- `spec() -> ToolSpec`：必须实现。
- `async execute(**kwargs) -> Any`：必须实现；返回值应可被序列化进日志/状态（避免不可 JSON 的对象除非约定）。
- `is_enabled() -> bool`：默认 `True`；环境不满足时可禁用。
- `is_concurrency_safe() -> bool`：默认与 `safety == READONLY` 一致；若只读工具仍不可并发，可覆盖并说明。

### 2.4 `ToolRegistry`

- `register` / `get` / `list_specs` 为编排层与推理侧获取「当前可用工具列表」的 **唯一推荐入口**。
- 新增或重命名工具时，需同步更新评测与文档中的工具清单（如有）。

---

## 3. 会话状态协议（Context State）

实现参考：`src/analyzer/context_state.py`。

### 3.1 `ContextState`

单次运行（review 或 debug）共享一份实例，由编排层创建并传入各阶段。

| 字段 | 说明 |
|------|------|
| `goal` | 当前任务目标 |
| `constraints` | 活跃约束（如「仅看 diff」「禁止写盘」） |
| `decisions` | `DecisionStep` 列表，决策历史 |
| `current_files` | 当前关注文件路径 |
| `errors` | `ErrorDetail` 列表 |

### 3.2 `DecisionStep`

| 字段 | 说明 |
|------|------|
| `phase` | 产生该记录的 agent 阶段标识 |
| `action` | 决定或执行的内容摘要 |
| `result` | 结果或观察 |

**约定**：`phase` 的取值集合应与 5 阶段命名一致（或维护枚举），便于日志与评测解析。

### 3.3 `ErrorDetail`

| 字段 | 说明 |
|------|------|
| `file` | 相关文件路径，可为空 |
| `line` | 行号，可选 |
| `message` | 错误描述 |
| `category` | 如 `syntax` \| `runtime` \| `logic` \| `style` \| `security` \| `unknown` |

扩展 `category` 枚举时需双方同意，并更新评测期望（如有）。

---

## 4. Review 结构化输出协议

实现参考：`src/analyzer/output_formatter.py`。

### 4.1 `Severity`

`critical` | `warning` | `info` | `style`（枚举值与 JSON 序列化一致）。

### 4.2 `ReviewIssue`（单条发现）

| 字段 | 类型 | 说明 |
|------|------|------|
| `severity` | `Severity` | 严重级别 |
| `location` | `str` | Review 模式下应为 changed line / changed hunk 的 canonical `path[:line[-end_line]]`；未变更文件只能作为 evidence 上下文，不能作为默认 inline comment 目标 |
| `evidence` | `str` | 代码片段或观察依据 |
| `suggestion` | `str` | 修复或行动建议 |
| `confidence` | `float` | `0.0`–`1.0`，模型置信度 |

### 4.2.1 Finding v2 canonical contract

`ReviewIssue` 保留上述 v0 字段，但只要 payload 出现结构化字段，就必须按
使用 v2 核心字段或显式 `schema_version="2.0"` 时进入 canonical contract；不能通过
省略版本号或填写 `1.0` 让完整结构化载荷回退到旧路径。仅供 legacy policy 入口
使用的 `cause_evidence` changed-line 锚点保持兼容。结构化风险 finding 必须同时包含：

- `finding_id`、`primary_anchor`、可选 `related_locations`；`location` 必须与主锚点一致；
- `observed_behavior`、`causal_mechanism`、`violated_invariant`、`trigger`、`impact`、`repair_intent`；
- `cause_evidence`、`contract_evidence`、`trigger_evidence`、`impact_evidence` 与逐角色 `supports`；
- 每个 evidence ref 必须指向同一 finding 的已交付 evidence ledger artifact，且 side、snapshot、revision、context hash 与 ledger 一致。

`src/analyzer/finding_contract.py` 是 producer payload、`ReviewIssue`、
`FindingDraft` 与 verifier 之间的唯一适配边界。严格 contract gap 与 evidence
identity gap 都是拒绝/待修复原因；它们不能由置信度、同文件近邻或模型自填的
provenance 字段绕过。

Review findings are advisory by contract. Downstream GitHub integrations may
publish them as comments, summaries, or soft checks, but hard merge blocking
remains the responsibility of GitHub CI / branch protection unless a future
product decision explicitly changes that boundary.

Phase 2 GitHub publishing starts with GitHub Actions. `github-advisory publish`
uses the existing `ReviewResponse` plus changed-line metadata to create a neutral
check run and advisory inline comments. Inline comments remain restricted to
changed lines; all other findings stay in the check summary.

### 4.3 `ReviewReport`（单次 review 汇总）

| 字段 | 类型 | 说明 |
|------|------|------|
| `issues` | `list[ReviewIssue]` | 问题列表 |
| `summary` | `str` | 可选总述 |

CLI、FastAPI 与 CI 校验应只依赖上述稳定字段；**增删字段** 需走共同评审。

---

## 5. Debug 结构化输出协议（已定稿并已落地）

实现参考：`src/analyzer/schemas.py`（`DebugStep`、`SuggestedCommand`、`DebugResponse`）。

产品目标见 [README](../README.md)（假设 → 验证步骤 → 建议补丁等）。字段与 [cli_tools_orchestrator_contract.md](./cli_tools_orchestrator_contract.md) §6 一致。

- `DebugStep`：`title`、`detail`、`location`、`evidence`、`confidence`（与 `ReviewIssue` 在 location / evidence / confidence 语义上对齐）。
- `SuggestedCommand`：`command`、`rationale`、`risk`（`low` | `medium` | `high`）；仅表示建议，不代表已执行。
- `DebugResponse`：`run_id`、`summary`、`hypotheses`、`steps`、`suggested_commands`、`suggested_patch`、`context`。

**变更约定**：增删字段需双方评审并同步契约文档。

---

## 6. 配置与环境变量协议

### 模型接收观测（2026-09-11，仅检测）

2026-09-11 输出上限映射修正：仅 `dashscope / kimi-k3` 将内部
`ModelConfig.max_tokens` 映射为 wire `max_completion_tokens`，不同时发送
`max_tokens`。该值限制思考与回答总量，不是独立CoT上限；内部预算、请求估算、
请求哈希仍使用统一RequestAssembler。其他模型映射不变。此修正不改变默认数值、
超时或审查逻辑。依据：百炼OpenAI兼容Chat参数文档。

`MODEL_REQUEST_LOG_DIR` 默认为调用进程 cwd 下的 `.mergewarden/model_requests`。
每次真正进入 SDK 的 attempt 对应一个随机 observation ID 与独立 JSONL 文件；
该 ID 随既有 attempt telemetry 返回，结合 request_hash 关联所属审查阶段。
各生命周期事件关闭文件并 flush，供运行中读取；不承诺掉电 fsync 持久性。
日志失败时仅警告并返回 write_failed 标志，不修改请求、超时、预算或业务判断。

| event / phase | 含义与边界 |
|---|---|
| attempt_started / sdk_entered | 已准备进入 SDK，不能据此声称服务收到请求 |
| response_headers | 收到 HTTP 状态与允许格式的 request ID，不记录完整 headers |
| first_body / receiving_body | 收到首个非空原始字节块，不等于首个语义 token |
| body_progress | 有新数据时最多每5秒落一条累计 bytes/chunks，非 token 统计 |
| body_received | 原响应体已完整读完 |
| sdk_returned | SDK 已完成响应处理，即将由项目解析 |
| response_parsed | 项目解析结束；记录 finish_reason、usage 是否存在、正文长度与工具数量，不记录内容 |
| attempt_finished | 成功/错误/取消与最后阶段、空闲时间；unknown usage 仍由原账本表示 |

观测不改变 stream 参数、不解析或持久化隐藏推理、不提前执行部分工具调用。
对于非流式 provider，响应头/正文可能直到生成结束才到达；不能据此断言模型未生成。
五秒进度仅在字节到达时触发，不是无数据心跳；静默期间通过最后事件与超时终态判断。
目录不会自动清理，需由运行环境制定留存策略，本轮不删除历史日志。

百炼 `dashscope / kimi-k3` 的 wire profile 使用固定 `temperature=1.0`、
`top_p=0.95`，思考不可关闭；工具对话保留 reasoning replay。该约束由模型兼容层
和统一 RequestAssembler 应用，预算估算、请求哈希与实际发送内容一致，不新增环境变量。
其他 provider/model 的采样行为不变。A/B 实验须记录此有效采样配置，而非声称温度为零。
依据：https://help.aliyun.com/zh/model-studio/kimi-api （2026-09-11 核对）。

实现参考：`src/config.py`。

| 变量 / 字段 | 含义 | 备注 |
|-------------|------|------|
| `OPENAI_API_KEY` | API 密钥 | 勿提交仓库 |
| `OPENAI_BASE_URL` | 兼容 API 基地址 | 默认 OpenAI 官方 |
| `MODEL_NAME` | 默认模型名 | 变更时评测基线可能需重跑 |
| `LOG_LEVEL` | 日志级别 | 与可观测性约定一致 |
| `REVIEW_MAX_ITERATIONS` | Review 模式最大循环轮次 | 默认 `1`，对应 `Settings.review_max_iterations` |
| `DEBUG_MAX_ITERATIONS` | Debug 模式最大循环轮次 | 默认 `3`，对应 `Settings.debug_max_iterations` |
| `TOKEN_BUDGET` | 单次运行累计 token 用量软上限（soft cap） | 默认 `30000`，对应 `Settings.token_budget`；达到后停止普通分析，仍可使用受保护预留执行 finalize-only 提交 |
| `TOKEN_HARD_BUDGET` | 单次运行累计 token 用量硬上限（hard cap） | 默认 `36000`，对应 `Settings.token_hard_budget`；不低于 `TOKEN_BUDGET` |
| `PROMPT_INPUT_TOKEN_BUDGET` | 每次模型请求中 **可截断上下文块**（meta、diff hunk、graph manifest、文件、结构等）的估算 token 上限 | 默认 `32000`，对应 `Settings.prompt_input_token_budget`；graph manifest 不得绕过该预算追加到 payload |
| `FINAL_SUBMIT_RESERVE_TOKENS` | 从 hard budget 中保护的最终结构化提交预留 | 默认 `12000`；普通分析的有效上限为 `min(TOKEN_BUDGET, TOKEN_HARD_BUDGET - reserve)` |
| `FINAL_SUBMIT_PROMPT_TOKEN_BUDGET` | finalize-only 请求可使用的可截断上下文预算 | 默认 `4000`；两种 context mode 以及 Review/Debug 共用该上限 |
| `FINAL_SUBMIT_FEEDBACK_TOKEN_BUDGET` | finalize-only 请求中为去重后的工具证据与 prior-analysis concern 摘要保留的预算 | 默认 `1200`，包含在 `FINAL_SUBMIT_PROMPT_TOKEN_BUDGET` 内；默认剩余 `2800` 给基础上下文 |
| `MODEL_MAX_TOKENS` | 非 finalize 模型调用的最大输出 token | 默认 `2048`，对应 `Settings.model_max_tokens` |

GitHub advisory workflows should set `MODEL_MAX_TOKENS` explicitly, with
`8192` as the current CI default, because the global runtime default remains
conservative for local runs. CI should also keep `PROMPT_INPUT_TOKEN_BUDGET`
and automatic file-context caps bounded so large PRs prefer targeted tools such
as `get_changed_context` / `find_symbol_context` over large preloaded prompts.
| `MODEL_REQUEST_TIMEOUT_SECONDS` | 单次模型 provider 调用的硬超时 | 默认 `60`，对应 `Settings.model_request_timeout_seconds` |
| `MODEL_MAX_RETRIES` | 单次逻辑模型调用的最大尝试次数 | 默认 `1`，对应 `Settings.model_max_retries` |
| `FINAL_SUBMIT_REQUEST_TOKEN_BUDGET` | 完整 finalize/schema-repair provider request（消息、历史、工具 schema 与 provider 控制）的硬上限 | 默认 `8000`；由 RequestAssembler 在实际序列化 payload 上执行 |
| `ASSEMBLED_REQUEST_TOKEN_BUDGET` | 非 finalize provider request 的完整序列化输入硬上限 | 默认 `36000`；与 final submit 使用同一 envelope 口径 |
| `REVIEW_REPAIR_MAX_ATTEMPTS` | 单份报告共享的 schema validation repair + integrity guard repair 次数 | 默认 `1`；本地字段转换不计入，schema 与 guard 不能各自重置额度 |
| `AGENT_RUN_TIMEOUT_SECONDS` | 单次编排运行的总墙钟截止线 | 默认 `170`，对应 `Settings.agent_run_timeout_seconds` |
| `REVIEW_WORKFLOW_ENFORCEMENT` | Review required-step 门控模式 | `off` / `warn` / `enforce`；v0.2.0 默认 `enforce` |
| `EVENT_LOG_DIR` | 事件 JSONL 日志目录 | 默认 `.mergewarden/logs`；相对路径时相对于 `repo_path` 解析，见编排层实现 |
| `GITHUB_TOKEN` / `GH_TOKEN` / `github_token` | GitHub API token | GitHub Actions publish mode needs `checks:write` and `pull-requests:write`; dry-run does not need a token |
| `GITHUB_ADVISORY_DRY_RUN` | GitHub advisory default publish mode | Default `true`; CLI `--publish` can override and perform real GitHub writes |
| `GITHUB_ADVISORY_COMMENT_MARKER` | MergeWarden comment marker | Default `<!-- mergewarden:comment -->`; used to update/mark only MergeWarden-owned comments |
| `PERMISSION_MODE` | 权限模式（`default` \| `plan`） | 默认 `default`；`plan` 模式禁止执行工具，仅生成计划与结构化输出 |
| `CI` | 常见 CI 环境变量 | 设为 `true`/`1`/`yes` 时，编排层对 `write`/`execute` 工具默认拒绝（与 [cli_tools_orchestrator_contract.md](./cli_tools_orchestrator_contract.md) §11 一致） |
| `EXECUTE_ENABLED` | execute 类工具全局开关 | 默认 `true`；置 `false` 时即便 Debug 模式也不注册 `run_command` / `run_tests` |
| `EXECUTE_BACKEND` | execute 工具后端实现 | `subprocess`（默认）/ `docker`（本地 `docker run` 后端，挂载统一 workspace root） |
| `EXECUTE_ALLOWED_COMMANDS` | `run_command` 首词白名单 | 逗号分隔；默认 `python,pytest,pip,node,npm,ruff,mypy,git`；`git` 子命令再限于 `status/diff/log/show/rev-parse` |
| `EXECUTE_DEFAULT_TIMEOUT_MS` | execute 工具默认超时 | 默认 `30000`，可由工具入参覆盖 |
| `EXECUTE_MAX_OUTPUT_BYTES` | stdout/stderr 各自字节上限 | 默认 `65536`；超限时截断并置 `SandboxResult.*_truncated=True` |
| `EXECUTE_DOCKER_IMAGE` | Docker execute 后端镜像 | 默认 `mergewarden-execute:latest`；需先构建 `Dockerfile.execute` |
| `EXECUTE_DOCKER_WORKDIR` | 容器内 workspace 挂载目录 | 默认 `/workspace`；容器 cwd 按宿主 cwd 相对 workspace 映射 |
| `EXECUTE_DOCKER_NETWORK` | Docker execute 网络模式 | 默认 `none` |
| `EXECUTE_DOCKER_MEMORY_MB` | Docker execute 内存限制 | 默认 `0`，表示不设置限制 |
| `EXECUTE_DOCKER_CPUS` | Docker execute CPU 限制 | 默认 `0`，表示不设置限制 |
| `RUN_CHECKPOINTS_ENABLED` | Platform worker checkpoint 开关 | 默认 `true` |
| `RUN_LEASE_SECONDS` | worker run lease 时长 | 默认 `180`，范围 `30..3600` 秒 |
| `RUN_HEARTBEAT_SECONDS` | worker 续租间隔 | 默认 `30`，范围 `1..300` 秒 |

新增全局配置项时，应更新 `Settings`、`.env.example`（如有）及本文档或 README。

---

## 7. 单次运行（Run）与可观测性

与 [architecture](./architecture.md) 中 Observability 一致，**建议在实现编排层时** 共同确认：

| 项目 | 约定 |
|------|------|
| `run_id` | 每次 CLI/调用生成的唯一标识，写入日志与可选 artifact |
| 记录内容 | 工具调用序列、关键中间结果、耗时、token 用量 |
| 输入快照 | 是否落盘脱敏后的 prompt/输出以便复盘（路径与保留策略） |
| `RunSummary` | Runtime summary in `src/analyzer/run_summary.py`; includes event-log status, model/token, tool counts, budget/stop state, submit validation errors, and publish status |
| Finding verification | `FindingCandidate` 使用稳定 digest id；风险 finding 的 verifier verdict、reason code 和 evidence repair round 写入 event log。确定性拒绝另写入 `deterministic_rejection_details`，逐条记录 candidate/finding、evidence role/index、retrieval source、文件/行号、失败字段、具体规则及是否为 revised finding |
| Review Workflow | required/completed/missing step、reprompt count 和 enforcement mode 写入 `workflow_summary` |
| Worker recovery | `review_runs` 保存 lease/heartbeat/attempt；`run_checkpoints` 保存步骤 attempt 和 artifact 路径 |
| Agent run journal | `.mergewarden/runs/<run_id>/journal.jsonl` 保存 append-only、可恢复的 `model_response`、`tool_result`、`draft_finding` 与 `length_recovery` 事实；它与 EventLog 的 observability 职责严格分离 |
| Evidence ledger | `ContextState.evidence_ledger` 只登记成功 provider request 中实际出现的完整 diff/file/tool/manifest body；每条记录保留 artifact、path/range、side、snapshot、revision、hash、source tool call 与 lifecycle |
| Finding funnel | `finding_funnel_completed` 独立记录 logical/submitted/provider/policy/risk/integrity/repair/evidence/final counters；这些计数不可用单一“accepted”字段相加替代 |
| `RunArtifactSummary` | Artifact-facing CLI/API summary for response JSON, publish result JSON, event log, and related paths |

具体字段若在代码中以 `RunContext` 等模型出现，应在该类型旁或本文档交叉引用。

---

## 8. Prompt 与 JSON Schema

以下由 **双方共同设计、变更需评审**：

- 系统提示词与分析/调试任务模板；
- 面向模型的 **工具列表** 与 **输出格式** 说明（须与第 2、4、5 节一致）；
- 任何「强制 JSON」或 function-calling 的 schema 版本。

Review 正常分析阶段可额外暴露编排层伪工具 `record_draft_finding`。模型输入
严格限于 `file`、`claim` 与可选 `line`/`symbol`；`id`、
`source_response_id` 由 runtime 绑定。该对象只表示待验证假设，不包含 severity、
confidence、root cause、impact、evidence/verifier/candidate 字段，也不能绕过
`submit_review` 或后续 verifier 合同。

### 8.1 Finding delivery v4：format recovery、finalization 与 patch-only repair

| 事务 | 模型可提供 | runtime 必须持有 | 成功条件 |
|------|------|------|------|
| format recovery | 仅结构化格式恢复 | 原始 response id、raw payload、candidate identity、delivered evidence ledger | semantic/evidence/reference/identity 与原始输入一致；否则保留原始输入并记 `rejected_preserved_input` |
| finalization | 仅 `submit_review` / `submit_debug` | exploration stop reason、pending draft、最终 submit response | 一次 submit-only 调用后，provisional `max_iterations` 等原因清除，draft 有终态，最终响应成为发布权威 |
| repair (v2 compatibility) | `target_candidate_id`、`candidate_content_version`、`repair_status`、`repair_reason`、`repair_patch` | CandidateRegistry、原 finding、基础版本、完整 gap、共享 repair transaction | target/version 精确匹配；patch 合并后重新通过 canonical contract 与 integrity guard |
| repair (v3) | opaque `target_handle`、`repair_status`、`repair_reason`、`repair_patch` | runtime transaction 持有 candidate、基础内容版本、证据上下文和 handle 绑定 | handle 必须属于当前事务；runtime 校验基础版本并原子应用 patch，再通过 integrity 与独立 semantic 重审；模型不接触 content version |
| publish | 已验证最终 candidate | final guard status、serialized delivered evidence、finding finalization journal | `integrity=verified` 且 `final_published_count` 与最终 candidate 状态一致 |

repair payload 禁止重复携带完整 semantic/evidence 顶层字段；`repaired` 必须有
非空 `repair_patch`，省略字段由 runtime 从原候选继承。unknown、duplicate、
cross-candidate、passed、旧 version 和伪造 identity 都必须拒绝，不能用 nearest
candidate 或模型自填 finding/Graph/hash/revision 代替 runtime identity。所有
format/source/contract/evidence repair 共用一份报告级额度。

探索 iteration guard 只表示普通探索停止，不表示交付失败；如果没有硬阻断，
编排层必须给 submit-only finalization 一次有界机会。只有 finalization 已提交、
没有 incomplete draft、integrity 没有 needs-repair/invalid 且没有 provider hard
failure 时，才能清除 placeholder 遗留的 completion incomplete 状态。`review_complete`
和 `delivery_complete` 仍是两个字段；后者必须在 `finding_funnel_completed`、
`finding_finalization` 与最终 response 中保持一致。

评测 validation 配置如需固定 provider，必须显式记录 `provider` 与非敏感
`base_url`；API key 仍只能来自运行环境，不得进入 YAML、summary 或 journal。

## 11. Harness slimming v3（2026-09-10）

### 11.1 Model wire contract

v3 模型输入由 `ModelFindingInputV3` 固定为四个必填字段：
`anchor`、`description`、`evidence_refs`、`severity`；`suggestion` 与
`related_locations` 可选。模型不得填写 confidence、五段 narrative、role
support、repair intent、candidate/version/provenance 或 snapshot/hash。版本由
runtime 注入，当前通过 `FINDING_CONTRACT_VERSION=3.0` 选择。

`ReviewIssue` 的旧字段只存在于兼容适配与历史消费者边界。v3 对外使用
`contract_payload()`；该路径不输出 fake confidence，也不把 description 复制回
旧 narrative。未知、未送达、过期或重复 evidence ref 保留为明确 integrity gap，
不能邻近替换。

### 11.2 Authority and lifecycle

`CandidateRegistry` 是 run-scoped 的唯一可变 finding authority：

| Action | Input | Runtime result |
|---|---|---|
| `save_finding` | 一份初始正文 | 新 candidate、内容版本、机械缺口 |
| `revise_finding` | opaque handle + patch | runtime 将 handle 绑定到当前版本；过期 handle 原子拒绝，模型不搬运 content version |
| `finish_review` | 可选摘要，无 finding 正文 | Reviewer 主动请求停止探索；非候选交接前提，不代表已接受 |
| `repair_review` | active transaction 的 opaque patch | 只合并显式字段，再跑完整 integrity |

candidate identity、content version、evidence digest、semantic receipt 和发布状态
分别由 runtime 持有。`finish_review`、`report_ready`、`external_publish_status`
不能互相代替。

#### 11.2.1 Runtime closeout（2026-09-11 实施契约）

正常停止、轮数上限或探索软预算触发统一、幂等的运行时收尾。已成功保存/修订的
Registry 当前版本是 integrity 与独立 semantic 的输入，不依赖最后一次模型响应
是否包含 finish，也不额外请求模型搬运全文或补结束信号。不得伪造模型工具事件。
未 finish 不是候选丢失理由；未验证内容不是已批准报告。有限停止保留受限原因，
可生成已批准部分报告，但本轮不放宽 report_ready 与外部发布门。

已有候选后正常自然停止，且没有轮数、预算、错误或未决约束，可在双门通过后完整
交付；不能继续把 finish 当作完成许可。无候选且无主动 finish 的自然文本停止不等于
完整无问题报告。触及轮数/额度等限制时，即使候选被批准，仍保留受限原因。

| 字段/概念 | 定义 |
|---|---|
| 模型 finish 审计 | 仅记录模型真实主动停止动作 |
| submission_received | v2 为实际结构化提交；v3 为运行时已接收 Registry 候选集合的交接，不表示模型调用过 finish |
| completion_status=incomplete | 受限终止、错误或未决候选仍妨碍完整交付；允许保留已批准的部分成果 |
| report_ready / delivery_complete | 必须同时满足完整性、独立复核与完整交付条件，不由 closeout 快照直接置真 |
| 探索软预算 | 停止探索；后处理仍可消费受保护的全局硬预算余额 |
| 全局硬预算/硬超时/用户取消 | 不启动新的模型调用，仅保存已完成动作与审计现场 |

reserve 服务于独立复核及必要的修订重审，不能被一轮补 finish 消耗。所有阶段共用
硬 Token/时间账本，模型发送前输入加输出上限不得超过剩余额度。正常评估使用
16 轮上限；1/3 轮作为单独压力用例，不要求模型用满轮数。v2/debug 路径保留兼容。

v3 工具回执必须与实际 provider tool-call ID 机械配对；解析后的动作如丢失传输 ID，
不得用另一个合成 ID 代替后声称回执已送达。允许内部 AnalysisPlan 保存最小动作
关联信息，不向模型 finding 增加字段。多 save、无效动作后有效动作及混合动作都必须
保持准确配对；仅在离线直接构造计划、确无 provider 调用时才可使用明确的合成审计 ID。

#### 11.2.2 Reviewer finding 粒度（2026-09-11）

普通 v3 Reviewer 按独立缺陷机制组织 finding，而不是按 diff hunk 数量组织。
同一因果机制且同一类修复的多个出现位置，使用一个主 anchor，并用
related_locations 保留其他位置。独立原因仍分开；同文件、同函数或类似措辞
本身不是合并理由，不确定是否同因时不强行合并。这是模型的语义组织原则，
不增加字段、词法判定或运行时自动合并。

新位置或证据属于已保存 finding 的同一原因时，优先用当前 opaque handle
调用 revise_finding 修订该 finding，而不是再次 save。patch 中的数组仍是替换
语义：更新 evidence_refs / related_locations 时保留需继续支持原结论的已有项，
省略字段保持原值；不得假设只提供新增项会自动追加，也不得编造遗失的引用。
无需为整理粒度新增一轮调查或强制 finish。独立 Verifier、批准绑定与 v3
旧合并器隔离保持不变；已经分别保存的多条候选不会因此自动合并。

### 11.3 Independent semantic verification

v3 的 `request` 是具体修订需求/未决问题，不是调查路由标记。只有显式
`investigation` action 才触发调查；无 action 的修订直接进入一次 Reviewer patch。
显式调查缺少可用调查器、预算不足或执行失败，保持 unresolved，不得退化为批准。
生产调查接口只消费结构化 action，测试不得用自然语言猜测型调查器替代这一契约。
repair 复用证据组装，但使用 patch-only 任务前缀；允许 patch 内修改已送达源码的
anchor/related_locations，禁止模型提供运行时身份、版本和事务路由字段。
有效阶段优先级为显式 repair、显式兼容收尾、普通探索；v3 仅达到末轮不自动触发
模型 submit-only。运行时收尾不是一次额外模型阶段。阶段指令和工具暴露必须一致。
Graph 提示策略不在本次变更范围内。

`SemanticVerifier` 不接收 Reviewer 历史、confidence、candidate identity 或既有
verified 标签；每次模型调用创建 fresh `ModelConversation`，输入只含 finding、
相关 diff、真实送达 evidence 和必要 context。Integrity 只回答机械来源问题；
semantic receipt 必须绑定当前内容版本与实际相关 evidence digest。

调查遵循单一原则：只有一个可能改变结论的具体未决问题才触发，最多一轮、最多两次
只读工具调用；调查结果回到同一 evidence ledger 后才允许一次 re-check。材料足够
时调用数为零，不能为了耗尽预算而调查。

以下 `submit_review` 恢复约定仅适用于 v2；v3 使用 save/revise 和可选 finish，
由运行时统一收尾，不能恢复为旧全文提交。候选是否进入已批准报告由 integrity
与独立 semantic 决定，而非模型是否主动 finish。

v2 Review 中 `finish_reason="length"` 且无合法 `submit_review` 的模型调用属于 incomplete，
不得解释为合法空 review。runtime 必须标记 `recovery_required`，并至多发起一次只暴露
`submit_review` 的 finalize recovery；其输入只来自已持久化 draft、已保留工具证据和
兼容 concern 摘要，不再探索。合法 submit（包括带非空 summary 的明确 `issues=[]`）
可结束恢复；blank `summary=""` + `issues=[]` 不是明确空 review。否则必须记录 failed
recovery 并让本次 completion 保持 invalid/incomplete。Journal 仅保存
visible `content`，不保存 `reasoning_content` 或 CoT；进程内只允许记录隐藏推理是否
出现这一布尔遥测事实。

避免仅在一侧仓库私密修改导致线上与本地行为分叉。

每次 provider 请求必须先经过 `RequestAssembler`，按实际 wire payload 估算并执行
输入上限；telemetry 中的 request hash/size 只能来自同一序列化结果。若请求被
shorten 或丢弃消息，ledger 不得把规划阶段选中的 source 当成已交付证据。schema
repair 与 finding integrity repair 共用报告级 `REVIEW_REPAIR_MAX_ATTEMPTS`；
schema-valid 但 evidence identity 不完整的 finding 仍不能发布。

---

## 9. 异常与降级

- 工具超时、命令失败、模型错误时，应能返回 **结构化错误信息**（可进入 `ContextState.errors` 或统一错误模型），并尽可能输出 **部分有用结论**（见规划文档中的 Graceful Degradation）。
- 自定义异常类命名与继承层次宜在 `src/` 内集中约定，避免裸抛 `Exception`（见 CONTRIBUTING）。

---

## 10. 变更流程（建议）

1. 在 Issue 中说明动机与兼容性影响。  
2. 更新本文档或 `architecture.md` 中的契约说明。  
3. 实现代码与测试；涉及输出 schema 时同步 `eval/fixtures/` 或评测脚本。  
4. PR 中 `@` 对方角色 review，合并前至少一人审阅契约相关改动。

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-09 | 初稿：工具、状态、Review 输出、配置、观测与协作流程 |
| 2026-04-12 | Debug 输出协议定稿落地；补充编排相关环境变量（轮次、token、事件日志、CI 与高危工具） |
| 2026-04-17 | execute 工具硬化：argv + 首词白名单、pluggable backend（subprocess/docker）、输出截断、Review 模式不暴露 execute 工具；新增 `EXECUTE_*` 环境变量 |
| 2026-05-06 | MVP+ 最小闭环：FastAPI 同步薄层、Docker CLI demo、eval gate 过渡阈值；Docker execute 后端口径更新为已落地 |
| 2026-05-08 | PR review 产品边界对齐：Review 输出为建议/soft check，硬合并阻断交给 CI；inline finding 约束为 changed line / changed hunk |
| 2026-05-10 | docs-audit：对齐文档与代码现状 — golden 样本分布（4正/2负）、FastAPI 已实现、load_diff 用 `git diff HEAD`、eval gate 仍处于过渡期 |
| 2026-05-16 | 恢复 MVP+ 真实 eval gate：`schema_validity_rate >= 1.0`、`hit_rate >= 0.6`、`false_positive_rate <= 0.5` |
| 2026-05-18 | MVP+ eval closure baseline：`eval/outputs/20260518_151719_report.json` 达到 schema validity `1.0`、hit rate `0.75`、false positive rate `0.0`；详见 `docs/mvp_plus_eval_closure.md`。 |
| 2026-07-11 | v0.2.0：增加 Finding 语义 verifier、required-step Review Workflow、worker lease/checkpoint/recovery、Eval 过程指标和 baseline comparison。 |
| 2026-09-07 | finding 生成链路修复：统一 canonical v2 contract、实际发送 evidence ledger、完整 request envelope、报告级共享 repair cap、独立 finding funnel 与 opt-in semantic-v4 分层评测；保留 semantic-v3 历史口径。 |
