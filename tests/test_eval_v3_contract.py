"""Regression tests for the v3 evaluation eligibility boundary."""

from __future__ import annotations

from copy import deepcopy

from eval.runner import _effective_review_issues, _match_issues_for_version
from eval.schemas import ExpectedIssue, Fixture
from src.analyzer.context_state import ContextState
from src.analyzer.finding_delivery import (
    CandidateRegistry,
    relevant_evidence_context_digest,
)
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import ReviewResponse
from src.analyzer.finding_contract import normalize_model_finding_v3_payload


CATALOG = [
    {
        "evidence_id": "ev-v3",
        "artifact_id": "artifact-v3",
        "path": "src/app.py",
        "start_line": 2,
        "end_line": 2,
        "source_type": "git_diff",
        "snapshot_id": "snapshot-v3",
        "revision": "revision-v3",
        "content_hash": "body-v3",
    }
]


def _issue() -> ReviewIssue:
    return ReviewIssue.model_validate(
        normalize_model_finding_v3_payload(
            {
                "anchor": {"file": "src/app.py", "line": 2},
                "description": "The changed return value violates the caller contract.",
                "evidence_refs": ["ev-v3"],
                "severity": "warning",
            },
            evidence_catalog=CATALOG,
        )
    )


def _approved_response() -> ReviewResponse:
    registry = CandidateRegistry()
    issue = _issue()
    record = registry.save_finding(issue, source_issue_index=0, iteration=0)
    bound = registry.authoritative_issue(record.candidate_id)
    assert bound is not None
    evidence_digest = relevant_evidence_context_digest(
        CATALOG,
        bound.evidence_refs,
        snapshot_id="snapshot-v3",
        revision="revision-v3",
    )
    version = registry.commit_verified_version(
        record.candidate_id,
        bound,
        evidence_context_digest=evidence_digest,
    )
    receipt = {
        "opaque_handle": registry.opaque_handle(record.candidate_id),
        "candidate_id": record.candidate_id,
        "content_version": version,
        "evidence_context_digest": evidence_digest,
        "verdict": "accept",
        "status": "completed",
        "input_digest": "input-v3",
        "request_hash": "request-v3",
        "response_digest": "response-v3",
        "provider_request_id": "provider-v3",
        "provider_attempt_count": 1,
    }
    assert registry.record_semantic_receipt(
        record.candidate_id,
        receipt,
        content_version=version,
        evidence_context_digest=evidence_digest,
    )
    return ReviewResponse(
        run_id="eval-v3",
        report=ReviewReport(issues=[bound], schema_version="3.0"),
        context=ContextState(
            evidence_snapshot_id="snapshot-v3",
            evidence_revision="revision-v3",
            evidence_ledger=deepcopy(CATALOG),
            candidate_registrations=registry.snapshot(),
        ),
        completion_status="complete",
        finding_run_status="complete",
        delivery_complete=True,
        semantic_verifier_required=True,
        semantic_verifier_completed=True,
        semantic_accepted_count=1,
        report_ready=True,
        external_publish_status="ready",
    )


def _fixture(expected_path: str = "other.py") -> Fixture:
    return Fixture.model_validate(
        {
            "id": "v3-eval",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {"files": {}},
            "expected": {
                "issues": [
                    ExpectedIssue(
                        severity=Severity.WARNING,
                        path=expected_path,
                        line=99,
                    )
                ]
            },
        }
    )


def test_v3_eligibility_ignores_legacy_confidence_and_evidence_fields() -> None:
    response = _approved_response()
    assert response.report.issues[0].confidence == 0.0
    assert response.report.issues[0].evidence == ""
    assert len(_effective_review_issues(_fixture(), response)) == 1

    deprecated_only = response.model_copy(deep=True)
    deprecated_only.report.issues[0].confidence = 1.0
    deprecated_only.report.issues[0].evidence = "legacy evidence formatting"
    assert len(_effective_review_issues(_fixture(), deprecated_only)) == 1


def test_v3_report_ready_cannot_replace_receipt_version_or_evidence_binding() -> None:
    missing_receipt = _approved_response().model_copy(deep=True)
    missing_receipt.context.candidate_registrations[0]["semantic_receipts"] = []
    missing_receipt.context.candidate_registrations[0]["semantic_verdict"] = "not_run"
    assert _effective_review_issues(_fixture(), missing_receipt) == []

    stale_version = _approved_response().model_copy(deep=True)
    stale_version.context.candidate_registrations[0]["candidate_content_version"] = "old"
    assert _effective_review_issues(_fixture(), stale_version) == []

    changed_evidence = _approved_response().model_copy(deep=True)
    changed_evidence.context.evidence_ledger[0]["content_hash"] = "changed"
    assert _effective_review_issues(_fixture(), changed_evidence) == []


def test_verifier_accept_is_not_a_gold_match() -> None:
    response = _approved_response()
    matches, matched_count, false_positive_count = _match_issues_for_version(
        _fixture(expected_path="unrelated.py"), response, "semantic-v3-content-v1"
    )
    assert len(_effective_review_issues(_fixture(), response)) == 1
    assert matches[0].matched is False
    assert matched_count == 0
    assert false_positive_count == 1


def test_v3_receipt_requires_runtime_flags_even_when_report_is_nonempty() -> None:
    response = _approved_response().model_copy(
        update={"delivery_complete": False, "finding_run_status": "incomplete"}
    )
    assert response.report.issues
    assert _effective_review_issues(_fixture(), response) == []
