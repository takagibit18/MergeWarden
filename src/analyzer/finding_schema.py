"""Typed finding-hypothesis and evidence-provenance primitives.

The public :class:`~src.analyzer.output_formatter.ReviewIssue` keeps the v0.2.2
fields for compatibility and embeds these v0.2.3 fields.  Keeping the small
types in this module avoids coupling graph, verifier, and publisher layers.
"""

from __future__ import annotations

import hashlib
from typing import Literal

from pydantic import BaseModel, Field, model_validator


FINDING_SCHEMA_VERSION = "2.0"
CounterfactualResult = Literal["yes", "no", "uncertain"]
EvidenceEligibility = Literal["strong", "exploratory", "none"]
EvidenceRole = Literal["cause", "contract", "trigger", "impact", "related"]
EvidenceSide = Literal["old", "new", "context", "unknown"]
FindingSeverity = Literal["critical", "warning", "info", "style"]


class SourceAnchor(BaseModel):
    """A repository-relative source location with optional symbol identity."""

    file: str = Field(min_length=1)
    line: int = Field(ge=1)
    end_line: int | None = Field(default=None, ge=1)
    symbol_id: str = ""

    @model_validator(mode="after")
    def _ordered_span(self) -> "SourceAnchor":
        if self.end_line is not None and self.end_line < self.line:
            raise ValueError("end_line must be greater than or equal to line")
        self.file = normalize_repo_path(self.file)
        return self

    @property
    def location(self) -> str:
        suffix = str(self.line)
        if self.end_line is not None and self.end_line != self.line:
            suffix += f"-{self.end_line}"
        return f"{self.file}:{suffix}"


class RelatedLocation(SourceAnchor):
    """A secondary location participating in the same independent repair unit."""

    role: EvidenceRole = "related"
    description: str = ""


class RepairIntent(BaseModel):
    """Minimal repair signature proposed by the reviewer."""

    action: str = ""
    targets: list[str] = Field(default_factory=list)
    boundary: str = ""

    def normalized_targets(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    normalize_semantic_token(value)
                    for value in self.targets
                    if normalize_semantic_token(value)
                }
            )
        )


class ClaimSupport(BaseModel):
    """One role-specific claim backed by shared evidence references."""

    role: EvidenceRole
    statement: str = Field(min_length=1)
    evidence_refs: list[str] = Field(min_length=1)


class FindingDraft(BaseModel):
    """Canonical internal finding contract shared by parser and verifier."""

    finding_id: str = Field(min_length=1)
    schema_version: Literal["2.0"] = "2.0"
    severity: FindingSeverity
    confidence: float = Field(ge=0.0, le=1.0)
    primary_anchor: SourceAnchor
    observed_behavior: str = Field(min_length=1)
    causal_mechanism: str = Field(min_length=1)
    violated_invariant: str = Field(min_length=1)
    repair_intent: RepairIntent
    trigger: str = Field(min_length=1)
    impact: str = Field(min_length=1)
    supports: list[ClaimSupport] = Field(min_length=1)

    @model_validator(mode="after")
    def _unique_support_roles(self) -> "FindingDraft":
        """Reject duplicate role envelopes before runtime evidence binding."""

        roles = [item.role for item in self.supports]
        if len(roles) != len(set(roles)):
            raise ValueError("supports must contain at most one envelope per role")
        return self


class EvidenceProvenance(BaseModel):
    """One evidence claim whose provenance is canonically bound by the runtime."""

    candidate_id: str = Field(
        default="",
        description="System-owned candidate identity; model input is overwritten.",
    )
    artifact_id: str = Field(
        default="",
        description="System-owned delivered-source artifact identity.",
    )
    evidence_id: str = Field(
        default="",
        description=(
            "Single model-facing evidence identity selected from the delivered "
            "catalog; never a Graph span, candidate id, content hash, or revision."
        ),
    )
    reference_id: str = Field(
        default="",
        description=(
            "Model-selected evidence reference retained for unresolved or aliased "
            "catalog lookups; it is not a trusted artifact identity."
        ),
    )
    resolution_status: str = Field(
        default="resolved",
        description=(
            "Evidence reference resolution state: resolved, unresolved, "
            "ambiguous, or undelivered."
        ),
    )
    snapshot_id: str = Field(
        default="",
        description="System-owned repository snapshot identity.",
    )
    revision: str = Field(
        default="",
        description="System-owned repository/index revision identity.",
    )
    side: EvidenceSide = Field(
        default="new",
        description="Source side used for the citation: new, old, or context.",
    )
    context_manifest_id: str = Field(
        default="",
        description="System-owned manifest identity; explicit legacy input must match.",
    )
    retrieval_source: str = Field(
        default="reviewer_context",
        description="System-selected trusted diff/read/symbol/manifest source.",
    )
    file: str = ""
    line: int | None = Field(default=None, ge=1)
    end_line: int | None = Field(default=None, ge=1)
    symbol_id: str = ""
    context_hash: str = Field(
        default="",
        description="System-bound canonical hash for manifest evidence.",
    )
    edge_kind: str = ""
    edge_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    resolver: str = ""
    evidence_eligibility: EvidenceEligibility = "strong"
    statement: str = ""

    @model_validator(mode="after")
    def _normalize(self) -> "EvidenceProvenance":
        if self.file:
            self.file = normalize_repo_path(self.file)
        if (
            self.line is not None
            and self.end_line is not None
            and self.end_line < self.line
        ):
            raise ValueError("evidence end_line must be >= line")
        return self

    @property
    def location(self) -> str:
        if not self.file or self.line is None:
            return ""
        suffix = str(self.line)
        if self.end_line is not None and self.end_line != self.line:
            suffix += f"-{self.end_line}"
        return f"{self.file}:{suffix}"


def normalize_repo_path(value: str) -> str:
    """Normalize a model-provided repository path without resolving it on disk."""

    path = str(value or "").strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path.startswith(("a/", "b/")):
        path = path[2:]
    return path


def normalize_semantic_token(value: str) -> str:
    """Stable conservative normalization for repair/invariant comparisons."""

    return " ".join(str(value or "").strip().lower().replace("_", " ").split())


def context_hash(content: str) -> str:
    """Return the canonical SHA-256 digest used by context manifests."""

    return hashlib.sha256(content.encode("utf-8")).hexdigest()
