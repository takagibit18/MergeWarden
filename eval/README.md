# Python retrieval evaluation

## GPT 配对批次（独立后继协议）

`real/ab-prepare.mjs` 和 `real/ab-launch.mjs` 使用现有 RealGolden40 全部公开任务，冻结
`openai-codex / gpt-5.6-luna / max`。A 为文本工具，B 为生产路由扩展自动触发的
`pi_structural_v1 + dispatch_v2`，不复用诊断样本的预选调查目标。Pi 仍拥有全部模型/工具循环。
这是用户指定的分阶段后继实验，不冒充旧 GLM 三臂 reserve/formal 锁已获得的新模型准入。

```sh
node --experimental-strip-types eval/real/ab-prepare.mjs /outside/new-output /outside/repository-cache
node --experimental-strip-types eval/real/ab-launch.mjs /outside/new-output /absolute/auth/auth.json --check-only
node --experimental-strip-types eval/real/ab-launch.mjs /outside/new-output /absolute/auth/auth.json
node --experimental-strip-types eval/real/ab-launch.mjs /outside/new-output /absolute/auth/auth.json --resume
```

先运行 `npm run verify`。准备仅使用已缓存 Git 对象；`--check-only` 校验代码、全部快照/图、
模型身份和隐藏标签的文件权限隔离，不访问真实模型。首次执行保留完整 80-job 计划，在
10 个配对/20 次首轮后退出。续跑要求阶段复审生成 `checkpoint-review.json`，其中
`decision: CONTINUE`、`experimentSha256`、`reviewedRuns` 和 `observedRunsSha256` 绑定实验及当前全部结果（后者为 `digest(latest.runs)`）。提前中断后续跑仍会在第 20 条暂停，复审该阶段后才可继续剩余样本。
不得用回执掩盖故障、覆盖失败或改变配置；代码变化应另建实验。失败、部分完成和观测异常均提前停批。

协议 `gpt-paired-ab-2` 冻结统一的 `review-closeout-1` 策略：A/B 共享同一操作/时间收尾规则，默认剩 20 次或 180 秒提醒，剩 10 次或 90 秒只允许提交及修正，硬上限仍为 100 次/600 秒。策略详细计费见主 README。旧协议必须保留原始结果，不能直接续接新代码。请求观测逐条关联请求审计与原生回答，将本地取消消息、真正中断的请求、供应商错误分开；未知用量保持缺失，不填零。

正式调用统计取 `toolExecuted`；宿主检索操作另记，共享引擎操作预算。禁用自动重试与压缩。
32768 是本地配置，当前 Codex 请求不携带服务端输出硬上限，不能宣称硬 token 等预算。
保留请求、原生会话、用量、首轮结果、图归因及准备成本；最终质量仍需独立于组别裁定。
已有语料及标签来源不变，不能因为新模型重新运行就称为未见样本或独立人工金标准。

## 真实 PR 候选扩充（独立于受控 Golden）

`real/manifests/candidates.index.json` 固定真实 PR 候选的 repository、完整来源 SHA、source-row hash 和准入状态；对应 lock 校验字节。它包含 40 个 c-CRAB 正例候选和 64 个 SWRBench source-clean 候选，**不是已审核的 40-case gold**。`screening.json` 只记录 Agent 对原始评语的功能范围筛选，不把排除的评语对应 PR 改标 clean，也不声称人工审查。已有受控 r1/r2 的文件、答案及历史成绩独立保存。

`real/tools/realgolden.py` 改编自用户提供的 RealGolden40 构造包，使用 Python 3.10+ 标准库。`sources.lock.json` 的 revision 2 保留同一个上游 commit，只纠正 Stage 3 的错误 size/blob，保留原记录和核验 URL。原始上游数据、项目对象缓存和运行结果放在 checkout 外；冻结任务及审核证据放在 `real/corpora/mergewarden-real-python40-v1`。下载只接受锁定字节，不接受最新分支替换。

