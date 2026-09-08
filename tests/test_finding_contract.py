"""Regression coverage for the producer-to-canonical finding contract seam."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import cast

from src.analyzer.finding_contract import canonical_contract_gaps
from src.analyzer.finding_schema import EvidenceProvenance
from src.analyzer.inference_engine import InferenceEngine
from src.analyzer.output_formatter import ReviewIssue, ReviewReport
from src.tools.review_context import ReviewToolContext
from src.tools.review_draft_validator_tool import ValidateReviewDraftTool


def _structured_payload(schema_version: str | None = None) -> dict[str, object]:
    issue: dict[str, object] = {
        "severity": "warning",
        "finding_id": "F-structured",
        "location": "src/app.py:2",
        "evidence": "+ return new_value",
        "suggestion": "Preserve the caller contract.",
        "confidence": 0.95,
        "primary_anchor": {"file": "src/app.py", "line": 2},
        "observed_behavior": "The returned value changes.",
        "causal_mechanism": "The changed producer returns a different value.",
        "violated_invariant": "Callers receive the established value.",
        "repair_intent": {"action": "Restore the established return value."},
        "trigger": "A caller invokes the changed branch.",
        "impact": "The caller observes an incompatible value.",
    }
    if schema_version is not None:
        issue["schema_version"] = schema_version
    return {"summary": "A structured finding.", "issues": [issue]}


def _tool_context(tmp_path: Path) -> ReviewToolContext:
    diff = (
        "diff --git a/src/app.py b/src/app.py\n"
        "--- a/src/app.py\n"
        "+++ b/src/app.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def run():\n"
        "-    return old_value\n"
        "+    return new_value\n"
    )
    return ReviewToolContext.from_diff(tmp_path, diff)


def test_structured_producer_payload_cannot_fall_back_to_schema_1() -> None:
    for schema_version in (None, "1.0"):
        normalized, _ = InferenceEngine._normalize_review_payload(
            _structured_payload(schema_version)
        )
        report = InferenceEngine._normalize_structured_report(
            ReviewReport.model_validate(normalized)
        )

        issue = report.issues[0]
        assert issue.schema_version == "2.0"
        assert issue.is_structured_hypothesis is True
        assert canonical_contract_gaps(issue, strict=True)


def test_validator_reports_structured_missing_roles_without_schema_version(
    tmp_path: Path,
) -> None:
    tool = ValidateReviewDraftTool(_tool_context(tmp_path))
    issue = dict(cast(list[dict[str, object]], _structured_payload()["issues"])[0])

    result = asyncio.run(tool.execute(summary="A structured finding.", issues=[issue]))

    item = result["issue_results"][0]
    assert "evidence_incomplete" in item["contract_gap_codes"]
    assert "support_role_missing" in item["contract_gap_codes"]
    assert item["passes_submit_preflight"] is False


def test_legacy_payload_remains_legacy_only_when_no_structured_fields_exist() -> None:
    normalized, _ = InferenceEngine._normalize_review_payload(
        {
            "summary": "A legacy finding.",
            "issues": [
                {
                    "severity": "warning",
                    "location": "src/app.py:2",
                    "evidence": "+ return new_value",
                    "suggestion": "Preserve behavior.",
                    "confidence": 0.9,
                }
            ],
        }
    )

    report = ReviewReport.model_validate(normalized)

    assert report.issues[0].schema_version == "1.0"


def test_legacy_policy_cause_evidence_remains_compatibility_only() -> None:
    normalized, _ = InferenceEngine._normalize_review_payload(
        {
            "summary": "A finding with a causal citation.",
            "issues": [
                {
                    "severity": "warning",
                    "location": "src/app.py:2",
                    "evidence": "+ return new_value",
                    "suggestion": "Preserve behavior.",
                    "confidence": 0.9,
                    "cause_evidence": [{"file": "src/app.py", "line": 2}],
                }
            ],
        }
    )

    report = ReviewReport.model_validate(normalized)

    assert report.issues[0].schema_version == "1.0"
    assert report.issues[0].is_structured_hypothesis is False


def test_location_support_ref_survives_runtime_bound_evidence_identity() -> None:
    issue = _structured_payload()["issues"][0]
    assert isinstance(issue, dict)
    full_issue = {
        **issue,
        "schema_version": "2.0",
        "cause_evidence": [
            EvidenceProvenance(
                artifact_id="artifact-cause",
                snapshot_id="snapshot-a",
                revision="revision-a",
                file="src/app.py",
                line=2,
                context_hash="bound-hash",
                statement="The changed return produces the incompatible value.",
            ).model_dump(mode="json")
        ],
        "contract_evidence": [
            EvidenceProvenance(
                artifact_id="artifact-contract",
                snapshot_id="snapshot-a",
                revision="revision-a",
                file="src/app.py",
                line=8,
                statement="The caller contract expects the prior value.",
            ).model_dump(mode="json")
        ],
        "trigger_evidence": [
            EvidenceProvenance(
                artifact_id="artifact-trigger",
                snapshot_id="snapshot-a",
                revision="revision-a",
                file="src/app.py",
                line=9,
                statement="The caller reaches the changed branch.",
            ).model_dump(mode="json")
        ],
        "impact_evidence": [
            EvidenceProvenance(
                artifact_id="artifact-impact",
                snapshot_id="snapshot-a",
                revision="revision-a",
                file="src/app.py",
                line=10,
                statement="The caller receives the incompatible value.",
            ).model_dump(mode="json")
        ],
        "supports": [
            {
                "role": "cause",
                "statement": "The changed return produces the incompatible value.",
                "evidence_refs": ["src/app.py:2"],
            },
            {
                "role": "contract",
                "statement": "The caller contract expects the prior value.",
                "evidence_refs": ["src/app.py:8"],
            },
            {
                "role": "trigger",
                "statement": "The caller reaches the changed branch.",
                "evidence_refs": ["src/app.py:9"],
            },
            {
                "role": "impact",
                "statement": "The caller receives the incompatible value.",
                "evidence_refs": ["src/app.py:10"],
            },
        ],
    }
    parsed = ReviewIssue.model_validate(full_issue)
    assert not canonical_contract_gaps(parsed, strict=True)
