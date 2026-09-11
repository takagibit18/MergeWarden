"""Keep DashScope K3 controls consistent across request and budget assembly."""

import json

import pytest

from src.config import Settings
from src.models.client import ModelClient
from src.models.compat import ModelCallPolicy, resolve_model_profile
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig


@pytest.mark.parametrize("thinking", ["off", "high"])
def test_k3_fixed_wire_controls(thinking: str) -> None:
    settings = Settings(model_provider="dashscope")
    profile = resolve_model_profile(settings, "kimi-k3")
    config = ModelConfig(model="kimi-k3", temperature=0, top_p=1)
    policy = ModelCallPolicy.model_validate(
        {"thinking": thinking, "forced_tool": "verify_findings"}
    )
    adjusted, effective = ModelClient._apply_policy(config, policy, profile)
    messages = [Message(role="user", content="Review")]
    wire = RequestAssembler.wire_payload(
        messages, [], adjusted, effective, profile=profile
    )
    assert wire["temperature"] == 1.0
    assert wire["top_p"] == 0.95
    assert wire["max_completion_tokens"] == config.max_tokens
    assert "max_tokens" not in wire
    assert wire["extra_body"]["enable_thinking"] is True
    assert wire["tool_choice"]["function"]["name"] == "verify_findings"
    assert config.temperature == 0 and config.top_p == 1
    assert (
        json.loads(
            RequestAssembler.serialized(
                messages, [], adjusted, effective, profile=profile
            )
        )
        == wire
    )
    assert profile.compat.requires_reasoning_replay_for_tool_calls


@pytest.mark.parametrize(
    "provider,model",
    [("dashscope", "qwen-plus"), ("zhipu", "glm-5.3-flash"), ("openai", "kimi-k3")],
)
def test_other_profiles_keep_sampling(provider: str, model: str) -> None:
    profile = resolve_model_profile(Settings(model_provider=provider), model)
    wire = RequestAssembler.wire_payload(
        [], [], ModelConfig(model=model), ModelCallPolicy(), profile=profile
    )
    assert wire["temperature"] == 0.0
    assert wire["top_p"] == 1.0
    assert wire["max_tokens"] == 2048
    assert "max_completion_tokens" not in wire