```sh
npm run eval:real:build -- fetch --cache ../realgolden-work/upstream
npm run eval:real:build -- import --cache ../realgolden-work/upstream --out ../realgolden-work/draft-v1
npm run eval:real:probe -- --selection eval/real/manifests/pilot.json --output ../realgolden-work/pilot-v1 --offline
```

前两条命令下载及导入待审候选，不能自动接受标签。第三条验证四个预留工程 pilot 的原始 Git 对象、SnapshotStore、Graph 和 Pi SDK 报告交付。它只注册脚本 provider，刻意提交空 findings，token 是合成值；600 秒/1000 tools 是离线工程预算，不是已冻结的真人模型实验预算。省略 `--offline` 只做 Git/Snapshot/差异分页预检。`--repositories DIRECTORY` 可以复用有任务身份回执的对象缓存；输出目录不可重复使用。

`real/adapter.mjs` 使用空工作目录中的原始 Git 对象，不写出源码文件、不重造提交、不运行 checkout filters、hooks、Python、setup 或项目测试。SnapshotStore 在 commits 输入下读取原始 blob；所有工具和报告继续走同一个 ReviewEngine。公开任务只允许 case ID、仓库、base/reviewed SHA、语言和输入策略；source comments、fixes、gold 不进入模型输入。每个缓存的 origin 和任务身份都必须匹配。

审核必须检查**实际 base→reviewed 差异**是否与原始标签适用范围相同。上游 base 可能来自更晚或不同分支，产生额外回退。`sourceReviewPaths` 的不匹配是阻断证据；路径相同仍需检查 hunk 和语义，不能据此认定 clean。不得静默换 base、用 merged SHA 或倒放补丁。更正需新版本、Git 历史依据和重新审核。审核必须明确 agent/human、diff scope、context requirement、源码锚点与 severity；不足 24 defect + 16 clean 时 freeze 失败。

```sh
node --experimental-strip-types eval/real/assess.mjs --candidates ../realgolden-work/draft-v1/candidates.hydrated.jsonl --probe ../realgolden-work/pilot-v1/result.json --output ../realgolden-work/assessment-v1
```

`assess.mjs` 保留初始 104 候选阶段的历史预检协议，不能用它判断新冻结集是否可启动模型。新流程使用 `eval:real:admission` 和 `eval:real-live`；旧受控 runner 仍然只接收 fixture。

`npm run verify` 包含离线构造器、scope、真实快照分页、准入、冻结 hash、续跑和开放标签评分测试，不下载上游、不访问模型。第三方项目源码不打包；冻结审核证据保留上游评论和出处，来源许可证不变。

## RealGolden40 冻结与运行协议

`real/manifests/closure-index.json` 记录扩充候选的 profile、筛选理由和 formal/reserve 选择。冻结集的 `public/tasks.jsonl` 只含 opaque ID 与 repository/base/reviewed SHA；`hidden/gold.jsonl` 保存答案；`audit/receipts.jsonl` 保存冗余 approved pool、源码 hash、真实父链、review/fix 和审核身份。当前标注由 Agent 静态复核，明确 `humanReviewed=false`；Grade B 不代表执行过上游测试。不能用 Graph coverage 或模型结果重新挑选这些样本。

以下命令在仓库根目录运行，路径占位符应替换为本机仓库外目录。`prepare` 是独立的 Git 对象获取/快照步骤；模型 loop 只复用本地对象，不联网获取目标仓库。

```sh
npm run eval:real:admission -- verify --corpus eval/real/corpora/mergewarden-real-python40-v1
npm run eval:real:admission -- prepare --corpus eval/real/corpora/mergewarden-real-python40-v1 --cache ../real-work/repositories --state ../real-work/state --output ../real-work/prepared.json
npm run eval:real:admission -- profile --corpus eval/real/corpora/mergewarden-real-python40-v1 --cache ../real-work/repositories --state ../real-work/state --output ../real-work/profiles.json
npm run eval:real:admission -- lock --corpus eval/real/corpora/mergewarden-real-python40-v1 --kind reserve --timeout-ms 300000 --max-tools 100 --run-output ../real-work/reserve-run --output ../real-work/reserve-lock.json
npm run eval:real-live -- --live --corpus eval/real/corpora/mergewarden-real-python40-v1 --experiment ../real-work/reserve-lock.json --cache ../real-work/repositories --output ../real-work/reserve-run
```

