"""Offline tests for v3 eval closeout, cost domains, and round contracts."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import eval.graph_ab_pilot as pilot
import eval.runner as runner
from eval.run_summary import extract_attempt_cost, extract_runtime_closeout
from eval.schemas import EvalResult, ReviewProcessMetrics


def _write_events(path: Path, events: list[dict[str, Any]]) -> Path:
    path.write_text(
        "\n".join(json.dumps(event) for event in events) + "\n",
        encoding="utf-8",
    )
    return path


def test_runtime_handoff_is_not_model_finish(tmp_path: Path, monkeypatch) -> None:
    events = [
        {
            "event_type": "model_call",
            "phase": "analyze",
            "payload": {"model_finish_reason": "stop"},
        },
        {
            "event_type": "tool_io",
            "phase": "execute_tools",
            "payload": {"name": "finish_review", "ok": False},
        },
        {
            "event_type": "finding_funnel_completed",
            "phase": "finding_funnel",
            "payload": {
                "finding_contract_version": "3.0",
                "run_status": "incomplete",
                "submission_received": True,
                "review_complete": False,
                "delivery_complete": False,
                "report_ready": False,
                "external_publish_status": "not_requested",
                "incomplete_reasons": ["iteration_guard", "pending_candidate"],
            },
        },
    ]
    log_path = _write_events(tmp_path / "closeout.jsonl", events)

    closeout = extract_runtime_closeout(log_path)

    assert closeout.finding_contract_version == "3.0"
    assert closeout.completion_status == "incomplete"
    assert closeout.submission_received is True
    assert closeout.finish_seen is False
    assert closeout.report_ready is False
    assert closeout.delivery_complete is False
    assert closeout.external_publish_status != "ready"
    assert closeout.incomplete_reasons == ["iteration_guard", "pending_candidate"]

    monkeypatch.setenv("EVENT_LOG_DIR", str(tmp_path))
    stats = runner._read_event_log_stats(tmp_path, "closeout")
    assert stats["submission_received"] is True
    assert stats["finish_seen"] is False
    assert stats["completion_status"] == "incomplete"


def test_successful_finish_review_is_a_separate_audit_fact(tmp_path: Path) -> None:
    log_path = _write_events(
        tmp_path / "finish.jsonl",
        [
            {
                "event_type": "tool_call",
                "phase": "execute_tools",
                "payload": {"name": "finish_review", "ok": True},
            },
            {
                "event_type": "finding_funnel_completed",
                "phase": "finding_funnel",
                "payload": {
                    "finding_contract_version": "3.0",
                    "run_status": "complete",
                    "submission_received": True,
                    "review_complete": True,
                    "delivery_complete": True,
                    "report_ready": True,
                    "external_publish_status": "ready",
                },
            },
        ],
    )

    closeout = extract_runtime_closeout(log_path)

    assert closeout.finish_seen is True
    assert closeout.submission_received is True
    assert closeout.completion_status == "complete"


def test_attempt_cost_includes_failed_attempts_and_unknown_usage(
    tmp_path: Path,
) -> None:
    log_path = _write_events(
        tmp_path / "cost.jsonl",
        [
            {
                "event_type": "model_call",
                "phase": "provider_attempt",
                "payload": {
                    "stage": "explore",
                    "success": True,
                    "usage_present": True,
                    "prompt_tokens": 80,
                    "completion_tokens": 20,
                    "reasoning_tokens": 5,
                    "total_tokens": 100,
                },
            },
            {
                "event_type": "model_call",
                "phase": "provider_attempt",
                "payload": {
                    "stage": "validate",
                    "success": False,
                    "usage_present": False,
                    "usage_unknown": True,
                },
            },
            {
                "event_type": "finding_verification_completed",
                "phase": "semantic_verify_findings",
                "payload": {
                    "verifier_kind": "semantic_model",
                    "provider_attempt_count": 2,
                    "failed_provider_attempt_count": 1,
                    "failed_unknown_usage_count": 0,
                    "prompt_tokens": 40,
                    "completion_tokens": 10,
                    "reasoning_tokens": 2,
                    "total_tokens": 50,
                },
            },
        ],
    )

    cost = extract_attempt_cost(log_path)

    assert cost.provider_attempt_count == 4
    assert cost.reviewer_provider_attempt_count == 2
    assert cost.verifier_provider_attempt_count == 2
    assert cost.successful_attempt_count == 2
    assert cost.failed_attempt_count == 2
    assert cost.unknown_usage_attempt_count == 1
    assert cost.usage_known is False
    assert cost.cost_status == "partial_unknown_usage"
    assert cost.total_tokens is None
    assert cost.reviewer_total_tokens is None
    assert cost.verifier_total_tokens == 50
    assert cost.successful_total_tokens == 150


def _record(
    *,
    tmp_path: Path,
    run_id: str,
    valid: bool,
    total_tokens: int | None,
    completion_status: str,
    provider_payload: dict[str, Any],
    error: str | None = None,
    expected_count: int = 1,
    matched_count: int | None = None,
    approved_finding_count: int = 0,
) -> dict[str, Any]:
    log_path = _write_events(
        tmp_path / f"{run_id}.jsonl",
        [
            {
                "event_type": "model_call",
                "phase": "provider_attempt",
                "payload": provider_payload,
            }
        ],
    )
    raw_output = {
        "finding_contract_version": "3.0",
        "report": {"schema_version": "3.0", "summary": "review"},
        "completion_status": completion_status,
        "finding_run_status": completion_status,
        "submission_received": True,
        "review_complete": completion_status == "complete",
        "delivery_complete": completion_status == "complete",
        "report_ready": completion_status == "complete",
        "external_publish_status": (
            "ready" if completion_status == "complete" else "not_requested"
        ),
        "incomplete_reasons": (
            [] if completion_status == "complete" else ["iteration_guard"]
        ),
    }
    measured_matched_count = (
        matched_count if matched_count is not None else (1 if valid else 0)
    )
    result = EvalResult(
        fixture_id="fixture",
        fixture_type="review",
        variant_id="A-agent-search",
        context_mode="agent_search",
        graph_cache_mode="disabled",
        matcher_version="semantic-v3-content-v1",
        finding_contract_version="3.0",
        run_id=run_id,
        schema_valid=valid,
        expected_count=expected_count,
        actual_count=measured_matched_count if valid else 0,
        approved_finding_count=approved_finding_count,
        matched_count=measured_matched_count,
        false_positive_count=0,
        total_tokens=total_tokens or 0,
        event_log_path=str(log_path),
        error=error,
        raw_output=raw_output,
        process_metrics=ReviewProcessMetrics(
            context_mode="agent_search",
            event_log_status="ok",
        ),
    )
    contract = pilot.VariantContractResult(
        expected_variant_id="A-agent-search",
        expected_context_mode="agent_search",
        expected_graph_cache_mode="not_applicable",
        actual_context_mode="agent_search",
        actual_graph_status="disabled",
        actual_graph_cache_mode="not_applicable",
        actual_cache_hit=None,
        actual_manifest_count=0,
        fallback_reason="",
        valid=valid,
        errors=[] if valid else ["run_error"],
    )
    return pilot.PilotRunRecord(
        fixture_id="fixture",
        fixture_types=["local"],
        repository_snapshot="snapshot",
        sample=1,
        order=1,
        variant_id="A-agent-search",
        run_id=run_id,
        valid=valid,
        invalid_reasons=[] if valid else ["run_error"],
        contract=contract,
        result=result,
    ).model_dump(mode="json")


def test_compact_summary_keeps_quality_and_cost_domains_separate(
    tmp_path: Path,
) -> None:
    records = [
        _record(
            tmp_path=tmp_path,
            run_id="complete",
            valid=True,
            total_tokens=10,
            completion_status="complete",
            provider_payload={
                "stage": "explore",
                "success": True,
                "usage_present": True,
                "total_tokens": 10,
            },
        ),
        _record(
            tmp_path=tmp_path,
            run_id="incomplete",
            valid=True,
            total_tokens=None,
            completion_status="incomplete",
            provider_payload={
                "stage": "explore",
                "success": False,
                "usage_present": False,
                "usage_unknown": True,
            },
            expected_count=2,
            matched_count=1,
            approved_finding_count=1,
        ),
        _record(
            tmp_path=tmp_path,
            run_id="invalid",
            valid=False,
            total_tokens=20,
            completion_status="incomplete",
            error="workspace failure",
            provider_payload={
                "stage": "explore",
                "success": True,
                "usage_present": True,
                "total_tokens": 20,
            },
        ),
    ]
    payload = {
        "experiment_id": "offline-closeout",
        "generated_at": "2026-09-11T00:00:00+00:00",
        "branch": "test",
        "start_commit": "a" * 40,
        "implementation_commit": "b" * 40,
        "frozen_baseline_tag": "eval/agent-baseline-v1",
        "frozen_baseline_target": "c" * 40,
        "formal_graph_ab": False,
        "held_out_executed": False,
        "seed": 20260910,
        "samples": 1,
        "variant_sample_counts": {"A-agent-search": 3},
        "round_contract": {
            "requested_rounds": 16,
            "effective_rounds": 16,
            "round_cap": 16,
        },
        "suite": "test",
        "shared_contract": {},
        "pairing_errors": [],
        "records": records,
    }

    summary = pilot.compact_summary(payload)
    variant = summary["variants"]["A-agent-search"]

    assert variant["valid_runs"] == 2
    assert variant["invalid_runs"] == 1
    assert variant["quality_runs"] == 2
    assert variant["quality_sample_domain"] == "runner_valid_runs_only"
    assert variant["quality_sample_includes_incomplete"] is True
    assert len(variant["quality"]) == 2
    assert variant["quality_gate_eligible_runs"] == 1
    assert abs(variant["aggregate_quality"]["overall_recall"] - (2 / 3)) < 1e-9
    assert variant["complete_delivery"]["sample_domain"] == (
        "runner_valid_runs_with_complete_delivery_gates_only"
    )
    assert variant["complete_delivery"]["runs"] == 1
    assert variant["complete_delivery"]["run_ids"] == ["complete"]
    assert variant["complete_delivery"]["aggregate_quality"]["overall_recall"] == 1.0
    assert [row["run_id"] for row in variant["complete_delivery"]["quality"]] == [
        "complete"
    ]
    assert variant["delivery"]["sample_domain"] == "all_attempts_including_invalid"
    assert variant["delivery"]["attempt_count"] == 3
    assert variant["delivery"]["delivery_complete_count"] == 1
    assert variant["delivery"]["delivery_complete_rate"] == (1 / 3)
    assert variant["delivery"]["invalid_attempt_count"] == 1
    assert variant["delivery_complete_rate"] == (1 / 3)
    assert [item["run_id"] for item in variant["complete_delivery_gate_excluded"]] == [
        "incomplete"
    ]
    assert {item["run_id"] for item in variant["quality_gate_excluded_runs"]} == {
        "incomplete",
        "invalid",
    }
    assert [item["run_id"] for item in variant["quality_excluded_runs"]] == ["invalid"]
    assert summary["delivery"]["sample_domain"] == "all_attempts_including_invalid"
    assert summary["delivery"]["attempt_count"] == 3
    assert summary["delivery"]["delivery_complete_count"] == 1
    assert summary["delivery"]["delivery_complete_rate"] == (1 / 3)
    assert len(variant["cost"]) == 3
    assert {row["run_id"] for row in variant["cost"]} == {
        "complete",
        "incomplete",
        "invalid",
    }
    assert variant["aggregate_cost"]["sample_domain"] == (
        "all_attempts_including_invalid"
    )
    assert variant["aggregate_cost"]["provider_attempt_count"] == 3
    assert variant["aggregate_cost"]["unknown_usage_attempt_count"] == 1
    assert variant["aggregate_cost"]["total_tokens"] is None
    assert summary["runner_readiness"] is True
    assert summary["quality_readiness"] is False


def test_round_contract_and_new_configs_are_offline_and_aligned(monkeypatch) -> None:
    monkeypatch.setenv("EVAL_REVIEW_MAX_ITERATIONS_CAP", "16")
    monkeypatch.setenv("EVAL_REVIEW_MIN_TOOL_ITERATIONS", "1")

    normal_contract = runner.review_iteration_contract(16)
    pressure_contract = runner.review_iteration_contract(3)
    assert normal_contract["requested_rounds"] == 16
    assert normal_contract["effective_rounds"] == 16
    assert normal_contract["round_cap"] == 16
    assert pressure_contract["requested_rounds"] == 3
    assert pressure_contract["effective_rounds"] == 3

    root = Path("eval/variants")
    paid = pilot._load_config(
        root / "finding-delivery-python-three-v3-aligned-paid-20260911.yaml"
    )
    normal = pilot._load_config(
        root / "finding-delivery-python-three-v3-aligned-normal-16-round-20260911.yaml"
    )
    pressure = pilot._load_config(
        root / "finding-delivery-python-three-v3-aligned-pressure-3-round-20260911.yaml"
    )
    for candidate in (normal, pressure):
        assert candidate["provider"] == paid["provider"]
        assert candidate["base_url"] == paid["base_url"]
        assert candidate["seed"] == paid["seed"]
        assert candidate["matcher_version"] == paid["matcher_version"]
        assert candidate["variants"] == paid["variants"]
        assert {
            key: value
            for key, value in candidate["shared"].items()
            if key != "max_iterations"
        } == {
            key: value
            for key, value in paid["shared"].items()
            if key != "max_iterations"
        }
    assert normal["round_profile"] == "normal"
    assert normal["shared"]["max_iterations"] == 16
    assert pressure["round_profile"] == "pressure"
    assert pressure["shared"]["max_iterations"] == 3
