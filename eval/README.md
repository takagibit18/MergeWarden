# 评测方案

## 概述

本目录包含两类能力：

- 黄金集自建 pipeline（GitHub 自动发现仓库 + PR 解析 + LLM 辅助标注）
- 评测执行模块（对 Agent 输出计算格式合法率、命中率、误报率、人工可接受度模板、耗时/Token）

## 目录结构

```
eval/
├── crawler/
│   ├── github_client.py
│   ├── pr_parser.py
│   ├── annotator.py
│   └── fixture_generator.py
├── schemas.py
├── runner.py
├── metrics.py
├── report.py
├── run.py
├── fixtures/          # 评测用例（固定输入 + 期望输出元数据）
│   ├── manifest.json
│   └── review_checklist.md
├── outputs/           # 评测产出物（.gitignore 已忽略）
└── README.md
```

## 评测策略

### 主路径：自建黄金集（Golden Set）

- **素材来源**：自动发现小型活跃开源仓库，并筛选已合并 bugfix PR 或被维护者指出问题的 closed/unmerged PR 候选
- **缺陷来源**：PR diff、可信 review 证据与 LLM 辅助标注 expected issues；正式黄金集必须人工复核
- **固定输入**：当前 fixture 包含 diff / 相关文件片段 / 错误日志（可选）；长期健壮形态见 [golden_fixture_snapshot_plan.md](../docs/golden_fixture_snapshot_plan.md)，目标是 PR diff + repo snapshot
- **期望行为**：
  - 检出类：输出命中目标问题类别
  - 结构类：结构化输出通过 JSON Schema 校验
  - 定位类：指向正确文件路径或行号范围

### 指标

| 指标 | 说明 |
|------|------|
| 格式合法率 | 输出通过结构化 schema 校验的比例 |
| 关键问题命中率 | 成功检出预设问题的比例 |
| 误报率 | 非预设问题的报告比例 |
| 人工可接受度 | 人工 spot-check 评分 |
| 耗时 / Token | 工程回归指标 |

### Review target semantics

For review fixtures, the primary input is the pull request diff. The temporary
sandbox contains the files from the fixture as post-diff context so the agent can
read surrounding code when needed. Expected issues should target problems that
the submitted diff introduces, exposes, or fails to fix; the eval is not a
general audit of the pre-diff repository.

When `diff_mode=True`, the eval measures review quality for the submitted diff.
File reads are contextual evidence only.

The robust fixture shape is `PR diff + repo snapshot`: when `input.workspace`
is present with `kind="git"`, the runner restores a full temporary repository
at `checkout_sha`, passes the PR diff as the review target, and lets read-only
tools inspect unchanged context only when needed. Expected review comments must
still map back to changed lines or changed hunks. Legacy `input.files` remains
supported as a sparse offline fallback.

### 补充维度：公开 benchmark

在黄金集跑通后，可从 SWE-bench 等公开数据中抽取少量实例做外推验证。子集规模、筛选规则需写入评测说明，与主评测通过/失败口径分开汇报。

## 运行

```bash
# 1) 自动抓取并生成 fixture（需要 GITHUB_TOKEN）
python -m eval.run crawl --max-repos 5 --max-prs-per-repo 3

# 1a) 生成 rejected PR 正样本候选（需要 GITHUB_TOKEN 与模型 API）
python -m eval.run crawl --suite golden_candidates --candidate-mode rejected-pr --max-repos 5 --max-prs-per-repo 3 --min-expected-issues 1

# 2) 跑评测（调用 AgentOrchestrator）
python -m eval.run eval --suite golden

# 默认本地评测使用 fixture 级并发，并为 review fixture 保留一轮只读工具上下文探索：
# EVAL_FIXTURE_CONCURRENCY=3, EVAL_REVIEW_MAX_ITERATIONS=2,
# EVAL_REVIEW_MIN_TOOL_ITERATIONS=1。这样避免模型第一轮直接 submit_review
# 导致 golden 正样本缺少必要上下文。

# 3) 基于已有报告重新渲染终端输出
python -m eval.run report --input eval/outputs/<timestamp>_report.json
```

### MVP+ eval gate

CI uses a soft eval gate to prevent obvious MergeWarden regression. It is not a hard merge decision for user pull requests. The current `golden` suite contains 4 positive should-detect fixtures and 2 negative zero-issue fixtures. All are `annotated_by=manual` and `reviewed=true`.

Workspace-backed fixtures are validated before model execution: every added line in `diff_text` must match the restored `checkout_sha` repository snapshot. A mismatch is treated as fixture validation failure, not as a model miss or false positive.

The transitional CI gate remains:

```bash
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.0 --false-positive-rate-max 0.5
```

- `schema_validity_rate >= 1.0`: every response must be valid structured output.
- `hit_rate >= 0.0`: hit rate is not enforced during the transition.
- `false_positive_rate <= 0.5`: false positives above 50% fail the gate.

The stable target remains:

```bash
python -m eval.gate --report eval/outputs/ci_report.json --schema-validity-min 1.0 --hit-rate-min 0.6 --false-positive-rate-max 0.5
```

Only restore CI to `--hit-rate-min 0.6` after a fresh run on the corrected fixtures passes schema validity, hit rate, false positive rate, and the human acceptability review is filled in.

### 2026-05-17 local golden eval status

Latest diagnostic report: `eval/outputs/20260517_152809_report.json`.

- Suite shape: `golden`, 6 reviewed fixtures, 4 positive and 2 negative.
- Schema validity: `100.00%`.
- Hit rate: `50.00%` (2/4 positive fixtures), below the stable `60.00%` target.
- False positive rate: `16.67%`.
- Average latency: `64.7s`; P50 / P95 latency: `57.5s` / `93.8s`.
- Average tokens: `21,745`; P50 / P95 tokens: `19,506` / `29,405`.
- Run shape: review eval used `EVAL_REVIEW_MAX_ITERATIONS=2`; round 0 gathered read-only context and round 1 forced `submit_review`. The run did not hit a budget hard cap or workspace checkout failure.

Interpretation: this report proves the MVP+ eval execution path is observable and debuggable, but it is not stable quality evidence. The run exposed stale fixture diff/snapshot drift; the runner now blocks that class of fixture issue before the model runs. A fresh golden eval is required before recording a new quality baseline.

## 产物说明

- `eval/fixtures/manifest.json`：fixture 索引
- `eval/fixtures/review_checklist.md`：人工审核清单（用于修正 LLM 草稿）
- `eval/outputs/*_report.json`：机器可读评测报告
- `eval/outputs/*_human_review.md`：人工可接受度打分模板（0-5）
