"""Canonical finding-contract adapters and deterministic contract gaps.

The runtime still exposes :class:`ReviewIssue` to old publishers.  This module
is the explicit seam between that compatibility envelope and the v2 finding
contract used by parsing, validation, and evaluation.  It deliberately does
not decide whether a claim is semantically true; it only checks that a claim
has the fields and provenance needed for the later integrity stage.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from src.analyzer.finding_schema import (
    ClaimSupport,
    FindingDraft,
    FindingRepairPatch,
    FINDING_SCHEMA_VERSION,
    EvidenceProvenance,
    EvidenceRole,
    FindingSeverity,
    RelatedLocation,
    RepairIntent,
    SourceAnchor,
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

# One source of truth for the semantic portion of a structured risk finding.
# The model-facing schema remains parse-tolerant so legacy adapters and the
# bounded repair loop can return candidate-level gaps instead of losing the
# entire report at JSON validation time.  The active submit schema adds the
# same fields as a conditional requirement for critical/warning issues.
STRUCTURED_RISK_NARRATIVE_FIELDS = (
    "observed_behavior",
    "causal_mechanism",
    "violated_invariant",
    "trigger",
    "impact",
)
STRUCTURED_RISK_REQUIRED_ROLES = ("cause", "contract")


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


ModelSupportRole = Literal["cause", "contract", "trigger", "impact"]


class ModelClaimSupport(BaseModel):
    """Model-facing role claim; related locations are not evidence roles."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    role: ModelSupportRole
    statement: str = Field(..., min_length=1)
    evidence_refs: list[str] = Field(..., min_length=1)


class ModelFindingInput(BaseModel):
    """Small model-facing finding contract.

    Runtime identity, provenance, and the compatibility ``location`` string
    deliberately do not appear here.  The adapter below turns this input into
    the strict internal ``ReviewIssue`` envelope.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    severity: FindingSeverity = Field(
        ..., description="critical, warning, info, or style"
    )
    primary_anchor: SourceAnchor = Field(
        ...,
        description="The one authoritative source position for this finding.",
    )
    evidence: str = Field(..., min_length=1)
    suggestion: str = Field(..., min_length=1)
    confidence: float = Field(..., ge=0.0, le=1.0)
    finding_id: str = ""
    target_candidate_id: str = Field(
        default="",
        description=(
            "Repair-only: exact runtime candidate_id from candidate_repair_feedback. "
            "Omit for an initial submission; never invent or reuse a finding_id here."
        ),
    )
    repair_status: Literal["", "repaired", "unchanged", "incomplete", "deferred"] = Field(
        default="",
        description=(
            "Repair-only: repaired, unchanged, or incomplete for the exact target."
        ),
    )
    candidate_content_version: str = Field(
        default="",
        description="Repair-only exact content version from candidate_repair_feedback.",
    )
    observed_behavior: str = ""
    causal_mechanism: str = ""
    violated_invariant: str = ""
    repair_intent: RepairIntent = Field(default_factory=RepairIntent)
    trigger: str = ""
    impact: str = ""
    supports: list[ModelClaimSupport] = Field(default_factory=list)
    related_locations: list[RelatedLocation] = Field(default_factory=list)


class ModelRepairIssueInput(BaseModel):
    """Model-facing identity-bound repair envelope.

    A repair response is deliberately not a second full finding.  The runtime
    owns the candidate's current semantic content and applies only the explicit
    ``repair_patch`` fields after checking the exact target and version.  This
    prevents an omitted field, a stale full finding, or a guessed identity from
    silently replacing the original candidate.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    target_candidate_id: str = Field(
        ...,
        min_length=1,
        description="Exact runtime candidate id from the active repair transaction.",
    )
    candidate_content_version: str = Field(
        ...,
        min_length=1,
        description="Exact base version copied from the active repair transaction.",
    )
    repair_status: Literal["repaired", "unchanged", "incomplete", "deferred"]
    repair_reason: str = ""
    repair_patch: FindingRepairPatch | None = Field(
        default=None,
        description=(
            "Only the semantic fields that changed. Omitted fields remain on the "
            "runtime-owned original candidate."
        ),
    )


