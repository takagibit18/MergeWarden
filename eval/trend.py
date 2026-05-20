"""Quality trend reports across multiple eval reports."""

from __future__ import annotations

import glob
from pathlib import Path

from pydantic import BaseModel, Field

from eval.schemas import EvalReport


class EvalTrendPoint(BaseModel):
    """One report in a trend series."""

    report_path: str
    generated_at: str
    schema_validity_rate: float
    hit_rate: float
    false_positive_rate: float
    avg_latency_seconds: float
    avg_total_tokens: float


class FixtureTrend(BaseModel):
    """Per-fixture hit/FP history."""

    fixture_id: str
    expected_count: int = 0
    hit_history: list[bool] = Field(default_factory=list)
    false_positive_history: list[int] = Field(default_factory=list)
    persistent_miss: bool = False


class QualityTrendReport(BaseModel):
    """Trend summary across reports."""

    reports: list[EvalTrendPoint] = Field(default_factory=list)
    best_report_path: str = ""
    baseline_report_path: str = ""
    fixture_trends: list[FixtureTrend] = Field(default_factory=list)
    persistent_misses: list[str] = Field(default_factory=list)


def expand_report_inputs(inputs: list[str] | tuple[str, ...]) -> list[Path]:
    paths: list[Path] = []
    for raw in inputs:
        matches = [Path(item) for item in glob.glob(raw)]
        if matches:
            paths.extend(matches)
        else:
            paths.append(Path(raw))
    return sorted({path.resolve() for path in paths if path.exists()})


def build_quality_trend(paths: list[str | Path]) -> QualityTrendReport:
    loaded: list[tuple[Path, EvalReport]] = [
        (Path(path), EvalReport.model_validate_json(Path(path).read_text(encoding="utf-8")))
        for path in paths
    ]
    loaded.sort(key=lambda item: item[1].generated_at)
    points = [_trend_point(path, report) for path, report in loaded]
    best = max(points, key=lambda item: item.hit_rate, default=None)
    baseline = points[-1] if points else None
    fixture_trends = _fixture_trends([report for _, report in loaded])
    return QualityTrendReport(
        reports=points,
        best_report_path=best.report_path if best else "",
        baseline_report_path=baseline.report_path if baseline else "",
        fixture_trends=fixture_trends,
        persistent_misses=[
            item.fixture_id
            for item in fixture_trends
            if item.expected_count > 0 and item.persistent_miss
        ],
    )


def _trend_point(path: Path, report: EvalReport) -> EvalTrendPoint:
    metrics = report.metrics
    return EvalTrendPoint(
        report_path=str(path),
        generated_at=report.generated_at,
        schema_validity_rate=metrics.schema_validity_rate,
        hit_rate=metrics.hit_rate,
        false_positive_rate=metrics.false_positive_rate,
        avg_latency_seconds=metrics.avg_latency_seconds,
        avg_total_tokens=metrics.avg_total_tokens,
    )


def _fixture_trends(reports: list[EvalReport]) -> list[FixtureTrend]:
    by_fixture: dict[str, FixtureTrend] = {}
    for report in reports:
        seen_this_report: set[str] = set()
        for result in report.results:
            trend = by_fixture.setdefault(
                result.fixture_id,
                FixtureTrend(
                    fixture_id=result.fixture_id,
                    expected_count=result.expected_count,
                ),
            )
            trend.expected_count = max(trend.expected_count, result.expected_count)
            trend.hit_history.append(
                result.expected_count > 0 and result.matched_count >= result.expected_count
            )
            trend.false_positive_history.append(result.false_positive_count)
            seen_this_report.add(result.fixture_id)
        for fixture_id, trend in by_fixture.items():
            if fixture_id not in seen_this_report:
                trend.hit_history.append(False)
                trend.false_positive_history.append(0)
    for trend in by_fixture.values():
        trend.persistent_miss = (
            trend.expected_count > 0 and bool(trend.hit_history) and not any(trend.hit_history)
        )
    return sorted(by_fixture.values(), key=lambda item: item.fixture_id)
