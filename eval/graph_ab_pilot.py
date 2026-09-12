"""Paired Graph A/B phase-two pilot runner.

This module extends the existing eval runner.  It owns only experiment lifecycle,
contract validation, pairing and aggregation; review semantics remain frozen.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import random
import re
import shutil
import sqlite3
import subprocess
import tempfile
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean, median, pstdev
from time import perf_counter
from typing import Any
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, Field

import eval.runner as base_runner
from eval.graph_ab_checkpoint import (
    CheckpointJournal,
    CheckpointStatus,
    StableRunKey,
)
from eval.run_summary import (
    extract_attempt_cost,
    extract_review_process_metrics,
    extract_runtime_closeout,
)
from eval.schemas import (
    DEFAULT_EVAL_MATCHER_VERSION,
    EvalResult,
    EvalVariant,
    Fixture,
    MetricSummary,
    StructuralIssueMetrics,
    validate_eval_matcher_contract,
)
from src.analyzer.context_strategy import GraphHybridContextStrategy
from src.analyzer.persistent_index import INDEX_SCHEMA_VERSION
from src.analyzer.schemas import (
    DebugRequest,
    DebugResponse,
    ReviewRequest,
    ReviewResponse,
)
from src.config import get_settings
from src.orchestrator.agent_loop import AgentOrchestrator

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "eval" / "variants" / "graph-ab-phase2-pilot.yaml"
DEFAULT_OUTPUT = ROOT / "eval" / "outputs" / "graph-ab-phase2-pilot.json"
DEFAULT_SUMMARY = ROOT / "eval" / "experiments" / "graph-ab-phase2-pilot-summary.json"
DEFAULT_CHECKPOINT = (
    ROOT / "eval" / "outputs" / "graph-ab-formal-readiness" / "checkpoint.jsonl"
)
VARIANT_IDS = (
    "A-agent-search",
    "B1-graph-hybrid-cold",
    "B2-graph-hybrid-warm",
)
FORBIDDEN_AGENT_EVENTS = {
    "relation_graph_built",
    "index_lifecycle",
    "context_manifest_created",
}


class ControlledPilotInterruption(RuntimeError):
    """Test/CLI hook proving durable resume after completed measured attempts."""


class VariantContractResult(BaseModel):
    expected_variant_id: str
    expected_context_mode: str
    expected_graph_cache_mode: str
    actual_context_mode: str
    actual_graph_status: str
    actual_graph_cache_mode: str
    actual_cache_hit: bool | None
    actual_manifest_count: int
    fallback_reason: str
    valid: bool
    errors: list[str] = Field(default_factory=list)


class IndexArtifact(BaseModel):
    path: str
    exists: bool
    size_bytes: int | None = None
    sha256: str | None = None
    logical_sha256: str | None = None
    schema_version: int | None = None
    repository_count: int | None = None
    revisions: list[str] = Field(default_factory=list)


class PilotRunRecord(BaseModel):
    fixture_id: str
    fixture_types: list[str]
    repository_snapshot: str
    sample: int
    order: int
    variant_id: str
    run_id: str
    measured: bool = True
    valid: bool
    invalid_reasons: list[str] = Field(default_factory=list)
    contract: VariantContractResult
    index_before: IndexArtifact | None = None
    index_after: IndexArtifact | None = None
    lifecycle: dict[str, Any] = Field(default_factory=dict)
    result: EvalResult
    result_artifact_id: str = ""
    result_artifact_sha256: str = ""
    result_artifact_ref: str = ""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fixture_snapshot(fixture: Fixture) -> str:
    workspace = fixture.input.workspace
    if workspace is not None:
        overlay = fixture.input.diff_text if workspace.apply_fixture_diff else ""
        overlay_sha256 = hashlib.sha256(overlay.encode("utf-8")).hexdigest()
        return f"{workspace.checkout_sha}+{overlay_sha256}"
    digest = hashlib.sha256()
    for path, content in sorted(fixture.input.files.items()):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content.replace("\r\n", "\n").encode("utf-8"))
        digest.update(b"\0")
    return f"synthetic:{digest.hexdigest()}"


def _event_types(path_value: str | None) -> tuple[set[str], list[str]]:
    if not path_value:
        return set(), ["event_log_missing"]
    path = Path(path_value)
    if not path.is_file():
        return set(), ["event_log_missing"]
    output: set[str] = set()
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                output.add(str(json.loads(line).get("event_type", "")))
    except (OSError, json.JSONDecodeError):
        return set(), ["event_log_parse_error"]
    return output, []


def validate_variant_contract(
    variant: EvalVariant,
    result: EvalResult,
    lifecycle: dict[str, Any] | None = None,
) -> VariantContractResult:
    """Validate the named variant against measured runtime telemetry."""
    lifecycle = lifecycle or {}
    metrics = result.process_metrics
    events, errors = _event_types(result.event_log_path)
    expected_cache = (
        "not_applicable"
        if variant.context_mode == "agent_search"
        else variant.graph_cache_mode
    )
    if result.variant_id != variant.id:
        errors.append("variant_id_mismatch")
    if metrics.context_mode != variant.context_mode:
        errors.append("context_mode_mismatch")
    if metrics.event_log_status != "ok" and not any(
        item.startswith("event_log_") for item in errors
    ):
        errors.append(f"event_log_{metrics.event_log_status}")
    if result.error:
        errors.append("run_error")
    if result.placeholder_summary:
        errors.append("placeholder_output")
    if result.workflow_invalid:
        errors.append("workflow_invalid")
    if not result.schema_valid:
        errors.append("schema_invalid")
    if any(reason == "run_timeout" for reason in result.finish_reasons):
        errors.append("timeout")
    if metrics.graph_fallback_reason:
        errors.append("graph_fallback")

    if variant.id == "A-agent-search":
        checks = {
            "agent_graph_status": metrics.graph_status == "disabled",
            "agent_graph_cache_mode": metrics.graph_cache_mode == "not_applicable",
            "agent_manifest_count": metrics.manifest_count == 0,
            "agent_manifest_token_cost": metrics.manifest_token_cost == 0,
            "agent_parsed_file_count": metrics.parsed_file_count is None,
            "agent_graph_node_count": metrics.graph_node_count is None,
            "agent_graph_edge_count": metrics.graph_edge_count is None,
            "agent_cache_hit": metrics.graph_cache_hit is None,
            "agent_fallback_reason": not metrics.graph_fallback_reason,
            "agent_graph_events": not (events & FORBIDDEN_AGENT_EVENTS),
            "agent_workspace_index": not lifecycle.get("workspace_sqlite_created", []),
        }
    elif variant.id == "B1-graph-hybrid-cold":
        checks = {
            "cold_graph_status": metrics.graph_status == "ready",
            "cold_cache_mode": metrics.graph_cache_mode == "cold",
            "cold_cache_miss": metrics.graph_cache_hit is False,
            "cold_manifest_count": metrics.manifest_count >= 1,
            "cold_build_latency": metrics.graph_build_latency_seconds > 0,
            "cold_fallback_reason": not metrics.graph_fallback_reason,
        }
    elif variant.id == "B2-graph-hybrid-warm":
        priming = lifecycle.get("priming", {})
        prime_telemetry = priming.get("telemetry", {})
        prime_index = priming.get("index_artifact", {})
        measured_index = lifecycle.get("measured_index_artifact", {})
        checks = {
            "warm_graph_status": metrics.graph_status == "ready",
            "warm_cache_mode": metrics.graph_cache_mode == "warm",
            "warm_cache_hit": metrics.graph_cache_hit is True,
            "warm_manifest_count": metrics.manifest_count >= 1,
            "warm_fallback_reason": not metrics.graph_fallback_reason,
            "warm_priming_separate": priming.get("measured") is False,
            "warm_priming_cold": prime_telemetry.get("graph_cache_mode") == "cold",
            "warm_priming_created": prime_telemetry.get("cache_hit") is False,
            "warm_index_logical_sha_unchanged": (
                bool(prime_index.get("logical_sha256"))
                and prime_index.get("logical_sha256")
                == measured_index.get("logical_sha256")
            ),
            "warm_index_schema": (
                prime_index.get("schema_version") == INDEX_SCHEMA_VERSION
                and measured_index.get("schema_version") == INDEX_SCHEMA_VERSION
            ),
            "warm_repository_identity": (
                prime_index.get("repository_count") == 1
                and measured_index.get("repository_count") == 1
                and prime_index.get("revisions") == measured_index.get("revisions")
            ),
        }
    else:
        checks = {"known_variant": False}
    errors.extend(name for name, passed in checks.items() if not passed)
    errors = list(dict.fromkeys(errors))
    return VariantContractResult(
        expected_variant_id=variant.id,
        expected_context_mode=variant.context_mode,
        expected_graph_cache_mode=expected_cache,
        actual_context_mode=metrics.context_mode,
        actual_graph_status=metrics.graph_status,
        actual_graph_cache_mode=metrics.graph_cache_mode,
        actual_cache_hit=metrics.graph_cache_hit,
        actual_manifest_count=metrics.manifest_count,
        fallback_reason=metrics.graph_fallback_reason,
        valid=not errors,
        errors=errors,
    )


def inspect_index(path: Path) -> IndexArtifact:
    if not path.is_file():
        return IndexArtifact(path=str(path), exists=False)
    artifact = IndexArtifact(
        path=str(path),
        exists=True,
        size_bytes=path.stat().st_size,
        sha256=_sha256(path),
    )
    try:
        connection = sqlite3.connect(path)
        try:
            version = connection.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()
            rows = connection.execute(
                "SELECT revision FROM repositories ORDER BY repository_id"
            ).fetchall()
            logical_digest = hashlib.sha256()
            table_rows = connection.execute(
                "SELECT name, sql FROM sqlite_master "
                "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
            for table_name, table_sql in table_rows:
                logical_digest.update(str(table_name).encode("utf-8"))
                logical_digest.update(b"\0")
                logical_digest.update(str(table_sql or "").encode("utf-8"))
                logical_digest.update(b"\0")
                columns = connection.execute(
                    f'PRAGMA table_info("{table_name}")'
                ).fetchall()
                order = ", ".join(str(index + 1) for index in range(len(columns)))
                data_rows = connection.execute(
                    f'SELECT * FROM "{table_name}" ORDER BY {order}'
                ).fetchall()
                logical_digest.update(
                    json.dumps(
                        data_rows, ensure_ascii=True, separators=(",", ":")
                    ).encode("utf-8")
                )
                logical_digest.update(b"\0")
        finally:
            connection.close()
        artifact.schema_version = int(version[0]) if version else None
        artifact.repository_count = len(rows)
        artifact.revisions = [str(row[0]) for row in rows]
        artifact.logical_sha256 = logical_digest.hexdigest()
    except (sqlite3.DatabaseError, OSError, TypeError, ValueError):
        pass
    return artifact


def clear_index(path: Path) -> None:
    """Remove only one experiment-owned index and its SQLite sidecars."""
    root = path.parent.resolve()
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        resolved = candidate.resolve()
        if resolved.parent != root:
            raise ValueError(f"Refusing to clear index outside {root}")
        if resolved.exists():
            resolved.unlink()
    if path.exists():
        raise RuntimeError(f"Cold index cleanup failed: {path}")


async def run_single_lifecycle(
    fixture: Fixture,
    *,
    variant: EvalVariant,
    relation_graph_index_path: Path | None,
    prime_graph_index: bool,
    temperature: float,
    review_max_iterations: int,
    agent_run_timeout_seconds: float | None = None,
    matcher_version: str = DEFAULT_EVAL_MATCHER_VERSION,
    diagnostic_artifact_dir: Path | None = None,
    defer_workspace_cleanup: bool = False,
    deferred_workspace_dir: Path | None = None,
) -> tuple[EvalResult, dict[str, Any]]:
    """Run the frozen eval pipeline with phase-two-owned index lifecycle."""
    active_contract_version = str(get_settings().finding_contract_version).strip()
    validate_eval_matcher_contract(matcher_version, active_contract_version)
    if active_contract_version == "3.0" and fixture.type != "review":
        raise ValueError(
            "Harness v3 paired evaluation only supports review fixtures"
        )
    expected_count = len(fixture.expected.issues)
    stage_timings: dict[str, float] = {}
    iteration_contract = base_runner.review_iteration_contract(review_max_iterations)
    lifecycle: dict[str, Any] = {"round_contract": iteration_contract}
    if defer_workspace_cleanup and deferred_workspace_dir is not None:
        # Development-only teardown deferral: keep the isolated workspace on
        # disk after the run so checkpoint append is not blocked by a slow
        # Windows rmtree of the full Haystack worktree.  The workspace is still
        # created fresh from the cache for every attempt; only post-run
        # deletion is postponed.  It has no effect on the A/B treatment.
        deferred_workspace_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir_ctx: Any = contextlib.nullcontext(str(deferred_workspace_dir))
    else:
        tmp_dir_ctx = tempfile.TemporaryDirectory(prefix="eval-fixture-")
    try:
        with tmp_dir_ctx as tmp_dir:
            stage_started = perf_counter()
            repo_root = await asyncio.to_thread(
                base_runner._prepare_fixture_workspace,
                fixture,
                Path(tmp_dir) / "repo",
                workspace_cache_dir=Path(get_settings().eval_workspace_cache_dir),
            )
            lifecycle["workspace_prepared"] = True
            stage_timings["prepare_workspace_seconds"] = perf_counter() - stage_started
            stage_started = perf_counter()
            validation_errors = await asyncio.to_thread(
                base_runner._validate_diff_added_lines_against_workspace,
                fixture,
                repo_root,
            ) + await asyncio.to_thread(
                base_runner._validate_expected_locations_against_diff,
                fixture,
                repo_root,
            )
            stage_timings["validate_fixture_seconds"] = perf_counter() - stage_started
            if validation_errors:
                lifecycle["fixture_validation_passed"] = False
                return (
                    EvalResult(
                        fixture_id=fixture.id,
                        fixture_type=fixture.type,
                        **base_runner._variant_result_fields(
                            variant, matcher_version=matcher_version
                        ),
                        finding_contract_version=active_contract_version,
                        schema_valid=False,
                        expected_count=expected_count,
                        stage_timings=stage_timings,
                        error="; ".join(validation_errors),
                    ),
                    lifecycle,
                )
            lifecycle["fixture_validation_passed"] = True
            workspace_sqlite_before = sorted(
                path.relative_to(repo_root).as_posix()
                for path in repo_root.rglob("*.sqlite*")
            )
            if prime_graph_index:
                if (
                    variant.graph_cache_mode != "warm"
                    or relation_graph_index_path is None
                ):
                    raise ValueError(
                        "Graph priming requires the warm variant and index path"
                    )
                original_diff = fixture.input.diff_text or ""
                prime_started = perf_counter()
                primed = await GraphHybridContextStrategy(
                    settings=get_settings(),
                    workspace_root=repo_root,
                    relation_graph_index_path=relation_graph_index_path,
                ).prepare(
                    ReviewRequest(
                        repo_path=str(repo_root),
                        diff_mode=bool(original_diff),
                        diff_text=original_diff,
                        verbose=False,
                    )
                )
                prime_seconds = perf_counter() - prime_started
                stage_timings["warm_priming_seconds"] = prime_seconds
                lifecycle["priming"] = {
                    "kind": "cold_context_priming",
                    "measured": False,
                    "latency_seconds": prime_seconds,
                    "prompt_tokens": None,
                    "completion_tokens": None,
                    "total_tokens": None,
                    "finding_count": None,
                    "telemetry": primed.graph_telemetry,
                    "index_artifact": inspect_index(
                        relation_graph_index_path
                    ).model_dump(mode="json"),
                }
                if (
                    primed.graph_telemetry.get("graph_status") != "ready"
                    or primed.graph_telemetry.get("graph_cache_mode") != "cold"
                    or primed.graph_telemetry.get("cache_hit") is not False
                    or not relation_graph_index_path.is_file()
                ):
                    raise RuntimeError(
                        "Warm priming did not produce a verified cold index"
                    )

            orchestrator = AgentOrchestrator(
                permission_mode="default",
                temperature=temperature,
                review_max_iterations=iteration_contract["effective_rounds"],
                review_min_tool_iterations=max(
                    1, get_settings().eval_review_min_tool_iterations
                ),
                review_diff_first_changed_files=True,
                agent_run_timeout_seconds=agent_run_timeout_seconds,
                relation_graph_index_path=relation_graph_index_path,
                context_mode=variant.context_mode,
            )
            sandbox_context = base_runner._build_fixture_context(fixture, repo_root)
            started = perf_counter()
            parsed_response: ReviewResponse | DebugResponse
            actual_count = 0
            if fixture.type == "review":
                original_diff = fixture.input.diff_text or ""
                response = await orchestrator.run_review(
                    ReviewRequest(
                        repo_path=str(repo_root),
                        diff_mode=bool(original_diff),
                        diff_text=base_runner._prepend_context(
                            original_diff, sandbox_context
                        ),
                        verbose=False,
                    )
                )
                parsed_response = ReviewResponse.model_validate(response.model_dump())
                validate_eval_matcher_contract(
                    matcher_version, parsed_response.report.schema_version
                )
                if parsed_response.report.schema_version != active_contract_version:
                    raise ValueError("Response finding contract differs from active experiment")
                actual_count = len(
                    base_runner._effective_review_issues(fixture, parsed_response)
                )
            else:
                original_error_log = fixture.input.error_log or ""
                response = await orchestrator.run_debug(
                    DebugRequest(
                        repo_path=str(repo_root),
                        error_log_text=base_runner._prepend_context(
                            original_error_log, sandbox_context
                        ),
                        verbose=False,
                    )
                )
                parsed_response = DebugResponse.model_validate(response.model_dump())
                actual_count = len(parsed_response.steps)
            latency = perf_counter() - started
            stage_timings["agent_run_seconds"] = latency
            total_tokens = base_runner._read_total_tokens(
                repo_root, parsed_response.run_id
            )
            log_stats = base_runner._read_event_log_stats(
                repo_root, parsed_response.run_id
            )
            resolved_log = base_runner._resolve_event_log_path(
                repo_root, parsed_response.run_id
            )
            event_log_path = base_runner._persist_event_log_to_outputs(
                Path(resolved_log) if resolved_log else None,
                fixture.id,
                parsed_response.run_id,
            )
            if diagnostic_artifact_dir is not None:
                journal_source = (
                    repo_root
                    / ".mergewarden"
                    / "runs"
                    / parsed_response.run_id
                    / "journal.jsonl"
                )
                lifecycle["run_journal_status"] = (
                    "persisted" if journal_source.is_file() else "missing_no_entries"
                )
                if journal_source.is_file():
                    diagnostic_artifact_dir.mkdir(parents=True, exist_ok=True)
                    journal_target = (
                        diagnostic_artifact_dir
                        / f"{fixture.id}_{variant.id}_{parsed_response.run_id}_journal.jsonl"
                    )
                    shutil.copy2(journal_source, journal_target)
                    lifecycle["run_journal_path"] = str(journal_target.resolve())
            matches, matched_count, false_positive_count = (
                base_runner._match_issues_for_version(
                    fixture, parsed_response, matcher_version
                )
            )
            location_matched_count, root_cause_matched_count = (
                base_runner._layered_match_counts(matches, matcher_version)
            )
            structural_metrics = base_runner._structural_issue_metrics(fixture, matches)
            dimension_counts = base_runner._v3_content_dimension_counts(
                fixture, parsed_response, matches, matcher_version
            )
            root_quality = (
                base_runner._root_cause_quality_for_version(
                    fixture, parsed_response, matches, matcher_version
                )
                if isinstance(parsed_response, ReviewResponse)
                else {}
            )
            placeholder = base_runner._is_placeholder_response(parsed_response)
            empty_business = base_runner._is_empty_business_output(parsed_response)
            workspace_sqlite_after = sorted(
                path.relative_to(repo_root).as_posix()
                for path in repo_root.rglob("*.sqlite*")
            )
            lifecycle.update(
                {
                    "relation_graph_index_path": (
                        str(relation_graph_index_path)
                        if relation_graph_index_path is not None
                        else None
                    ),
                    "workspace_sqlite_before": workspace_sqlite_before,
                    "workspace_sqlite_after": workspace_sqlite_after,
                    "workspace_sqlite_created": sorted(
                        set(workspace_sqlite_after) - set(workspace_sqlite_before)
                    ),
                }
            )
            process_metrics = extract_review_process_metrics(
                event_log_path, matcher_version=matcher_version
            )
            if isinstance(parsed_response, ReviewResponse):
                process_metrics.finding_contract_version = (
                    parsed_response.report.schema_version
                )
            raw_output = parsed_response.model_dump(mode="json")
            runtime_closeout = extract_runtime_closeout(
                event_log_path,
                raw_output=raw_output,
                finding_contract_version=active_contract_version,
            )
            attempt_cost = extract_attempt_cost(
                event_log_path,
                metrics=process_metrics,
                fallback_total_tokens=total_tokens,
            )
            raw_output["eval_runtime"] = {
                "round_contract": iteration_contract,
                "closeout": runtime_closeout.model_dump(mode="json"),
                "cost": attempt_cost.model_dump(mode="json"),
            }
            lifecycle["runtime_closeout"] = runtime_closeout.model_dump(mode="json")
            lifecycle["attempt_cost"] = attempt_cost.model_dump(mode="json")
            result = EvalResult(
                fixture_id=fixture.id,
                fixture_type=fixture.type,
                **base_runner._variant_result_fields(
                    variant, matcher_version=matcher_version
                ),
                finding_contract_version=active_contract_version,
                run_id=parsed_response.run_id,
                schema_valid=base_runner._eval_schema_valid(parsed_response),
                expected_count=expected_count,
                actual_count=actual_count,
                matched_count=matched_count,
                false_positive_count=false_positive_count,
                location_matched_count=location_matched_count,
                root_cause_matched_count=root_cause_matched_count,
                **root_quality,
                **dimension_counts,
                latency_seconds=latency,
                total_tokens=total_tokens,
                event_log_path=event_log_path,
                stage_timings=stage_timings,
                error=(
                    "Empty review output: no summary or issues."
                    if empty_business
                    else (
                        "Placeholder review output: no submit_review/debug before finalize."
                        if placeholder
                        else None
                    )
                ),
                issue_matches=matches,
                structural_metrics=structural_metrics,
                raw_output=raw_output,
                placeholder_summary=placeholder,
                submit_review_seen_any=log_stats["submit_review_seen_any"],
                submit_debug_seen_any=log_stats["submit_debug_seen_any"],
                budget_exhausted=log_stats["budget_exhausted"],
                budget_state=log_stats["budget_state"],
                finish_reasons=log_stats["finish_reasons"],
                workflow_invalid=(
                    parsed_response.workflow_invalid
                    if isinstance(parsed_response, ReviewResponse)
                    else False
                ),
                workflow_missing_steps=(
                    parsed_response.workflow_missing_steps
                    if isinstance(parsed_response, ReviewResponse)
                    else []
                ),
                process_metrics=process_metrics,
            )
            return result, lifecycle
    except Exception as exc:  # noqa: BLE001
        return (
            EvalResult(
                fixture_id=fixture.id,
                fixture_type=fixture.type,
                **base_runner._variant_result_fields(
                    variant, matcher_version=matcher_version
                ),
                finding_contract_version=active_contract_version,
                schema_valid=False,
                expected_count=expected_count,
                stage_timings=stage_timings,
                error=str(exc),
            ),
            lifecycle,
        )


def variant_order(seed: int, fixture_index: int, sample: int = 0) -> list[str]:
    """Return a reproducible balanced order without changing pair membership."""
    latin = [
        list(VARIANT_IDS),
        [VARIANT_IDS[2], VARIANT_IDS[0], VARIANT_IDS[1]],
        [VARIANT_IDS[1], VARIANT_IDS[2], VARIANT_IDS[0]],
    ]
    rng = random.Random(seed)
    offset = rng.randrange(len(latin))
    return latin[(offset + fixture_index + sample) % len(latin)]


def _load_fixture(path: Path, *, allow_unreviewed: bool = False) -> Fixture:
    fixture = Fixture.model_validate_json(path.read_text(encoding="utf-8"))
    tags = {tag.lower().replace("_", "-") for tag in fixture.metadata.tags}
    if fixture.metadata.suite.lower().replace("_", "-") == "held-out" or any(
        tag in {"held-out", "holdout"} for tag in tags
    ):
        raise ValueError(f"Held-out fixture is forbidden: {fixture.id}")
    if not fixture.metadata.reviewed and not allow_unreviewed:
        raise ValueError(f"Pilot fixture is not reviewed: {fixture.id}")
    return fixture


def _load_config(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise TypeError("Pilot config must be a mapping")
    if payload.get("formal_graph_ab") is not False:
        raise ValueError("Pilot must set formal_graph_ab=false")
    if payload.get("held_out_executed") is not False:
        raise ValueError("Pilot must set held_out_executed=false")
    shared = payload.get("shared")
    if not isinstance(shared, dict):
        raise ValueError("Pilot config must declare a shared runtime contract")
    raw_rounds = shared.get("max_iterations")
    if isinstance(raw_rounds, bool) or not isinstance(raw_rounds, int) or raw_rounds < 1:
        raise ValueError("Pilot shared.max_iterations must be a positive integer")
    return payload


def _variants(config: dict[str, Any]) -> dict[str, EvalVariant]:
    variants = {
        item["id"]: EvalVariant(
            id=item["id"],
            context_mode=item["context_mode"],
            graph_cache_mode=(
                "disabled"
                if item["id"] == "A-agent-search"
                else item["graph_cache_mode"]
            ),
        )
        for item in config.get("variants", [])
    }
    unknown = set(variants) - set(VARIANT_IDS)
    if unknown:
        raise ValueError(f"Unknown pilot variants: {sorted(unknown)}")
    if not variants:
        raise ValueError("Pilot variants must not be empty")
    # Development matrices (runtime_contract_source=current) may declare a
    # subset of the three pilot variants; frozen phase-two configs keep the
    # strict three-variant contract.
    if config.get("runtime_contract_source") != "current" and tuple(
        variants
    ) != VARIANT_IDS:
        raise ValueError(f"Pilot variants must be exactly {VARIANT_IDS}")
    return variants


def _run_git(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout.strip()


def _frozen_contract(config: dict[str, Any]) -> dict[str, Any]:
    baseline_path = ROOT / "eval" / "contracts" / "agent-baseline-v1.yaml"
    baseline = yaml.safe_load(baseline_path.read_text(encoding="utf-8"))
    if config.get("runtime_contract_source") == "current":
        return {"shared": dict(config.get("shared", {})), "contracts": {}}
    runtime = baseline["runtime"]
    expected = {
        "model": runtime["model"],
        "temperature": runtime["temperature"],
        "max_output_tokens": runtime["max_output_tokens"],
        "max_iterations": runtime["max_iterations"],
        "tool_budget": runtime["tool_budget"],
        "model_request_timeout_seconds": runtime["model_request_timeout_seconds"],
        "tool_timeout_seconds": runtime["tool_timeout_seconds"],
    }
    shared = config.get("shared", {})
    mismatches = [key for key, value in expected.items() if shared.get(key) != value]
    if mismatches:
        raise ValueError(
            f"Pilot shared config differs from frozen baseline: {mismatches}"
        )
    run_timeout_seconds = float(
        shared.get("run_timeout_seconds", runtime["run_timeout_seconds"])
    )
    if run_timeout_seconds <= 0:
        raise ValueError("Pilot run_timeout_seconds must be greater than zero")
    expected["run_timeout_seconds"] = run_timeout_seconds
    return {"shared": expected, "contracts": baseline["contracts"]}


def _apply_runtime_contract(config: dict[str, Any]) -> None:
    """Apply an explicit development-run contract to the shared runtime settings.

    `get_settings()` builds a fresh Settings instance from the environment on
    every call, so mutating a single instance does not propagate to the
    orchestrator / graph strategy / inference engine / model client.  For
    development configs (runtime_contract_source=current) we therefore write
    the contract values into the environment first: every later
    ``get_settings()`` then materialises the same effective values.  This
    keeps the change inside the eval harness and leaves production settings
    untouched.
    """
    if config.get("runtime_contract_source") != "current":
        return
    # Provider selection is part of a real-model eval contract.  Model names
    # such as ``glm-5.3-flash`` are not sufficient to distinguish the zhipu
    # endpoint from other OpenAI-compatible gateways, and those gateways can
    # expose different reasoning controls.  Keep the provider/base URL in
    # the experiment config so a run cannot silently switch compatibility
    # profiles because the user's local .env points elsewhere.
    provider = str(config.get("provider", "")).strip()
    base_url = str(config.get("base_url", "")).strip()
    if provider:
        os.environ["MODEL_PROVIDER"] = provider
    if base_url:
        os.environ["OPENAI_BASE_URL"] = base_url
    shared = config.get("shared", {})
    env_map = {
        "finding_contract_version": "FINDING_CONTRACT_VERSION",
        "model_max_retries": "MODEL_MAX_RETRIES",
        "model": "MODEL_NAME",
        "max_output_tokens": "MODEL_MAX_TOKENS",
        "exploration_max_output_tokens": "EXPLORATION_MAX_OUTPUT_TOKENS",
        "submit_max_output_tokens": "SUBMIT_MAX_OUTPUT_TOKENS",
        "tool_budget": "AGENT_MAX_TOOL_CALLS",
        "agent_max_recoverable_tool_errors": "AGENT_MAX_RECOVERABLE_TOOL_ERRORS",
        "model_request_timeout_seconds": "MODEL_REQUEST_TIMEOUT_SECONDS",
        "tool_timeout_seconds": "AGENT_TOOL_TIMEOUT_SECONDS",
        "run_timeout_seconds": "AGENT_RUN_TIMEOUT_SECONDS",
        "prompt_input_token_budget": "PROMPT_INPUT_TOKEN_BUDGET",
        "token_budget": "TOKEN_BUDGET",
        "token_hard_budget": "TOKEN_HARD_BUDGET",
        "final_submit_reserve_tokens": "FINAL_SUBMIT_RESERVE_TOKENS",
        "final_submit_prompt_token_budget": "FINAL_SUBMIT_PROMPT_TOKEN_BUDGET",
        "final_submit_feedback_token_budget": "FINAL_SUBMIT_FEEDBACK_TOKEN_BUDGET",
        "final_submit_request_token_budget": "FINAL_SUBMIT_REQUEST_TOKEN_BUDGET",
        "assembled_request_token_budget": "ASSEMBLED_REQUEST_TOKEN_BUDGET",
        "review_repair_max_attempts": "REVIEW_REPAIR_MAX_ATTEMPTS",
        "max_iterations": "REVIEW_MAX_ITERATIONS",
    }
    for config_key, env_key in env_map.items():
        if config_key in shared:
            os.environ[env_key] = str(shared[config_key])
    settings = get_settings()
    field_map = {
        "model": "model_name",
        "max_output_tokens": "model_max_tokens",
        "exploration_max_output_tokens": "exploration_max_output_tokens",
        "submit_max_output_tokens": "submit_max_output_tokens",
        "tool_budget": "agent_max_tool_calls",
        "agent_max_recoverable_tool_errors": "agent_max_recoverable_tool_errors",
        "model_request_timeout_seconds": "model_request_timeout_seconds",
        "tool_timeout_seconds": "agent_tool_timeout_seconds",
        "prompt_input_token_budget": "prompt_input_token_budget",
        "token_budget": "token_budget",
        "token_hard_budget": "token_hard_budget",
        "final_submit_reserve_tokens": "final_submit_reserve_tokens",
        "final_submit_prompt_token_budget": "final_submit_prompt_token_budget",
        "final_submit_feedback_token_budget": "final_submit_feedback_token_budget",
        "final_submit_request_token_budget": "final_submit_request_token_budget",
        "assembled_request_token_budget": "assembled_request_token_budget",
        "review_repair_max_attempts": "review_repair_max_attempts",
    }
    for config_key, settings_key in field_map.items():
        if config_key in shared:
            setattr(settings, settings_key, shared[config_key])


def _fixture_entries(
    config: dict[str, Any], suite: str
) -> list[tuple[Fixture, list[str], str]]:
    output: list[tuple[Fixture, list[str], str]] = []
    for item in config.get("fixtures", []):
        phase = str(item.get("phase", "validation"))
        selected = (
            suite == "all"
            or phase == suite
            or (suite == "preview" and phase == "preflight")
        )
        if not selected:
            continue
        path = (ROOT / str(item["path"])).resolve()
        allow_unreviewed = phase == "preview" and bool(
            config.get("engineering_preview")
        )
        output.append(
            (
                _load_fixture(path, allow_unreviewed=allow_unreviewed),
                list(item.get("types", [])),
                phase,
            )
        )
    if not output:
        raise ValueError(f"No pilot fixtures selected for suite={suite}")
    return output


def _experiment_contract_hash(
    config: dict[str, Any],
    frozen_contract: dict[str, Any],
    *,
    seed: int,
) -> str:
    payload = {
        "experiment_id": config["experiment_id"],
        "seed": seed,
        "shared_contract": frozen_contract,
        "variants": config.get("variants", []),
        "formal_graph_ab": config.get("formal_graph_ab"),
        "held_out_executed": config.get("held_out_executed"),
        "runtime_identity": _runtime_identity(config),
    }
    canonical = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _runtime_identity(config: dict[str, Any]) -> dict[str, Any]:
    """Hash implementation, prompt/schema, provider, matcher, and budget inputs."""

    source_names = (
        "eval/graph_ab_pilot.py",
        "eval/run_summary.py",
        "eval/runner.py",
        "eval/schemas.py",
        "src/analyzer/context_planner.py",
        "src/analyzer/context_state.py",
        "src/analyzer/context_strategy.py",
        "src/analyzer/evidence_binding.py",
        "src/analyzer/evidence_ledger.py",
        "src/analyzer/finding_contract.py",
        "src/analyzer/finding_delivery.py",
        "src/analyzer/semantic_verifier.py",
        "src/analyzer/finding_integrity.py",
        "src/analyzer/finding_schema.py",
        "src/analyzer/inference_engine.py",
        "src/analyzer/output_formatter.py",
        "src/analyzer/prompts.py",
        "src/analyzer/schemas.py",
        "src/analyzer/verifier_context.py",
        "src/config.py",
        "src/models/client.py",
        "src/models/compat.py",
        "src/models/request_assembler.py",
        "src/models/schemas.py",
        "src/orchestrator/agent_loop.py",
        "src/orchestrator/tool_schemas.py",
        "src/tools/changed_context_tool.py",
        "src/tools/file_read.py",
        "src/tools/grep_tool.py",
        "src/tools/review_draft_validator_tool.py",
        "src/tools/symbol_context_tool.py",
    )
    implementation: dict[str, str] = {}
    for name in source_names:
        path = ROOT / name
        if path.is_file():
            implementation[name] = _sha256(path)
    shared = config.get("shared", {})
    if not isinstance(shared, dict):
        shared = {}
    safe_shared = {
        str(key): value
        for key, value in shared.items()
        if "key" not in str(key).lower()
        and "secret" not in str(key).lower()
        and not (
            "prompt" in str(key).lower()
            and "budget" not in str(key).lower()
        )
    }
    raw_base_url = os.getenv("OPENAI_BASE_URL", "").strip()
    try:
        parsed_base_url = urlsplit(raw_base_url)
        provider_base_url = {
            "scheme": parsed_base_url.scheme.lower(),
            "hostname": (parsed_base_url.hostname or "").lower(),
            "port": parsed_base_url.port,
            "path": parsed_base_url.path.rstrip("/"),
        }
    except ValueError:
        provider_base_url = {"invalid": True}
    return {
        "identity_version": 3,
        "implementation": implementation,
        "provider": os.getenv("MODEL_PROVIDER", "").strip().lower(),
        "provider_base_url": provider_base_url,
        "model": str(shared.get("model", os.getenv("MODEL_NAME", ""))),
        "reasoning": {
            "configured": shared.get(
                "reasoning_effort", shared.get("thinking", "")
            ),
            "explore_policy": "high",
            "submit_policy": "off",
        },
        "matcher_version": config.get("matcher_version", DEFAULT_EVAL_MATCHER_VERSION),
        "budgets": safe_shared,
    }


def _stable_run_key(
    *,
    experiment_id: str,
    fixture_id: str,
    sample_index: int,
    variant_id: str,
    repository_snapshot: str,
    experiment_contract_hash: str,
) -> StableRunKey:
    return StableRunKey(
        experiment_id=experiment_id,
        fixture_id=fixture_id,
        sample_index=sample_index,
        variant_id=variant_id,
        repository_snapshot=repository_snapshot,
        experiment_contract_hash=experiment_contract_hash,
    )


_CHECKPOINT_SENSITIVE_PARTS = (
    "api_key",
    "prompt",
    "raw_output",
    "event_log_path",
    "relation_graph_index_path",
)
_CHECKPOINT_SAFE_TOKEN_FIELDS = {
    "prompt_tokens",
    "successful_prompt_tokens",
    "successful_cached_prompt_tokens",
    "successful_adjacent_common_prefix_tokens",
    "cache_observation_count",
    "provider_cache_hit_count",
}


def _sanitize_checkpoint_value(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower()
            if normalized in _CHECKPOINT_SAFE_TOKEN_FIELDS:
                sanitized[key] = _sanitize_checkpoint_value(item)
            elif any(part in normalized for part in _CHECKPOINT_SENSITIVE_PARTS):
                sanitized[key] = {} if normalized == "raw_output" else None
            elif normalized == "path":
                sanitized[key] = ""
            else:
                sanitized[key] = _sanitize_checkpoint_value(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_checkpoint_value(item) for item in value]
    return value


def _checkpoint_run_record(record: PilotRunRecord) -> dict[str, Any]:
    """Keep aggregation state while removing prompts, code output, and local paths."""
    return _sanitize_checkpoint_value(record.model_dump(mode="json"))


def _checkpoint_status(record: PilotRunRecord) -> CheckpointStatus:
    if record.valid:
        return "measured"
    if (
        not record.result.run_id
        and "prepare_workspace_seconds" not in record.result.stage_timings
    ):
        return "workspace_failure"
    return "invalid"


def _sanitized_result_artifact(record: PilotRunRecord) -> dict[str, Any]:
    """Build a source-free result projection for durable checkpoint restore."""

    result = record.result.model_dump(mode="json")
    raw = result.get("raw_output")
    raw_report = raw.get("report") if isinstance(raw, dict) else None
    issue_digests: list[dict[str, Any]] = []
    if isinstance(raw_report, dict) and isinstance(raw_report.get("issues"), list):
        for issue in raw_report["issues"]:
            if not isinstance(issue, dict):
                continue
            safe_issue = {
                key: issue.get(key)
                for key in ("severity", "location", "finding_id", "candidate_id")
                if issue.get(key) not in (None, "")
            }
            safe_issue["evidence_sha256"] = hashlib.sha256(
                str(issue.get("evidence", "")).encode("utf-8")
            ).hexdigest()
            safe_issue["suggestion_sha256"] = hashlib.sha256(
                str(issue.get("suggestion", "")).encode("utf-8")
            ).hexdigest()
            issue_digests.append(safe_issue)
    result["raw_output"] = {
        "schema_version": "sanitized-result-v1",
        "report": {
            "issue_count": len(issue_digests),
            "summary_present": bool(isinstance(raw_report, dict) and raw_report.get("summary")),
            "issues": issue_digests,
        },
    }
    result["event_log_path"] = None
    canonical = json.dumps(result, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    artifact_id = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return {
        "schema_version": "sanitized-result-artifact-v1",
        "artifact_id": artifact_id,
        "result": result,
    }


def _write_result_artifact(record: PilotRunRecord, artifact_root: Path) -> tuple[str, str, str]:
    """Persist one independent sanitized result artifact and return its reference."""

    payload = _sanitized_result_artifact(record)
    artifact_id = str(payload["artifact_id"])
    canonical = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    serialized = canonical + "\n"
    digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    directory = artifact_root / "result_artifacts"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{artifact_id}.json"
    target.write_text(serialized, encoding="utf-8")
    return artifact_id, digest, target.relative_to(artifact_root).as_posix()


def _record_from_checkpoint(
    record: dict[str, Any] | None,
    *,
    artifact_root: Path | None = None,
    require_artifact: bool = False,
) -> PilotRunRecord:
    if record is None:
        raise RuntimeError("Checkpoint run record is missing")
    payload = dict(record)
    artifact_ref = str(payload.get("result_artifact_ref", "") or "")
    artifact_sha = str(payload.get("result_artifact_sha256", "") or "")
    if require_artifact and artifact_root is None:
        raise RuntimeError("Checkpoint result artifact root is missing")
    if require_artifact and not artifact_ref:
        raise RuntimeError("Checkpoint result artifact reference is missing")
    if require_artifact and not artifact_sha:
        raise RuntimeError("Checkpoint result artifact hash is missing")
    if require_artifact and not str(payload.get("result_artifact_id", "")):
        raise RuntimeError("Checkpoint result artifact id is missing")
    if artifact_root is not None and artifact_ref:
        target = (artifact_root / artifact_ref).resolve()
        expected_root = artifact_root.resolve()
        if not target.is_relative_to(expected_root) or target.name != (
            str(payload.get("result_artifact_id", "")) + ".json"
        ):
            raise RuntimeError("Checkpoint result artifact reference is invalid")
        if not target.is_file():
            raise RuntimeError("Checkpoint result artifact is missing")
        raw = target.read_text(encoding="utf-8")
        if artifact_sha and hashlib.sha256(raw.encode("utf-8")).hexdigest() != artifact_sha:
            raise RuntimeError("Checkpoint result artifact hash mismatch")
        artifact = json.loads(raw)
        if not isinstance(artifact, dict) or not isinstance(
            artifact.get("result"), dict
        ):
            raise RuntimeError("Checkpoint result artifact is invalid")
        if artifact.get("artifact_id") != payload.get("result_artifact_id"):
            raise RuntimeError("Checkpoint result artifact id mismatch")
        canonical_result = json.dumps(
            artifact["result"],
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )
        if hashlib.sha256(canonical_result.encode("utf-8")).hexdigest() != str(
            payload.get("result_artifact_id", "")
        ):
            raise RuntimeError("Checkpoint result artifact content mismatch")
        payload["result"] = artifact["result"]
    return PilotRunRecord.model_validate(payload)


async def run_pilot(
    *,
    config_path: Path,
    suite: str,
    samples: int,
    seed: int,
    checkpoint_path: Path | None = None,
    resume: bool = True,
    retry_invalid: bool = True,
    stop_after_measured: int | None = None,
    defer_workspace_cleanup: bool = False,
) -> dict[str, Any]:
    config = _load_config(config_path)
    _apply_runtime_contract(config)
    round_contract = base_runner.review_iteration_contract(
        int(config["shared"]["max_iterations"])
    )
    validate_eval_matcher_contract(
        str(config.get("matcher_version", DEFAULT_EVAL_MATCHER_VERSION)),
        get_settings().finding_contract_version,
    )
    frozen = _frozen_contract(config)
    variants = _variants(config)
    configured_sample_counts = {
        str(item["id"]): max(1, int(item.get("samples", samples)))
        for item in config.get("variants", [])
    }
    entries = _fixture_entries(config, suite)
    experiment_contract_hash = _experiment_contract_hash(config, frozen, seed=seed)
    journal = CheckpointJournal(checkpoint_path) if checkpoint_path else None
    if journal is not None and not resume:
        journal.reset()
    records: list[PilotRunRecord] = []
    reused_run_count = 0
    attempted_run_count = 0
    smoke_valid = True
    for fixture_index, (fixture, fixture_types, phase) in enumerate(entries):
        if phase != "smoke" and not smoke_valid:
            break
        snapshot = _fixture_snapshot(fixture)
        index_path = (
            ROOT
            / "eval"
            / "outputs"
            / "graph_ab_indexes"
            / re.sub(r"[^A-Za-z0-9_.-]+", "_", fixture.id)
            / "pilot.sqlite3"
        ).resolve()
        index_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_records: list[PilotRunRecord] = []
        sample_counts = (
            {variant_id: 1 for variant_id in variants}
            if phase == "smoke"
            else configured_sample_counts
        )
        fixture_samples = max(sample_counts.values())
        for sample in range(fixture_samples):
            order = [
                variant_id
                for variant_id in variant_order(seed, fixture_index, sample)
                if variant_id in sample_counts
                and sample < sample_counts[variant_id]
            ]
            for order_index, variant_id in enumerate(order):
                variant = variants[variant_id]
                stable_key = _stable_run_key(
                    experiment_id=str(config["experiment_id"]),
                    fixture_id=fixture.id,
                    sample_index=sample + 1,
                    variant_id=variant_id,
                    repository_snapshot=snapshot,
                    experiment_contract_hash=experiment_contract_hash,
                )
                if journal is not None and resume:
                    artifact_repair_required = False
                    completed = journal.completed(stable_key)
                    if completed is not None:
                        try:
                            reused = _record_from_checkpoint(
                                completed.run_record,
                                artifact_root=checkpoint_path.parent
                                if checkpoint_path is not None
                                else None,
                                require_artifact=True,
                            )
                        except RuntimeError:
                            # A missing/tampered independent artifact is not a
                            # valid resume hit; re-measure the run instead.
                            reused = None
                            artifact_repair_required = True
                            journal.append(
                                key=stable_key,
                                status="invalid",
                                valid=False,
                                run_record=completed.run_record,
                            )
                        if reused is None:
                            pass
                        else:
                            records.append(reused)
                            fixture_records.append(reused)
                            reused_run_count += 1
                            continue
                    if not retry_invalid and not artifact_repair_required:
                        failed = journal.latest_failure(stable_key)
                        if failed is not None:
                            try:
                                reused = _record_from_checkpoint(
                                    failed.run_record,
                                    artifact_root=checkpoint_path.parent
                                    if checkpoint_path is not None
                                    else None,
                                    require_artifact=True,
                                )
                            except RuntimeError:
                                # A historical invalid result without a
                                # verifiable artifact cannot be reused under
                                # the no-retry option; measure it again.
                                reused = None
                            if reused is not None:
                                records.append(reused)
                                fixture_records.append(reused)
                                reused_run_count += 1
                                continue
                index_before: IndexArtifact | None = None
                if variant.context_mode == "graph_hybrid":
                    clear_index(index_path)
                    index_before = inspect_index(index_path)
                    if index_before.exists:
                        raise RuntimeError(f"Index still exists before {variant_id}")
                result, lifecycle = await run_single_lifecycle(
                    fixture,
                    variant=variant,
                    relation_graph_index_path=(
                        index_path if variant.context_mode == "graph_hybrid" else None
                    ),
                    prime_graph_index=variant_id == "B2-graph-hybrid-warm",
                    temperature=float(config["shared"]["temperature"]),
                    review_max_iterations=int(config["shared"]["max_iterations"]),
                    matcher_version=str(
                        config.get("matcher_version", DEFAULT_EVAL_MATCHER_VERSION)
                    ),
                    agent_run_timeout_seconds=float(
                        config["shared"]["run_timeout_seconds"]
                    ),
                    diagnostic_artifact_dir=(
                        checkpoint_path.parent / "run_journals"
                        if checkpoint_path is not None
                        else None
                    ),
                    defer_workspace_cleanup=defer_workspace_cleanup,
                    deferred_workspace_dir=(
                        (
                            checkpoint_path.parent
                            / "deferred_workspaces"
                            / hashlib.sha1(
                                f"{fixture.id}:{variant_id}:{sample + 1}".encode(
                                    "utf-8"
                                )
                            ).hexdigest()[:8]
                        )
                        if defer_workspace_cleanup and checkpoint_path is not None
                        else None
                    ),
                )
                index_after = (
                    inspect_index(index_path)
                    if variant.context_mode == "graph_hybrid"
                    else None
                )
                if index_after is not None:
                    lifecycle["measured_index_artifact"] = index_after.model_dump(
                        mode="json"
                    )
                contract = validate_variant_contract(variant, result, lifecycle)
                reasons = list(contract.errors)
                if variant.context_mode == "graph_hybrid":
                    if index_after is None or not index_after.exists:
                        reasons.append("graph_index_missing")
                    elif index_after.schema_version != INDEX_SCHEMA_VERSION:
                        reasons.append("graph_index_schema_mismatch")
                record = PilotRunRecord(
                    fixture_id=fixture.id,
                    fixture_types=fixture_types,
                    repository_snapshot=snapshot,
                    sample=sample + 1,
                    order=order_index + 1,
                    variant_id=variant_id,
                    run_id=result.run_id
                    or f"failed:{fixture.id}:{variant_id}:{sample + 1}",
                    valid=not reasons,
                    invalid_reasons=list(dict.fromkeys(reasons)),
                    contract=contract,
                    index_before=index_before,
                    index_after=index_after,
                    lifecycle=lifecycle,
                    result=result,
                )
                if checkpoint_path is not None:
                    artifact_id, artifact_sha, artifact_ref = _write_result_artifact(
                        record, checkpoint_path.parent
                    )
                    record = record.model_copy(
                        update={
                            "result_artifact_id": artifact_id,
                            "result_artifact_sha256": artifact_sha,
                            "result_artifact_ref": artifact_ref,
                        }
                    )
                if journal is not None:
                    if lifecycle.get("priming") is not None:
                        journal.append(
                            key=stable_key,
                            status="priming",
                            valid=False,
                            run_record=None,
                        )
                    status = _checkpoint_status(record)
                    journal.append(
                        key=stable_key,
                        status=status,
                        valid=status == "measured",
                        run_record=_checkpoint_run_record(record),
                    )
                records.append(record)
                fixture_records.append(record)
                attempted_run_count += 1
                if (
                    stop_after_measured is not None
                    and attempted_run_count >= stop_after_measured
                ):
                    raise ControlledPilotInterruption(
                        "Controlled interruption after "
                        f"{attempted_run_count} measured attempts"
                    )
        if phase == "smoke":
            smoke_valid = all(item.valid for item in fixture_records) and {
                item.variant_id for item in fixture_records
            } == set(VARIANT_IDS)

    pairing_errors: list[str] = []
    by_fixture_sample: dict[tuple[str, int], list[PilotRunRecord]] = defaultdict(list)
    for record in records:
        by_fixture_sample[(record.fixture_id, record.sample)].append(record)
    for key, paired in by_fixture_sample.items():
        expected_variants = {
            variant_id
            for variant_id, count in configured_sample_counts.items()
            if key[1] <= count
        }
        if {item.variant_id for item in paired} != expected_variants:
            pairing_errors.append(f"{key}:variant_membership")
        if len({item.repository_snapshot for item in paired}) != 1:
            pairing_errors.append(f"{key}:snapshot_mismatch")
    generated_at = datetime.now(UTC).isoformat()
    payload = {
        "experiment_id": config["experiment_id"],
        "finding_contract_version": get_settings().finding_contract_version,
        "semantic_rule_version": base_runner.V3_CONTENT_JUDGMENT_VERSION,
        "runtime_identity": _runtime_identity(config),
        "generated_at": generated_at,
        "branch": _run_git("branch", "--show-current"),
        "start_commit": _run_git("merge-base", "HEAD", "origin/main"),
        "implementation_commit": _run_git("rev-parse", "HEAD"),
        "frozen_baseline_tag": "eval/agent-baseline-v1",
        "frozen_baseline_target": _run_git(
            "rev-parse", "eval/agent-baseline-v1^{commit}"
        ),
        "formal_graph_ab": False,
        "held_out_executed": False,
        "seed": seed,
        "samples": samples,
        "variant_sample_counts": configured_sample_counts,
        "round_contract": round_contract,
        "suite": suite,
        "shared_contract": frozen,
        "experiment_contract_hash": experiment_contract_hash,
        "checkpoint": {
            "path": str(checkpoint_path.resolve()) if checkpoint_path else None,
            "resume_enabled": resume,
            "retry_invalid": retry_invalid,
            "reused_run_count": reused_run_count,
            "attempted_run_count": attempted_run_count,
        },
        "pairing_errors": pairing_errors,
        "records": [item.model_dump(mode="json") for item in records],
    }
    return payload


def _ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _stats(values: list[float | int | None]) -> dict[str, float | int | None]:
    clean = [float(value) for value in values if value is not None]
    if not clean:
        return {
            "mean": None,
            "median": None,
            "standard_deviation": None,
            "min": None,
            "max": None,
        }
    return {
        "mean": mean(clean),
        "median": median(clean),
        "standard_deviation": pstdev(clean) if len(clean) > 1 else 0.0,
        "min": min(clean),
        "max": max(clean),
    }


def _structural_metrics_payload(
    metrics: StructuralIssueMetrics,
) -> dict[str, int | float | None]:
    return metrics.model_dump(mode="json") | {
        "overall_recall": metrics.overall_recall,
        "local_recall": metrics.local_recall,
        "direct_cross_file_recall": metrics.direct_cross_file_recall,
        "multi_hop_recall": metrics.multi_hop_recall,
        "graph_observable_recall": metrics.graph_observable_recall,
        "graph_unobservable_recall": metrics.graph_unobservable_recall,
        "structural_annotation_coverage": metrics.structural_annotation_coverage,
        "graph_observability_annotation_coverage": (
            metrics.graph_observability_annotation_coverage
        ),
    }


def _aggregate_run_structural_metrics(
    results: list[EvalResult],
) -> StructuralIssueMetrics:
    return StructuralIssueMetrics.model_validate(
        {
            field: sum(getattr(result.structural_metrics, field) for result in results)
            for field in StructuralIssueMetrics.model_fields
        }
    )


def _record_closeout(record: PilotRunRecord) -> Any:
    """Read status from the timeline, with explicit response fallback."""

    return extract_runtime_closeout(
        record.result.event_log_path,
        raw_output=record.result.raw_output,
        finding_contract_version=record.result.finding_contract_version,
    )


def _quality_eligibility(
    record: PilotRunRecord,
    closeout: Any,
) -> tuple[bool, list[str]]:
    """Separate runner validity from complete quality-gate eligibility."""

    result = record.result
    reasons: list[str] = []
    if not record.valid:
        reasons.extend(["runner_invalid", *record.invalid_reasons])
    if result.error:
        reasons.append("result_error")
    if not result.schema_valid:
        reasons.append("schema_invalid")
    if result.placeholder_summary:
        reasons.append("placeholder_output")

    contract_version = str(
        result.finding_contract_version or closeout.finding_contract_version
    ).strip()
    if contract_version == "3.0":
        if closeout.completion_status != "complete":
            reasons.append("incomplete_closeout")
        if not closeout.review_complete:
            reasons.append("review_incomplete")
        if not closeout.delivery_complete:
            reasons.append("delivery_incomplete")
        if not closeout.report_ready:
            reasons.append("report_not_ready")
        if closeout.external_publish_status == "failed":
            reasons.append("external_publish_failed")
    return not reasons, list(dict.fromkeys(reasons))


def _cost_row(
    record: PilotRunRecord,
    *,
    closeout: Any,
    quality_eligible: bool,
    quality_exclusion_reasons: list[str],
) -> dict[str, Any]:
    result = record.result
    metrics = result.process_metrics
    attempt_cost = extract_attempt_cost(
        result.event_log_path,
        metrics=metrics,
        fallback_total_tokens=result.total_tokens,
    )
    return {
        "run_id": record.run_id,
        "fixture_id": record.fixture_id,
        "variant_id": record.variant_id,
        "valid": record.valid,
        "invalid_reasons": list(record.invalid_reasons),
        "quality_eligible": quality_eligible,
        "quality_exclusion_reasons": quality_exclusion_reasons,
        "completion_status": closeout.completion_status,
        "finding_run_status": closeout.finding_run_status,
        "finish_seen": closeout.finish_seen,
        "investigation_ready": closeout.investigation_ready,
        "submission_received": closeout.submission_received,
        "review_complete": closeout.review_complete,
        "delivery_complete": closeout.delivery_complete,
        "report_ready": closeout.report_ready,
        "external_publish_status": closeout.external_publish_status,
        "incomplete_reasons": list(closeout.incomplete_reasons),
        **result.stage_timings,
        "graph_build_latency_seconds": metrics.graph_build_latency_seconds,
        "incremental_update_latency_seconds": metrics.incremental_update_latency_seconds,
        "context_planning_latency_seconds": None,
        "reviewer_latency_seconds": metrics.reviewer_latency_seconds,
        "verifier_latency_seconds": metrics.verifier_latency_seconds,
        "consolidation_latency_seconds": metrics.consolidation_latency_seconds,
        "end_to_end_latency_seconds": metrics.end_to_end_latency_seconds,
        "prompt_tokens": attempt_cost.prompt_tokens,
        "completion_tokens": attempt_cost.completion_tokens,
        "total_tokens": attempt_cost.total_tokens,
        "cost_status": attempt_cost.cost_status,
        "usage_known": attempt_cost.usage_known,
        "provider_attempt_count": attempt_cost.provider_attempt_count,
        "reviewer_provider_attempt_count": attempt_cost.reviewer_provider_attempt_count,
        "verifier_provider_attempt_count": attempt_cost.verifier_provider_attempt_count,
        "successful_attempt_count": attempt_cost.successful_attempt_count,
        "failed_attempt_count": attempt_cost.failed_attempt_count,
        "known_usage_attempt_count": attempt_cost.known_usage_attempt_count,
        "unknown_usage_attempt_count": attempt_cost.unknown_usage_attempt_count,
        "reviewer_unknown_usage_attempt_count": (
            attempt_cost.reviewer_unknown_usage_attempt_count
        ),
        "verifier_unknown_usage_attempt_count": (
            attempt_cost.verifier_unknown_usage_attempt_count
        ),
        "reviewer_total_tokens": attempt_cost.reviewer_total_tokens,
        "verifier_total_tokens": attempt_cost.verifier_total_tokens,
        "successful_prompt_tokens": attempt_cost.successful_prompt_tokens,
        "successful_completion_tokens": attempt_cost.successful_completion_tokens,
        "successful_reasoning_tokens": attempt_cost.successful_reasoning_tokens,
        "successful_total_tokens": attempt_cost.successful_total_tokens,
        "successful_cached_prompt_tokens": (
            attempt_cost.successful_cached_prompt_tokens
        ),
        "successful_adjacent_common_prefix_tokens": (
            attempt_cost.successful_adjacent_common_prefix_tokens
        ),
        "cache_observation_count": metrics.cache_observation_count,
        "provider_cache_hit_count": metrics.provider_cache_hit_count,
        "provider_cache_hit_rate": _ratio(
            metrics.provider_cache_hit_count,
            metrics.cache_observation_count,
        ),
        "cached_prompt_token_rate": _ratio(
            attempt_cost.successful_cached_prompt_tokens,
            attempt_cost.successful_prompt_tokens,
        ),
        "graph_selected_production_path_count": (
            metrics.graph_selected_production_path_count
        ),
        "graph_selected_low_hop_path_count": metrics.graph_selected_low_hop_path_count,
        "graph_required_production_path_count": (
            metrics.graph_required_production_path_count
        ),
        "graph_missing_production_path_count": metrics.graph_missing_production_path_count,
        "graph_reviewer_available_path_count": (
            metrics.graph_reviewer_available_path_count
        ),
        "graph_reviewer_selected_path_count": (
            metrics.graph_reviewer_selected_path_count
        ),
        "graph_reviewer_dropped_path_count": metrics.graph_reviewer_dropped_path_count,
        "graph_reviewer_selected_token_count": (
            metrics.graph_reviewer_selected_token_count
        ),
        "graph_reviewer_role_coverage": metrics.graph_reviewer_role_coverage,
        "manifest_token_cost": metrics.manifest_token_cost,
        "tool_call_count": metrics.tool_call_count,
        "read_file_calls": metrics.read_file_calls,
        "grep_calls": metrics.grep_calls,
        "symbol_lookup_calls": metrics.symbol_lookup_calls,
        "duplicate_tool_call_count": metrics.duplicate_tool_call_count,
        "parsed_file_count": metrics.parsed_file_count,
        "graph_node_count": metrics.graph_node_count,
        "graph_edge_count": metrics.graph_edge_count,
        "cache_hit": metrics.graph_cache_hit,
        "persistent_cache_hit_rate": metrics.persistent_cache_hit_rate,
        "index_size_bytes": record.index_after.size_bytes
        if record.index_after
        else None,
        "review_iterations": metrics.review_iterations,
        "tool_search_success_rate": None,
        "search_after_manifest": None,
        "out_of_scope_read_rate": None,
        "repeated_search_rate": None,
        "candidate_revision_count": None,
        "stop_condition_efficiency": None,
    }


def _aggregate_cost_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate cost across every attempted run, including invalid runs."""

    def total(name: str) -> int:
        return sum(int(row.get(name, 0) or 0) for row in rows)

    unknown = total("unknown_usage_attempt_count")
    reviewer_unknown = total("reviewer_unknown_usage_attempt_count")
    verifier_unknown = total("verifier_unknown_usage_attempt_count")

    def complete_component(name: str, unknown_count: int) -> int | None:
        if unknown_count:
            return None
        return sum(int(row[name] or 0) for row in rows if row.get(name) is not None)

    provider_attempts = total("provider_attempt_count")
    if provider_attempts == 0:
        status = "no_provider_attempt"
    elif unknown:
        status = "partial_unknown_usage"
    else:
        status = "complete"
    return {
        "sample_domain": "all_attempts_including_invalid",
        "run_count": len(rows),
        "provider_attempt_count": provider_attempts,
        "reviewer_provider_attempt_count": total("reviewer_provider_attempt_count"),
        "verifier_provider_attempt_count": total("verifier_provider_attempt_count"),
        "successful_attempt_count": total("successful_attempt_count"),
        "failed_attempt_count": total("failed_attempt_count"),
        "known_usage_attempt_count": total("known_usage_attempt_count"),
        "unknown_usage_attempt_count": unknown,
        "reviewer_unknown_usage_attempt_count": reviewer_unknown,
        "verifier_unknown_usage_attempt_count": verifier_unknown,
        "usage_known": unknown == 0,
        "cost_status": status,
        "total_tokens": complete_component("total_tokens", unknown),
        "reviewer_total_tokens": complete_component(
            "reviewer_total_tokens", reviewer_unknown
        ),
        "verifier_total_tokens": complete_component(
            "verifier_total_tokens", verifier_unknown
        ),
        "successful_prompt_tokens": total("successful_prompt_tokens"),
        "successful_completion_tokens": total("successful_completion_tokens"),
        "successful_reasoning_tokens": total("successful_reasoning_tokens"),
        "successful_total_tokens": total("successful_total_tokens"),
        "successful_cached_prompt_tokens": total("successful_cached_prompt_tokens"),
        "successful_adjacent_common_prefix_tokens": total(
            "successful_adjacent_common_prefix_tokens"
        ),
    }


