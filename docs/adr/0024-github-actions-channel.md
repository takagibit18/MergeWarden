# ADR 0024 — GitHub Actions 审查与评论学习通道

状态：已实施（本地端到端验证）；真实 GitHub Actions 运行未验收。
基线：`main` `8bb987a`。
修订：ADR-0018 "产品路径一律 approval `required`"；ADR-0020 "accepted trade-off 只来自 local user"；
`integrations/github/README.md` 的"远程写入未实现"。

## 背景

MergeWarden 要作为本仓库和作者其他项目的 PR 审查与经验沉淀工作流，运行在 GitHub 托管 runner 上。
现有学习链路有三个前提在 CI 里不成立：

1. 状态目录在本机长期存在。托管 runner 每次都是新机器，任务结束磁盘即销毁。
2. Skill bank 用 `repositoryId = sha256(本地路径)` 分区，CLI 不能指定稳定的分区键。
3. 人工反馈只有本地 CLI 一个入口，产品路径的学习结果必须人工审批。

定位是作者自用的研发效能工具：可信评论者范围是仓库的 owner、member 和 collaborator，
可以接受比 ADR-0018 更弱的治理，但不跨仓库共享经验。

## 决策

### D1 托管 runner + 瘦状态仓库

- 状态存放在一个私有 Git 仓库，每个被审项目一个目录：`<state-repo>/<owner>/<name>/`，
  即 MergeWarden 的 `--state`。不同项目写不相交的目录。
- 只提交权威数据和交付记录，由该目录下的 `.gitignore` 白名单决定：`skills/`（锁文件除外）、
  `runs/*/{run.json,report.json,report.md,navigation.json}`、`snapshots/*.json`、`channels/`。
  `blobs/`、`graphs/`、`locks/`、`auth/`、`session.jsonl` 不提交。
- 同目录的 `.gitattributes` 为 `* -text`。报告与快照按字节校验哈希，Git 不能改写行尾
  （在 `core.autocrlf=true` 的机器上实测会使 `Report integrity mismatch`）。
- 冻结源码不存副本。`hydrateSnapshot` 按快照清单里的 base/head commit 从被审仓库的 Git
  对象恢复文本 blob，逐个校验 SHA-256 与清单一致，不一致即失败。只支持 commit 快照。
- 一次任务一个 commit。推送被拒（远端已前进）时 `pull --rebase` 后重试，最多 4 次。
  项目目录不相交，正常情况下 rebase 不会冲突；冲突即视为同项目并发写，任务失败，
  靠幂等重跑恢复。工作流用 `concurrency: mergewarden-state-<repo>`（不取消）让同项目任务排队。
- 先推送状态，再在 PR 上发报告评论。可见的报告一定有持久化的运行记录。

### D2 稳定分区键

`review --repository-key KEY` 传入 `ReviewOptions.skillRepositoryKey`，审查前的待学习过滤也用它。
通道固定为 `github:<owner>/<name>`（小写）。反馈来源从运行清单继承这个键。

### D3 评论触发与信任

- 只处理首个非空行以 `/mw` 开头的 PR 评论：
  `/mw [wrong|missed|contract|tradeoff|unsure] [finding:ID] 说明`。
  verdict 依次映射为 `correction`、`missed_defect`、`contract`、`accepted_tradeoff`、`uncertain`。
- 可信作者：`user.type == "User"` 且 `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`。
  机器人一律不可信。判断在 CLI（确定性业务逻辑）里做，工作流的 `if` 只做粗筛。
- 新的来源身份 `identity: 'github_collaborator'`，`trust: 'trusted'`，并记录 `channel`
  （仓库、PR 号、评论类型与 id、作者、association、链接）。`channel` 不进入学习输入。
- 行内 review 评论在 RIGHT 侧、且 `original_commit_id` 等于所选运行的 head commit 时，
  `original_start_line..original_line` 成为反馈 range。`tradeoff` 必须有这样的 range。
- ADR-0020 的"人工决定"从 `local_user` 扩展为 `local_user` 或 `github_collaborator`
  （`humanFeedback`）。模拟反馈和运行来源仍不能创建、撤销 accepted trade-off。

### D4 幂等与乱序

- `eventId = fb-gh-ic-<id>`（issue 评论）或 `fb-gh-rc-<id>`（review 评论）。
- 通道不信任 webhook 里的评论正文，处理时用 `GITHUB_TOKEN` 重新读取评论当前状态；
  404 视为已删除。目标状态由当前评论决定：内容相同为 `unchanged`；内容变化保存
  `version + 1`；删除、去掉 `/mw` 或作者不再可信则撤回（`withdrawn`，`version + 1`）。
  重复投递、乱序到达和手动重跑都收敛到同一结果。
- 后续版本沿用第一次选定的运行（bank 要求同一 eventId 的 runId 不变）。
- PR 与运行的对应关系由审查任务写入 `channels/github/pulls/<n>.json`，不从评论里解析，
  避免任何人伪造标记把反馈指向别的运行。

### D5 取消审批，仅限可信人工反馈

- `github feedback` 保存反馈后以 `approval: 'auto'`、`feedbackOnly: true` 学习当前分区的待处理反馈，
  决定记为 `host_auto`。这修订 ADR-0018 的"产品路径必须审批"，但只放开这一条路径。
- 审查任务用 `--learn off`：模型自身的审查结果不在通道里自动学习。没有人工把关时，
  只允许人写下的经验直接生效。
- ADR-0018 的写入门禁（novelty 比对、规范化、重复与近似重复拦截）不变。
  退回方式不变：`skills disable` / `skills rollback`，或撤回原评论。

### D6 运行边界

- 复用工作流 `.github/workflows/mergewarden-channel.yml`（`workflow_call`）。MergeWarden 从自己的
  checkout（默认 `takagibit18/MergeWarden@main`）运行，被审仓库只作为数据检出，
  `persist-credentials: false`，不安装依赖、不执行代码。
- 只审查同仓库分支的 PR。fork PR 拿不到 secrets，跳过。
- 凭据：`MW_STATE_TOKEN`（仅状态仓库 contents 读写），`MW_MODEL_API_KEY`，工作流 `GITHUB_TOKEN`
  仅需 `contents: read`、`pull-requests: write`、`issues: write`。

## 不做

- GitHub App、webhook 服务或托管平台。
- 发布行内 review 评论或 check run；报告作为一条 PR 评论发布（再次审查时编辑上一条）。
- 跨仓库共享 Skill。
- 状态仓库的保留与压缩策略。运行记录会持续增长，单独立项。

## 验证

`tests/github-channel.test.mjs` 用本地 bare 仓库代替状态仓库，覆盖：
命令解析、信任判定、重放/编辑/去标记/删除的收敛、白名单提交内容、新 runner 上从 Git 恢复 blob、
可信 trade-off 评论在无审批下成为 active Skill、推送被拒后 rebase 重试、
新 runner 上的下一次审查绑定该 Skill，以及 CLI 读取 webhook 载荷。
GitHub API 读取、评论发布、反应和真实 Actions 运行没有自动化测试，需要在配置 secrets 后实际验收。
