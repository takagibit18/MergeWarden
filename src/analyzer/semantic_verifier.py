"""Independent semantic verification for the slim finding contract.

The integrity guard in :mod:`finding_integrity` answers whether a finding is
well-formed and tied to delivered material.  This module is a separate model
conversation that answers the different question: does the described behavior
follow from the diff, evidence, and relevant rules?  It never receives
reviewer history, confidence, candidate ids, or prior verification outcomes.
"""

from __future__ import annotations

import hashlib
import inspect
import json
from dataclasses import dataclass
from collections.abc import Awaitable, Callable, Mapping, Sequence
from time import monotonic
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from src.analyzer.finding_schema import FindingContentV3, FindingSeverity
from src.models.compat import ModelCallPolicy
from src.models.conversation import ModelConversation
from src.models.request_assembler import RequestAssembler
from src.models.schemas import Message, ModelConfig, ModelResponse

SemanticVerdict = Literal["accept", "reject", "needs_revision", "unresolved"]
SemanticDecisionStatus = Literal["completed", "unresolved"]


class SemanticVerifierCandidate(BaseModel):
    """Model-facing candidate envelope keyed only by an opaque handle."""

    model_config = ConfigDict(extra="forbid")

    opaque_handle: str = Field(..., min_length=1)
    content: FindingContentV3


class SemanticInvestigationRequest(BaseModel):
    """One explicit, bounded read-only action requested by the verifier."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    tool: Literal["read_file", "get_changed_context", "find_symbol_context", "grep_files"]
    file: str = ""
    start_line: int | None = Field(default=None, ge=1)
    end_line: int | None = Field(default=None, ge=1)
    symbol: str = ""
    pattern: str = ""

    @model_validator(mode="after")
    def _bounded_target(self) -> "SemanticInvestigationRequest":
        if self.end_line is not None and self.start_line is not None:
            if self.end_line < self.start_line:
                raise ValueError("investigation end_line must not precede start_line")
        if self.tool in {"read_file", "get_changed_context", "grep_files"} and not self.file:
            raise ValueError(f"{self.tool} investigation requires file")
        if self.tool in {"read_file", "get_changed_context"} and self.start_line is None:
            raise ValueError(f"{self.tool} investigation requires start_line")
        if self.tool == "find_symbol_context" and not self.symbol:
            raise ValueError("find_symbol_context investigation requires symbol")
        if self.tool == "grep_files" and not self.pattern:
            raise ValueError("grep_files investigation requires pattern")
        return self


class SemanticVerifierDecision(BaseModel):
    """One explicit semantic decision returned by the verifier tool."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    opaque_handle: str = Field(..., min_length=1)
    verdict: SemanticVerdict
    reason: str = Field(..., min_length=1)
    request: str = ""
    investigation: SemanticInvestigationRequest | None = None
    severity_correction: FindingSeverity | None = None

    @model_validator(mode="after")
    def _decision_contract(self) -> "SemanticVerifierDecision":
        if self.verdict == "needs_revision" and not self.request.strip():
            raise ValueError("needs_revision requires a concrete request")
        if self.verdict != "needs_revision" and (
            self.request.strip() or self.investigation is not None
        ):
            raise ValueError("request/investigation are only valid for needs_revision")
        return self


class InvestigationResult(BaseModel):
    """Bounded read-only answer supplied to one verifier re-check."""

    model_config = ConfigDict(extra="forbid")

    answer: str = ""
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    tool_call_count: int = Field(default=0, ge=0, le=2)


class SemanticVerifierReceipt(BaseModel):
    """Auditable semantic result bound to one exact content/evidence version."""

    model_config = ConfigDict(extra="forbid")

    opaque_handle: str = Field(..., min_length=1)
    candidate_id: str = ""
    content_version: str = ""
    evidence_context_digest: str = ""
    verdict: SemanticVerdict
    reason: str = ""
    request: str = ""
    severity_correction: FindingSeverity | None = None
    status: SemanticDecisionStatus = "completed"
    input_digest: str = ""
    request_hash: str = ""
    request_estimated_tokens: int = Field(default=0, ge=0)
    response_digest: str = ""
    provider_attempt_count: int = Field(default=0, ge=0)
    model: str = ""
    provider_request_id: str = ""
    verifier_contract_version: str = "3.0"
    policy_version: str = "semantic-v1"
    investigation_calls: int = Field(default=0, ge=0, le=1)
    investigation_tool_calls: int = Field(default=0, ge=0, le=2)
    investigation_evidence_refs: list[str] = Field(default_factory=list)
    error_code: str = ""


