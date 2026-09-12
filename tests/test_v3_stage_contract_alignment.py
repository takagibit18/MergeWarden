"""Cross-stage v3 contracts, using offline clients and real message builders."""

from __future__ import annotations

import asyncio
import json

import pytest

from src.analyzer.context_state import ContextState
from src.analyzer.finding_schema import FindingPatchV3
from src.analyzer.inference_engine import InferenceEngine
from src.analyzer.prompts import build_review_messages, build_review_messages_async
from src.analyzer.schemas import ReviewRequest
from src.analyzer.semantic_verifier import (
    InvestigationResult,
    SemanticVerifier,
    SemanticVerifierBudget,
)
from src.orchestrator.agent_loop import AgentOrchestrator
from src.orchestrator.tool_schemas import (
    build_repair_tool_schemas,
    build_v3_finding_action_tool_schemas,
)
from src.tools.base import ToolSpec
from tests.test_harness_slimming_v3 import _candidate, _VerifierClient
from tests.test_inference_engine import RecordingFakeModelClient


@pytest.mark.parametrize("version", ["2.0", "3.0"])
def test_repair_prefix_is_consistent_across_sync_and_async_builders(
    version: str,
) -> None:
    arguments = dict(
        request=ReviewRequest(repo_path="."),
        context=ContextState(),
        diff="",
        file_contents={},
        contract_version=version,
    )
    ordinary = build_review_messages(**arguments)
    sync = build_review_messages(**arguments, repair_mode=True)
    asynchronous = asyncio.run(
        build_review_messages_async(**arguments, repair_mode=True)
    )
    assert [m.content for m in sync] == [m.content for m in asynchronous]
    assert sync[0].content == ordinary[0].content
    if version == "3.0":
        assert "Submit minimal patches through repair_review" in sync[1].content
        assert "Save each supported finding" not in sync[1].content
        assert "finish_review" not in sync[1].content
    else:
        assert sync[1].content == ordinary[1].content


def test_last_stage_overrides_defer_instruction_on_actual_model_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    client = RecordingFakeModelClient()
    asyncio.run(
        InferenceEngine(model_client=client).analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            contract_version="3.0",
            near_last_iteration=True,
            defer_submit=True,
        )
    )
    text = "\n".join(m.content for m in client.calls[-1])
    assert "FINAL CALL" not in text
    assert "Do not call finish_review yet" in text
    assert {t["function"]["name"] for t in client.tools[-1]} == {
        "save_finding",
        "revise_finding",
        "finish_review",
    }


@pytest.mark.parametrize("size", [1, 2, 3])
def test_v3_old_preflight_is_hidden_even_with_small_registries(size: int) -> None:
    orchestrator = AgentOrchestrator()
    orchestrator._settings.finding_contract_version = "3.0"  # noqa: SLF001
    specs = [
        ToolSpec(name=name, description="offline")
        for name in [
            "validate_review_draft",
            "record_draft_finding",
            "update_draft_finding",
        ][:size]
    ]
    assert not orchestrator._review_tool_specs_for_stage(  # noqa: SLF001
        specs, request=ReviewRequest(repo_path="."), defer_submit=False
    )


@pytest.mark.parametrize("mode", ["no_adapter", "no_budget", "no_recheck_budget"])
def test_explicit_investigation_cannot_silently_become_an_ordinary_repair(
    mode: str,
) -> None:
    decision = {
        "opaque_handle": "h-1",
        "verdict": "needs_revision",
        "reason": "Missing source.",
        "request": "Check the helper.",
        "investigation": {"tool": "read_file", "file": "helper.py", "start_line": 8},
    }
    client = _VerifierClient([{"decisions": [decision]}])
    budget = SemanticVerifierBudget(
        max_investigation_calls=0 if mode == "no_budget" else 1,
        max_model_calls=1 if mode == "no_recheck_budget" else 2,
    )

    async def unexpected(*args: object) -> InvestigationResult:
        raise AssertionError("No investigation may start without required capacity")

    result = asyncio.run(
        SemanticVerifier(client, budget=budget).verify(
            [_candidate()],
            investigator=None if mode == "no_adapter" else unexpected,
        )
    )
    assert result.receipts[0].verdict == "unresolved"
    assert result.investigation_call_count == 0
    assert client.calls == 1


def test_plain_revision_remains_a_revision_with_default_investigation_enabled() -> None:
    decision = {
        "opaque_handle": "h-1",
        "verdict": "needs_revision",
        "reason": "Classification only.",
        "request": "Change severity to info.",
        "severity_correction": "info",
    }
    client = _VerifierClient([{"decisions": [decision]}])

    async def unexpected(*args: object) -> InvestigationResult:
        raise AssertionError("A plain revision must not be routed to investigation")

    result = asyncio.run(
        SemanticVerifier(client).verify([_candidate()], investigator=unexpected)
    )
    assert result.receipts[0].verdict == "needs_revision"
    assert result.receipts[0].request == decision["request"]
    assert result.investigation_call_count == 0
    assert client.calls == 1


def test_repair_description_and_patch_schema_allow_source_location_corrections() -> (
    None
):
    schema = build_repair_tool_schemas(contract_version="3.0")[0]["function"]
    assert "anchor or related-location corrections" in schema["description"]
    assert "versions, paths," not in schema["description"]
    patch = FindingPatchV3(anchor={"file": "src/app.py", "line": 2})
    assert patch.anchor.file == "src/app.py"
    assert "anchor" in json.dumps(schema["parameters"])


def test_second_batch_target_cannot_skip_its_requested_investigation() -> None:
    requests = [
        {
            "opaque_handle": handle,
            "verdict": "needs_revision",
            "reason": "Missing source.",
            "request": "Check helper.",
            "investigation": {
                "tool": "read_file",
                "file": "helper.py",
                "start_line": 8,
            },
        }
        for handle in ["h-1", "h-2"]
    ]
    client = _VerifierClient(
        [
            {"decisions": requests},
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "Confirmed.",
                    }
                ]
            },
        ]
    )

    async def investigate(*args: object) -> InvestigationResult:
        return InvestigationResult(answer="helper observed", tool_call_count=1)

    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate("h-1"), _candidate("h-2")],
            investigator=investigate,
        )
    )
    assert [receipt.verdict for receipt in result.receipts] == ["accept", "unresolved"]
    assert result.investigation_call_count == 1
    assert client.calls == 2
