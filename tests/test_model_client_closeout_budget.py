"""Offline integration checks for application-owned ModelClient retries."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import APIConnectionError

import src.models.client as client_module
from src.models.client import ModelClient
from src.models.exceptions import ModelClientError, ServiceUnavailableError
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig
from src.models.token_telemetry import serialize_json


class _FakeCompletions:
    def __init__(self, outcomes: list[Any]) -> None:
        self._outcomes = list(outcomes)
        self.calls = 0
        self.payloads: list[dict[str, Any]] = []

    async def create(self, **payload: Any) -> Any:
        self.calls += 1
        self.payloads.append(dict(payload))
        if self._outcomes:
            outcome = self._outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        return _response()


class _FakeSDK:
    def __init__(self, outcomes: list[Any]) -> None:
        self.completions = _FakeCompletions(outcomes)
        self.chat = SimpleNamespace(completions=self.completions)

    async def close(self) -> None:
        return None


class _BlockingCompletions:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.block = asyncio.Event()
        self.calls = 0
        self.payloads: list[dict[str, Any]] = []

    async def create(self, **payload: Any) -> Any:
        self.calls += 1
        self.payloads.append(dict(payload))
        self.entered.set()
        await self.block.wait()
        return _response()


class _BlockingSDK:
    def __init__(self) -> None:
        self.completions = _BlockingCompletions()
        self.chat = SimpleNamespace(completions=self.completions)

    async def close(self) -> None:
        return None


def _settings(*, max_retries: int = 3) -> SimpleNamespace:
    return SimpleNamespace(
        openai_api_key="offline-test-key",
        openai_base_url="https://provider.invalid/v1",
        model_name="fake-model",
        model_provider="openai",
        model_max_tokens=8,
        model_request_timeout_seconds=5.0,
        model_max_retries=max_retries,
    )


def _connection_error() -> APIConnectionError:
    request = httpx.Request("POST", "https://provider.invalid/v1/chat/completions")
    return APIConnectionError(request=request)


def _response() -> Any:
    message = SimpleNamespace(content="ok", reasoning_content="", tool_calls=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    usage = SimpleNamespace(prompt_tokens=2, completion_tokens=3, total_tokens=5)
    return SimpleNamespace(
        id="response-1",
        choices=[choice],
        usage=usage,
        model="fake-model",
    )


def _make_client(
    monkeypatch: pytest.MonkeyPatch,
    outcomes: list[Any],
    *,
    max_retries: int = 3,
) -> tuple[ModelClient, _FakeSDK, dict[str, Any]]:
    fake = _FakeSDK(outcomes)
    init_kwargs: dict[str, Any] = {}

    def fake_sdk_factory(**kwargs: Any) -> _FakeSDK:
        init_kwargs.update(kwargs)
        return fake

    monkeypatch.setattr(client_module, "AsyncOpenAI", fake_sdk_factory)
    monkeypatch.setattr(
        ModelClient,
        "_build_http_client",
        staticmethod(lambda: SimpleNamespace(event_hooks={"response": []})),
    )
    return ModelClient(settings=_settings(max_retries=max_retries)), fake, init_kwargs


def _make_blocking_client(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[ModelClient, _BlockingSDK]:
    fake = _BlockingSDK()

    def fake_sdk_factory(**kwargs: Any) -> _BlockingSDK:
        assert kwargs["max_retries"] == 0
        return fake

    monkeypatch.setattr(client_module, "AsyncOpenAI", fake_sdk_factory)
    monkeypatch.setattr(
        ModelClient,
        "_build_http_client",
        staticmethod(lambda: SimpleNamespace(event_hooks={"response": []})),
    )
    return ModelClient(settings=_settings()), fake


def _attempt_budget(client: ModelClient, config: ModelConfig) -> int:
    messages = [Message(role="user", content="offline closeout budget")]
    runtime_config, policy, profile = client.prepare_call(config)
    wire_payload = RequestAssembler.wire_payload(
        messages,
        [],
        runtime_config,
        policy,
        profile=profile,
    )
    return client._estimate_attempt_token_budget(  # noqa: SLF001
        serialize_json(wire_payload),
        runtime_config.max_tokens,
    )


def _messages() -> list[Message]:
    return [Message(role="user", content="offline closeout budget")]


def test_real_client_disables_sdk_retry_and_keeps_budget_off_wire(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake, init_kwargs = _make_client(monkeypatch, [_response()])
    config = ModelConfig(model="fake-model", max_tokens=8)
    budget = _attempt_budget(client, config)
    config.call_token_budget = budget

    response = asyncio.run(client.chat(_messages(), config=config))

    assert init_kwargs["max_retries"] == 0
    assert "call_token_budget" not in config.model_dump()
    assert fake.completions.calls == 1
    assert fake.completions.payloads[0].get("call_token_budget") is None
    assert response.usage.total_tokens == 5

    attempts = client.consume_call_telemetry()
    assert len(attempts) == 1
    assert attempts[0]["total_tokens"] == 5
    assert attempts[0]["call_budget_reserved_tokens"] == budget
    assert attempts[0]["call_budget_remaining_tokens"] == 0
    assert client._last_call_budget_reserved_tokens == budget  # noqa: SLF001
    assert budget > response.usage.total_tokens


def test_zero_budget_blocks_before_first_provider_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake, _ = _make_client(monkeypatch, [_response()])
    config = ModelConfig(model="fake-model", max_tokens=8, call_token_budget=0)

    with pytest.raises(
        ModelClientError, match="token budget is insufficient"
    ) as raised:
        asyncio.run(client.chat(_messages(), config=config))

    assert raised.value.code == "call_token_budget_exhausted"
    assert fake.completions.calls == 0
    assert client.consume_call_telemetry() == []
    assert client._last_call_budget_reserved_tokens == 0  # noqa: SLF001


def test_unknown_failed_attempt_spends_one_reservation_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake, _ = _make_client(monkeypatch, [_connection_error(), _response()])
    config = ModelConfig(model="fake-model", max_tokens=8)
    budget = _attempt_budget(client, config)
    config.call_token_budget = budget
    sleeps: list[float] = []

    async def record_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", record_sleep)

    with pytest.raises(ServiceUnavailableError):
        asyncio.run(client.chat(_messages(), config=config))

    assert fake.completions.calls == 1
    assert sleeps == []
    attempts = client.consume_call_telemetry()
    assert len(attempts) == 1
    assert attempts[0]["success"] is False
    assert attempts[0]["usage_unknown"] is True
    assert attempts[0]["call_budget_reserved_tokens"] == budget
    assert attempts[0]["call_budget_remaining_tokens"] == 0


def test_two_reservations_allow_one_application_retry_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake, init_kwargs = _make_client(
        monkeypatch, [_connection_error(), _response()]
    )
    config = ModelConfig(model="fake-model", max_tokens=8)
    budget = _attempt_budget(client, config)
    config.call_token_budget = budget * 2
    sleeps: list[float] = []

    async def record_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", record_sleep)

    response = asyncio.run(client.chat(_messages(), config=config))

    assert init_kwargs["max_retries"] == 0
    assert fake.completions.calls == 2
    assert sleeps == [1]
    attempts = client.consume_call_telemetry()
    assert len(attempts) == 2
    assert attempts[0]["success"] is False
    assert attempts[0]["usage_unknown"] is True
    assert attempts[1]["success"] is True
    assert attempts[1]["total_tokens"] == response.usage.total_tokens == 5
    assert [item["call_budget_remaining_tokens"] for item in attempts] == [budget, 0]
    assert client._last_call_budget_reserved_tokens == budget * 2  # noqa: SLF001
    assert client._last_call_budget_remaining_tokens == 0  # noqa: SLF001
    assert sum(item["total_tokens"] for item in attempts) == 5
    assert client._last_call_budget_reserved_tokens != response.usage.total_tokens  # noqa: SLF001


def test_cancelled_sdk_await_is_audited_once_and_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake = _make_blocking_client(monkeypatch)
    config = ModelConfig(model="fake-model", max_tokens=8)
    budget = _attempt_budget(client, config)
    config.call_token_budget = budget

    async def cancel_after_sdk_entry() -> None:
        task = asyncio.create_task(client.chat(_messages(), config=config))
        await fake.completions.entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(cancel_after_sdk_entry())

    assert fake.completions.calls == 1
    attempts = client.consume_call_telemetry()
    assert len(attempts) == 1
    assert attempts[0]["success"] is False
    assert attempts[0]["cancelled"] is True
    assert attempts[0]["usage_unknown"] is True
    assert attempts[0]["failure_type"] == "cancelled"
    assert attempts[0]["call_budget_reserved_tokens"] == budget
    assert attempts[0]["call_budget_remaining_tokens"] == 0


def test_none_budget_preserves_application_retry_compatibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, fake, _ = _make_client(monkeypatch, [_connection_error(), _response()])
    sleeps: list[float] = []

    async def record_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", record_sleep)

    response = asyncio.run(
        client.chat(
            _messages(),
            config=ModelConfig(model="fake-model", max_tokens=8),
        )
    )

    assert response.content == "ok"
    assert fake.completions.calls == 2
    assert sleeps == [1]
    attempts = client.consume_call_telemetry()
    assert len(attempts) == 2
    assert all(item["call_budget_reserved_tokens"] is None for item in attempts)
    assert client._last_call_budget_remaining_tokens is None  # noqa: SLF001
