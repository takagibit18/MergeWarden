"""Metadata-only HTTP receive observations; never inspect response bodies."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable
from uuid import uuid4

import httpx

ACTIVE_TRACE: ContextVar[ReceiveTrace | None] = ContextVar(
    "model_receive_trace", default=None
)
_LOG = logging.getLogger(__name__)


class ReceiveTrace:
    """One attempt, one append-only file, no prompt/body/header dumps."""

    def __init__(
        self,
        request_hash: str,
        attempt: int,
        timeout: float,
        *,
        model: str = "",
        provider: str = "",
        input_estimate: int = 0,
        output_limit: int = 0,
    ) -> None:
        self.id = uuid4().hex
        self.path = (
            Path(os.getenv("MODEL_REQUEST_LOG_DIR", ".mergewarden/model_requests"))
            / f"{self.id}.jsonl"
        )
        self.started = time.monotonic()
        self.last_write = self.started
        self.last_byte: float | None = None
        self.first_byte: float | None = None
        self.bytes = 0
        self.chunks = 0
        self.phase = "sdk_entered"
        self.status: int | None = None
        self.request_id = ""
        self.write_failed = False
        self.finished = False
        self.request_hash = request_hash
        self.attempt = attempt
        self.timeout = timeout
        self.model = model
        self.provider = provider
        self.input_estimate = input_estimate
        self.output_limit = output_limit
        self.emit("attempt_started")

    def emit(self, event: str, **extra: Any) -> None:
        now = time.monotonic()
        record = {
            "schema_version": "model-receive-v1",
            "timestamp": datetime.now(UTC).isoformat(),
            "observation_id": self.id,
            "event": event,
            "phase": self.phase,
            "request_hash": self.request_hash,
            "provider_attempt": self.attempt,
            "model": self.model,
            "provider": self.provider,
            "estimated_input_tokens": self.input_estimate,
            "max_output_tokens": self.output_limit,
            "timeout_seconds": self.timeout,
            "elapsed_seconds": now - self.started,
            "http_status": self.status,
            "provider_request_id": self.request_id,
            "received_bytes": self.bytes,
            "received_chunks": self.chunks,
            "first_body_seconds": None
            if self.first_byte is None
            else self.first_byte - self.started,
            "idle_seconds": None if self.last_byte is None else now - self.last_byte,
            **extra,
        }
        if self.write_failed:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record) + "\n")
                stream.flush()
            self.last_write = now
        except Exception:  # noqa: BLE001 -- observations must not alter provider behavior
            self.write_failed = True
            _LOG.warning("Model receive observation unavailable: %s", self.id)

    def body_chunk(self, size: int) -> None:
        if not size:
            return
        now = time.monotonic()
        self.phase = "receiving_body"
        self.bytes += size
        self.chunks += 1
        self.last_byte = now
        first = self.first_byte is None
        if first:
            self.first_byte = now
        if first or now - self.last_write >= 5:
            self.emit("first_body" if first else "body_progress")

    def finish(self, success: bool, cancelled: bool, code: str) -> None:
        if self.finished:
            return
        self.finished = True
        self.emit(
            "attempt_finished", success=success, cancelled=cancelled, error_code=code
        )


class ObservedStream(httpx.AsyncByteStream):
    """Forward every original byte and close operation without buffering."""

    def __init__(self, source: httpx.AsyncByteStream, trace: ReceiveTrace) -> None:
        self.source = source
        self.trace = trace

    async def __aiter__(self) -> AsyncIterator[bytes]:
        async for chunk in self.source:
            self.trace.body_chunk(len(chunk))
            yield chunk
        self.trace.phase = "body_received"
        self.trace.emit("body_received")

    async def aclose(self) -> None:
        await self.source.aclose()


async def observe_headers(response: httpx.Response) -> None:
    """Observe before SDK reads the body; do not consume it in this hook."""
    trace = ACTIVE_TRACE.get()
    if trace is None:
        return
    trace.phase = "response_headers"
    trace.status = response.status_code
    request_id = response.headers.get(
        "x-request-id", response.headers.get("request-id", "")
    )
    trace.request_id = (
        request_id if re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id) else ""
    )
    trace.emit("response_headers")
    response.stream = ObservedStream(response.stream, trace)  # type: ignore[arg-type]


async def observed_await(request: Awaitable[Any], trace: ReceiveTrace) -> Any:
    """Scope transport hooks to the task created by the existing wait_for."""
    token = ACTIVE_TRACE.set(trace)
    try:
        result = await request
        trace.phase = "sdk_returned"
        trace.emit("sdk_returned")
        return result
    finally:
        ACTIVE_TRACE.reset(token)
