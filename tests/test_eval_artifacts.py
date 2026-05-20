"""Tests for Phase 2 eval artifact persistence."""

import json
from pathlib import Path

from eval.artifacts import write_eval_artifacts
from eval.schemas import EvalReport, EvalResult


def test_write_eval_artifacts_creates_diagnostics_and_run_summaries(tmp_path: Path) -> None:
    report = EvalReport(
        suite="golden",
        results=[
            EvalResult(
                fixture_id="fixture-a",
                fixture_type="review",
                schema_valid=True,
                expected_count=1,
                actual_count=0,
                matched_count=0,
            )
        ],
    )
    report_path = tmp_path / "report.json"
    report_path.write_text(report.model_dump_json(), encoding="utf-8")

    paths = write_eval_artifacts(report, report_path)

    diagnostics = json.loads(Path(paths.diagnostics_path).read_text(encoding="utf-8"))
    summaries = json.loads(Path(paths.run_summaries_path).read_text(encoding="utf-8"))
    assert diagnostics["fixtures"][0]["fixture_id"] == "fixture-a"
    assert summaries["runs"][0]["event_log_status"] == "missing"
