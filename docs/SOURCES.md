# 参考来源与核对边界

整理：2026-09-23。外部设计只提供参照，不构成本项目性能或生产能力证明。

## [S1] Pi SDK / ResourceLoader / Extension 接口

https://pi.dev/docs/latest/sdk

本次网页核对。SDK 底座、资源加载、原生 session 接入的设计依据。

## [S2] Pi session format / CustomEntry

https://pi.dev/docs/latest/session-format

本次网页核对。原生 JSONL、分支以及不进入 LLM 上下文的 custom entries。

## [S3] Pi coding-agent package manifest

https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/package.json

本次读到 0.84.1 / @earendil-works / Node >=22.19.0；不是 npm 安装结果。

## [S4] Tree-sitter static node types / binding manifest

https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types

本次网页核对；binding 源码版本 0.27.0，registry 与 grammar ABI 尚未验证。

## [S5] RepoGraph v1

https://arxiv.org/html/2410.14684v1

本次读取 HTML。借鉴仓库图与工具查询；不将修复实验当作本项目 review 效果。

## [S6] Alibaba Open Code Review

https://github.com/alibaba/open-code-review

前两轮源码讨论参照；核对版本 a003b9341a65130b024829101ea35494b56569e1。重点 code_comment 与 session/resume，不是恢复能力实测。

## [S7] Codex 原生 review 实现

https://github.com/openai/codex/blob/595cc91e8cbb1c2ca822d0311dcf12709410c582/codex-rs/core/src/tasks/review.rs

前两轮源码讨论参照。结论仅限该原生 review 路径，不推断所有 Codex 产品。

## [S8] TypeSafe 官方开发 Skill

https://github.com/typesafe-ai/skills/blob/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai/SKILL.md

前两轮核对资料。Jev 局部有类型判断的设计参照。本次 TypeSafe 在线文档访问失败，API 留待集成时重查。

## [S9] Alibaba VS Code 扩展架构

https://github.com/alibaba/open-code-review/tree/a003b9341a65130b024829101ea35494b56569e1/extensions/vscode

前两轮源码讨论参照。只借鉴引擎与薄客户端分层，不复制其实现。

## [S10] LocAgent 论文与固定源码

论文：https://aclanthology.org/2025.acl-long.426/

正文：https://arxiv.org/html/2503.09089v2

源码：https://github.com/gersteinlab/LocAgent/tree/4935b557326c154bad8e8dcf3747cc8d32d1f387

许可：https://github.com/gersteinlab/LocAgent/blob/4935b557326c154bad8e8dcf3747cc8d32d1f387/LICENSE （Apache License 2.0）

本次核对 directory/file/class/function 层级、contains/imports/invokes/inherits 关系、实体搜索和多跳遍历。MergeWarden 未复制其图构建代码：对固定机制做适配，并保留不可变快照、Tree-sitter、保守唯一解析、源码证据、资源边界和可恢复发布。逐项 faithful/adapted/not used 状态及实现证据见 `eval/locagent/entity-graph-v4-fidelity.json`；schema v4 决策见 ADR-0014。

## [S11] Alibaba OpenCodeReview / AACR-Bench

OpenCodeReview：https://github.com/alibaba/open-code-review/blob/main/README.md

论文：https://arxiv.org/abs/2608.09290

AACR-Bench：https://github.com/alibaba/aacr-bench

指标定义：https://github.com/alibaba/aacr-bench/blob/main/docs/metrics.md

2026-09-23 核对。公开 benchmark 描述为 200 个真实 PR、50 个项目、10 种语言；OpenCodeReview 论文表 3 按模型报告 finding F1 17.9%–25.1%、precision 25.2%–37.8%、recall 11.7%–20.0%，并报告相同模型相对 Claude Code 的 token/延迟优势。README 的 1,505 个 expert-verified ground-truth issues 与 AACR-Bench 当前 README 的 2,145 个 review comments 不是同一口径，引用时分别保留。其语义和位置匹配、数据规模、语言范围均不同于 RealGolden40，不直接比较排名。

## [S12] CodeGraph README / benchmark

README：https://github.com/sina-parsania/CodeGraph/blob/main/README.md

Benchmark：https://github.com/sina-parsania/CodeGraph/blob/main/docs/BENCHMARK.md

2026-09-23 核对。这里把用户所称 CodeGraph 解释为 `sina-parsania/CodeGraph`。公开结果包括 93.8%–98.7% 的 compiler-oracle 图边精度、68 个 who-references 问题上的 precision 0.75 / recall 0.87 / 99% answer rate / 227 平均响应 bytes，以及 benchmark 中约 21 ms 的查询延迟。它衡量图边和引用检索，不等同于代码审查 finding precision/recall；本项目尚无同口径 compiler-oracle 基准。

## 本次仓库搭建的版本固定

已从官方 npm registry 安装 Pi coding-agent 0.84.1、web-tree-sitter 0.27.0 和 tree-sitter-python 0.25.0，并提交真实 lockfile。Pi 行为以安装包源码和 smoke 为准；grammar 来源、commit、ABI 和 SHA-256 见 integrations/tree-sitter/grammars/python.lock.json。前述正文保留骨架生成时的核对边界，最新执行结果见 VALIDATION.md。