class ModelRepairTargetInput(BaseModel):
    """Model-facing repair item bound to an opaque runtime handle.

    The handle is deliberately not a candidate id or content hash.  The
    runtime resolves it inside the currently open transaction and checks the
    transaction's base version/context before applying the patch.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    target_handle: str = Field(
        ...,
        min_length=1,
        description="Opaque target handle from the active repair transaction.",
    )
    repair_status: Literal["repaired", "unchanged", "incomplete", "deferred"]
    repair_reason: str = ""
    repair_patch: FindingRepairPatch | None = Field(
        default=None,
        description=(
            "Only changed semantic fields. Omitted fields inherit the runtime-owned "
            "candidate; use delete_fields for explicit deletion."
        ),
    )


class ModelRepairResponse(BaseModel):
    """Patch-only response returned by the dedicated repair tool."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    repairs: list[ModelRepairTargetInput] = Field(
        ...,
        min_length=1,
        description="One or more opaque target dispositions or semantic patches.",
    )


def is_structured_issue_payload(payload: Any) -> bool:
    """Tell producer boundaries whether a payload uses the v2 field family."""

    if not isinstance(payload, dict):
        return False
    if str(payload.get("schema_version", "") or "").strip() == FINDING_SCHEMA_VERSION:
        return True
    return bool(_STRUCTURED_ISSUE_FIELDS.intersection(payload))


def is_model_finding_payload(payload: Any) -> bool:
    """Identify the new input shape by its single-anchor boundary."""

    if not isinstance(payload, dict):
        return False
    return "primary_anchor" in payload and "location" not in payload


def is_model_repair_payload(payload: Any) -> bool:
    """Identify the identity-bound repair envelope before normal finding parsing."""

    if not isinstance(payload, dict):
        return False
    target = str(
        payload.get("target_candidate_id", payload.get("target_handle", "")) or ""
    ).strip()
    return bool(target and ("repair_status" in payload or "repair_patch" in payload))


_REPAIR_ENVELOPE_FIELDS = frozenset(
    {
        "target_candidate_id",
        "candidate_content_version",
        "repair_status",
        "repair_reason",
        "repair_patch",
    }
)


def validate_model_repair_payload(payload: Any) -> str:
    """Return a precise protocol error for one patch-only repair issue.

    This check is separate from ``normalize_model_repair_payload`` because the
    latter materializes a temporary compatibility envelope for the existing
    evidence binder.  The wire boundary must reject semantic fields outside
    ``repair_patch`` before that compatibility adapter can see them.
    """

    if not isinstance(payload, dict):
        return f"repair issue must be an object, got {type(payload).__name__}"
    unexpected = sorted(set(payload) - _REPAIR_ENVELOPE_FIELDS)
    if unexpected:
        return (
            "repair issue contains forbidden top-level semantic fields: "
            + ", ".join(unexpected)
            + "; put changed fields under repair_patch"
        )
    try:
        model_input = ModelRepairIssueInput.model_validate(payload)
    except ValidationError as exc:
        return str(exc)
    if model_input.repair_status == "repaired":
        patch = model_input.repair_patch
        if patch is None or not patch.model_dump(mode="json", exclude_none=True):
            return "repaired repair_status requires a non-empty repair_patch"
    elif model_input.repair_patch is not None:
        return (
            "repair_patch is allowed only when repair_status is repaired; "
            f"got {model_input.repair_status}"
        )
    return ""


def validate_model_repair_target_payload(payload: Any) -> str:
    """Validate one dedicated repair item without legacy identity fields."""

    if not isinstance(payload, dict):
        return f"repair item must be an object, got {type(payload).__name__}"
    try:
        item = ModelRepairTargetInput.model_validate(payload)
    except ValidationError as exc:
        return str(exc)
    patch = item.repair_patch
    if item.repair_status == "repaired":
        if patch is None:
            return "repaired repair_status requires a non-empty repair_patch"
        if not (
            patch.model_fields_set - {"delete_fields"}
            or patch.delete_fields
        ):
            return "repaired repair_status requires a non-empty repair_patch"
        null_fields = sorted(
            field
            for field in patch.model_fields_set
            if field != "delete_fields" and getattr(patch, field) is None
        )
        if null_fields:
            return (
                "null is not an omission or deletion for repair fields: "
                + ", ".join(null_fields)
            )
    elif patch is not None:
        return (
            "repair_patch is allowed only when repair_status is repaired; "
            f"got {item.repair_status}"
        )
    return ""


