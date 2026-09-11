"""Offline contract tests for the v3 reviewer wire and closeout boundary."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from src.analyzer.context_state import ContextState
from src.analyzer.inference_engine import InferenceEngine
from src.analyzer.prompts import build_review_messages
from src.analyzer.schemas import ReviewRequest
from src.models.compat import ModelCallPolicy
from src.models.client import ModelClient
from src.models.conversation import ModelConversation
from src.models.exceptions import ModelClientError
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig, ModelResponse, TokenUsage
from src.orchestrator.tool_schemas import build_v3_finding_action_tool_schemas
from src.tools.base import ToolResult


class _OfflineWireClient:
    """Capture one model request without contacting a provider."""

    def __init__(self) -> None:
        self.default_config = ModelConfig(model="offline-test")
        self.messages: list[Message] = []
        self.tools: list[dict[str, Any]] = []
        self.config: ModelConfig | None = None
        self.policy: ModelCallPolicy | None = None
        self.conversation: ModelConversation | None = None

    async def chat(
        self,
        messages: list[Message],
        config: ModelConfig,
        tools: list[dict[str, Any]],
        policy: ModelCallPolicy,
        conversation: ModelConversation,
    ) -> ModelResponse:
        self.messages = messages
        self.tools = tools
        self.config = config
        self.policy = policy
        self.conversation = conversation
        return ModelResponse(
            content="",
            tool_calls=[],
            usage=TokenUsage(total_tokens=1),
            model="offline-test",
            finish_reason="stop",
        )


class _BudgetWireClient(_OfflineWireClient):
    """Offline client with explicit per-attempt telemetry for budget tests."""

    def __init__(
        self,
        *,
        response: ModelResponse | None = None,
        attempts: list[dict[str, Any]] | None = None,
        cancel: bool = False,
        budget_error: bool = False,
    ) -> None:
        super().__init__()
        self.default_config = ModelConfig(model="offline-budget", max_tokens=16)
        self.response = response or ModelResponse(
            content="",
            tool_calls=[],
            usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            model="offline-budget",
            finish_reason="stop",
        )
        self._attempts = list(attempts or [])
        self.cancel = cancel
        self.budget_error = budget_error
        self.calls = 0

    async def chat(
        self,
        messages: list[Message],
        config: ModelConfig,
        tools: list[dict[str, Any]],
        policy: ModelCallPolicy,
        conversation: ModelConversation,
    ) -> ModelResponse:
        self.calls += 1
        self.messages = messages
        self.tools = tools
        self.config = config
        self.policy = policy
        self.conversation = conversation
        if self.budget_error:
            raise ModelClientError(
                "Logical call token budget is insufficient for a provider attempt",
                code="call_token_budget_exhausted",
            )
        if self.cancel:
            raise asyncio.CancelledError()
        return self.response

    def consume_call_telemetry(self) -> list[dict[str, Any]]:
        attempts = list(self._attempts)
        self._attempts = []
        return attempts


def test_v3_prompt_and_wire_schema_make_finish_optional() -> None:
    request = ReviewRequest(repo_path=".")
    messages = build_review_messages(
        request,
        ContextState(),
        diff="diff --git a/src/app.py b/src/app.py",
        file_contents={},
        contract_version="3.0",
    )
    tools = build_v3_finding_action_tool_schemas()
    wire = RequestAssembler.wire_payload(
        messages,
        tools,
        ModelConfig(model="offline-test"),
        ModelCallPolicy(thinking="high"),
    )
    serialized_wire = json.dumps(wire, ensure_ascii=True, sort_keys=True)

    assert "finish_review is optional" in serialized_wire
    assert "When the saved set is ready" not in serialized_wire
    descriptions = {
        item["function"]["name"]: item["function"]["description"]
        for item in wire["tools"]
    }
    assert "not a model finish" in descriptions["save_finding"]
    assert "runtime closeout may hand off" in descriptions["finish_review"]
    assert "submit the saved finding set" not in descriptions["finish_review"]


def test_v3_near_last_ordinary_call_keeps_exploration_tools(monkeypatch) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    client = _OfflineWireClient()
    engine = InferenceEngine(model_client=client)  # type: ignore[arg-type]
    tools = build_v3_finding_action_tool_schemas() + [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read one delivered source file.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=tools,
            near_last_iteration=True,
            # This is the legacy label emitted by older callers. v3 must not
            # reinterpret it as a submission-only stage.
            stage="submit_only",
            contract_version="3.0",
        )
    )

    assert client.config is not None
    assert client.policy is not None
    assert client.policy.thinking == "high"
    assert client.config.tool_choice is None
    assert {item["function"]["name"] for item in client.tools} == {
        "save_finding",
        "revise_finding",
        "finish_review",
        "read_file",
    }
    wire_text = json.dumps(
        RequestAssembler.wire_payload(
            client.messages,
            client.tools,
            client.config,
            client.policy,
        ),
        ensure_ascii=True,
    )
    assert "runtime closeout receives the current Registry contents" in wire_text
    assert "Prefer finishing now" not in wire_text


def test_v3_analyze_places_current_handles_in_runtime_directory(monkeypatch) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    client = _OfflineWireClient()
    engine = InferenceEngine(model_client=client)  # type: ignore[arg-type]

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            contract_version="3.0",
            current_finding_handles=[
                {
                    "opaque_handle": "vh-current-1",
                    "anchor": "src/app.py:12",
                    "description_short": "Current finding label",
                }
            ],
        )
    )

    directory = next(
        message
        for message in client.messages
        if message.role == "user"
        and "runtime_current_finding_handles" in message.content
    )
    directory_payload = json.loads(directory.content.split("\n", 1)[1])
    assert directory_payload == [
        {
            "opaque_handle": "vh-current-1",
            "anchor": "src/app.py:12",
            "description_short": "Current finding label",
        }
    ]
    assert "candidate_id" not in directory.content
    assert "content_version" not in directory.content


def test_v3_call_budget_preflight_skips_provider_send(monkeypatch) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    client = _BudgetWireClient()
    engine = InferenceEngine(model_client=client)  # type: ignore[arg-type]

    plan, usage = asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            contract_version="3.0",
            remaining_call_token_budget=1,
        )
    )

    assert client.calls == 0
    assert engine.last_call_budget_tokens_used == 0
    assert plan.incomplete_reason == "call_token_budget_exhausted"
    assert plan.recovery_required
    assert usage.total_tokens == 0


def test_call_budget_charges_each_attempt_and_does_not_double_count_reasoning() -> None:
    response = ModelResponse(
        content="",
        tool_calls=[],
        usage=TokenUsage(
            prompt_tokens=3,
            completion_tokens=7,
            reasoning_tokens=4,
            total_tokens=23,
        ),
        model="offline-budget",
        finish_reason="stop",
    )
    client = _BudgetWireClient(
        response=response,
        attempts=[
            {
                "provider_attempt": 1,
                "success": False,
                "usage_present": False,
            },
            {
                "provider_attempt": 2,
                "success": True,
                "usage_present": True,
                "completion_tokens": 7,
                "reasoning_tokens": 4,
                "total_tokens": 23,
            },
        ],
    )
    engine = InferenceEngine(model_client=client)  # type: ignore[arg-type]
    remaining = 200_000

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=[],
            contract_version="3.0",
            remaining_call_token_budget=remaining,
        )
    )

    assert client.calls == 1
    assert client.config is not None
    assert client.config.call_token_budget == remaining
    assert client.policy is not None
    input_estimate = RequestAssembler.estimate(
        client.messages,
        client.tools,
        client.config,
        client.policy,
    )
    max_output = client.config.max_tokens
    expected = (input_estimate + max_output) + max(
        input_estimate + response.usage.completion_tokens,
        response.usage.total_tokens,
    )
    assert engine.last_call_budget_tokens_used == expected
    assert engine.last_call_budget_tokens_used < (
        (input_estimate + max_output)
        + input_estimate
        + response.usage.completion_tokens
        + response.usage.reasoning_tokens
    )


def test_nested_reasoning_usage_is_not_added_twice_to_known_charge() -> None:
    completion = SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content="", tool_calls=[]),
                finish_reason="stop",
            )
        ],
        usage=SimpleNamespace(
            prompt_tokens=3,
            completion_tokens=7,
            completion_tokens_details=SimpleNamespace(reasoning_tokens=4),
            total_tokens=23,
        ),
        model="offline-budget",
    )
    response = ModelClient._parse_completion(completion)  # noqa: SLF001
    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]

    charges = engine._charge_call_budget(  # noqa: SLF001
        request_estimated_tokens=100,
        max_output_tokens=16,
        response=response,
        attempts=[
            {
                "success": True,
                "usage_present": True,
                "completion_tokens": response.usage.completion_tokens,
                "reasoning_tokens": response.usage.reasoning_tokens,
                "total_tokens": response.usage.total_tokens,
            }
        ],
    )

    assert response.usage.completion_tokens == 7
    assert response.usage.reasoning_tokens == 4
    assert charges == [max(100 + 7, 23)]
    assert engine.last_call_budget_tokens_used == 107


def test_cancelled_call_charges_unknown_attempt_before_reraising() -> None:
    client = _BudgetWireClient(cancel=True)
    events: list[tuple[Any, str, dict[str, Any]]] = []
    engine = InferenceEngine(
        model_client=client,  # type: ignore[arg-type]
        trace_event_writer=lambda event, name, payload: events.append(
            (event, name, payload)
        ),
    )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            engine._chat_with_telemetry(  # noqa: SLF001
                messages=[Message(role="user", content="cancelled request")],
                config=ModelConfig(model="offline-budget", max_tokens=16),
                tools=[],
                policy=ModelCallPolicy(thinking="high"),
                iteration=0,
                stage="explore",
                force_submit=False,
                request_estimated_tokens=12,
                max_output_tokens=16,
            )
        )

    assert engine.last_call_budget_tokens_used == 28
    assert len(events) == 1
    assert events[0][2]["budget_tokens_used"] == 28
    assert events[0][2]["usage_unknown"]


def test_zero_attempt_budget_error_has_no_synthetic_charge_or_trace() -> None:
    events: list[tuple[Any, str, dict[str, Any]]] = []
    client = _BudgetWireClient(budget_error=True)
    engine = InferenceEngine(
        model_client=client,  # type: ignore[arg-type]
        trace_event_writer=lambda event, name, payload: events.append(
            (event, name, payload)
        ),
    )

    with pytest.raises(ModelClientError, match="token budget is insufficient"):
        asyncio.run(
            engine._chat_with_telemetry(  # noqa: SLF001
                messages=[Message(role="user", content="budget rejection")],
                config=ModelConfig(model="offline-budget", max_tokens=16),
                tools=[],
                policy=ModelCallPolicy(thinking="high"),
                iteration=0,
                stage="explore",
                force_submit=False,
                request_estimated_tokens=12,
                max_output_tokens=16,
            )
        )

    assert engine.last_call_budget_tokens_used == 0
    assert not events


def test_actual_tool_receipt_survives_into_v3_provider_wire(monkeypatch) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    conversation = ModelConversation()
    conversation.add_assistant_tool_turn(
        response_id="provider-response-1",
        content="",
        thinking="",
        tool_calls=[
            {
                "id": "provider-call-read-1",
                "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"src/app.py"}'},
            }
        ],
    )
    conversation.add_tool_result(
        "provider-call-read-1",
        {"ok": True, "data": {"path": "src/app.py", "content": "wire receipt"}},
    )
    client = _OfflineWireClient()
    engine = InferenceEngine(  # type: ignore[arg-type]
        model_client=client,  # type: ignore[arg-type]
        conversation=conversation,
    )

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            diff_text="diff --git a/src/app.py b/src/app.py",
            prompt_input_token_budget=12000,
            contract_version="3.0",
        )
    )

    assert client.conversation is conversation
    assistant = next(
        message for message in client.messages if message.role == "assistant"
    )
    receipt = next(message for message in client.messages if message.role == "tool")
    assert assistant.tool_calls
    assert assistant.tool_calls[0]["id"] == "provider-call-read-1"
    assert receipt.tool_call_id == "provider-call-read-1"
    assert "wire receipt" in receipt.content


def test_runtime_save_receipt_handle_is_visible_to_next_revise_wire(
    monkeypatch,
) -> None:
    """A real structured save receipt supplies the only model-facing handle."""

    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    conversation = ModelConversation()
    conversation.add_assistant_tool_turn(
        response_id="provider-save-response",
        content="",
        thinking="",
        tool_calls=[
            {
                "id": "provider-save-call-1",
                "type": "function",
                "function": {
                    "name": "save_finding",
                    "arguments": '{"finding":{"anchor":{"file":"src/app.py","line":1}}}',
                },
            }
        ],
    )
    conversation.add_tool_result(
        "provider-save-call-1",
        ToolResult(
            ok=True,
            data={
                "saved": True,
                "opaque_handle": "vh_saved_finding_1",
            },
        ),
    )
    client = _OfflineWireClient()
    engine = InferenceEngine(  # type: ignore[arg-type]
        model_client=client,  # type: ignore[arg-type]
        conversation=conversation,
    )

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            contract_version="3.0",
        )
    )

    receipt = next(message for message in client.messages if message.role == "tool")
    assert receipt.tool_call_id == "provider-save-call-1"
    assert "vh_saved_finding_1" in receipt.content
    revise_schema = next(
        item for item in client.tools if item["function"]["name"] == "revise_finding"
    )
    assert "opaque_handle" in revise_schema["function"]["parameters"]["properties"]


def test_v3_force_closeout_keeps_saved_handle_after_validator_pass(monkeypatch) -> None:
    """Explicit v3 force_submit still supports a handle-based revision."""

    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    conversation = ModelConversation()
    conversation.add_assistant_tool_turn(
        response_id="provider-save-response",
        content="",
        thinking="",
        tool_calls=[
            {
                "id": "provider-save-call-1",
                "type": "function",
                "function": {"name": "save_finding", "arguments": "{}"},
            }
        ],
    )
    conversation.add_tool_result(
        "provider-save-call-1",
        {"ok": True, "data": {"opaque_handle": "vh_saved_finding_1"}},
    )
    client = _OfflineWireClient()
    engine = InferenceEngine(  # type: ignore[arg-type]
        model_client=client,  # type: ignore[arg-type]
        conversation=conversation,
    )

    asyncio.run(
        engine.analyze(
            state=ContextState(),
            request=ReviewRequest(repo_path="."),
            tool_specs=[],
            tool_schemas=build_v3_finding_action_tool_schemas(),
            force_submit=True,
            validator_result={"submit_allowed": True},
            contract_version="3.0",
        )
    )

    assert any("vh_saved_finding_1" in message.content for message in client.messages)
    assert client.config is not None
    assert client.config.tool_choice == "auto"
    assert client.policy is not None
    assert client.policy.forced_tool is None


def test_v3_registry_action_turn_is_trimmed_atomically_without_directory() -> None:
    """Ordinary history may drop a provider turn, but never half of its pair."""

    conversation = ModelConversation()
    conversation.add_assistant_tool_turn(
        response_id="provider-save-response",
        content="",
        thinking="",
        tool_calls=[
            {
                "id": "provider-save-call-1",
                "type": "function",
                "function": {"name": "save_finding", "arguments": "{}"},
            }
        ],
    )
    conversation.add_tool_result(
        "provider-save-call-1",
        {"ok": True, "data": {"opaque_handle": "vh_saved_finding_1"}},
    )
    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]
    system = Message(role="system", content="v3 reviewer")
    original_history = engine._preserve_v3_registry_turns(  # noqa: SLF001
        conversation.messages()
    )
    config = ModelConfig(model="offline-test")
    policy = ModelCallPolicy(thinking="high")
    preserved_budget = RequestAssembler.estimate(
        [system, *original_history], [], config, policy
    )
    request = [
        system,
        Message(role="user", content="context " * 10000),
        *original_history,
    ]
    assembled = RequestAssembler.fit(
        request,
        [],
        config,
        policy,
        budget=max(512, preserved_budget + 24),
    )

    assert assembled.trimmed
    retained_call_ids = {
        call["id"]
        for message in assembled.messages
        if message.role == "assistant" and message.tool_calls
        for call in message.tool_calls
    }
    retained_result_ids = {
        message.tool_call_id for message in assembled.messages if message.role == "tool"
    }
    assert retained_call_ids == retained_result_ids
    assert "provider-save-call-1" not in retained_call_ids


def test_v3_current_handle_directory_survives_history_trim() -> None:
    conversation = ModelConversation()
    for index in range(16):
        save_id = f"provider-save-{index}"
        read_id = f"provider-read-{index}"
        finish_id = f"provider-finish-{index}"
        old_body = f"old-finding-body-{index}-" + ("x" * 4000)
        conversation.add_assistant_tool_turn(
            response_id=f"provider-response-{index}",
            content="model commentary " + ("y" * 1000),
            thinking="private reasoning " + ("z" * 1000),
            tool_calls=[
                {
                    "id": save_id,
                    "type": "function",
                    "function": {
                        "name": "save_finding",
                        "arguments": json.dumps(
                            {
                                "finding": {
                                    "anchor": {"file": "src/app.py", "line": index + 1},
                                    "description": old_body,
                                    "evidence_refs": ["ev-1"],
                                    "severity": "warning",
                                }
                            }
                        ),
                    },
                },
                {
                    "id": read_id,
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": json.dumps({"path": "src/app.py"}),
                    },
                },
                {
                    "id": finish_id,
                    "type": "function",
                    "function": {
                        "name": "finish_review",
                        "arguments": json.dumps({"summary": "old closeout"}),
                    },
                },
            ],
        )
        conversation.add_tool_result(
            save_id,
            {"ok": True, "data": {"opaque_handle": f"vh-handle-{index}"}},
        )
        conversation.add_tool_result(
            read_id,
            {
                "ok": True,
                "data": {"content": f"large-sibling-{index}-" + ("r" * 6000)},
            },
        )
        conversation.add_tool_result(
            finish_id,
            {"ok": True, "data": {"finished": True}},
        )

    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]
    original_history = engine._preserve_v3_registry_turns(  # noqa: SLF001
        conversation.messages()
    )
    assert original_history == conversation.messages()
    directory = engine._build_current_finding_handles_message(  # noqa: SLF001
        [
            {
                "opaque_handle": f"vh-handle-{index}",
                "anchor": f"src/app.py:{index + 1}",
                "description_short": f"Current finding {index}",
            }
            for index in range(16)
        ]
    )
    assert directory is not None
    assert directory.role == "user"
    assert directory.preserve_on_trim
    assert "vh-handle-15" in directory.content
    assert "old-finding-body-0" not in directory.content
    assert "large-sibling-15" not in directory.content

    system = Message(role="system", content="v3 reviewer")
    config = ModelConfig(model="offline-test")
    policy = ModelCallPolicy(thinking="high")
    preserved_budget = RequestAssembler.estimate(
        [system, directory], [], config, policy
    )
    assembled = RequestAssembler.fit(
        [
            system,
            directory,
            Message(role="user", content="new context " * 30000),
            *original_history,
        ],
        [],
        config,
        policy,
        budget=max(512, preserved_budget + 24),
    )

    assert assembled.trimmed
    retained_calls = {
        call["id"]
        for message in assembled.messages
        if message.role == "assistant" and message.tool_calls
        for call in message.tool_calls
    }
    retained_results = {
        message.tool_call_id for message in assembled.messages if message.role == "tool"
    }
    assert retained_calls == retained_results
    assert "vh-handle-15" in json.dumps(
        [message.model_dump(mode="json") for message in assembled.messages],
        ensure_ascii=True,
    )
    assert "old-finding-body-0" not in json.dumps(
        [message.model_dump(mode="json") for message in assembled.messages],
        ensure_ascii=True,
    )
    assert "large-sibling-15" not in json.dumps(
        [message.model_dump(mode="json") for message in assembled.messages],
        ensure_ascii=True,
    )


def test_v3_legacy_submit_error_keeps_finish_optional() -> None:
    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]
    _, metadata = engine._parse_tool_calls(  # noqa: SLF001
        [
            {
                "function": {
                    "name": "submit_review",
                    "arguments": '{"summary":"legacy","issues":[]}',
                }
            }
        ],
        ReviewRequest(repo_path="."),
        contract_version="3.0",
    )

    guidance = metadata["submit_review_validation_error"]
    assert "save_finding" in guidance
    assert "revise_finding" in guidance
    assert "finish_review is optional" in guidance


def test_v3_action_refs_keep_valid_and_invalid_calls_exactly_aligned() -> None:
    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]
    valid_finding = {
        "anchor": {"file": "src/app.py", "line": 1},
        "description": "The saved behavior is incorrect.",
        "evidence_refs": ["ev-1"],
        "severity": "warning",
    }
    plan, metadata = engine._parse_tool_calls(  # noqa: SLF001
        [
            {
                "id": "save-1",
                "function": {
                    "name": "save_finding",
                    "arguments": json.dumps({"finding": valid_finding}),
                },
            },
            {
                "id": "bad-save",
                "function": {
                    "name": "save_finding",
                    "arguments": json.dumps(
                        {"finding": {"anchor": {"file": "src/app.py", "line": 2}}}
                    ),
                },
            },
            {
                "id": "save-2",
                "function": {
                    "name": "save_finding",
                    "arguments": json.dumps({"finding": valid_finding}),
                },
            },
            {
                "id": "revise-1",
                "function": {
                    "name": "revise_finding",
                    "arguments": json.dumps(
                        {
                            "opaque_handle": "vh-existing",
                            "patch": {
                                "description": "The corrected behavior is explicit."
                            },
                        }
                    ),
                },
            },
            {
                "id": "finish-1",
                "function": {
                    "name": "finish_review",
                    "arguments": json.dumps(
                        {"summary": "Stop after the saved actions."}
                    ),
                },
            },
        ],
        ReviewRequest(repo_path="."),
        contract_version="3.0",
    )

    assert metadata.get("v3_action_validation_errors")
    assert len(plan.v3_save_findings) == 2
    assert len(plan.v3_revise_findings) == 1
    assert plan.v3_finish_review is not None
    assert [
        (ref.name, ref.provider_call_id, ref.raw_call_index, ref.action_index)
        for ref in plan.v3_action_call_refs
    ] == [
        ("save_finding", "save-1", 0, 0),
        ("save_finding", "bad-save", 1, None),
        ("save_finding", "save-2", 2, 1),
        ("revise_finding", "revise-1", 3, 0),
        ("finish_review", "finish-1", 4, 0),
    ]
    bad_ref = plan.v3_action_call_refs[1]
    assert bad_ref.validation_error
    assert json.loads(bad_ref.raw_arguments)["finding"]["anchor"]["line"] == 2
    assert "v3_action_call_refs" not in plan.model_dump()


def test_v3_duplicate_provider_action_id_is_not_reused_for_a_valid_action() -> None:
    engine = InferenceEngine(model_client=_OfflineWireClient())  # type: ignore[arg-type]
    finding = {
        "anchor": {"file": "src/app.py", "line": 1},
        "description": "A supported behavior change.",
        "evidence_refs": ["ev-1"],
        "severity": "warning",
    }
    plan, _ = engine._parse_tool_calls(  # noqa: SLF001
        [
            {
                "id": "duplicate-id",
                "function": {
                    "name": "save_finding",
                    "arguments": json.dumps({"finding": finding}),
                },
            },
            {
                "id": "duplicate-id",
                "function": {
                    "name": "revise_finding",
                    "arguments": json.dumps(
                        {"opaque_handle": "vh-existing", "patch": {"severity": "info"}}
                    ),
                },
            },
        ],
        ReviewRequest(repo_path="."),
        contract_version="3.0",
    )

    assert len(plan.v3_save_findings) == 1
    assert not plan.v3_revise_findings
    assert plan.v3_action_call_refs[0].validation_error == ""
    assert plan.v3_action_call_refs[1].action_index is None
    assert "duplicate provider call id" in plan.v3_action_call_refs[1].validation_error
