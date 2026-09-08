"""Read-only deterministic validator for candidate review drafts."""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field

from src.analyzer.finding_contract import (
    canonical_contract_gaps,
    ModelFindingInput,
    normalize_model_finding_payload,
    normalize_producer_issue_payload,
)
from src.analyzer.finding_schema import (
    ClaimSupport,
    EvidenceProvenance,
    RelatedLocation,
    RepairIntent,
    SourceAnchor,
)
from src.analyzer.location import normalize_location
from src.analyzer.output_formatter import (
    ReviewIssue,
    Severity,
    has_specific_code_evidence,
)
from src.analyzer.review_policy import (
    MIN_CRITICAL_CONFIDENCE,
    MIN_RISK_WARNING_CONFIDENCE,
    MIN_WARNING_CONFIDENCE,
    evaluate_issue_filter,
)
from src.tools.base import BaseTool, ToolSafety, ToolSpec
from src.tools.review_context import ReviewToolContext


_SUMMARY_RISK_PATTERN = re.compile(
    r"\b(bug|regression|breaking|breaks?|compatibility|user-visible|risk)\b",
    re.IGNORECASE,
)


class ReviewDraftIssueInput(BaseModel):
    """Candidate review issue submitted by the model for policy feedback."""

    severity: Severity
    location: str = ""
    evidence: str
    suggestion: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    schema_version: str | None = Field(
        default=None,
        description="Use 2.0 for a structured finding hypothesis; omit for legacy policy-only validation.",
    )
    finding_id: str = ""
    target_candidate_id: str = Field(
        default="",
        description=(
            "Repair-only exact runtime candidate_id from candidate_repair_feedback; "
            "never use finding_id, text, or position as a repair selector."
        ),
    )
    primary_anchor: SourceAnchor | None = None
    related_locations: list[RelatedLocation] = Field(default_factory=list)
    observed_behavior: str = ""
    causal_mechanism: str = ""
    violated_invariant: str = ""
    repair_intent: RepairIntent = Field(default_factory=RepairIntent)
    trigger: str = ""
    impact: str = ""
    supports: list[ClaimSupport] = Field(default_factory=list)
    cause_evidence: list[EvidenceProvenance] = Field(
        default_factory=list,
        description=(
            "Role-specific causal evidence; supporting locations may be unchanged "
            "when they were actually observed by the reviewer."
        ),
    )
    contract_evidence: list[EvidenceProvenance] = Field(default_factory=list)
    trigger_evidence: list[EvidenceProvenance] = Field(default_factory=list)
    impact_evidence: list[EvidenceProvenance] = Field(default_factory=list)


class ValidateReviewDraftInput(BaseModel):
    """Validated input for review draft validation."""

    summary: str = Field(
        default="",
        description="Your candidate review summary text; the tool checks whether it "
        "mentions bug, regression, or breaking-change keywords without a corresponding "
        "issue that passes the output filter",
    )
    issues: list[ReviewDraftIssueInput] = Field(
        default_factory=list,
        description="The list of candidate issues you plan to include in submit_review; "
        "pass every issue here first so the tool can validate each one before submission",
    )
    draft_ids: list[str] = Field(
        default_factory=list,
        description="Optional runtime draft ids represented by this candidate payload",
    )


