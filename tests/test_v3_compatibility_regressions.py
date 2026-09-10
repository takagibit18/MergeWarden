"""First-failure regressions for the explicit v3 evaluation boundary."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from typing import Any, cast

import pytest

from eval.core_eval import (
    CORE_V3_MATCHER_VERSION,
    GoldFinding,
    GoldLocation,
    match_review_findings,
)
from eval.metrics import build_eval_report
from eval.runner import _match_issues_for_version, run_single
from eval.schemas import EvalResult, ExpectedIssue, Fixture
from src.analyzer.context_state import ContextState
from src.analyzer.finding_contract import normalize_model_finding_v3_payload
from src.analyzer.finding_delivery import CandidateRegistry, relevant_evidence_context_digest
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.root_cause import RootCauseConsolidator
from src.analyzer.result_processor import ResultProcessor
from src.analyzer.schemas import ReviewRequest, ReviewResponse
from src.analyzer.inference_engine import InferenceEngine
from src.integrations.github_publisher import (
    GitHubPublishRequest,
    GitHubPublisher,
    validate_v3_publish_binding,
)
from src.platform.artifacts import ArtifactStore


_CATALOG = [
    {
        "evidence_id": "ev-v3-regression",
        "artifact_id": "artifact-v3-regression",
        "path": "src/app.py",
        "start_line": 2,
        "end_line": 2,
        "source_type": "git_diff",
        "snapshot_id": "snapshot-v3-regression",
        "revision": "revision-v3-regression",
        "content_hash": "body-v3-regression",
    }
]


def _approved_v3_response() -> ReviewResponse:
    issue = ReviewIssue.model_validate(
        normalize_model_finding_v3_payload(
            {
                "anchor": {"file": "src/app.py", "line": 2},
                "description": "The changed return value violates the caller contract.",
                "evidence_refs": ["ev-v3-regression"],
                "severity": "warning",
            },
            evidence_catalog=_CATALOG,
        )
    )
    registry = CandidateRegistry()
    record = registry.save_finding(issue, source_issue_index=0, iteration=0)
    bound = registry.authoritative_issue(record.candidate_id)
    assert bound is not None
    digest = relevant_evidence_context_digest(
        _CATALOG,
        bound.evidence_refs,
        snapshot_id="snapshot-v3-regression",
        revision="revision-v3-regression",
    )
    version = registry.commit_verified_version(
        record.candidate_id,
        bound,
        evidence_context_digest=digest,
    )
    assert registry.record_semantic_receipt(
        record.candidate_id,
        {
            "opaque_handle": registry.opaque_handle(record.candidate_id),
            "candidate_id": record.candidate_id,
            "content_version": version,
            "evidence_context_digest": digest,
            "verdict": "accept",
            "status": "completed",
            "input_digest": "input-v3-regression",
            "request_hash": "request-v3-regression",
            "response_digest": "response-v3-regression",
            "provider_request_id": "provider-v3-regression",
            "provider_attempt_count": 1,
        },
        content_version=version,
        evidence_context_digest=digest,
    )
    return ReviewResponse(
        run_id="run-v3-regression",
        report=ReviewReport(issues=[bound], schema_version="3.0"),
        context=ContextState(
            evidence_snapshot_id="snapshot-v3-regression",
            evidence_revision="revision-v3-regression",
            evidence_ledger=deepcopy(_CATALOG),
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


def _fixture() -> Fixture:
    return Fixture.model_validate(
        {
            "id": "v3-content-regression",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {"files": {}},
            "expected": {
                "issues": [
                    ExpectedIssue(
                        severity=Severity.WARNING,
                        path="src/app.py",
                        line=2,
                        description="The changed return value violates the caller contract.",
                        mechanism_pattern="legacy mechanism annotation",
                        invariant_pattern="legacy invariant annotation",
                    )
                ]
            },
        }
    )


def test_v3_content_matcher_uses_description_instead_of_empty_legacy_roles() -> None:
    matches, matched_count, false_positive_count = _match_issues_for_version(
        _fixture(), _approved_v3_response(), "semantic-v3-content-v1"
    )

    assert matched_count == 1
    assert false_positive_count == 0
    assert matches[0].matched is True
    assert matches[0].location_matched is True
    assert matches[0].root_cause_matched is True
    assert matches[0].role_match_diagnostics["semantic_source"] == "description"


def test_empty_v3_report_keeps_explicit_report_version() -> None:
    report = ReviewReport(summary="No findings.", issues=[], schema_version="3.0")

    assert report.contract_payload()["schema_version"] == "3.0"


def test_public_v3_payload_is_reimportable_but_not_approval_bound() -> None:
    response = _approved_v3_response()

    payload = response.contract_payload()
    public_context = payload["context"]
    assert "candidate_registrations" not in public_context
    assert "evidence_ledger" not in public_context
    assert payload["report"]["issues"][0]["description"]
    assert payload["report"]["issues"][0]["evidence_refs"] == [
        "ev-v3-regression"
    ]

    reimported = ReviewResponse.model_validate(payload)
    assert reimported.report.schema_version == "3.0"
    assert reimported.report.issues[0].description == response.report.issues[0].description
    assert reimported.context.candidate_registrations == []


def test_v3_artifact_and_github_dry_run_keep_the_same_public_semantics(tmp_path) -> None:
    response = _approved_v3_response()

    artifact_store = ArtifactStore(tmp_path)
    artifact_path = artifact_store.save_pipeline_result(response.run_id, response)
    artifact = artifact_store.load_pipeline_result(artifact_path)
    assert artifact["report"]["schema_version"] == "3.0"
    assert artifact["report"]["issues"][0]["description"] == (
        response.report.issues[0].description
    )
    assert "candidate_registrations" not in artifact["context"]

    dry_run = GitHubPublisher(client=cast(Any, None)).publish_sync(
        GitHubPublishRequest(
            owner_repo="example/repo",
            pr_number=1,
            head_sha="head-v3-regression",
            response=response,
            changed_lines={"src/app.py": [2]},
            dry_run=True,
        )
    )
    body = dry_run.advisory_payload.inline_comments[0].body
    assert dry_run.status == "dry_run"
    assert response.report.issues[0].description in body
    assert "Evidence refs: ev-v3-regression" in body


def test_v3_parser_rejects_legacy_submit_review_without_fallback() -> None:
    engine = InferenceEngine.__new__(InferenceEngine)
    request = ReviewRequest(repo_path=".")
    plan, meta = engine._parse_tool_calls(
        [
            {
                "id": "call-v3-submit",
                "function": {
                    "name": "submit_review",
                    "arguments": {
                        "summary": "legacy-shaped",
                        "issues": [],
                    },
                },
            }
        ],
        request,
        contract_version="3.0",
    )

    assert plan.draft_review is None
    assert meta["submit_review_seen"] is True
    assert "not supported" in meta["submit_review_validation_error"]
    assert engine._try_parse_submit_payload_from_json(
        {"summary": "legacy-shaped", "issues": []},
        request,
        contract_version="3.0",
    ) is None


def test_v3_root_cause_merge_is_explicitly_isolated() -> None:
    response = _approved_v3_response()
    original_description = response.report.issues[0].description

    result = RootCauseConsolidator().consolidate(response.report)

    assert result.report.schema_version == "3.0"
    assert result.report.issues[0].description == original_description
    assert result.proposals == []
    assert result.rejections[0].reasons == [
        "v3_root_cause_consolidation_unsupported"
    ]
    assert all(issue.schema_version == "3.0" for issue in result.report.issues)


def test_v3_result_merge_does_not_deduplicate_through_legacy_fields() -> None:
    first = _approved_v3_response().report.issues[0]
    second = first.model_copy(
        deep=True,
        update={
            "candidate_id": "cand-distinct-v3",
            "finding_id": "F-distinct-v3",
            "description": "A different v3 claim at the same location.",
        },
    )

    merged = ResultProcessor.merge_review_reports(
        [ReviewReport(issues=[first, second], schema_version="3.0")]
    )

    assert len(merged.issues) == 2
    assert {issue.description for issue in merged.issues} == {
        first.description,
        second.description,
    }


def test_unknown_report_version_is_rejected_instead_of_inferred() -> None:
    with pytest.raises(ValueError, match="Unsupported review report schema_version"):
        ReviewReport(schema_version="9.0")


def test_core_eval_rejects_v3_issue_when_report_envelope_is_missing() -> None:
    issue = _approved_v3_response().report.issues[0].model_dump(mode="json")

    with pytest.raises(ValueError, match="explicit report schema_version"):
        match_review_findings(
            [],
            {"run_id": "missing-envelope", "report": {"issues": [issue]}},
        )


def test_eval_report_builder_rejects_mixed_contracts_and_matchers() -> None:
    results = [
        EvalResult(
            fixture_id="v2",
            fixture_type="review",
            matcher_version="semantic-v3",
            finding_contract_version="2.0",
        ),
        EvalResult(
            fixture_id="v3",
            fixture_type="review",
            matcher_version="semantic-v3-content-v1",
            finding_contract_version="3.0",
        ),
    ]

    with pytest.raises(ValueError, match="mixed matcher versions"):
        build_eval_report("mixed", results)


def test_empty_v3_publish_binding_is_ready_but_incomplete_is_not() -> None:
    ready = ReviewResponse(
        run_id="empty-v3",
        report=ReviewReport(summary="No findings.", schema_version="3.0"),
        context=ContextState(),
        completion_status="complete",
        finding_run_status="complete",
        delivery_complete=True,
        report_ready=True,
    )
    assert validate_v3_publish_binding(ready) == (
        True,
        "v3_runtime_approval_bound_empty_report",
    )

    incomplete = ready.model_copy(update={"delivery_complete": False})
    assert validate_v3_publish_binding(incomplete) == (False, "delivery_incomplete")


def test_mixed_finding_contracts_are_rejected_at_report_boundary() -> None:
    legacy = ReviewIssue(
        severity=Severity.WARNING,
        location="src/legacy.py:1",
        evidence="+ old",
        suggestion="Keep the old guard.",
    )

    with pytest.raises(ValueError, match="mixed finding contracts"):
        ReviewReport(issues=[legacy, _approved_v3_response().report.issues[0]], schema_version="3.0")


def test_historical_matcher_is_rejected_for_a_v3_report() -> None:
    with pytest.raises(ValueError, match="Unsupported evaluation contract/matcher"):
        _match_issues_for_version(_fixture(), _approved_v3_response(), "semantic-v3")


def test_v3_matcher_rejects_debug_fixture_before_workspace_or_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FINDING_CONTRACT_VERSION", "3.0")
    debug_fixture = _fixture().model_copy(update={"type": "debug"})

    with pytest.raises(ValueError, match="requires a review fixture"):
        asyncio.run(
            run_single(
                debug_fixture,
                matcher_version="semantic-v3-content-v1",
            )
        )


def test_v3_runtime_rejects_historical_matcher_before_workspace_or_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FINDING_CONTRACT_VERSION", "3.0")

    with pytest.raises(ValueError, match="Unsupported evaluation contract/matcher"):
        asyncio.run(run_single(_fixture(), matcher_version="semantic-v3"))


def test_core_eval_v3_reads_description_and_requires_runtime_approval() -> None:
    response = _approved_v3_response()
    quality = match_review_findings(
        [
            GoldFinding(
                id="return-contract",
                category="api",
                severity=Severity.WARNING,
                file="src/app.py",
                location=GoldLocation(start_line=2, end_line=2, tolerance_lines=0),
                description="The changed return value violates the caller contract.",
                root_cause="return contract",
            )
        ],
        response.model_dump(mode="json"),
        matcher_version=CORE_V3_MATCHER_VERSION,
        finding_contract_version="3.0",
    )

    assert quality.finding_contract_version == "3.0"
    assert quality.matched_count == 1
    assert quality.generated_count == 1

    unapproved = response.model_copy(deep=True)
    unapproved.context.candidate_registrations[0]["status"] = "pending"
    rejected_quality = match_review_findings(
        [],
        unapproved.model_dump(mode="json"),
        matcher_version=CORE_V3_MATCHER_VERSION,
        finding_contract_version="3.0",
    )
    assert rejected_quality.generated_count == 0
