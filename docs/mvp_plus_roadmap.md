# MVP+ 完整落地路线图

> 本文档定义：当前版本已经具备什么、完整 MVP+ 必须交付什么、哪些能力明确留到 Phase 2，以及每个 MVP+ 里程碑的验收方式。  
> 与 [project_plan.md](project_plan.md) 互补：`project_plan` 记录总体方向，本文记录 **从当前版本走到完整 MVP+ 的可执行落盘规划**。

---

## 1. 当前版本基线

当前版本已经超过最小 MVP，具备以下可直接依赖的基础能力：

- **CLI 产品入口**：`review` / `debug` 子命令，输出结构化 `ReviewResponse` / `DebugResponse`。
- **五阶段 Agent 编排**：prepare -> analyze -> execute -> process -> continue/stop；支持多轮工具反馈、轮次上限、token 预算与 finalize-only 收口。
- **上下文管理**：按优先级截断、diff hunk / 文件粒度装载、`project_structure`、按需 `file_contents`、溢出块 LLM 摘要与 `truncated.summarized` 可观测字段。
- **工具与安全**：只读工具、Debug-only execute 工具、首词白名单、`shell=False`、环境清洗、输出截断、高危门控、CI 默认拒绝 execute。
- **Docker execute 后端**：`DockerBackend` 已通过本地 `docker run` 执行预构建镜像，复用 workspace/cwd 校验、容器内 cwd 映射、`SandboxResult` 观测字段。
- **契约与输出**：canonical `location` 解析、`ReviewReport` / `DebugResponse` Pydantic 模型、CLI 可消费的稳定 JSON 结构。
- **评测与回归**：`eval/` Golden fixtures、manifest、runner、report、gate、CI artifact 上传已经存在。
- **CI 基础流水线**：ruff、mypy、pytest、golden eval、eval gate 已接入 GitHub Actions。

仍需注意的基线风险：

- 部分规划文档仍滞后于代码现状，例如 Docker 后端状态、容器内执行口径、未来 API 入口。
- CI 当前 `golden` suite 暂为纯负样本，因此本轮 gate 只约束 schema 与 false positive；`hit_rate >= 0.6` 等补充正样本后恢复。
- Docker 能执行命令，但还缺面向用户的一键 CLI demo 闭环。

---

## 2. 完整 MVP+ 完成定义

完整 MVP+ 的目标不是增加大量新产品线，而是在当前 MVP 基础上补齐 **可交付、可验证、可运维、可展示** 的闭环。

达到完整 MVP+ 时，必须同时满足：

1. **CLI 稳定路径**：`review` / `debug` 有清晰 demo、错误处理和结构化输出，能作为主产品入口展示。
2. **同步 FastAPI 薄层**：提供 `GET /health`、`POST /review`、`POST /debug`，复用现有 orchestrator 与 Pydantic 请求/响应模型，不引入 job queue 或持久状态。
3. **Docker CLI demo 闭环**：以 `docker compose run --rm agent python cli.py ...` 作为主 demo 路径，文档中给出可复制命令和预期结果。
4. **观测与降级收口**：run_id、phase 事件、工具失败、submit 校验失败、终止原因可排查；用户看到的 stop reason 不误导。
5. **温和 eval gate**：CI gate 至少约束 MergeWarden 自身评测回归的 `schema_validity_rate >= 1.0` 与 `false_positive_rate <= 0.5`；当 `golden` suite 补齐正样本后，恢复 `hit_rate >= 0.6`。该 gate 不代表产品侧对用户 PR 的 hard merge block。
6. **文档一致性**：README、architecture、project plan、shared contracts、execute design、golden fixture snapshot plan、env example 与代码现状一致。

MVP+ 不要求：

- 自动修复代码并提交补丁。
- 支持完整多用户平台、数据库、任务队列或长期作业状态。
- 在 CI 中默认真实运行 Docker execute smoke；该测试保持手动启用。

---

## 3. MVP+ 非目标与 Phase 2 边界

以下能力不纳入完整 MVP+ 完成标准，只作为 Phase 2 或更后续阶段：

| 能力 | 阶段 | 边界说明 |
|------|------|----------|
| GitHub Action / Bot PR 自动评论 | Phase 2 | MVP+ 只准备稳定 CLI/API/评测/文档，PR 评论、review thread、check conclusion 策略后移。 |
| PR webhook / GitHub App | Phase 2 | 当前不引入 webhook server、installation token、权限矩阵或 GitHub App 配置。 |
| PR 评论去重与更新 | Phase 2 | 不在 MVP+ 内设计 inline comment lifecycle。 |
| IDE 插件 | Later | `project_plan.md` 已定义为有余力再做，MVP+ 不规划实现。 |
| 异步任务 API / job queue | Later | FastAPI 只做同步薄层；长任务、状态存储和后台 worker 后移。 |

Phase 2 启动前置条件：

- MVP+ 的 CLI 与 FastAPI 输出契约稳定。
- eval gate 能可靠阻止 MergeWarden 自身质量明显退化；用户 PR 的硬性合并裁决仍交给 GitHub CI / branch protection。
- README 能让新用户本地或 Docker 跑通 demo。
- 事件日志足以复盘一次失败 review/debug。

