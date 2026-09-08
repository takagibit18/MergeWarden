"""Canonical finding-contract adapters and deterministic contract gaps.

The runtime still exposes :class:`ReviewIssue` to old publishers.  This module
is the explicit seam between that compatibility envelope and the v2 finding
contract used by parsing, validation, and evaluation.  It deliberately does
not decide whether a claim is semantically true; it only checks that a claim
has the fields and provenance needed for the later integrity stage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src.analyzer.finding_schema import (
    ClaimSupport,
    FindingDraft,
    FINDING_SCHEMA_VERSION,
    EvidenceProvenance,
    EvidenceRole,
)
from src.analyzer.location import normalize_location
from src.analyzer.output_formatter import ReviewIssue


_STRUCTURED_ISSUE_FIELDS = frozenset(
    {
        "finding_id",
        "primary_anchor",
        "related_locations",
        "observed_behavior",
        "causal_mechanism",
        "violated_invariant",
        "repair_intent",
        "trigger",
        "impact",
        "supports",
    }
)


@dataclass(frozen=True)
class FindingContractGap:
    """One repairable or invalid gap in a canonical finding envelope."""

    code: str
    field: str
    message: str
    invalid: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "field": self.field,
            "message": self.message,
            "invalid": self.invalid,
        }


def is_structured_issue_payload(payload: Any) -> bool:
    """Tell producer boundaries whether a payload uses the v2 field family."""

    if not isinstance(payload, dict):
        return False
    if str(payload.get("schema_version", "") or "").strip() == FINDING_SCHEMA_VERSION:
        return True
    return bool(_STRUCTURED_ISSUE_FIELDS.intersection(payload))


def normalize_producer_issue_payload(payload: Any) -> Any:
    """Assign v2 for core structured payloads, preventing legacy bypass."""

    if not isinstance(payload, dict) or not is_structured_issue_payload(payload):
        return payload
    normalized = dict(payload)
    if str(normalized.get("schema_version", "") or "").strip() in {"", "1.0"}:
        normalized["schema_version"] = FINDING_SCHEMA_VERSION
    return normalized


def evidence_reference(evidence: EvidenceProvenance) -> str:
    """Return a stable reference that can be compared with a ClaimSupport ref."""

    if evidence.context_hash:
        return evidence.context_hash
    if evidence.context_manifest_id:
        return evidence.context_manifest_id
    return evidence.location


def issue_supports(issue: ReviewIssue) -> list[ClaimSupport]:
    """Read canonical supports, deriving them from legacy role arrays if needed."""

    if issue.supports:
        return list(issue.supports)
    supports: list[ClaimSupport] = []
    for role, values in _role_evidence(issue):
        if not values:
            continue
        refs = [
            reference
            for reference in (evidence_reference(item) for item in values)
            if reference
        ]
        statement = next(
            (item.statement.strip() for item in values if item.statement.strip()),
            "",
        )
        if refs and statement:
            supports.append(
                ClaimSupport(
                    role=role,
                    statement=statement,
                    evidence_refs=sorted(set(refs)),
                )
            )
    return supports


def canonical_contract_gaps(
    issue: ReviewIssue,
    *,
    strict: bool = False,
) -> list[FindingContractGap]:
    """Return structural gaps without silently upgrading legacy findings.

    Legacy v1 issues remain parseable for compatibility.  They are not treated
    as canonical findings.  Structured v2 risk issues require the cause and
    contract roles, and require trigger/impact evidence whenever the matching
    claim is present.  ``strict`` additionally requires the v2 narrative fields
    and is used by active submit preflight; the default keeps old in-process
    callers source-compatible while the final guard still validates provenance.
    """

    if issue.schema_version == "1.0":
        return []
    if issue.schema_version != FINDING_SCHEMA_VERSION:
        return [
            FindingContractGap(
                "finding_contract_invalid",
                "schema_version",
                "Finding schema_version must be 1.0 or 2.0.",
                invalid=True,
            )
        ]
    gaps: list[FindingContractGap] = []
    if issue.primary_anchor is None:
        gaps.append(
            FindingContractGap(
                "finding_contract_incomplete",
                "primary_anchor",
                "Structured findings need a primary source anchor.",
            )
        )
    else:
        display_location = normalize_location(issue.location)
        if (
            display_location.valid
            and display_location.canonical != issue.primary_anchor.location
        ):
            gaps.append(
                FindingContractGap(
                    "finding_contract_invalid",
                    "primary_anchor",
                    "primary_anchor must agree with the canonical finding location.",
                    invalid=True,
                )
            )
    if strict:
        if not issue.finding_id.strip():
            gaps.append(
                FindingContractGap(
                    "finding_contract_incomplete",
                    "finding_id",
                    "Structured risk finding is missing finding_id.",
                )
            )
        for field in (
            "observed_behavior",
            "causal_mechanism",
            "violated_invariant",
            "trigger",
            "impact",
        ):
            if not getattr(issue, field, "").strip():
                gaps.append(
                    FindingContractGap(
                        "finding_contract_incomplete",
                        field,
                        f"Structured risk finding is missing {field}.",
                    )
                )
        if not issue.repair_intent.action.strip():
            gaps.append(
                FindingContractGap(
                    "finding_contract_incomplete",
                    "repair_intent.action",
                    "Structured risk finding is missing repair intent.",
                )
            )

    role_values: dict[str, list[EvidenceProvenance]] = {
        str(role): values for role, values in _role_evidence(issue)
    }
    required_roles = {"cause", "contract"}
    if issue.trigger.strip():
        required_roles.add("trigger")
    if issue.impact.strip():
        required_roles.add("impact")
    for role in sorted(required_roles):
        values = role_values.get(role, [])
        if not values:
            gaps.append(
                FindingContractGap(
                    "evidence_incomplete",
                    f"{role}_evidence",
                    f"Structured risk finding is missing {role} evidence.",
                )
            )
            continue
        for index, item in enumerate(values):
            if not item.statement.strip():
                gaps.append(
                    FindingContractGap(
                        "evidence_binding_missing",
                        f"{role}_evidence[{index}].statement",
                        "Evidence needs a statement tying the source to the claim.",
                    )
                )

    supports = issue_supports(issue)
    seen_roles: set[str] = set()
    role_refs = {
        role: {
            reference
            for item in values
            for reference in _evidence_reference_options(item)
            if reference
        }
        for role, values in role_values.items()
    }
    for index, support in enumerate(supports):
        if support.role in seen_roles:
            gaps.append(
                FindingContractGap(
                    "finding_contract_invalid",
                    f"supports[{index}].role",
                    "Canonical supports may contain one envelope per role.",
                    invalid=True,
                )
            )
        seen_roles.add(support.role)
        allowed_refs = role_refs.get(support.role, set())
        if not set(support.evidence_refs).intersection(allowed_refs):
            gaps.append(
                FindingContractGap(
                    "support_reference_missing",
                    f"supports[{index}].evidence_refs",
                    "Support references do not identify a declared evidence item.",
                    invalid=True,
                )
            )
    support_roles = {support.role for support in supports}
    for role in sorted(required_roles):
        if role not in support_roles:
            gaps.append(
                FindingContractGap(
                    "support_role_missing",
                    "supports",
                    f"Canonical supports is missing the {role} role envelope.",
                )
            )
    return gaps


def _evidence_reference_options(evidence: EvidenceProvenance) -> set[str]:
    """Return stable references that remain comparable after runtime binding."""

    return {
        value
        for value in (
            evidence.location,
            evidence.context_hash,
            evidence.context_manifest_id,
            evidence.artifact_id,
        )
        if value
    }


def finding_draft_from_issue(
    issue: ReviewIssue,
    *,
    runtime_finding_id: str | None = None,
) -> FindingDraft:
    """Convert a structured compatibility issue into the canonical draft."""

    if issue.schema_version != FINDING_SCHEMA_VERSION:
        raise ValueError(
            "legacy ReviewIssue requires the explicit compatibility adapter"
        )
    gaps = canonical_contract_gaps(issue, strict=True)
    if gaps:
        raise ValueError("; ".join(gap.message for gap in gaps))
    assert issue.primary_anchor is not None
    return FindingDraft(
        finding_id=(runtime_finding_id or issue.finding_id or "").strip(),
        severity=issue.severity.value,
        confidence=issue.confidence,
        primary_anchor=issue.primary_anchor,
        observed_behavior=issue.observed_behavior,
        causal_mechanism=issue.causal_mechanism,
        violated_invariant=issue.violated_invariant,
        repair_intent=issue.repair_intent,
        trigger=issue.trigger,
        impact=issue.impact,
        supports=issue_supports(issue),
    )


def legacy_issue_adapter(issue: ReviewIssue) -> ReviewIssue:
    """Mark the old output shape explicitly for legacy consumers."""

    return issue.model_copy(update={"schema_version": "1.0", "supports": []})


def _role_evidence(
    issue: ReviewIssue,
) -> list[tuple[EvidenceRole, list[EvidenceProvenance]]]:
    return [
        ("cause", issue.cause_evidence),
        ("contract", issue.contract_evidence),
        ("trigger", issue.trigger_evidence),
        ("impact", issue.impact_evidence),
    ]