def _aggregate_quality_payload(aggregate: MetricSummary) -> dict[str, Any]:
    return {
        "overall_recall": aggregate.overall_recall,
        "precision": aggregate.precision,
        "root_cause_recall": aggregate.root_cause_recall,
        "over_merge_count": aggregate.over_merge_count,
        "under_merge_count": aggregate.under_merge_count,
        "repair_unit_accuracy": aggregate.repair_unit_accuracy,
    }


def compact_summary(payload: dict[str, Any]) -> dict[str, Any]:
    records = [PilotRunRecord.model_validate(item) for item in payload["records"]]
    configured_variant_ids = tuple(
        str(variant_id)
        for variant_id in payload.get("variant_sample_counts", {})
    )
    variant_ids = configured_variant_ids or tuple(
        dict.fromkeys(item.variant_id for item in records)
    )
    variants: dict[str, Any] = {}
    for variant_id in variant_ids:
        all_runs = [item for item in records if item.variant_id == variant_id]
        valid = [item for item in all_runs if item.valid]
        closeouts = {item.run_id: _record_closeout(item) for item in all_runs}
        quality_details = {
            item.run_id: _quality_eligibility(item, closeouts[item.run_id])
            for item in all_runs
        }
        # Quality denominators intentionally use runner-valid runs only.  A
        # structurally valid but incomplete v3 run remains visible in this
        # domain and may contribute approved partial findings; the gate result
        # is reported separately so it cannot be mistaken for complete delivery.
        quality_runs = valid
        complete_delivery_runs = [
            item for item in valid if quality_details[item.run_id][0]
        ]
        complete_delivery_aggregate = MetricSummary.from_results(
            [item.result for item in complete_delivery_runs]
        )
        delivery_complete_count = sum(
            closeouts[item.run_id].delivery_complete for item in all_runs
        )
        delivery_complete_rate = _ratio(delivery_complete_count, len(all_runs))
        delivery_summary = {
            "sample_domain": "all_attempts_including_invalid",
            "attempt_count": len(all_runs),
            "delivery_complete_count": delivery_complete_count,
            "delivery_complete_rate": delivery_complete_rate,
            "end_to_end_delivery_rate": delivery_complete_rate,
            "invalid_attempt_count": len(all_runs) - len(valid),
            "valid_attempt_count": len(valid),
            "complete_delivery_gate_count": len(complete_delivery_runs),
        }
        quality_rows = []
        cost_rows = []
        for item in quality_runs:
            result = item.result
            metrics = result.process_metrics
            closeout = closeouts[item.run_id]
            quality_rows.append(
                {
                    "run_id": item.run_id,
                    "fixture_id": item.fixture_id,
                    "completion_status": closeout.completion_status,
                    "finding_run_status": closeout.finding_run_status,
                    "finish_seen": closeout.finish_seen,
                    "submission_received": closeout.submission_received,
                    "review_complete": closeout.review_complete,
                    "delivery_complete": closeout.delivery_complete,
                    "report_ready": closeout.report_ready,
                    "external_publish_status": closeout.external_publish_status,
                    "quality_gate_eligible": quality_details[item.run_id][0],
                    "quality_gate_exclusion_reasons": quality_details[item.run_id][1],
                    "schema_valid": result.schema_valid,
                    "approved_finding_count": result.approved_finding_count,
                    "expected_count": result.expected_count,
                    "matched_count": result.matched_count,
                    "false_positive_count": result.false_positive_count,
                    "hit_rate": _ratio(result.matched_count, result.expected_count),
                    "precision": _ratio(
                        result.matched_count,
                        result.matched_count + result.false_positive_count,
                    ),
                    "cross_file_recall": (
                        _ratio(result.matched_count, result.expected_count)
                        if "cross-file" in item.fixture_types
                        else None
                    ),
                    "two_hop_recall": (
                        _ratio(result.matched_count, result.expected_count)
                        if "two-hop dependency" in item.fixture_types
                        else None
                    ),
                    "evidence_complete_count": metrics.evidence_complete_count,
                    "verifier_candidate_count": metrics.verifier_candidate_count,
                    "verifier_accepted_count": metrics.verifier_accepted_count,
                    "verifier_rejected_count": metrics.verifier_rejected_count,
                    "deterministic_evidence_pass_rate": metrics.evidence_validation_pass_rate,
                    "expected_root_cause_count": result.expected_root_cause_count,
                    "matched_root_cause_count": result.matched_root_cause_count,
                    "over_merge_count": result.over_merge_count,
                    "under_merge_count": result.under_merge_count,
                    "repair_unit_accuracy": _ratio(
                        result.repair_unit_matched_count,
                        result.repair_unit_expected_count,
                    ),
                    "final_root_cause_count": metrics.final_root_cause_count,
                    "structural_metrics": _structural_metrics_payload(
                        result.structural_metrics
                    ),
                }
            )
            cost_rows.append(
                {
                    "run_id": item.run_id,
                    **result.stage_timings,
                    "graph_build_latency_seconds": metrics.graph_build_latency_seconds,
                    "incremental_update_latency_seconds": (
                        metrics.incremental_update_latency_seconds
                    ),
                    "context_planning_latency_seconds": None,
                    "reviewer_latency_seconds": metrics.reviewer_latency_seconds,
                    "verifier_latency_seconds": metrics.verifier_latency_seconds,
                    "consolidation_latency_seconds": metrics.consolidation_latency_seconds,
                    "end_to_end_latency_seconds": metrics.end_to_end_latency_seconds,
                    "prompt_tokens": metrics.prompt_tokens,
                    "completion_tokens": metrics.completion_tokens,
                    "total_tokens": metrics.total_tokens,
                    "provider_attempt_count": metrics.provider_attempt_count,
                    "successful_prompt_tokens": metrics.successful_prompt_tokens,
                    "successful_completion_tokens": (
                        metrics.successful_completion_tokens
                    ),
                    "successful_reasoning_tokens": metrics.successful_reasoning_tokens,
                    "successful_total_tokens": metrics.successful_total_tokens,
                    "successful_cached_prompt_tokens": (
                        metrics.successful_cached_prompt_tokens
                    ),
                    "successful_adjacent_common_prefix_tokens": (
                        metrics.successful_adjacent_common_prefix_tokens
                    ),
                    "cache_observation_count": metrics.cache_observation_count,
                    "provider_cache_hit_count": metrics.provider_cache_hit_count,
                    "provider_cache_hit_rate": _ratio(
                        metrics.provider_cache_hit_count,
                        metrics.cache_observation_count,
                    ),
                    "cached_prompt_token_rate": _ratio(
                        metrics.successful_cached_prompt_tokens,
                        metrics.successful_prompt_tokens,
                    ),
                    "graph_selected_production_path_count": (
                        metrics.graph_selected_production_path_count
                    ),
                    "graph_selected_low_hop_path_count": (
                        metrics.graph_selected_low_hop_path_count
                    ),
                    "graph_required_production_path_count": (
                        metrics.graph_required_production_path_count
                    ),
                    "graph_missing_production_path_count": (
                        metrics.graph_missing_production_path_count
                    ),
                    "graph_reviewer_available_path_count": (
                        metrics.graph_reviewer_available_path_count
                    ),
                    "graph_reviewer_selected_path_count": (
                        metrics.graph_reviewer_selected_path_count
                    ),
                    "graph_reviewer_dropped_path_count": (
                        metrics.graph_reviewer_dropped_path_count
                    ),
                    "graph_reviewer_selected_token_count": (
                        metrics.graph_reviewer_selected_token_count
                    ),
                    "graph_reviewer_role_coverage": (
                        metrics.graph_reviewer_role_coverage
                    ),
                    "manifest_token_cost": metrics.manifest_token_cost,
                    "tool_call_count": metrics.tool_call_count,
                    "read_file_calls": metrics.read_file_calls,
                    "grep_calls": metrics.grep_calls,
                    "symbol_lookup_calls": metrics.symbol_lookup_calls,
                    "duplicate_tool_call_count": metrics.duplicate_tool_call_count,
                    "parsed_file_count": metrics.parsed_file_count,
                    "graph_node_count": metrics.graph_node_count,
                    "graph_edge_count": metrics.graph_edge_count,
                    "cache_hit": metrics.graph_cache_hit,
                    "persistent_cache_hit_rate": metrics.persistent_cache_hit_rate,
                    "index_size_bytes": item.index_after.size_bytes
                    if item.index_after
                    else None,
                    "review_iterations": metrics.review_iterations,
                    "tool_search_success_rate": None,
                    "search_after_manifest": None,
                    "out_of_scope_read_rate": None,
                    "repeated_search_rate": None,
                    "candidate_revision_count": None,
                    "stop_condition_efficiency": None,
                }
            )
        cost_rows = [
            _cost_row(
                item,
                closeout=closeouts[item.run_id],
                quality_eligible=quality_details[item.run_id][0],
                quality_exclusion_reasons=quality_details[item.run_id][1],
            )
            for item in all_runs
        ]
        aggregate = MetricSummary.from_results([item.result for item in quality_runs])
        aggregate_cost = _aggregate_cost_rows(cost_rows)
        variants[variant_id] = {
            "valid_runs": len(valid),
            "invalid_runs": len(all_runs) - len(valid),
            "valid_run_rate": _ratio(len(valid), len(all_runs)),
            "quality_sample_domain": (
                "runner_valid_runs_only"
            ),
            "quality_sample_includes_incomplete": True,
            "quality_runs": len(quality_runs),
            "quality_gate_eligible_runs": sum(
                quality_details[item.run_id][0] for item in valid
            ),
            "quality_gate_excluded_runs": [
                {
                    "run_id": item.run_id,
                    "reasons": quality_details[item.run_id][1],
                    "completion_status": closeouts[item.run_id].completion_status,
                    "submission_received": closeouts[item.run_id].submission_received,
                    "finish_seen": closeouts[item.run_id].finish_seen,
                }
                for item in all_runs
                if not quality_details[item.run_id][0]
            ],
            "complete_delivery_gate_excluded": [
                {
                    "run_id": item.run_id,
                    "reasons": quality_details[item.run_id][1],
                    "completion_status": closeouts[item.run_id].completion_status,
                    "submission_received": closeouts[item.run_id].submission_received,
                    "finish_seen": closeouts[item.run_id].finish_seen,
                }
                for item in valid
                if not quality_details[item.run_id][0]
            ],
            "quality_excluded_runs": [
                {
                    "run_id": item.run_id,
                    "reasons": quality_details[item.run_id][1],
                    "completion_status": closeouts[item.run_id].completion_status,
                    "submission_received": closeouts[item.run_id].submission_received,
                    "finish_seen": closeouts[item.run_id].finish_seen,
                }
                for item in all_runs
                if not item.valid
            ],
            "complete_delivery": {
                "sample_domain": (
                    "runner_valid_runs_with_complete_delivery_gates_only"
                ),
                "runs": len(complete_delivery_runs),
                "run_ids": [item.run_id for item in complete_delivery_runs],
                "aggregate_quality": _aggregate_quality_payload(
                    complete_delivery_aggregate
                ),
                "quality": [
                    row for row in quality_rows if row["quality_gate_eligible"]
                ],
            },
            "aggregate_quality": _aggregate_quality_payload(aggregate),
            "aggregate_process": {
                "provider_attempt_count": aggregate.provider_attempt_count,
                "successful_prompt_tokens": aggregate.successful_prompt_tokens,
                "successful_completion_tokens": aggregate.successful_completion_tokens,
                "successful_reasoning_tokens": aggregate.successful_reasoning_tokens,
                "successful_total_tokens": aggregate.successful_total_tokens,
                "successful_cached_prompt_tokens": (
                    aggregate.successful_cached_prompt_tokens
                ),
                "successful_adjacent_common_prefix_tokens": (
                    aggregate.successful_adjacent_common_prefix_tokens
                ),
                "cache_observation_count": aggregate.cache_observation_count,
                "provider_cache_hit_count": aggregate.provider_cache_hit_count,
                "provider_cache_hit_rate": _ratio(
                    aggregate.provider_cache_hit_count,
                    aggregate.cache_observation_count,
                ),
                "cached_prompt_token_rate": _ratio(
                    aggregate.successful_cached_prompt_tokens,
                    aggregate.successful_prompt_tokens,
                ),
                "graph_selected_production_path_count": (
                    aggregate.graph_selected_production_path_count
                ),
                "graph_selected_low_hop_path_count": (
                    aggregate.graph_selected_low_hop_path_count
                ),
                "graph_required_production_path_count": (
                    aggregate.graph_required_production_path_count
                ),
                "graph_missing_production_path_count": (
                    aggregate.graph_missing_production_path_count
                ),
                "graph_reviewer_available_path_count": (
                    aggregate.graph_reviewer_available_path_count
                ),
                "graph_reviewer_selected_path_count": (
                    aggregate.graph_reviewer_selected_path_count
                ),
                "graph_reviewer_dropped_path_count": (
                    aggregate.graph_reviewer_dropped_path_count
                ),
                "graph_reviewer_selected_token_count": (
                    aggregate.graph_reviewer_selected_token_count
                ),
                "graph_reviewer_role_coverage": (
                    aggregate.graph_reviewer_role_coverage
                ),
            },
            "aggregate_cost": aggregate_cost,
            "cost_sample_domain": "all_attempts_including_invalid",
            "delivery": delivery_summary,
            "delivery_sample_domain": "all_attempts_including_invalid",
            "delivery_complete_runs": delivery_complete_count,
            "delivery_complete_rate": delivery_complete_rate,
            "end_to_end_delivery_rate": delivery_complete_rate,
            "structural_metrics": _structural_metrics_payload(
                _aggregate_run_structural_metrics(
                    [item.result for item in quality_runs]
                )
            ),
            "quality": quality_rows,
            "cost": cost_rows,
            "stability": {
                "hit_rate": _stats([row["hit_rate"] for row in quality_rows]),
                "end_to_end_latency_seconds": _stats(
                    [row["end_to_end_latency_seconds"] for row in cost_rows]
                ),
                "total_tokens": _stats([row["total_tokens"] for row in cost_rows]),
                "usage_known_rate": _ratio(
                    sum(bool(row["usage_known"]) for row in cost_rows),
                    len(cost_rows),
                ),
                "pass_at_k": max(
                    (
                        row["hit_rate"]
                        for row in quality_rows
                        if row["hit_rate"] is not None
                    ),
                    default=None,
                ),
                "finding_fingerprint_distribution": "not_available",
            },
        }
    runner_ready = _runner_ready_for_suite(
        suite=str(payload["suite"]),
        pairing_errors=list(payload["pairing_errors"]),
        records=records,
        variants=variants,
    )
    quality_ready = runner_ready and all(
        variants[item]["invalid_runs"] == 0
        and variants[item]["valid_runs"] > 0
        and variants[item]["quality_gate_eligible_runs"]
        == variants[item]["valid_runs"]
        for item in variants
    )
    overall_closeouts = [_record_closeout(item) for item in records]
    overall_delivery_complete_count = sum(
        closeout.delivery_complete for closeout in overall_closeouts
    )
    overall_delivery_rate = _ratio(
        overall_delivery_complete_count, len(records)
    )
    overall_delivery = {
        "sample_domain": "all_attempts_including_invalid",
        "attempt_count": len(records),
        "delivery_complete_count": overall_delivery_complete_count,
        "delivery_complete_rate": overall_delivery_rate,
        "end_to_end_delivery_rate": overall_delivery_rate,
        "invalid_attempt_count": sum(not item.valid for item in records),
        "valid_attempt_count": sum(item.valid for item in records),
    }
    return (
        {
            key: payload[key]
            for key in (
                "experiment_id",
                "generated_at",
                "branch",
                "start_commit",
                "implementation_commit",
                "frozen_baseline_tag",
                "frozen_baseline_target",
                "formal_graph_ab",
                "held_out_executed",
                "seed",
                "samples",
                "suite",
                "shared_contract",
                "pairing_errors",
            )
        }
        | {
            "experiment_contract_hash": payload.get("experiment_contract_hash"),
            "checkpoint": payload.get("checkpoint"),
            "round_contract": payload.get("round_contract"),
        }
        | {
            "fixtures": [
                {
                    "id": fixture_id,
                    "types": next(
                        item.fixture_types
                        for item in records
                        if item.fixture_id == fixture_id
                    ),
                    "snapshot": next(
                        item.repository_snapshot
                        for item in records
                        if item.fixture_id == fixture_id
                    ),
                    "run_order": [
                        item.variant_id
                        for item in records
                        if item.fixture_id == fixture_id and item.sample == 1
                    ],
                }
                for fixture_id in dict.fromkeys(item.fixture_id for item in records)
            ],
            "variants": variants,
            "invalid_runs": [
                {
                    "run_id": item.run_id,
                    "variant_id": item.variant_id,
                    "reasons": item.invalid_reasons,
                }
                for item in records
                if not item.valid
            ],
            "runner_readiness": runner_ready,
            "runner_readiness_scope": "runtime_variant_contract_only",
            "quality_readiness": quality_ready,
            "delivery": overall_delivery,
            "delivery_sample_domain": "all_attempts_including_invalid",
            "delivery_complete_runs": overall_delivery_complete_count,
            "delivery_complete_rate": overall_delivery_rate,
            "end_to_end_delivery_rate": overall_delivery_rate,
            "ready_for_formal_paired_ab": False,
            "readiness_note": "Runner evidence only; final readiness additionally requires automated test results and frozen-file audit.",
        }
    )


