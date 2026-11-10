# 在 GitHub Actions 上使用 MergeWarden

设计见 [ADR 0024](adr/0024-github-actions-channel.md)。本文只讲配置和使用。

## 一次性准备

1. 新建一个**私有**状态仓库，例如 `<you>/mergewarden-state`，带一个初始提交。
2. 创建 fine-grained personal access token：只选状态仓库，权限 `Contents: Read and write`。
   如果 MergeWarden 仓库是私有的，同一个 token 还要能读它，并作为 `tool-token` 传入。
3. 在每个要审查的仓库里配置：
   - Variables：`MW_STATE_REPOSITORY`（`<you>/mergewarden-state`）、`MW_PROVIDER`、`MW_MODEL`。
   - Secrets：`MW_STATE_TOKEN`、`MW_MODEL_API_KEY`。
4. 添加工作流。本仓库已有 [`.github/workflows/mergewarden.yml`](../.github/workflows/mergewarden.yml)。
   其他仓库复制这个文件，把 `uses:` 改成
   `takagibit18/MergeWarden/.github/workflows/mergewarden-channel.yml@main`。
   MergeWarden 是私有仓库时，需要在其 Settings → Actions → Access 允许你名下的仓库使用它的工作流。

未配置 `MW_STATE_REPOSITORY` 时工作流不运行。

## 日常使用

- 同仓库分支的 PR 打开或推送新提交时，MergeWarden 审查 base..head，把报告发成一条 PR 评论；
  再次审查会编辑上一条。
- 仓库 owner、member 或 collaborator 用 `/mw` 开头的评论教它：

  ```text
  /mw [wrong|missed|contract|tradeoff|unsure] [finding:ID] 说明
  ```

  | 写法 | 含义 |
  |---|---|
  | `/mw wrong finding:C1 …` | 这条 finding 不成立，说明原因 |
  | `/mw missed …` | 漏报了问题 |
  | `/mw contract …` | 仓库约定 |
  | `/mw tradeoff …` | 已接受的取舍，必须是变更行上的行内评论 |
  | `/mw unsure …` | 不确定，只作参考 |
  | `/mw …` | 一般说明 |

  在 Files changed 里对新代码行发行内评论，会把这几行锚定为证据。
- 反馈处理后评论会收到反应：🚀 已学成 Skill，👀 已记录、学习未完成（失败的学习不会自动重试，编辑评论即可重新触发），😕 未记录（会另发一条原因）。
- 编辑评论会更新这条经验；删除评论或去掉 `/mw` 会撤回它。机器人和外部贡献者的评论不会被学习。
- 新经验从下一次审查开始生效。

## 排查与回退

状态仓库的 `<owner>/<name>/` 是普通的 MergeWarden 状态目录。克隆后可以用本地 CLI 查看或回退：

```bash
npm run cli -- skills list --state <clone>/<owner>/<name> --repo <被审仓库 checkout>
```

```bash
npm run cli -- skills disable --id SKILL_ID --state <clone>/<owner>/<name> --repo <被审仓库 checkout>
```

改动后提交并推送状态仓库。也可以直接 `git revert` 状态仓库里的某次学习提交。
