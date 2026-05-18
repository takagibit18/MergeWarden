# 健壮 Golden Fixture 构建规范：PR diff + repo snapshot

> 本文定义后续版本更健壮的 review 黄金集形态。目标是让 eval 尽量接近真实 PR review：Agent 面对的是 PR diff，但可在完整仓库快照中按需读取上下文。

## 1. 产品定位

MergeWarden 的 review 能力不负责替代 GitHub CI 判断“能不能合并”。CI / branch protection 仍是硬性合并裁决者；Agent 的职责是补充 CI 不一定覆盖的 reviewer 判断：这段代码虽然可能能过测试，但是否值得怀疑、是否缺少保护、是否引入难以被现有测试捕捉的风险。

因此 review eval 不应演变成全仓库审计。它只考察本次 PR diff 引入、暴露或未修复的问题，并要求 finding 能定位回 changed line 或 changed hunk。

## 2. 目标运行形态

```mermaid
flowchart TD
    A["Fixture: PR diff + repo snapshot ref"] --> B["Runner 创建临时目录"]
    B --> C["还原完整仓库快照"]
    C --> D["传入 PR diff 作为 review target"]
    D --> E["Agent 首轮查看 diff + changed files"]
    E --> F{"是否需要上下文?"}
    F -->|否| G["提交 ReviewReport"]
    F -->|是| H["只读工具读取未变更上下文文件"]
    H --> G
    G --> I["Eval 匹配 changed line / changed hunk 上的 expected issue"]
```

关键约束：

- 初始 prompt 不塞全仓库内容。
- 完整仓库快照只作为工具可访问 workspace。
- `expected.issues` 只标注 diff 相关问题。
- `ReviewIssue.location` 必须落在 changed line 或 changed hunk。
- 未变更文件可以出现在 `evidence` 中，但不能成为默认 inline comment 位置。

## 3. Fixture 数据结构建议

长期建议在现有 `FixtureInput` 外扩展 workspace 元数据，而不是把全仓库内容内嵌进 JSON。

```json
{
  "input": {
    "diff_text": "...",
    "files": {},
    "workspace": {
      "kind": "git",
      "repo_url": "https://github.com/owner/repo.git",
      "base_sha": "abc123",
      "head_sha": "def456",
      "checkout_sha": "def456",
      "diff_base_sha": "abc123"
    }
  }
}
```

字段语义：

- `repo_url`：公开仓库地址，runner 可 clone / fetch。
- `base_sha`：PR base commit，用于明确 diff 基线。
- `head_sha`：PR head commit，用于还原被 review 的代码状态。
- `checkout_sha`：临时 workspace 实际 checkout 的 commit，通常等于 `head_sha`。
- `diff_base_sha`：用于生成或校验 `diff_text` 的基线，通常等于 `base_sha`。

当前 `input.files` 可保留为兼容字段。迁移完成后，review fixture 优先使用 `workspace` 还原完整仓库；`files` 只用于小型单文件单测或离线降级。

## 4. Runner Behavior

When a fixture has `workspace.kind = "git"`, the runner should:

1. Create a temporary directory.
2. Clone or fetch `repo_url` through a local cache.
3. Checkout `checkout_sha`.
4. Verify actual HEAD equals `checkout_sha`.
5. Verify every added line in `diff_text` matches the same file and new-line number in the restored `checkout_sha` workspace. Mismatches return fixture validation errors and are not counted as model misses or false positives.
6. Verify expected issue `path` / `line` lands on a changed line or changed hunk and the file exists.
7. Use that directory as `ReviewRequest.repo_path`.
8. Use `diff_text` as `ReviewRequest.diff_text`.
9. Set `diff_mode=True`.
10. Expose only read-only tools in review mode.

The runner should not embed the full repository in the prompt. Context expansion remains agent-driven through `read_file`, `grep_files`, `glob_files`, and `list_dir`.

Added-line consistency is a hard requirement. If the prompt diff and tool-readable repo snapshot disagree, the model can reasonably report diff/file conflicts, polluting hit and false-positive metrics. Such issues must be blocked as fixture quality failures before model execution.

## 5. 标注规范

正式 `suite=golden` 的正样本必须满足：

- `metadata.reviewed = true`
- `metadata.annotated_by = "manual"`
- `expected.issues[*].path` 指向 changed file。
- `expected.issues[*].line` / `end_line` 与 PR diff 新文件行号一致。
- 问题能从 changed hunk 直接定位；上下文文件只用于证明为什么它有风险。
- severity 只反映本次 diff 引入的风险，不惩罚历史遗留问题。

负样本应覆盖：

- 纯测试补充。
- 文档或注释变更。
- 安全的重构或重命名。
- 有 reviewer 争议但最终没有可从 diff 直接证明的缺陷。

## 6. 候选来源

候选 PR 可以来自两类：

- `merged-bugfix`：已合并 bugfix PR，用于寻找历史上真实修复过的问题。
- `rejected-pr`：closed but unmerged PR，且维护者、协作者或贡献者在 discussion / review 中指出明确问题。

`rejected-pr` 候选只进入 `golden_candidates`。进入正式 `golden` 前必须人工确认：问题确实由 diff 引入，且 expected location 能落在 changed line / changed hunk。

## 7. 不纳入本规范的目标

- 不做全仓库漏洞扫描黄金集。
- 不要求 agent 运行测试才能命中 expected issue。
- 不把未变更文件上的历史问题标成正样本。
- 不把 Agent 输出定义为用户 PR 的 hard merge block。

## 8. Migration Steps

1. Done: add optional `workspace` metadata to `FixtureInput` and support git snapshot checkout in the runner.
2. Done: migrate the formal `golden` suite to the `PR diff + repo snapshot` shape; keep `input.files` only as a compatibility fallback.
3. Done: validate expected locations against diff changed hunks before model execution.
4. Done: validate `diff_text` added lines against `checkout_sha` workspace content before model execution, preventing stale fixtures from contaminating metrics.
5. Closure: rerun golden eval on corrected fixtures, restore the `hit_rate >= 0.6` eval gate, and report schema failures, misses, false positives, workspace restore failures, and fixture validation failures separately.

## 9. Acceptance Criteria

- The same fixture restores the same workspace on a clean machine.
- Runner checkout HEAD equals `checkout_sha`.
- `diff_text` hunk new-line numbers match workspace file line numbers.
- Every added line in `diff_text` matches the workspace text at that file and line.
- The agent can read unchanged context through read-only tools.
- Matched issue locations overlap expected changed hunks.
- Zero-expected samples do not produce high-confidence false positives from unrelated historical repository issues.
- `manifest.json` reviewed flags match fixture metadata.
