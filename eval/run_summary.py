"""Eval-specific wrappers around runtime run-summary helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal, Mapping

from pydantic import BaseModel, Field

from eval.schemas import (
    DEFAULT_EVAL_MATCHER_VERSION,
    EvalReport,
    ReviewProcessMetrics,
)
from src.analyzer.finding_funnel import FindingFunnel
from src.analyzer.run_summary import RunSummary, summarize_event_log


class EvalRunSummaryReport(BaseModel):
    """Run summaries for every fixture in one eval report."""

    suite: str
    generated_at: str
    matcher_version: str = DEFAULT_EVAL_MATCHER_VERSION
    finding_contract_version: str = "unknown"
    report_path: str = ""
    runs: list[RunSummary] = Field(default_factory=list)


class EvalRuntimeCloseout(BaseModel):
    """Auditable runtime closeout facts kept separate from model finish facts.

    ``submission_received`` is deliberately a handoff fact.  For finding
    contract 3.0 it means that the runtime handed its current Registry
    candidate set to the downstream gates; it is not evidence that the model
    called ``finish_review``.  ``finish_seen`` is populated only from a
    successful tool event in the event timeline.
    """

    schema_version: str = "eval-runtime-closeout-v1"
    finding_contract_version: str = "unknown"
    completion_status: Literal["complete", "incomplete", "unknown"] = "unknown"
    finding_run_status: str = ""
    finish_seen: bool = False
    investigation_ready: bool = False
    submission_received: bool = False
    review_complete: bool = False
    delivery_complete: bool = False
    report_ready: bool = False
    external_publish_status: str = "not_requested"
    incomplete_reasons: list[str] = Field(default_factory=list)


class EvalAttemptCost(BaseModel):
    """Attempt-level token accounting for one eval run.

    Costs include unsuccessful provider attempts.  A run with an attempt whose
    usage is unavailable retains ``None`` for the affected total rather than
    turning the missing usage into a misleading zero.
    """

    schema_version: str = "eval-attempt-cost-v1"
    provider_attempt_count: int = Field(default=0, ge=0)
    reviewer_provider_attempt_count: int = Field(default=0, ge=0)
    verifier_provider_attempt_count: int = Field(default=0, ge=0)
    successful_attempt_count: int = Field(default=0, ge=0)
    failed_attempt_count: int = Field(default=0, ge=0)
    known_usage_attempt_count: int = Field(default=0, ge=0)
    unknown_usage_attempt_count: int = Field(default=0, ge=0)
    reviewer_unknown_usage_attempt_count: int = Field(default=0, ge=0)
    verifier_unknown_usage_attempt_count: int = Field(default=0, ge=0)
    usage_known: bool = True
    cost_status: Literal["no_provider_attempt", "complete", "partial_unknown_usage"] = (
        "no_provider_attempt"
    )
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    reasoning_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)
    successful_prompt_tokens: int = Field(default=0, ge=0)
    successful_completion_tokens: int = Field(default=0, ge=0)
    successful_reasoning_tokens: int = Field(default=0, ge=0)
    successful_total_tokens: int = Field(default=0, ge=0)
    successful_cached_prompt_tokens: int = Field(default=0, ge=0)
    successful_adjacent_common_prefix_tokens: int = Field(default=0, ge=0)
    reviewer_total_tokens: int | None = Field(default=0, ge=0)
    verifier_total_tokens: int | None = Field(default=0, ge=0)


def extract_runtime_closeout(
    event_log_path: str | Path | None,
    *,
    raw_output: Mapping[str, Any] | None = None,
    finding_contract_version: str | None = None,
) -> EvalRuntimeCloseout:
    """Extract closeout status without treating handoff as model finish.

    Status fields may be recovered from the response envelope when an event
    log is unavailable, but ``finish_seen`` never is: only a successful
    ``finish_review`` tool event is authoritative for that audit fact.
    """

    raw = raw_output if isinstance(raw_output, Mapping) else {}
    contract_version = _first_non_empty_string(
        finding_contract_version,
        raw.get("finding_contract_version"),
        _nested_report_value(raw, "schema_version"),
    ) or "unknown"
    completion_status: str | None = None
    finding_run_status: str | None = None
    submission_received: bool | None = None
    investigation_ready: bool | None = None
    review_complete: bool | None = None
    delivery_complete: bool | None = None
    report_ready: bool | None = None
    external_publish_status: str | None = None
    incomplete_reasons: list[str] | None = None
    finish_seen = False

    path = Path(event_log_path) if event_log_path else None
    if path is not None and path.is_file():
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            lines = []
        for raw_line in lines:
            if not raw_line.strip():
                continue
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            payload = event.get("payload", {})
            if not isinstance(payload, Mapping):
                payload = {}
            event_type = str(event.get("event_type", ""))
            phase = str(event.get("phase", ""))

            # TOOL_CALL and TOOL_IO are two projections of the same action in
            # current timelines.  This is a boolean audit fact, so observing
            # both must not double count it.
            if event_type in {"tool_call", "tool_io"}:
                name = _first_non_empty_string(
                    payload.get("name"), payload.get("tool_name")
                )
                if name == "finish_review" and payload.get("ok") is True:
                    finish_seen = True

            if event_type == "finding_funnel_completed" or (
                event_type == "phase_end" and phase == "review_complete"
            ):
                candidate_contract = _first_non_empty_string(
                    payload.get("finding_contract_version")
                )
                if candidate_contract:
                    contract_version = candidate_contract
                status = _first_non_empty_string(
                    payload.get("completion_status"),
                    payload.get("finding_run_status"),
                    payload.get("run_status"),
                )
                if status in {"complete", "incomplete"}:
                    completion_status = status
                    finding_run_status = status
                for name in (
                    "investigation_ready",
                    "submission_received",
                    "review_complete",
                    "delivery_complete",
                    "report_ready",
                ):
                    value = payload.get(name)
                    if isinstance(value, bool):
                        if name == "submission_received":
                            submission_received = value
                        elif name == "investigation_ready":
                            investigation_ready = value
                        elif name == "review_complete":
                            review_complete = value
                        elif name == "delivery_complete":
                            delivery_complete = value
                        else:
                            report_ready = value
                publish_status = payload.get("external_publish_status")
                if isinstance(publish_status, str) and publish_status.strip():
                    external_publish_status = publish_status.strip()
                reasons = payload.get("incomplete_reasons")
                if isinstance(reasons, list):
                    incomplete_reasons = [
                        str(reason).strip()
                        for reason in reasons
                        if str(reason).strip()
                    ]

    # Status fallback is intentionally limited to explicit response fields.
    # In particular, do not read a cached ``finish_seen`` value from a result
    # projection: that would allow a report artifact to manufacture the model
    # finish audit.
    raw_status = _runtime_status_mapping(raw)
    if not contract_version or contract_version == "unknown":
        contract_version = _first_non_empty_string(
            raw_status.get("finding_contract_version")
        ) or "unknown"
    if completion_status is None:
        candidate = _first_non_empty_string(
            raw.get("completion_status"),
            raw.get("finding_run_status"),
            raw_status.get("completion_status"),
            raw_status.get("finding_run_status"),
        )
        if candidate in {"complete", "incomplete"}:
            completion_status = candidate
    if finding_run_status is None:
        candidate = _first_non_empty_string(
            raw.get("finding_run_status"),
            raw.get("completion_status"),
            raw_status.get("finding_run_status"),
            raw_status.get("completion_status"),
        )
        if candidate:
            finding_run_status = candidate
    for name in (
        "investigation_ready",
        "submission_received",
        "review_complete",
        "delivery_complete",
        "report_ready",
    ):
        raw_value = raw.get(name)
        if not isinstance(raw_value, bool):
            raw_value = raw_status.get(name)
        if locals()[name] is None and isinstance(raw_value, bool):
            if name == "investigation_ready":
                investigation_ready = raw_value
            elif name == "submission_received":
                submission_received = raw_value
            elif name == "review_complete":
                review_complete = raw_value
            elif name == "delivery_complete":
                delivery_complete = raw_value
            else:
                report_ready = raw_value
    if external_publish_status is None:
        raw_publish_status = raw.get(
            "external_publish_status", raw_status.get("external_publish_status")
        )
        if isinstance(raw_publish_status, str) and raw_publish_status.strip():
            external_publish_status = raw_publish_status.strip()
    if incomplete_reasons is None:
        raw_reasons = raw.get("incomplete_reasons", raw_status.get("incomplete_reasons"))
        if isinstance(raw_reasons, list):
            incomplete_reasons = [
                str(reason).strip()
                for reason in raw_reasons
                if str(reason).strip()
            ]

    if completion_status is None and finding_run_status in {"complete", "incomplete"}:
        completion_status = finding_run_status
    return EvalRuntimeCloseout(
        finding_contract_version=contract_version,
        completion_status=completion_status or "unknown",
        finding_run_status=finding_run_status or "",
        finish_seen=finish_seen,
        investigation_ready=bool(investigation_ready),
        submission_received=bool(submission_received),
        review_complete=bool(review_complete),
        delivery_complete=bool(delivery_complete),
        report_ready=bool(report_ready),
        external_publish_status=external_publish_status or "not_requested",
        incomplete_reasons=incomplete_reasons or [],
    )


def extract_attempt_cost(
    event_log_path: str | Path | None,
    *,
    metrics: ReviewProcessMetrics | None = None,
    fallback_total_tokens: int | None = None,
) -> EvalAttemptCost:
    """Reconcile all provider attempts into reviewer/verifier/total cost.

    The runtime emits reviewer attempts as ``model_call/provider_attempt``
    events and semantic verifier aggregates as a
    ``finding_verification_completed`` event.  If a direct verifier attempt
    stream is present, its aggregate event is not counted a second time.
    """

    events = _read_jsonl_events(event_log_path)
    provider_rows = [
        event
        for event in events
        if event.get("event_type") == "model_call"
        and event.get("phase") == "provider_attempt"
    ]
    verifier_provider_rows = [
        event for event in provider_rows if _is_verifier_event(event)
    ]
    reviewer_provider_rows = [
        event for event in provider_rows if not _is_verifier_event(event)
    ]
    semantic_rows = [
        event
        for event in events
        if event.get("event_type") == "finding_verification_completed"
        and _is_verifier_event(event)
        and isinstance(event.get("payload"), Mapping)
        and "provider_attempt_count" in event["payload"]
    ]

    reviewer = _cost_from_attempt_rows(reviewer_provider_rows)
    verifier = _cost_from_attempt_rows(verifier_provider_rows)
    verifier_from_events = bool(verifier_provider_rows)
    if not verifier_from_events:
        verifier = _cost_from_semantic_rows(semantic_rows)

    if not provider_rows and not semantic_rows and metrics is not None:
        return _cost_from_metrics(metrics, fallback_total_tokens)

    provider_attempt_count = (
        reviewer["attempt_count"] + verifier["attempt_count"]
    )
    failed_attempt_count = reviewer["failed_count"] + verifier["failed_count"]
    known_usage_attempt_count = (
        reviewer["known_count"] + verifier["known_count"]
    )
    unknown_usage_attempt_count = (
        reviewer["unknown_count"] + verifier["unknown_count"]
    )
    total_tokens = (
        reviewer["total_tokens"] + verifier["total_tokens"]
        if unknown_usage_attempt_count == 0
        else None
    )
    reviewer_total_tokens = (
        reviewer["total_tokens"]
        if reviewer["unknown_count"] == 0
        else None
    )
    verifier_total_tokens = (
        verifier["total_tokens"]
        if verifier["unknown_count"] == 0
        else None
    )
    if provider_attempt_count == 0:
        cost_status: Literal[
            "no_provider_attempt", "complete", "partial_unknown_usage"
        ] = "no_provider_attempt"
    elif unknown_usage_attempt_count:
        cost_status = "partial_unknown_usage"
    else:
        cost_status = "complete"
    return EvalAttemptCost(
        provider_attempt_count=provider_attempt_count,
        reviewer_provider_attempt_count=reviewer["attempt_count"],
        verifier_provider_attempt_count=verifier["attempt_count"],
        successful_attempt_count=reviewer["successful_count"]
        + verifier["successful_count"],
        failed_attempt_count=failed_attempt_count,
        known_usage_attempt_count=known_usage_attempt_count,
        unknown_usage_attempt_count=unknown_usage_attempt_count,
        reviewer_unknown_usage_attempt_count=reviewer["unknown_count"],
        verifier_unknown_usage_attempt_count=verifier["unknown_count"],
        usage_known=unknown_usage_attempt_count == 0,
        cost_status=cost_status,
        prompt_tokens=_sum_or_none(reviewer["prompt_tokens"], verifier["prompt_tokens"]),
        completion_tokens=_sum_or_none(
            reviewer["completion_tokens"], verifier["completion_tokens"]
        ),
        reasoning_tokens=_sum_or_none(
            reviewer["reasoning_tokens"], verifier["reasoning_tokens"]
        ),
        total_tokens=total_tokens,
        successful_prompt_tokens=reviewer["successful_prompt_tokens"]
        + verifier["successful_prompt_tokens"],
        successful_completion_tokens=reviewer["successful_completion_tokens"]
        + verifier["successful_completion_tokens"],
        successful_reasoning_tokens=reviewer["successful_reasoning_tokens"]
        + verifier["successful_reasoning_tokens"],
        successful_total_tokens=reviewer["successful_total_tokens"]
        + verifier["successful_total_tokens"],
        successful_cached_prompt_tokens=reviewer["successful_cached_prompt_tokens"]
        + verifier["successful_cached_prompt_tokens"],
        successful_adjacent_common_prefix_tokens=(
            reviewer["successful_adjacent_common_prefix_tokens"]
            + verifier["successful_adjacent_common_prefix_tokens"]
        ),
        reviewer_total_tokens=reviewer_total_tokens,
        verifier_total_tokens=verifier_total_tokens,
    )


def _read_jsonl_events(event_log_path: str | Path | None) -> list[dict[str, Any]]:
    """Read parseable event rows without making a malformed log look valid."""

    if not event_log_path:
        return []
    path = Path(event_log_path)
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return []
    events: list[dict[str, Any]] = []
    for raw_line in lines:
        if not raw_line.strip():
            continue
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _first_non_empty_string(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _nested_report_value(raw: Mapping[str, Any], key: str) -> object:
    report = raw.get("report")
    return report.get(key) if isinstance(report, Mapping) else None


def _runtime_status_mapping(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return a cached status projection, excluding finish audit semantics."""

    direct = raw.get("eval_runtime_closeout")
    if isinstance(direct, Mapping):
        return direct
    runtime = raw.get("eval_runtime")
    if isinstance(runtime, Mapping):
        closeout = runtime.get("closeout")
        if isinstance(closeout, Mapping):
            return closeout
    return {}


