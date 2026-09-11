"""Offline transport tests: observations must never change model semantics."""

import asyncio
import json
from pathlib import Path

import httpx
import pytest

from src.config import Settings
from src.models.client import ModelClient
from src.models.receive_trace import (
    ACTIVE_TRACE,
    ReceiveTrace,
    observe_headers,
    observed_await,
)
from src.models.schemas import Message, ModelConfig


class Body(httpx.AsyncByteStream):
    def __init__(self, pause: bool = False) -> None:
        self.pause = pause
        self.closed = False

    async def __aiter__(self):
        yield b"private reasoning sentinel"
        if self.pause:
            await asyncio.sleep(60)
        yield b"private content sentinel"

    async def aclose(self) -> None:
        self.closed = True


def events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_headers_and_first_body_are_durable_before_completion(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))

    async def run():
        trace = ReceiveTrace("hash", 1, 10)
        body = Body()

        async def handler(request):
            return httpx.Response(200, headers={"x-request-id": "rid-1"}, stream=body)

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            event_hooks={"response": [observe_headers]},
        ) as client:

            async def request():
                async with client.stream("GET", "https://example.invalid") as response:
                    assert events(trace.path)[-1]["event"] == "response_headers"
                    chunks = []
                    async for chunk in response.aiter_raw():
                        chunks.append(chunk)
                        assert trace.path.exists()
                    return b"".join(chunks)

            result = await observed_await(request(), trace)
        trace.finish(True, False, "")
        assert result == b"private reasoning sentinelprivate content sentinel"
        assert body.closed
        records = events(trace.path)
        assert records[-1]["received_bytes"] == len(result)
        assert records[-1]["provider_request_id"] == "rid-1"
        assert "sentinel" not in trace.path.read_text()
        assert ACTIVE_TRACE.get() is None

    asyncio.run(run())


def test_partial_body_timeout_keeps_phase_and_closes(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))

    async def run():
        trace = ReceiveTrace("hash", 1, 0.02)
        body = Body(pause=True)

        async def handler(request):
            return httpx.Response(200, stream=body)

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            event_hooks={"response": [observe_headers]},
        ) as client:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(
                    observed_await(client.get("https://example.invalid"), trace), 0.02
                )
        trace.finish(False, False, "application_request_timeout")
        record = events(trace.path)[-1]
        assert record["phase"] == "receiving_body"
        assert record["received_bytes"] > 0
        assert record["idle_seconds"] is not None
        assert body.closed

    asyncio.run(run())


def test_sink_failure_is_nonfatal(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))

    def fail(*args, **kwargs):
        raise OSError("private disk error")

    monkeypatch.setattr(Path, "open", fail)
    trace = ReceiveTrace("hash", 1, 1)
    trace.body_chunk(12)
    trace.finish(False, True, "")
    assert trace.write_failed


def test_progress_is_bounded_and_terminal_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))
    trace = ReceiveTrace("hash", 1, 10)
    for _ in range(1000):
        trace.body_chunk(1)
    trace.finish(True, False, "")
    trace.finish(True, False, "")
    assert len(events(trace.path)) == 3
    assert events(trace.path)[-1]["received_bytes"] == 1000


def test_real_sdk_client_preserves_request_and_response(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))
    seen = []

    async def handler(request):
        seen.append(json.loads(request.content))
        return httpx.Response(
            200,
            headers={"x-request-id": "rid-sdk"},
            json={
                "id": "completion-1",
                "object": "chat.completion",
                "created": 1,
                "model": "test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "OK"},
                    }
                ],
                "usage": {
                    "prompt_tokens": 2,
                    "completion_tokens": 1,
                    "total_tokens": 3,
                },
            },
        )

    monkeypatch.setattr(
        ModelClient,
        "_build_http_client",
        staticmethod(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))),
    )

    async def run():
        client = ModelClient(
            Settings(
                openai_api_key="private-key",
                openai_base_url="https://example.invalid/v1",
                model_provider="openai",
            ),
            max_retries=1,
        )
        try:
            response = await client.chat(
                [Message(role="user", content="private-prompt")],
                config=ModelConfig(model="test", max_tokens=20),
            )
            assert response.content == "OK"
            assert response.usage.total_tokens == 3
            audit = client.consume_call_telemetry()
            assert len(audit) == 1
            assert audit[0]["receive_observation_id"]
            assert audit[0]["success"]
        finally:
            await client.close()

    asyncio.run(run())
    assert len(seen) == 1
    assert seen[0] == {
        "model": "test",
        "messages": [{"role": "user", "content": "private-prompt"}],
        "temperature": 0.0,
        "max_tokens": 20,
        "top_p": 1.0,
    }
    contents = "".join(p.read_text() for p in tmp_path.glob("*.jsonl"))
    assert "private-key" not in contents and "private-prompt" not in contents


def test_timeout_before_headers_and_task_isolation(tmp_path, monkeypatch):
    monkeypatch.setenv("MODEL_REQUEST_LOG_DIR", str(tmp_path))

    async def run():
        left = ReceiveTrace("left", 1, 0.01)
        right = ReceiveTrace("right", 1, 0.01)

        async def blocked():
            assert ACTIVE_TRACE.get() is left
            await asyncio.sleep(60)

        async def quick():
            assert ACTIVE_TRACE.get() is right
            return 42

        slow = asyncio.create_task(observed_await(blocked(), left))
        await asyncio.sleep(0)
        assert await observed_await(quick(), right) == 42
        slow.cancel()
        with pytest.raises(asyncio.CancelledError):
            await slow
        left.finish(False, True, "")
        right.finish(True, False, "")
        assert events(left.path)[-1]["http_status"] is None
        assert events(left.path)[-1]["phase"] == "sdk_entered"
        assert events(right.path)[-1]["phase"] == "sdk_returned"
        assert ACTIVE_TRACE.get() is None

    asyncio.run(run())
