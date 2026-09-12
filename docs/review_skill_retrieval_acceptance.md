# Review Skill Retrieval 验收手册

设计见[检索架构](review_skill_retrieval_architecture.md)。本手册不依赖旧 stacked branch 或实施计划。
默认仍是 `sequential`；切换为 `deterministic` 需要独立真实 A/B 证据。

## 离线检索门

在仓库根目录运行，将新结果写到忽略的 outputs，避免覆盖已保存报告：

```bash
python -m eval.skill_retrieval --skill-bank eval/skill_banks/retrieval-v1 --fixtures-dir eval/fixtures --output-json eval/outputs/retrieval-validation-1.json
python -m eval.skill_retrieval --skill-bank eval/skill_banks/retrieval-v1 --fixtures-dir eval/fixtures --output-json eval/outputs/retrieval-validation-2.json
```

两次 JSON 应逐字节相同（报告无 timestamp）；检查：

- `recall_at_k = 1.0`；candidate/deprecated selection、hard-budget violation、budget loss 均为零。
- 报告记录实际 `top_k`、`char_budget`、`legacy_fallback_limit` 和非空 bank digest。
- 固定 bank 与生产 `review_skills/learned.jsonl` 隔离，人工标注理由见 [bank README](../eval/skill_banks/retrieval-v1/README.md)。
- [holdout](../eval/holdout/retrieval-v1.json) 中 pending 条目不进入分母；独立裁定后才提升，且与已标注 fixture 集合隔离，不硬编码旧样本数量。
- malformed metadata 被记录并跳过；缺失 metadata 保持兼容，但无 scoped match 时不超过 legacy fallback limit。

## 回归门

```bash
python -m pytest tests/test_review_skills.py tests/test_review_experience.py tests/test_github_feedback.py tests/test_skill_retrieval_eval.py tests/test_config.py tests/test_prompts.py tests/test_agent_loop.py tests/test_eval_runner.py -q
python -m pytest -q
python -m ruff check src eval tests --exclude eval/outputs
git diff --check
```

重点检查同 run 多轮 selection 不变、下一 run 可见新 digest、完整 Core、原子预算装载、确定排序、
oversize continue、production/eval 配置一致以及 telemetry 不含 raw diff。
验收过程不写生产经验 bank、不改变依赖或 gold。

## 真实模型 A/B 与默认切换

固定相同 model、temperature、reviewed fixture subset、samples、context mode、Graph cache mode、
预算和非空 bank digest；两组唯一的处理差异是 `skill_retrieval_mode=sequential` / `deterministic`。
运行前记录可接受的 p95 和工具调用回归界限，不能看完结果再调门槛。

切换默认前必须同时满足：

- candidate finding recall 不低于 baseline，false-positive rate 不高于 baseline。
- schema / workflow validity 不退化，invalid 单独记录，不能作为成功空结果。
- skill prompt tokens/chars 下降或相关性提高。
- 工具调用与端到端 p95 没有超过预先定义的回归界限。
- 报告能绑定相同 bank digest、代码版本与有效配置。

未满足则保持默认；即时回滚是 `REVIEW_SKILL_RETRIEVAL_MODE=sequential`，不需要破坏性数据迁移。

## 历史证据及其限度

2026-09-05 交付记录报告：6 个已标注真实 fixture 的离线 Recall@5 / Precision@5 均为 1.0，
irrelevant、budget loss、candidate/deprecated selection 和预算违例为零；当时记录的 bank digest 为
`16f444a4756464e59863b0a7a5be79b3fe1f98ed3e22fecdf7ee0651106fa13a`。
固定报告保留在 [review-skill-retrieval-v1.json](../eval/reports/review-skill-retrieval-v1.json)。

这些是历史离线检索证据，不是本次清理复测的结果；当时 provider-backed live A/B 未执行，
不能据此声称最终 finding 质量、费用或时延有优势。旧分支/提交拓扑和测试流水可按
[清理审计](documentation_cleanup_audit.md)中的固定提交恢复。
