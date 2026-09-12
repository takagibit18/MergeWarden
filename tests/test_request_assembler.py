"""Regression tests for the complete provider-request budget envelope."""

from __future__ import annotations

from types import SimpleNamespace

from src.models.client import ModelClient
from src.models.compat import ModelCallPolicy, ProviderCompat
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig


def _submit_tool() -> dict[str, object]:
    return {
        "type": "function",
        "function": {
            "name": "submit_review",
            "description": "Submit a validated review report.",
            "parameters": {
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
            },
        },
    }


def test_assembler_serializes_the_same_provider_controls_as_model_client() -> None:
    client = ModelClient.__new__(ModelClient)
    client._settings = SimpleNamespace(  # noqa: SLF001
        openai_base_url="https://open.bigmodel.cn/api/paas/v4",
        model_provider="zhipu",
    )
    config = ModelConfig(
        model="glm-5.3-flash",
        tool_choice={
            "type": "function",
            "function": {"name": "submit_review"},
        },
    )
    policy = ModelCallPolicy(thinking="off", forced_tool="submit_review")
    messages = [
        Message(role="system", content="Review policy."),
        Message(
            role="assistant",
            content="",
            thinking="prior reasoning",
            tool_calls=[{"id": "call-1", "type": "function"}],
        ),
    ]

    runtime_config, runtime_policy, profile = client.prepare_call(config, policy)
    payload = RequestAssembler.wire_payload(
        messages,
        [_submit_tool()],
        runtime_config,
        runtime_policy,
        profile=profile,
    )

    assert payload["extra_body"] == {"thinking": {"type": "enabled"}}
    assert payload["reasoning_effort"] == "low"
    assert payload["messages"][1]["reasoning_content"] == "prior reasoning"
    assert "thinking" not in payload
    assert "forced_tool" not in payload


def test_assembler_counts_tool_schema_and_removes_replay_history_first() -> None:
    config = ModelConfig(model="fake-model")
    policy = ModelCallPolicy(thinking="off")
    tools = [_submit_tool()]
    stable_messages = [
        Message(role="system", content="Keep this policy."),
        Message(role="user", content="Final review payload."),
    ]
    budget = RequestAssembler.estimate(stable_messages, tools, config, policy)
    messages = [
        *stable_messages[:1],
        Message(role="assistant", content="Old assistant replay."),
        Message(role="tool", content="Old tool replay."),
        *stable_messages[1:],
    ]

    assembled = RequestAssembler.fit(
        messages,
        tools,
        config,
        policy,
        budget=budget,
    )

    assert [item.role for item in assembled.messages] == ["system", "user"]
    assert assembled.dropped_message_count == 2
    assert assembled.estimated_tokens <= budget
    assert assembled.request_hash
    assert assembled.serialized_payload


def test_assembler_shortens_context_deterministically_after_history_removal() -> None:
    config = ModelConfig(model="fake-model")
    policy = ModelCallPolicy(thinking="off")
    messages = [
        Message(role="system", content="System policy."),
        Message(role="user", content="A" * 8000),
        Message(role="user", content="B" * 4000),
    ]

    first = RequestAssembler.fit(messages, [], config, policy, budget=1200)
    second = RequestAssembler.fit(messages, [], config, policy, budget=1200)

    assert first.trimmed is True
    assert first.messages == second.messages
    assert first.request_hash == second.request_hash
    assert "request context shortened" in first.messages[1].content
    assert first.estimated_tokens <= 1200


def test_assembler_exposes_over_budget_when_fixed_envelope_cannot_fit() -> None:
    config = ModelConfig(model="fake-model")
    policy = ModelCallPolicy(thinking="off")
    assembled = RequestAssembler.fit(
        [Message(role="system", content="A")],
        [_submit_tool()],
        config,
        policy,
        budget=1,
    )

    assert assembled.estimated_tokens > 1
    assert assembled.trimmed is False


def test_profile_defaults_keep_reasoning_replay_disabled_for_plain_openai() -> None:
    profile = SimpleNamespace(
        compat=ProviderCompat(
            requires_reasoning_replay_for_tool_calls=False,
        )
    )
    payload = RequestAssembler.wire_payload(
        [Message(role="assistant", content="", thinking="private")],
        [],
        ModelConfig(model="fake-model"),
        ModelCallPolicy(thinking="off"),
        profile=profile,
    )

    assert "reasoning_content" not in payload["messages"][0]