def normalize_model_repair_payload(
    payload: dict[str, Any],
    *,
    evidence_catalog: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Normalize a patch-only repair into a parseable compatibility envelope."""

    try:
        model_input = ModelRepairIssueInput.model_validate(payload)
    except ValidationError:
        normalized = {
            key: value
            for key, value in payload.items()
            if key in ModelRepairIssueInput.model_fields
        }
    else:
        normalized = model_input.model_dump(mode="json", exclude_none=True)

    direct_patch_fields = {
        "severity",
        "primary_anchor",
        "evidence",
        "suggestion",
        "confidence",
        "observed_behavior",
        "causal_mechanism",
        "violated_invariant",
        "repair_intent",
        "trigger",
        "impact",
        "supports",
        "related_locations",
    }
    if (
        "repair_patch" not in normalized
        and not direct_patch_fields.intersection(normalized)
    ):
        # Preserve the distinction between a patch-only response and a legacy
        # full replacement after the temporary ReviewIssue is materialized.
        normalized["repair_patch"] = {}

    patch = normalized.get("repair_patch")
    if isinstance(patch, dict):
        # Lift patch fields into the temporary compatibility envelope so the
        # existing evidence binding path can resolve its support references.
        for field, value in patch.items():
            normalized.setdefault(field, value)

    # ReviewIssue keeps required v0.2.2 fields for downstream publishers.
    # These placeholders are never published: _merge_repaired_report applies
    # only the explicit patch to the runtime-owned original candidate.
    normalized.setdefault("severity", "info")
    normalized.setdefault(
        "primary_anchor",
        {"file": "__repair_target__", "line": 1},
    )
    normalized.setdefault("evidence", "")
    normalized.setdefault("suggestion", "")
    normalized.setdefault("confidence", 0.0)
    normalized["schema_version"] = FINDING_SCHEMA_VERSION

    anchor_raw = normalized.get("primary_anchor")
    try:
        anchor = SourceAnchor.model_validate(anchor_raw)
    except Exception:  # noqa: BLE001
        normalized.setdefault("location", "")
    else:
        normalized["primary_anchor"] = anchor.model_dump(mode="json")
        normalized["location"] = anchor.location

    supports = normalized.get("supports")
    if not isinstance(supports, list):
        return normalized
    role_fields = {
        "cause": "cause_evidence",
        "contract": "contract_evidence",
        "trigger": "trigger_evidence",
        "impact": "impact_evidence",
    }
    catalog = _evidence_catalog_by_reference(evidence_catalog or [])
    catalog_status = _evidence_catalog_reference_status(evidence_catalog or [])
    for evidence_field in role_fields.values():
        normalized[evidence_field] = []
    for support in supports:
        if not isinstance(support, dict):
            continue
        role = str(support.get("role", "")).strip()
        field = role_fields.get(role)
        if field is None:
            continue
        statement = str(support.get("statement", "")).strip()
        refs = support.get("evidence_refs", [])
        if not isinstance(refs, list):
            continue
        for raw_ref in refs:
            reference = str(raw_ref or "").strip()
            if not reference:
                continue
            record = catalog.get(reference)
            normalized[field].append(
                _evidence_payload_from_catalog_record(
                    record,
                    reference=reference,
                    statement=statement,
                    resolution_status=(
                        "resolved"
                        if record is not None
                        else catalog_status.get(reference, "unresolved")
                    ),
                )
            )
    return normalized


def normalize_model_finding_payload(
    payload: Any,
    *,
    evidence_catalog: list[dict[str, Any]] | None = None,
) -> Any:
    """Materialize model input into the strict compatibility envelope.

    The model selects exact ids from ``evidence_catalog``.  A missing id is
    represented as an unbound evidence item so the integrity guard can reject
    it with a useful reason; it is never replaced by a nearby span.
    """

    if not isinstance(payload, dict):
        return normalize_producer_issue_payload(payload)
    if is_model_repair_payload(payload):
        return normalize_model_repair_payload(
            payload,
            evidence_catalog=evidence_catalog,
        )
    model_shape = is_model_finding_payload(payload)
    if not model_shape and "primary_anchor" not in payload:
        return normalize_producer_issue_payload(payload)
    if model_shape:
        try:
            # Re-validate at the adapter boundary so fields owned by the runtime
            # (candidate/provenance/location identity) cannot ride along in a
            # simplified model payload and become trusted downstream.
            model_input = ModelFindingInput.model_validate(payload)
        except ValidationError:
            # Preserve semantic values for the normal report validation error, but
            # drop every field that is outside the model-facing contract.
            normalized = {
                key: value
                for key, value in payload.items()
                if key in ModelFindingInput.model_fields
            }
        else:
            normalized = model_input.model_dump(mode="json")
            # These fields remain on the compatibility Pydantic model for old
            # callers, but the initial wire schema does not expose them and a
            # model-supplied value must never open or retarget a repair.
            for runtime_field in (
                "target_candidate_id",
                "repair_status",
                "candidate_content_version",
                "repair_reason",
                "repair_patch",
            ):
                normalized.pop(runtime_field, None)
        normalized["schema_version"] = FINDING_SCHEMA_VERSION
    else:
        # Old structured producers may still send both fields.  Keep the
        # compatibility envelope, but make the anchor the single authority so
        # a stale duplicate location cannot create two competing truths.
        normalized = normalize_producer_issue_payload(payload)
        if not isinstance(normalized, dict):
            return normalized

    anchor_raw = normalized.get("primary_anchor")
    try:
        anchor = SourceAnchor.model_validate(anchor_raw)
    except Exception:  # noqa: BLE001
        # Keep the malformed value for the normal validation error, while
        # making the missing compatibility field explicit if possible.
        normalized.setdefault("location", "")
    else:
        normalized["primary_anchor"] = anchor.model_dump(mode="json")
        # ``primary_anchor`` is the only location authority for structured
        # payloads, including the compatibility envelope.
        normalized["location"] = anchor.location

    if not model_shape:
        return normalized

    supports = normalized.get("supports")
    if not isinstance(supports, list):
        return normalized
    role_fields = {
        "cause": "cause_evidence",
        "contract": "contract_evidence",
        "trigger": "trigger_evidence",
        "impact": "impact_evidence",
    }
    catalog = _evidence_catalog_by_reference(evidence_catalog or [])
    catalog_status = _evidence_catalog_reference_status(evidence_catalog or [])
    for evidence_field in role_fields.values():
        normalized[evidence_field] = []
    for support in supports:
        if not isinstance(support, dict):
            continue
        role = str(support.get("role", "")).strip()
        field = role_fields.get(role)
        if field is None:
            continue
        statement = str(support.get("statement", "")).strip()
        refs = support.get("evidence_refs", [])
        if not isinstance(refs, list):
            continue
        for raw_ref in refs:
            reference = str(raw_ref or "").strip()
            if not reference:
                continue
            record = catalog.get(reference)
            normalized[field].append(
                _evidence_payload_from_catalog_record(
                    record,
                    reference=reference,
                    statement=statement,
                    resolution_status=(
                        "resolved"
                        if record is not None
                        else catalog_status.get(reference, "unresolved")
                    ),
                )
            )
    return normalized


def _evidence_catalog_by_reference(
    catalog: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Index only unambiguous exact delivered evidence ids and aliases."""

    candidates: dict[str, list[dict[str, Any]]] = {}
    for raw in catalog:
        if not isinstance(raw, dict):
            continue
        # The model-facing catalog is a proof boundary.  Indexed/selected
        # spans and clipped bodies may be useful planner metadata, but they
        # are not delivered evidence and must not become bindable by alias.
        if str(raw.get("lifecycle", "delivered")).strip() != "delivered":
            continue
        if bool(raw.get("truncated", False)):
            continue
        ids = [
            str(raw.get("evidence_id", "")).strip(),
            str(raw.get("artifact_id", "")).strip(),
        ]
        aliases = raw.get("aliases", [])
        if isinstance(aliases, list):
            ids.extend(str(item).strip() for item in aliases)
        for reference in {item for item in ids if item}:
            candidates.setdefault(reference, []).append(raw)
    return {
        reference: records[0]
        for reference, records in candidates.items()
        if len(records) == 1
    }


def _evidence_catalog_reference_status(
    catalog: list[dict[str, Any]],
) -> dict[str, str]:
    """Classify exact references without making non-delivered records citable."""

    candidates: dict[str, list[dict[str, Any]]] = {}
    for raw in catalog:
        if not isinstance(raw, dict):
            continue
        ids = [
            str(raw.get("evidence_id", "")).strip(),
            str(raw.get("artifact_id", "")).strip(),
        ]
        aliases = raw.get("aliases", [])
        if isinstance(aliases, list):
            ids.extend(str(item).strip() for item in aliases)
        for reference in {item for item in ids if item}:
            candidates.setdefault(reference, []).append(raw)
    status: dict[str, str] = {}
    for reference, records in candidates.items():
        delivered = [
            item
            for item in records
            if str(item.get("lifecycle", "delivered")).strip() == "delivered"
            and not bool(item.get("truncated", False))
        ]
        if len(delivered) == 1 and len(records) == 1:
            status[reference] = "resolved"
        elif delivered:
            status[reference] = "ambiguous"
        else:
            status[reference] = "undelivered"
    return status


def _evidence_payload_from_catalog_record(
    record: dict[str, Any] | None,
    *,
    reference: str,
    statement: str,
    resolution_status: str = "resolved",
) -> dict[str, Any]:
    """Convert a delivered ledger record, or an unknown ref, without guessing."""

    if not isinstance(record, dict):
        return {
            # Keep the requested token in the compatibility envelope for old
            # diagnostics, but resolution_status makes it explicitly
            # non-trusted and prevents binding/identity validation from using
            # it as an artifact.
            "artifact_id": reference,
            "evidence_id": "",
            "reference_id": reference,
            "resolution_status": resolution_status or "unresolved",
            "retrieval_source": "",
            "statement": statement,
        }
    scope = str(record.get("scope", "")).strip()
    aliases = record.get("aliases", [])
    manifest_id = ""
    if scope == "context_manifest" and isinstance(aliases, list):
        manifest_id = next(
            (
                str(item).strip()
                for item in aliases
                if str(item).strip() != str(record.get("artifact_id", "")).strip()
            ),
            "",
        )
    return {
        "artifact_id": str(record.get("artifact_id", reference)).strip() or reference,
        "evidence_id": str(record.get("evidence_id", "")).strip(),
        "reference_id": reference,
        "resolution_status": resolution_status or "resolved",
        "snapshot_id": str(record.get("snapshot_id", "")).strip(),
        "revision": str(record.get("revision", "")).strip(),
        "side": str(record.get("side", "new") or "new"),
        "context_manifest_id": manifest_id,
        "retrieval_source": str(
            record.get("source_type", record.get("retrieval_source", ""))
        ).strip(),
        "file": str(record.get("path", record.get("file", ""))).strip(),
        "line": record.get("start_line", record.get("line")),
        "end_line": record.get("end_line", record.get("line")),
        "context_hash": (
            str(record.get("content_hash", record.get("body_hash", ""))).strip()
            if scope == "context_manifest"
            else ""
        ),
        "statement": statement,
    }


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

    if evidence.evidence_id:
        return evidence.evidence_id
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
    require_runtime_identity: bool = True,
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
        if require_runtime_identity and not issue.finding_id.strip():
            gaps.append(
                FindingContractGap(
                    "finding_contract_incomplete",
                    "finding_id",
                    "Structured risk finding is missing finding_id.",
                )
            )
        for field in STRUCTURED_RISK_NARRATIVE_FIELDS:
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
    required_roles = set(STRUCTURED_RISK_REQUIRED_ROLES)
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
            unresolved_refs = {
                str(item.reference_id).strip()
                for item in role_values.get(support.role, [])
                if str(item.reference_id).strip()
                and str(item.resolution_status).strip()
                in {"unresolved", "ambiguous", "undelivered"}
            }
            unresolved_selected = set(support.evidence_refs).intersection(
                unresolved_refs
            )
            gaps.append(
                FindingContractGap(
                    "support_reference_unresolved"
                    if unresolved_selected
                    else "support_reference_missing",
                    f"supports[{index}].evidence_refs",
                    (
                        "Support references identify evidence that was not delivered "
                        "or could not be resolved in this run."
                        if unresolved_selected
                        else "Support references do not identify a declared evidence item."
                    ),
                    invalid=not bool(unresolved_selected),
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
            evidence.evidence_id,
            evidence.location,
            evidence.context_hash,
            evidence.context_manifest_id,
            evidence.artifact_id,
            evidence.reference_id
            if evidence.resolution_status == "resolved"
            else "",
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
