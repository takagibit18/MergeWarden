# 文档清理审计

日期：2026-09-12。起点：`codex/review-skill-retrieval-hardening`，提交
`3a1c15a4eab02fc6296869d46635ee172e2b6e2c`；清理分支：`chore/repository-docs-cleanup`。
本次只处理仓库卫生和文档，不修改 Python、测试用例、评测配置、基线、回放、图片或运行数据。

## 判断方法与恢复

结合旧稿正文、当前实现、回归测试引用和现行入口判断。复选框、文件日期及旧测试通过数量都不作为当前完成证明。
本轮验证是文档及引用检查，不重新验证历史模型实验。

下表退出主干的原文均能在上述提交中恢复，例如：

```bash
git show 3a1c15a4eab02fc6296869d46635ee172e2b6e2c:docs/analyzer_dev_plan.md
```

本机额外保存原文于 `.codex-artifacts/docs-cleanup-20260912/originals/`（不提交）。
个人 Claude 配置、Cursor 计划和面试材料保留原本地路径，仅取消跟踪。

## 退出主干的材料及保留内容

| 原路径（相对仓库） | 判断 | 保留去向 |
|---|---|---|
| `.claude/settings.json`、`.claude/settings.local.json` | 个人目录及命令权限，不是可移植项目配置 | 原路径本地保留并精确忽略 |
| `.cursor/plans/review_loop_failure_analysis_1556ec02.plan.md` | pending 任务已被后续反馈、预算和收尾实现取代 | 本地保留；设计记录 §2 |
| `mergewarden_agent_interview_qa.md` | 个人求职材料，无运行引用 | 本地保留并忽略 |
| `eval/fixtures/.gitkeep` | 目录已有受控 fixture，无占位需要 | 删除占位文件，fixture 不变 |
| `docs/graph-ab/formal-collection-readiness.md` | 与 eval 下报告字节完全相同 | 保留 `eval/reports/graph-ab-formal-readiness.md` |
| `docs/project_plan.md` | 初始个人目标、两人分工、排期、CLI-only 阶段过期 | 设计记录 §1；维护待办 |
| `docs/analyzer_dev_plan.md` | M0–M7 已有对应模块；默认轮次、无工具完成、旧签名不宜继续指导开发 | 设计记录 §1–3；未核实观测项进入待办 |
| `docs/mvp_plus_four_directions_implementation.md` | 原文明确历史快照，旧 fixture 数量和 CI 描述过期 | 设计记录 §1、§4；现有 location / context 契约 |
| `docs/mvp_plus_roadmap.md` | 将现有 webhook、worker、发布能力描述为未来；旧 CI gate 不符合当前工作流 | 当前 README / 平台指南；旧质量证据保留于 mvp_plus_eval_closure |
| `docs/v0.2.0_reliability_quality_plan.md` | 旧发布步骤及 FindingVerifier 路径过期；七步 checkpoint 不等于当前两步实现 | 设计记录 §3、§7；恢复与 GA 验收缺口进入待办 |
| `docs/superpowers/plans/2026-07-12-diff-only-local-eval.md` 及对应 specs 下 `2026-07-12-diff-only-local-eval-design.md` | file-backed local_smoke fixture 已存在，实施步骤退出 | 设计记录 §4；fixture 契约 |
| `docs/superpowers/plans/2026-07-12-offline-cache-eval.md` 及对应 `offline-cache-eval-design.md` | 配置、offline cache miss 分支与测试存在 | 设计记录 §4；fixture 契约 |
| `docs/superpowers/plans/2026-07-12-reproducible-golden-eval.md` 及对应 `reproducible-golden-eval-design.md` | per-command Git 配置与缓存恢复已实现 | 设计记录 §4；fixture 契约 |
| `docs/superpowers/plans/2026-07-12-forced-tool-provider-compat.md` 及对应 `forced-tool-provider-compat-design.md` | 旧 provider 泛化规则已演进，测试已有 Zhipu GLM-5.3 特例 | 设计记录 §6；保留 provider 回归测试 |
| `docs/superpowers/plans/2026-07-12-verifier-hit-rate-recovery.md` 及对应 `verifier-hit-rate-recovery-design.md` | 有界上下文、风险步骤与缓存发布已存在；旧 verifier 文件及接口不再存在 | 设计记录 §3–4；不宣称历史质量门已重新验收 |
| `docs/agent_hallucination_chain.md` | 一次运行的排障推测，不是现行契约 | 设计记录 §2，保留“推测未确认”限制 |
| `docs/review_loop_failure_fix.md` | 旧反馈/预算修复过程，混合多个默认值与单 fixture 结果 | 设计记录 §2；当前收尾契约 |
| `docs/eval_cache_diagnostics_20260730.md` | 阶段性缓存诊断与探针数据 | 设计记录 §4–5；真实复测状态待确认 |
| `docs/relation_graph_cold_build_optimization_20260731.md` | 实现说明可归纳，性能数值只对应旧样本 | 设计记录 §5；旧阻塞不标为当前已解决或仍存在 |
| `docs/review_skill_retrieval_implementation_plan.md` | 三层功能和 hardening 已有实现，分支执行指令过期 | 检索架构、验收手册、设计记录 §8 |
| `docs/review_skill_retrieval_agent_prompt.md` | 绑定旧分支和特定工作区的执行指令 | 不保留执行提示；设计及约束并入正式文档 |
| `docs/review_skill_retrieval_delivery.md` | 提交拓扑、当时测试输出属于交付历史 | 验收手册保留历史离线证据与 live A/B 未执行边界 |
| `eval/reports/core-eval-zero-hit-fix1.md`、`fix2.md`、`fix2-preflight.md`、`fix2-source-order-preflight.md`、`fix3.md`、`fix4.md`（均有相同前缀） | 中间矩阵退出主干，不改变评分或原始数据 | 保留 zero-hit-chain 汇总、正式 contract-final 和 length-recovery 报告；详细旧矩阵按固定提交恢复 |

