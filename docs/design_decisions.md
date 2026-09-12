# 长期设计记录

本文件保留旧开发计划中仍有价值的选择、理由和边界，不复刻已完成的任务步骤。
整理基线为 `3a1c15a4eab02fc6296869d46635ee172e2b6e2c`（2026-09-12）；实现接口以
[共享契约](shared_contracts.md)、[架构](architecture.md)及对应代码为准。
旧稿去向见[文档清理审计](documentation_cleanup_audit.md)，未确认的工作见[维护待办](maintenance_backlog.md)。

## 1. 产品边界与共用入口

- MergeWarden 提供 advisory review、neutral check 和变更行评论；CI / branch protection 仍负责合并裁决。
- CLI 与 HTTP 共用请求、响应和编排实现，避免维护两套审查协议。
- 五阶段循环分离上下文准备、模型推理、工具执行、结果处理和继续判断；工具 schema 由编排层构造。
- 完整仓库是按需取证的 workspace，不是初始 prompt。PR diff 是审查目标，未变更源码可以提供支撑；不能把全仓历史问题当作 PR 引入的缺陷。
- readonly/write/execute 的权限与并发边界不因新增 verifier 或工作流而扩大。

来源：原 project plan、Analyzer plan、MVP+ 四方向说明。
实现入口：[编排契约](cli_tools_orchestrator_contract.md)、[执行工具设计](execute_tools_design.md)。
初期两人分工、13 天工期、CLI-only 与 GitHub/worker 尚属未来的排期已失效，不再保留为现行路线。

## 2. 结构化输出与有界收尾

- 早期选择 Python prompt 模块和 submit 伪工具，是为了复用类型、工具协议和可替换 provider，避免独立模板与自由文本解析体系。
- “模型没有调用工具”不等于完成；placeholder、缺少合法提交和空白报告不能伪装成成功。
- 输入上下文预算与运行累计预算不同；收尾、修复和 verifier 请求也必须受实际请求预算和总预算约束。
- 工具反馈短窗口适合 prompt；长期事实和证据不应随窗口淘汰。EventLog 用于观测，Journal 用于可恢复事实，两者不互相替代。
- 收尾时保留 draft 和真实证据。具体工具和解析规则必须按 finding contract 版本选择，不能把旧 v2 submit-only 方案直接套到 v3 save/revise/finish。

来源：Analyzer plan、Cursor review-loop plan、review-loop 修复及 force-submit 排障稿。
现行边界：[调查与修复契约](investigation_state_and_repair_contract.md)、[架构中的 Journal 与 v3](architecture.md)。
旧稿的固定 review 轮次、预算倍数、正则 JSON 兜底及“无工具即成功”不再是实现要求。
force-submit 排障稿中 HTTP 400 / tool_call_id 的原因当时只是推测，不能升级为已证实的历史事实。

## 3. 独立验真与可信证据

- 生成候选与批准发布分离；缺 verdict、格式错误或 provider 失败不能产生未经验证的风险发布。
- verifier 使用候选相关的有界上下文。直接传整个反馈窗口会丢失早期证据并增加噪声；无界的第二套工具循环会增加延迟和状态复杂度。
- 语义判断与确定性完整性校验分开观测。不能把系统位置/来源拒绝全部算作模型拒绝，也不能把 integrity verified 当成 semantic accepted。
- source、snapshot、range、revision 和批准身份由运行时绑定；模型声明、Graph 路径或 manifest 元数据本身不是已经展示的源码证据。
- 修改内容或证据后必须重新绑定、复核。展示裁剪不能改变事实身份，未展示或部分覆盖的正文不能被补记为完整证据。
- 草稿校验按风险候选触发，info-only 输出不能因不存在的风险步骤被错误判为 workflow incomplete。

来源：v0.2 reliability plan、7 月 verifier-hit-rate plan/spec、Core Eval zero-hit 修复链。
现行边界：[字段所有权](finding_contract_field_ownership.md)、[共享契约](shared_contracts.md)、[兼容矩阵](finding-contract-compatibility-matrix-20260910.md)。
旧计划的 `FindingVerifier` 文件名、confidence 提升规则、shadow/off 回滚和候选 ID 算法具有版本限制，不作为 v3 的通用要求。

## 4. 可复现 workspace 与缓存

