"""Thin, run-scoped integrity checks for reviewer findings.

The reviewer owns the engineering judgment behind a finding.  This module only
checks that the resulting finding is structurally usable and that its cited
locations can be tied to code the reviewer actually received during this run.
It intentionally does not decide whether the reported behavior is a bug.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, cast
from uuid import uuid4

from src.analyzer.diff_lines import changed_new_lines_by_file
from src.analyzer.evidence_ledger import EvidenceLedger
from src.analyzer.evidence_binding import bind_candidate_evidence, bind_issue_candidate_id
from src.analyzer.finding_delivery import (
    CandidateRegistry,
    candidate_content_version,
    evidence_context_digest,
)
from src.analyzer.finding_contract import canonical_contract_gaps
from src.analyzer.finding_schema import EvidenceSide, normalize_repo_path
from src.analyzer.location import LocationParseResult, normalize_location
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import FindingCandidate, ReviewRequest
from src.analyzer.verifier_context import (
    build_candidate_verifier_context,
    context_budget_exhausted_for_evidence,
    context_budget_exhausted_for_location,
    location_in_candidate_context,
    provenance_in_candidate_context,
)

_RISK_SEVERITIES = {Severity.CRITICAL, Severity.WARNING}
RepairFailureClass = Literal[
    "deterministic_normalization",
    "contract_gap",
    "source_gap",
    "reference_error",
    "untrusted_identity",
]


def classify_integrity_failure(
    failure: IntegrityFailure | str,
    *,
    field: str = "",
) -> RepairFailureClass:
    """Map an objective failure to the next safe state transition."""

    code = failure.code if isinstance(failure, IntegrityFailure) else str(failure)
    failure_field = failure.field if isinstance(failure, IntegrityFailure) else field
    if code in {"evidence_not_observed", "evidence_incomplete", "verifier_context_budget_exhausted"}:
        return "source_gap"
    if code in {
        "support_reference_missing",
        "support_reference_unresolved",
        "support_reference_undelivered",
        "reference_not_delivered",
        "evidence_binding_missing",
    }:
        if failure_field.endswith(".statement") or failure_field.endswith("statement"):
            return "contract_gap"
        return "reference_error"
    if code in {
        "finding_contract_incomplete",
        "support_role_missing",
        "role_claim_missing",
        "changed_anchor_missing",
        "finding_structure_invalid",
        "finding_contract_invalid",
    }:
        return "contract_gap"
    if code in {"location_invalid", "location_line_missing"} and failure_field == "primary_anchor":
        return "deterministic_normalization"
    if code in {
        "candidate_binding_mismatch",
        "candidate_binding_missing",
        "repository_path_invalid",
        "repository_path_missing",
        "location_invalid",
        "location_line_missing",
        "location_line_out_of_range",
        "location_unreadable",
        "evidence_identity_mismatch",
    }:
        return "untrusted_identity"
    return "reference_error"


def build_candidates(
    report: ReviewReport,
    *,
    iteration: int,
    registry: CandidateRegistry | None = None,
    register: bool = True,
    include_non_risk: bool = False,
) -> list[FindingCandidate]:
    """Build runtime-registered risk candidates for the integrity stage.

    ``registry`` is the authoritative identity store for orchestrated runs.
    The optional argument keeps standalone legacy callers source-compatible;
    those callers still receive a program-generated candidate id.
    """

    candidates: list[FindingCandidate] = []
    seen: set[str] = set()
    if registry is not None and register:
        registry.register_report(
            report,
            iteration=iteration,
            include_non_risk=include_non_risk,
        )
    for source_issue_index, issue in enumerate(report.issues):
        if not include_non_risk and issue.severity not in _RISK_SEVERITIES:
            continue
        registration = (
            registry.registration(issue.candidate_id)
            if registry is not None and issue.candidate_id.strip()
            else None
        )
        if registry is not None and issue.target_candidate_id.strip():
            # Repair payloads are only materialized after the merge validator
            # has checked their target.  Treating one as a fresh registration
            # here would silently make a repair target unbound.
            candidate_id = issue.candidate_id.strip()
        else:
            candidate_id = (
                registration.candidate_id
                if registration is not None
                else _runtime_candidate_id(issue, seen)
            )
        seen.add(candidate_id)
        if not issue.finding_id:
            issue.finding_id = (
                registration.finding_id
                if registration is not None
                else "F-" + candidate_id[len("cand_") :].upper()
            )
        bound_issue = bind_issue_candidate_id(issue, candidate_id)
        issue.candidate_id = candidate_id
        for evidence in issue.all_evidence():
            evidence.candidate_id = candidate_id
        bound_issue.finding_id = issue.finding_id
        candidates.append(
            FindingCandidate(
                candidate_id=candidate_id,
                logical_identity_hash=_logical_identity_hash(
                    issue, candidate_id=candidate_id
                ),
                content_hash=(
                    registration.candidate_content_version
                    if registration is not None
                    and not issue.target_candidate_id.strip()
                    else _candidate_content_hash(issue)
                ),
                candidate_content_version=(
                    registration.candidate_content_version
                    if registration is not None
                    and not issue.target_candidate_id.strip()
                    else candidate_content_version(issue)
                ),
                issue=bound_issue,
                claim=issue.suggestion.strip(),
                evidence_locations=(
                    [issue.location] if issue.location.strip() else []
                ),
                originating_iteration=max(0, iteration),
                source_issue_index=source_issue_index,
            )
        )
    return candidates


def _runtime_candidate_id(issue: ReviewIssue, seen: set[str]) -> str:
    """Return the program-owned id created at first candidate registration."""

    existing = str(issue.candidate_id or "").strip()
    if existing.startswith("cand_") and existing not in seen:
        return existing
    while True:
        candidate_id = "cand_" + uuid4().hex[:20]
        if candidate_id not in seen:
            return candidate_id


def _logical_identity_hash(issue: ReviewIssue, *, candidate_id: str = "") -> str:
    """Hash the runtime identity, never mutable finding content.

    The runtime candidate id is created once and carried on the issue before a
    repair round.  It is therefore the only safe identity input here: severity,
    anchor text, finding labels, evidence, and suggestions are all mutable
    versions of the same candidate and must not silently retarget repair.
    """

    logical = str(candidate_id or issue.candidate_id or "").strip()
    if not logical:
        # This fallback is only for standalone callers that have not registered
        # a candidate yet.  ``build_candidates`` always supplies the runtime id.
        anchor = (
            issue.primary_anchor.location
            if issue.primary_anchor is not None
            else issue.location
        )
        logical = anchor.strip().replace("\\", "/")
    return hashlib.sha256(logical.encode("utf-8")).hexdigest()[:16]


def _candidate_content_hash(issue: ReviewIssue) -> str:
    """Hash the mutable finding version without runtime provenance fields."""

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
                "snapshot_id",
                "revision",
                "context_manifest_id",
                "retrieval_source",
                "context_hash",
            ):
                item.pop(key, None)
    normalized = json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class IntegrityFailure:
    """One objective integrity failure for a finding."""

    code: str
    message: str
    field: str = ""
    location: str = ""
    file: str = ""
    start_line: int | None = None
    end_line: int | None = None
    retrieval_source: str = ""
    context_manifest_id: str = ""
    manifest_hash_prefix: str = ""
    reference_id: str = ""

    def as_detail(self) -> dict[str, Any]:
        """Return a stable structured representation for event logs and reports."""

        return {
            "code": self.code,
            "message": self.message,
            "field": self.field,
            "location": self.location,
            "file": self.file,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "retrieval_source": self.retrieval_source,
            "context_manifest_id": self.context_manifest_id,
            "manifest_hash_prefix": self.manifest_hash_prefix,
            "reference_id": self.reference_id,
        }


@dataclass(frozen=True)
class FindingIntegrityResult:
    """Integrity result for one candidate."""

    candidate_id: str
    passed: bool
    failures: tuple[IntegrityFailure, ...] = ()
    content_version: str = ""
    evidence_context_digest: str = ""

    @property
    def status(self) -> Literal["verified", "needs_repair", "invalid"]:
        """Expose the internal tri-state without changing the legacy ``passed`` flag."""

        if self.passed:
            return "verified"
        # ``invalid`` is reserved for failures that cannot be repaired without
        # guessing runtime identity or source scope.  Contract/reference gaps
        # remain candidates for the bounded repair loop even when an older
        # implementation would have grouped them under one invalid bucket.
        if any(
            classify_integrity_failure(failure) == "untrusted_identity"
            for failure in self.failures
        ):
            return "invalid"
        return "needs_repair"


@dataclass(frozen=True)
class IntegrityGuardResult:
    """Batch result returned by :class:`FindingIntegrityGuard`."""

    results: tuple[FindingIntegrityResult, ...] = ()
    bound_candidates: tuple[FindingCandidate, ...] = ()
    evidence_context_digest: str = ""

    @property
    def checked_count(self) -> int:
        return len(self.results)

    @property
    def passed_count(self) -> int:
        return sum(item.passed for item in self.results)

    @property
    def rejected_count(self) -> int:
        return self.checked_count - self.passed_count

    @property
    def accepted_candidate_ids(self) -> frozenset[str]:
        return frozenset(item.candidate_id for item in self.results if item.passed)

    @property
    def rejected_candidate_ids(self) -> frozenset[str]:
        return frozenset(item.candidate_id for item in self.results if not item.passed)

    @property
    def verified_candidate_ids(self) -> frozenset[str]:
        return frozenset(
            item.candidate_id for item in self.results if item.status == "verified"
        )

    @property
    def needs_repair_candidate_ids(self) -> frozenset[str]:
        return frozenset(
            item.candidate_id
            for item in self.results
            if item.status == "needs_repair"
        )

    @property
    def invalid_candidate_ids(self) -> frozenset[str]:
        return frozenset(
            item.candidate_id for item in self.results if item.status == "invalid"
        )

    @property
    def failures(self) -> dict[str, tuple[IntegrityFailure, ...]]:
        return {
            item.candidate_id: item.failures
            for item in self.results
            if item.failures
        }

    @property
    def failure_details(self) -> dict[str, list[dict[str, Any]]]:
        """Return detailed failures keyed by candidate while preserving code views."""

        return {
            candidate_id: [failure.as_detail() for failure in failures]
            for candidate_id, failures in self.failures.items()
        }


class FindingIntegrityGuard:
    """Check finding integrity without re-evaluating the reported bug."""

    def __init__(self, repo_root: Path | str | None = None) -> None:
        self._repo_root = Path(repo_root).resolve() if repo_root is not None else None

    def validate(
        self,
        candidates: list[FindingCandidate],
        request: ReviewRequest,
        *,
        tool_evidence: list[dict[str, Any]] | None = None,
        context_manifests: list[dict[str, Any]] | None = None,
        candidate_context: list[dict[str, Any]] | None = None,
        context_mode: str = "graph_hybrid",
        evidence_ledger: EvidenceLedger | None = None,
        snapshot_id: str = "",
        revision: str = "",
    ) -> IntegrityGuardResult:
        """Validate candidates against repository and retained run context."""

        if not candidates:
            return IntegrityGuardResult()

        validation_context_digest = evidence_context_digest(
            evidence_ledger.to_payload() if evidence_ledger is not None else [],
            snapshot_id=snapshot_id,
            revision=revision,
        )

        evidence = tool_evidence or []
        manifests = context_manifests or []
        binding_failures = {
            candidate.candidate_id: self._candidate_binding_failures(candidate)
            for candidate in candidates
        }
        bound_candidates = bind_candidate_evidence(
            candidates,
            request,
            evidence,
            context_manifests=manifests,
            evidence_ledger=evidence_ledger,
            snapshot_id=snapshot_id,
            revision=revision,
        )
        contexts = (
            candidate_context
            if candidate_context is not None
            else build_candidate_verifier_context(
                bound_candidates,
                request,
                evidence,
                context_manifests=manifests,
                context_mode=context_mode,
            )
        )
        contexts_by_id = {
            str(item.get("candidate_id", "")): item
            for item in contexts
            if isinstance(item, dict)
        }
        changed = changed_new_lines_by_file(request.diff_text or "")
        prepared_candidates: list[FindingCandidate] = []
        preparation_failures: dict[str, tuple[IntegrityFailure, ...]] = {}
        for candidate in bound_candidates:
            prepared, failures = self._prepare_candidate_evidence(
                candidate,
                request=request,
                repo_root=self._root_for(request),
                changed=changed,
                context=contexts_by_id.get(candidate.candidate_id),
                evidence_ledger=evidence_ledger,
            )
            prepared_candidates.append(prepared)
            preparation_failures[candidate.candidate_id] = failures
        results = tuple(
            self._validate_candidate(
                candidate,
                request=request,
                repo_root=self._root_for(request),
                changed=changed,
                context=contexts_by_id.get(candidate.candidate_id),
                evidence_ledger=evidence_ledger,
                initial_failures=(
                    *binding_failures.get(candidate.candidate_id, ()),
                    *preparation_failures.get(candidate.candidate_id, ()),
                ),
                validation_context_digest=validation_context_digest,
            )
            for candidate in prepared_candidates
        )
        result_by_id = {result.candidate_id: result for result in results}
        finalized_candidates = tuple(
            candidate.model_copy(
                update={
                    "verification_status": (
                        "accepted"
                        if result_by_id.get(candidate.candidate_id, None)
                        and result_by_id[candidate.candidate_id].status == "verified"
                        else "verification_blocked"
                        if result_by_id.get(candidate.candidate_id, None)
                        else "verification_blocked"
                    ),
                    "integrity_status": (
                        result_by_id[candidate.candidate_id].status
                        if result_by_id.get(candidate.candidate_id, None)
                        else "invalid"
                    ),
                    "issue": candidate.issue.model_copy(
                        update={
                            "integrity_status": (
                                result_by_id[candidate.candidate_id].status
                                if result_by_id.get(candidate.candidate_id, None)
                                else "invalid"
                            )
                        }
                    ),
                }
            )
            for candidate in prepared_candidates
        )
        return IntegrityGuardResult(
            results=results,
            bound_candidates=finalized_candidates,
            evidence_context_digest=validation_context_digest,
        )

    def _prepare_candidate_evidence(
        self,
        candidate: FindingCandidate,
        *,
        request: ReviewRequest,
        repo_root: Path,
        changed: dict[str, set[int]],
        context: dict[str, Any] | None,
        evidence_ledger: EvidenceLedger | None,
    ) -> tuple[FindingCandidate, tuple[IntegrityFailure, ...]]:
        """Drop invalid optional structured evidence before final publication."""

        issue = candidate.issue
        if isinstance(issue, ReviewIssue) and issue.is_v3_finding:
            failures: list[IntegrityFailure] = []
            for index, evidence_item in enumerate(issue.evidence_provenance):
                failures.extend(
                    self._validate_evidence_item(
                        evidence_item,
                        request=request,
                        repo_root=repo_root,
                        changed=changed,
                        context=context,
                        evidence_ledger=evidence_ledger,
                        field=f"evidence_refs[{index}]",
                    )
                )
            return candidate, tuple(failures)
        if not (
            isinstance(issue, ReviewIssue)
            and issue.is_structured_hypothesis
            and issue.severity in _RISK_SEVERITIES
        ):
            return candidate, ()

        required_roles = {"cause", "contract"}
        if issue.trigger.strip():
            required_roles.add("trigger")
        if issue.impact.strip():
            required_roles.add("impact")
        retained: dict[str, list[Any]] = {}
        required_failures: list[IntegrityFailure] = []
        for role, evidence_items in (
            ("cause", issue.cause_evidence),
            ("contract", issue.contract_evidence),
            ("trigger", issue.trigger_evidence),
            ("impact", issue.impact_evidence),
        ):
            valid_items: list[Any] = []
            for index, evidence_item in enumerate(evidence_items):
                failures = self._validate_evidence_item(
                    evidence_item,
                    request=request,
                    repo_root=repo_root,
                    changed=changed,
                    context=context,
                    evidence_ledger=evidence_ledger,
                    field=f"{role}_evidence[{index}]",
                )
                if not failures:
                    valid_items.append(evidence_item)
                elif any(
                    failure.code
                    in {
                        "support_reference_unresolved",
                        "support_reference_undelivered",
                    }
                    for failure in failures
                ):
                    # Retain the unresolved reference for one candidate-level
                    # diagnostic. It is not source evidence and can never pass
                    # publication, but dropping it would create a misleading
                    # cascade of empty-role failures.
                    valid_items.append(evidence_item)
                    if role in required_roles:
                        required_failures.extend(failures)
                elif role in required_roles:
                    required_failures.extend(failures)
            retained[f"{role}_evidence"] = valid_items
        prepared_issue = issue.model_copy(update=retained)
        return (
            candidate.model_copy(update={"issue": prepared_issue}),
            tuple(required_failures),
        )

    def _validate_evidence_item(
        self,
        evidence_item: Any,
        *,
        request: ReviewRequest,
        repo_root: Path,
        changed: dict[str, set[int]],
        context: dict[str, Any] | None,
        evidence_ledger: EvidenceLedger | None,
        field: str,
    ) -> list[IntegrityFailure]:
        """Validate one evidence role and return failures with full provenance."""

        resolution_status = str(
            getattr(evidence_item, "resolution_status", "resolved") or "resolved"
        ).strip().lower()
        reference_id = str(getattr(evidence_item, "reference_id", "") or "").strip()
        if resolution_status in {"unresolved", "ambiguous", "undelivered"}:
            label = {
                "undelivered": "undelivered",
                "ambiguous": "ambiguous",
            }.get(resolution_status, "unresolved")
            return [
                IntegrityFailure(
                    (
                        "support_reference_undelivered"
                        if resolution_status == "undelivered"
                        else "support_reference_unresolved"
                    ),
                    f"Evidence reference is {label} in the delivered catalog; choose an exact legal catalog id.",
                    field=f"{field}.evidence_ref",
                    reference_id=reference_id,
                )
            ]

        evidence_location = self._evidence_location(evidence_item)
        failures = _decorate_failures(
            self._validate_location(
                evidence_location,
                repo_root=repo_root,
                field=field,
                require_line=True,
            ),
            evidence=evidence_item,
        )
        metadata = _evidence_failure_metadata(evidence_item)
        if not evidence_item.retrieval_source:
            failures.append(
                IntegrityFailure(
                    "evidence_binding_missing",
                    "Evidence does not identify a retrieval source.",
                    field=f"{field}.retrieval_source",
                    location=evidence_item.location,
                    **metadata,
                )
            )
        if not field.startswith("evidence_refs[") and not evidence_item.statement.strip():
            failures.append(
                IntegrityFailure(
                    "evidence_binding_missing",
                    "Evidence has no statement tying the location to the finding.",
                    field=f"{field}.statement",
                    location=evidence_item.location,
                    **metadata,
                )
            )
        if evidence_ledger is not None:
            ledger_records = [
                record
                for record in evidence_ledger.records
                if record.path == evidence_location.path
                and record.side
                == cast(
                    EvidenceSide,
                    str(getattr(evidence_item, "side", "new") or "new"),
                )
                and record.covers(
                    evidence_location.line or 0,
                    evidence_location.end_line or evidence_location.line or 0,
                )
            ]
            missing_identity = [
                field_name
                for field_name in ("artifact_id", "snapshot_id", "revision")
                if not str(getattr(evidence_item, field_name, "") or "").strip()
                and (
                    field_name == "artifact_id"
                    or any(
                        str(getattr(record, field_name, "") or "").strip()
                        for record in ledger_records
                    )
                )
            ]
            if missing_identity:
                failures.append(
                    IntegrityFailure(
                        "evidence_identity_mismatch",
                        "Evidence is missing system-bound artifact, snapshot, or revision identity.",
                        field=f"{field}.{missing_identity[0]}",
                        location=evidence_item.location,
                        **metadata,
                    )
                )
        observed = evidence_location.valid and (
            evidence_ledger.covers(
                evidence_location.path or "",
                evidence_location.line or 0,
                evidence_location.end_line or evidence_location.line,
                side=cast(
                    EvidenceSide,
                    str(getattr(evidence_item, "side", "new") or "new"),
                ),
                artifact_id=str(getattr(evidence_item, "artifact_id", "") or "").strip(),
                snapshot_id=str(
                    getattr(evidence_item, "snapshot_id", "") or ""
                ).strip(),
                revision=str(getattr(evidence_item, "revision", "") or "").strip(),
                content_hash=str(
                    getattr(evidence_item, "context_hash", "") or ""
                ).strip(),
            )
            if evidence_ledger is not None
            else provenance_in_candidate_context(context, evidence_item)
        )
        if evidence_location.valid and not observed:
            evidence_role = field.partition("_evidence")[0]
            base_observed = bool(
                evidence_ledger is not None
                and evidence_ledger.covers(
                    evidence_location.path or "",
                    evidence_location.line or 0,
                    evidence_location.end_line or evidence_location.line,
                    side=cast(
                        EvidenceSide,
                        str(getattr(evidence_item, "side", "new") or "new"),
                    ),
                )
            )
            if base_observed and evidence_ledger is not None:
                failures.append(
                    IntegrityFailure(
                        "evidence_identity_mismatch",
                        "Evidence path and range were delivered, but its explicit artifact, snapshot, revision, or hash does not match this run.",
                        field=f"{field}.identity",
                        location=evidence_item.location,
                        **metadata,
                    )
                )
                return failures
            budget_exhausted = context_budget_exhausted_for_evidence(
                context,
                evidence_item,
                role=evidence_role,
            )
            failures.append(
                IntegrityFailure(
                    (
                        "verifier_context_budget_exhausted"
                        if budget_exhausted
                        else "evidence_not_observed"
                    ),
                    (
                        "Evidence was observed but omitted from retained reviewer "
                        "context by the verifier budget."
                        if budget_exhausted
                        else "Evidence provenance is not present in retained reviewer context."
                    ),
                    field=field,
                    location=evidence_item.location,
                    **metadata,
                )
            )
        return failures

    def _validate_candidate(
        self,
        candidate: FindingCandidate,
        *,
        request: ReviewRequest,
        repo_root: Path,
        changed: dict[str, set[int]],
        context: dict[str, Any] | None,
        evidence_ledger: EvidenceLedger | None,
        initial_failures: tuple[IntegrityFailure, ...],
        validation_context_digest: str = "",
    ) -> FindingIntegrityResult:
        issue = candidate.issue
        failures: list[IntegrityFailure] = list(initial_failures)
        candidate_id = str(candidate.candidate_id or "").strip()

        if not candidate_id:
            failures.append(
                IntegrityFailure(
                    "candidate_binding_missing",
                    "Finding candidate id is empty.",
                    field="candidate_id",
                )
            )
        if not isinstance(issue, ReviewIssue):
            failures.append(
                IntegrityFailure(
                    "finding_structure_invalid",
                    "Finding could not be parsed as a ReviewIssue.",
                    field="issue",
                )
            )
            return FindingIntegrityResult(
                candidate_id,
                False,
                tuple(failures),
                content_version=candidate.candidate_content_version,
                evidence_context_digest=validation_context_digest,
            )

        for gap in canonical_contract_gaps(
            issue,
            strict=issue.is_structured_hypothesis
            and issue.severity in _RISK_SEVERITIES
            and (evidence_ledger is not None or bool(issue.supports)),
        ):
            gap_code = gap.code
            gap_message = gap.message
            if (
                gap.code == "evidence_incomplete"
                and evidence_ledger is not None
                and _issue_anchor_is_delivered(issue, evidence_ledger)
            ):
                # The source is present; what is absent is the role-specific
                # claim/envelope. Keep this in the contract class so source
                # retrieval is not requested again for an already delivered
                # body.
                gap_code = "role_claim_missing"
                gap_message = (
                    "The cited source is already delivered, but the finding is "
                    f"missing the {gap.field} role claim."
                )
            failures.append(
                IntegrityFailure(
                    gap_code,
                    gap_message,
                    field=gap.field,
                    location=issue.location,
                )
            )

        if issue.candidate_id and issue.candidate_id != candidate_id:
            failures.append(
                IntegrityFailure(
                    "candidate_binding_mismatch",
                    "Finding candidate_id does not match the runtime candidate.",
                    field="candidate_id",
                )
            )
        for evidence in issue.all_evidence():
            if evidence.candidate_id and evidence.candidate_id != candidate_id:
                failures.append(
                    IntegrityFailure(
                        "candidate_binding_mismatch",
                        "Evidence candidate_id does not match its finding candidate.",
                        field="evidence.candidate_id",
                        location=evidence.location,
                        **_evidence_failure_metadata(evidence),
                    )
                )

        display = normalize_location(issue.location)
        failures.extend(
            self._validate_location(
                display,
                repo_root=repo_root,
                field="location",
                require_line=issue.severity in _RISK_SEVERITIES,
            )
        )
        if display.valid and display.line is not None:
            failures.extend(
                self._observed_failures(
                    display,
                    context=context,
                    changed=changed,
                    field="location",
                    evidence_ledger=evidence_ledger,
                )
            )

        if issue.primary_anchor is not None:
            anchor_location = normalize_location(issue.primary_anchor.location)
            failures.extend(
                self._validate_location(
                    anchor_location,
                    repo_root=repo_root,
                    field="primary_anchor",
                    require_line=True,
                )
            )
            if anchor_location.valid:
                failures.extend(
                    self._observed_failures(
                        anchor_location,
                        context=context,
                        changed=changed,
                        field="primary_anchor",
                        evidence_ledger=evidence_ledger,
                    )
                )

        for index, related in enumerate(issue.related_locations):
            related_location = normalize_location(related.location)
            field = f"related_locations[{index}]"
            failures.extend(
                self._validate_location(
                    related_location,
                    repo_root=repo_root,
                    field=field,
                    require_line=True,
                )
            )
            if related_location.valid:
                failures.extend(
                    self._observed_failures(
                        related_location,
                        context=context,
                        changed=changed,
                        field=field,
                        evidence_ledger=evidence_ledger,
                    )
                )

        for role, evidence_items in (
            ("cause", issue.cause_evidence),
            ("contract", issue.contract_evidence),
            ("trigger", issue.trigger_evidence),
            ("impact", issue.impact_evidence),
        ):
            for index, evidence_item in enumerate(evidence_items):
                failures.extend(
                    self._validate_evidence_item(
                        evidence_item,
                        request=request,
                        repo_root=repo_root,
                        changed=changed,
                        context=context,
                        evidence_ledger=evidence_ledger,
                        field=f"{role}_evidence[{index}]",
                    )
                )

        if issue.is_v3_finding:
            for index, evidence_item in enumerate(issue.evidence_provenance):
                failures.extend(
                    self._validate_evidence_item(
                        evidence_item,
                        request=request,
                        repo_root=repo_root,
                        changed=changed,
                        context=context,
                        evidence_ledger=evidence_ledger,
                        field=f"evidence_refs[{index}]",
                    )
                )

        if (
            issue.is_structured_hypothesis
            and not issue.is_v3_finding
            and issue.severity in _RISK_SEVERITIES
        ):
            required_roles = {"cause", "contract"}
            if issue.trigger.strip():
                required_roles.add("trigger")
            if issue.impact.strip():
                required_roles.add("impact")
            for role in sorted(required_roles):
                if not getattr(issue, f"{role}_evidence"):
                    role_gap_code = (
                        "role_claim_missing"
                        if evidence_ledger is not None
                        and _issue_anchor_is_delivered(issue, evidence_ledger)
                        else "evidence_incomplete"
                    )
                    failures.append(
                        IntegrityFailure(
                            role_gap_code,
                            (
                                "The cited source is already delivered, but the finding "
                                f"is missing the {role}_evidence role claim."
                                if role_gap_code == "role_claim_missing"
                                else f"Structured risk finding is missing {role} evidence."
                            ),
                            field=f"{role}_evidence",
                            location=issue.location,
                            **_location_failure_metadata(display),
                        )
                    )

        if issue.severity in _RISK_SEVERITIES and self._requires_changed_anchor(
            request, changed
        ):
            if not self._has_changed_anchor(candidate, issue, changed):
                failures.append(
                    IntegrityFailure(
                        "changed_anchor_missing",
                        "Risk finding has no location on a line changed by this PR.",
                        field="changed_anchor",
                    )
                )

        unique_failures = tuple(dict.fromkeys(failures))
        return FindingIntegrityResult(
            candidate_id,
            not unique_failures,
            unique_failures,
            content_version=candidate.candidate_content_version,
            evidence_context_digest=validation_context_digest,
        )

    @staticmethod
    def _candidate_binding_failures(
        candidate: FindingCandidate,
    ) -> tuple[IntegrityFailure, ...]:
        candidate_id = str(candidate.candidate_id or "").strip()
        failures: list[IntegrityFailure] = []
        issue = candidate.issue
        if not candidate_id:
            return ()
        if isinstance(issue, ReviewIssue):
            if issue.candidate_id and issue.candidate_id != candidate_id:
                failures.append(
                    IntegrityFailure(
                        "candidate_binding_mismatch",
                        "Finding candidate_id does not match the runtime candidate.",
                        field="candidate_id",
                    )
                )
            for evidence in issue.all_evidence():
                if evidence.candidate_id and evidence.candidate_id != candidate_id:
                    failures.append(
                        IntegrityFailure(
                            "candidate_binding_mismatch",
                            "Evidence candidate_id does not match its finding candidate.",
                            field="evidence.candidate_id",
                            location=evidence.location,
                            **_evidence_failure_metadata(evidence),
                        )
                    )
        return tuple(failures)

    @staticmethod
    def _requires_changed_anchor(
        request: ReviewRequest, changed: dict[str, set[int]]
    ) -> bool:
        """Require PR anchoring in diff reviews, while preserving full-repo reviews."""

        return request.diff_mode or bool(changed)

    @staticmethod
    def _has_changed_anchor(
        candidate: FindingCandidate,
        issue: ReviewIssue,
        changed: dict[str, set[int]],
    ) -> bool:
        locations: list[LocationParseResult] = [normalize_location(issue.location)]
        if issue.primary_anchor is not None:
            locations.append(normalize_location(issue.primary_anchor.location))
        locations.extend(
            normalize_location(item.location) for item in issue.related_locations
        )
        locations.extend(
            normalize_location(item.location) for item in issue.all_evidence()
        )
        locations.extend(normalize_location(item) for item in candidate.evidence_locations)
        return any(
            location.valid
            and location.path in changed
            and location.line is not None
            and any(
                line in changed[location.path]
                for line in range(
                    location.line, (location.end_line or location.line) + 1
                )
            )
            for location in locations
        )

    @staticmethod
    def _evidence_location(evidence: Any) -> LocationParseResult:
        file = normalize_repo_path(getattr(evidence, "file", ""))
        line = getattr(evidence, "line", None)
        end_line = getattr(evidence, "end_line", None)
        if not file or line is None:
            return normalize_location("")
        suffix = str(line)
        if end_line is not None:
            suffix += f"-{end_line}"
        return normalize_location(f"{file}:{suffix}")

    @staticmethod
    def _validate_location(
        location: LocationParseResult,
        *,
        repo_root: Path,
        field: str,
        require_line: bool,
    ) -> list[IntegrityFailure]:
        if not location.valid or not location.path:
            return [
                IntegrityFailure(
                    "location_invalid",
                    location.warning or "Location is not a valid repository-relative path.",
                    field=field,
                    location=location.raw,
                )
            ]
        if location.line is None:
            if require_line:
                return [
                    IntegrityFailure(
                        "location_line_missing",
                        "Risk finding location must identify a source line.",
                        field=field,
                        location=location.canonical,
                    )
                ]
            return FindingIntegrityGuard._validate_repo_path(
                repo_root, location.path, field=field, location=location.canonical
            )

        failures = FindingIntegrityGuard._validate_repo_path(
            repo_root, location.path, field=field, location=location.canonical
        )
        if failures:
            return failures
        path = FindingIntegrityGuard._resolve_repo_path(repo_root, location.path)
        if path is None or not path.is_file():
            return failures
        try:
            line_count = _line_count(path)
        except OSError:
            return [
                IntegrityFailure(
                    "location_unreadable",
                    "Referenced repository file could not be read.",
                    field=field,
                    location=location.canonical,
                )
            ]
        end_line = location.end_line or location.line
        if end_line > line_count:
            return [
                IntegrityFailure(
                    "location_line_out_of_range",
                    f"Referenced line range exceeds the file's {line_count} lines.",
                    field=field,
                    location=location.canonical,
                )
            ]
        return failures

    @staticmethod
    def _validate_repo_path(
        repo_root: Path,
        relative_path: str,
        *,
        field: str,
        location: str,
    ) -> list[IntegrityFailure]:
        resolved = FindingIntegrityGuard._resolve_repo_path(repo_root, relative_path)
        if resolved is None:
            return [
                IntegrityFailure(
                    "repository_path_invalid",
                    "Referenced path escapes the repository root.",
                    field=field,
                    location=location,
                )
            ]
        if not resolved.exists() or not resolved.is_file():
            return [
                IntegrityFailure(
                    "repository_path_missing",
                    "Referenced repository file does not exist.",
                    field=field,
                    location=location,
                )
            ]
        return []

    @staticmethod
    def _resolve_repo_path(repo_root: Path, relative_path: str) -> Path | None:
        normalized = normalize_repo_path(relative_path)
        if not normalized or normalized.startswith("/"):
            return None
        try:
            resolved = (repo_root / Path(*normalized.split("/"))).resolve()
            if not resolved.is_relative_to(repo_root.resolve()):
                return None
        except (OSError, ValueError):
            return None
        return resolved

    @staticmethod
    def _observed_failures(
        location: LocationParseResult,
        *,
        context: dict[str, Any] | None,
        changed: dict[str, set[int]],
        field: str,
        evidence_ledger: EvidenceLedger | None = None,
    ) -> list[IntegrityFailure]:
        if not location.valid or location.line is None:
            return []
        if _location_intersects_changed_lines(location, changed):
            return []
        if evidence_ledger is not None:
            if evidence_ledger.covers(
                location.path or "",
                location.line,
                location.end_line or location.line,
            ):
                return []
        elif location_in_candidate_context(context, location):
            return []
        budget_exhausted = context_budget_exhausted_for_location(context, location)
        return [
            IntegrityFailure(
                (
                    "verifier_context_budget_exhausted"
                    if budget_exhausted
                    else "evidence_not_observed"
                ),
                (
                    "Referenced code was observed but omitted from retained reviewer "
                    "context by the verifier budget."
                    if budget_exhausted
                    else "Referenced code was not present in retained reviewer context."
                ),
                field=field,
                location=location.canonical,
                **_location_failure_metadata(location),
            )
        ]

    def _root_for(self, request: ReviewRequest) -> Path:
        return self._repo_root or Path(request.repo_path).resolve()


def _evidence_failure_metadata(evidence: Any) -> dict[str, Any]:
    """Extract safe provenance fields for structured failure telemetry."""

    digest = str(getattr(evidence, "context_hash", "") or "").strip()
    file = normalize_repo_path(str(getattr(evidence, "file", "") or ""))
    start_line = getattr(evidence, "line", None)
    end_line = getattr(evidence, "end_line", None) or start_line
    return {
        "file": file,
        "start_line": start_line if isinstance(start_line, int) else None,
        "end_line": end_line if isinstance(end_line, int) else None,
        "retrieval_source": str(
            getattr(evidence, "retrieval_source", "") or ""
        ).strip(),
        "context_manifest_id": str(
            getattr(evidence, "context_manifest_id", "") or ""
        ).strip(),
        "manifest_hash_prefix": digest[:12],
        "reference_id": str(
            getattr(evidence, "reference_id", "") or ""
        ).strip(),
    }


def _location_failure_metadata(location: LocationParseResult) -> dict[str, Any]:
    """Extract structured location fields for non-evidence failures."""

    return {
        "file": location.path or "",
        "start_line": location.line,
        "end_line": location.end_line or location.line,
    }


def _decorate_failures(
    failures: list[IntegrityFailure],
    *,
    evidence: Any,
) -> list[IntegrityFailure]:
    """Fill structured evidence metadata without changing failure identity."""

    metadata = _evidence_failure_metadata(evidence)
    decorated: list[IntegrityFailure] = []
    for failure in failures:
        updates = {
            key: value
            for key, value in metadata.items()
            if not getattr(failure, key)
            and value not in ("", None)
        }
        decorated.append(replace(failure, **updates) if updates else failure)
    return decorated


def _location_intersects_changed_lines(
    location: LocationParseResult,
    changed: dict[str, set[int]],
) -> bool:
    if not location.valid or not location.path or location.line is None:
        return False
    end_line = location.end_line or location.line
    return any(
        line in changed.get(location.path, set())
        for line in range(location.line, end_line + 1)
    )


def _issue_anchor_is_delivered(issue: ReviewIssue, ledger: EvidenceLedger) -> bool:
    """Tell role/claim omissions apart from genuinely missing source bodies."""

    locations: list[LocationParseResult] = []
    display = normalize_location(issue.location)
    if display.valid and display.line is not None:
        locations.append(display)
    if issue.primary_anchor is not None:
        anchor = normalize_location(issue.primary_anchor.location)
        if anchor.valid and anchor.line is not None:
            locations.append(anchor)
    for location in locations:
        if ledger.covers(
            location.path or "",
            location.line or 0,
            location.end_line or location.line,
        ):
            return True
    return False


def _line_count(path: Path) -> int:
    data = path.read_bytes()
    if not data:
        return 0
    return data.count(b"\n") + (0 if data.endswith(b"\n") else 1)
