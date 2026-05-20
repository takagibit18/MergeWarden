"""Persist Phase 2 readiness artifacts derived from eval reports."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel

from eval.diagnostics import build_eval_diagnostics
from eval.run_summary import summarize_eval_report
from eval.schemas import EvalReport


class EvalArtifactPaths(BaseModel):
    """Paths written for one eval report."""

    diagnostics_path: str
    run_summaries_path: str


def write_eval_artifacts(report: EvalReport, report_path: str | Path) -> EvalArtifactPaths:
    """Write diagnostics and run-summary artifacts next to an eval report."""
    report_file = Path(report_path)
    diagnostics_path = _artifact_path(report_file, "diagnostics")
    run_summaries_path = _artifact_path(report_file, "run_summaries")

    diagnostics_path.write_text(
        build_eval_diagnostics(report).model_dump_json(indent=2),
        encoding="utf-8",
    )
    run_summaries_path.write_text(
        summarize_eval_report(report, report_path=report_file).model_dump_json(indent=2),
        encoding="utf-8",
    )
    return EvalArtifactPaths(
        diagnostics_path=str(diagnostics_path),
        run_summaries_path=str(run_summaries_path),
    )


def _artifact_path(report_path: Path, suffix: str) -> Path:
    return report_path.with_name(f"{report_path.stem}_{suffix}.json")
