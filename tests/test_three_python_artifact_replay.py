"""Replay archived reviewer actions without inventing verifier responses."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from src.analyzer.context_state import ContextState
from src.analyzer.inference_engine import InferenceEngine
from src.analyzer.schemas import ReviewRequest
from src.models.schemas import ModelConfig
from src.orchestrator.agent_loop import AgentOrchestrator

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "eval/outputs/finding-delivery-python-three-v3-20260910"
RAW = OUTPUT / "raw.json"
pytestmark = pytest.mark.skipif(
    not RAW.is_file(), reason="Local archived AB artifacts required"
)


class NoProvider:
    """Make any accidental model request fail the offline test."""

    default_config = ModelConfig(model="offline-artifact-replay")

    async def chat(self, *args: Any, **kwargs: Any) -> None:
        raise AssertionError("Artifact replay must not call a provider")


def load_case(index: int) -> tuple[dict[str, Any], list[dict[str, Any]], Path]:
    record = json.loads(RAW.read_text(encoding="utf-8"))["records"][index]
    journal = (
        OUTPUT / "run_journals" / Path(record["lifecycle"]["run_journal_path"]).name
    )
    entries = [
        json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines()
    ]
    return record, entries, journal


@pytest.mark.parametrize("index", range(6))
@pytest.mark.parametrize(
    "defer_saved_actions",
    [False, True],
    ids=["original-sequence", "controlled-final-save"],
)
def test_real_reviewer_actions_reach_registry_without_content_loss(
    index: int, defer_saved_actions: bool
) -> None:
    """Moving archived saves is a controlled experiment, not a natural rerun."""
    record, entries, journal = load_case(index)
    before = hashlib.sha256(journal.read_bytes()).hexdigest()
    context = ContextState.model_validate(record["result"]["raw_output"]["context"])
    orchestrator = AgentOrchestrator()
    engine = InferenceEngine(model_client=NoProvider())  # type: ignore[arg-type]
    request = ReviewRequest(repo_path=str(ROOT))
    pending: list[dict[str, Any]] = []
    saved_descriptions: list[str] = []
    final_report = None
    for entry in entries:
        if entry["type"] != "model_response":
            continue
        calls = entry["payload"]["tool_calls"]
        if any(call["function"]["name"] == "repair_review" for call in calls):
            continue
        is_final = any(call["function"]["name"] == "finish_review" for call in calls)
        for call in calls:
            if call["function"]["name"] == "save_finding":
                payload = json.loads(call["function"]["arguments"])
                saved_descriptions.append(payload["finding"]["description"])
        if defer_saved_actions:
            pending.extend(
                call for call in calls if call["function"]["name"] == "save_finding"
            )
            calls = [
                call for call in calls if call["function"]["name"] != "save_finding"
            ]
            if is_final:
                calls = pending + calls
                pending = []
        plan, metadata = engine._parse_tool_calls(  # noqa: SLF001
            calls,
            request,
            force_submit=is_final,
            contract_version="3.0",
        )
        assert not metadata.get("v3_action_validation_errors")
        results = orchestrator._execute_v3_finding_actions(plan, context)  # noqa: SLF001
        assert all(result.ok for _, result in results)
        if is_final:
            final_report = plan.draft_review
    assert final_report is not None
    assert [issue.description for issue in final_report.issues] == saved_descriptions
    assert len(final_report.issues) == (0 if index == 1 else 1)
    assert hashlib.sha256(journal.read_bytes()).hexdigest() == before


def test_archived_haystack_repair_handle_is_not_a_transaction_target() -> None:
    """Do not turn the archived rejected patch into an offline success."""
    _, entries, _ = load_case(3)
    transactions = [
        entry["payload"]["transaction"]
        for entry in entries
        if entry["type"] == "repair_transaction"
    ]
    call = next(
        call
        for entry in entries
        if entry["type"] == "model_response"
        for call in entry["payload"]["tool_calls"]
        if call["function"]["name"] == "repair_review"
    )
    engine = InferenceEngine(model_client=NoProvider())  # type: ignore[arg-type]
    plan, _ = engine._parse_tool_calls(  # noqa: SLF001
        [call],
        ReviewRequest(repo_path=str(ROOT)),
        force_submit=True,
        repair_mode=True,
        contract_version="3.0",
    )
    assert plan.repair_response is not None
    assert all(
        item.target_handle not in transactions[0]["target_handles"]
        for item in plan.repair_response.repairs
    )
    # This is a historical audit inconsistency, not evidence of an applied patch.
    assert transactions[-1]["rejected_response_fingerprints"]
    assert not transactions[-1]["applied_response_fingerprints"]
    assert transactions[-1]["status"] == "accepted"


def test_archived_verifier_receipts_are_not_raw_model_responses() -> None:
    """Receipts cannot be repurposed as new independent verdicts."""
    for index in range(6):
        _, entries, _ = load_case(index)
        calls = [
            call
            for entry in entries
            if entry["type"] == "model_response"
            for call in entry["payload"]["tool_calls"]
        ]
        assert not any(call["function"]["name"] == "verify_findings" for call in calls)