300 秒/100 tools 是 reserve 的初始运行配置示例，正式预算必须根据本机 pilot 冻结。锁固定 GLM-5.3-Flash、Pi、完整 prompt（含实际 cwd）、实现摘要和 Git commit；运行中不可改变。`--subset ID,ID`、`--arms T0,G0,G1`、`--repeat 2` 可缩小任务或重复运行。reserve 锁使用 `operational_retry`：`--resume` 可仅补跑未完整交付的 job，并保留每次失败尝试及 native session/report。formal 锁强制 `first_attempt`：一个 run key 第一次开始后，completed/partial/failed/timeout/中断记录都是唯一正式结果，resume 只运行从未开始的 job。无法确认拥有者的锁不自动清理。

`lock` 另支持 `--max-tokens 16384 --provider-reasoning-effort high`：通过与正式运行相同的 Pi 接入入口选择本次策略，产品 catalog 不变。新锁默认 8192 / `low`；显式档位支持 low/high/max，不再把内部 medium 偷换成原生档位，也不接受旧的 provider-default 配置。模型声明使用 Pi 原生兼容字段与档位映射；每轮发送前参数保存在原生会话审计条目中。调整必须新建 reserve 锁及输出目录，并让三组全部使用同一配置；正式锁必须匹配所依据的 reserve 配置。历史锁、原始请求和结果不可回填。

正式 `lock --kind formal --pilot ../real-work/reserve-run` 必须读取至少 6 个永久预留 task 的三组完成记录，校验原生交付及同一 snapshot，并要求 coverage 和实测 pilot 有调查余量。指定新 `--run-output` 和相同模型配置；只有返回 `READY` 的正式锁可用于 formal tasks。未完成 pilot 时不可启动正式付费实验，reserve 结果不进入正式质量报告。

正式预测裁定先运行 `blind --runs latest.json --gold hidden/gold.jsonl --output packet.json --key-output private-key.json`。裁定者只收到匿名 prediction、源码定位/证据、hidden reference 与 fix evidence；arm、run key、Graph 调用、metrics 和 trace 只在私有 key 中。填写后用 `unblind --judgments judgments.json --key private-key.json --output judgments.jsonl` 恢复 hash-bound scoring identity。`score --runs latest.json --gold hidden/gold.jsonl --adjudications judgments.jsonl --output scores.json` 使用这些裁定记录。原始未匹配 prediction 一律保留 `unadjudicated`；另支持 `matched`、`duplicate`、`new_valid` 和 `false_positive`。新有效 finding 必须写明源码与引入证据，语义重复不增加 TP；输出逐 prediction mapping、reference recall、已裁定 precision 和未知项上下界。不同 arm/repeat 应分别评分，不能将 reserve 与正式结果合并。

### 2026-09-23 Scheme A 正式实验结果

Graph preparation 完成 40/40 个唯一 generation（31 ready、9 partial），8 快照 G0/G1 热查询 16/16 通过 p95 ≤ 500 ms、max ≤ 2000 ms 门槛。统一模型/预算的 reserve pilot 为 18/18 completed，随后生成 READY formal lock。正式 40 tasks × 3 arms 的 120 个 `first_attempt` 均已保全，但 BigModel 自第 5 次运行起持续返回 1113“余额不足或无可用资源包”，因此只有 4 completed、116 failed；不存在可以在原锁下继续的未开始 job。

盲审只产生 1 条可裁定 prediction，结果 matched；precision 1/1，reference recall 1/72。完成数按 T0/G0/G1 为 1/2/1，唯一 finding 来自 G0 且为 text-only，Graph calls 为 0。该样本量不能用于三臂质量、成本或 Graph 增益结论。原 formal 输出必须保持不可变；充值后继续实验须创建 successor lock 和全新输出目录，不能把补跑结果合并或覆盖成本轮 first-attempt。

## 受控 Golden

