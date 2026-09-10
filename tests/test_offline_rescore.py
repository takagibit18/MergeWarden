"""Determinism and accounting checks for the persisted v3 re-scorer."""

from __future__ import annotations

from pathlib import Path

import pytest

from eval.offline_rescore import rescore_experiment


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "eval" / "outputs" / "finding-delivery-python-ab-20260910-v3-zhipu"
RAW = OUTPUT_ROOT / "raw.json"
SUMMARY = ROOT / "eval" / "experiments" / "finding-delivery-python-ab-20260910-v3-zhipu-summary.json"
CHECKPOINT = OUTPUT_ROOT / "checkpoint.jsonl"


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
    assert all(run["finding_contract_version"] == "3.0" for run in first["runs"])
    assert all(
        run["token_accounting"]["component_sum_matches_measured"] is True
        for run in first["runs"]
        if run["token_accounting"]["verifier_total_tokens"] is not None
    )
    delivered = first["runs"][:3]
    assert [run["rescored_eligible_finding_count"] for run in delivered] == [2, 2, 3]
    assert all(run["natural_stop"] for run in delivered)
    assert all(run["external_publish_status"] == "ready" for run in delivered)
    assert all(not run["external_publish_succeeded"] for run in delivered)
    assert first["runs"][-1]["malformed_verifier_diagnostics"]["status"].startswith(
        "historical_evidence_insufficient"
    )
