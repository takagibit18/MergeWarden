"""No-model replay coverage for the finding delivery transaction boundary."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from src.analyzer.finding_contract import ModelRepairResponse
from src.analyzer.finding_delivery import (
    CandidateRegistry,
    RepairTransaction,
    evidence_context_digest,
)
from src.analyzer.finding_integrity import build_candidates
from src.analyzer.finding_schema import ClaimSupport
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.orchestrator.agent_loop import AgentOrchestrator
from src.orchestrator.tool_schemas import build_repair_tool_schemas
from src.analyzer.inference_engine import InferenceEngine
from src.analyzer.schemas import ReviewRequest


_POSTFINAL_JOURNALS = (
    Path(
        "eval/outputs/finding-delivery-repair-v4-postfinal-zhipu-20260909/"
        "run_journals/development_agent_search_cross_file_A-agent-search_"
        "4cb51c11-3aef-4766-bbbe-5bbdffd0facd_journal.jsonl"
    ),
    Path(
        "eval/outputs/finding-delivery-repair-v4-postfinal-zhipu-20260909/"
        "run_journals/golden_deepset-ai_haystack_pr12208_reverse_A-agent-search_"
        "0feb6a45-9b8d-4e42-a73f-dd7c3552af2e_journal.jsonl"
    ),
    Path(
        "eval/outputs/finding-delivery-python-ab-20260909-zhipu/"
        "run_journals/golden_deepset-ai_haystack_pr12208_reverse_A-agent-search_"
        "4c0e41b2-b2ea-4980-9059-c7215e385dba_journal.jsonl"
    ),
)


def _issue(
    *,
    location: str = "pkg/service.py:2",
    suggestion: str = "Preserve the caller-visible contract.",
    finding_id: str = "",
) -> ReviewIssue:
    return ReviewIssue(
        severity=Severity.WARNING,
        location=location,
        evidence="+ changed_value = new_value",
        suggestion=suggestion,
        confidence=0.95,
        finding_id=finding_id,
    )


def _case(count: int = 1):
    issues = [
        _issue(
            location=f"pkg/service{index}.py:2",
            suggestion=f"Original suggestion {index}",
        )
        for index in range(count)
    ]
    report = ReviewReport(issues=issues)
    registry = CandidateRegistry()
    candidates = build_candidates(report, iteration=0, registry=registry)
    handles = {
        f"target-{index}": candidate.candidate_id
        for index, candidate in enumerate(candidates)
    }
    transaction = RepairTransaction(
        candidate_ids=[candidate.candidate_id for candidate in candidates],
        target_handles=handles,
        base_versions={
            candidate.candidate_id: registry.expected_version(candidate.candidate_id)
            for candidate in candidates
        },
        required_steps=["submit"],
        base_snapshot_id="snapshot-a",
        base_revision="revision-a",
        base_evidence_context_digest=evidence_context_digest(
            [], snapshot_id="snapshot-a", revision="revision-a"
        ),
    )
    preview = SimpleNamespace(
        bound_candidates=candidates,
        results=[SimpleNamespace(status="needs_repair") for _ in candidates],
    )
    return report, registry, candidates, transaction, preview


def _repair(items: list[dict[str, object]]) -> ModelRepairResponse:
    return ModelRepairResponse.model_validate({"repairs": items})


def _merge(case, response, *, catalog=None, snapshot="snapshot-a", revision="revision-a"):
    report, registry, _candidates, transaction, preview = case
    diagnostics: list[dict[str, object]] = []
    merged = AgentOrchestrator._merge_repair_response(
        report,
        response,
        preview,
        transaction=transaction,
        registry=registry,
        evidence_catalog=catalog or [],
        snapshot_id=snapshot,
        revision=revision,
        diagnostics=diagnostics,
    )
    return merged, diagnostics


def test_real_journal_replay_preserves_candidate_and_finalization_facts() -> None:
    observed = []
    for path in _POSTFINAL_JOURNALS:
        entries = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        types = [entry["type"] for entry in entries]
        registration = next(
            entry["payload"] for entry in entries if entry["type"] == "candidate_registration"
        )
        final = next(
            entry["payload"] for entry in entries if entry["type"] == "finding_finalization"
        )
        assert registration["registrations"]
        assert final["finding_run_status"] in {"complete", "incomplete"}
        assert "candidate_registration" in types
        assert "finding_finalization" in types
        observed.append(final["final_published_count"])
    assert observed == [0, 1, 0]


def test_runtime_registers_identity_without_model_finding_id() -> None:
    report = ReviewReport(issues=[_issue(finding_id="model-label")])
    registry = CandidateRegistry()
    candidates = build_candidates(report, iteration=0, registry=registry)
    assert candidates[0].candidate_id.startswith("cand_")
    assert candidates[0].issue.finding_id.startswith("F-")
    assert candidates[0].issue.finding_id != "model-label"


def test_trigger_patch_preserves_causal_mechanism_and_other_semantics() -> None:
    case = _case()
    original = case[0].issues[0]
    original.causal_mechanism = "The producer drops the compatibility fallback."
    original.observed_behavior = "The caller receives a changed value."
    case[0].issues[0] = original
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"trigger": "A legacy caller reaches the branch."},
                }
            ]
        ),
    )
    assert diagnostics == []
    assert merged.issues[0].trigger
    assert merged.issues[0].causal_mechanism == original.causal_mechanism
    assert merged.issues[0].observed_behavior == original.observed_behavior


def test_patch_omission_preserves_original_suggestion() -> None:
    case = _case()
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"trigger": "Only this field changed."},
                }
            ]
        ),
    )
    assert diagnostics == []
    assert merged.issues[0].suggestion == "Original suggestion 0"


def test_null_patch_value_is_rejected_without_mutation() -> None:
    case = _case()
    handle = next(iter(case[3].target_handles))
    response = _repair(
        [
            {
                "target_handle": handle,
                "repair_status": "repaired",
                "repair_patch": {"trigger": None},
            }
        ]
    )
    merged, diagnostics = _merge(case, response)
    assert merged.issues[0].trigger == ""
    assert diagnostics[0]["code"] == "repair_patch_null_ambiguous"


def test_empty_string_is_an_explicit_replacement() -> None:
    case = _case()
    case[0].issues[0].trigger = "Existing trigger"
    candidate_id = case[2][0].candidate_id
    case[1].commit_verified_version(candidate_id, case[0].issues[0])
    case[3].base_versions[candidate_id] = case[1].expected_version(candidate_id)
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"trigger": ""},
                }
            ]
        ),
    )
    assert diagnostics == []
    assert merged.issues[0].trigger == ""


def test_empty_support_collection_clears_compatibility_evidence() -> None:
    case = _case()
    case[0].issues[0].supports = [
        ClaimSupport(role="cause", statement="cause", evidence_refs=["ev-cause"])
    ]
    candidate_id = case[2][0].candidate_id
    case[1].commit_verified_version(candidate_id, case[0].issues[0])
    case[3].base_versions[candidate_id] = case[1].expected_version(candidate_id)
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"supports": []},
                }
            ]
        ),
    )
    assert diagnostics == []
    assert merged.issues[0].supports == []
    assert merged.issues[0].cause_evidence == []


def test_explicit_delete_is_distinct_from_empty_value() -> None:
    case = _case()
    case[0].issues[0].trigger = "Keep only until explicitly deleted"
    candidate_id = case[2][0].candidate_id
    case[1].commit_verified_version(candidate_id, case[0].issues[0])
    case[3].base_versions[candidate_id] = case[1].expected_version(candidate_id)
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"delete_fields": ["trigger"]},
                }
            ]
        ),
    )
    assert diagnostics == []
    assert merged.issues[0].trigger == ""


def test_full_top_level_repair_payload_is_rejected_by_parser() -> None:
    engine = InferenceEngine.__new__(InferenceEngine)
    plan, meta = engine._parse_tool_calls(
        [
            {
                "id": "repair-1",
                "function": {
                    "name": "repair_review",
                    "arguments": json.dumps(
                        {
                            "repairs": [
                                {
                                    "target_handle": "target-0",
                                    "repair_status": "repaired",
                                    "suggestion": "full finding leakage",
                                }
                            ]
                        }
                    ),
                },
            }
        ],
        ReviewRequest(repo_path="."),
        force_submit=True,
        repair_mode=True,
    )
    assert plan.repair_response is None
    assert meta["repair_review_validation_error"]


def test_suggestion_only_repair_payload_is_rejected() -> None:
    engine = InferenceEngine.__new__(InferenceEngine)
    plan, meta = engine._parse_tool_calls(
        [
            {
                "function": {
                    "name": "repair_review",
                    "arguments": json.dumps({"suggestion": "not a repair envelope"}),
                }
            }
        ],
        ReviewRequest(repo_path="."),
        force_submit=True,
        repair_mode=True,
    )
    assert plan.repair_response is None
    assert "repairs" in meta["repair_review_validation_error"]


def test_model_cannot_submit_full_review_during_repair_mode() -> None:
    engine = InferenceEngine.__new__(InferenceEngine)
    plan, meta = engine._parse_tool_calls(
        [
            {
                "function": {
                    "name": "submit_review",
                    "arguments": json.dumps({"summary": "x", "issues": []}),
                }
            }
        ],
        ReviewRequest(repo_path="."),
        force_submit=True,
        repair_mode=True,
    )
    assert plan.draft_review is None
    assert "dedicated repair_review" in meta["repair_review_validation_error"]


def test_stale_version_rejects_patch() -> None:
    case = _case()
    handle, candidate_id = next(iter(case[3].target_handles.items()))
    case[1].commit_verified_version(candidate_id, _issue(suggestion="new runtime version"))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"trigger": "stale"},
                }
            ]
        ),
    )
    assert merged.issues[0].suggestion == "Original suggestion 0"
    assert diagnostics[0]["code"] == "repair_target_expired"


def test_changed_evidence_context_rejects_entire_transaction() -> None:
    case = _case()
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "repaired",
                    "repair_patch": {"trigger": "new context"},
                }
            ]
        ),
        catalog=[
            {
                "evidence_id": "ev-new",
                "artifact_id": "ev-new",
                "path": "pkg/service.py",
                "start_line": 2,
                "end_line": 2,
                "content_hash": "different",
            }
        ],
    )
    assert merged.issues[0].trigger == ""
    assert diagnostics[0]["code"] == "repair_transaction_context_stale"


def test_duplicate_handles_cannot_cross_talk_between_candidates() -> None:
    case = _case(2)
    first_handle, first_id = next(iter(case[3].target_handles.items()))
    response = _repair(
        [
            {
                "target_handle": first_handle,
                "repair_status": "repaired",
                "repair_patch": {"suggestion": "first replacement"},
            },
            {
                "target_handle": first_handle,
                "repair_status": "repaired",
                "repair_patch": {"suggestion": "cross-talk"},
            },
        ]
    )
    merged, diagnostics = _merge(case, response)
    assert merged.issues[0].suggestion == "first replacement"
    assert merged.issues[1].suggestion == "Original suggestion 1"
    assert any(item["code"] == "repair_target_duplicate" for item in diagnostics)
    assert case[3].target_handles[first_handle] == first_id


def test_duplicate_response_is_idempotently_ignored() -> None:
    case = _case()
    handle, candidate_id = next(iter(case[3].target_handles.items()))
    response = _repair(
        [
            {
                "target_handle": handle,
                "repair_status": "repaired",
                "repair_patch": {"suggestion": "applied once"},
            }
        ]
    )
    merged, first_diagnostics = _merge(case, response)
    assert first_diagnostics == []
    case[1].commit_verified_version(candidate_id, merged.issues[0])
    _replayed, diagnostics = _merge(case, response)
    assert diagnostics[0]["code"] == "repair_response_replay"


def test_incomplete_disposition_retains_original_candidate() -> None:
    case = _case()
    handle = next(iter(case[3].target_handles))
    merged, diagnostics = _merge(
        case,
        _repair(
            [
                {
                    "target_handle": handle,
                    "repair_status": "incomplete",
                    "repair_reason": "No delivered source proves the trigger.",
                }
            ]
        ),
    )
    assert merged.issues[0].suggestion == "Original suggestion 0"
    assert diagnostics[0]["code"] == "repair_target_incomplete"
    assert case[3].target_results[case[3].target_handles[handle]] == "incomplete"


def test_verified_registry_content_cannot_be_overwritten_by_stale_report() -> None:
    registry = CandidateRegistry()
    first = ReviewReport(issues=[_issue(suggestion="trusted")])
    candidate = build_candidates(first, iteration=0, registry=registry)[0]
    registry.commit_verified_version(candidate.candidate_id, candidate.issue)
    stale = ReviewReport(issues=[_issue(suggestion="stale")])
    build_candidates(stale, iteration=1, registry=registry)
    assert stale.issues[0].suggestion == "trusted"
    assert registry.authoritative_issue(candidate.candidate_id).suggestion == "trusted"


def test_dedicated_repair_schema_has_no_finding_submission_fields() -> None:
    schema = build_repair_tool_schemas()[0]["function"]
    assert schema["name"] == "repair_review"
    params = schema["parameters"]
    assert params["required"] == ["repairs"]
    assert "summary" not in params["properties"]
    assert "issues" not in params["properties"]
    item = params["properties"]["repairs"]["items"]
    assert "target_handle" in item["properties"]
    assert "target_candidate_id" not in item["properties"]
    assert "candidate_content_version" not in item["properties"]


def test_validation_result_carries_content_and_context_binding() -> None:
    case = _case()
    candidate = case[2][0]
    assert candidate.candidate_content_version == case[3].base_versions[candidate.candidate_id]
    assert case[3].base_evidence_context_digest == evidence_context_digest(
        [], snapshot_id="snapshot-a", revision="revision-a"
    )
