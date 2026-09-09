"""Cross-module regression tests for runtime-owned finding delivery."""

from __future__ import annotations

from types import SimpleNamespace

from src.analyzer.finding_delivery import CandidateRegistry
from src.analyzer.finding_integrity import build_candidates
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import FindingCandidate
from src.analyzer.inference_engine import InferenceEngine
from src.orchestrator.agent_loop import AgentOrchestrator


def _issue(*, finding_id: str = "", suggestion: str = "Preserve the contract") -> ReviewIssue:
    return ReviewIssue(
        severity=Severity.WARNING,
        location="pkg/service.py:2",
        evidence="+ changed_value = new_value",
        suggestion=suggestion,
        confidence=0.95,
        finding_id=finding_id,
    )


def test_initial_report_without_runtime_identity_is_registered_once() -> None:
    registry = CandidateRegistry()
    report = ReviewReport(issues=[_issue(), _issue()])

    candidates = build_candidates(report, iteration=0, registry=registry)

    assert len(candidates) == 1
    assert len(registry.records) == 1
    record = registry.records[0]
    assert record.candidate_id.startswith("cand_")
    assert record.finding_id.startswith("F-")
    assert record.candidate_content_version
    assert candidates[0].candidate_id == record.candidate_id
    assert candidates[0].candidate_content_version == record.candidate_content_version
    assert registry.duplicate_sources(record.candidate_id) == (1,)


def test_content_revision_keeps_candidate_identity_and_changes_version() -> None:
    registry = CandidateRegistry()
    first_report = ReviewReport(issues=[_issue()])
    first = build_candidates(first_report, iteration=0, registry=registry)[0]

    revised_report = ReviewReport(
        issues=[_issue(suggestion="Restore the caller-visible contract")]
    )
    revised = build_candidates(revised_report, iteration=1, registry=registry)[0]

    assert revised.candidate_id == first.candidate_id
    assert revised.logical_identity_hash == first.logical_identity_hash
    assert revised.candidate_content_version != first.candidate_content_version


def test_repair_feedback_never_invents_a_missing_target() -> None:
    message = InferenceEngine._build_repair_feedback_message(
        {
            "validator_passed": False,
            "unresolved_evidence_gaps": [
                {
                    "current_finding_id": "df_legacy",
                    "gaps": [{"required_action": "add contract support"}],
                }
            ],
        }
    )

    assert message is not None
    assert "candidate_repair_protocol:" not in message.content
    assert "<missing-target-" not in message.content
    assert "initial_submission_feedback" in message.content


def test_runtime_repair_requires_exact_version_and_explicit_status() -> None:
    original = ReviewReport(issues=[_issue(finding_id="F-original")])
    original_candidate = FindingCandidate(
        candidate_id="cand-runtime",
        content_hash="version-a",
        candidate_content_version="version-a",
        issue=original.issues[0],
        claim="Preserve the contract",
        originating_iteration=0,
    )
    preview = SimpleNamespace(
        bound_candidates=[original_candidate],
        results=[SimpleNamespace(status="needs_repair")],
    )
    missing_version = _issue(suggestion="repaired")
    missing_version.target_candidate_id = "cand-runtime"
    diagnostics: list[dict[str, object]] = []

    merged = AgentOrchestrator._merge_repaired_report(
        original,
        ReviewReport(issues=[missing_version]),
        preview,
        diagnostics=diagnostics,
    )

    assert merged.issues[0].suggestion == "Preserve the contract"
    assert [item["code"] for item in diagnostics] == [
        "repair_target_version_missing",
        "repair_target_not_returned",
    ]

    explicit_missing_status = _issue(suggestion="repaired")
    explicit_missing_status.target_candidate_id = "cand-runtime"
    explicit_missing_status.candidate_content_version = "version-a"
    diagnostics = []
    AgentOrchestrator._merge_repaired_report(
        original,
        ReviewReport(issues=[explicit_missing_status]),
        preview,
        diagnostics=diagnostics,
    )
    assert diagnostics[0]["code"] == "repair_status_missing"


def test_graph_draft_and_revision_ids_are_not_repair_targets() -> None:
    original = ReviewReport(issues=[_issue(finding_id="F-original")])
    candidate = FindingCandidate(
        candidate_id="cand-runtime",
        content_hash="version-a",
        candidate_content_version="version-a",
        issue=original.issues[0],
        claim="Preserve the contract",
        originating_iteration=0,
    )
    preview = SimpleNamespace(
        bound_candidates=[candidate],
        results=[SimpleNamespace(status="needs_repair")],
    )
    repair = _issue()
    repair.target_candidate_id = "C-001-graph"
    repair.candidate_content_version = "version-a"
    repair.repair_status = "repaired"
    diagnostics: list[dict[str, object]] = []

    merged = AgentOrchestrator._merge_repaired_report(
        original,
        ReviewReport(issues=[repair]),
        preview,
        diagnostics=diagnostics,
    )

    assert merged.issues[0].suggestion == "Preserve the contract"
    assert diagnostics[0]["code"] == "repair_target_unknown"