这是同一个 ReviewEngine 的内部工具消融，不是产品模式。`cases.json` 当前为 **controlled-python-v02-20-r2**：4 单文件、4 跨文件、2 多跳、2 import/scope 缺陷，8 个 clean 对照。每例保存仓库逻辑身份、真实 Git base/head SHA、源码、定位、严重性、行为和人工可读理由。r2 经用户授权的 Agent 静态复核修订，作者已看过 r1 模型结果；在 r2 模型调用前冻结，不是独立人工标注或未见结果的 holdout。

`corpus.lock.json` 固定字节摘要。`materialize.mjs` 只用 Git 对象命令重建相同提交，不执行 Python，不 checkout hooks。修订必须有明确源码依据、授权和新 corpus 身份；不能为当前预测改答案。

## Corpus 版本与修订边界

旧版 [controlled-python-v02-20](corpora/controlled-python-v02-20/cases.json) 和 lock 按原字节归档，SHA-256 为 `ef748a3c5916190857e5cb8e4753b23274f7206833ada681763dd328b2b44939`。历史 GLM 20+20 结果只属于该版本。当前 r2 hash 见 [lock](corpus.lock.json)，逐例 predecessor/SHA、修改理由、severity 理由及 Agent provenance 见 [修订清单](corpus-revision.json)。这份清单是语料元数据，不是人工审核 receipt。

| r2 修订 | 源码层面的约定 |
|---|---|
| clean-guard | 保留正小数输入；两个版本的调用者都先把正数 count 归一化到至少 1，再移除 helper 的重复保护。ratio(1,0.5) 两边均为 1.0 |
| clean-key-migration / clean-alias / clean-conversion | 公共入口、输入域和私有 helper/alias 在两个版本源码中明确，不能只把范围写在模型看不到的 gold 中 |
| clean-shadow / clean-empty / clean-default | 分别检查局部遮蔽、调用者非空保护、始终传参使私有 mutable default 不被使用；替换原来简单的等价表达式改写 |
| multihop-units → multihop-retry | 换成两跳重试次数契约，避免重复一份相同单位转换 defect；旧 case 仍在 r1 |
| 12 个 defect 的 severity | 10 项 medium；错误删除与显式输出集合反转 2 项暂定 high；逐例理由不推断不存在的生产事故或安全事件 |

这些仍是每例 1–3 文件的受控样本。clean-alias 较容易，不能宣称 8 个 clean 都是高难 hard negative；cross-units/clean-conversion 有意成对，样本并非完全独立。r2 的源码行为目前基于静态推导，grammar/Snapshot/离线 Pi 验证不等于执行 Python 或真实模型质量验证。

执行、评分、trace 匹配和人工审核工具均可用 `--corpus DIRECTORY` 显式选择包含 cases/lock 的目录，默认当前 r2。旧结果配上 r2 标签会拒绝；不得把历史分数改称 r2 分数。例如重新核验旧评分：

```sh
npm run eval -- --score --corpus eval/corpora/controlled-python-v02-20 --output /outside/checkout/old-run --mapping /outside/checkout/old-run/mapping.json
```

历史 trace 或审核页同样附加 `--corpus eval/corpora/controlled-python-v02-20`。r1 的 dispute 不能因 r2 修订被抹除；若比较两套语料，需明确样本与源码不同，不能把分数变化归因于 Graph。

## 执行

先安装锁定依赖并运行 `npm run verify`。输出目录必须在本仓库之外且每次新建，状态与被审 fixture 也是并列目录。

```sh
npm run eval -- --offline --all --output /outside/checkout/offline-run
npm run graph:smoke -- /outside/checkout/graph-smoke
npm run eval -- --live --output /outside/checkout/live-smoke
npm run eval -- --live --all --repeats 3 --output /outside/checkout/live-repeat
```

实体图 v4 的工程 profile 固定读取清单中 8 个真实 Python 快照及其完整 SHA；它只读取 Git blob，不 checkout、导入或执行目标项目代码。缓存、Graph 状态和 JSON 结果都应放在 checkout 外：