- fixture 固定 Git revision，先验证源码与 diff 的一致性，再调用模型；恢复失败、fixture 无效和模型漏检分别统计。
- `local_smoke` 的文件片段只证明本地 runner / 模型链路，不能充当完整 Golden 基线。
- 离线 workspace 模式只读本地缓存；缺少目标 commit 明确失败，不偷偷联网。缓存命中优先本地恢复。
- TLS backend 和 safe-directory 采用单命令、明确目录配置，不修改全局 Git 配置或关闭 TLS 校验。
- 并发初始化采用独立临时目录和有界发布重试；已存在的有效缓存不能被失败任务清除，清理失败不能遮盖原始错误。
- 关系图索引放在临时 checkout 外；有 remote 的仓库采用稳定身份。缓存还需检查构建版本、resolver 和参数画像，不能仅凭文件存在判断可复用。

来源：7 月 diff-only / offline-cache / reproducible-golden 三组 plan/spec、缓存诊断。
实现：[eval runner](../eval/runner.py)、[持久化索引](../src/analyzer/persistent_index.py)。
规范：[Golden fixture 契约](golden_fixture_contract.md)。

## 5. 图规模与证据强度

- 边去重、出入邻接和符号名称使用内存索引，避免每次操作扫描全图导致近似二次复杂度。
- 反序列化、拷贝、删除或 resolver 替换图后重建私有索引；保持外部格式兼容。
- 高基数歧义候选超限时整体降级并记录省略数量，不能任意取前几个制造确定关系。
- `TESTED_BY` 只由满足强度要求的调用或引用派生；弱关联不能膨胀为强证据。
- 合成规模探针、当前仓库探针与真实 Golden PR 复测是不同证据，不能互相替代。

来源：2026-07-31 冷构建优化记录。
实现：[CodeRelationGraph](../src/analyzer/code_graph.py)、[关系图契约](v023_v025_root_cause_relation_graph.md)。
原报告的速度倍率、SQLite 大小和旧 builder 版本仅对应当时工作负载；不作为当前性能承诺。

## 6. Provider 兼容必须集中且不弱化校验

- forced tool 的兼容适配在模型请求边界处理，使用有效配置副本，保留调用方配置及无关 extra_body。
- 不通过移除强制工具约束、改自由文本或无限重试来掩盖 provider 不兼容。
- 7 月设计中“GLM 一律关闭 thinking”的泛化已经过期；当前按 provider / API / model profile 分流。
  例如 Zhipu GLM-5.3 与旧 DashScope 行为不同，不能依据模型名字套用旧规则。

实现与证据：[模型客户端](../src/models/client.py)、[兼容元数据](../src/models/compat.py)、[模型客户端回归](../tests/test_model_client.py)。

## 7. 持久化与副作用恢复

- 原子 claim、lease owner 检查和 heartbeat 防止多个 worker 同时占有任务。
- checkpoint 保存可验证的产物引用与 digest，不序列化活跃模型客户端或数据库连接。
- artifact 原子替换，GitHub 发布使用稳定身份以支持恢复；数据库升级保留旧数据，不依赖破坏性 down migration。
- 旧计划的七步 checkpoint 是目标设计；当前 worker 的实际阶段是 `review_pipeline` 和 `persist_artifacts`。
  因而不能声称已实现“从 verifier 后继续、跳过全部模型调用”的细粒度恢复。

来源：v0.2 reliability plan。实现：[worker](../src/platform/worker.py)、[平台说明](platform_mvp.md)。

## 8. Skill 检索与评测证据

- Core 常驻；active 仅表示有资格检索，candidate/deprecated 不进入生产选择。
- 可选 metadata 向后兼容；坏 metadata 跳过，无 scope 的旧记录仅有界回退。
- 排序及 tie-break 确定、完整记录原子装入预算、过大条目使用 continue；Core 不静默截断。
- 同一 run 固定 selection 和 bank digest；Graph 只提供路由信号，不成为 bug 证据。
- 固定评测 bank 与生产经验分开；未裁定 holdout 不进入分母。
- 离线检索准确率不能证明最终 finding 质量、费用和 p95 改善；默认切换需要同条件真实 A/B。

来源：retrieval implementation plan / agent prompt / delivery。
详细设计及验收保留在[检索架构](review_skill_retrieval_architecture.md)和[验收手册](review_skill_retrieval_acceptance.md)。
历史实验需区分 invalid、N/A、模型输出漂移和真实机制改进；零命中不能自动归咎 verifier。
保留[Core Eval 修复链](../eval/reports/core-eval-zero-hit-chain.md)的逐阶段结论，原始中间报告可按清理前提交恢复。
