"""Tests for quality trend reports."""

import json
from pathlib import Path

from eval.trend import build_quality_trend, expand_report_inputs


def _write_report(path: Path, generated_at: str, fixture_hits: dict[str, tuple[int, int]]) -> None:
    results = []
    expected_total = 0
    matched_total = 0
    for fixture_id, (expected, matched) in fixture_hits.items():
        expected_total += expected
        matched_total += matched
        results.append(
            {
                "fixture_id": fixture_id,
                "fixture_type": "review",
                "schema_valid": True,
                "expected_count": expected,
                "actual_count": matched,
                "matched_count": matched,
                "false_positive_count": 0,
                "latency_seconds": 1.0,
                "total_tokens": 10,
            }
        )
    hit_rate = matched_total / expected_total if expected_total else 0.0
    path.write_text(
        json.dumps(
            {
                "suite": "golden",
                "generated_at": generated_at,
                "fixture_count": len(results),
                "metrics": {
                    "schema_validity_rate": 1.0,
                    "hit_rate": hit_rate,
                    "false_positive_rate": 0.0,
                    "avg_latency_seconds": 1.0,
                    "avg_total_tokens": 10,
                },
                "results": results,
            }
        ),
        encoding="utf-8",
    )


def test_quality_trend_tracks_best_report_and_persistent_miss(tmp_path: Path) -> None:
    r1 = tmp_path / "r1_report.json"
    r2 = tmp_path / "r2_report.json"
    _write_report(r1, "2026-05-18T01:00:00+00:00", {"a": (1, 0), "b": (1, 1)})
    _write_report(r2, "2026-05-18T02:00:00+00:00", {"a": (1, 0), "b": (1, 1)})

    trend = build_quality_trend([r1, r2])

    assert trend.baseline_report_path.endswith("r2_report.json")
    assert trend.best_report_path.endswith("r1_report.json")
    assert trend.persistent_misses == ["a"]
    fixture_a = next(item for item in trend.fixture_trends if item.fixture_id == "a")
    assert fixture_a.hit_history == [False, False]


def test_expand_report_inputs_accepts_globs(tmp_path: Path) -> None:
    (tmp_path / "a_report.json").write_text("{}", encoding="utf-8")
    (tmp_path / "b_report.json").write_text("{}", encoding="utf-8")

    paths = expand_report_inputs([str(tmp_path / "*_report.json")])

    assert len(paths) == 2
