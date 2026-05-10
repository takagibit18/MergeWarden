"""Tests for model client provider-specific request controls."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from src.models.client import ModelClient
from src.models.schemas import Message, ModelConfig


class _FakeCompletions:
    def __init__(self) -> None:
        self.payload: dict[str, Any] | None = None

    async def create(self, **payload: Any) -> Any:
        self.payload = payload
        message = SimpleNamespace(
            content="ok",
            reasoning_content="kept reasoning",
            tool_calls=None,
        )
        choice = SimpleNamespace(message=message, finish_reason="stop")
        usage = SimpleNamespace(
            prompt_tokens=1,
            completion_tokens=2,
            total_tokens=3,
        )
        return SimpleNamespace(
            choices=[choice],
            usage=usage,
            model="fake-model",
        )


class _FakeOpenAIClient:
    def __init__(self) -> None:
        self.completions = _FakeCompletions()
        self.chat = SimpleNamespace(completions=self.completions)


def _make_client(fake: _FakeOpenAIClient) -> ModelClient:
    client = ModelClient.__new__(ModelClient)
    client._client = fake  # noqa: SLF001
    client._default_config = ModelConfig(model="fake-model")  # noqa: SLF001
    client._max_retries = 1  # noqa: SLF001
    return client


def test_chat_forwards_tool_choice_extra_body_and_reasoning_messages() -> None:
    fake = _FakeOpenAIClient()
    client = _make_client(fake)
    config = ModelConfig(
        model="deepseek-v4-pro",
        tool_choice={"type": "function", "function": {"name": "submit_review"}},
        extra_body={"thinking": {"type": "disabled"}},
    )

    response = asyncio.run(
        client.chat(
            messages=[
                Message(
                    role="assistant",
                    content="",
                    tool_calls=[{"id": "call-1", "function": {"name": "read_file"}}],
                    reasoning_content="prior reasoning",
                )
            ],
            config=config,
            tools=[{"type": "function", "function": {"name": "submit_review"}}],
        )
    )

    payload = fake.completions.payload
    assert payload is not None
    assert payload["tool_choice"] == {
        "type": "function",
        "function": {"name": "submit_review"},
    }
    assert payload["extra_body"] == {"thinking": {"type": "disabled"}}
    assert payload["messages"][0]["reasoning_content"] == "prior reasoning"
    assert response.reasoning_content == "kept reasoning"
