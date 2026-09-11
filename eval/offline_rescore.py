"""Deterministic, model-free re-scoring for persisted Harness v3 runs.

The re-scorer consumes the final response and runtime receipt bindings already
stored in the experiment output.  It never calls a model, creates a receipt,
or rewrites the source artifacts.  Finding eligibility is delegated to the
same runtime-bound adapter used by the live evaluator; gold matching remains a
separate operation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from eval.run_summary import extract_review_process_metrics
from eval.runner import (
    V3_CONTENT_JUDGMENT_VERSION,
    _effective_review_issues,
    _match_issues_for_version,
    _root_cause_quality_for_version,
    _v3_duplicate_actual_stats,
    _v3_eval_eligibility,
    load_fixtures,
)
from eval.schemas import V3_CONTENT_MATCHER_VERSION
from src.analyzer.location import normalize_location
from src.analyzer.schemas import ReviewResponse


RESCORE_VERSION = "offline-rescore-v4"
V3_ADAPTER_VERSION = "v3-runtime-boundary-v1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_sha256(value: Any) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.is_file():
        return rows
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def _relative_path(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return str(path.resolve())


def _resolve_path(value: str, *, repo_root: Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else repo_root / path


def _git_commit(repo_root: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return "unknown"
    return completed.stdout.strip() or "unknown"


def _is_generated_rescore_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    return normalized.startswith("eval/reports/") and normalized.endswith(".json")


def _git_worktree_trace(repo_root: Path) -> dict[str, Any]:
    """Capture the HEAD base and current patch state without changing Git state."""

    try:
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        ).stdout
        tracked_patch = subprocess.run(
            ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            cwd=repo_root,
            check=True,
            capture_output=True,
        ).stdout.decode("utf-8", errors="replace")
    except (OSError, subprocess.CalledProcessError) as exc:
        return {
            "scoring_worktree_dirty": None,
            "scoring_worktree_status": [],
            "scoring_worktree_patch_sha256": "",
            "scoring_worktree_trace_error": str(exc),
        }

    status_lines = [
        line
        for line in status.splitlines()
        if line.strip() and not _is_generated_rescore_path(line[3:].strip())
    ]
    untracked_files: list[dict[str, str]] = []
    for raw_path in untracked.split("\x00"):
        path_value = raw_path.strip()
        if not path_value or _is_generated_rescore_path(path_value):
            continue
        path = repo_root / Path(path_value)
        if path.is_file():
            untracked_files.append(
                {
                    "path": path_value.replace("\\", "/"),
                    "sha256": _sha256(path),
                }
            )
    untracked_files.sort(key=lambda item: item["path"])
    trace_payload = {
        "status": status_lines,
        "tracked_patch_sha256": hashlib.sha256(tracked_patch).hexdigest(),
        "untracked_files": untracked_files,
    }
    return {
        "scoring_worktree_dirty": bool(status_lines or untracked_files),
        "scoring_worktree_status": status_lines,
        "scoring_worktree_patch_sha256": _canonical_sha256(trace_payload),
        "scoring_worktree_trace_error": "",
    }


def _last_funnel_payload(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event in reversed(events):
        if event.get("event_type") == "finding_funnel_completed":
            payload = event.get("payload", {})
            if isinstance(payload, dict):
                return payload
    return {}


def _receipt_summary(registration: dict[str, Any]) -> dict[str, Any] | None:
    receipts = registration.get("semantic_receipts", [])
    if not isinstance(receipts, list):
        return None
    current_version = str(registration.get("candidate_content_version", ""))
    matching = [
        item
        for item in receipts
        if isinstance(item, dict)
        and str(item.get("content_version", "")) == current_version
    ]
    if len(matching) != 1:
        return None
    receipt = matching[0]
    return {
        "content_version": str(receipt.get("content_version", "")),
        "evidence_context_digest": str(
            receipt.get("evidence_context_digest", "")
        ),
        "input_digest": str(receipt.get("input_digest", "")),
        "request_hash": str(receipt.get("request_hash", "")),
        "response_digest": str(receipt.get("response_digest", "")),
        "provider_request_id": str(receipt.get("provider_request_id", "")),
        "provider_attempt_count": int(receipt.get("provider_attempt_count", 0) or 0),
        "verdict": str(receipt.get("verdict", "")),
        "status": str(receipt.get("status", "")),
    }


def _finding_decisions(
    response: ReviewResponse,
    actual_issues: list[Any],
    matches: list[Any],
) -> list[dict[str, Any]]:
    assigned_by_actual: dict[int, list[int]] = {}
    matched_by_actual: dict[int, list[int]] = {}
    for match in matches:
        if match.matched_actual_index is not None:
            assigned_by_actual.setdefault(match.matched_actual_index, []).append(
                match.expected_index
            )
            if match.matched:
                matched_by_actual.setdefault(match.matched_actual_index, []).append(
                    match.expected_index
                )
    registrations = {
        str(item.get("candidate_id", "")): item
        for item in response.context.candidate_registrations
        if isinstance(item, dict) and str(item.get("candidate_id", "")).strip()
    }
    decisions: list[dict[str, Any]] = []
    for index, issue in enumerate(response.report.issues):
        candidate_id = str(getattr(issue, "candidate_id", "") or "")
        registration = registrations.get(candidate_id)
        if getattr(issue, "is_v3_finding", False):
            eligible, reason = _v3_eval_eligibility(issue, response)
        else:
            eligible = issue in actual_issues
            reason = "legacy_matcher_eligibility" if eligible else "legacy_filter"
        location = str(getattr(issue, "location", "") or "")
        evidence_refs = [
            str(item).strip()
            for item in getattr(issue, "evidence_refs", [])
            if str(item).strip()
        ]
        receipt = _receipt_summary(registration) if registration else None
        actual_index = next(
            (
                candidate_index
                for candidate_index, actual_issue in enumerate(actual_issues)
                if actual_issue is issue
            ),
            None,
        )
        decisions.append(
            {
                "report_index": index,
                "finding_id": str(getattr(issue, "finding_id", "") or ""),
                "candidate_id": candidate_id,
                "schema_version": str(getattr(issue, "schema_version", "")),
                "severity": str(getattr(getattr(issue, "severity", ""), "value", getattr(issue, "severity", ""))),
                "location": location,
                "evidence_refs": evidence_refs,
                "integrity_status": str(
                    registration.get("status", "") if registration else getattr(issue, "integrity_status", "")
                ),
                "eligible_for_gold_matching": eligible,
                "eligibility_reason": reason,
                "actual_index": actual_index,
                "matched_expected_indexes": (
                    matched_by_actual.get(actual_index, [])
                    if actual_index is not None
                    else []
                ),
                "diagnostic_expected_indexes": (
                    assigned_by_actual.get(actual_index, [])
                    if actual_index is not None
                    else []
                ),
                "receipt_binding": receipt,
            }
        )
    return decisions


def _gold_match_details(fixture: Any, matches: list[Any], actual_issues: list[Any]) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    for match in matches:
        expected = fixture.expected.issues[match.expected_index]
        actual = (
            actual_issues[match.matched_actual_index]
            if match.matched_actual_index is not None
            else None
        )
        details.append(
            {
                "expected_index": match.expected_index,
                "expected_path": expected.path,
                "expected_line": expected.line,
                "expected_end_line": expected.end_line,
                "expected_severity": expected.severity.value,
                "matched": bool(match.matched),
                "matched_finding_id": (
                    str(getattr(actual, "finding_id", "")) if actual is not None else ""
                ),
                "matched_location": (
                    str(getattr(actual, "location", "")) if actual is not None else ""
                ),
                "location_matched": match.location_matched,
                "severity_matched": match.role_match_diagnostics.get(
                    "severity_floor_met"
                ),
                "root_cause_matched": match.root_cause_matched,
                "semantic_status": match.role_match_diagnostics.get(
                    "semantic_status", "not_available"
                ),
                "repair_unit_status": match.role_match_diagnostics.get(
                    "repair_unit_status", "not_available"
                ),
                "diagnostics": dict(match.role_match_diagnostics),
            }
        )
    return details


def _location_interval(value: str) -> tuple[str, int, int] | None:
    parsed = normalize_location(value)
    if not parsed.valid or not parsed.path or parsed.line is None:
        return None
    end_line = parsed.end_line or parsed.line
    return parsed.path, parsed.line, end_line


def _overlap_checks(run_views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for left_index, left in enumerate(run_views):
        left_findings = [
            item
            for item in left.get("finding_decisions", [])
            if item.get("eligible_for_gold_matching")
        ]
        for right in run_views[left_index:]:
            if left.get("fixture_id") != right.get("fixture_id"):
                continue
            right_findings = [
                item
                for item in right.get("finding_decisions", [])
                if item.get("eligible_for_gold_matching")
            ]
            same_run = left.get("run_id") == right.get("run_id")
            for left_finding_index, left_finding in enumerate(left_findings):
                start_right = left_finding_index + 1 if same_run else 0
                for right_finding in right_findings[start_right:]:
                    left_location = _location_interval(left_finding.get("location", ""))
                    right_location = _location_interval(right_finding.get("location", ""))
                    if left_location is None or right_location is None:
                        continue
                    left_path, left_start, left_end = left_location
                    right_path, right_start, right_end = right_location
                    same_path = left_path == right_path
                    line_overlap = same_path and not (
                        left_end < right_start or right_end < left_start
                    )
                    line_gap = None
                    if same_path and not line_overlap:
                        line_gap = max(0, max(left_start, right_start) - min(left_end, right_end))
                    left_refs = set(left_finding.get("evidence_refs", []))
                    right_refs = set(right_finding.get("evidence_refs", []))
                    checks.append(
                        {
                            "fixture_id": left.get("fixture_id", ""),
                            "left_run_id": left.get("run_id", ""),
                            "right_run_id": right.get("run_id", ""),
                            "left_finding_id": left_finding.get("finding_id", ""),
                            "right_finding_id": right_finding.get("finding_id", ""),
                            "same_path": same_path,
                            "line_overlap": line_overlap,
                            "line_gap": line_gap,
                            "shared_evidence_refs": sorted(left_refs.intersection(right_refs)),
                            "automatic_overlap_signal": bool(
                                line_overlap or (same_path and line_gap is not None and line_gap <= 32)
                            ),
                            "same_root_cause": "not_determined",
                            "human_semantic_review_required": True,
                        }
                    )
    return checks


def _token_accounting(
    result: dict[str, Any],
    events: list[dict[str, Any]],
    journal_rows: list[dict[str, Any]],
    process_metrics: Any,
) -> dict[str, Any]:
    provider_rows = [
        event
        for event in events
        if event.get("event_type") == "model_call"
        and event.get("phase") == "provider_attempt"
    ]
    reviewer_rows = [
        event
        for event in provider_rows
        if event.get("payload", {}).get("stage", "reviewer") != "semantic_verifier"
    ]
    reviewer_known_rows = [
        event
        for event in reviewer_rows
        if event.get("payload", {}).get("success") is True
        and event.get("payload", {}).get("usage_present") is True
    ]
    reviewer_tokens = sum(
        int(event.get("payload", {}).get("total_tokens", 0) or 0)
        for event in reviewer_known_rows
    )
    semantic_events = [
        event
        for event in events
        if event.get("event_type") == "finding_verification_completed"
        and event.get("phase") == "semantic_verify_findings"
    ]
    semantic_payload = semantic_events[-1].get("payload", {}) if semantic_events else {}
    semantic_tokens = (
        int(semantic_payload.get("total_tokens", 0) or 0)
        if "total_tokens" in semantic_payload
        and int(semantic_payload.get("failed_unknown_usage_count", 0) or 0) == 0
        else None
    )
    semantic_receipts = [
        row.get("payload", {})
        for row in journal_rows
        if row.get("type") == "semantic_verifier_call"
        and row.get("payload", {}).get("phase") == "receipt"
    ]
    semantic_provider_ids = {
        str(item.get("provider_request_id", ""))
        for item in semantic_receipts
        if str(item.get("provider_request_id", "")).strip()
    }
    semantic_attempt_count: int | None
    if "provider_attempt_count" in semantic_payload:
        semantic_attempt_count = int(semantic_payload.get("provider_attempt_count", 0) or 0)
    elif semantic_provider_ids:
        semantic_attempt_count = len(semantic_provider_ids)
    elif semantic_events:
        semantic_attempt_count = None
    else:
        semantic_attempt_count = 0
    phase_end = [
        event
        for event in events
        if event.get("event_type") == "phase_end"
        and event.get("phase") == "review_complete"
    ]
    phase_payload = phase_end[-1].get("payload", {}) if phase_end else {}
    measured_total = (
        int(phase_payload["successful_total_tokens"])
        if isinstance(phase_payload.get("successful_total_tokens"), int)
        else None
    )
    if measured_total is None and process_metrics.successful_total_tokens:
        measured_total = process_metrics.successful_total_tokens
    component_sum = (
        reviewer_tokens + semantic_tokens if semantic_tokens is not None else None
    )
    unknown_provider_usage = sum(
        int(event.get("payload", {}).get("usage_unknown", False))
        for event in provider_rows
    )
    warm_priming_seconds = float(result.get("stage_timings", {}).get("warm_priming_seconds", 0.0) or 0.0)
    return {
        "raw_result_total_tokens": int(result.get("total_tokens", 0) or 0),
        "reviewer_total_tokens": reviewer_tokens if reviewer_known_rows else None,
        "verifier_total_tokens": semantic_tokens,
        "measured_successful_total_tokens": measured_total,
        "component_sum_matches_measured": (
            component_sum == measured_total
            if component_sum is not None and measured_total is not None
            else None
        ),
        "reviewer_logical_model_calls": sum(
            event.get("phase") == "analyze"
            for event in events
            if event.get("event_type") == "model_call"
        ),
        "verifier_logical_model_calls": int(semantic_payload.get("model_call_count", 0) or 0),
        "reviewer_provider_attempts": len(reviewer_rows),
        "verifier_provider_attempts": semantic_attempt_count,
        "provider_attempts_reported_by_phase_end": phase_payload.get("provider_attempt_count"),
        "failed_provider_attempts": sum(
            event.get("payload", {}).get("success") is not True
            for event in provider_rows
        ),
        "unknown_usage_attempts": unknown_provider_usage
        + int(semantic_payload.get("failed_unknown_usage_count", 0) or 0),
        "logical_calls_vs_provider_attempts_are_separate": True,
        "warm_priming_seconds": warm_priming_seconds,
        "warm_priming_token_usage": "not_recorded" if warm_priming_seconds else "not_applicable",
    }


def _run_view(
    record: dict[str, Any],
    *,
    fixture: Any,
    repo_root: Path,
) -> dict[str, Any]:
    result = record.get("result", {})
    raw_output = result.get("raw_output", {})
    response = ReviewResponse.model_validate(raw_output)
    if response.report.schema_version != "3.0":
        raise ValueError(
            "offline v3 rescore requires report schema_version='3.0'"
        )
    # A missing source matcher is evidence loss, not permission to infer the
    # historical default.  The rescore matcher remains explicit below.
    source_matcher_version = str(result.get("matcher_version", "")).strip() or "unknown"
    matcher_version = V3_CONTENT_MATCHER_VERSION
    event_path = _resolve_path(str(result.get("event_log_path", "")), repo_root=repo_root)
    journal_path = _resolve_path(
        str(record.get("lifecycle", {}).get("run_journal_path", "")),
        repo_root=repo_root,
    )
    events = _read_jsonl(event_path)
    journal_rows = _read_jsonl(journal_path)
    process_metrics = extract_review_process_metrics(
        event_path,
        matcher_version=matcher_version,
    )
    process_metrics.matcher_version = matcher_version
    process_metrics.finding_contract_version = response.report.schema_version
    actual_issues = _effective_review_issues(fixture, response)
    matches, matched_count, unmatched_actual_count = _match_issues_for_version(
        fixture, response, matcher_version
    )
    root_cause_quality = _root_cause_quality_for_version(
        fixture,
        response,
        matches,
        matcher_version,
    )
    severity_matched_count = sum(
        bool(match.role_match_diagnostics.get("severity_floor_met"))
        for match in matches
    )
    semantic_undetermined_count = sum(
        match.role_match_diagnostics.get("semantic_status") == "undetermined"
        for match in matches
    )
    duplicate_stats = _v3_duplicate_actual_stats(actual_issues)
    funnel = _last_funnel_payload(events)
    external_status = str(response.external_publish_status)
    external_published_count = int(funnel.get("external_published_count", 0) or 0)
    return {
        "fixture_id": str(record.get("fixture_id", "")),
        "fixture_snapshot": str(record.get("repository_snapshot", "")),
        "variant_id": str(record.get("variant_id", "")),
        "run_id": str(record.get("run_id", "")),
        "runner_execution_valid": bool(record.get("valid", False)),
        "schema_valid": bool(result.get("schema_valid", False)),
        "finding_contract_version": response.report.schema_version,
        "source_matcher_version": source_matcher_version,
        "matcher_version": matcher_version,
        "adapter_version": V3_ADAPTER_VERSION,
        "raw_report_finding_count": len(response.report.issues),
        "original_eval_actual_count": int(result.get("actual_count", 0) or 0),
        "rescored_eligible_finding_count": len(actual_issues),
        "semantic_accepted_count": int(response.semantic_accepted_count),
        "delivery_complete": bool(response.delivery_complete),
        "internal_final_finding_count": int(process_metrics.final_published_count),
        "finding_run_status": response.finding_run_status,
        "natural_stop": bool(process_metrics.natural_completion),
        "termination_reason": process_metrics.termination_reason,
        "report_ready": bool(response.report_ready),
        "external_publish_status": external_status,
        "external_publish_requested": external_status in {"published", "failed"},
        "external_publish_succeeded": external_status == "published"
        and external_published_count > 0,
        "external_published_count": external_published_count,
        "matched_count": matched_count,
        "false_positive_count": unmatched_actual_count,
        "false_positive_metric_definition": "gold_based_unmatched_actual_count; not a semantic false-positive judgment",
        "approved_finding_count": len(actual_issues),
        "location_matched_count": sum(bool(match.location_matched) for match in matches),
        "severity_matched_count": severity_matched_count,
        "root_cause_matched_count": sum(
            bool(match.root_cause_matched) for match in matches
        ),
        "repair_unit_matched_count": int(
            root_cause_quality.get("repair_unit_matched_count") or 0
        ),
        "semantic_undetermined_count": semantic_undetermined_count,
        "duplicate_actual_count": duplicate_stats["duplicate_count"],
        "duplicate_candidate_pair_count": duplicate_stats["candidate_pair_count"],
        "semantic_rule_version": V3_CONTENT_JUDGMENT_VERSION,
        "root_cause_quality": root_cause_quality,
        "gold_match_details": _gold_match_details(fixture, matches, actual_issues),
        "finding_decisions": _finding_decisions(response, actual_issues, matches),
        "metric_change_reason": (
            "v3 final findings use runtime receipt/version/evidence bindings; "
            "semantic-v3-content-v1 consumes description, anchor, related_locations, "
            "suggestion, and evidence_refs. Its conservative judgment version "
            f"is {V3_CONTENT_JUDGMENT_VERSION}; nonidentical shared-evidence pairs "
            "are candidates only and do not prove semantic or repair agreement. "
            "Legacy narrative fields are not consulted."
        ),
        "token_accounting": _token_accounting(
            result, events, journal_rows, process_metrics
        ),
        "malformed_verifier_diagnostics": _malformed_diagnostics(
            events, journal_rows
        ),
        "source_hashes": {
            "raw_result": _canonical_sha256(result),
            "event_log": _sha256(event_path) if event_path.is_file() else "",
            "run_journal": _sha256(journal_path) if journal_path.is_file() else "",
        },
    }


def _malformed_diagnostics(
    events: list[dict[str, Any]], journal_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    receipt_rows = [
        row.get("payload", {})
        for row in journal_rows
        if row.get("type") == "semantic_verifier_call"
        and row.get("payload", {}).get("phase") == "receipt"
    ]
    errors = [
        str(item.get("error_code", ""))
        for item in receipt_rows
        if str(item.get("error_code", "")).strip()
    ]
    malformed = [
        item for item in errors if "malformed" in item or "invalid" in item
    ]
    if not malformed:
        return {"status": "not_observed", "error_codes": []}
    return {
        "status": "historical_evidence_insufficient_for_field_level_diagnosis",
        "error_codes": malformed,
        "raw_provider_response_persisted": False,
        "safe_request_hash_present": any(
            bool(str(item.get("request_hash", "")).strip()) for item in receipt_rows
        ),
        "safe_response_digest_present": any(
            bool(str(item.get("response_digest", "")).strip()) for item in receipt_rows
        ),
        "provider_request_id_present": any(
            bool(str(item.get("provider_request_id", "")).strip())
            for item in receipt_rows
        ),
        "provider_attempt_count_present": any(
            int(item.get("provider_attempt_count", 0) or 0) > 0
            for item in receipt_rows
        ),
        "diagnosis_boundary": (
            "The stored error proves verifier decision/schema validation failed for the "
            "recorded handle, but the historical response body and request association "
            "are absent, so the exact field or constraint cannot be recovered."
        ),
        "event_failure_count": sum(
            event.get("event_type") == "workflow_step_failed" for event in events
        ),
    }


def rescore_experiment(
    *,
    repo_root: Path,
    raw_path: Path,
    summary_path: Path,
    checkpoint_path: Path,
    fixtures_dir: Path,
) -> dict[str, Any]:
    raw = _read_json(raw_path)
    summary = _read_json(summary_path)
    checkpoint_rows = _read_jsonl(checkpoint_path)
    fixtures = {fixture.id: fixture for fixture in load_fixtures(fixtures_dir)}
    records = [
        record
        for record in raw.get("records", [])
        if isinstance(record, dict) and bool(record.get("measured", True))
    ]
    run_views: list[dict[str, Any]] = []
    missing_fixture_ids: list[str] = []
    for record in records:
        fixture_id = str(record.get("fixture_id", ""))
        fixture = fixtures.get(fixture_id)
        if fixture is None:
            missing_fixture_ids.append(fixture_id)
            continue
        run_views.append(_run_view(record, fixture=fixture, repo_root=repo_root))
    source_files = [raw_path, summary_path, checkpoint_path]
    for view in run_views:
        for key in ("event_log", "run_journal"):
            path_value = view["source_hashes"].get(key, "")
            if path_value:
                # The hash is already captured per run; source manifest paths
                # are added below from the original records for readability.
                del path_value
    source_manifest: list[dict[str, str]] = []
    for path in source_files:
        if path.is_file():
            source_manifest.append(
                {"path": _relative_path(path, repo_root), "sha256": _sha256(path)}
            )
    for record in records:
        for value in (
            str(record.get("result", {}).get("event_log_path", "")),
            str(record.get("lifecycle", {}).get("run_journal_path", "")),
        ):
            if not value:
                continue
            path = _resolve_path(value, repo_root=repo_root)
            if path.is_file():
                entry = {"path": _relative_path(path, repo_root), "sha256": _sha256(path)}
                if entry not in source_manifest:
                    source_manifest.append(entry)
    source_manifest.sort(key=lambda item: item["path"])
    source_digest = _canonical_sha256(source_manifest)
    worktree_trace = _git_worktree_trace(repo_root)
    return {
        "schema_version": "offline-rescore-result-v1",
        "rescore_version": RESCORE_VERSION,
        "semantic_rule_version": V3_CONTENT_JUDGMENT_VERSION,
        "generated_at": str(summary.get("generated_at", "")),
        "source_experiment_id": str(raw.get("experiment_id", "")),
        "source_suite": str(raw.get("suite", summary.get("suite", ""))),
        "source_run_count": len(records),
        "source_raw_path": _relative_path(raw_path, repo_root),
        "source_summary_path": _relative_path(summary_path, repo_root),
        "source_checkpoint_path": _relative_path(checkpoint_path, repo_root),
        "source_artifact_manifest": source_manifest,
        "source_artifact_manifest_sha256": source_digest,
        "source_implementation_commit": str(raw.get("implementation_commit", "")),
        "scoring_commit": _git_commit(repo_root),
        "scoring_code_digest": _canonical_sha256(
            {
                "core_eval": _sha256(repo_root / "eval" / "core_eval.py"),
                "module": _sha256(Path(__file__)),
                "runner": _sha256(repo_root / "eval" / "runner.py"),
                "run_summary": _sha256(repo_root / "eval" / "run_summary.py"),
                "schemas": _sha256(repo_root / "eval" / "schemas.py"),
            }
        ),
        "scoring_commit_role": "HEAD base for the current scoring worktree",
        **worktree_trace,
        "finding_contract_version": "3.0",
        "source_matcher_versions": sorted(
            {
                str(view.get("source_matcher_version", ""))
                for view in run_views
                if str(view.get("source_matcher_version", "")).strip()
            }
        ),
        "matcher_version": V3_CONTENT_MATCHER_VERSION,
        "adapter_version": V3_ADAPTER_VERSION,
        "checkpoint_row_count": len(checkpoint_rows),
        "missing_fixture_ids": sorted(set(missing_fixture_ids)),
        "runs": run_views,
        "overlap_checks": _overlap_checks(run_views),
        "summary_coverage": {
            "all_measured_records_included": len(run_views) == len(records)
            and not missing_fixture_ids,
            "no_model_calls_made": True,
            "raw_artifacts_modified": False,
        },
    }


def write_rescore_output(payload: dict[str, Any], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--fixtures-dir", type=Path, default=Path("eval/fixtures"))
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    payload = rescore_experiment(
        repo_root=args.repo_root.resolve(),
        raw_path=args.raw.resolve(),
        summary_path=args.summary.resolve(),
        checkpoint_path=args.checkpoint.resolve(),
        fixtures_dir=(
            args.fixtures_dir
            if args.fixtures_dir.is_absolute()
            else (args.repo_root / args.fixtures_dir)
        ).resolve(),
    )
    write_rescore_output(payload, args.output.resolve())
    print(json.dumps({"output": str(args.output.resolve()), "runs": len(payload["runs"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
