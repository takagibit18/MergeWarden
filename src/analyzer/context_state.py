"""Structured state management for review / debug sessions.

Tracks the evolving context — goal, constraints, decisions, files under
inspection, and accumulated errors — so that the agent loop and tools can
make informed decisions at each phase.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from src.analyzer.context_mode import ReviewContextMode
from src.models.schemas import DraftFindingState


class DecisionStep(BaseModel):
    """A single reasoning or decision record within a session."""

    phase: str = Field(..., description="Which agent phase produced this decision")
    action: str = Field(..., description="What was decided or executed")
    result: str = Field(default="", description="Outcome or observation")


class ErrorDetail(BaseModel):
    """Structured representation of an error encountered during analysis."""

    file: str = Field(default="", description="File path where the error relates to")
    line: int | None = Field(default=None, description="Line number, if applicable")
    message: str = Field(..., description="Human-readable error description")
    category: str = Field(
        default="unknown",
        description="Error category: syntax | runtime | logic | style | security",
    )


class ContextState(BaseModel):
    """Session-wide mutable state shared across agent phases.

    The orchestrator creates one instance per run and passes it through
    every phase so that tools and the inference engine can read / update it.
    """

    goal: str = Field(default="", description="Current review or debug objective")
    context_mode: ReviewContextMode = Field(
        default="graph_hybrid",
        description="Explicit context strategy selected for this review.",
    )
    constraints: list[str] = Field(
        default_factory=list, description="Active constraints for this run"
    )
    decisions: list[DecisionStep] = Field(
        default_factory=list, description="Decision history"
    )
    current_files: list[str] = Field(
        default_factory=list, description="Files currently under inspection"
    )
    errors: list[ErrorDetail] = Field(
        default_factory=list, description="Errors discovered so far"
    )
    candidate_context_manifests: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Budgeted context manifests that are actually sent to the reviewer.",
    )
    evidence_snapshot_id: str = Field(
        default="",
        description="System-owned snapshot identity for delivered source evidence.",
    )
    evidence_revision: str = Field(
        default="",
        description="System-owned repository revision identity for delivered evidence.",
    )
    evidence_ledger: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Exact source ranges delivered to the reviewer; index-only graph entries "
            "are intentionally excluded."
        ),
    )
    candidate_registrations: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Runtime-owned candidate identities and content versions used for replay; "
            "model-authored draft or graph ids are not authoritative here."
        ),
    )
    repair_transactions: list[dict[str, Any]] = Field(
        default_factory=list,
        description=(
            "Bounded repair transaction facts, including target versions, executed "
            "steps, budget, and per-target disposition."
        ),
    )
    draft_findings: list[DraftFindingState] = Field(
        default_factory=list,
        description=(
            "Explicit investigation checkpoints for durable draft hypotheses. "
            "A pending draft is not a final finding."
        ),
    )
    relation_graph_summary: dict[str, object] = Field(
        default_factory=dict,
        description="Non-source telemetry for the change-centred code graph/index.",
    )
