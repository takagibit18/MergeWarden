# MVP+ 完整落地路线图

> 本文档定义：当前版本已经具备什么、完整 MVP+ 必须交付什么、哪些能力明确留到 Phase 2，以及每个 MVP+ 里程碑的验收方式。
> 与 [project_plan.md](project_plan.md) 互补：`project_plan` 记录总体方向，本文记录 **从当前版本走到完整 MVP+ 的可执行落盘规划**。

---

## 1. Current Baseline

The current version is beyond the minimal MVP and has the following usable foundations:

- **CLI entrypoints**: `review` and `debug` produce structured `ReviewResponse` / `DebugResponse` output.
- **Five-phase agent loop**: prepare -> analyze -> execute -> process -> continue/stop, with tool feedback, iteration limits, token budgets, and finalize-only closure.
- **Context management**: prioritized truncation, diff hunk and file-level loading, `project_structure`, on-demand `file_contents`, LLM summaries for overflow chunks, and observable `truncated.summarized` fields.
- **Tools and safety**: read-only review tools, debug-only execute tools, first-token allowlist, `shell=False`, environment cleanup, output truncation, high-risk gates, and CI execute refusal by default.
- **Docker execute backend**: `DockerBackend` is available for local smoke tests and reuses workspace/cwd validation, container cwd mapping, and `SandboxResult` observability fields.
- **Contracts and output**: canonical `location` parsing, Pydantic output models, and stable CLI-consumable JSON.
- **Eval and regression**: `eval/` fixtures, manifest, runner, report, gate, and CI artifact upload exist. Workspace-backed fixtures are validated against their restored `checkout_sha` before model execution.
- **CI foundation**: ruff, mypy, pytest, golden eval, and eval gate are wired in GitHub Actions.

Current status:

- MVP+ engineering scope is in release-candidate shape: CLI, FastAPI thin layer, Docker CLI demo, event logs, soft eval gate, and documentation entrypoints are in place.
- The `golden` suite has 4 positive and 2 negative fixtures; all are `annotated_by=manual` and `reviewed=true`; `manifest.json` is consistent with fixture metadata.
- The current MVP+ closure report `eval/outputs/20260518_151719_report.json` has schema validity `1.0`, hit rate `0.75`, and false positive rate `0.0`. It satisfies the stable `hit_rate >= 0.6` target.
- Fixture diff/snapshot drift has been fixed and is now blocked by runner validation. The corrected golden run is recorded in [mvp_plus_eval_closure.md](mvp_plus_eval_closure.md).
- Docker CLI demo commands are documented in README and `docker-compose.yml`.

---
## 2. Complete MVP+ Definition

Complete MVP+ means a deliverable, verifiable, operable, and demoable loop on top of the current MVP. It does not mean adding a large new product surface.

Complete MVP+ requires:

1. **Stable CLI path**: `review` and `debug` have clear demos, error handling, and structured output.
2. **Synchronous FastAPI thin layer**: `GET /health`, `POST /review`, and `POST /debug` reuse the existing orchestrator and Pydantic request/response models without a job queue or durable state.
3. **Docker CLI demo loop**: `docker compose run --rm agent python cli.py ...` is the primary container demo path with documented commands and expected output.
4. **Observability and graceful degradation**: run_id, phase events, tool failures, submit validation failures, budget state, and stop reasons are diagnosable.
5. **Stable eval gate**: CI gates schema validity, hit rate, and false positive regression with `schema_validity_rate >= 1.0`, `hit_rate >= 0.6`, and `false_positive_rate <= 0.5`. This gate protects MergeWarden itself and is not a hard merge decision for user pull requests.
6. **Documentation consistency**: README, architecture, project plan, shared contracts, execute design, golden fixture snapshot plan, and env examples match the codebase.

2026-05-18 status:

- **MVP+ engineering scope: complete.** CLI, API, Docker demo, observability, eval runner, fixture snapshot strategy, and docs boundaries are closed.
- **MVP+ stable quality evidence: complete for the current numeric gate.** R14 passes schema validity `1.0`, hit rate `0.75`, and false positive rate `0.0` on the reviewed golden suite.
- **Phase 2 should not block MVP+ engineering closure.** GitHub Bot, PR comment lifecycle, webhooks, async jobs, and productized run storage remain Phase 2 work.

MVP+ does not require:

- Automatic code repair and patch submission.
- A full multi-user platform, database, task queue, or long-running job state.
- Docker execute smoke tests enabled by default in CI; they remain manually enabled.

---
## 3. Non-goals and Phase 2 Boundary

These capabilities are outside the complete MVP+ standard and belong to Phase 2 or later:

| Capability | Stage | Boundary |
|------|------|----------|
| GitHub Action / Bot PR comments | Phase 2 | MVP+ prepares stable CLI/API/eval/docs. PR comments, review threads, and check conclusion policy move later. |
| PR webhook / GitHub App | Phase 2 | No webhook server, installation token, permission matrix, or GitHub App configuration in MVP+. |
| PR comment deduplication and updates | Phase 2 | Inline comment lifecycle is not designed inside MVP+. |
| Eval quality hardening | Phase 2-ready | Does not block MVP+ engineering closure, but restoring `hit_rate >= 0.6`, multi-sample stability, and provider matrix testing should precede GitHub integration. |
| IDE plugin | Later | Already defined as optional later work in `project_plan.md`. |
| Async API / job queue | Later | FastAPI remains synchronous; long-running jobs, state storage, and workers move later. |

Phase 2 prerequisites:

