"""Determinism and accounting checks for the persisted v3 re-scorer."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from eval.offline_rescore import rescore_experiment


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "eval" / "outputs" / "finding-delivery-python-ab-20260910-v3-zhipu"
RAW = OUTPUT_ROOT / "raw.json"
SUMMARY = ROOT / "eval" / "experiments" / "finding-delivery-python-ab-20260910-v3-zhipu-summary.json"
CHECKPOINT = OUTPUT_ROOT / "checkpoint.jsonl"
HISTORICAL_V2_REPORT = (
    ROOT / "eval" / "reports" / "finding-delivery-python-ab-20260910-v3-offline-rescore-v2.json"
)
HISTORICAL_V3_REPORT = (
    ROOT / "eval" / "reports" / "finding-delivery-python-ab-20260910-v3-offline-rescore-v3.json"
)


@pytest.mark.skipif(
    not (HISTORICAL_V2_REPORT.is_file() and HISTORICAL_V3_REPORT.is_file()),
    reason="optional local historical rescore reports are not present",
)
def test_historical_rescore_artifacts_keep_their_versions() -> None:
    v2 = json.loads(HISTORICAL_V2_REPORT.read_text(encoding="utf-8"))
    v3 = json.loads(HISTORICAL_V3_REPORT.read_text(encoding="utf-8"))

    assert v2["rescore_version"] == "offline-rescore-v2"
    assert v3["rescore_version"] == "offline-rescore-v3"
    assert v3["semantic_rule_version"] == (
        "semantic-v3-content-v1-conservative-v2"
    )


@pytest.mark.skipif(
    not (RAW.is_file() and SUMMARY.is_file() and CHECKPOINT.is_file()),
    reason="historical real-model artifacts are not present in this checkout",
)
def test_historical_v3_rescore_is_repeatable_and_reconciles_tokens() -> None:
    first = rescore_experiment(
        repo_root=ROOT,
        raw_path=RAW,
        summary_path=SUMMARY,
        checkpoint_path=CHECKPOINT,
        fixtures_dir=ROOT / "eval" / "fixtures",
    )
    second = rescore_experiment(
        repo_root=ROOT,
        raw_path=RAW,
        summary_path=SUMMARY,
        checkpoint_path=CHECKPOINT,
        fixtures_dir=ROOT / "eval" / "fixtures",
    )

    assert first == second
    assert len(first["runs"]) == 4
    assert first["finding_contract_version"] == "3.0"
    assert first["rescore_version"] == "offline-rescore-v4"
    assert first["semantic_rule_version"] == "semantic-v3-content-v1-conservative-v3"
    assert first["matcher_version"] == "semantic-v3-content-v1"
    assert first["source_matcher_versions"] == ["semantic-v3"]
    assert first["source_implementation_commit"]
    assert first["scoring_commit"]
    assert first["scoring_commit_role"] == (
        "HEAD base for the current scoring worktree"
    )
    assert first["source_artifact_manifest"]
    assert first["source_artifact_manifest_sha256"]
    assert isinstance(first["scoring_worktree_dirty"], bool)
    assert first["scoring_worktree_patch_sha256"]
    assert first["scoring_worktree_trace_error"] == ""
    assert all(run["finding_contract_version"] == "3.0" for run in first["runs"])
    assert all(
        run["token_accounting"]["component_sum_matches_measured"] is True
        for run in first["runs"]
        if run["token_accounting"]["verifier_total_tokens"] is not None
    )
    delivered = first["runs"][:3]
    assert [run["rescored_eligible_finding_count"] for run in delivered] == [2, 2, 3]
    assert [run["approved_finding_count"] for run in delivered] == [2, 2, 3]
    assert [run["location_matched_count"] for run in delivered] == [1, 1, 1]
    assert [run["severity_matched_count"] for run in delivered] == [1, 1, 1]
    assert [run["root_cause_matched_count"] for run in delivered] == [0, 0, 0]
    assert [run["repair_unit_matched_count"] for run in delivered] == [0, 0, 0]
    assert [run["duplicate_actual_count"] for run in delivered] == [0, 0, 0]
    assert [run["matched_count"] for run in delivered] == [0, 0, 0]
    assert sum(
        run["duplicate_candidate_pair_count"] > 0 for run in delivered
    ) >= 1
    pydantic_decisions = delivered[0]["finding_decisions"]
    assert pydantic_decisions[0]["diagnostic_expected_indexes"] == [0]
    assert all(item["matched_expected_indexes"] == [] for item in pydantic_decisions)
    assert all(
        detail["location_matched"] is True
        for run in delivered[:2]
        for detail in run["gold_match_details"]
    )
    assert all(
        detail["semantic_status"] == "undetermined"
        for run in delivered[:2]
        for detail in run["gold_match_details"]
    )
    assert all(
        not item["matched_expected_indexes"]
        for item in delivered[2]["finding_decisions"]
    )
    assert all(run["natural_stop"] for run in delivered)
    assert all(run["external_publish_status"] == "ready" for run in delivered)
    assert all(not run["external_publish_succeeded"] for run in delivered)
    assert first["runs"][-1]["malformed_verifier_diagnostics"]["status"].startswith(
        "historical_evidence_insufficient"
    )
    assert first["runs"][-1]["finding_run_status"] == "incomplete"
    assert first["runs"][-1]["report_ready"] is False
    assert first["runs"][-1]["rescored_eligible_finding_count"] == 0
