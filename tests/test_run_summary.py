"""Tests for event-log run summaries."""

from __future__ import annotations

import json
from pathlib import Path

from eval.run_summary import summarize_event_log


def test_summarize_event_log_collects_budget_submit_and_model_details(tmp_path: Path) -> None:
    log = tmp_path / "run.jsonl"
    events = [
        {
            "run_id": "run-1",
            "event_type": "model_response_detail",
            "phase": "analyze",
            "payload": {
                "model": "model-a",
                "usage": {"total_tokens": 12},
                "tool_call_summaries": [{"name": "read_file"}, {"name": "submit_review"}],
            },
        },
        {
            "run_id": "run-1",
            "event_type": "plan_parsed",
            "phase": "analyze",
            "payload": {
                "submit_review_seen": True,
                "submit_review_validation_error": "",
            },
        },
        {
            "run_id": "run-1",
            "event_type": "format_result",
            "phase": "format",
            "payload": {"used_placeholder_summary": False, "issues_count": 2},
        },
        {
            "run_id": "run-1",
            "event_type": "decision",
            "phase": "continue",
            "payload": {"reason": "budget_soft_capped", "budget_state": "soft_capped"},
        },
    ]
    log.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")

    summary = summarize_event_log(log)

    assert summary.run_id == "run-1"
    assert summary.event_log_status == "ok"
    assert summary.model_names == ["model-a"]
    assert summary.total_tokens == 12
    assert summary.tool_call_count == 2
    assert summary.submit_review_seen is True
    assert summary.issues_count == 2
    assert summary.budget_state == "soft_capped"
    assert summary.finish_reasons == ["budget_soft_capped"]


def test_summarize_event_log_reports_missing_and_parse_error(tmp_path: Path) -> None:
    missing = summarize_event_log(tmp_path / "missing.jsonl")
    assert missing.event_log_status == "missing"

    broken = tmp_path / "broken.jsonl"
    broken.write_text("{bad json", encoding="utf-8")
    parsed = summarize_event_log(broken)
    assert parsed.event_log_status == "parse_error"
    assert "Invalid JSON" in parsed.parse_error


def test_summarize_event_log_captures_invalid_submit_and_placeholder(tmp_path: Path) -> None:
    log = tmp_path / "run.jsonl"
    events = [
        {
            "run_id": "run-2",
            "event_type": "plan_parsed",
            "phase": "analyze",
            "payload": {
                "submit_review_seen": True,
                "submit_review_validation_error": "Invalid JSON arguments",
            },
        },
        {
            "run_id": "run-2",
            "event_type": "format_result",
            "phase": "format",
            "payload": {"used_placeholder_summary": True, "issues_count": 0},
        },
    ]
    log.write_text("\n".join(json.dumps(event) for event in events), encoding="utf-8")

    summary = summarize_event_log(log)

    assert summary.submit_validation_errors == ["Invalid JSON arguments"]
    assert summary.placeholder_summary is True