---

## 4. MVP+ 里程碑

### M+0 文档与基线校准

**目标**：消除规划文档与当前代码的明显冲突，建立可信基线。

**任务**

- 将 Docker 后端状态统一为“已落地为本地 `docker run` 后端”，不再写 stub。
- 在路线图中明确 FastAPI、Docker demo、eval gate、观测收口是 MVP+ 剩余主线。
- 标出 `architecture.md`、`project_plan.md`、`shared_contracts.md` 中需要后续同步的过期口径。

**验收**

- `docs/mvp_plus_roadmap.md` 能独立说明当前版本与完整 MVP+ 的差距。
- 文档中没有将已实现 Docker 后端描述为 stub。

**验证**

- 人工检查路线图与 `src/security/backends.py`、`src/config.py`、`.github/workflows/ci.yml` 口径一致。

### M+1 Docker CLI demo 闭环

**目标**：让新用户用 Docker 跑通一个可展示的 CLI 路径。

**任务**

- 明确主 demo 命令：`docker compose run --rm agent python cli.py review --help` 与至少一个 review/debug 示例。
- 更新 README Docker 章节，说明 `.env`、API key、挂载目录、预期输出。
- 保留真实 execute Docker smoke 为手动测试：`RUN_DOCKER_TESTS=1 pytest -q tests/test_docker_backend_smoke.py -rs`。

**验收**

- 用户只看 README 即可知道如何用 Docker 跑 CLI demo。
- Docker demo 不要求真实 PR bot，也不要求 FastAPI。

**验证**

```bash
docker compose run --rm agent python cli.py review --help
docker compose run --rm agent python cli.py debug --help
```

### M+2 FastAPI 同步薄层

**目标**：提供与 CLI 能力等价的最小 HTTP 入口，便于后续 Phase 2 集成。

**任务**

- 新增同步 FastAPI app，最小接口：
  - `GET /health`：返回服务状态、版本、默认模型名。
  - `POST /review`：接收 `ReviewRequest` JSON，返回 `ReviewResponse` JSON。
  - `POST /debug`：接收 `DebugRequest` JSON，返回 `DebugResponse` JSON。
- HTTP 层只做参数校验、异常转译和 JSON 返回，不改 Agent 核心编排。
- API 默认不做交互式高危确认；execute 工具仍遵循现有高危门控与 CI/plan-mode 策略。
- 补充依赖、测试和启动文档，例如 `uvicorn src.api.app:app --reload`。

**验收**

- CLI 与 API 共用同一套请求/响应模型，不维护两份协议。
- API 错误以稳定 JSON 返回，包含可读 `message`，模型/工具失败不泄露敏感环境变量。

**验证**

- 使用 `TestClient` 覆盖 `/health`、`/review`、`/debug`。
- 至少覆盖模型客户端不可用时的降级响应。

### M+3 观测与降级收口

**目标**：让失败路径可以复盘，让用户看到的终止原因准确。

**任务**

- 补齐关键 phase 的 `phase_start` / `phase_end` 事件，至少覆盖 analyze、execute_tools、format_result、continue。
- 将 `submit_review` / `submit_debug` schema 校验失败记录为结构化事件，包含 run_id、phase、错误类别和降级路径。
- 收口终止原因优先级：hard budget > blocking schema/runtime error > max iterations > model completed > no tools needed。
- 将连续工具失败 / 空结果的降级策略写入 `analyzer_dev_plan.md` 和实际实现任务。

**验收**

- 一次失败运行能通过 event log 还原：输入上下文摘要、模型调用、工具调用、失败原因、最终 stop reason。
- CLI verbose 输出或 JSON context 中的 errors 与 stop reason 不互相矛盾。

**验证**

- 单测覆盖 schema 校验失败、工具连续失败、budget hard cap、max iteration stop。
- 手动检查 `.mergewarden/logs/<run_id>.jsonl` 的事件顺序。

### M+4 Eval gate 温和门禁

**目标**：让 CI 中的 Golden eval 真正阻止 MergeWarden 自身明显质量退化，同时避免把 Agent 输出误定义为用户 PR 的硬合并门禁。

**任务**

- 当前 `suite=golden` 只有负样本时，将 GitHub Actions 中 eval gate 设为：
  - `--schema-validity-min 1.0`
  - `--hit-rate-min 0.0`
  - `--false-positive-rate-max 0.5`
- 在 `eval/README.md` 中说明当前阈值是过渡门禁；下一个最小闭环补充正样本后恢复 `--hit-rate-min 0.6`。
- 保持 eval artifact 上传，失败时可查看 machine report、human review 模板和 event logs。

**验收**

- CI 不再接受 schema 无效输出。
- 纯负样本阶段不因缺少 expected issue 而错误阻塞 PR。
- false positive rate 超过阈值时 CI 会失败。
- 这里的 CI 失败只表示本项目评测质量退化；Phase 2 的 GitHub PR 集成默认产出建议、soft check 或 review comment。