## 改造后继续保留的材料

- `golden_fixture_snapshot_plan.md` 改为 [golden_fixture_contract.md](golden_fixture_contract.md)：固定 revision、full_pr / partial_pr / legacy、验证失败分类仍是有效契约；移除已完成迁移步骤和旧数值门。
- [检索架构](review_skill_retrieval_architecture.md)保留设计主体，删除三层 PR 排期和预计修改文件列表，标明历史调研与当前已落地能力；验收不再依赖已删除计划。
- [兼容矩阵](finding-contract-compatibility-matrix-20260910.md)消除 pilot v2-only 的内部矛盾，不再依赖本地忽略的交付稿作为唯一解释。
- [MVP+ closure](mvp_plus_eval_closure.md)、[Graph coupling audit](graph-ab/current-coupling-audit.md)、[phase2 readiness](graph-ab/phase2-pilot-readiness.md)保留历史证据，并明确不是当前运行状态。
- [Graph 研究规划](mergewarden_graph_ab_experiment_plan.md)、[9 月修复方案](graph_review_verifier_root_cause_and_plan_20260905.md)暂留：包含自适应路由、因果包、统计设计和未确认实验门，不能按日期整份删除；本轮仅标明历史与提案边界，后续需专项逐项核验。
- [错误记录](error_log.md)暂留独有排障证据，不把“合并文档”变成丢失根因记录；新增入口提示历史状态不等于当前状态。
- `eval/baselines`、`contracts`、`experiments`、`variants`、`replays`、Golden fixtures 和其校验测试保留，避免破坏封板和重放。

## 引用与维护

`agent.md` 改为设计记录、维护待办和现行契约入口；正式文档引用随迁移更新。
历史错误表和实验汇总中的旧文件名作为溯源文字保留，并通过固定提交恢复，不伪装为当前可打开文件。
本轮不重写 Git 历史，不删除冻结 tag，也不执行旧计划中的编码、外部模型、发布或分支操作指令。

## 本轮验证结果

- 拟提交文件集合由 443 个收敛为 412 个（退出 35 个，新增 4 个）；docs 由 47 个变为 27 个。
- 保留文档及新增文档的 Markdown 本地文件链接检查：无失效链接。现行文档无已退役材料引用；审计与历史记录中的溯源文件名除外。
- `git diff --check HEAD`：通过。
- `python -m pytest tests/test_github_action_happy_path_docs.py tests/test_github_advisory_workflow.py -q`：3 passed。
- `python -m eval.core_eval audit`：PASS，5 个 full-workspace fixtures、2 个 candidates。
- 个人配置与材料的本地文件和备份逐字节一致，忽略规则生效。
- 变更范围检查：未修改 Python、tests、marketing、评测配置、基线、实验数据或回放。
- 未运行全量业务测试、真实模型 A/B 或外部发布；本轮文档变更不能替代历史发布与性能验收。