def _is_verifier_event(event: Mapping[str, Any]) -> bool:
    payload = event.get("payload", {})
    if not isinstance(payload, Mapping):
        payload = {}
    phase = str(event.get("phase", "")).strip().lower()
    stage = _first_non_empty_string(
        payload.get("stage"), payload.get("logical_stage")
    ).lower()
    verifier_kind = str(payload.get("verifier_kind", "")).strip().lower()
    return (
        phase in {"semantic_verify_findings", "semantic_verifier", "semantic_investigation"}
        or stage in {"semantic_verify_findings", "semantic_verifier", "semantic_investigation"}
        or "semantic" in phase
        or "semantic" in stage
        or verifier_kind == "semantic_model"
    )


def _empty_cost_bucket() -> dict[str, Any]:
    return {
        "attempt_count": 0,
        "successful_count": 0,
        "failed_count": 0,
        "known_count": 0,
        "unknown_count": 0,
        "total_tokens": 0,
        "prompt_tokens": None,
        "completion_tokens": None,
        "reasoning_tokens": None,
        "successful_prompt_tokens": 0,
        "successful_completion_tokens": 0,
        "successful_reasoning_tokens": 0,
        "successful_total_tokens": 0,
        "successful_cached_prompt_tokens": 0,
        "successful_adjacent_common_prefix_tokens": 0,
        "prompt_missing": False,
        "completion_missing": False,
        "reasoning_missing": False,
    }


