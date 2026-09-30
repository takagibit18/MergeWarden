# Review Skills interface

Skills are versioned, repository-scoped experience data. They can suggest an investigation, but cannot establish a defect, satisfy coverage, supply current-source evidence, or override review policy. Deterministic validation checks structure, identity, permissions and budgets; it does not prove natural-language correctness or prevent every misleading suggestion.

## Product commands

```sh
npm run cli -- review --repo REPOSITORY --base BASE --head HEAD --provider PROVIDER --model MODEL --api-key-env KEY_VARIABLE --skills auto --learn auto --state EXTERNAL_STATE
npm run cli -- rerun --repo REPOSITORY --run RUN_ID --provider PROVIDER --model MODEL --auth oauth --skills replay --learn off --state EXTERNAL_STATE
npm run cli -- feedback --run RUN_ID --comment "Explicit zero remains valid caller input." --path app.py --start-line 1 --end-line 2 --state EXTERNAL_STATE
npm run cli -- feedback --run RUN_ID --comment-file EXTERNAL_COMMENT --event FEEDBACK_EVENT --version 2 --withdrawn true --state EXTERNAL_STATE
npm run cli -- skills list --state EXTERNAL_STATE
npm run cli -- skills show --id SKILL_ID --revision 1 --state EXTERNAL_STATE
npm run cli -- skills learn --provider PROVIDER --model MODEL --auth oauth --max-jobs 1 --retry false --state EXTERNAL_STATE
npm run cli -- skills disable --id SKILL_ID --state EXTERNAL_STATE
npm run cli -- skills rollback --id SKILL_ID --revision 1 --state EXTERNAL_STATE
npm run cli -- skills unlock --state EXTERNAL_STATE
```

Every flag takes a value. `--finding` and `--verdict correction|missed_defect|contract|uncertain` are optional. A missed defect does not require a finding ID. Feedback is saved before any explicitly authenticated learning attempt. Without authentication it remains pending. Comments cannot select their identity or simulated status; only the evaluation host can select the separate simulation entry metadata. Pending does not mean published.

New product reviews default to `skills=auto, learn=auto`. After verified report delivery, the host registers a learning source and awaits at most one extraction if a learner is configured. The CLI may process one pending feedback item before binding the next review. Both extraction windows have a separate 60-second ceiling, 40,000-byte input ceiling and requested 4,096 output-token limit. Provider enforcement of output limits is not presumed. The SDK retains its normal transport retry policy in production; evaluation selects first-attempt explicitly. No unbounded repair or judge loop exists.

The engine can run without a learner: sources are still registered as pending. Internal evaluation defaults to `skills=off, learn=off`; an evaluation runner must explicitly choose an arm. `skills learn` repairs registration gaps from a bounded scan of delivered runs that recorded `learningPolicy=auto`, and from committed source events. Failed attempts require `--retry true`; their original files remain intact. `skills unlock` checks that recorded bank/worker lock owners are dead before removing locks. Unreadable locks require local inspection.

## Identity and isolation

Source `SnapshotIdentity` and its configuration fingerprint are unchanged. `run.json.skills` records a separate knowledge identity and hashes. Each run stores a self-contained `skills.json`; `skill-reads.json` records actual body loads, revisions, operation ordinals, bytes and explicitly estimated tokens. Catalog visibility is not consumption. Repeated reads return a small already-loaded receipt and still consume the shared tool-operation budget. Closing forbids new Skill reads.

Selection uses host repository scope, changed paths, language and a bounded diff prefix. Ordering is deterministic; at most eight directory entries and three complete bodies are available, with at most one trial body and 6,000 cumulative UTF-8 body bytes. Bodies are never truncated into a new apparent rule. Catalog conditions have explicit preview truncation. A changed dependency hash makes a repository contract a `recheck` hint; it is not current fact.

Rerun defaults to the original package. A legacy run without Skill fields replays without Skills. Missing or corrupted replay packages fail. Explicit `--skills auto` on rerun creates a new run with parent lineage and selects current knowledge. An unavailable current bank yields an explicitly degraded empty package for ordinary auto review.

