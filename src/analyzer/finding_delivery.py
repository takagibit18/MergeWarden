"""Runtime-owned finding delivery identities and bounded repair facts.

The model can describe a finding, but it cannot create the identifiers used to
route a repair.  This module keeps that boundary small and run-scoped so the
orchestrator can persist enough information to replay a delivery decision
without treating draft ids, graph ids, hashes, or repository revisions as
candidate identities.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity

CandidateStatus = Literal[
    "registered",
    "needs_repair",
    "verified",
    "invalid",
    "deferred",
    "unchanged",
    "incomplete",
    "published",
]
RepairTransactionStatus = Literal[
    "open",
    "accepted",
    "partially_accepted",
    "rejected",
    "incomplete",
    "deferred",
]


def candidate_content_version(issue: ReviewIssue) -> str:
    """Return the stable version digest for one mutable finding envelope.

    Runtime provenance and repair selectors are excluded.  Changing semantic
    text, location, roles, or support changes the version while retaining the
    same runtime candidate id.
    """

    if issue.is_v3_finding:
        payload = {
            "schema_version": issue.schema_version,
            "anchor": issue.primary_anchor.model_dump(mode="json")
            if issue.primary_anchor is not None
            else {},
            "description": issue.description,
            "evidence_refs": sorted(set(issue.evidence_refs)),
            "severity": issue.severity.value,
            "suggestion": issue.suggestion,
            "related_locations": [
                location.model_dump(mode="json")
                for location in issue.related_locations
            ],
        }
        serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]

    payload = issue.model_dump(mode="json")
    for key in (
        "candidate_id",
        "finding_id",
        "target_candidate_id",
        "repair_status",
        "candidate_content_version",
        "integrity_status",
        "root_cause_id",
        "context_manifest_id",
        "context_hash",
        "repair_reason",
        "repair_patch",
    ):
        payload.pop(key, None)
    for field in (
        "cause_evidence",
        "contract_evidence",
        "trigger_evidence",
        "impact_evidence",
    ):
        items = payload.get(field)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            for key in (
                "candidate_id",
                "artifact_id",
                "evidence_id",
                "snapshot_id",
                "revision",
                "context_manifest_id",
                "retrieval_source",
                "context_hash",
            ):
                item.pop(key, None)
    serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]


def logical_identity_hash(candidate_id: str) -> str:
    """Hash a runtime candidate identity for audit-only comparisons."""

    return hashlib.sha256(candidate_id.encode("utf-8")).hexdigest()[:16]


def evidence_context_digest(
    records: list[dict[str, Any]] | None,
    *,
    snapshot_id: str = "",
    revision: str = "",
) -> str:
    """Hash the exact evidence context a validation result observed.

    Bodies are represented by their canonical content/body hashes rather than
    copied into transaction metadata.  A later ledger addition, replacement,
    snapshot, or revision therefore invalidates an open repair transaction.
    """

    stable_records: list[dict[str, Any]] = []
    for raw in records or []:
        if not isinstance(raw, dict):
            continue
        stable_records.append(
            {
                key: raw.get(key, "")
                for key in (
                    "evidence_id",
                    "artifact_id",
                    "path",
                    "start_line",
                    "end_line",
                    "side",
                    "content_hash",
                    "body_hash",
                    "source_type",
                    "snapshot_id",
                    "revision",
                    "lifecycle",
                    "truncated",
                    "displayed_ranges",
                    "displayed_line_numbers",
                )
            }
        )
    stable_records.sort(
        key=lambda item: (
            str(item.get("evidence_id", "")),
            str(item.get("artifact_id", "")),
            str(item.get("path", "")),
            str(item.get("start_line", "")),
        )
    )
    payload = {
        "snapshot_id": str(snapshot_id or ""),
        "revision": str(revision or ""),
        "records": stable_records,
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str).encode(
            "utf-8"
        )
    ).hexdigest()[:24]


def relevant_evidence_context_digest(
    records: list[dict[str, Any]] | None,
    evidence_refs: list[str] | tuple[str, ...] | set[str],
    *,
    snapshot_id: str = "",
    revision: str = "",
) -> str:
    """Digest only the evidence selected by one finding.

    Adding an unrelated ledger record must not invalidate an otherwise stable
    semantic receipt.  A changed selected body, range, lifecycle, snapshot, or
    revision still changes the digest and therefore requires re-review.
    """

    wanted = {str(item).strip() for item in evidence_refs if str(item).strip()}
    selected: list[dict[str, Any]] = []
    for raw in records or []:
        if not isinstance(raw, dict):
            continue
        identifiers = {
            str(raw.get("evidence_id", "")).strip(),
            str(raw.get("artifact_id", "")).strip(),
        }
        aliases = raw.get("aliases", [])
        if isinstance(aliases, list):
            identifiers.update(str(item).strip() for item in aliases)
        if identifiers.intersection(wanted):
            selected.append(raw)
    return evidence_context_digest(
        selected,
        snapshot_id=snapshot_id,
        revision=revision,
    )


class CandidateRegistration(BaseModel):
    """Runtime registration record for one logical candidate."""

    model_config = ConfigDict(extra="forbid")

    candidate_id: str = Field(min_length=1)
    finding_id: str = Field(min_length=1)
    candidate_content_version: str = Field(min_length=1)
    logical_identity_hash: str = Field(min_length=1)
    source_issue_indexes: list[int] = Field(default_factory=list)
    status: CandidateStatus = "registered"
    created_iteration: int = Field(default=0, ge=0)
    current_content: dict[str, Any] = Field(default_factory=dict)
    previous_content_versions: list[str] = Field(default_factory=list)
    validated_content_version: str = ""
    validated_evidence_context_digest: str = ""
    semantic_verdict: Literal[
        "not_run", "accept", "reject", "needs_revision", "unresolved"
    ] = "not_run"
    semantic_receipts: list[dict[str, Any]] = Field(default_factory=list)
    semantic_validated_content_version: str = ""
    semantic_validated_evidence_context_digest: str = ""


class CandidateRegistry:
    """Run-scoped registry that owns candidate ids and mutable versions."""

    def __init__(self) -> None:
        self._records: dict[str, CandidateRegistration] = {}
        self._source_indexes: dict[int, str] = {}
        self._content_indexes: dict[str, str] = {}
        self._duplicate_sources: dict[str, list[int]] = {}
        self._opaque_handles: dict[str, str] = {}
        self._handle_candidates: dict[str, str] = {}
        self._handle_versions: dict[str, str] = {}

    @property
    def records(self) -> tuple[CandidateRegistration, ...]:
        """Return registrations in deterministic insertion order."""

        return tuple(self._records.values())

    @property
    def candidate_ids(self) -> frozenset[str]:
        """Return every runtime candidate id registered in this run."""

        return frozenset(self._records)

    def register_report(
        self,
        report: ReviewReport,
        *,
        iteration: int,
        advance_existing: bool = True,
        include_non_risk: bool = False,
    ) -> tuple[CandidateRegistration, ...]:
        """Register initial risk findings and deterministically remove exact duplicates.

        A repair response is not a new registration: it carries a target and is
        intentionally left for the repair transaction validator.  Only exact
        normalized content versions are deduplicated; similar prose remains a
        separate candidate.
        """

        unique_issues: list[ReviewIssue] = []
        registrations: list[CandidateRegistration] = []
        seen_candidate_ids: set[str] = set()
        for source_index, issue in enumerate(report.issues):
            if not include_non_risk and issue.severity not in {
                Severity.CRITICAL,
                Severity.WARNING,
            }:
                unique_issues.append(issue)
                continue
            if issue.target_candidate_id.strip():
                unique_issues.append(issue)
                continue
            registration = self.register_issue(
                issue,
                source_issue_index=source_index,
                iteration=iteration,
                advance_existing=advance_existing,
            )
            # A verified/published registration is the authoritative content
            # version.  A later stale report object must not roll it back just
            # because it reached the final publication pass again.
            if (
                registration.status in {"verified", "published"}
                and registration.current_content
            ):
                try:
                    issue = ReviewIssue.model_validate(registration.current_content)
                except Exception:  # noqa: BLE001
                    # Keep the caller's object if an old journal contained a
                    # partial compatibility envelope; the guard will report
                    # that malformed state instead of guessing a replacement.
                    pass
            if registration.candidate_id in seen_candidate_ids:
                self._duplicate_sources.setdefault(registration.candidate_id, []).append(
                    source_index
                )
                continue
            seen_candidate_ids.add(registration.candidate_id)
            issue.candidate_id = registration.candidate_id
            issue.finding_id = registration.finding_id
            for evidence in issue.all_evidence():
                evidence.candidate_id = registration.candidate_id
            unique_issues.append(issue)
            registrations.append(registration)
        # Reassign even when the length is unchanged: a verified registration
        # may have replaced a stale report object with the authoritative
        # content version.
        report.issues = unique_issues
        return tuple(registrations)

    def register_issue(
        self,
        issue: ReviewIssue,
        *,
        source_issue_index: int,
        iteration: int,
        advance_existing: bool = True,
    ) -> CandidateRegistration:
        """Register or recover one candidate without trusting model ids."""

        supplied = issue.candidate_id.strip()
        if supplied.startswith("cand_") and supplied in self._records:
            record = self._records[supplied]
            self._advance_existing(record, issue, allow=advance_existing)
            self._remember_source(record.candidate_id, source_issue_index)
            return record

        existing_source_id = self._source_indexes.get(source_issue_index)
        if existing_source_id:
            record = self._records[existing_source_id]
            self._advance_existing(record, issue, allow=advance_existing)
            self._remember_source(record.candidate_id, source_issue_index)
            return record

        version = candidate_content_version(issue)
        existing_id = self._content_indexes.get(version)
        if existing_id:
            record = self._records[existing_id]
            self._remember_source(record.candidate_id, source_issue_index)
            return record

        candidate_id = "cand_" + uuid4().hex[:20]
        # Reviewer-local labels are not runtime identity.  Always allocate the
        # authoritative finding label together with the candidate record.
        finding_id = "F-" + uuid4().hex[:12].upper()
        payload = issue.model_dump(mode="json")
        payload["finding_id"] = finding_id
        payload["candidate_id"] = candidate_id
        record = CandidateRegistration(
            candidate_id=candidate_id,
            finding_id=finding_id,
            candidate_content_version=version,
            logical_identity_hash=logical_identity_hash(candidate_id),
            source_issue_indexes=[source_issue_index],
            created_iteration=max(0, iteration),
            current_content=payload,
        )
        self._records[candidate_id] = record
        self._source_indexes[source_issue_index] = candidate_id
        self._content_indexes[version] = candidate_id
        return record

    def save_finding(
        self,
        issue: ReviewIssue,
        *,
        source_issue_index: int,
        iteration: int,
    ) -> CandidateRegistration:
        """Save one initial finding through the sole runtime authority."""

        # v3 save is intentionally different from legacy report recovery.  A
        # source index is an audit fact, not an update selector: repeated model
        # responses can reuse an index after deduplication and must never replace
        # an existing candidate.  Only exact content identity deduplicates a
        # fresh save; explicit mutation goes through revise_finding below.
        version = candidate_content_version(issue)
        existing_id = self._content_indexes.get(version)
        if existing_id:
            record = self._records[existing_id]
            self._remember_source(record.candidate_id, source_issue_index)
            return record

        candidate_id = "cand_" + uuid4().hex[:20]
        finding_id = "F-" + uuid4().hex[:12].upper()
        payload = issue.model_dump(mode="json")
        payload["finding_id"] = finding_id
        payload["candidate_id"] = candidate_id
        record = CandidateRegistration(
            candidate_id=candidate_id,
            finding_id=finding_id,
            candidate_content_version=version,
            logical_identity_hash=logical_identity_hash(candidate_id),
            source_issue_indexes=[source_issue_index],
            created_iteration=max(0, iteration),
            current_content=payload,
        )
        self._records[candidate_id] = record
        self._source_indexes[source_issue_index] = candidate_id
        self._content_indexes[version] = candidate_id
        return record

    def _advance_existing(
        self,
        record: CandidateRegistration,
        issue: ReviewIssue,
        *,
        allow: bool,
    ) -> None:
        """Advance a mutable initial version without changing its id."""

        if (
            not allow
            or issue.target_candidate_id.strip()
            or record.status in {"verified", "published"}
        ):
            return
        version = candidate_content_version(issue)
        if version == record.candidate_content_version:
            return
        self._content_indexes.pop(record.candidate_content_version, None)
        self._content_indexes[version] = record.candidate_id
        record.previous_content_versions.append(record.candidate_content_version)
        record.candidate_content_version = version
        payload = issue.model_dump(mode="json")
        payload["finding_id"] = record.finding_id
        payload["candidate_id"] = record.candidate_id
        record.current_content = payload
        record.semantic_verdict = "not_run"
        record.semantic_receipts = []
        record.semantic_validated_content_version = ""
        record.semantic_validated_evidence_context_digest = ""

    def registration(self, candidate_id: str) -> CandidateRegistration | None:
        """Return a registration only for an exact runtime candidate id."""

        return self._records.get(str(candidate_id).strip())

    def opaque_handle(self, candidate_id: str) -> str:
        """Return the run-scoped opaque handle for one runtime candidate."""

        normalized = str(candidate_id).strip()
        if normalized not in self._records:
            return ""
        current_version = self._records[normalized].candidate_content_version
        handle = self._opaque_handles.get(normalized)
        if handle is None or self._handle_versions.get(handle) != current_version:
            handle = "vh_" + uuid4().hex[:20]
            self._opaque_handles[normalized] = handle
            self._handle_candidates[handle] = normalized
            self._handle_versions[handle] = current_version
        return handle

    def candidate_for_handle(self, handle: str) -> str:
        """Resolve only an exact handle generated by this registry."""

        return self._handle_candidates.get(str(handle).strip(), "")

    def version_for_handle(self, handle: str) -> str:
        """Return the content version bound when an opaque handle was issued."""

        return self._handle_versions.get(str(handle).strip(), "")

    def revise_finding(
        self,
        candidate_id: str,
        issue: ReviewIssue,
        *,
        base_version: str,
    ) -> bool:
        """Atomically replace mutable content for one exact runtime handle."""

        record = self.registration(candidate_id)
        if record is None or record.candidate_content_version != base_version:
            return False
        version = candidate_content_version(issue)
        self._content_indexes.pop(record.candidate_content_version, None)
        self._content_indexes[version] = record.candidate_id
        record.previous_content_versions.append(record.candidate_content_version)
        record.candidate_content_version = version
        payload = issue.model_dump(mode="json")
        payload["candidate_id"] = record.candidate_id
        payload["finding_id"] = record.finding_id
        record.current_content = payload
        record.status = "registered"
        record.validated_content_version = ""
        record.validated_evidence_context_digest = ""
        record.semantic_verdict = "not_run"
        record.semantic_receipts = []
        record.semantic_validated_content_version = ""
        record.semantic_validated_evidence_context_digest = ""
        return True

    def finish_review(self) -> tuple[ReviewIssue, ...]:
        """Return the registry-owned finding set without accepting it."""

        findings: list[ReviewIssue] = []
        for record in self.records:
            issue = self.authoritative_issue(record.candidate_id)
            if issue is not None:
                findings.append(issue)
        return tuple(findings)

    def closeout_issues(self) -> tuple[ReviewIssue, ...]:
        """Return the current registry content for a runtime closeout.

        v3 closeout is a runtime handoff, not a model ``finish_review`` fact.
        Keep the explicit alias so callers cannot accidentally make the
        authoritative closeout depend on whether a model finish action was
        observed.
        """

        return self.finish_review()

    def expected_version(self, candidate_id: str) -> str:
        """Return the current repair version or an empty string for unknown ids."""

        record = self.registration(candidate_id)
        return record.candidate_content_version if record is not None else ""

    def mark_status(self, candidate_id: str, status: CandidateStatus) -> None:
        """Record a deterministic status without replacing candidate content."""

        record = self.registration(candidate_id)
        if record is not None:
            record.status = status
            if status not in {"verified", "published"}:
                record.validated_content_version = ""
                record.validated_evidence_context_digest = ""

    def authoritative_issue(self, candidate_id: str) -> ReviewIssue | None:
        """Return the registry-owned content for a known candidate."""

        record = self.registration(candidate_id)
        if record is None or not record.current_content:
            return None
        try:
            return ReviewIssue.model_validate(record.current_content)
        except Exception:  # noqa: BLE001
            return None

    def commit_verified_version(
        self,
        candidate_id: str,
        issue: ReviewIssue,
        *,
        evidence_context_digest: str = "",
    ) -> str:
        """Advance a candidate version only after a complete guard passes."""

        record = self.registration(candidate_id)
        if record is None:
            raise KeyError(f"unknown runtime candidate: {candidate_id}")
        version = candidate_content_version(issue)
        old_version = record.candidate_content_version
        if old_version != version:
            self._content_indexes.pop(old_version, None)
            self._content_indexes[version] = candidate_id
            record.previous_content_versions.append(old_version)
        record.candidate_content_version = version
        payload = issue.model_dump(mode="json")
        payload["finding_id"] = record.finding_id
        payload["candidate_id"] = record.candidate_id
        record.current_content = payload
        record.status = "verified"
        if old_version != version:
            record.semantic_verdict = "not_run"
            record.semantic_receipts = []
            record.semantic_validated_content_version = ""
            record.semantic_validated_evidence_context_digest = ""
        record.validated_content_version = version
        record.validated_evidence_context_digest = str(
            evidence_context_digest or ""
        )
        return version

    def record_semantic_receipt(
        self,
        candidate_id: str,
        receipt: dict[str, Any],
        *,
        content_version: str,
        evidence_context_digest: str,
    ) -> bool:
        """Commit a semantic receipt only for the current content version."""

        record = self.registration(candidate_id)
        if record is None or record.candidate_content_version != content_version:
            return False
        verdict = str(receipt.get("verdict", "unresolved")).strip()
        if verdict not in {"accept", "reject", "needs_revision", "unresolved"}:
            verdict = "unresolved"
        record.semantic_verdict = verdict  # type: ignore[assignment]
        record.semantic_receipts.append(dict(receipt))
        record.semantic_validated_content_version = content_version
        record.semantic_validated_evidence_context_digest = str(
            evidence_context_digest or ""
        )
        return True

    def duplicate_sources(self, candidate_id: str) -> tuple[int, ...]:
        """Return source indexes removed as exact duplicates."""

        return tuple(self._duplicate_sources.get(candidate_id, ()))

    def snapshot(self) -> list[dict[str, Any]]:
        """Return a JSON-safe replay snapshot."""

        return [record.model_dump(mode="json") for record in self.records]

    def _remember_source(self, candidate_id: str, source_issue_index: int) -> None:
        record = self._records[candidate_id]
        if source_issue_index not in record.source_issue_indexes:
            record.source_issue_indexes.append(source_issue_index)
        self._source_indexes[source_issue_index] = candidate_id


class RepairTransaction(BaseModel):
    """Bounded transaction facts shared by format, source, and contract repair."""

    model_config = ConfigDict(extra="forbid")

    transaction_id: str = Field(
        default_factory=lambda: "rtx_" + uuid4().hex[:20], min_length=1
    )
    input_recovery_id: str = Field(
        default="",
        description="Separate format-recovery identity, never a candidate id.",
    )
    candidate_ids: list[str] = Field(default_factory=list)
    target_handles: dict[str, str] = Field(
        default_factory=dict,
        description="Opaque model-facing handle -> runtime candidate id mapping.",
    )
    base_versions: dict[str, str] = Field(default_factory=dict)
    base_snapshot_id: str = ""
    base_revision: str = ""
    base_evidence_context_digest: str = ""
    gap_codes: dict[str, list[str]] = Field(default_factory=dict)
    required_steps: list[str] = Field(default_factory=list)
    executed_steps: list[str] = Field(default_factory=list)
    model_call_count: int = Field(default=0, ge=0)
    token_budget: int = Field(default=0, ge=0)
    time_budget_seconds: float = Field(default=0.0, ge=0.0)
    status: RepairTransactionStatus = "open"
    target_results: dict[str, str] = Field(default_factory=dict)
    rejection_reasons: list[str] = Field(default_factory=list)
    applied_response_fingerprints: list[str] = Field(default_factory=list)
    rejected_response_fingerprints: list[str] = Field(default_factory=list)

    def record_step(self, step: str) -> None:
        """Record a step once, preserving the transaction timeline."""

        if step not in self.executed_steps:
            self.executed_steps.append(step)
