"""Offline checks for v3 finding granularity and revise behavior."""

from __future__ import annotations

import json
from typing import Any

import pytest

from src.analyzer.context_state import ContextState
from src.analyzer.finding_delivery import CandidateRegistry
from src.analyzer.output_formatter import ReviewIssue
from src.analyzer.prompts import build_review_messages
from src.analyzer.schemas import ReviewRequest
from src.models.compat import ModelCallPolicy
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig
from src.orchestrator.agent_loop import AgentOrchestrator
from src.orchestrator.tool_schemas import (
    build_repair_tool_schemas,
    build_submit_tool_schemas,
    build_v3_finding_action_tool_schemas,
)


def _wire_text(messages: list[Message], tools: list[dict[str, Any]]) -> str:
    """Serialize the same request envelope passed to an offline provider."""

    wire = RequestAssembler.wire_payload(
        messages,
        tools,
        ModelConfig(model="offline-test"),
        ModelCallPolicy(thinking="high"),
    )
    return json.dumps(wire, ensure_ascii=True, sort_keys=True)


def _v3_issue(
    *,
    file: str,
    line: int,
    description: str,
    evidence_refs: list[str],
    related_locations: list[dict[str, Any]] | None = None,
) -> ReviewIssue:
    """Build one slim v3 issue for the registry-only regression script."""

    return ReviewIssue.model_validate(
        {
            "schema_version": "3.0",
            "anchor": {"file": file, "line": line},
            "description": description,
            "evidence_refs": evidence_refs,
            "severity": "warning",
            "related_locations": related_locations or [],
        }
    )


@pytest.mark.parametrize("context_mode", ["agent_search", "graph_hybrid"])
def test_v3_ab_wire_contains_granularity_and_revise_principles(
    context_mode: str,
) -> None:
    """Both ordinary v3 context modes carry the same actual prompt/tool contract."""

    messages = build_review_messages(
        ReviewRequest(repo_path="."),
        ContextState(context_mode=context_mode),
        diff="diff --git a/src/app.py b/src/app.py\n+changed()",
        file_contents={"src/app.py": "def changed(): pass"},
        contract_version="3.0",
    )
    wire_text = _wire_text(messages, build_v3_finding_action_tool_schemas())

    for phrase in (
        "independent defect mechanism",
        "not changed-hunk count",
        "same causal mechanism and repair class",
        "related_locations",
        "arrays replace, not append",
        "current opaque handle",
    ):
        assert phrase in wire_text


def test_v3_action_parameters_keep_existing_required_fields() -> None:
    """Granularity guidance stays descriptive and adds no model-required fields."""

    schemas = {
        item["function"]["name"]: item["function"]
        for item in build_v3_finding_action_tool_schemas()
    }

    assert schemas["save_finding"]["parameters"]["required"] == ["finding"]
    assert schemas["revise_finding"]["parameters"]["required"] == [
        "opaque_handle",
        "patch",
    ]
    assert schemas["save_finding"]["parameters"]["properties"]["finding"][
        "required"
    ] == ["anchor", "description", "evidence_refs", "severity"]


def test_v2_and_repair_wires_keep_their_existing_task_boundaries() -> None:
    """The new ordinary-v3 guidance does not leak into v2 or repair requests."""

    request = ReviewRequest(repo_path=".")
    context = ContextState(context_mode="graph_hybrid")
    v2_text = _wire_text(
        build_review_messages(
            request,
            context,
            diff="diff --git a/src/app.py b/src/app.py",
            file_contents={},
            contract_version="2.0",
        ),
        build_submit_tool_schemas(model_input=True, contract_version="2.0"),
    )
    assert "submit_review exactly once" in v2_text
    assert "confidence >= 0.85" in v2_text
    assert "independent defect mechanism" not in v2_text

    repair_tools = build_repair_tool_schemas(contract_version="3.0")
    repair_text = _wire_text(
        build_review_messages(
            request,
            context,
            diff="diff --git a/src/app.py b/src/app.py",
            file_contents={},
            contract_version="3.0",
            repair_mode=True,
        ),
        repair_tools,
    )
    assert [item["function"]["name"] for item in repair_tools] == ["repair_review"]
    assert "repair_review" in repair_text
    assert "save_finding" not in repair_text
    assert "revise_finding" not in repair_text
    assert "independent defect mechanism" not in repair_text


def test_registry_revise_keeps_existing_evidence_and_location() -> None:
    """A same-cause second location remains one candidate after an explicit revise."""

    original_location = {"file": "src/app.py", "line": 12}
    original = _v3_issue(
        file="src/app.py",
        line=8,
        description="The lookup uses a key that is absent for this input path.",
        evidence_refs=["ev-root"],
        related_locations=[original_location],
    )
    registry = CandidateRegistry()
    record = registry.save_finding(original, source_issue_index=0, iteration=0)
    handle = registry.opaque_handle(record.candidate_id)
    candidate_id = registry.candidate_for_handle(handle)
    base_version = registry.version_for_handle(handle)

    revised = AgentOrchestrator._apply_v3_repair_patch(  # noqa: SLF001
        original,
        {
            "evidence_refs": ["ev-root", "ev-second-location"],
            "related_locations": [
                original_location,
                {"file": "src/other.py", "line": 27},
            ],
        },
        delete_fields=[],
        candidate_id=candidate_id,
        evidence_catalog=[],
    )
    assert registry.revise_finding(
        candidate_id,
        revised,
        base_version=base_version,
    )

    current = registry.closeout_issues()
    assert len(current) == 1
    assert current[0].evidence_refs == ["ev-root", "ev-second-location"]
    assert [item.location for item in current[0].related_locations] == [
        "src/app.py:12",
        "src/other.py:27",
    ]


def test_registry_keeps_independent_causes_as_two_candidates() -> None:
    """Two distinct mechanisms still produce two saved candidates."""

    registry = CandidateRegistry()
    first = _v3_issue(
        file="src/app.py",
        line=8,
        description="The lookup uses a key that is absent for this input path.",
        evidence_refs=["ev-first"],
    )
    second = _v3_issue(
        file="src/app.py",
        line=40,
        description="The fallback returns a value with the wrong public type.",
        evidence_refs=["ev-second"],
    )

    registry.save_finding(first, source_issue_index=0, iteration=0)
    registry.save_finding(second, source_issue_index=1, iteration=0)

    current = registry.closeout_issues()
    assert len(current) == 2
    assert {item.description for item in current} == {
        first.description,
        second.description,
    }
