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
    GeneratedFinding,
    _deduplicate_generated_findings,
    match_review_findings,
)
from eval.metrics import build_eval_report
from eval.runner import (
    _match_issues_for_version,
    _v3_duplicate_actual_count,
    _v3_duplicate_actual_stats,
    _v3_semantic_text_judgment,
    run_single,
)
from eval.schemas import EvalResult, ExpectedIssue, Fixture
from src.analyzer.context_state import ContextState
from src.analyzer.finding_contract import normalize_model_finding_v3_payload
from src.analyzer.finding_delivery import CandidateRegistry, relevant_evidence_context_digest
from src.analyzer.finding_schema import RelatedLocation
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


def _approved_v3_response(
    *,
    description: str = "The changed return value violates the caller contract.",
    suggestion: str = "",
    root_cause_id: str = "",
) -> ReviewResponse:
    payload = {
        "anchor": {"file": "src/app.py", "line": 2},
        "description": description,
        "evidence_refs": ["ev-v3-regression"],
        "severity": "warning",
    }
    if suggestion:
        payload["suggestion"] = suggestion
    if root_cause_id:
        payload["root_cause_id"] = root_cause_id
    issue = ReviewIssue.model_validate(
        normalize_model_finding_v3_payload(
            payload,
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


def _fixture(
    *,
    description: str = "The changed return value violates the caller contract.",
    repair_unit: str = "",
) -> Fixture:
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
                        description=description,
                        repair_unit=repair_unit,
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


_FILE_PATH_GOLD_DESCRIPTION = (
    "Exception handlers index optional file_path metadata, raising KeyError "
    "instead of skipping bad sources."
)


@pytest.mark.parametrize(
    ("actual_description", "expected_status"),
    [
        (
            "The file_path metadata lookup is safe and never raises KeyError; "
            "there is no regression.",
            "undetermined",
        ),
        (
            "The file_path metadata is lost when serializing a valid document, "
            "so its citation is missing.",
            "undetermined",
        ),
        (
            "Exception handlers skip bad sources instead of raising KeyError "
            "when indexing optional file_path metadata.",
            "undetermined",
        ),
        (
            "Exception handlers index optional file_path metadata only when the "
            "path is present, rather than raising KeyError.",
            "undetermined",
        ),
        (
            "Absent path metadata triggers a key lookup failure.",
            "undetermined",
        ),
        (
            "The handler fails when x > 2.",
            "undetermined",
        ),
        (
            "Use cache A and cache B.",
            "undetermined",
        ),
        (
            "flag can be false",
            "undetermined",
        ),
        (
            "Requests fail when a token is missing.",
            "undetermined",
        ),
        (
            "The handler fails when x < 2.",
            "undetermined",
        ),
    ],
)
def test_v3_semantic_match_requires_strict_text_identity(
    actual_description: str,
    expected_status: str,
) -> None:
    matches, matched_count, _ = _match_issues_for_version(
        _fixture(description=_FILE_PATH_GOLD_DESCRIPTION),
        _approved_v3_response(description=actual_description),
        "semantic-v3-content-v1",
    )

    diagnostics = matches[0].role_match_diagnostics
    assert matched_count == 0
    assert matches[0].matched is False
    assert diagnostics["semantic_status"] == expected_status
    assert diagnostics["semantic_rule_version"] == (
        "semantic-v3-content-v1-conservative-v3"
    )


def test_v3_strict_text_rule_preserves_code_text_and_only_normalizes_boundaries() -> None:
    expected = 'Call cache_A when flag == "on" and value < 2.'
    matched, matched_reason = _v3_semantic_text_judgment(
        f"  {expected}\r\n",
        f"{expected}\n",
    )
    assert matched == "matched"
    assert matched_reason == "semantic-v3-content-v1-conservative-v3:exact_text"
    line_break_matched, _ = _v3_semantic_text_judgment(
        'Call cache_A when\nflag == "on" and value < 2.',
        'Call cache_A when\r\nflag == "on" and value < 2.',
    )
    assert line_break_matched == "matched"

    for actual in (
        'Call cache_A when flag == "on" and value > 2.',
        'Call cache_A when flag == "on" and value < 2. ',
        'Call cache_A when flag == "on" and value < 2.',
        'Call cache_A when flag == "on  value" and value < 2.',
        'Call cacheA when flag == "on" and value < 2.',
        'call cache_A when flag == "on" and value < 2.',
        'Call cache_A when flag == "on" and  value < 2.',
    ):
        status, reason = _v3_semantic_text_judgment(expected, actual)
        if actual == expected:
            assert status == "matched"
        elif actual.endswith(" "):
            assert status == "matched"
        else:
            assert status == "undetermined"
            assert reason.endswith(":text_not_identical")


@pytest.mark.parametrize(
    ("expected_description", "actual_description"),
    [
        ("The handler fails when x < 2.", "The handler fails when x > 2."),
        ("Use cache A or cache B.", "Use cache A and cache B."),
        ("flag is false", "flag can be false"),
        (
            "Requests fail without a token.",
            "Requests fail when a token is missing.",
        ),
        ("Use cache_A.", "Use cacheA."),
        ("Use Cache A.", "Use cache a."),
        ("Guard  the call.", "Guard the call."),
        ('Use the label "a b".', 'Use the label "a  b".'),
    ],
)
def test_v3_main_eval_does_not_promote_nonidentical_text(
    expected_description: str,
    actual_description: str,
) -> None:
    matches, matched_count, _ = _match_issues_for_version(
        _fixture(description=expected_description),
        _approved_v3_response(description=actual_description),
        "semantic-v3-content-v1",
    )

    assert matched_count == 0
    assert matches[0].role_match_diagnostics["semantic_status"] == "undetermined"


def test_v3_repair_match_rejects_an_opposite_directive() -> None:
    expected_repair = "Use safe metadata access consistently across handlers"
    matches, matched_count, _ = _match_issues_for_version(
        _fixture(
            description=_FILE_PATH_GOLD_DESCRIPTION,
            repair_unit=expected_repair,
        ),
        _approved_v3_response(
            description=_FILE_PATH_GOLD_DESCRIPTION,
            suggestion=(
                "Remove the safe metadata fallback and use direct lookup instead."
            ),
        ),
        "semantic-v3-content-v1",
    )

    diagnostics = matches[0].role_match_diagnostics
    assert matched_count == 0
    assert diagnostics["semantic_status"] == "matched"
    assert diagnostics["repair_unit_status"] == "undetermined"
    assert diagnostics["repair_unit_reason"].endswith(":repair_text_not_identical")


@pytest.mark.parametrize(
    "update",
    [
        {"location": "b.py:80"},
        {"location": "a.py:10-11"},
        {"suggestion": "Do not guard the call."},
        {"severity": Severity.CRITICAL},
        {"root_cause_id": "different-root"},
        {"related_locations": [RelatedLocation(file="b.py", line=80)]},
        {"evidence": "A different evidence excerpt."},
    ],
)
def test_v3_duplicate_stats_require_all_strict_key_fields(update: dict[str, Any]) -> None:
    base = _approved_v3_response(
        description="The call fails.",
        suggestion="Guard the call.",
    ).report.issues[0].model_copy(update={"root_cause_id": "root-a"})
    different = base.model_copy(update=update)

    stats = _v3_duplicate_actual_stats([base, different])
    assert stats["duplicate_count"] == 0
    assert stats["candidate_pair_count"] == 1


def test_v3_duplicate_stats_require_shared_evidence_identical_content_and_root() -> None:
    first = _approved_v3_response(
        description="The parser rejects missing metadata.",
        suggestion="Use a guarded lookup.",
    ).report.issues[0]
    exact_duplicate = _approved_v3_response(
        description="The parser rejects missing metadata.",
        suggestion="Use a guarded lookup.",
    ).report.issues[0]
    different_root = _approved_v3_response(
        description="The parser accepts missing metadata.",
        suggestion="Allow the direct lookup.",
        root_cause_id="private-attribute-reclassification",
    ).report.issues[0]

    assert _v3_duplicate_actual_count([first, exact_duplicate]) == 1
    uncertain = _v3_duplicate_actual_stats([first, different_root])
    assert uncertain["duplicate_count"] == 0
    assert uncertain["candidate_pair_count"] == 1

    same_content_different_roots = _v3_duplicate_actual_stats(
        [
            first.model_copy(update={"root_cause_id": "root-a"}),
            exact_duplicate.model_copy(update={"root_cause_id": "root-b"}),
        ]
    )
    assert same_content_different_roots["duplicate_count"] == 0
    assert same_content_different_roots["candidate_pair_count"] == 1


def test_core_v3_does_not_deduplicate_an_incomplete_finding_projection() -> None:
    findings = [
        GeneratedFinding(
            actual_index=index,
            severity=Severity.WARNING,
            location="a.py:10",
            text="The call fails.",
            contract_version="3.0",
            evidence_refs=["ev_shared"],
        )
        for index in range(2)
    ]

    unique, duplicate_count = _deduplicate_generated_findings(findings)

    assert len(unique) == 2
    assert duplicate_count == 0


def test_core_v3_uses_the_same_conservative_semantic_judgment() -> None:
    gold = GoldFinding(
        id="file-path-meta-access",
        category="error-handling",
        severity=Severity.WARNING,
        file="src/app.py",
        location=GoldLocation(start_line=2, end_line=2, tolerance_lines=0),
        description=_FILE_PATH_GOLD_DESCRIPTION,
        root_cause="optional file_path metadata is indexed unsafely",
    )
    actual_descriptions = (
        _FILE_PATH_GOLD_DESCRIPTION,
        "The file_path metadata lookup is safe and never raises KeyError; "
        "there is no regression.",
        "Absent path metadata triggers a key lookup failure.",
        "Exception handlers index optional file_path metadata, raising ValueError "
        "instead of skipping bad sources.",
        "Exception handlers index optional file_path metadata only when the path "
        "is present, rather than raising KeyError.",
    )

    qualities = [
        match_review_findings(
            [gold],
            _approved_v3_response(description=description).model_dump(mode="json"),
            matcher_version=CORE_V3_MATCHER_VERSION,
            finding_contract_version="3.0",
        )
        for description in actual_descriptions
    ]

    assert [quality.matched_count for quality in qualities] == [1, 0, 0, 0, 0]


@pytest.mark.parametrize(
    ("expected_description", "actual_description"),
    [
        ("The handler fails when x < 2.", "The handler fails when x > 2."),
        ("Use cache A or cache B.", "Use cache A and cache B."),
        ("flag is false", "flag can be false"),
        (
            "Requests fail without a token.",
            "Requests fail when a token is missing.",
        ),
        ("Use cache_A.", "Use cacheA."),
        ("Use Cache A.", "Use cache a."),
        ("Guard  the call.", "Guard the call."),
        ('Use the label "a b".', 'Use the label "a  b".'),
    ],
)
def test_core_v3_does_not_promote_nonidentical_text(
    expected_description: str,
    actual_description: str,
) -> None:
    gold = GoldFinding(
        id="strict-text",
        category="logic",
        severity=Severity.WARNING,
        file="src/app.py",
        location=GoldLocation(start_line=2, end_line=2, tolerance_lines=0),
        description=expected_description,
        root_cause="strict text fixture",
    )
    quality = match_review_findings(
        [gold],
        _approved_v3_response(description=actual_description).model_dump(mode="json"),
        matcher_version=CORE_V3_MATCHER_VERSION,
        finding_contract_version="3.0",
    )

    assert quality.matched_count == 0


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


def test_v3_parser_preserves_provider_ids_across_invalid_and_valid_action_order() -> None:
    engine = InferenceEngine.__new__(InferenceEngine)
    request = ReviewRequest(repo_path=".")
    finding = {
        "anchor": {"file": "src/app.py", "line": 2},
        "description": "The changed return value violates the caller contract.",
        "evidence_refs": ["ev-v3-regression"],
        "severity": "warning",
    }
    calls = [
        {
            "id": "save-good-1",
            "function": {"name": "save_finding", "arguments": {"finding": finding}},
        },
        {
            "id": "save-bad",
            "function": {
                "name": "save_finding",
                "arguments": {
                    "finding": {
                        "anchor": {"file": "src/app.py", "line": 3},
                        "evidence_refs": ["ev-v3-regression"],
                        "severity": "warning",
                    }
                },
            },
        },
        {
            "id": "save-good-2",
            "function": {"name": "save_finding", "arguments": {"finding": finding}},
        },
        {
            "id": "revise-good-1",
            "function": {
                "name": "revise_finding",
                "arguments": {
                    "opaque_handle": "vh_saved-finding",
                    "patch": {"suggestion": "Return the validated value."},
                },
            },
        },
    ]

    plan, metadata = engine._parse_tool_calls(  # noqa: SLF001
        calls,
        request,
        contract_version="3.0",
    )

    assert metadata["v3_action_validation_errors"]
    assert len(plan.v3_save_findings) == 2
    assert len(plan.v3_revise_findings) == 1
    assert [
        (ref.name, ref.provider_call_id, ref.raw_call_index, ref.action_index)
        for ref in plan.v3_action_call_refs
    ] == [
        ("save_finding", "save-good-1", 0, 0),
        ("save_finding", "save-bad", 1, None),
        ("save_finding", "save-good-2", 2, 1),
        ("revise_finding", "revise-good-1", 3, 0),
    ]
    bad_ref = plan.v3_action_call_refs[1]
    assert bad_ref.validation_error
    assert bad_ref.raw_arguments == calls[1]["function"]["arguments"]
    assert plan.v3_action_call_refs[2].raw_arguments == calls[2]["function"][
        "arguments"
    ]
    assert "v3_action_call_refs" not in plan.model_dump()


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
