"""Analyzer-layer schemas for CLI and orchestrator integration."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from src.analyzer.context_state import ContextState
from src.analyzer.output_formatter import ReviewIssue, ReviewReport
from src.models.schemas import DraftFindingInput, DraftFindingUpdateInput

ReviewOutcome = Literal[
    "no_candidates",
    "accepted",
    "partially_rejected",
    "all_candidates_rejected",
]
AnalysisAction = Literal["exploration", "state", "completion"]
EXPLORATION_TOOL_NAMES = frozenset(
    {
        "read_file",
        "grep_files",
        "glob_files",
        "list_dir",
        "get_changed_context",
        "changed_context",
        "find_symbol_context",
        "symbol_context",
    }
)


class ReviewRequest(BaseModel):
    """Structured input for a review run."""

    repo_path: str = Field(
        ...,
        description="Target repository or directory path",
    )
    diff_mode: bool = Field(
        default=False,
        description="Whether to run in diff mode",
    )
    diff_text: str | None = Field(
        default=None,
        description="Optional diff text input",
    )
    model_name: str | None = Field(
        default=None,
        description="Model override from CLI",
    )
    verbose: bool = Field(
        default=False,
        description="Whether verbose output is enabled",
    )


class DebugRequest(BaseModel):
    """Structured input for a debug run."""

    repo_path: str = Field(
        ...,
        description="Target repository or directory path",
    )
    error_log_path: str | None = Field(
        default=None,
        description="Optional error log path",
    )
    error_log_text: str | None = Field(
        default=None,
        description="Optional error log content",
    )
    model_name: str | None = Field(
        default=None,
        description="Model override from CLI",
    )
    verbose: bool = Field(
        default=False,
        description="Whether verbose output is enabled",
    )


class ReviewResponse(BaseModel):
    """Structured output for a review run."""

    run_id: str = Field(
        ...,
        description="Unique identifier for the current run",
    )
    report: ReviewReport = Field(
        ...,
        description="Structured review report",
    )
    context: ContextState = Field(
        ...,
        description="Session context for audit and debugging",
    )
    workflow_invalid: bool = Field(
        default=False,
        description="Whether required review workflow steps remained incomplete.",
    )
    workflow_missing_steps: list[str] = Field(
        default_factory=list,
        description="Required workflow steps that remained incomplete.",
    )
    review_outcome: ReviewOutcome = Field(
        default="no_candidates",
        description="Verifier outcome independent of workflow validity.",
    )
    completion_status: Literal["complete", "incomplete"] = Field(
        default="complete",
        description="Whether the review completed all required evidence checks.",
    )
    incomplete_reasons: list[str] = Field(
        default_factory=list,
        description="Structured reasons a review could not be completed safely.",
    )
    investigation_ready: bool = Field(
        default=False,
        description="Investigation reached a state where submission was allowed.",
    )
    submission_received: bool = Field(
        default=False,
        description="A valid submit_review action was actually received.",
    )
    review_complete: bool = Field(
        default=False,
        description=(
            "Final review verification ran; this does not assert every finding "
            "was publishable."
        ),
    )

    def model_dump(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        """Keep the complete v0 response envelope compact for old consumers.

        The new completion fields are emitted when a run has a meaningful
        lifecycle state. A direct legacy formatter call with all flags false
        keeps the historical serialized key set, while a completed run keeps
        its positive readiness/submission/completion evidence for API and eval
        consumers.
        """

        dumped = super().model_dump(*args, **kwargs)
        if self.completion_status == "complete" and not self.incomplete_reasons:
            dumped.pop("completion_status", None)
            dumped.pop("incomplete_reasons", None)
            if not any(
                (
                    self.investigation_ready,
                    self.submission_received,
                    self.review_complete,
                )
            ):
                dumped.pop("investigation_ready", None)
                dumped.pop("submission_received", None)
                dumped.pop("review_complete", None)
        return dumped


class ReviewHandoff(BaseModel):
    """Minimal evidence-preserving state passed into a submit-only turn."""

    changed_diff: str = ""
    file_contents: dict[str, str] = Field(default_factory=dict)
    candidate_context_manifests: list[dict[str, Any]] = Field(default_factory=list)
    evidence_ledger: list[dict[str, Any]] = Field(default_factory=list)
    evidence_gaps: list[str] = Field(default_factory=list)
    has_draft_findings: bool = False


class DebugStep(BaseModel):
    """A single debug step in the structured debug response."""

    title: str = Field(
        ...,
        description="Short title for the debug step",
    )
    detail: str = Field(
        ...,
        description="Detailed explanation of the step",
    )
    location: str = Field(
        default="",
        description="Relevant file location or code reference",
    )
    evidence: str = Field(
        default="",
        description="Evidence supporting this step",
    )
    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Confidence score",
    )


class SuggestedCommand(BaseModel):
    """A suggested command that the user may choose to run."""

    command: str = Field(
        ...,
        description="Suggested shell command",
    )
    rationale: str = Field(
        ...,
        description="Why this command is suggested",
    )
    risk: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Risk level of the suggested command",
    )


class DebugResponse(BaseModel):
    """Structured output for a debug run."""

    run_id: str = Field(
        ...,
        description="Unique identifier for the current run",
    )
    summary: str = Field(
        ...,
        description="High-level debug summary",
    )
    hypotheses: list[str] = Field(
        default_factory=list,
        description="Candidate root-cause hypotheses",
    )
    steps: list[DebugStep] = Field(
        default_factory=list,
        description="Suggested debug steps",
    )
    suggested_commands: list[SuggestedCommand] = Field(
        default_factory=list,
        description="Commands suggested for manual execution",
    )
    suggested_patch: str | None = Field(
        default=None,
        description="Optional suggested patch",
    )
    context: ContextState = Field(
        ...,
        description="Session context for audit and debugging",
    )


class AnalysisPlan(BaseModel):
    """Structured plan produced by the analyze phase."""

    source_response_id: str = Field(
        default="",
        description="Durable run-journal id of the model response behind this plan",
    )
    draft_finding_source_response_id: str = Field(
        default="",
        description="Trusted originating response id for draft-finding pseudo-calls",
    )
    needs_tools: bool = Field(
        default=False,
        description="Whether tool execution is required in this iteration",
    )
    tool_calls: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Raw tool-call payloads parsed from model output",
    )
    draft_finding_calls: list[DraftFindingInput] = Field(
        default_factory=list,
        description="Validated minimal draft-finding pseudo-tool inputs",
    )
    draft_finding_updates: list[DraftFindingUpdateInput] = Field(
        default_factory=list,
        description="Validated state transitions for already-recorded hypotheses",
    )
    draft_review: ReviewReport | None = Field(
        default=None,
        description="Optional draft review result produced by model",
    )
    draft_debug: DebugResponse | None = Field(
        default=None,
        description="Optional draft debug result produced by model",
    )
    incomplete_reason: str = Field(
        default="",
        description="Reason the model response was unusable for a trusted final result.",
    )
    recovery_required: bool = Field(
        default=False,
        description="Whether a truncated response without valid submit needs recovery",
    )
    schema_repair_attempted_count: int = Field(
        default=0,
        ge=0,
        description="Schema-validation repair attempts consumed by this plan",
    )
    model_finish_reason: str = Field(
        default="",
        description="Provider finish reason retained for runtime and funnel telemetry.",
    )
    final_submit_evidence_included_count: int = Field(
        default=0,
        ge=0,
        description="Number of deduplicated evidence entries retained for final submit.",
    )
    final_submit_evidence_token_count: int = Field(
        default=0,
        ge=0,
        description="Estimated tokens used by the bounded final-submit evidence digest.",
    )
    final_submit_evidence_truncated_count: int = Field(
        default=0,
        ge=0,
        description="Evidence entries omitted or shortened to respect the digest budget.",
    )

    @property
    def has_explicit_submit(self) -> bool:
        """Whether the model produced a valid completion action this turn."""

        return self.draft_review is not None or self.draft_debug is not None

    @property
    def has_state_action(self) -> bool:
        """Whether this turn changed or recorded durable investigation state."""

        return bool(self.draft_finding_calls or self.draft_finding_updates)

    @property
    def has_exploration_action(self) -> bool:
        """Whether this turn requested an ordinary exploratory tool."""

        return any(
            isinstance(call.get("function"), dict)
            and str(call["function"].get("name", "")).strip()
            in EXPLORATION_TOOL_NAMES
            for call in self.tool_calls
            if isinstance(call, dict)
        )

    @property
    def action_kinds(self) -> tuple[AnalysisAction, ...]:
        """Return the distinct semantic action kinds present in this plan."""

        kinds: list[AnalysisAction] = []
        if self.has_exploration_action:
            kinds.append("exploration")
        if self.has_state_action:
            kinds.append("state")
        if self.has_explicit_submit:
            kinds.append("completion")
        return tuple(kinds)


class FindingCandidate(BaseModel):
    """One risk finding awaiting objective integrity validation."""

    candidate_id: str
    logical_identity_hash: str = Field(
        default="",
        description=(
            "Stable logical identity metadata; independent from mutable finding text "
            "and from the runtime candidate id."
        ),
    )
    content_hash: str = Field(
        default="",
        description="Version hash of the candidate content at registration time.",
    )
    candidate_content_version: str = Field(
        default="",
        description=(
            "Runtime-owned mutable content version used to bind a repair response. "
            "It is distinct from candidate_id and repository revision."
        ),
    )
    issue: ReviewIssue
    claim: str
    evidence_locations: list[str] = Field(default_factory=list)
    originating_iteration: int = Field(ge=0)
    source_issue_index: int = Field(default=0, ge=0)
    verification_status: Literal[
        "pending",
        "accepted",
        "rejected",
        "verification_blocked",
        "verified",
        "needs_repair",
        "invalid",
    ] = "pending"
    integrity_status: Literal["pending", "verified", "needs_repair", "invalid"] = (
        "pending"
    )