```sh
node --expose-gc --experimental-strip-types eval/graph-profile.mjs --offline --cache /outside/checkout/repositories --state /outside/checkout/graph-profile-state --output /outside/checkout/graph-profile.json
```

普通标识符引用消融复用 Change A 提交 `598c9bc` 的旧提取器，并严格使用 profile 实际完成的 core 文件集合。`--legacy-root` 应指向该提交的只读 detached worktree；若依赖没有安装，可让它复用主 checkout 的 `integrations/tree-sitter/node_modules`。输出分别报告旧 `references` facts 的 UTF-8 增量和按旧 schema 物理列估算的保守 SQLite 下界；后者不含 `REFERENCES` 聚合关系行，也不冒充一次真实旧库构建的总大小。

```sh
git worktree add --detach /outside/checkout/mergewarden-change-a 598c9bc
node --experimental-strip-types eval/graph-reference-ablation.mjs --legacy-root /outside/checkout/mergewarden-change-a --cache /outside/checkout/repositories --state /outside/checkout/graph-profile-state --profile /outside/checkout/graph-profile.json --output /outside/checkout/graph-reference-ablation.json
git worktree remove /outside/checkout/mergewarden-change-a
```

默认 smoke 固定 4 例，可用 `--cases single-zero,cross-key` 选择子集；`--all` 跑 20 例。`--offline` 使用真实 Pi SDK 与刻意提交空 finding 的脚本 provider，token 是合成值，不能作为模型质量/成本证据。`--live` 从 `experiment.json` 指定的环境变量读取密钥，当前固定 bigmodel/glm-5.3-flash、120 秒、40 次工具预算。密钥不进入配置/结果文件。

各臂共享相同 snapshot 与 final_only/source evidence/schema/report delivery。T0 只用 BASE；G0/G1 在同一 BASE 上共享完全相同的中性 navigation policy，差异只限于各自 interface/retrieval 的机械说明。该 policy 说明 untouched context trigger、caller/reference/consumer/dependency 发现、不用结构导航重复确认已读位置，以及失败时回退文本/源码；不强制 Graph 调用。Pi 会附加 cwd，所以 A/B 固定相同仓库外 cwd。每组记录有效 system prompt、thinking level、API、endpoint、maxTokens、包锁 hash，逐对比较。运行前后核对整个引擎、适配器、schema 和 eval 源码摘要；实验途中修改实现会阻止有效比较。重复运行交替组顺序；Graph 缓存可在同 snapshot 后续运行复用，需按 cold/warm 指标解释成本。

## 原始结果与匹配

`raw.json` 保存逐例报告、交付状态、run manifest、实际 tokens、工具调用、review/build/query latency、Graph 覆盖与版本配置。原生 Pi JSONL、源码快照与报告保存在 `state/`。review latency 不包括创建 fixture 和预先冻结 snapshot 的时间；Graph warm request 含线程启动及缓存完整性核验，queryMs 单独记录。

`mapping.json` 给出逐个 prediction 的待判定项。审核 claim/trigger/impact 与 golden behavior 是否相同，填写 `goldenId`（误报用 null）、rationale、reviewer，并把 status 设为 complete。禁止只因行号相交判为匹配；一个 golden 最多匹配一个 prediction，重复 finding 按额外预测处理。

```sh
npm run eval -- --score --output /outside/checkout/live-smoke --mapping /outside/checkout/live-smoke/mapping.json
```

指标包含 finding precision/recall/F1、clean PR FPR、PR-level recall、cross-file recall、complete delivery rate；输入/输出/总 tokens、工具/图工具次数、review/build latency；逐例 indexed/parse-incomplete/resolved/candidate/unresolved 数量。无分母或缺少用量为 null；失败/partial 不从 recall/交付分母移除。保留 raw、mapping 和 perCase，不能只展示汇总。clean FPR 的分母是所有尝试的 clean 案例，必须与完整交付率一起读。

schema 位于 `schemas/golden-case.schema.json` 和 `schemas/evaluation-result.schema.json`；CI 验证 corpus hash、20 例 SHA 重建、真实冻结边界和指标算术。小样本、脚本 smoke 和“成功构图”都不能证明 Graph 带来审查增益。