class SemanticVerifierBudget(BaseModel):
    """Hard limits for one independent verification stage."""

    batch_size: int = Field(default=8, ge=1, le=64)
    max_model_calls: int = Field(default=2, ge=0, le=8)
    max_investigation_calls: int = Field(default=1, ge=0, le=1)
    max_investigation_tool_calls: int = Field(default=2, ge=0, le=2)
    timeout_seconds: float = Field(default=90.0, gt=0.0, le=600.0)
    token_budget: int | None = Field(default=None, ge=1)
    hard_token_budget: int | None = Field(default=None, ge=1)
    initial_tokens_used: int = Field(default=0, ge=0)
    reserved_tokens: int = Field(default=0, ge=0)
    request_token_budget: int = Field(default=36000, ge=512)

    @model_validator(mode="after")
    def _budget_order(self) -> "SemanticVerifierBudget":
        if (
            self.token_budget is not None
            and self.hard_token_budget is not None
            and self.hard_token_budget < self.token_budget
        ):
            raise ValueError("hard_token_budget must be at least token_budget")
        return self


class SemanticVerifierResult(BaseModel):
    """Complete result of one bounded semantic verification pass."""

    receipts: list[SemanticVerifierReceipt] = Field(default_factory=list)
    model_call_count: int = Field(default=0, ge=0)
    successful_model_call_count: int = Field(default=0, ge=0)
    failed_model_call_count: int = Field(default=0, ge=0)
    provider_attempt_count: int = Field(default=0, ge=0)
    failed_provider_attempt_count: int = Field(default=0, ge=0)
    failed_unknown_usage_count: int = Field(default=0, ge=0)
    prompt_tokens: int = Field(default=0, ge=0)
    completion_tokens: int = Field(default=0, ge=0)
    reasoning_tokens: int = Field(default=0, ge=0)
    total_tokens: int = Field(default=0, ge=0)
    cached_prompt_tokens: int = Field(default=0, ge=0)
    cache_observation_count: int = Field(default=0, ge=0)
    cache_hit_count: int = Field(default=0, ge=0)
    investigation_call_count: int = Field(default=0, ge=0)
    investigation_tool_call_count: int = Field(default=0, ge=0)
    errors: list[str] = Field(default_factory=list)

    @property
    def accepted_count(self) -> int:
        return sum(item.verdict == "accept" for item in self.receipts)

    @property
    def rejected_count(self) -> int:
        return sum(item.verdict == "reject" for item in self.receipts)

    @property
    def needs_revision_count(self) -> int:
        return sum(item.verdict == "needs_revision" for item in self.receipts)

    @property
    def unresolved_count(self) -> int:
        return sum(item.verdict == "unresolved" for item in self.receipts)


ReadonlyInvestigator = Callable[
    [str, SemanticVerifierCandidate, int],
    InvestigationResult
    | Mapping[str, Any]
    | Awaitable[InvestigationResult | Mapping[str, Any]],
]

UsageObserver = Callable[[ModelResponse | None, int, int, int], None]


@dataclass(frozen=True)
class _CallOutcome:
    """One logical verifier call and its provider-attempt accounting."""

    decisions: list[SemanticVerifierDecision]
    response: ModelResponse | None
    error: str
    input_digest: str = ""
    request_hash: str = ""
    request_estimated_tokens: int = 0
    response_digest: str = ""
    provider_attempt_count: int = 0
    failed_provider_attempt_count: int = 0
    failed_unknown_usage_count: int = 0
    invalid_handles: tuple[str, ...] = ()
    sent: bool = False


