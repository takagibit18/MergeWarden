# Finding contract field ownership

This table records the historical v2 model-input contract.  The active slim v3
boundary is defined below; v2 remains only as an explicit compatibility mode.
The
legacy `ReviewIssue` envelope remains available to existing publishers and is
produced by an explicit adapter; its compatibility fields are not a second
source of truth.  In particular, a reviewer-local `finding_id`, a runtime
`candidate_id`, and a content/version hash are different things.

| Information | Owner | Model input / internal representation | Boundary rule |
| --- | --- | --- | --- |
| Root cause, invariant, trigger, impact, repair suggestion | Model | Narrative fields on `ReviewIssue` / `FindingDraft` | The adapter may validate presence and type, but never invent wording. |
| Evidence file, range, and claim supported by it | Model, from delivered context | `supports[].statement` plus exact `evidence_refs[]`; internal role evidence is materialized | A statement must explain the role. An empty or copied statement is a gap. |
| Reviewer-local finding id | Model, with adapter fallback | `finding_id` | It labels the submitted hypothesis; if absent, the runtime supplies a local `F-...` value. It is never a repair selector. |
| Runtime candidate identity | Program | `candidate_id` (`cand_...`) | Generated once when the candidate first enters the runtime funnel and carried across versions and repair. It is independent of severity, anchor text, finding text, and evidence content. |
| Candidate identity/version hashes | Program | `logical_identity_hash`, `content_hash` | The logical hash identifies the runtime candidate; the content hash describes the current mutable finding version. A content change must not retarget repair. |
| Snapshot, revision, hash, side, artifact identity | Program | `EvidenceProvenance` | Values are bound only from the current run's delivered evidence ledger. The model may select a reference, but cannot manufacture provenance. |
| Primary position | Program from one model anchor | Model supplies only `primary_anchor`; adapter deterministically emits `location` and retains `primary_anchor` | Legacy `location` is accepted only by the compatibility adapter; it is not a second authority. |
| Evidence reference identifiers | Program provides, model selects | The delivered evidence catalog exposes exact legal ids; internal evidence stores the bound record | Unknown, undelivered, stale, or out-of-scope ids remain explicit reference errors; no nearest-match or automatic substitution. |
| Role/support relationship | Program schema, model semantics | One `supports` envelope per role, with role-specific statement and refs | The same artifact may be selected by multiple roles, but each role needs its own claim. |
| Lifecycle/status | Program | `investigation_ready`, `submission_received`, `review_complete`, `finding_run_status` | Evidence-sufficient investigation may enter submit; it is not itself a final submission. Runner validity and review completion are reported separately. |
| Legacy output fields | Adapter / publisher compatibility layer | v1 fields are mapped from the canonical structure | Historical payloads remain readable; new model prompts use the v2 boundary. |

## Model input versus internal finding

The model-facing submit tool uses a deliberately small schema: semantic finding
fields, one `primary_anchor`, and role support envelopes.  The internal schema
continues to carry `location`, candidate identity, provenance, legacy role arrays,
and publisher fields because downstream consumers still need them.  The adapter
is the only place where those representations meet.

`supports[].evidence_refs` must be selected from the exact catalog included in
the same serialized request.  The validator and integrity guard both use the
same normalization and fail-closed reference checks.  A reference that is
unknown, ambiguous, or known but not delivered is retained as
`reference_id`/`resolution_status`; it does not acquire a guessed path or line
and does not create a cascade of false identity failures.

## Repair boundary

Repair feedback is addressed to one exact `target_candidate_id` and includes
the current reviewer-local `finding_id`, the original semantic content, the
candidate's logical/content hashes, the original evidence, and the concrete
gap/action list.  A repair response without that exact target is not merged.
Unknown, duplicate, cross-candidate, already-passed, or omitted targets remain
unchanged and are reported as diagnostics.  A merged report is run through the
same final integrity guard again.

## Delivered catalog versus historical ledger

The historical ledger may contain more observations than the final request
exposes.  Only entries that occur as complete, non-truncated records in the
serialized request's delivered catalog are legal model references.  Final
submit assembly prioritizes all relevant required catalog entries, keeps each
entry atomic, and validates the serialized payload after trimming; it does not
use an arbitrary `records[:40]` prefix.  If a required id cannot fit, the run
is explicitly context-insufficient and no provider submit is attempted.

## Active v3 ownership table

| Information | Owner | v3 representation | Rule |
| --- | --- | --- | --- |
| Finding position | Reviewer selects; runtime validates | `FindingContentV3.anchor` | `file` and `line` are required; `end_line` is optional; runtime binds source range. |
| Complete semantic claim | Reviewer | `FindingContentV3.description` | One natural-language description; runtime never reconstructs the old five narrative fields. |
| Legal source selection | Reviewer selects, runtime resolves | `evidence_refs` | Every ref must be an exact id in the delivered ledger; no nearest or role-based substitution. |
| Suggested severity | Reviewer proposes, semantic verifier may request correction | `severity` | A correction cannot silently accept the old content version; it becomes `needs_revision`. |
| Optional remediation/display context | Reviewer | `suggestion`, `related_locations` | Omission preserves current content during patch; explicit deletion uses the small delete whitelist, never null. |
| Runtime identity/version | Program | `CandidateRegistry` registration | Opaque handles and content versions are generated and checked atomically. |
| Semantic decision | Independent verifier | `SemanticVerifierReceipt` | Must bind exact content version and relevant evidence digest; integrity pass alone is insufficient. |
| Processing/publication state | Program | response/run summary fields | Processing complete, candidate disposition, report ready, and external publish are separate facts. |

The compatibility `ReviewIssue` fields remain a materialization boundary for old
publishers and journals. They are not a second mutable authority and are not
model-facing in v3.
