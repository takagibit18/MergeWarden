# Golden Fixture 快照与审查范围契约

本规范由旧 snapshot plan 收敛而来。结构以 [eval/schemas.py](../eval/schemas.py) 为准，
执行以 [eval/runner.py](../eval/runner.py) 为准；主评测入口见 [eval/README.md](../eval/README.md)。

## 审查目标

PR diff 是审查对象，完整仓库快照是只读取证 workspace，不全量注入初始 prompt。
未变更源码可作为证据；GitHub inline 发布仍须映射回 changed lines。
fixture 无效、workspace 恢复失败、模型执行失败和质量漏检分别记录。

## Git workspace 与范围

`input.workspace` 固定 `repo_url`、`base_sha`、`head_sha`、`checkout_sha` 和 `diff_base_sha`。
同时显式区分 `review_scope`：

| 范围 | 要求 |
|---|---|
| `full_pr` | `checkout_sha=head_sha`、`diff_base_sha=base_sha`；从 Git 派生完整 diff，不信任旧 JSON diff 快照；禁止文件 overlay |
| `partial_pr` | 显式安全相对 `review_paths` 和非空 `scope_reason`；仅审查声明路径，不能冒充完整 PR；gold 位于声明范围内 |
| `legacy` | 兼容历史 fixture 行为，不进入 Core full-workspace set；不能从旧报告推定符合 full_pr |

`input.files` 继续服务小型文件用例。`local_smoke` 使用独立 suite、无 Git workspace，
只证明 runner / 模型链路，不参与 Golden 基线比较。

## 恢复与调用前校验

1. 通过本地 mirror cache 恢复到临时目录，checkout 固定 revision，并校验实际 HEAD。
2. 按 review_scope 解析有效 diff，验证新增行的文件、行号、正文与 workspace 一致。
3. 校验 expected / gold 的位置及范围声明，不把输入不一致交给模型纠错。
4. 使用临时目录作为 repo_path，以有效 diff 和 changed files 开始审查，再按需读取上下文。
5. 保留恢复、fixture 校验与 Agent 执行的阶段诊断；失败不能算作成功空报告。

镜像含所需 commit 时优先本地恢复；`EVAL_OFFLINE_WORKSPACE_CACHE=true` 时不远程 clone / fetch / update，
缓存或目标 commit 缺失必须明确报告 `offline cache miss`。离线 workspace 不等于离线模型调用。
`EVAL_GIT_SSL_BACKEND` 只作用于单次 Git 命令；不改全局配置或关闭 TLS。
缓存并发发布使用独立临时目录、有界重试和有效目标复用；不得清除其他任务的有效缓存。

## 标注与统计

- 正式 Golden 的人工 reviewed 状态须与 manifest 一致；候选标注未经裁定不自动提升为正式数据。
- 缺陷必须与被审查变更有关，不能用全仓历史问题或位置重叠替代语义判断。
- 负样本包含文档、测试、重构等无缺陷变更；来源可含 merged-bugfix 和 rejected-pr，后者先进入候选集。
- 保留 gold、matcher 和 finding contract 的版本绑定。历史 matcher 不因新版本上线而静默改变含义。
- 数值阈值、样本数、重复次数以当前评测配置与报告为准，旧 MVP+ 的 0.6 门槛不自动成为当前 CI 行为。

## 验证入口

```bash
python -m eval.core_eval audit
python -m pytest tests/test_eval_review_scope.py tests/test_eval_workspace_cache.py tests/test_core_eval.py -q
```

fixture 恢复的可复现性、diff 与源码一致性、只读取证和错误分类由对应回归保护。
真实模型质量验收须单独保留匹配当前 commit、配置与数据集的报告。
