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

    payload = issue.model_dump(mode="json")
    for key in (
        "candidate_id",
        "target_candidate_id",
        "repair_status",
        "candidate_content_version",
        "integrity_status",
        "root_cause_id",
        "context_manifest_id",
        "context_hash",
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


class CandidateRegistry:
    """Run-scoped registry that owns candidate ids and mutable versions."""

    def __init__(self) -> None:
        self._records: dict[str, CandidateRegistration] = {}
        self._source_indexes: dict[int, str] = {}
        self._content_indexes: dict[str, str] = {}
        self._duplicate_sources: dict[str, list[int]] = {}

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
            if issue.severity not in {Severity.CRITICAL, Severity.WARNING}:
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
            if registration.candidate_id in seen_candidate_ids:
                self._duplicate_sources.setdefault(registration.candidate_id, []).append(
                    source_index
                )
                continue
            seen_candidate_ids.add(registration.candidate_id)
            issue.candidate_id = registration.candidate_id
            if not issue.finding_id.strip():
                issue.finding_id = registration.finding_id
            for evidence in issue.all_evidence():
                evidence.candidate_id = registration.candidate_id
            unique_issues.append(issue)
            registrations.append(registration)
        if len(unique_issues) != len(report.issues):
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
        finding_id = issue.finding_id.strip() or "F-" + uuid4().hex[:12].upper()
        payload = issue.model_dump(mode="json")
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

        if not allow or issue.target_candidate_id.strip():
            return
        version = candidate_content_version(issue)
        if version == record.candidate_content_version:
            return
        self._content_indexes.pop(record.candidate_content_version, None)
        self._content_indexes[version] = record.candidate_id
        record.previous_content_versions.append(record.candidate_content_version)
        record.candidate_content_version = version
        record.current_content = issue.model_dump(mode="json")

    def registration(self, candidate_id: str) -> CandidateRegistration | None:
        """Return a registration only for an exact runtime candidate id."""

        return self._records.get(str(candidate_id).strip())

    def expected_version(self, candidate_id: str) -> str:
        """Return the current repair version or an empty string for unknown ids."""

        record = self.registration(candidate_id)
        return record.candidate_content_version if record is not None else ""

    def mark_status(self, candidate_id: str, status: CandidateStatus) -> None:
        """Record a deterministic status without replacing candidate content."""

        record = self.registration(candidate_id)
        if record is not None:
            record.status = status

    def commit_verified_version(self, candidate_id: str, issue: ReviewIssue) -> str:
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
        record.current_content = issue.model_dump(mode="json")
        record.status = "verified"
        return version

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
    candidate_ids: list[str] = Field(default_factory=list)
    base_versions: dict[str, str] = Field(default_factory=dict)
    gap_codes: dict[str, list[str]] = Field(default_factory=dict)
    required_steps: list[str] = Field(default_factory=list)
    executed_steps: list[str] = Field(default_factory=list)
    model_call_count: int = Field(default=0, ge=0)
    token_budget: int = Field(default=0, ge=0)
    time_budget_seconds: float = Field(default=0.0, ge=0.0)
    status: RepairTransactionStatus = "open"
    target_results: dict[str, str] = Field(default_factory=dict)
    rejection_reasons: list[str] = Field(default_factory=list)

    def record_step(self, step: str) -> None:
        """Record a step once, preserving the transaction timeline."""

        if step not in self.executed_steps:
            self.executed_steps.append(step)
