"""Bounded, deterministic assembly of provider request payloads.

Prompt component budgets are useful diagnostics, but providers receive one
assembled request.  This module applies the final cap to that assembled
request and returns only safe size/hash metadata for telemetry.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from src.models.compat import ModelCallPolicy, ModelProfile
from src.models.schemas import Message, ModelConfig
from src.models.token_telemetry import component_hash, estimate_tokens, serialize_json


@dataclass(frozen=True)
class AssembledRequest:
    """A request payload plus bounded-size metadata."""

    messages: list[Message]
    estimated_tokens: int
    request_hash: str
    serialized_payload: str = ""
    trimmed: bool = False
    dropped_message_count: int = 0


class RequestAssembler:
    """Assemble and fit one provider request under a shared input budget."""

    @staticmethod
    def wire_payload(
        messages: list[Message],
        tools: list[dict[str, Any]],
        config: ModelConfig,
        policy: ModelCallPolicy,
        *,
        profile: ModelProfile | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": config.model,
            "messages": RequestAssembler._wire_messages(messages, profile),
            "temperature": config.temperature,
            (
                profile.compat.output_limit_parameter if profile else "max_tokens"
            ): config.max_tokens,
            "top_p": config.top_p,
        }
        if tools:
            payload["tools"] = tools
        if config.tool_choice is not None:
            payload["tool_choice"] = config.tool_choice
        if config.extra_body is not None:
            payload["extra_body"] = config.extra_body
        if profile is not None:
            compat = profile.compat
            if compat.fixed_temperature is not None:
                payload["temperature"] = compat.fixed_temperature
            if compat.fixed_top_p is not None:
                payload["top_p"] = compat.fixed_top_p
            if (
                compat.thinking_format == "dashscope"
                and not compat.supports_thinking_disable
            ):
                payload["extra_body"] = {
                    **(config.extra_body or {}),
                    "enable_thinking": True,
                }
        if profile is not None and profile.compat.supports_reasoning_effort:
            if policy.thinking == "high":
                payload["reasoning_effort"] = (
                    "low"
                    if (
                        profile.compat.thinking_format == "zhipu"
                        and not profile.compat.supports_thinking_disable
                    )
                    else "high"
                )
            elif (
                policy.thinking == "off"
                and profile.compat.thinking_format == "zhipu"
                and not profile.compat.supports_thinking_disable
            ):
                # GLM-5.3/Flash keeps thinking enabled and accepts ``low`` as
                # its lowest reasoning-effort setting.
                payload["reasoning_effort"] = "low"
        return payload

    @classmethod
    def serialized(
        cls,
        messages: list[Message],
        tools: list[dict[str, Any]],
        config: ModelConfig,
        policy: ModelCallPolicy,
        *,
        profile: ModelProfile | None = None,
    ) -> str:
        return serialize_json(
            cls.wire_payload(
                messages,
                tools,
                config,
                policy,
                profile=profile,
            )
        )

    @classmethod
    def estimate(
        cls,
        messages: list[Message],
        tools: list[dict[str, Any]],
        config: ModelConfig,
        policy: ModelCallPolicy,
        *,
        profile: ModelProfile | None = None,
    ) -> int:
        return estimate_tokens(
            cls.serialized(
                messages,
                tools,
                config,
                policy,
                profile=profile,
            )
        )

    @classmethod
    def fit(
        cls,
        messages: list[Message],
        tools: list[dict[str, Any]],
        config: ModelConfig,
        policy: ModelCallPolicy,
        *,
        budget: int,
        profile: ModelProfile | None = None,
    ) -> AssembledRequest:
        """Fit a request while retaining system, payload, and final notices.

        Conversation assistant/tool turns are the first removable material.
        If the cap is still exceeded, only long user context is shortened; the
        caller receives ``trimmed=True`` and can record an incomplete handoff.
        """

        selected = list(messages)
        original_count = len(selected)
        trimmed = False
        budget = max(1, int(budget))

        def estimate_request(items: list[Message]) -> int:
            return cls.estimate(
                items,
                tools,
                config,
                policy,
                profile=profile,
            )

        if estimate_request(selected) > budget:
            removable_groups = cls._trim_groups(selected)
            for group in reversed(removable_groups):
                if estimate_request(selected) <= budget:
                    break
                for index in reversed(group):
                    selected.pop(index)
                trimmed = True

        if estimate_request(selected) > budget:
            # Shorten the largest context message repeatedly.  The earlier
            # implementation visited each message only once, so one large
            # message could still leave the assembled request over the cap.
            # The marker is never treated as source evidence by the ledger.
            while estimate_request(selected) > budget:
                candidates = [
                    index
                    for index, item in enumerate(selected)
                    if (
                        item.role != "system"
                        and item.content
                        and not item.preserve_on_trim
                    )
                ]
                if not candidates:
                    break
                index = max(candidates, key=lambda item: len(selected[item].content))
                content = selected[index].content
                current = estimate_request(selected)
                excess = max(1, current - budget)
                marker = "\n[request context shortened; retrieve missing evidence]"
                # Token estimates are intentionally conservative; use binary
                # search to choose the longest prefix that fits the remaining
                # envelope, then repeat if another message still dominates.
                low = 0
                high = max(0, len(content) - len(marker))
                while low < high:
                    middle = (low + high + 1) // 2
                    candidate = content[:middle].rstrip() + marker
                    selected[index] = selected[index].model_copy(
                        update={"content": candidate}
                    )
                    if estimate_request(selected) <= budget:
                        low = middle
                    else:
                        high = middle - 1
                if low > 0:
                    selected[index] = selected[index].model_copy(
                        update={
                            "content": content[:low].rstrip() + marker,
                        }
                    )
                else:
                    # Remove the body if even the marker cannot fit.  This is
                    # still explicit in the request and avoids claiming that a
                    # hard cap was met while silently exceeding it.
                    selected[index] = selected[index].model_copy(update={"content": ""})
                trimmed = True
                if len(selected[index].content) >= len(content) and excess <= 1:
                    break

        serialized = cls.serialized(
            selected,
            tools,
            config,
            policy,
            profile=profile,
        )
        return AssembledRequest(
            messages=selected,
            estimated_tokens=estimate_tokens(serialized),
            request_hash=component_hash(serialized),
            serialized_payload=serialized,
            trimmed=trimmed,
            dropped_message_count=max(0, original_count - len(selected)),
        )

    @staticmethod
    def _trim_groups(messages: list[Message]) -> list[list[int]]:
        """Return removable assistant/tool units without creating orphans."""

        groups: list[list[int]] = []
        index = 0
        while index < len(messages):
            message = messages[index]
            end = index + 1
            if message.role == "assistant" and message.tool_calls:
                while end < len(messages) and messages[end].role == "tool":
                    end += 1
            group = list(range(index, end))
            if any(
                messages[item].role in {"assistant", "tool"} for item in group
            ) and all(not messages[item].preserve_on_trim for item in group):
                groups.append(group)
            index = end
        return groups

    @staticmethod
    def _wire_messages(
        messages: list[Message], profile: ModelProfile | None
    ) -> list[dict[str, Any]]:
        return [
            RequestAssembler._wire_message(message, profile) for message in messages
        ]

    @staticmethod
    def _wire_message(
        message: Message, profile: ModelProfile | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"role": message.role, "content": message.content}
        if message.tool_call_id is not None:
            payload["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            payload["tool_calls"] = message.tool_calls
        if (
            message.thinking is not None
            and profile is not None
            and profile.compat.requires_reasoning_replay_for_tool_calls
        ):
            payload["reasoning_content"] = message.thinking
        return payload
