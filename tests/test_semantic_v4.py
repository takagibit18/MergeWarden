"""Offline regression tests for the versioned layered finding matcher."""

from __future__ import annotations

from eval.runner import _match_issues_for_version, _root_cause_quality_for_version
from eval.schemas import ExpectedIssue, EvalResult, Fixture, MetricSummary
from src.analyzer.context_state import ContextState
from src.analyzer.finding_schema import EvidenceProvenance, RepairIntent, SourceAnchor
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import ReviewResponse


def _fixture() -> Fixture:
    return Fixture.model_validate(
        {
            "id": "layered-replay",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {"files": {}},
            "expected": {
                "issues": [
                    ExpectedIssue(
                        severity=Severity.WARNING,
                        path="src/changed.py",
                        line=10,
                        root_cause_id="root-1",
                        mechanism_pattern="duplicate submission",
                        invariant_pattern="one request per finding",
                        trigger_pattern="retry after timeout",
                        impact_pattern="duplicate charge",
                        repair_unit="dedupe by request id",
                        affected_paths=["src/changed.py", "src/helper.py"],
                    )
                ]
            },
        }
    )


def _evidence(
    file: str,
    line: int,
    statement: str,
    *,
    artifact_id: str,
) -> EvidenceProvenance:
    return EvidenceProvenance(
        file=file,
        line=line,
        end_line=line,
        artifact_id=artifact_id,
        snapshot_id="snapshot-1",
        revision="revision-1",
        retrieval_source="read_file",
        statement=statement,
    )


def _verified_issue(
    *,
    display_location: str = "src/symptom.py:50",
    causal_mechanism: str = "The retry causes duplicate submission.",
    integrity_status: str = "verified",
) -> ReviewIssue:
    return ReviewIssue(
        severity=Severity.WARNING,
        location=display_location,
        evidence="The changed path can submit the same payment twice.",
        suggestion="Dedupe by request id before sending the request.",
        confidence=0.95,
        schema_version="2.0",
        integrity_status=integrity_status,
        primary_anchor=SourceAnchor(file="src/symptom.py", line=50),
        observed_behavior="A retry produces a duplicate charge.",
        causal_mechanism=causal_mechanism,
        violated_invariant="There must be one request per finding.",
        repair_intent=RepairIntent(
            action="Dedupe by request id before sending the request."
        ),
        trigger="Retry after timeout.",
        impact="The user receives a duplicate charge.",
        cause_evidence=[
            _evidence(
                "src/changed.py",
                10,
                "This changed branch performs the duplicate submission.",
                artifact_id="artifact-cause",
            )
        ],
        contract_evidence=[
            _evidence(
                "src/helper.py",
                21,
                "The helper's contract requires one request per finding.",
                artifact_id="artifact-contract",
            )
        ],
        trigger_evidence=[
            _evidence(
                "src/helper.py",
                22,
                "The retry-after-timeout branch triggers this behavior.",
                artifact_id="artifact-trigger",
            )
        ],
        impact_evidence=[
            _evidence(
                "src/helper.py",
                23,
                "The observable result is a duplicate charge.",
                artifact_id="artifact-impact",
            )
        ],
    )


def _response(issue: ReviewIssue) -> ReviewResponse:
    return ReviewResponse(
        run_id="layered-run",
        report=ReviewReport(summary="A verified risk finding.", issues=[issue]),
        context=ContextState(),
    )


def test_v4_accepts_verified_causal_anchor_and_verified_cross_file_paths() -> None:
    fixture = _fixture()
    response = _response(_verified_issue())

    matches = _match_issues_for_version(fixture, response, "semantic-v4")

    assert matches[1:] == (1, 0)
    item = matches[0][0]
    assert item.matched is True
    assert item.location_matched is True
    assert item.root_cause_matched is True
    assert item.role_match_diagnostics["affected_paths_matched"] is True
    assert item.role_match_diagnostics["actual_paths"] == [
        "src/changed.py",
        "src/helper.py",
        "src/symptom.py",
    ]

    quality = _root_cause_quality_for_version(
        fixture, response, matches[0], "semantic-v4"
    )
    assert quality["evidence_complete_count"] == 1
    assert quality["final_finding_count"] == 1


def test_v4_keeps_partial_dimensions_auditable_and_v3_unchanged() -> None:
    fixture = _fixture()
    wrong_root = _verified_issue(causal_mechanism="The retry loses the cache entry.")
    response = _response(wrong_root)

    v4_matches = _match_issues_for_version(fixture, response, "semantic-v4")
    v3_matches = _match_issues_for_version(fixture, response, "semantic-v3")

    v4_item = v4_matches[0][0]
    assert v4_item.matched is False
    assert v4_item.matched_actual_index == 0
    assert v4_item.location_matched is True
    assert v4_item.root_cause_matched is False
    assert v4_item.role_match_diagnostics["mechanism_matched"] is False
    assert v4_matches[1:] == (0, 1)
    assert v3_matches[0][0].matched is False
    assert v3_matches[1:] == (0, 1)


def test_v4_does_not_treat_same_file_proximity_as_a_causal_anchor() -> None:
    fixture = _fixture()
    nearby = _verified_issue(
        display_location="src/changed.py:99",
    ).model_copy(
        update={
            "cause_evidence": [
                _evidence(
                    "src/changed.py",
                    99,
                    "A nearby line is visible but is not the expected cause.",
                    artifact_id="artifact-nearby",
                )
            ]
        }
    )

    item = _match_issues_for_version(
        fixture, _response(nearby), "semantic-v4"
    )[0][0]

    assert item.location_matched is False
    assert item.matched is False


def test_v4_excludes_findings_that_still_need_repair() -> None:
    fixture = _fixture()
    response = _response(_verified_issue(integrity_status="needs_repair"))

    matches = _match_issues_for_version(fixture, response, "semantic-v4")

    assert matches[1:] == (0, 0)
    assert matches[0][0].matched is False
    assert matches[0][0].location_matched is False


def test_layered_metrics_are_version_scoped() -> None:
    v4 = EvalResult(
        fixture_id="layered-replay",
        fixture_type="review",
        matcher_version="semantic-v4",
        expected_count=2,
        location_matched_count=2,
        root_cause_matched_count=1,
    )
    v3 = EvalResult(
        fixture_id="legacy-replay",
        fixture_type="review",
        matcher_version="semantic-v3",
        expected_count=2,
        location_matched_count=2,
        root_cause_matched_count=2,
    )

    metrics = MetricSummary.from_results([v4, v3])

    assert metrics.layered_expected_count == 2
    assert metrics.location_matched_count == 2
    assert metrics.root_cause_matched_count == 1
    assert metrics.location_match_rate == 1.0
    assert metrics.root_cause_match_rate == 0.5