## 独立人工复核

```sh
npm run eval:human-review -- --output /outside/checkout/human-review
npm run eval:human-review -- --validate /path/to/golden-human-review.json --output /outside/checkout/review-receipt
```

第一条命令生成离线 `review.html` 与待填 JSON。审核人先读逐文件 base/head，再展开既有标注，独立检查 bug、clean、expected behavior/输入域、severity 和 Graph 设计偏向。页面不显示模型预测或 A/B 结果；姓名、独立性声明、人工填写声明、五项判断与理由均由本人填写。未填项保持 pending，不能由 Agent 补成“人工已审核”。浏览器保存草稿并导出 JSON，不发送网络请求。

第二条命令验证 corpus hash、20 个 case 身份和 base/head SHA，生成 `reviewed-provenance.json`。其中每例有效 `annotationProvenance.status` 为 pending_human_review、human_reviewed_accepted 或 human_reviewed_disputed；保留签署人、日期和原始理由。软件只能验证声明与数据结构，不能自行证明审核人的身份。部分复核不会升级未审案例；不同意任一标签/行为/severity 或仍有偏向疑问时，必须标记 needs_revision/reject，不能静默接受。

此 receipt 是绑定所选 corpus 的人工来源记录，不修改冻结 case/答案/lock。r2 的 `annotationProvenance` 如实描述 Agent 编写和复核来源；`corpus-revision.json` 保存 Agent 状态，不可冒充这里的人工声明。只有实际人工作答才能生成 human_reviewed 状态。后续再次修订须另建版本，旧实验继续引用原 hash。schema 见 `schemas/human-review.schema.json`。

## 受控端到端接入采样

`controlled-e2e` 在已有三个不可变历史案例上验证新接入策略和数据记录。它复用同一 ReviewEngine、Pi 会话和结构调查服务；包装器只选择案例、观察传输和汇总结果，不接管模型工具循环。

```sh
node --experimental-strip-types eval/controlled-e2e/prepare.mjs /outside/previous-microeval /outside/session-opaque-id
node --experimental-strip-types eval/controlled-e2e/launch.mjs /outside/session-opaque-id --offline
node --experimental-strip-types eval/controlled-e2e/launch.mjs /outside/session-opaque-id
node --experimental-strip-types eval/controlled-e2e/summarize.mjs /outside/session-opaque-id
```

必须使用新输出目录。准备阶段固定快照、源码摘要、六次首轮顺序、`low` 推理、32768 输出上限和每次十分钟上限。输出上限不等于每轮固定额度：Pi 会根据增长的上下文自动缩小实际额度，采样只验证实际值为正且不超过上限，并保存每轮参数。输出目录使用中性名称，因为 Pi 会把工作目录写入模型提示。实时运行前必须通过同一冻结输入的全部模拟预检。凭据仍只来自 `MERGEWARDEN_API_KEY`。无自动重试或换例；任一方式遇到接口、原生记录、请求摘要或结构包交付故障，都停止剩余批次。预算不足或缺少最终提交保留为未完成。

修复机械故障后，如需继续尚未尝试的组合，可在 `prepare.mjs` 的第四个参数传入已停止批次目录。这会建立新冻结和 `prior-attempts.json`，排除全部已尝试组合；不能覆盖旧结果，也不能把两个运行版本当作严格质量对照。原生发送前记录与 HTTP 发送记录分别计数；准备后被取消的请求单列，不能误计为实际服务调用或直接视为摘要不一致。

每次保存原始请求、完整或部分流式响应、逐请求时间点与供应商用量、逐工具执行时间、原生会话和正式报告。汇总再校验报告摘要、请求摘要、工具轨迹和证据是否进入后续请求；`runs.csv`、`requests.csv`、`summary.json` 区分完整用量和已知下限。分析器另存自身摘要，模拟结果只进入 `preflight`。这是执行准入采样，不能当成独立盲测、自动选路覆盖或质量增益证明。

## 工具轨迹与 Finding 归因