**验证**

```bash
python -m eval.run eval --suite golden --output-json eval/outputs/ci_report.json
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.0 --false-positive-rate-max 0.5
```

### M+4.1 Eval 正样本补齐与门禁恢复

**目标**：让 `suite=golden` 同时包含人工审核过的正负样本，并恢复 `hit_rate >= 0.6` 门禁。

**任务**

- 至少补充 2-3 条人工审核过的真实 PR 正样本到 `suite=golden`，每条 expected issue 必须能从 diff 直接定位。
- 下一阶段开始向 `PR diff + repo snapshot` 的健壮 fixture 形态迁移，详见 [golden_fixture_snapshot_plan.md](golden_fixture_snapshot_plan.md)。
- 更新 `manifest.json`，确保 CI 运行的 `suite=golden` 同时覆盖 `should-detect` 与 `zero-issue`。
- 将 `.github/workflows/ci.yml` 的 eval gate 恢复为 `--hit-rate-min 0.6`。
- 同步 `eval/README.md` 与本路线图中的门禁命令。

**验收**

- `suite=golden` 中至少有一条正样本和一条负样本。
- `hit_rate >= 0.6` 在 CI 中重新生效。
- 新增正样本的 `annotated_by` 为 `manual`，`reviewed` 为 `true`。

**验证**

```bash
python -m eval.run eval --suite golden --output-json eval/outputs/ci_report.json
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5
```

### M+5 契约与文档一致性

**目标**：让对外文档、架构文档、契约文档和代码行为一致。

**任务**

- 更新 `architecture.md`：Docker 后端不再是 stub；FastAPI 从 optional routes 变为 MVP+ 薄层目标。
- 更新 `project_plan.md`：MVP+ 包含 FastAPI 薄层、Docker CLI demo、温和 eval gate；Phase 2 才包含 GitHub Bot。
- 更新 `shared_contracts.md`：`EXECUTE_BACKEND=docker` 描述为可用后端，并补齐 Docker 配置项与 `SandboxResult` 观测字段。
- 更新 `.env.example` 与 README：补 FastAPI、Docker demo、eval gate、Docker smoke 说明。

**验收**

- 搜索 Docker 后端仍为占位实现、旧 hit-rate 阈值等过期口径，不应再出现在当前文档中。
- README 能作为新用户入口，docs 能作为开发者入口。

**验证**

```bash
Select-String -Path docs\*.md,README.md,.env.example -Pattern '占位实现','旧 hit-rate 阈值'
```

### M+6 MVP+ Release 验收

**目标**：形成可展示、可复现、可评测的 MVP+ 版本。

**任务**

- 跑通本地验证、Docker CLI demo、FastAPI smoke、Golden eval。
- 生成一份端到端演示记录：输入仓库或 fixture、命令、run_id、输出摘要、eval report 链接。
- 将剩余未完成事项移动到 Phase 2 backlog，不混入 MVP+ 完成标准。

**验收**

- 新用户可以在 README 指引下跑通本地或 Docker demo。
- 开发者可以根据 docs 了解架构、契约、安全边界和评测门禁。
- CI 能阻止 MergeWarden 自身格式和基础质量退化；产品侧 PR 集成默认只提供建议或 soft check。

**验证**

```bash
ruff check --no-cache .
mypy src/
pytest -q
python -m eval.run eval --suite golden --output-json eval/outputs/ci_report.json
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.0 --false-positive-rate-max 0.5
docker compose run --rm agent python cli.py review --help
```

---

## 5. 最终验收清单

完整 MVP+ 发布前逐项确认：

- [ ] CLI `review` / `debug` 本地可运行，并有 README 示例。
- [ ] Docker CLI demo 可运行，并有明确预期输出。
- [ ] FastAPI `GET /health`、`POST /review`、`POST /debug` 有测试与文档。
- [ ] `SandboxResult`、execute 后端、Docker 配置在契约文档中描述一致。
- [ ] 事件日志能复盘失败原因和终止原因。
- [ ] 当前 CI gate 使用过渡门禁：schema 1.0、hit rate 0.0、false positive 0.5；补齐 `golden` 正样本后恢复 hit rate 0.6。
- [ ] Golden eval report 与 human review artifact 可查看。
- [ ] README、architecture、project plan、shared contracts、execute design、golden fixture snapshot plan 口径一致。
- [ ] Phase 2 backlog 清晰列出 GitHub Action/Bot、PR 评论、IDE 插件等后续事项。

---

## 6. 维护规则

- 涉及工具安全、Docker 后端、execute 策略时，必须同步 `execute_tools_design.md`、`shared_contracts.md` 和本路线图。
- 涉及 API 请求/响应字段时，必须同步 Pydantic 模型、FastAPI 测试、CLI/API 文档和 eval fixture。
- 涉及 eval gate 阈值时，必须同步 `.github/workflows/ci.yml`、`eval/README.md` 和 release 验收清单。
- 涉及 Phase 2 能力时，只能写入 Phase 2 backlog；不得改变 MVP+ 完成标准，除非重新修订本文档的完成定义。