class ValidateReviewDraftTool(BaseTool):
    """Provide deterministic policy feedback for a candidate ReviewReport."""

    def __init__(self, review_context: ReviewToolContext) -> None:
        self._context = review_context

    def spec(self) -> ToolSpec:
        """Return the LLM-facing tool specification."""
        # Keep this policy-only tool on the same model-facing contract as
        # submit_review.  Pydantic emits nested ``$ref`` definitions here;
        # inline them before handing the schema to a provider so the validator
        # does not accidentally expose a different, partially legacy shape.
        from src.orchestrator.tool_schemas import _inline_json_schema_refs

        model_issue_schema = _inline_json_schema_refs(
            ModelFindingInput.model_json_schema()
        )
        model_issue_schema["additionalProperties"] = False
        return ToolSpec(
            name="validate_review_draft",
            description=(
                "Check your candidate review issues against output policy before calling "
                "submit_review. For each issue, this tool verifies: whether the location "
                "uses the correct canonical file path format, whether warning/critical "
                "contains a finding anchor on code changed by this PR, whether the "
                "evidence contains concrete code or diff snippets, and whether confidence "
                "meets the threshold "
                "for the chosen severity level. Use this BEFORE submit_review — it gives "
                "you deterministic policy feedback so you can fix location formatting "
                "errors, gather missing evidence, recalibrate severity/confidence, and drop "
                "issues that would not pass the output filter. Never raise confidence merely "
                "to cross a threshold. This tool only validates policy compliance; "
                "it does not judge whether your analysis is semantically correct and it "
                "does not replace submit_review."
            ),
            parameters={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "summary": {"type": "string"},
                    "issues": {
                        "type": "array",
                        "items": model_issue_schema,
                    },
                    "draft_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                    },
                },
                "required": ["issues"],
            },
            safety=ToolSafety.READONLY,
        )

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        """Return deterministic validation feedback for a candidate draft."""
        data = ValidateReviewDraftInput(**kwargs)
        issue_results = [
            self._validate_issue(index, issue)
            for index, issue in enumerate(data.issues)
        ]
        effective_issue_count = sum(
            1 for item in issue_results if item["passes_submit_preflight"]
        )
        summary = data.summary.strip()
        summary_warnings: list[str] = []
        risky_summary = _SUMMARY_RISK_PATTERN.search(summary) is not None
        if risky_summary and effective_issue_count == 0:
            summary_warnings.append(
                "summary mentions bug/regression/breaking/user-visible risk but no issue passes current filter"
            )
        return {
            "normalized_summary": summary,
            "issue_results": issue_results,
            "summary_warnings": summary_warnings,
            "effective_issue_count": effective_issue_count,
            "should_submit_empty_issues": effective_issue_count == 0
            and not summary_warnings,
            "validated_draft_ids": list(data.draft_ids),
            "validated_finding_ids": [],
            "unresolved_evidence_gaps": [
                reason
                for item in issue_results
                for reason in [
                    *item.get("fail_reasons", []),
                    *item.get("contract_gap_codes", []),
                ]
            ],
            "policy_warnings": list(summary_warnings),
            "validator_passed": bool(
                not summary_warnings
                and all(item["passes_submit_preflight"] for item in issue_results)
                and (
                    effective_issue_count > 0
                    or (effective_issue_count == 0 and not summary_warnings)
                )
            ),
            "submit_allowed": bool(
                not summary_warnings
                and all(item["passes_submit_preflight"] for item in issue_results)
            ),
        }

    def _validate_issue(
        self, index: int, input_issue: ReviewDraftIssueInput
    ) -> dict[str, Any]:
        issue_payload = normalize_model_finding_payload(
            input_issue.model_dump(exclude_unset=True)
        )
        issue_payload = normalize_producer_issue_payload(issue_payload)
        issue_payload.setdefault("schema_version", "1.0")
        issue = ReviewIssue(
            **issue_payload,
        )
        location = normalize_location(issue.location)
        evidence_specific = has_specific_code_evidence(issue.evidence)
        filter_decision = evaluate_issue_filter(issue)
        passes_output_filter = filter_decision.passed
        location_on_changed_line = self._location_on_changed_line(
            location.path,
            location.line,
            location.end_line,
        )
        pr_causal_anchor_on_changed_line = any(
            self._location_on_changed_line(
                evidence.file,
                evidence.line,
                evidence.end_line,
            )
            for evidence in issue.cause_evidence
        )
        causality_required = issue.severity in {
            Severity.CRITICAL,
            Severity.WARNING,
        }
        changed_anchor_present = (
            location_on_changed_line or pr_causal_anchor_on_changed_line
        )
        passes_causality = not causality_required or changed_anchor_present
        passes_filter = passes_output_filter and passes_causality
        contract_gaps = canonical_contract_gaps(
            issue,
            strict=issue.is_structured_hypothesis
            and issue.severity in {Severity.CRITICAL, Severity.WARNING},
        )
        passes_contract = not contract_gaps
        passes_submit_preflight = passes_filter and passes_contract
        fail_reasons: list[str] = []
        repair_hints: list[str] = []

        if not location.valid:
            fail_reasons.append(location.warning or "invalid_location")
            repair_hints.append("use canonical path[:line[-end_line]] location")
        elif location.warning:
            repair_hints.append(f"use canonical location {location.canonical}")

        if causality_required and not changed_anchor_present:
            fail_reasons.append("changed_anchor_missing")
            repair_hints.append(
                "cite at least one real changed line as the finding anchor; supporting "
                "cause_evidence may remain on unchanged code"
            )

        if issue.severity == Severity.CRITICAL:
            if issue.confidence < MIN_CRITICAL_CONFIDENCE:
                fail_reasons.append("confidence_below_critical_threshold")
                repair_hints.append(
                    "gather stronger evidence or lower severity; do not inflate confidence "
                    "to cross 0.85"
                )
            if not evidence_specific:
                fail_reasons.append("evidence_not_specific")
                repair_hints.append("add concrete diff or code evidence")
        elif issue.severity == Severity.WARNING and not passes_output_filter:
            if issue.confidence < MIN_RISK_WARNING_CONFIDENCE:
                fail_reasons.append("confidence_below_warning_threshold")
                repair_hints.append(
                    "gather stronger evidence or keep the concern non-risk; do not inflate "
                    "confidence"
                )
            elif issue.confidence < MIN_WARNING_CONFIDENCE:
                fail_reasons.append("warning_lacks_specific_risk_evidence")
                repair_hints.append(
                    "add concrete diff evidence and describe the user-visible risk"
                )
            if not evidence_specific:
                fail_reasons.append("evidence_not_specific")
                repair_hints.append("add concrete diff or code evidence")
            repair_hints.append(
                "lower severity to info/style or remove issue if evidence is speculative"
            )

        for gap in contract_gaps:
            fail_reasons.append(gap.code)
            repair_hints.append(gap.message)

        return {
            "original_index": index,
            "normalized_location": location.canonical,
            "severity": issue.severity.value,
            "confidence": issue.confidence,
            "location_valid": location.valid,
            "location_on_changed_line": location_on_changed_line,
            "pr_causal_anchor_on_changed_line": pr_causal_anchor_on_changed_line,
            "changed_anchor_present": changed_anchor_present,
            "evidence_specific": evidence_specific,
            "passes_current_filter": passes_filter,
            "passes_contract": passes_contract,
            "passes_submit_preflight": passes_submit_preflight,
            "contract_status": "valid" if passes_contract else "needs_repair",
            "contract_gaps": [gap.as_dict() for gap in contract_gaps],
            "contract_gap_codes": list(dict.fromkeys(gap.code for gap in contract_gaps)),
            "filter_reason_codes": list(filter_decision.reason_codes),
            "standard_threshold": filter_decision.standard_threshold,
            "relaxed_threshold": filter_decision.relaxed_threshold,
            "risk_pattern_matched": filter_decision.risk_pattern_matched,
            "fail_reasons": list(dict.fromkeys(fail_reasons)),
            "repair_hints": list(dict.fromkeys(repair_hints)),
        }

    def _location_on_changed_line(
        self,
        path: str | None,
        line: int | None,
        end_line: int | None,
    ) -> bool:
        if path is None or line is None:
            return False
        changed_lines = self._context.changed_lines_by_file.get(path, set())
        if not changed_lines:
            return False
        last_line = end_line or line
        return any(
            candidate in changed_lines for candidate in range(line, last_line + 1)
        )
