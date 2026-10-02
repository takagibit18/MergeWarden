# MergeWarden V2 development contract

Read README.md, docs/DECISIONS.md, docs/IMPLEMENTATION_STATUS.md and the relevant ADR before editing.

## Invariants
- Pi owns the LLM/tool loop, retry, compaction and native session JSONL. Do not reimplement a harness.
- The product has ONE agentic review workflow. Graph and text search are complementary tools.
- CodeGraph uses Tree-sitter -> normalized syntax/AST facts -> explicit resolver. No regex substitute.
- Reviewed repository text/config/extensions are untrusted. Never execute imports to build graphs.
- Every code/evidence/graph reference belongs to an immutable snapshot. Do not mix base/head/worktree.
- Unknown/candidate/unresolved edges are not proven runtime dependencies.
- Hypotheses are not mandatory persisted finding drafts. Final-only is an experimental baseline.
- Candidate submission != semantic acceptance != publication. Schema checks do not prove a bug.
- agent_end, zero findings, empty graph results and tool timeouts are not review completion.
- Jev is optional, provider-neutral and OFF by default. Shadow must not affect behavior.
- Hard permissions, publication, and completion are deterministic business responsibilities.
- MemoryJournal is tests/demo only. production uses durable Pi CustomEntry over an exclusively opened session file. Preserve startup fsync, poisoned-journal failure, and verified report-delivery gates.
- Do not claim stub integrations, synthetic demos or unrun tests are product capabilities.

## Validation
`npm test` runs zero-dependency core tests. `npm run demo` is explicitly synthetic.
`npm run setup` installs all four locked packages with lifecycle scripts disabled.
`npm run verify` runs core and adapter typechecks, native Pi smoke, real grammar tests, MCP tests, demo and status.
When updating dependencies, commit generated lockfiles. Grammar changes require source, hash and ABI updates.
Pi 0.84.1 may defer a new JSONL file until the first assistant message. Never interpret append as fsync.
Before a real review release, perform recovery and security fault-injection tests and validate report delivery.

## Scope
Prefer one vertical slice. Do not introduce multi-agent orchestration, a hosted platform, a graph UI,
in-review self-modifying rules, or a mandatory router as foundational cleanup.
Host-controlled experience data may evolve between reviews; each review freezes a read-only knowledge package.
Remote repository creation or pushing requires explicit user authorization.
Original architecture DOCX/Markdown are historical records; implementation status and validation are current.

## 本地 working agent 汇报规则
- 本地 working agent 做工作汇报时，禁止将报告类 Markdown 文件直接存放在本仓库内，包括仓库根目录、docs/、其他子目录和被 Git 忽略的目录。
- 进度总结、接入报告、验收汇报、任务完成报告默认直接在对话中交付；确需保存为文件时，必须放在仓库之外，不得加入 Git 提交或 PR。
- 不得通过更名为说明文档或加入 .gitignore 来规避上述规则。