class SemanticVerifier:
    """Run the independent verifier with fresh conversations and hard bounds."""

    TOOL_NAME = "verify_findings"
    SYSTEM_PROMPT = (
        "You are an independent semantic verifier, not the original reviewer. "
        "Decide whether each slim finding follows from the supplied diff, real "
        "delivered evidence, and relevant rules. Do not use confidence, reviewer "
        "history, candidate identity, or prior verification state. Return exactly "
        "one verify_findings tool call with one decision per opaque_handle. "
        "accept means the described causal conclusion is supported; reject means "
        "the conclusion is wrong or unsupported; needs_revision means a concrete "
        "missing fact could change the conclusion. Give a short reason."
    )
    INVESTIGATION_POLICY = (
        "先判断现有材料是否足够。只有存在一个可能改变结论、现有材料无法回答的具体问题时，"
        "才进行定向调查。明确要确认什么，获得足够信息后立即停止。不要重新审查整个 PR，"
        "不为寻找更多问题或增加证据数量调查，不重复读取已有完整材料。"
    )

    def __init__(
        self,
        model_client: Any | None,
        *,
        budget: SemanticVerifierBudget | None = None,
        model_config: ModelConfig | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._model_client = model_client
        self._budget = budget or SemanticVerifierBudget()
        self._model_config = model_config
        self._clock = clock

    @classmethod
    def tool_schema(cls) -> dict[str, Any]:
        """Return the single bounded verifier tool schema."""

        investigation_action_schema = {
            "oneOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "tool": {"const": "read_file"},
                        "file": {"type": "string", "minLength": 1},
                        "start_line": {"type": "integer", "minimum": 1},
                        "end_line": {"type": ["integer", "null"], "minimum": 1},
                        "symbol": {"type": "string"},
                        "pattern": {"type": "string"},
                    },
                    "required": ["tool", "file", "start_line"],
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "tool": {"const": "get_changed_context"},
                        "file": {"type": "string", "minLength": 1},
                        "start_line": {"type": "integer", "minimum": 1},
                        "end_line": {"type": ["integer", "null"], "minimum": 1},
                        "symbol": {"type": "string"},
                        "pattern": {"type": "string"},
                    },
                    "required": ["tool", "file", "start_line"],
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "tool": {"const": "find_symbol_context"},
                        "file": {"type": "string"},
                        "start_line": {"type": ["integer", "null"], "minimum": 1},
                        "end_line": {"type": ["integer", "null"], "minimum": 1},
                        "symbol": {"type": "string", "minLength": 1},
                        "pattern": {"type": "string"},
                    },
                    "required": ["tool", "symbol"],
                },
                {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "tool": {"const": "grep_files"},
                        "file": {"type": "string", "minLength": 1},
                        "start_line": {"type": ["integer", "null"], "minimum": 1},
                        "end_line": {"type": ["integer", "null"], "minimum": 1},
                        "symbol": {"type": "string"},
                        "pattern": {"type": "string", "minLength": 1},
                    },
                    "required": ["tool", "file", "pattern"],
                },
                {"type": "null"},
            ]
        }
        decision_schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "opaque_handle": {"type": "string", "minLength": 1},
                "verdict": {
                    "type": "string",
                    "enum": ["accept", "reject", "needs_revision"],
                },
                "reason": {"type": "string", "minLength": 1},
                "request": {"type": "string"},
                "investigation": investigation_action_schema,
                "severity_correction": {
                    "type": ["string", "null"],
                    "enum": ["critical", "warning", "info", "style", None],
                },
            },
            "required": ["opaque_handle", "verdict", "reason"],
            "allOf": [
                {
                    "if": {
                        "required": ["verdict"],
                        "properties": {"verdict": {"const": "needs_revision"}},
                    },
                    "then": {
                        "required": ["request"],
                        "properties": {"request": {"minLength": 1}},
                    },
                    "else": {
                        "properties": {
                            "request": {"maxLength": 0},
                            "investigation": {"type": "null"},
                        }
                    },
                }
            ],
        }
        return {
            "type": "function",
            "function": {
                "name": cls.TOOL_NAME,
                "description": (
                    "Independently decide every supplied finding. Do not omit a "
                    "handle; use unresolved only when the material or model call "
                    "cannot produce a reliable decision."
                ),
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "decisions": {
                            "type": "array",
                            "items": decision_schema,
                        }
                    },
                    "required": ["decisions"],
                },
            },
        }

    async def verify(
        self,
        candidates: Sequence[SemanticVerifierCandidate],
        *,
        changed_diff: str = "",
        evidence: Sequence[Mapping[str, Any]] | None = None,
        context: Mapping[str, Any] | None = None,
        content_versions: Mapping[str, str] | None = None,
        evidence_context_digests: Mapping[str, str] | None = None,
        investigator: ReadonlyInvestigator | None = None,
        investigation_evidence_refs: Mapping[str, Sequence[str]] | None = None,
        usage_observer: UsageObserver | None = None,
    ) -> SemanticVerifierResult:
        """Verify all candidates, producing an explicit receipt for each."""

        candidate_list = list(candidates)
        if not candidate_list:
            return SemanticVerifierResult()
        result = SemanticVerifierResult()
        content_versions = content_versions or {}
        evidence_context_digests = evidence_context_digests or {}
        investigation_evidence_refs = investigation_evidence_refs or {}
        started_at = self._clock()
        input_payload = self._input_payload(
            candidate_list,
            changed_diff=changed_diff,
            evidence=evidence or [],
            context=context or {},
        )
        input_digest = _digest(input_payload)

        if self._model_client is None or self._budget.max_model_calls <= 0:
            result.errors.append("semantic_verifier_model_unavailable")
            result.receipts = [
                self._unresolved_receipt(
                    candidate,
                    input_digest=input_digest,
                    content_versions=content_versions,
                    evidence_context_digests=evidence_context_digests,
                    error_code="semantic_verifier_model_unavailable",
                )
                for candidate in candidate_list
            ]
            return result

        pending = list(candidate_list)
        first_decisions: dict[str, SemanticVerifierDecision] = {}
        response_by_handle: dict[str, ModelResponse | None] = {}
        input_digests_by_handle: dict[str, str] = {}
        request_hashes_by_handle: dict[str, str] = {}
        request_tokens_by_handle: dict[str, int] = {}
        response_digests_by_handle: dict[str, str] = {}
        attempt_counts_by_handle: dict[str, int] = {}
        investigated_handles: set[str] = set()
        investigation_tools_by_handle: dict[str, int] = {}
        invalid_handles: set[str] = set()
        forced_unresolved: dict[str, str] = {}
        for batch_index in range(0, len(pending), self._budget.batch_size):
            if result.model_call_count >= self._budget.max_model_calls:
                break
            if not self._can_start_call(started_at, result):
                result.errors.append("semantic_verifier_budget_exhausted")
                break
            batch = pending[batch_index : batch_index + self._budget.batch_size]
            batch_handles = {item.opaque_handle for item in batch}
            batch_payload = self._input_payload(
                batch,
                changed_diff=changed_diff,
                evidence=evidence or [],
                context=context or {},
            )
            outcome = await self._call_model(
                batch_payload,
                started_at=started_at,
                used_tokens=result.total_tokens,
            )
            self._record_call_outcome(result, outcome, usage_observer)
            if not outcome.sent:
                if outcome.error:
                    result.errors.append(outcome.error)
                continue
            if outcome.error:
                result.errors.append(outcome.error)
            if not outcome.decisions and not outcome.invalid_handles:
                continue
            result.successful_model_call_count += 1
            for handle in outcome.invalid_handles:
                if handle in batch_handles:
                    invalid_handles.add(handle)
                    first_decisions.pop(handle, None)
            for decision in outcome.decisions:
                if decision.opaque_handle not in batch_handles:
                    continue
                if decision.opaque_handle in invalid_handles:
                    continue
                first_decisions[decision.opaque_handle] = decision
                response_by_handle[decision.opaque_handle] = outcome.response
                input_digests_by_handle[decision.opaque_handle] = outcome.input_digest
                request_hashes_by_handle[decision.opaque_handle] = outcome.request_hash
                request_tokens_by_handle[decision.opaque_handle] = (
                    outcome.request_estimated_tokens
                )
                response_digests_by_handle[decision.opaque_handle] = (
                    outcome.response_digest
                )
                attempt_counts_by_handle[decision.opaque_handle] = (
                    outcome.provider_attempt_count
                )
            for candidate in batch:
                candidate_decision: SemanticVerifierDecision | None = (
                    first_decisions.get(candidate.opaque_handle)
                )
                if candidate_decision is None:
                    continue
                if (
                    candidate_decision.verdict == "needs_revision"
                    and (
                        candidate_decision.investigation is not None
                        or bool(candidate_decision.request.strip())
                    )
                    and investigator is not None
                    and result.investigation_call_count
                    < self._budget.max_investigation_calls
                    and result.model_call_count < self._budget.max_model_calls
                    and self._can_start_call(started_at, result)
                ):
                    investigation_query = candidate_decision.request.strip()
                    investigation_action: dict[str, Any] = {}
                    if candidate_decision.investigation is not None:
                        investigation_action = candidate_decision.investigation.model_dump(
                            mode="json"
                        )
                        investigation_query = json.dumps(
                            {
                                "question": investigation_query,
                                "action": investigation_action,
                            },
                            ensure_ascii=True,
                            sort_keys=True,
                        )
                    investigation = await self._investigate(
                        investigator, investigation_query, candidate
                    )
                    result.investigation_call_count += 1
                    result.investigation_tool_call_count += (
                        investigation.tool_call_count
                    )
                    investigated_handles.add(candidate.opaque_handle)
                    investigation_tools_by_handle[candidate.opaque_handle] = (
                        investigation.tool_call_count
                    )
                    if investigation.tool_call_count <= 0:
                        forced_unresolved[candidate.opaque_handle] = (
                            "semantic_verifier_investigation_unavailable"
                        )
                        break
                    recheck_payload = self._input_payload(
                        [candidate],
                        changed_diff=changed_diff,
                        evidence=evidence or [],
                        context={
                            **dict(context or {}),
                            "targeted_investigation": investigation.model_dump(
                                mode="json"
                            ),
                            "investigation_action": investigation_action,
                        },
                    )
                    if not self._can_start_call(started_at, result):
                        forced_unresolved[candidate.opaque_handle] = (
                            "semantic_verifier_budget_exhausted_before_recheck"
                        )
                        break
                    recheck = await self._call_model(
                        recheck_payload,
                        started_at=started_at,
                        used_tokens=result.total_tokens,
                    )
                    self._record_call_outcome(result, recheck, usage_observer)
                    if recheck.error:
                        result.errors.append(recheck.error)
                        forced_unresolved[candidate.opaque_handle] = recheck.error
                    elif candidate.opaque_handle in recheck.invalid_handles:
                        forced_unresolved[candidate.opaque_handle] = (
                            "semantic_verifier_recheck_handle_invalid"
                        )
                    else:
                        rechecked = [
                            item
                            for item in recheck.decisions
                            if item.opaque_handle == candidate.opaque_handle
                        ]
                        if len(rechecked) != 1:
                            forced_unresolved[candidate.opaque_handle] = (
                                "semantic_verifier_recheck_verdict_missing"
                            )
                        else:
                            first_decisions[candidate.opaque_handle] = rechecked[0]
                            response_by_handle[candidate.opaque_handle] = (
                                recheck.response
                            )
                            input_digests_by_handle[candidate.opaque_handle] = (
                                recheck.input_digest
                            )
                            request_hashes_by_handle[candidate.opaque_handle] = (
                                recheck.request_hash
                            )
                            request_tokens_by_handle[candidate.opaque_handle] = (
                                recheck.request_estimated_tokens
                            )
                            response_digests_by_handle[candidate.opaque_handle] = (
                                recheck.response_digest
                            )
                            attempt_counts_by_handle[candidate.opaque_handle] = (
                                recheck.provider_attempt_count
                            )
                    # A concrete investigation is one bounded round.  Do not
                    # turn a second needs_revision into an exploration loop.
                    break

        for candidate in candidate_list:
            if candidate.opaque_handle in forced_unresolved:
                receipt = self._unresolved_receipt(
                    candidate,
                    input_digest=input_digests_by_handle.get(
                        candidate.opaque_handle, input_digest
                    ),
                    content_versions=content_versions,
                    evidence_context_digests=evidence_context_digests,
                    error_code=forced_unresolved[candidate.opaque_handle],
                    request_hash=request_hashes_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    request_estimated_tokens=request_tokens_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                    response_digest=response_digests_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    provider_attempt_count=attempt_counts_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                )
                result.receipts.append(receipt)
                continue
            final_decision: SemanticVerifierDecision | None = first_decisions.get(
                candidate.opaque_handle
            )
            if final_decision is None:
                receipt = self._unresolved_receipt(
                    candidate,
                    input_digest=input_digests_by_handle.get(
                        candidate.opaque_handle, input_digest
                    ),
                    content_versions=content_versions,
                    evidence_context_digests=evidence_context_digests,
                    error_code=(
                        "semantic_verifier_missing_verdict"
                        if not result.errors
                        else result.errors[-1]
                    ),
                    request_hash=request_hashes_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    request_estimated_tokens=request_tokens_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                    response_digest=response_digests_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    provider_attempt_count=attempt_counts_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                )
            else:
                verdict = final_decision.verdict
                request = final_decision.request
                if (
                    final_decision.severity_correction is not None
                    and verdict == "accept"
                ):
                    # A severity change changes the candidate content version;
                    # accepting the old version would make the correction a
                    # silent publication bypass.  Force a bounded revision.
                    verdict = "needs_revision"
                    request = (
                        request
                        or "Apply the verifier severity correction and re-submit this finding."
                    )
                receipt = SemanticVerifierReceipt(
                    opaque_handle=candidate.opaque_handle,
                    content_version=content_versions.get(candidate.opaque_handle, ""),
                    evidence_context_digest=evidence_context_digests.get(
                        candidate.opaque_handle, ""
                    ),
                    verdict=verdict,
                    reason=final_decision.reason,
                    request=request,
                    severity_correction=final_decision.severity_correction,
                    input_digest=input_digests_by_handle.get(
                        candidate.opaque_handle, input_digest
                    ),
                    request_hash=request_hashes_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    request_estimated_tokens=request_tokens_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                    response_digest=response_digests_by_handle.get(
                        candidate.opaque_handle, ""
                    ),
                    provider_attempt_count=attempt_counts_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                    model=str(
                        getattr(
                            response_by_handle.get(candidate.opaque_handle),
                            "model",
                            "",
                        )
                        or ""
                    ),
                    provider_request_id=str(
                        getattr(
                            response_by_handle.get(candidate.opaque_handle),
                            "provider_request_id",
                            "",
                        )
                        or ""
                    ),
                    investigation_calls=int(
                        candidate.opaque_handle in investigated_handles
                    ),
                    investigation_tool_calls=investigation_tools_by_handle.get(
                        candidate.opaque_handle, 0
                    ),
                    investigation_evidence_refs=[
                        str(item).strip()
                        for item in investigation_evidence_refs.get(
                            candidate.opaque_handle, ()
                        )
                        if str(item).strip()
                    ],
                )
            result.receipts.append(receipt)
        return result

    @staticmethod
    def _record_usage(
        result: SemanticVerifierResult,
        response: ModelResponse | None,
    ) -> None:
        """Copy provider usage into the verifier result for shared accounting."""

        if response is None:
            return
        if not response.usage_present:
            return
        result.prompt_tokens += max(0, int(response.usage.prompt_tokens))
        result.completion_tokens += max(0, int(response.usage.completion_tokens))
        result.reasoning_tokens += max(0, int(response.usage.reasoning_tokens))
        result.total_tokens += max(0, int(response.usage.total_tokens))
        cached = response.usage.cached_prompt_tokens
        if cached is not None:
            result.cache_observation_count += 1
            result.cached_prompt_tokens += max(0, int(cached))
            result.cache_hit_count += int(cached > 0)

    def _record_call_outcome(
        self,
        result: SemanticVerifierResult,
        outcome: _CallOutcome,
        usage_observer: UsageObserver | None,
    ) -> None:
        """Account one call immediately, including failed provider attempts."""

        if outcome.sent:
            result.model_call_count += 1
            self._record_usage(result, outcome.response)
            result.provider_attempt_count += outcome.provider_attempt_count
            result.failed_provider_attempt_count += outcome.failed_provider_attempt_count
            result.failed_unknown_usage_count += outcome.failed_unknown_usage_count
            if outcome.error:
                result.failed_model_call_count += 1
            if usage_observer is not None:
                usage_observer(
                    outcome.response,
                    outcome.provider_attempt_count,
                    outcome.failed_provider_attempt_count,
                    outcome.failed_unknown_usage_count,
                )

    def _can_start_call(
        self,
        started_at: float,
        result: SemanticVerifierResult,
    ) -> bool:
        """Check shared token and wall-clock limits before each provider call."""

        if self._clock() - started_at >= self._budget.timeout_seconds:
            return False
        if self._budget.hard_token_budget is None:
            return True
        remaining = (
            self._budget.hard_token_budget
            - self._budget.initial_tokens_used
            - result.total_tokens
            - self._budget.reserved_tokens
        )
        return remaining > 0

    async def _call_model(
        self,
        payload: dict[str, Any],
        *,
        started_at: float,
        used_tokens: int,
    ) -> _CallOutcome:
        """Call one fresh verifier conversation and parse only the tool output."""

        messages = [
            Message(
                role="system",
                content=self.SYSTEM_PROMPT + "\n" + self.INVESTIGATION_POLICY,
            ),
            Message(
                role="user",
                content=(
                    "Verify the following supplied material. It is complete for this call; "
                    "do not request broad exploration.\n"
                    + json.dumps(payload, ensure_ascii=True)
                ),
            ),
        ]
        config = self._model_config
        if config is None:
            default_config = getattr(self._model_client, "default_config", None)
            if isinstance(default_config, ModelConfig):
                config = default_config.model_copy(
                    update={
                        "max_tokens": min(default_config.max_tokens, 2048),
                    }
                )
            else:
                config = ModelConfig(
                    model="semantic-verifier",
                    max_tokens=2048,
                )
        remaining_seconds = max(
            0.001, self._budget.timeout_seconds - (self._clock() - started_at)
        )
        remaining_tokens = self._remaining_output_tokens(used_tokens)
        if remaining_tokens <= 0:
            return _CallOutcome(
                decisions=[],
                response=None,
                error="semantic_verifier_budget_exhausted",
            )
        config = config.model_copy(
            update={
                "max_tokens": min(config.max_tokens, remaining_tokens),
                "timeout": min(config.timeout, remaining_seconds),
            }
        )
        policy = ModelCallPolicy(thinking="off", forced_tool=self.TOOL_NAME)
        tools = [self.tool_schema()]
        wire_config = config
        wire_policy = policy
        profile = None
        prepare_call = getattr(self._model_client, "prepare_call", None)
        if callable(prepare_call):
            try:
                wire_config, wire_policy, profile = prepare_call(config, policy)
            except Exception as exc:  # noqa: BLE001
                return _CallOutcome(
                    decisions=[],
                    response=None,
                    error=_error_code(exc),
                )
        assembled = RequestAssembler.fit(
            messages,
            tools,
            wire_config,
            wire_policy,
            budget=self._budget.request_token_budget,
            profile=profile,
        )
        input_digest = _digest({"serialized_payload": assembled.serialized_payload})
        if assembled.estimated_tokens > self._budget.request_token_budget:
            return _CallOutcome(
                decisions=[],
                response=None,
                error="semantic_verifier_request_over_budget",
                input_digest=input_digest,
                request_hash=assembled.request_hash,
                request_estimated_tokens=assembled.estimated_tokens,
            )
        model_client = self._model_client
        if model_client is None:
            return _CallOutcome(
                decisions=[],
                response=None,
                error="semantic_verifier_model_unavailable",
                input_digest=input_digest,
                request_hash=assembled.request_hash,
                request_estimated_tokens=assembled.estimated_tokens,
            )
        attempts: list[dict[str, Any]] = []
        try:
            response = await model_client.chat(
                assembled.messages,
                config=wire_config,
                tools=tools,
                policy=wire_policy,
                conversation=ModelConversation(),
            )
        except Exception as exc:  # noqa: BLE001
            attempts = self._consume_attempts(model_client)
            attempt_count, failed_count, unknown_count = self._attempt_counts(
                attempts, response=None
            )
            return _CallOutcome(
                decisions=[],
                response=None,
                error=_error_code(exc),
                input_digest=input_digest,
                request_hash=assembled.request_hash,
                request_estimated_tokens=assembled.estimated_tokens,
                provider_attempt_count=attempt_count,
                failed_provider_attempt_count=failed_count,
                failed_unknown_usage_count=unknown_count,
                sent=True,
            )
        attempts = self._consume_attempts(model_client)
        attempt_count, failed_count, unknown_count = self._attempt_counts(
            attempts, response=response
        )
        response_digest = _digest(
            {
                "content": response.content,
                "tool_calls": response.tool_calls,
                "finish_reason": response.finish_reason,
            }
        )
        verify_calls = [
            call
            for call in getattr(response, "tool_calls", []) or []
            if isinstance(call, dict)
            and str(call.get("function", {}).get("name", "")).strip()
            == self.TOOL_NAME
        ]
        if len(verify_calls) != 1:
            return _CallOutcome(
                decisions=[],
                response=response,
                error=(
                    "semantic_verifier_missing_tool_call"
                    if not verify_calls
                    else "semantic_verifier_multiple_tool_calls"
                ),
                input_digest=input_digest,
                request_hash=assembled.request_hash,
                request_estimated_tokens=assembled.estimated_tokens,
                response_digest=response_digest,
                provider_attempt_count=attempt_count,
                failed_provider_attempt_count=failed_count,
                failed_unknown_usage_count=unknown_count,
                sent=True,
            )
        function = verify_calls[0].get("function", {})
        raw_arguments = function.get("arguments", "")
        if isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError:
                return _CallOutcome(
                    decisions=[],
                    response=response,
                    error="semantic_verifier_malformed_verdict",
                    input_digest=input_digest,
                    request_hash=assembled.request_hash,
                    request_estimated_tokens=assembled.estimated_tokens,
                    response_digest=response_digest,
                    provider_attempt_count=attempt_count,
                    failed_provider_attempt_count=failed_count,
                    failed_unknown_usage_count=unknown_count,
                    sent=True,
                )
        else:
            arguments = raw_arguments
        if not isinstance(arguments, dict) or not isinstance(
            arguments.get("decisions"), list
        ):
            return _CallOutcome(
                decisions=[],
                response=response,
                error="semantic_verifier_malformed_verdict",
                input_digest=input_digest,
                request_hash=assembled.request_hash,
                request_estimated_tokens=assembled.estimated_tokens,
                response_digest=response_digest,
                provider_attempt_count=attempt_count,
                failed_provider_attempt_count=failed_count,
                failed_unknown_usage_count=unknown_count,
                sent=True,
            )
        expected_handles = {
            str(item.get("opaque_handle", "")).strip()
            for item in payload.get("findings", [])
            if isinstance(item, dict)
        }
        decisions: list[SemanticVerifierDecision] = []
        invalid_handles: set[str] = set()
        seen_handles: set[str] = set()
        parse_errors: list[str] = []
        for raw in arguments["decisions"]:
            raw_handle = str(raw.get("opaque_handle", "")).strip() if isinstance(raw, dict) else ""
            try:
                decision = SemanticVerifierDecision.model_validate(raw)
            except ValidationError:
                if raw_handle in expected_handles:
                    invalid_handles.add(raw_handle)
                parse_errors.append(
                    "semantic_verifier_malformed_decision"
                    + (f":{raw_handle}" if raw_handle else "")
                )
                continue
            if decision.opaque_handle not in expected_handles:
                parse_errors.append("semantic_verifier_unknown_handle")
                continue
            if decision.opaque_handle in seen_handles:
                invalid_handles.add(decision.opaque_handle)
                decisions = [
                    item
                    for item in decisions
                    if item.opaque_handle != decision.opaque_handle
                ]
                parse_errors.append("semantic_verifier_duplicate_handle")
                continue
            seen_handles.add(decision.opaque_handle)
            decisions.append(decision)
        return _CallOutcome(
            decisions=decisions,
            response=response,
            error=parse_errors[0] if parse_errors else "",
            input_digest=input_digest,
            request_hash=assembled.request_hash,
            request_estimated_tokens=assembled.estimated_tokens,
            response_digest=response_digest,
            provider_attempt_count=attempt_count,
            failed_provider_attempt_count=failed_count,
            failed_unknown_usage_count=unknown_count,
            invalid_handles=tuple(sorted(invalid_handles)),
            sent=True,
        )

    def _remaining_output_tokens(self, used_tokens: int) -> int:
        """Return the hard-cap output allowance for the next provider request."""

        if self._budget.hard_token_budget is None:
            return 2048
        return max(
            0,
            self._budget.hard_token_budget
            - self._budget.initial_tokens_used
            - used_tokens
            - self._budget.reserved_tokens,
        )

    @staticmethod
    def _consume_attempts(model_client: Any) -> list[dict[str, Any]]:
        """Read provider attempt telemetry without requiring it from test clients."""

        consumer = getattr(model_client, "consume_call_telemetry", None)
        if not callable(consumer):
            return []
        try:
            attempts = consumer()
        except Exception:  # noqa: BLE001
            return []
        return [item for item in attempts if isinstance(item, dict)]

    @staticmethod
    def _attempt_counts(
        attempts: list[dict[str, Any]],
        *,
        response: ModelResponse | None,
    ) -> tuple[int, int, int]:
        """Separate provider attempts, failed attempts, and unknown usage."""

        if not attempts:
            return (
                1,
                int(response is None),
                int(response is None or not response.usage_present),
            )
        failed = sum(not bool(item.get("success", False)) for item in attempts)
        unknown = sum(
            bool(item.get("usage_unknown", False))
            or not bool(item.get("usage_present", False))
            for item in attempts
        )
        return len(attempts), failed, unknown

    async def _investigate(
        self,
        investigator: ReadonlyInvestigator,
        question: str,
        candidate: SemanticVerifierCandidate,
    ) -> InvestigationResult:
        try:
            value = investigator(
                question,
                candidate,
                self._budget.max_investigation_tool_calls,
            )
            if inspect.isawaitable(value):
                value = await value
            return InvestigationResult.model_validate(value)
        except Exception:  # noqa: BLE001
            return InvestigationResult(
                answer="",
                evidence=[],
                tool_call_count=self._budget.max_investigation_tool_calls,
            )

    @staticmethod
    def _input_payload(
        candidates: Sequence[SemanticVerifierCandidate],
        *,
        changed_diff: str,
        evidence: Sequence[Mapping[str, Any]],
        context: Mapping[str, Any],
    ) -> dict[str, Any]:
        return {
            "changed_diff": changed_diff,
            "evidence": [dict(item) for item in evidence],
            "context": dict(context),
            "findings": [
                {
                    "opaque_handle": candidate.opaque_handle,
                    "content": candidate.content.model_dump(mode="json"),
                }
                for candidate in candidates
            ],
        }

    @staticmethod
    def _unresolved_receipt(
        candidate: SemanticVerifierCandidate,
        *,
        input_digest: str,
        content_versions: Mapping[str, str],
        evidence_context_digests: Mapping[str, str],
        error_code: str,
        request_hash: str = "",
        request_estimated_tokens: int = 0,
        response_digest: str = "",
        provider_attempt_count: int = 0,
    ) -> SemanticVerifierReceipt:
        return SemanticVerifierReceipt(
            opaque_handle=candidate.opaque_handle,
            content_version=content_versions.get(candidate.opaque_handle, ""),
            evidence_context_digest=evidence_context_digests.get(
                candidate.opaque_handle, ""
            ),
            verdict="unresolved",
            status="unresolved",
            input_digest=input_digest,
            request_hash=request_hash,
            request_estimated_tokens=request_estimated_tokens,
            response_digest=response_digest,
            provider_attempt_count=provider_attempt_count,
            error_code=error_code,
        )


def _digest(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=True, sort_keys=True, default=str).encode(
            "utf-8"
        )
    ).hexdigest()[:24]


def _error_code(exc: Exception) -> str:
    name = exc.__class__.__name__.lower()
    if "timeout" in name:
        return "semantic_verifier_timeout"
    return "semantic_verifier_model_error"
