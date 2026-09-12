"""Offline replay for independent finding-funnel counters."""

from __future__ import annotations

from pathlib import Path

from eval.run_summary import extract_review_process_metrics
from eval.schemas import EvalResult, MetricSummary


def test_minimal_redacted_funnel_replay_preserves_stage_boundaries() -> None:
    replay = (
        Path(__file__).parents[1]
        / "eval"
        / "replays"
        / "finding_funnel_minimal.jsonl"
    )
    metrics = extract_review_process_metrics(replay, matcher_version="semantic-v4")

    assert metrics.event_log_status == "ok"
    assert metrics.finding_run_status == "incomplete"
    assert metrics.model_raw_issue_count == 3
    assert metrics.candidate_issue_count == 2
    assert metrics.verifier_accepted_count == 1
    assert metrics.verifier_rejected_count == 1
    assert metrics.integrity_needs_repair_count == 1
    assert metrics.repair_attempted_count == 1
    assert metrics.repair_succeeded_count == 0
    assert metrics.evidence_complete_count == 1
    assert metrics.evidence_validated_count == 1

    funnel = metrics.finding_funnel
    assert funnel.submitted_finding_count == 3
    assert funnel.submitted_attempt_count > funnel.submitted_finding_count
    assert funnel.policy_passed_count + funnel.policy_rejected_count == 3
    assert funnel.risk_candidate_count == funnel.integrity_checked_count
    assert funnel.integrity_verified_count + funnel.integrity_needs_repair_count == (
        funnel.integrity_checked_count
    )
    assert funnel.final_published_count == funnel.final_risk_finding_count == 1
    assert funnel.evidence_complete_count <= funnel.evidence_validated_count

    summary = MetricSummary.from_results(
        [
            EvalResult(
                fixture_id="redacted-replay",
                fixture_type="review",
                matcher_version="semantic-v4",
                process_metrics=metrics,
            )
        ]
    )
    assert summary.finding_funnel.submitted_finding_count == 3
    assert summary.finding_funnel.provider_attempt_count == 5
    assert summary.finding_funnel.final_published_count == 1