def _runner_ready_for_suite(
    *,
    suite: str,
    pairing_errors: list[object],
    records: list[PilotRunRecord],
    variants: dict[str, Any],
) -> bool:
    """Apply the smoke sentinel only to runs that actually select it."""
    smoke = [
        item
        for item in records
        if item.fixture_id == "development_agent_search_cross_file"
    ]
    smoke_required = suite in {"smoke", "all"}
    expected_variant_ids = set(variants)
    smoke_ready = not smoke_required or (
        len(smoke) == len(expected_variant_ids)
        and {item.variant_id for item in smoke} == expected_variant_ids
        and all(item.valid for item in smoke)
    )
    return (
        not pairing_errors
        and smoke_ready
        and all(variants[item]["valid_runs"] > 0 for item in expected_variant_ids)
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument(
        "--suite",
        choices=("smoke", "validation", "preflight", "preview", "all"),
        default="all",
    )
    parser.add_argument("--samples", type=int, default=1)
    parser.add_argument("--seed", type=int, default=20260804)
    parser.add_argument("--output-json", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--summary-json", type=Path, default=DEFAULT_SUMMARY)
    parser.add_argument(
        "--resume",
        type=Path,
        default=DEFAULT_CHECKPOINT,
        help="Durable checkpoint JSONL to resume and append.",
    )
    parser.add_argument(
        "--no-resume",
        action="store_true",
        help="Atomically start a fresh checkpoint instead of reusing records.",
    )
    parser.add_argument(
        "--retry-invalid",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Retry invalid/workspace-failure attempts (default: true).",
    )
    parser.add_argument(
        "--stop-after-measured",
        type=int,
        default=None,
        help="Controlled interruption hook after N durable measured attempts.",
    )
    parser.add_argument(
        "--defer-workspace-cleanup",
        action="store_true",
        help=(
            "Development-only: keep each isolated workspace on disk under "
            "outputs/<experiment>/deferred_workspaces instead of synchronously "
            "rmtree'ing it after the run, so checkpoint append is not blocked by "
            "slow Windows deletion of the full worktree.  Does not alter the A/B "
            "treatment; workspaces are still materialized fresh per attempt."
        ),
    )
    parser.add_argument(
        "--summarize-only",
        type=Path,
        default=None,
        help="Rebuild compact summary from an existing raw Pilot JSON without new runs.",
    )
    args = parser.parse_args()
    if args.summarize_only is not None:
        payload = json.loads(args.summarize_only.read_text(encoding="utf-8"))
    else:
        payload = asyncio.run(
            run_pilot(
                config_path=args.config.resolve(),
                suite=args.suite,
                samples=max(1, args.samples),
                seed=args.seed,
                checkpoint_path=args.resume.resolve(),
                resume=not args.no_resume,
                retry_invalid=args.retry_invalid,
                stop_after_measured=args.stop_after_measured,
                defer_workspace_cleanup=args.defer_workspace_cleanup,
            )
        )
    summary = compact_summary(payload)
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    if args.summarize_only is None:
        args.output_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    args.summary_json.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"Raw pilot: {args.output_json}")
    print(f"Compact summary: {args.summary_json}")
    print(f"Runner readiness: {'PASS' if summary['runner_readiness'] else 'FAIL'}")


if __name__ == "__main__":
    main()
