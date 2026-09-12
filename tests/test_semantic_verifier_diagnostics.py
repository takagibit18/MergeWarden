"""Safe request/response diagnostics for malformed verifier decisions."""

from __future__ import annotations

import asyncio
import json

from src.analyzer.finding_schema import FindingContentV3, SourceAnchor
from src.analyzer.semantic_verifier import (
    SemanticVerifier,
    SemanticVerifierBudget,
    SemanticVerifierCandidate,
)
from src.models.schemas import ModelConfig, ModelResponse, TokenUsage


class _MalformedVerifierClient:
    default_config = ModelConfig(model="offline-malformed")

    async def chat(self, *args: object, **kwargs: object) -> ModelResponse:
        del args, kwargs
        return ModelResponse(
            model="offline-malformed",
            provider_request_id="provider-malformed-1",
            usage=TokenUsage(total_tokens=7),
            tool_calls=[
                {
                    "function": {
                        "name": "verify_findings",
                        "arguments": json.dumps(
                            {
                                "decisions": [
                                    {
                                        "opaque_handle": "h-malformed",
                                        "verdict": "accept",
                                        # The runtime requires a non-empty reason.
                                    }
                                ]
                            }
                        ),
                    }
                }
            ],
        )


def _candidate() -> SemanticVerifierCandidate:
    return SemanticVerifierCandidate(
        opaque_handle="h-malformed",
        content=FindingContentV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description="The changed return value violates the caller contract.",
            evidence_refs=["ev-v3"],
            severity="warning",
        ),
    )


def test_malformed_decision_keeps_safe_request_response_diagnostics() -> None:
    verifier = SemanticVerifier(
        _MalformedVerifierClient(),
        budget=SemanticVerifierBudget(hard_token_budget=10_000),
    )
    result = asyncio.run(
        verifier.verify(
            [_candidate()],
            content_versions={"h-malformed": "content-v1"},
            evidence_context_digests={"h-malformed": "evidence-v1"},
        )
    )

    receipt = result.receipts[0]
    assert receipt.verdict == "unresolved"
    assert receipt.error_code == "semantic_verifier_malformed_decision:h-malformed:reason=missing"
    assert receipt.input_digest
    assert receipt.request_hash
    assert receipt.response_digest
    assert receipt.provider_request_id == "provider-malformed-1"
    assert receipt.provider_attempt_count == 1
    assert receipt.budget_tokens_used >= receipt.request_estimated_tokens
    assert receipt.budget_remaining_tokens == max(0, 10_000 - receipt.budget_tokens_used)