```sh
npm run eval:traces -- --output /outside/checkout/live-run
npm run eval:traces -- --output /outside/checkout/live-run --mapping /outside/checkout/live-run/mapping.json
npm run eval:traces -- --output /outside/checkout/live-run --mapping /outside/checkout/live-run/mapping.json --human-review /path/to/golden-human-review.json
```

分析器只读原生 Pi JSONL 的最后活动分支中的 toolCall/toolResult，不采信模型自述，也不改 prompt、finding 协议或源码 evidence。验证报告和 immutable evidence 后，生成 `trace-analysis.json`：每次调用的 ID/序号/原生 entry、状态、逐 finding `discoveryPath` 和可追溯链均保留。分析器源码 hash 与 JSONL hash 一并记录。`--partial` 仅生成明确标记 provisional 的中途分析；不会把未完成实验当成正式结果。schema 见 `schemas/trace-analysis.schema.json`。

- `graph_assisted`：已解析的 incoming CALLS 返回此前未被文本工具暴露的 caller 路径；收到该结果后，模型另行发出 read_source 覆盖其调用位置；成功接受的 finding evidence 包含同一 snapshot/head 的该位置与实际读取的 SHA。schema v4 不再建立普通 REFERENCES；旧实验结果仍按各自冻结实现解释。
- `text_only`：最终证据在 Graph 之前已读，或没有观测到相关 Graph 返回位置引出这些证据。
- `ambiguous`：相关 Graph 与文本发现重叠、关系不确定、同一批次提前发出源码读取，或 trace/成功提交/源码证据链不足。Graph 查询失败不自动转成 text_only。

为避免夸大增益，采用保守的文件路径级新颖性：之前在任一 revision 的 read_source/read_diff/search_text 暴露过 caller 路径，即不授予严格 Graph 首次发现归因；Graph 后、源码读取前出现竞争性文本发现也同样处理。这可能低估同文件内新 symbol 的贡献，因此同时保留 ambiguous 与完整链。outgoing 关系当前只带 source provenance，不能猜测 callee 范围以强行归因。

输出包含 Graph 调用数、首次调用序号、lookup 成功率与非空命中率、lookup→neighbors 和 neighbors→read_source 转化、逐例 search_text/read_source 差值。序号按模型发出的调用顺序计，包含拒绝及无返回的调用；成功率分母是全部 lookup，转化率分母分别是命中的 lookup、成功非空的 neighbors。neighbors conversion 要求读取返回的 provenance 位置，不等同于新发现；同批次预发调用不算转化。重复 lookup 的后续 neighbors 只归给最近一个返回匹配 ID 的 lookup。

Graph 返回量记录精确 UTF-8 bytes/Unicode 字符数；SDK 未提供逐 tool 的 GLM token 数，因此 `graphResponseTokens=null`。另列字符数/4 向上取整的粗估，明确不是 GLM tokenizer、账单 token 或上下文重复发送成本。真实 input/output/total tokens 仍取模型 SDK usage，不用粗估替代。

逐 run 的 `usage` 仅统计活动分支中的供应商/SDK 用量元数据，input 包含 cacheRead/cacheWrite；保留缓存用量、interrupted/missing response 数以及 `incompleteUsage`。超时流可能以 aborted 和全零 usage 结束，这不是零消耗的证据。汇总 `runsWithIncompleteUsage` 显式暴露缺口；raw 中实测 tokens 是 SDK 已返回的部分，不能当完整供应商账单。分析不读取或输出模型思考内容。

传入已完成语义复核的 mapping 后，可列出 **graph_assisted 且同 case/repeat 的 Text-only 没有已接受同一 golden 的 finding**，同时保留 Text-only 是否完成。缺少 mapping 时该结果为 null，不能靠标题相似或行号重合猜测。此指标证明的是本次可观察发现路径，单次配对仍不能证明反事实因果或普遍收益。

`--human-review` 仅接受实际审核人填写的原始导出，校验后将逐例审核 provenance 附入分析结果。未提供时明确记录 pending_independent_human_review；Agent 对预测与原 gold 的语义匹配不能代替人工审核，质量分数须按尚未复核的标签解释。