The normal scope is the local Snapshot repository registration identity. Public PR evaluation uses `skillRepositoryKeyForTask`, checking a host-admitted task hash, exact task receipt, origin and Git objects. This does not trust arbitrary origin declarations or repository configuration. The host may supply a neutral external `evaluation.contextCwd` so arm directory names do not change Pi's effective system prompt. It must be outside the reviewed repository.

## Storage and corrections

Learning has a separate coverage query (`learning-context-1`); it does not reuse Review eligibility. Repository and explicit language compatibility bound candidates. Path, symbol, keyword, title and condition overlap determine relevance across method and fact scopes, with Skill ID only breaking ties. Zero-overlap candidates are omitted. The input records candidate and omission counts, selection reasons, support identity indicators and whether each complete body was provided. Catalog titles and conditions are extracted directly with marked truncation.

The initial learning limits are eight catalog entries, three complete bodies and 12,000 UTF-8 bytes for the combined existing-knowledge context. These are ceilings, not quotas. Selection also respects the 40,000-byte whole-input ceiling without removing current evidence or fixed rules. `relevantSkills` contains complete bodies only. Selection finishes before opaque references are minted; the native learner checks the actual `input.json` and `model-input.json` bytes before making a request. `learning-input-meta.json` records these sizes and file hashes alongside independent context-policy and prompt versions/hashes. The shared extraction policy and historical job identities remain unchanged; this does not enqueue historical sources again.

Catalog-only knowledge is read-only awareness: its opaque reference cannot target `revise`, `attach_source` or `retire`. Externally managed, retired and quarantined knowledge is also awareness-only. For a provided managed body, the host still binds its identity, revision and source/dependency hashes to the frozen snapshot. `attach_source` requires every old dependency to appear with the same hash in the current bounded source pages. `dependenciesAvailable=false` exposes this limitation; it is not permission to remove dependencies or create a duplicate. The same source adds no support twice, and different pages of the same PR do not establish independent corroboration.

The single-call `existing-skill-aware-1` prompt compares fixed rules, catalog and complete old knowledge before choosing `noop`, `attach_source`, `revise` or an independent `add`. Revisions preserve still-valid old boundaries. Before returning, the model compares all operations by checking behavior, scope, counterexamples and stop conditions, including candidates with different `scopeType`. Complementary additions remain allowed. This is soft guidance, not semantic consolidation or a guarantee against duplicates. Q2 remains an offline, post-experiment check, with no publication judge or second model call.

Learning uses one serial worker per local state directory. The worker holds `learning.lock` for the batch, builds each job's input from the current bank, awaits extraction and publication, and only then starts the next job. Current usage is a local bank owned by that workflow; a shared multi-writer bank or merging proposals generated against an earlier bank version is outside the supported workflow. Keep source registration and feedback edits outside an active learning batch. Revision checks remain enabled, and failed attempts are not automatically replayed. Independent experiments use separate state directories and frozen copies for review.

`STATE/skills/objects` contains content-addressed immutable source versions, Skill revisions and bank snapshots. One atomic `current.json` pointer publishes a complete changeset under a bank-wide write lock. Unpublished objects may remain after interruption; they are not visible knowledge. Revision conflicts reject the entire changeset. Windows file sync and atomic rename are used with the same filesystem limitations as review delivery; this is not a database or an exactly-once guarantee.

`jobs` and `attempts/JOB/N` retain pending/running/applied/noop/failed state, bounded input, model output, native Pi session, observed request parameters, usage and publication receipt. Job identity binds immutable source hash and extraction-policy version; the actual input hash is recorded separately. A committed receipt recovers an interrupted job without applying it twice. A job interrupted before publication can make another paid request on explicit retry/recovery; external model execution is not exactly once.

Run-derived procedures default to trial. Contextual trusted corrections may become active automatically; active means usable support, not proven truth. Substantive unresolved conflicts are quarantined. Source edits and withdrawals preserve old versions, remove the old support, and quarantine affected current Skills before further extraction. Rollback creates a new revision, retains only still-current sources, and never resurrects revoked support. A model cannot modify unmanaged Skills or the fixed base rules. Repeated source observations have an `independenceKey`; run count and loading count are not independent corroboration.

The native learning session has its own fixed extraction instructions and no tools, ambient Skills, AGENTS files, templates or project extensions. It does not instantiate the Review Runtime with its review prompt. Its failure and usage records are separate from report delivery. Report reopening and evidence remain available when learning fails.