def _cost_from_attempt_rows(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    bucket = _empty_cost_bucket()
    for event in rows:
        payload = event.get("payload", {})
        if not isinstance(payload, Mapping):
            payload = {}
        bucket["attempt_count"] += 1
        success = payload.get("success") is True
        bucket["successful_count"] += int(success)
        bucket["failed_count"] += int(not success)
        total_tokens = _token_or_none(payload.get("total_tokens"))
        usage_present = payload.get("usage_present") is True
        usage_known = usage_present and total_tokens is not None
        if usage_known:
            bucket["known_count"] += 1
            bucket["total_tokens"] += total_tokens
            for field_name, missing_name in (
                ("prompt_tokens", "prompt_missing"),
                ("completion_tokens", "completion_missing"),
                ("reasoning_tokens", "reasoning_missing"),
            ):
                value = _token_or_none(payload.get(field_name))
                if value is None:
                    bucket[missing_name] = True
                else:
                    bucket[field_name] = (bucket[field_name] or 0) + value
            if success:
                bucket["successful_prompt_tokens"] += _non_negative_int(
                    payload.get("prompt_tokens")
                )
                bucket["successful_completion_tokens"] += _non_negative_int(
                    payload.get("completion_tokens")
                )
                bucket["successful_reasoning_tokens"] += _non_negative_int(
                    payload.get("reasoning_tokens")
                )
                bucket["successful_total_tokens"] += total_tokens
                bucket["successful_cached_prompt_tokens"] += _non_negative_int(
                    payload.get("cached_prompt_tokens")
                )
                bucket[
                    "successful_adjacent_common_prefix_tokens"
                ] += _non_negative_int(payload.get("adjacent_common_prefix_tokens"))
        else:
            bucket["unknown_count"] += 1
    if bucket["attempt_count"] == 0:
        bucket["prompt_tokens"] = None
        bucket["completion_tokens"] = None
        bucket["reasoning_tokens"] = None
    else:
        for field_name, missing_name in (
            ("prompt_tokens", "prompt_missing"),
            ("completion_tokens", "completion_missing"),
            ("reasoning_tokens", "reasoning_missing"),
        ):
            if bucket[missing_name]:
                bucket[field_name] = None
    return bucket


def _cost_from_semantic_rows(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    bucket = _empty_cost_bucket()
    for event in rows:
        payload = event.get("payload", {})
        if not isinstance(payload, Mapping):
            continue
        attempts = _non_negative_int(payload.get("provider_attempt_count"))
        failed = min(
            attempts,
            _non_negative_int(
                payload.get(
                    "failed_provider_attempt_count",
                    payload.get("failed_attempt_count"),
                )
            ),
        )
        unknown = min(
            attempts,
            _non_negative_int(payload.get("failed_unknown_usage_count")),
        )
        total_tokens = _token_or_none(payload.get("total_tokens"))
        if attempts and total_tokens is None:
            unknown = attempts
        bucket["attempt_count"] += attempts
        bucket["failed_count"] += failed
        bucket["successful_count"] += max(0, attempts - failed)
        bucket["unknown_count"] += unknown
        bucket["known_count"] += max(0, attempts - unknown)
        if total_tokens is not None and unknown == 0:
            bucket["total_tokens"] += total_tokens
            bucket["successful_total_tokens"] += total_tokens
        elif total_tokens is not None:
            # The runtime's semantic aggregate is the successful/known token
            # total.  Preserve that diagnostic even though the all-attempt
            # total remains unknown because at least one attempt is missing.
            bucket["successful_total_tokens"] += total_tokens
        for field_name in (
            "prompt_tokens",
            "completion_tokens",
            "reasoning_tokens",
        ):
            value = _token_or_none(payload.get(field_name))
            if value is not None:
                bucket[field_name] = (bucket[field_name] or 0) + value
        bucket["successful_prompt_tokens"] += _non_negative_int(
            payload.get("prompt_tokens")
        )
        bucket["successful_completion_tokens"] += _non_negative_int(
            payload.get("completion_tokens")
        )
        bucket["successful_reasoning_tokens"] += _non_negative_int(
            payload.get("reasoning_tokens")
        )
        bucket["successful_cached_prompt_tokens"] += _non_negative_int(
            payload.get("cached_prompt_tokens")
        )
        bucket[
            "successful_adjacent_common_prefix_tokens"
        ] += _non_negative_int(payload.get("adjacent_common_prefix_tokens"))
    return bucket


def _cost_from_metrics(
    metrics: ReviewProcessMetrics,
    fallback_total_tokens: int | None,
) -> EvalAttemptCost:
    attempts = max(0, int(metrics.provider_attempt_count))
    failed = max(0, int(metrics.failed_attempt_count))
    unknown = max(0, int(metrics.failed_unknown_usage_count))
    total_value = (
        fallback_total_tokens
        if fallback_total_tokens is not None
        else metrics.total_tokens
    )
    total_tokens = None if unknown else max(0, int(total_value or 0))
    if attempts == 0:
        status: Literal["no_provider_attempt", "complete", "partial_unknown_usage"] = (
            "no_provider_attempt"
        )
    elif unknown:
        status = "partial_unknown_usage"
    else:
        status = "complete"
    return EvalAttemptCost(
        provider_attempt_count=attempts,
        reviewer_provider_attempt_count=attempts,
        successful_attempt_count=max(0, attempts - failed),
        failed_attempt_count=failed,
        known_usage_attempt_count=max(0, attempts - unknown),
        unknown_usage_attempt_count=unknown,
        reviewer_unknown_usage_attempt_count=unknown,
        usage_known=unknown == 0,
        cost_status=status,
        total_tokens=total_tokens,
        successful_prompt_tokens=metrics.successful_prompt_tokens,
        successful_completion_tokens=metrics.successful_completion_tokens,
        successful_reasoning_tokens=metrics.successful_reasoning_tokens,
        successful_total_tokens=metrics.successful_total_tokens,
        successful_cached_prompt_tokens=metrics.successful_cached_prompt_tokens,
        successful_adjacent_common_prefix_tokens=(
            metrics.successful_adjacent_common_prefix_tokens
        ),
        reviewer_total_tokens=(
            None if unknown else metrics.reviewer_total_tokens or total_tokens or 0
        ),
        verifier_total_tokens=metrics.verifier_total_tokens,
    )


def _sum_or_none(left: int | None, right: int | None) -> int | None:
    if left is None and right is None:
        return None
    return (left or 0) + (right or 0)


def _token_or_none(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return max(0, parsed)


def summarize_eval_report(
    report: EvalReport,
    *,
    report_path: str | Path | None = None,
) -> EvalRunSummaryReport:
    """Summarize all event logs referenced by an eval report."""
    return EvalRunSummaryReport(
        suite=report.suite,
        generated_at=report.generated_at,
        matcher_version=report.matcher_version,
        finding_contract_version=report.finding_contract_version,
        report_path=str(report_path or ""),
        runs=[summarize_event_log(item.event_log_path) for item in report.results],
    )


def extract_review_process_metrics(
    event_log_path: str | Path | None,
    *,
    matcher_version: str = DEFAULT_EVAL_MATCHER_VERSION,
) -> ReviewProcessMetrics:
    """Extract process metrics from one JSONL event timeline."""
    metrics = ReviewProcessMetrics(matcher_version=matcher_version)
    reviewer_usage_seen = False
    reviewer_total_tokens = 0
    if not event_log_path:
        return metrics
    path = Path(event_log_path)
    if not path.is_file():
        return metrics
    metrics.event_log_status = "ok"
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            metrics.event_log_status = "parse_error"
            return metrics
        payload = event.get("payload", {}) or {}
        event_type = str(event.get("event_type", ""))
        phase = str(event.get("phase", ""))
        payload_matcher_version = payload.get("matcher_version")
        if isinstance(payload_matcher_version, str) and payload_matcher_version:
            metrics.matcher_version = payload_matcher_version
        if event_type == "decision" and phase == "continue":
            reason = str(payload.get("reason", "") or "").strip()
            normalized = _normalize_termination_reason(reason)
            if normalized:
                metrics.termination_reason = normalized
                if normalized == "natural_model_stop":
                    metrics.natural_completion = True
            if payload.get("reached_limit") is True:
                metrics.iteration_guard_hit = True
        if event_type == "decision" and phase == "pre_budget_submit":
            metrics.pre_budget_submit_triggered = True
        if payload.get("pre_budget_submit_triggered") is True:
            metrics.pre_budget_submit_triggered = True
        if event_type == "finding_funnel_completed":
            metrics.finding_funnel = FindingFunnel.model_validate(payload)
            raw_contract_version = payload.get("finding_contract_version")
            if isinstance(raw_contract_version, str) and raw_contract_version.strip():
                metrics.finding_contract_version = raw_contract_version.strip()
            for field_name in (
                "logical_candidate_count",
                "submitted_finding_count",
                "submitted_attempt_count",
                "provider_attempt_count",
                "no_finding_run_count",
                "non_risk_not_routed_count",
                "pre_verifier_rejected_count",
                "policy_passed_count",
                "policy_rejected_count",
                "risk_candidate_count",
                "integrity_checked_count",
                "integrity_verified_count",
                "integrity_needs_repair_count",
                "integrity_invalid_count",
                "deterministic_rejected_count",
                "repair_attempted_count",
                "repair_succeeded_count",
                "final_published_count",
                "final_risk_finding_count",
                "evidence_validated_count",
            ):
                if field_name in payload:
                    setattr(metrics, field_name, _non_negative_int(payload[field_name]))
            if "evidence_complete_count" in payload:
                metrics.evidence_complete_count = _non_negative_int(
                    payload["evidence_complete_count"]
                )
            metrics.finding_run_status = str(payload.get("run_status", "complete"))
        elif event_type == "finding_candidates_built":
            metrics.model_raw_issue_count = _non_negative_int(
                payload.get("model_raw_issue_count")
            )
            metrics.verifier_candidate_count = _non_negative_int(
                payload.get("verifier_candidate_count", payload.get("candidate_count"))
            )
            metrics.candidate_issue_count = _non_negative_int(
                payload.get("candidate_count")
            )
            metrics.evidence_bound_issue_count = _non_negative_int(
                payload.get("evidence_bound_count")
            )
            metrics.structured_hypothesis_count = _non_negative_int(
                payload.get("structured_hypothesis_count")
            )
            metrics.evidence_complete_count = _non_negative_int(
                payload.get("evidence_complete_count")
            )
        elif event_type == "finding_verification_completed":
            metrics.verifier_accepted_count = _non_negative_int(
                payload.get("accepted_count")
            )
            metrics.verifier_rejected_count = _non_negative_int(
                payload.get("rejected_count")
            )
            metrics.integrity_checked_count = _non_negative_int(
                payload.get("candidate_count", metrics.integrity_checked_count)
            )
            metrics.integrity_verified_count = _non_negative_int(
                payload.get("verified_count", payload.get("accepted_count"))
            )
            metrics.integrity_needs_repair_count = _non_negative_int(
                payload.get("needs_repair_count")
            )
            metrics.integrity_invalid_count = _non_negative_int(
                payload.get("invalid_count")
            )
            metrics.deterministic_evidence_checked_count = _non_negative_int(
                payload.get("deterministic_evidence_checked_count")
            )
            metrics.deterministic_evidence_passed_count = _non_negative_int(
                payload.get("deterministic_evidence_passed_count")
            )
            metrics.deterministic_evidence_rejected_count = _non_negative_int(
                payload.get("deterministic_evidence_rejected_count")
            )
            if phase == "semantic_verify_findings" and "total_tokens" in payload:
                unknown_usage = _non_negative_int(
                    payload.get("failed_unknown_usage_count")
                )
                metrics.verifier_total_tokens = (
                    None
                    if unknown_usage
                    else _non_negative_int(payload.get("total_tokens"))
                )
            metrics.model_raw_issue_count = _non_negative_int(
                payload.get("model_raw_issue_count", metrics.model_raw_issue_count)
            )
            metrics.verifier_candidate_count = _non_negative_int(
                payload.get(
                    "verifier_candidate_count", metrics.verifier_candidate_count
                )
            )
            raw_outcome = str(payload.get("review_outcome", "") or "")
            if raw_outcome in {
                "no_candidates",
                "accepted",
                "partially_rejected",
                "all_candidates_rejected",
                "incomplete",
            }:
                metrics.review_outcome = raw_outcome  # type: ignore[assignment]
            raw_codes = payload.get("integrity_failures")
            if isinstance(raw_codes, dict):
                metrics.integrity_failure_codes = {
                    str(candidate_id): [str(code) for code in codes]
                    for candidate_id, codes in raw_codes.items()
                    if isinstance(codes, list)
                }
            raw_details = payload.get("integrity_failure_details")
            if isinstance(raw_details, dict):
                metrics.integrity_failure_details = {
                    str(candidate_id): [
                        dict(detail) for detail in details if isinstance(detail, dict)
                    ]
                    for candidate_id, details in raw_details.items()
                    if isinstance(details, list)
                }
        elif event_type == "workflow_summary":
            metrics.required_step_count = _non_negative_int(
                payload.get("required_step_count")
            )
            metrics.completed_required_step_count = _non_negative_int(
                payload.get("completed_required_step_count")
            )
            metrics.workflow_filtered_issue_count = _non_negative_int(
                payload.get("workflow_filtered_issue_count")
            )
            metrics.final_effective_issue_count = _non_negative_int(
                payload.get("final_effective_issue_count")
            )
            metrics.workflow_invalid = bool(payload.get("workflow_invalid", False))
            missing_steps = payload.get("missing_required_steps", [])
            metrics.workflow_missing_steps = (
                [str(item) for item in missing_steps]
                if isinstance(missing_steps, list)
                else []
            )
        elif event_type == "context_plan_completed":
            _update_graph_selection_metrics(metrics, payload)
            metrics.candidate_context_tokens = _non_negative_int(
                payload.get("token_cost")
            )
            metrics.included_graph_nodes = _non_negative_int(
                payload.get("included_node_count")
            )
            metrics.included_graph_paths = _non_negative_int(
                payload.get("included_path_count")
            )
            metrics.discarded_graph_paths = _non_negative_int(
                payload.get("discarded_path_count")
            )
        elif event_type == "context_telemetry":
            _update_graph_reviewer_metrics(metrics, payload)
        elif event_type == "index_lifecycle":
            metrics.graph_build_latency_seconds = _non_negative_float(
                payload.get("build_latency_seconds")
            )
            metrics.incremental_update_latency_seconds = _non_negative_float(
                payload.get("incremental_update_latency_seconds")
            )
            metrics.persistent_cache_hit_rate = _bounded_ratio(
                payload.get("cache_hit_rate")
            )
        elif event_type == "root_cause_consolidation_completed":
            metrics.consolidator_block_count = _non_negative_int(
                payload.get("block_count")
            )
            metrics.consolidator_average_block_size = _non_negative_float(
                payload.get("average_block_size")
            )
            metrics.consolidator_proposal_count = _non_negative_int(
                payload.get("proposal_count")
            )
            metrics.consolidator_accepted_cluster_count = _non_negative_int(
                payload.get("accepted_cluster_count")
            )
            metrics.consolidator_rejected_cluster_count = _non_negative_int(
                payload.get("rejected_cluster_count")
            )
            metrics.final_root_cause_count = _non_negative_int(
                payload.get("final_root_cause_count")
            )
            metrics.finding_inflation_ratio = _non_negative_float(
                payload.get("finding_inflation_ratio")
            )
            metrics.unused_context_ratio = _bounded_ratio(
                payload.get("unused_context_ratio")
            )
            metrics.edge_confidence_contribution = _bounded_ratio(
                payload.get("edge_confidence_contribution")
            )
            metrics.evidence_complete_count = _non_negative_int(
                payload.get("evidence_complete_count", metrics.evidence_complete_count)
            )
        elif event_type == "tool_io":
            metrics.reviewer_tool_call_count += 1
            if payload.get("deduplicated") is True:
                metrics.duplicate_tool_call_count += 1
        elif event_type == "model_call" and phase == "provider_attempt":
            metrics.provider_attempt_count += 1
            success = payload.get("success") is True
            usage_present = payload.get("usage_present") is True
            if not success:
                metrics.failed_attempt_count += 1
                if payload.get("usage_unknown") is True:
                    metrics.failed_unknown_usage_count += 1
            elif usage_present:
                reviewer_usage_seen = True
                reviewer_total_tokens += _non_negative_int(
                    payload.get("total_tokens")
                )
                metrics.successful_prompt_tokens += _non_negative_int(
                    payload.get("prompt_tokens")
                )
                metrics.successful_completion_tokens += _non_negative_int(
                    payload.get("completion_tokens")
                )
                metrics.successful_reasoning_tokens += _non_negative_int(
                    payload.get("reasoning_tokens")
                )
                metrics.successful_total_tokens += _non_negative_int(
                    payload.get("total_tokens")
                )
                metrics.successful_cached_prompt_tokens += _non_negative_int(
                    payload.get("cached_prompt_tokens")
                )
                metrics.successful_adjacent_common_prefix_tokens += (
                    _non_negative_int(
                        payload.get("adjacent_common_prefix_tokens")
                    )
                )
                if payload.get("cached_prompt_tokens") is not None:
                    metrics.cache_observation_count += 1
                    if _non_negative_int(payload.get("cached_prompt_tokens")) > 0:
                        metrics.provider_cache_hit_count += 1
        elif (
            event_type == "phase_end"
            and phase == "review_complete"
        ):
            mode = str(payload.get("context_mode", "graph_hybrid"))
            metrics.context_mode = (
                "agent_search" if mode == "agent_search" else "graph_hybrid"
            )
            metrics.model = str(payload.get("model", ""))
            metrics.review_iterations = _non_negative_int(
                payload.get(
                    "review_iterations", payload.get("actual_review_iterations")
                )
            )
            metrics.tool_call_count = _non_negative_int(payload.get("tool_call_count"))
            metrics.tool_bearing_iterations = _non_negative_int(
                payload.get("tool_bearing_iterations")
            )
            metrics.submit_iteration = _optional_non_negative_int(
                payload.get("submit_iteration")
            )
            if isinstance(payload.get("natural_completion"), bool):
                metrics.natural_completion = payload["natural_completion"]
            for status_name in (
                "investigation_ready",
                "submission_received",
                "review_complete",
                "delivery_complete",
            ):
                if isinstance(payload.get(status_name), bool):
                    setattr(metrics, status_name, payload[status_name])
            if isinstance(payload.get("iteration_guard_hit"), bool):
                metrics.iteration_guard_hit = payload["iteration_guard_hit"]
            if isinstance(payload.get("pre_budget_submit_triggered"), bool):
                metrics.pre_budget_submit_triggered = payload[
                    "pre_budget_submit_triggered"
                ]
            termination_reason = str(
                payload.get("termination_reason", "") or ""
            ).strip()
            if termination_reason:
                metrics.termination_reason = termination_reason
            metrics.model_response_journal_writes = _non_negative_int(
                payload.get("model_response_journal_writes")
            )
            metrics.draft_findings_created = _non_negative_int(
                payload.get("draft_findings_created")
            )
            metrics.draft_state_transition_count = _non_negative_int(
                payload.get("draft_state_transition_count")
            )
            raw_draft_status_counts = payload.get("draft_status_counts")
            if isinstance(raw_draft_status_counts, dict):
                metrics.draft_status_counts = {
                    str(status): _non_negative_int(count)
                    for status, count in raw_draft_status_counts.items()
                }
            metrics.draft_stagnation_streak = _non_negative_int(
                payload.get("draft_stagnation_streak")
            )
            raw_incomplete_reasons = payload.get("incomplete_reasons")
            if isinstance(raw_incomplete_reasons, list):
                metrics.incomplete_reasons = [
                    str(reason)
                    for reason in raw_incomplete_reasons
                    if str(reason).strip()
                ]
            metrics.length_recoveries_attempted = _non_negative_int(
                payload.get("length_recoveries_attempted")
            )
            metrics.length_recoveries_succeeded = _non_negative_int(
                payload.get("length_recoveries_succeeded")
            )
            metrics.length_recoveries_failed = _non_negative_int(
                payload.get("length_recoveries_failed")
            )
            metrics.repair_budget_total = _non_negative_int(
                payload.get("repair_budget_total")
            )
            metrics.repair_budget_remaining = _non_negative_int(
                payload.get("repair_budget_remaining")
            )
            metrics.repair_format_attempt_count = _non_negative_int(
                payload.get("repair_format_attempt_count")
            )
            metrics.repair_contract_attempt_count = _non_negative_int(
                payload.get("repair_contract_attempt_count")
            )
            metrics.repair_evidence_attempt_count = _non_negative_int(
                payload.get("repair_evidence_attempt_count")
            )
            metrics.final_submit_attempt_count = _non_negative_int(
                payload.get("final_submit_attempt_count")
            )
            metrics.grep_calls = _non_negative_int(payload.get("grep_calls"))
            metrics.read_file_calls = _non_negative_int(payload.get("read_file_calls"))
            metrics.symbol_lookup_calls = _non_negative_int(
                payload.get("symbol_lookup_calls")
            )
            metrics.reviewer_latency_seconds = _non_negative_float(
                payload.get("reviewer_latency_seconds")
            )
            metrics.verifier_latency_seconds = _non_negative_float(
                payload.get("verifier_latency_seconds")
            )
            metrics.consolidation_latency_seconds = _non_negative_float(
                payload.get("consolidation_latency_seconds")
            )
            metrics.end_to_end_latency_seconds = _non_negative_float(
                payload.get("end_to_end_latency_seconds")
            )
            metrics.prompt_tokens = _optional_non_negative_int(
                payload.get("prompt_tokens")
            )
            metrics.completion_tokens = _optional_non_negative_int(
                payload.get("completion_tokens")
            )
            metrics.total_tokens = _non_negative_int(payload.get("total_tokens"))
            raw_contract_version = payload.get("finding_contract_version")
            if isinstance(raw_contract_version, str) and raw_contract_version.strip():
                metrics.finding_contract_version = raw_contract_version.strip()
            for field_name in (
                "logical_candidate_count",
                "submitted_finding_count",
                "submitted_attempt_count",
                "provider_attempt_count",
                "no_finding_run_count",
                "non_risk_not_routed_count",
                "pre_verifier_rejected_count",
                "policy_passed_count",
                "policy_rejected_count",
                "risk_candidate_count",
                "integrity_checked_count",
                "integrity_verified_count",
                "integrity_needs_repair_count",
                "integrity_invalid_count",
                "deterministic_rejected_count",
                "repair_attempted_count",
                "repair_succeeded_count",
                "final_published_count",
                "final_risk_finding_count",
                "evidence_complete_count",
                "evidence_validated_count",
            ):
                if field_name in payload:
                    setattr(
                        metrics,
                        field_name,
                        _non_negative_int(payload.get(field_name)),
                    )
            phase_end_funnel_updates = {
                field_name: getattr(metrics, field_name)
                for field_name in (
                    "logical_candidate_count",
                    "submitted_finding_count",
                    "submitted_attempt_count",
                    "provider_attempt_count",
                    "no_finding_run_count",
                    "non_risk_not_routed_count",
                    "pre_verifier_rejected_count",
                    "policy_passed_count",
                    "policy_rejected_count",
                    "risk_candidate_count",
                    "integrity_checked_count",
                    "integrity_verified_count",
                    "integrity_needs_repair_count",
                    "integrity_invalid_count",
                    "deterministic_rejected_count",
                    "repair_attempted_count",
                    "repair_succeeded_count",
                    "final_published_count",
                    "final_risk_finding_count",
                    "evidence_complete_count",
                    "evidence_validated_count",
                )
                if field_name in payload
            }
            if phase_end_funnel_updates:
                metrics.finding_funnel = metrics.finding_funnel.model_copy(
                    update=phase_end_funnel_updates
                )
            if "finding_run_status" in payload:
                metrics.finding_run_status = str(
                    payload.get("finding_run_status") or metrics.finding_run_status
                )
            for field_name in (
                "provider_attempt_count",
                "successful_prompt_tokens",
                "successful_completion_tokens",
                "successful_reasoning_tokens",
                "successful_total_tokens",
                "successful_cached_prompt_tokens",
                "successful_adjacent_common_prefix_tokens",
                "cache_observation_count",
                "provider_cache_hit_count",
                "failed_attempt_count",
                "failed_unknown_usage_count",
            ):
                if field_name in payload:
                    setattr(
                        metrics,
                        field_name,
                        _non_negative_int(payload.get(field_name)),
                    )
            metrics.review_skill_loaded_count = _non_negative_int(
                payload.get("review_skill_loaded_count")
            )
            metrics.review_skill_chars = _non_negative_int(
                payload.get("review_skill_chars")
            )
            metrics.review_skill_tokens = _non_negative_int(
                payload.get("review_skill_tokens")
            )
            metrics.review_skill_retrieval_latency_ms = _non_negative_float(
                payload.get("review_skill_retrieval_latency_ms")
            )
            metrics.review_skill_fallback_count = _non_negative_int(
                payload.get("review_skill_fallback_count")
            )
            metrics.graph_status = str(payload.get("graph_status", ""))
            metrics.graph_cache_mode = str(
                payload.get("graph_cache_mode", "not_applicable")
            )
            metrics.manifest_count = _non_negative_int(payload.get("manifest_count"))
            metrics.manifest_token_cost = _non_negative_int(
                payload.get("manifest_token_cost")
            )
            metrics.parsed_file_count = _optional_non_negative_int(
                payload.get("parsed_file_count")
            )
            metrics.graph_node_count = _optional_non_negative_int(
                payload.get("graph_node_count")
            )
            metrics.graph_edge_count = _optional_non_negative_int(
                payload.get("graph_edge_count")
            )
            raw_cache_hit = payload.get("cache_hit")
            metrics.graph_cache_hit = (
                bool(raw_cache_hit) if isinstance(raw_cache_hit, bool) else None
            )
            metrics.graph_fallback_reason = str(payload.get("fallback_reason", ""))
            _update_graph_selection_metrics(metrics, payload)
    metrics.reviewer_total_tokens = (
        reviewer_total_tokens if reviewer_usage_seen else None
    )
    return metrics


def _update_graph_selection_metrics(
    metrics: ReviewProcessMetrics, payload: dict[str, object]
) -> None:
    """Copy graph path diversity counters from planner or review telemetry."""

    field_keys = {
        "graph_available_path_count": (
            "graph_available_path_count",
            "available_graph_path_count",
        ),
        "graph_selected_path_count": (
            "graph_selected_path_count",
            "selected_reviewer_path_count",
            "included_graph_path_count",
            "included_path_count",
        ),
        "graph_dropped_repeated_prefix_path_count": (
            "graph_dropped_repeated_prefix_path_count",
            "dropped_repeated_prefix_path_count",
        ),
        "graph_selected_direct_path_count": (
            "graph_selected_direct_path_count",
            "selected_direct_path_count",
        ),
        "graph_selected_production_path_count": (
            "graph_selected_production_path_count",
            "selected_production_path_count",
        ),
        "graph_selected_low_hop_path_count": (
            "graph_selected_low_hop_path_count",
            "selected_low_hop_path_count",
        ),
        "graph_required_production_path_count": (
            "graph_required_production_path_count",
            "required_production_path_count",
        ),
        "graph_missing_production_path_count": (
            "graph_missing_production_path_count",
            "missing_production_path_count",
        ),
        "graph_reviewer_context_token_estimate": (
            "graph_reviewer_context_token_estimate",
        ),
    }
    for field_name, keys in field_keys.items():
        for key in keys:
            if key in payload:
                setattr(metrics, field_name, _non_negative_int(payload.get(key)))
                break

    raw_reasons = payload.get(
        "graph_path_selection_reason_counts",
        payload.get("path_selection_reason_counts"),
    )
    if isinstance(raw_reasons, dict):
        metrics.graph_path_selection_reason_counts = {
            str(reason): _non_negative_int(count)
            for reason, count in raw_reasons.items()
        }


def _update_graph_reviewer_metrics(
    metrics: ReviewProcessMetrics, payload: dict[str, object]
) -> None:
    """Accumulate the Graph parts that reached the reviewer prompt."""

    projection = payload.get("graph_reviewer_prompt_projection")
    if not isinstance(projection, dict):
        return
    metrics.graph_reviewer_available_path_count += _non_negative_int(
        projection.get("available_path_count")
    )
    metrics.graph_reviewer_selected_path_count += _non_negative_int(
        projection.get("selected_path_count")
    )
    metrics.graph_reviewer_dropped_path_count += _non_negative_int(
        projection.get("dropped_path_count")
    )
    selected_tokens = projection.get("selected_token_count")
    if selected_tokens is None:
        selected_tokens = projection.get("estimated_tokens")
    metrics.graph_reviewer_selected_token_count += _non_negative_int(
        selected_tokens
    )
    raw_roles = projection.get("selected_role_coverage")
    if isinstance(raw_roles, list):
        metrics.graph_reviewer_role_coverage = sorted(
            {
                *metrics.graph_reviewer_role_coverage,
                *(str(role) for role in raw_roles if str(role)),
            }
        )


def _non_negative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _optional_non_negative_int(value: object) -> int | None:
    if value is None:
        return None
    return _non_negative_int(value)


def _normalize_termination_reason(reason: str) -> str:
    """Map legacy decision labels to the normalized observability enum."""

    return {
        "model_completed": "natural_model_stop",
        "completed": "natural_model_stop",
        "max_iterations": "iteration_guard",
        "budget_soft_capped": "token_soft_limit",
        "budget_hard_capped": "token_hard_limit",
        "run_timeout": "run_timeout",
        "model_timeout": "provider_timeout",
        "pre_budget_submit_attempted": "pre_budget_submit",
    }.get(reason, "")


def _non_negative_float(value: object) -> float:
    try:
        return max(0.0, float(value or 0.0))
    except (TypeError, ValueError):
        return 0.0


def _bounded_ratio(value: object) -> float:
    return min(1.0, _non_negative_float(value))