- MVP+ CLI and FastAPI output contracts are stable.
- Eval gate reliably catches obvious MergeWarden quality regression; hard merge authority remains GitHub CI / branch protection.
- README lets a new user run the local or Docker demo.
- Event logs are sufficient to debug a failed review/debug run.

Recommended Phase 2 order:

1. **Eval stability and diagnostics**: keep R14 as the current numeric baseline, then add multi-report trends, per-fixture diagnostics, pass@k/provider sampling, and focused `golden_pytest-dev_pytest_pr8513` analysis.
2. **Productized observability**: summarize event logs, budget state, provider/model, schema failure, hit/miss, and FP causes into local run summaries and eval sidecar artifacts.
3. **GitHub PR integration**: start with local advisory payload export and soft checks, not hard blocks; restrict inline comments to changed lines / changed hunks.
4. **Comment lifecycle**: add fingerprint-based dedupe, update, stale-comment folding, and run_id tracking.
5. **Async execution and storage**: introduce job queue, durable state, and webhook callbacks only when GitHub integration needs long-running work.

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

- 当前 `suite=golden` 为 4 个正样本 + 2 个负样本，GitHub Actions 中 eval gate 设为：
  - `--schema-validity-min 1.0`
  - `--hit-rate-min 0.6`
  - `--false-positive-rate-max 0.5`
- 在 `eval/README.md` 中说明当前阈值是稳定 MVP+ 数值门禁；R14 已通过同一组阈值。
- 保持 eval artifact 上传，失败时可查看 machine report、human review 模板和 event logs。

**验收**

- CI 不再接受 schema 无效输出。
- 命中率低于稳定阈值时 CI 会失败。
- false positive rate 超过阈值时 CI 会失败。
- 这里的 CI 失败只表示本项目评测质量退化；Phase 2 的 GitHub PR 集成默认产出建议、soft check 或 review comment。

**验证**

```bash
python -m eval.run eval --suite golden --output-json eval/outputs/ci_report.json
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5
```

### M+4.1 Eval Positive Fixtures and Stable Gate Restore

**Status**: fixture count is complete (4 positive + 2 negative, all `annotated_by=manual`, `reviewed=true`), and the stable hit-rate gate is restored.

**Done**

- Added 4 manually reviewed positive fixtures (`pytest_pr8513`, `pytest_pr9350`, `pytest_pr7254`, `nethermind_pr5381`) and 2 negative fixtures (`ruff_pr24648`, `requests_pr7205`).
- `manifest.json` and fixture metadata are consistent for the reviewed golden suite.
- Review fixtures use the `PR diff + repo snapshot` shape. The runner validates diff added lines against the `checkout_sha` workspace before model execution.

**Current diagnostic result**

- Latest local report: `eval/outputs/20260518_151719_report.json`.
- Result: schema validity `1.0`, hit rate `0.75`, false positive rate `0.0`.
- Interpretation: this is the current MVP+ numeric quality baseline. It clears the stable gate on the reviewed golden suite; `golden_pytest-dev_pytest_pr8513` remains the next quality-hardening target.

**Stable gate**

- CI uses `python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5`.
- Local R14 passes the same numeric thresholds.
- See [mvp_plus_eval_closure.md](mvp_plus_eval_closure.md) for the recent optimization and metric history.

### M+5 契约与文档一致性

**目标**：让对外文档、架构文档、契约文档和代码行为一致。

**任务**

- 更新 `architecture.md`：Docker 后端和 FastAPI 薄层均已落地，文档需反映实际状态。
- 更新 `project_plan.md`：MVP+ 已包含 FastAPI 薄层、Docker CLI demo、温和 eval gate；Phase 2 才包含 GitHub Bot。
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
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5
docker compose run --rm agent python cli.py review --help
```

---

## 5. Final Acceptance Checklist

Before a complete MVP+ release, confirm:

- [x] CLI `review` / `debug` local entrypoints and structured output contracts exist, with README examples.
- [x] Docker CLI demo documentation exists; real Docker smoke remains manually enabled.
- [x] FastAPI `GET /health`, `POST /review`, and `POST /debug` are in MVP+ scope and reuse current contracts.
- [x] `SandboxResult`, execute backends, and Docker configuration are described consistently in contract docs.
- [x] Event logs can explain failure reason, budget state, and stop reason.
- [x] Current CI gate uses stable thresholds: schema 1.0, hit rate 0.6, false positive 0.5.
- [x] Golden fixtures use workspace-backed snapshots and diff/workspace consistency validation.
- [x] Rerun golden eval on corrected fixtures and record stable `hit_rate >= 0.6` evidence.
- [ ] Fill the latest `golden_human_review.md` human acceptability scores and comments when preparing release notes.
- [x] README, architecture, project plan, shared contracts, execute design, and golden fixture snapshot plan align on MVP+ / Phase 2 boundaries.
- [x] Phase 2 backlog clearly lists GitHub Action/Bot, PR comment lifecycle, async execution, and productized observability.

---
## 6. 维护规则

- 涉及工具安全、Docker 后端、execute 策略时，必须同步 `execute_tools_design.md`、`shared_contracts.md` 和本路线图。
- 涉及 API 请求/响应字段时，必须同步 Pydantic 模型、FastAPI 测试、CLI/API 文档和 eval fixture。
- 涉及 eval gate 阈值时，必须同步 `.github/workflows/ci.yml`、`eval/README.md` 和 release 验收清单。
- 涉及 Phase 2 能力时，只能写入 Phase 2 backlog；不得改变 MVP+ 完成标准，除非重新修订本文档的完成定义。
