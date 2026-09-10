"""LLM inference engine — model reasoning and plan formulation."""

from __future__ import annotations

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any, Callable

from pydantic import ValidationError

from src.analyzer.context_builder import ContextBuilder
from src.analyzer.context_state import ContextState
from src.analyzer.evidence_ledger import ledger_from_sources
from src.analyzer.event_log import EventType
from src.analyzer.finding_contract import (
    is_model_finding_v3_payload,
    is_model_repair_payload,
    issue_supports,
    ModelFinishReviewActionV3,
    ModelFindingInputV3,
    ModelRepairResponse,
    ModelRepairResponseV3,
    ModelReviseFindingActionV3,
    ModelSaveFindingActionV3,
    normalize_model_finding_payload,
    validate_model_repair_payload,
    validate_model_repair_target_payload,
    validate_model_repair_target_v3_payload,
)
from src.analyzer.diff_lines import ParsedDiffHunk, parse_unified_diff_hunks
from src.analyzer.finding_schema import normalize_repo_path
from src.analyzer.location import normalize_location
from src.analyzer.output_formatter import ReviewReport
from src.analyzer.review_skills import SkillSelection
from src.analyzer.prompts import (
    FINALIZE_REVIEW_NOTICE,
    FINALIZE_REVIEW_NOTICE_V3,
    FINALIZE_DEBUG_NOTICE,
    REPAIR_REVIEW_NOTICE,
    USER_PREFIX_REVIEW,
    USER_PREFIX_REVIEW_V3,
    build_debug_messages,
    build_debug_messages_async,
    build_review_messages,
    build_review_messages_async,
)
from src.analyzer.schemas import (
    AnalysisPlan,
    DebugRequest,
    DebugResponse,
    ReviewRequest,
    ReviewHandoff,
)
from src.analyzer.trace import TraceRecorder
from src.config import get_settings
from src.models.client import ModelClient
from src.models.compat import ModelCallPolicy, ModelProfile
from src.models.conversation import ModelConversation
from src.models.request_assembler import AssembledRequest, RequestAssembler
from src.models.schemas import (
    DraftFinding,
    DraftFindingInput,
    DraftFindingState,
    DraftFindingUpdateInput,
    Message,
    ModelConfig,
    ModelResponse,
    TokenUsage,
)
from src.models.token_telemetry import estimate_tokens, serialize_json, token_component
from src.tools.base import ToolResult, ToolSpec
from src.analyzer.verifier_context import capture_verifier_tool_evidence

logger = logging.getLogger(__name__)
_SUBMIT_MAX_TOKENS = 4096
_EXPLORATION_MAX_TOKENS = 12288
_SYNTHETIC_CONTEXT_MAX_CHARS = 3600
_FINAL_EVIDENCE_ENTRY_MAX_CHARS = 2400
_FINAL_EVIDENCE_TOOL_NAMES = {
    "changed_context",
    "get_changed_context",
    "read_file",
    "symbol_context",
    "find_symbol_context",
}
_DSML_ISSUES_PARAMETER_PATTERN = re.compile(
    r"parameter\s+name\s*=\s*\\?[\"']issues\\?[\"']",
    re.IGNORECASE,
)
_EMPTY_ISSUES_SUMMARY_CONCERN_PATTERN = re.compile(
    r"\b("
    r"one concern|concerns? noted|subtle logic change|logic change|"
    r"behavioral modification|behavior(?:al)? change|compatibility risk"
    r")\b",
    re.IGNORECASE,
)


def _optional_non_negative_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


class InferenceEngine:
    """Build messages, call model client, and parse structured plan."""

    def __init__(
        self,
        model_client: ModelClient,
        trace_recorder: TraceRecorder | None = None,
        trace_event_writer: Callable[[EventType, str, dict[str, Any]], None]
        | None = None,
        model_response_writer: Callable[[ModelResponse, int], str] | None = None,
        conversation: ModelConversation | None = None,
    ) -> None:
        self._model_client = model_client
        self._trace_recorder = trace_recorder
        self._trace_event_writer = trace_event_writer
        self._model_response_writer = model_response_writer
        self._conversation = conversation or ModelConversation()

    async def analyze(
        self,
        state: ContextState,
        request: ReviewRequest | DebugRequest,
        tool_specs: list[ToolSpec],
        tool_schemas: list[dict[str, Any]] | None = None,
        diff_text: str = "",
        error_log: str = "",
        project_structure: str = "",
        file_contents: dict[str, str] | None = None,
        tool_feedback: list[dict[str, Any]] | None = None,
        feedback_digest_index: dict[str, dict[str, Any]] | None = None,
        draft_findings: list[DraftFinding] | None = None,
        validator_result: dict[str, Any] | None = None,
        prompt_input_token_budget: int | None = None,
        iteration: int = 0,
        force_submit: bool = False,
        near_last_iteration: bool = False,
        defer_submit: bool = False,
        stage: str | None = None,
        skill_selection: SkillSelection | None = None,
        skill_telemetry: dict[str, Any] | None = None,
        repair_attempt_budget: int | None = None,
        allow_exploration: bool = False,
        repair_mode: bool = False,
        submit_tool_name: str | None = None,
        contract_version: str = "2.0",
    ) -> tuple[AnalysisPlan, TokenUsage]:
        file_contents = file_contents or {}
        settings = get_settings()
        submit_only = force_submit or (
            near_last_iteration and not allow_exploration
        ) or stage == "submit_only"
        inferred_stage = (
            "validate"
            if any(
                str(item.get("function", {}).get("name", ""))
                == "validate_review_draft"
                for item in (tool_schemas or [])
                if isinstance(item, dict)
                and isinstance(item.get("function"), dict)
            )
            else "explore"
        )
        # A final/near-limit call is submit-only even when an older caller did
        # not pass the newer explicit stage label.
        call_stage = (
            "repair"
            if repair_mode
            else "submit_only"
            if submit_only
            else (stage or inferred_stage)
        )
        requested_budget = (
            prompt_input_token_budget
            if prompt_input_token_budget is not None
            else settings.prompt_input_token_budget
        )
        total_prompt_budget = requested_budget
        final_feedback_budget = 0
        if submit_only:
            total_prompt_budget = min(
                requested_budget, settings.final_submit_prompt_token_budget
            )
            final_feedback_budget = min(
                settings.final_submit_feedback_token_budget,
                max(0, total_prompt_budget - 1),
            )
        budget = max(1, total_prompt_budget - final_feedback_budget)
        cb = ContextBuilder()
        context_telemetry: dict[str, Any] = {}
        summary_enabled = settings.context_summary_enabled and not submit_only
        prompt_context = state
        prompt_diff_text = diff_text
        prompt_file_contents = file_contents
        prompt_project_structure = project_structure
        if submit_only and isinstance(request, ReviewRequest):
            # Submit-only keeps the handoff explicit and bounded.  The previous
            # implementation cleared diff/manifests/files and relied on a short
            # tool preview, which made a no-draft run lose its change evidence.
            handoff = self._build_review_handoff(
                state,
                diff_text=diff_text,
                file_contents=file_contents,
                draft_findings=draft_findings or [],
                tool_feedback=tool_feedback or [],
            )
            prompt_context = state.model_copy(deep=True)
            prompt_context.candidate_context_manifests = (
                handoff.candidate_context_manifests
            )
            prompt_context.evidence_ledger = handoff.evidence_ledger
            prompt_diff_text = handoff.changed_diff
            prompt_file_contents = handoff.file_contents
            prompt_project_structure = ""
        if isinstance(request, ReviewRequest):
            if summary_enabled:
                messages = await build_review_messages_async(
                    request,
                    prompt_context,
                    prompt_diff_text,
                    prompt_file_contents,
                    prompt_token_budget=budget,
                    context_builder=cb,
                    compressor_model_client=self._model_client,
                    summary_enabled=True,
                    summary_max_tokens_per_part=get_settings().summary_max_tokens_per_part,
                    summary_model_name=request.model_name or get_settings().model_name,
                    project_structure=prompt_project_structure,
                    telemetry_sink=context_telemetry,
                    skill_selection=skill_selection,
                    contract_version=contract_version,
                )
            else:
                messages = build_review_messages(
                    request,
                    prompt_context,
                    prompt_diff_text,
                    prompt_file_contents,
                    prompt_token_budget=budget,
                    context_builder=cb,
                    project_structure=prompt_project_structure,
                    telemetry_sink=context_telemetry,
                    skill_selection=skill_selection,
                    contract_version=contract_version,
                )
        else:
            if summary_enabled:
                messages = await build_debug_messages_async(
                    request,
                    state,
                    error_log,
                    file_contents,
                    prompt_token_budget=budget,
                    context_builder=cb,
                    compressor_model_client=self._model_client,
                    summary_enabled=True,
                    summary_max_tokens_per_part=get_settings().summary_max_tokens_per_part,
                    summary_model_name=request.model_name or get_settings().model_name,
                    project_structure=project_structure,
                    telemetry_sink=context_telemetry,
                )
            else:
                messages = build_debug_messages(
                    request,
                    state,
                    error_log,
                    file_contents,
                    prompt_token_budget=budget,
                    context_builder=cb,
                    project_structure=project_structure,
                    telemetry_sink=context_telemetry,
                )

        if skill_telemetry is not None:
            context_telemetry["review_skills"] = dict(skill_telemetry)

        final_evidence_telemetry = self._empty_final_evidence_telemetry(
            final_feedback_budget
        )
        finalize_conversation_insert_at = len(messages) if submit_only else None
        if submit_only:
            final_evidence, final_evidence_telemetry = (
                self._build_final_submit_evidence_summary(
                    tool_feedback or [],
                    feedback_digest_index or {},
                    draft_findings or [],
                    validator_result=validator_result,
                    candidate_context_manifests=state.candidate_context_manifests,
                    draft_states=state.draft_findings,
                    evidence_ledger=state.evidence_ledger,
                    token_budget=final_feedback_budget,
                )
            )
            if final_evidence is not None:
                messages.append(final_evidence)
        else:
            window_iterations = {
                item.get("iteration")
                for item in (tool_feedback or [])
                if isinstance(item, dict)
            }
            folded = self._build_folded_feedback_summary(
                feedback_digest_index or {}, window_iterations
            )
            if folded is not None:
                messages.append(folded)
            repair_feedback = self._build_repair_feedback_message(
                validator_result,
                token_budget=(
                    max(512, settings.final_submit_feedback_token_budget)
                    if settings.final_submit_feedback_token_budget > 0
                    else max(512, budget // 4)
                ),
            )
            if repair_feedback is not None:
                messages.append(repair_feedback)
            if isinstance(request, ReviewRequest) and (
                draft_findings or state.draft_findings
            ):
                messages.append(
                    self._build_draft_checkpoint_message(
                        draft_findings or [], state.draft_findings
                    )
                )
            evidence_catalog_message = self._build_evidence_catalog_message(
                state.evidence_ledger
            )
            if evidence_catalog_message is not None:
                messages.append(evidence_catalog_message)
        if defer_submit:
            messages.append(
                Message(
                    role="user",
                    content=(
                        (
                            "Do not call finish_review yet. Submission is temporarily "
                            "unavailable during the initial exploration stage. "
                            if contract_version == "3.0"
                            else "Do not call submit_review yet. Submission is temporarily "
                            "unavailable during the initial exploration stage. Use the "
                        )
                        + (
                            "Use available read-only tools and save_finding only after a "
                            "finding is concrete. "
                            if contract_version == "3.0"
                            else "available read-only tools to resolve the most important evidence "
                        )
                        + "gap. Do not assume this is the only exploration round. In later "
                        "rounds, continue targeted investigation whenever material "
                        "evidence gaps remain."
                    ),
                )
            )
        if tool_feedback and not submit_only:
            messages.extend(
                self._build_tool_feedback_messages(
                    tool_feedback,
                    selected_file_complete_lines=context_telemetry.get(
                        "selected_file_complete_lines", {}
                    ),
                )
            )
            failure_guidance = self._build_failure_guidance_message(tool_feedback)
            if failure_guidance is not None:
                messages.append(failure_guidance)
        if submit_only:
            notice = (
                REPAIR_REVIEW_NOTICE
                if repair_mode and isinstance(request, ReviewRequest)
                else FINALIZE_REVIEW_NOTICE_V3
                if contract_version == "3.0" and isinstance(request, ReviewRequest)
                else FINALIZE_REVIEW_NOTICE
                if isinstance(request, ReviewRequest)
                else FINALIZE_DEBUG_NOTICE
            )
            messages.append(Message(role="user", content=notice))
        elif near_last_iteration:
            messages.append(
                Message(
                    role="user",
                    content=(
                        "Note: you are at the last allowed iteration. Prefer finishing now via "
                        + (
                            "finish_review"
                            if contract_version == "3.0"
                            else "submit_review/submit_debug"
                        )
                        + " using what you already have, unless a tool "
                        "call is strictly necessary and has not been made with identical args."
                    ),
                )
            )

        tools = (
            self._submit_only_tools(
                tool_schemas or [],
                request,
                expected_name=(
                    submit_tool_name
                    or ("repair_review" if repair_mode else None)
                ),
            )
            if submit_only
            else tool_schemas or []
        )
        config = None
        if submit_only:
            config = self._build_submit_config(request)
        else:
            config = self._model_client.default_config.model_copy(
                update={
                    "max_tokens": int(
                        getattr(settings, "exploration_max_output_tokens", _EXPLORATION_MAX_TOKENS)
                    )
                }
            )
        if request.model_name:
            if config is None:
                config = self._model_client.default_config.model_copy(
                    update={"model": request.model_name}
                )
            else:
                config.model = request.model_name
        policy = ModelCallPolicy(
            thinking="off" if submit_only else "high",
            forced_tool=(
                submit_tool_name
                or (
                    "repair_review"
                    if repair_mode
                    else self._submit_tool_name(
                        request, contract_version=contract_version
                    )
                )
            )
            if submit_only
            else None,
        )
        # Once deterministic validation has passed, the submit-only call is a
        # fresh, bounded handoff.  Replaying every prior assistant/tool turn
        # would re-send repeated source/tool feedback.  Legacy forced-finalize
        # callers without validator state retain the provider replay contract.
        minimal_submit_only = bool(
            submit_only
            and isinstance(validator_result, dict)
            and validator_result.get("submit_allowed") is True
        )
        conversation_messages = (
            [] if minimal_submit_only else self._conversation.messages()
        )
        conversation_history_count = len(conversation_messages)
        if submit_only:
            assert finalize_conversation_insert_at is not None
            conversation_history_start = finalize_conversation_insert_at
            messages[conversation_history_start:conversation_history_start] = (
                conversation_messages
            )
        else:
            conversation_history_start = len(messages)
            messages.extend(conversation_messages)
        # Component budgets do not include the envelope and tool schema.  Fit
        # the exact provider request after every history/context path so final
        # submit and repair calls share one enforceable cap.
        request_budget = (
            settings.final_submit_request_token_budget
            if submit_only
            else settings.assembled_request_token_budget
        )
        wire_config = config
        wire_policy = policy
        wire_profile: ModelProfile | None = None
        prepare_call = getattr(self._model_client, "prepare_call", None)
        if callable(prepare_call):
            wire_config, wire_policy, wire_profile = prepare_call(config, policy)
        assembled_request = RequestAssembler.fit(
            messages,
            tools,
            wire_config,
            wire_policy,
            budget=request_budget,
            profile=wire_profile,
        )
        messages = assembled_request.messages
        conversation_history_start = min(conversation_history_start, len(messages))
        conversation_history_count = min(
            conversation_history_count,
            max(0, len(messages) - conversation_history_start),
        )
        if submit_only:
            context_validation = self._validate_final_submit_request_context(
                assembled_request,
                final_evidence_telemetry,
                budget=request_budget,
            )
            context_telemetry["final_submit_context_validation"] = context_validation
            if not context_validation["valid"]:
                final_evidence_telemetry["context_insufficient"] = True
                final_evidence_telemetry["context_insufficient_reason"] = str(
                    context_validation["reason"]
                )
        if assembled_request.estimated_tokens > max(1, request_budget):
            context_telemetry["assembled_request_over_budget"] = True
            context_telemetry["assembled_request_over_budget_reason"] = (
                "serialized_submit_request_over_budget"
                if submit_only
                else "assembled_request_over_budget"
            )

        self._record_context_telemetry(
            context_telemetry=context_telemetry,
            messages=messages,
            tools=tools,
            config=config,
            policy=policy,
            file_contents=file_contents,
            tool_feedback=tool_feedback or [],
            conversation_history_count=conversation_history_count,
            iteration=iteration,
            prompt_input_token_budget=total_prompt_budget,
            base_context_token_budget=budget,
            final_submit_feedback_token_budget=final_feedback_budget,
            final_evidence_telemetry=final_evidence_telemetry,
            force_submit=submit_only,
            stage=call_stage,
            relation_graph_summary=state.relation_graph_summary,
            assembled_request=assembled_request,
            assembled_request_budget=request_budget,
        )
        if submit_only and final_evidence_telemetry.get("context_insufficient"):
            reason = str(
                final_evidence_telemetry.get(
                    "context_insufficient_reason",
                    "final_submit_context_insufficient",
                )
            )
            if self._trace_event_writer is not None:
                self._trace_event_writer(
                    EventType.ERROR,
                    "analyze",
                    {
                        "iteration": iteration,
                        "reason": "final_submit_context_insufficient",
                        "detail": reason,
                        "required_catalog_ids": final_evidence_telemetry.get(
                            "required_catalog_ids", []
                        ),
                        "included_catalog_ids": final_evidence_telemetry.get(
                            "included_catalog_ids", []
                        ),
                    },
                )
            return (
                AnalysisPlan(
                    needs_tools=False,
                    tool_calls=[],
                    incomplete_reason="final_submit_context_insufficient",
                    recovery_required=True,
                ),
                TokenUsage(),
            )
        if not submit_only and assembled_request.estimated_tokens > max(1, request_budget):
            reason = "assembled_request_over_budget"
            if self._trace_event_writer is not None:
                self._trace_event_writer(
                    EventType.ERROR,
                    "analyze",
                    {
                        "iteration": iteration,
                        "reason": reason,
                        "assembled_request_tokens": assembled_request.estimated_tokens,
                        "assembled_request_budget": request_budget,
                    },
                )
            return (
                AnalysisPlan(
                    needs_tools=False,
                    tool_calls=[],
                    incomplete_reason=reason,
                    recovery_required=True,
                ),
                TokenUsage(),
            )
        response = await self._chat_with_telemetry(
            messages=messages,
            config=config,
            tools=tools,
            policy=policy,
            iteration=iteration,
            stage=call_stage,
            force_submit=submit_only,
        )
        if isinstance(request, ReviewRequest):
            self._record_delivered_review_evidence(
                state,
                assembled_request,
                tool_feedback or [],
                repo_path=request.repo_path,
            )
        response_id = self._persist_model_response(response, iteration)
        self._record_length_finish(response, iteration, config)
        plan, parse_meta = self._parse_tool_calls(
            response.tool_calls,
            request,
            force_submit=submit_only,
            evidence_catalog=state.evidence_ledger,
            repair_mode=repair_mode,
            contract_version=contract_version,
        )
        self._complete_invalid_draft_tool_calls(response.tool_calls, parse_meta)
        format_recovery_raw_payload = parse_meta.get("format_recovery_raw_payload")
        format_recovery_validation_error = str(
            parse_meta.get("format_recovery_validation_error", "") or ""
        )
        format_recovery_input_response_id = response_id
        if plan.draft_finding_calls:
            plan.draft_finding_source_response_id = response_id
        parse_meta["tool_choice"] = self._trace_tool_choice(config)
        parse_meta["thinking_disabled"] = policy.thinking == "off"
        if (
            isinstance(request, ReviewRequest)
            and not repair_mode
            and contract_version != "3.0"
            and plan.draft_review is None
            and response.finish_reason != "length"
            and parse_meta.get("submit_review_seen")
            and parse_meta.get("submit_review_validation_error")
        ):
            repair_allowed = repair_attempt_budget is None or repair_attempt_budget > 0
            if repair_allowed:
                initial_usage = response.usage
                (
                    repair_plan,
                    repair_response,
                    repair_meta,
                    repair_response_id,
                    repair_assembled_request,
                ) = await self._retry_submit_review_validation_repair(
                    messages=messages,
                    request=request,
                    tool_schemas=tool_schemas or [],
                    validation_error=str(parse_meta["submit_review_validation_error"]),
                    iteration=iteration,
                    prior_history_start=conversation_history_start,
                    prior_history_count=conversation_history_count,
                    invalid_tool_calls=response.tool_calls,
                    stage=call_stage,
                    evidence_catalog=state.evidence_ledger,
                    contract_version=contract_version,
                )
                self._record_delivered_review_evidence(
                    state,
                    repair_assembled_request,
                    tool_feedback or [],
                    repo_path=request.repo_path,
                )
                repair_response.usage.total_tokens += initial_usage.total_tokens
                repair_response.usage.prompt_tokens += initial_usage.prompt_tokens
                repair_response.usage.completion_tokens += initial_usage.completion_tokens
                repair_response.usage.reasoning_tokens += initial_usage.reasoning_tokens
                repair_response.usage_present = (
                    repair_response.usage_present or response.usage_present
                )
                plan.schema_repair_attempted_count += 1
                repair_plan.schema_repair_attempted_count += 1
                if repair_plan.draft_review is not None:
                    repair_plan.draft_finding_calls = plan.draft_finding_calls
                    repair_plan.draft_finding_source_response_id = (
                        plan.draft_finding_source_response_id
                    )
                    plan = repair_plan
                    response = repair_response
                    parse_meta = repair_meta
                    response_id = repair_response_id
                else:
                    response.usage = repair_response.usage
            else:
                parse_meta["schema_repair_skipped_budget"] = True
                plan.incomplete_reason = "schema_repair_budget_exhausted"
                plan.recovery_required = True
        fallback_json_found = False
        fallback_parse_valid = False
        if not plan.draft_review and not plan.draft_debug:
            fallback = self._fallback_extract_json(response.content)
            if fallback:
                fallback_json_found = True
                parsed = self._try_parse_submit_payload_from_json(
                    fallback,
                    request,
                    evidence_catalog=state.evidence_ledger,
                    contract_version=contract_version,
                )
                if parsed:
                    fallback_parse_valid = True
                    parsed.draft_finding_calls = plan.draft_finding_calls
                    parsed.draft_finding_source_response_id = (
                        plan.draft_finding_source_response_id
                    )
                    parsed.schema_repair_attempted_count = (
                        plan.schema_repair_attempted_count
                    )
                    plan = parsed
        if isinstance(format_recovery_raw_payload, dict) and format_recovery_raw_payload:
            recovery_seed = (
                f"{format_recovery_input_response_id}|{iteration}|"
                f"{format_recovery_validation_error}"
            )
            plan.format_recovery_id = "fr_" + hashlib.sha256(
                recovery_seed.encode("utf-8")
            ).hexdigest()[:20]
            plan.format_recovery_required = True
            plan.format_recovery_raw_payload = format_recovery_raw_payload
            plan.format_recovery_validation_error = format_recovery_validation_error
            plan.format_recovery_input_response_id = format_recovery_input_response_id
            plan.format_recovery_response_id = response_id
        plan.source_response_id = response_id
        incomplete_reason = self._length_incomplete_reason(response, plan)
        plan.model_finish_reason = response.finish_reason
        if submit_only:
            plan.final_submit_evidence_included_count = int(
                final_evidence_telemetry["included_count"]
            )
            plan.final_submit_evidence_token_count = int(
                final_evidence_telemetry["estimated_tokens"]
            )
            plan.final_submit_evidence_truncated_count = int(
                final_evidence_telemetry["truncated_count"]
            )
        if incomplete_reason:
            plan.incomplete_reason = incomplete_reason
            plan.recovery_required = True
            parse_meta["incomplete_reason"] = incomplete_reason
            self._record_incomplete_response(
                response, iteration, config, incomplete_reason
            )
        self._record_trace(
            response,
            plan,
            parse_meta,
            iteration,
            fallback_json_found,
            fallback_parse_valid,
        )
        return plan, response.usage

    async def _chat_with_telemetry(
        self,
        *,
        messages: list[Message],
        config: ModelConfig,
        tools: list[dict[str, Any]],
        policy: ModelCallPolicy,
        iteration: int,
        stage: str,
        force_submit: bool,
    ) -> ModelResponse:
        """Call the provider and emit one safe event for every provider attempt."""

        try:
            response = await self._model_client.chat(
                messages=messages,
                config=config,
                tools=tools,
                policy=policy,
                conversation=self._conversation,
            )
        except Exception as exc:
            self._record_provider_attempts(
                attempts=self._consume_provider_attempts(),
                response=None,
                error=exc,
                iteration=iteration,
                stage=stage,
                force_submit=force_submit,
                policy=policy,
                tool_schema_count=len(tools),
            )
            raise

        self._record_provider_attempts(
            attempts=self._consume_provider_attempts(),
            response=response,
            error=None,
            iteration=iteration,
            stage=stage,
            force_submit=force_submit,
            policy=policy,
            tool_schema_count=len(tools),
        )
        return response

    def _consume_provider_attempts(self) -> list[dict[str, Any]]:
        consumer = getattr(self._model_client, "consume_call_telemetry", None)
        if not callable(consumer):
            return []
        try:
            attempts = consumer()
        except Exception:  # noqa: BLE001
            return []
        return [item for item in attempts if isinstance(item, dict)]

    def _record_provider_attempts(
        self,
        *,
        attempts: list[dict[str, Any]],
        response: ModelResponse | None,
        error: Exception | None,
        iteration: int,
        stage: str,
        force_submit: bool,
        policy: ModelCallPolicy,
        tool_schema_count: int,
    ) -> None:
        if self._trace_event_writer is None:
            return
        if not attempts:
            attempts = [
                {
                    "provider_attempt": 1,
                    "success": response is not None,
                    "usage_present": bool(response and response.usage_present),
                    "prompt_tokens": response.usage.prompt_tokens if response else 0,
                    "completion_tokens": response.usage.completion_tokens
                    if response
                    else 0,
                    "total_tokens": response.usage.total_tokens if response else 0,
                    "reasoning_tokens": response.usage.reasoning_tokens
                    if response
                    else 0,
                    "cached_prompt_tokens": response.usage.cached_prompt_tokens
                    if response
                    else None,
                    "actual_reasoning_effort": response.actual_reasoning_effort
                    if response
                    else "unknown",
                    "provider_request_id": response.provider_request_id
                    if response
                    else "",
                    "usage_unknown": response is None,
                }
            ]
        for raw in attempts:
            success = bool(raw.get("success", response is not None))
            usage_present = bool(raw.get("usage_present", success))
            payload: dict[str, Any] = {
                "iteration": iteration,
                "provider_attempt": int(raw.get("provider_attempt", 1) or 1),
                "stage": stage,
                "force_submit": force_submit,
                "thinking": str(raw.get("thinking", policy.thinking)),
                "actual_reasoning_effort": str(
                    raw.get(
                        "actual_reasoning_effort",
                        response.actual_reasoning_effort
                        if response is not None
                        else "unknown",
                    )
                ),
                "forced_tool": str(
                    raw.get("forced_tool", policy.forced_tool or "none")
                ),
                "tool_schema_count": int(
                    raw.get("tool_schema_count", tool_schema_count) or 0
                ),
                "prompt_tokens": max(0, int(raw.get("prompt_tokens", 0) or 0)),
                "completion_tokens": max(
                    0, int(raw.get("completion_tokens", 0) or 0)
                ),
                "total_tokens": max(0, int(raw.get("total_tokens", 0) or 0)),
                "reasoning_tokens": max(
                    0, int(raw.get("reasoning_tokens", 0) or 0)
                ),
                "cached_prompt_tokens": _optional_non_negative_int(
                    raw.get("cached_prompt_tokens")
                ),
                "request_hash": str(raw.get("request_hash", "") or ""),
                "request_estimated_tokens": max(
                    0, int(raw.get("request_estimated_tokens", 0) or 0)
                ),
                "adjacent_common_prefix_tokens": max(
                    0, int(raw.get("adjacent_common_prefix_tokens", 0) or 0)
                ),
                "adjacent_prefix_hash": str(
                    raw.get("adjacent_prefix_hash", "") or ""
                ),
                "provider_cache_hit": bool(
                    raw.get("cached_prompt_tokens") is not None
                    and int(raw.get("cached_prompt_tokens", 0) or 0) > 0
                ),
                "usage_present": usage_present,
                "success": success,
                "provider_request_id": str(raw.get("provider_request_id", "") or ""),
                "usage_unknown": bool(
                    raw.get("usage_unknown", not success and not usage_present)
                ),
            }
            if not success:
                if error is not None:
                    payload.setdefault("failure_type", error.__class__.__name__)
                    payload.setdefault(
                        "failure_status", getattr(error, "status_code", None)
                    )
                    payload.setdefault(
                        "provider_code", str(getattr(error, "code", "") or "")
                    )
                else:
                    payload.setdefault("failure_type", str(raw.get("failure_type", "")))
                    payload.setdefault("failure_status", raw.get("failure_status"))
                    payload.setdefault("provider_code", str(raw.get("provider_code", "")))
            self._trace_event_writer(EventType.MODEL_CALL, "provider_attempt", payload)

    async def _retry_submit_review_validation_repair(
        self,
        *,
        messages: list[Message],
        request: ReviewRequest,
        tool_schemas: list[dict[str, Any]],
        validation_error: str,
        iteration: int,
        prior_history_start: int,
        prior_history_count: int,
        invalid_tool_calls: list[dict[str, Any]],
        stage: str = "submit_only",
        evidence_catalog: list[dict[str, Any]] | None = None,
        contract_version: str = "2.0",
    ) -> tuple[AnalysisPlan, ModelResponse, dict[str, Any], str, AssembledRequest]:
        for raw_call in invalid_tool_calls:
            call_id = str(raw_call.get("id", "")).strip()
            if call_id:
                self._conversation.add_tool_result(
                    call_id,
                    {
                        "ok": False,
                        "error_type": "validation_error",
                        "message": validation_error,
                    },
                )
        prior_history_end = prior_history_start + prior_history_count
        repair_messages = [
            *messages[:prior_history_start],
            *self._conversation.messages(),
            *messages[prior_history_end:],
            Message(
                role="user",
                content=(
                    "Your previous submit_review tool call was rejected by schema validation. "
                    "Call submit_review again as your only action, preserving supported findings "
                    "but fixing this exact validation error:\n"
                    f"{validation_error}\n"
                    "The submit_review function arguments must directly contain top-level "
                    "summary and issues fields; do not wrap them inside an arguments object."
                ),
            ),
        ]
        config = self._build_submit_config(request)
        policy = ModelCallPolicy(thinking="off", forced_tool="submit_review")
        repair_tools = self._submit_only_tools(tool_schemas, request)
        wire_config = config
        wire_policy = policy
        wire_profile: ModelProfile | None = None
        prepare_call = getattr(self._model_client, "prepare_call", None)
        if callable(prepare_call):
            wire_config, wire_policy, wire_profile = prepare_call(config, policy)
        assembled_request = RequestAssembler.fit(
            repair_messages,
            repair_tools,
            wire_config,
            wire_policy,
            budget=get_settings().final_submit_request_token_budget,
            profile=wire_profile,
        )
        repair_messages = assembled_request.messages
        response = await self._chat_with_telemetry(
            messages=repair_messages,
            config=config,
            tools=repair_tools,
            policy=policy,
            iteration=iteration,
            stage=stage,
            force_submit=True,
        )
        response_id = self._persist_model_response(response, iteration)
        plan, parse_meta = self._parse_tool_calls(
            response.tool_calls,
            request,
            force_submit=True,
            evidence_catalog=evidence_catalog,
            contract_version=contract_version,
        )
        parse_meta["tool_choice"] = self._trace_tool_choice(config)
        parse_meta["thinking_disabled"] = True
        return plan, response, parse_meta, response_id, assembled_request

    def _persist_model_response(self, response: ModelResponse, iteration: int) -> str:
        """Persist a provider response before parsing, fallback, or validation."""

        if self._model_response_writer is None:
            return ""
        return self._model_response_writer(response, iteration)

    def _build_submit_config(
        self, request: ReviewRequest | DebugRequest
    ) -> ModelConfig:
        settings = get_settings()
        return self._model_client.default_config.model_copy(
            update={
                "max_tokens": int(
                    getattr(settings, "submit_max_output_tokens", _SUBMIT_MAX_TOKENS)
                ),
            }
        )

    @staticmethod
    def _submit_tool_name(
        request: ReviewRequest | DebugRequest, *, contract_version: str = "2.0"
    ) -> str:
        if isinstance(request, ReviewRequest) and contract_version == "3.0":
            return "finish_review"
        return "submit_review" if isinstance(request, ReviewRequest) else "submit_debug"

    @staticmethod
    def _submit_only_tools(
        tool_schemas: list[dict[str, Any]],
        request: ReviewRequest | DebugRequest,
        *,
        expected_name: str | None = None,
    ) -> list[dict[str, Any]]:
        expected = expected_name or (
            "submit_review" if isinstance(request, ReviewRequest) else "submit_debug"
        )
        return [
            tool
            for tool in tool_schemas
            if isinstance(tool.get("function"), dict)
            and tool["function"].get("name") == expected
        ]

    @staticmethod
    def _trace_tool_choice(config: ModelConfig | None) -> Any:
        if config is None:
            return None
        return config.tool_choice

    def _parse_tool_calls(
        self,
        raw_calls: list[dict[str, Any]],
        request: ReviewRequest | DebugRequest,
        *,
        force_submit: bool = False,
        evidence_catalog: list[dict[str, Any]] | None = None,
        repair_mode: bool = False,
        contract_version: str = "2.0",
    ) -> tuple[AnalysisPlan, dict[str, Any]]:
        tool_calls: list[dict[str, Any]] = []
        draft_finding_calls: list[DraftFindingInput] = []
        draft_finding_updates: list[DraftFindingUpdateInput] = []
        v3_save_findings: list[ModelSaveFindingActionV3] = []
        v3_revise_findings: list[ModelReviseFindingActionV3] = []
        v3_finish_review: ModelFinishReviewActionV3 | None = None
        draft_review: ReviewReport | None = None
        repair_response: ModelRepairResponse | ModelRepairResponseV3 | None = None
        draft_debug: DebugResponse | None = None
        parse_meta: dict[str, Any] = {
            "submit_review_seen": False,
            "submit_debug_seen": False,
            "submit_review_validation_error": "",
            "submit_review_arguments_normalized": False,
            "submit_debug_validation_error": "",
            "repair_review_seen": False,
            "repair_review_validation_error": "",
            "draft_finding_validation_errors": [],
            "draft_finding_update_validation_errors": [],
            "valid_draft_call_ids": [],
            "valid_draft_update_call_ids": [],
            "location_warnings": [],
            "force_submit_discarded_count": 0,
            "format_recovery_raw_payload": {},
            "format_recovery_validation_error": "",
        }

        for raw in raw_calls:
            function_block = raw.get("function") if isinstance(raw, dict) else None
            if not isinstance(function_block, dict):
                continue
            name = str(function_block.get("name", "")).strip()
            arguments = function_block.get("arguments", "{}")
            argument_error = ""
            try:
                payload = self._parse_tool_arguments(arguments)
            except json.JSONDecodeError as exc:
                payload = {}
                argument_error = f"Invalid JSON arguments for {name}: {exc}"
            except Exception as exc:  # noqa: BLE001
                payload = {}
                argument_error = f"Invalid arguments for {name}: {exc}"

            if name == "record_draft_finding":
                if force_submit or not isinstance(request, ReviewRequest):
                    parse_meta["force_submit_discarded_count"] += int(force_submit)
                    continue
                if argument_error or not isinstance(payload, dict):
                    error = argument_error or (
                        "Invalid record_draft_finding arguments type: "
                        f"{type(payload).__name__}"
                    )
                    parse_meta["draft_finding_validation_errors"].append(error)
                    logger.warning("Invalid draft finding ignored: %s", error)
                    continue
                try:
                    draft_finding_calls.append(
                        DraftFindingInput.model_validate(payload)
                    )
                    parse_meta["valid_draft_call_ids"].append(
                        str(raw.get("id", "")).strip()
                    )
                except ValidationError as exc:
                    parse_meta["draft_finding_validation_errors"].append(str(exc))
                    logger.warning("Invalid draft finding ignored: %s", exc)
                continue
            if name == "update_draft_finding":
                if force_submit or not isinstance(request, ReviewRequest):
                    parse_meta["force_submit_discarded_count"] += int(force_submit)
                    continue
                if argument_error or not isinstance(payload, dict):
                    error = argument_error or (
                        "Invalid update_draft_finding arguments type: "
                        f"{type(payload).__name__}"
                    )
                    parse_meta["draft_finding_update_validation_errors"].append(error)
                    continue
                try:
                    draft_finding_updates.append(
                        DraftFindingUpdateInput.model_validate(payload)
                    )
                    parse_meta["valid_draft_update_call_ids"].append(
                        str(raw.get("id", "")).strip()
                    )
                except ValidationError as exc:
                    parse_meta["draft_finding_update_validation_errors"].append(
                        str(exc)
                    )
                continue
            if contract_version == "3.0" and name in {
                "save_finding",
                "revise_finding",
                "finish_review",
            }:
                if force_submit and name != "finish_review":
                    parse_meta["force_submit_discarded_count"] += 1
                    continue
                if argument_error or not isinstance(payload, dict):
                    parse_meta.setdefault("v3_action_validation_errors", []).append(
                        argument_error
                        or f"Invalid {name} arguments type: {type(payload).__name__}"
                    )
                    continue
                try:
                    if name == "save_finding":
                        v3_save_findings.append(
                            ModelSaveFindingActionV3.model_validate(payload)
                        )
                    elif name == "revise_finding":
                        v3_revise_findings.append(
                            ModelReviseFindingActionV3.model_validate(payload)
                        )
                    else:
                        v3_finish_review = ModelFinishReviewActionV3.model_validate(
                            payload
                        )
                except ValidationError as exc:
                    parse_meta.setdefault("v3_action_validation_errors", []).append(
                        f"{name}: {exc}"
                    )
                continue
            if name == "submit_review":
                parse_meta["submit_review_seen"] = True
                if repair_mode:
                    parse_meta["repair_review_validation_error"] = (
                        "repair transaction requires the dedicated repair_review tool; "
                        "full submit_review payloads are forbidden"
                    )
                    continue
                if contract_version == "3.0":
                    parse_meta["submit_review_validation_error"] = (
                        "submit_review is not supported for finding contract 3.0; "
                        "call finish_review"
                    )
                    continue
                if argument_error or not isinstance(payload, dict):
                    error = (
                        argument_error
                        or f"Invalid submit_review arguments type: {type(payload).__name__}"
                    )
                    logger.warning("Invalid submit_review arguments ignored: %s", error)
                    parse_meta["submit_review_validation_error"] = error
                    continue
                payload, arguments_normalized = (
                    self._normalize_nested_submit_review_arguments(payload)
                )
                parse_meta["submit_review_arguments_normalized"] = bool(
                    parse_meta["submit_review_arguments_normalized"]
                    or arguments_normalized
                )
                payload_error = self._validate_submit_review_payload(
                    payload,
                    contract_version=contract_version,
                )
                if payload_error:
                    logger.warning(
                        "Invalid submit_review payload ignored: %s", payload_error
                    )
                    parse_meta["submit_review_validation_error"] = payload_error
                    if not any(
                        is_model_repair_payload(item)
                        for item in payload.get("issues", [])
                        if isinstance(item, dict)
                    ):
                        parse_meta["format_recovery_raw_payload"] = payload
                        parse_meta["format_recovery_validation_error"] = payload_error
                    continue
                normalized_payload, warnings = self._normalize_review_payload(
                    payload,
                    evidence_catalog=evidence_catalog,
                    contract_version=contract_version,
                )
                parse_meta["location_warnings"] = warnings
                try:
                    draft_review = self._normalize_structured_report(
                        ReviewReport.model_validate(normalized_payload),
                        contract_version=contract_version,
                    )
                except (ValidationError, ValueError) as exc:
                    logger.warning("Invalid submit_review payload ignored: %s", exc)
                    parse_meta["submit_review_validation_error"] = str(exc)
                    if not any(
                        is_model_repair_payload(item)
                        for item in payload.get("issues", [])
                        if isinstance(item, dict)
                    ):
                        parse_meta["format_recovery_raw_payload"] = payload
                        parse_meta["format_recovery_validation_error"] = str(exc)
                    continue
                continue
            if name == "repair_review":
                parse_meta["repair_review_seen"] = True
                if argument_error or not isinstance(payload, dict):
                    error = argument_error or (
                        "Invalid repair_review arguments type: "
                        f"{type(payload).__name__}"
                    )
                    parse_meta["repair_review_validation_error"] = error
                    continue
                if not repair_mode:
                    parse_meta["repair_review_validation_error"] = (
                        "repair_review is only valid inside an active repair transaction"
                    )
                    continue
                try:
                    repairs = payload.get("repairs")
                    if not isinstance(repairs, list):
                        raise ValueError("repair_review requires a repairs list")
                    for index, item in enumerate(repairs):
                        error = (
                            validate_model_repair_target_v3_payload(item)
                            if contract_version == "3.0"
                            else validate_model_repair_target_payload(item)
                        )
                        if error:
                            raise ValueError(f"repairs[{index}]: {error}")
                    repair_response = (
                        ModelRepairResponseV3.model_validate(payload)
                        if contract_version == "3.0"
                        else ModelRepairResponse.model_validate(payload)
                    )
                except (ValidationError, ValueError) as exc:
                    parse_meta["repair_review_validation_error"] = str(exc)
                    logger.warning("Invalid repair_review payload ignored: %s", exc)
                continue
            if name == "submit_debug":
                parse_meta["submit_debug_seen"] = True
                if argument_error or not isinstance(payload, dict):
                    error = (
                        argument_error
                        or f"Invalid submit_debug arguments type: {type(payload).__name__}"
                    )
                    logger.warning("Invalid submit_debug arguments ignored: %s", error)
                    parse_meta["submit_debug_validation_error"] = error
                    continue
                try:
                    draft_debug = DebugResponse.model_validate(
                        {
                            **payload,
                            "run_id": "",
                            "context": {"goal": "", "constraints": [], "decisions": []},
                        }
                    )
                except ValidationError as exc:
                    parse_meta["submit_debug_validation_error"] = str(exc)
                    continue
                continue
            if force_submit:
                parse_meta["force_submit_discarded_count"] += 1
                logger.warning(
                    "Force-submit mode: discarding non-submit tool_call '%s' to force fallback JSON extraction",
                    name,
                )
                continue
            tool_calls.append(raw)

        if isinstance(request, ReviewRequest):
            return (
                AnalysisPlan(
                    needs_tools=bool(tool_calls),
                    tool_calls=tool_calls,
                    draft_finding_calls=draft_finding_calls,
                    draft_finding_updates=draft_finding_updates,
                    v3_save_findings=v3_save_findings,
                    v3_revise_findings=v3_revise_findings,
                    v3_finish_review=v3_finish_review,
                    draft_review=draft_review,
                    repair_response=repair_response,
                ),
                parse_meta,
            )
        return (
            AnalysisPlan(
                needs_tools=bool(tool_calls),
                tool_calls=tool_calls,
                draft_debug=draft_debug,
                repair_response=repair_response,
            ),
            parse_meta,
        )

    def _complete_invalid_draft_tool_calls(
        self,
        raw_calls: list[dict[str, Any]],
        parse_meta: dict[str, Any],
    ) -> None:
        """Satisfy rejected pseudo-calls so provider replay remains complete."""

        valid_ids = set(parse_meta.get("valid_draft_call_ids", []))
        valid_update_ids = set(parse_meta.get("valid_draft_update_call_ids", []))
        for raw in raw_calls:
            function = raw.get("function") if isinstance(raw, dict) else None
            if not isinstance(function, dict):
                continue
            if function.get("name") not in {
                "record_draft_finding",
                "update_draft_finding",
            }:
                continue
            call_id = str(raw.get("id", "")).strip()
            if not call_id or call_id in valid_ids or call_id in valid_update_ids:
                continue
            self._conversation.add_tool_result(
                call_id,
                {
                    "ok": False,
                    "recorded": False,
                    "error_type": "validation_error",
                },
            )

    @staticmethod
    def _parse_tool_arguments(arguments: Any) -> Any:
        if not isinstance(arguments, str):
            return arguments
        try:
            return json.loads(arguments)
        except json.JSONDecodeError as exc:
            if "Invalid control character" not in exc.msg:
                raise
            return json.loads(arguments, strict=False)

    def _try_parse_submit_payload_from_json(
        self,
        payload: dict[str, Any],
        request: ReviewRequest | DebugRequest,
        *,
        evidence_catalog: list[dict[str, Any]] | None = None,
        contract_version: str = "2.0",
    ) -> AnalysisPlan | None:
        if isinstance(request, ReviewRequest):
            if contract_version == "3.0":
                return None
            payload_error = self._validate_submit_review_payload(
                payload,
                contract_version=contract_version,
            )
            if payload_error:
                logger.warning("Invalid fallback review JSON ignored: %s", payload_error)
                return None
            normalized_payload, _ = self._normalize_review_payload(
                payload,
                evidence_catalog=evidence_catalog,
                contract_version=contract_version,
            )
            try:
                report = self._normalize_structured_report(
                    ReviewReport.model_validate(normalized_payload),
                    contract_version=contract_version,
                )
                return AnalysisPlan(
                    needs_tools=False, tool_calls=[], draft_review=report
                )
            except (ValidationError, ValueError) as exc:
                logger.warning("Invalid fallback review JSON ignored: %s", exc)
                return None
        try:
            draft_debug = DebugResponse.model_validate(
                {
                    **payload,
                    "run_id": "",
                    "context": {"goal": "", "constraints": [], "decisions": []},
                }
            )
            return AnalysisPlan(
                needs_tools=False, tool_calls=[], draft_debug=draft_debug
            )
        except ValidationError:
            return None

    @staticmethod
    def _normalize_structured_report(
        report: ReviewReport,
        *,
        contract_version: str = "2.0",
    ) -> ReviewReport:
        """Populate canonical support envelopes from compatible role arrays."""

        if report.schema_version != contract_version:
            raise ValueError(
                "review report contract/version mismatch: "
                f"report={report.schema_version!r}, context={contract_version!r}"
            )
        for issue in report.issues:
            if (
                issue.is_structured_hypothesis
                and not issue.is_v3_finding
                and not issue.supports
            ):
                issue.supports = issue_supports(issue)
        return report

    @staticmethod
    def _fallback_extract_json(content: str) -> dict[str, Any] | None:
        if not content:
            return None
        # Scan { positions from end to start — the last JSON block is most likely the target
        decoder = json.JSONDecoder()
        positions = [i for i, c in enumerate(content) if c == "{"]  # noqa: RUF015
        for pos in reversed(positions):
            try:
                obj, _ = decoder.raw_decode(content, pos)
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                continue
        # Fallback: original greedy regex
        match = re.search(r"\{[\s\S]*\}", content)
        if not match:
            return None
        try:
            candidate = json.loads(match.group(0))
            return candidate if isinstance(candidate, dict) else None
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _normalize_nested_submit_review_arguments(
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], bool]:
        """Unwrap one exact provider-style arguments envelope for submit_review."""

        if set(payload) != {"arguments"}:
            return payload, False
        nested = payload.get("arguments")
        if not isinstance(nested, dict) or not {"summary", "issues"}.issubset(nested):
            return payload, False
        return nested, True

    @staticmethod
    def _validate_submit_review_payload(
        payload: dict[str, Any],
        *,
        contract_version: str = "2.0",
    ) -> str:
        summary = payload.get("summary")
        if isinstance(summary, str) and _DSML_ISSUES_PARAMETER_PATTERN.search(summary):
            return "Invalid submit_review payload: DSML parameter leak for issues in summary"
        if "issues" not in payload:
            return "Invalid submit_review payload: missing required issues list"
        if not isinstance(payload["issues"], list):
            return (
                "Invalid submit_review payload: issues must be a list, "
                f"got {type(payload['issues']).__name__}"
            )
        for index, issue in enumerate(payload["issues"]):
            if is_model_repair_payload(issue):
                repair_error = validate_model_repair_payload(issue)
                if repair_error:
                    return (
                        "Invalid submit_review repair issue at "
                        f"issues[{index}]: {repair_error}"
                    )
            if isinstance(issue, dict) and is_model_finding_v3_payload(issue):
                if contract_version != "3.0":
                    return (
                        "Invalid submit_review payload: v3 finding requires "
                        "finding contract version '3.0'"
                    )
                try:
                    ModelFindingInputV3.model_validate(issue)
                except ValidationError as exc:
                    return (
                        "Invalid submit_review 3.0 finding at "
                        f"issues[{index}]: {exc}"
                    )
                continue
            if (
                isinstance(issue, dict)
                and "confidence" not in issue
                and not (
                    str(issue.get("target_candidate_id", "")).strip()
                    and str(issue.get("repair_status", "")).strip()
                    in {"unchanged", "incomplete", "deferred", "repaired"}
                    and (
                        "repair_patch" in issue
                        or str(issue.get("repair_status", "")).strip()
                        != "repaired"
                    )
                )
            ):
                return (
                    "Invalid submit_review payload: "
                    f"issues[{index}] missing required confidence"
                )
        if (
            isinstance(summary, str)
            and not payload["issues"]
            and _EMPTY_ISSUES_SUMMARY_CONCERN_PATTERN.search(summary)
        ):
            return (
                "Invalid submit_review payload: summary mentions review concerns "
                "but issues is empty"
            )
        return ""

    @staticmethod
    def _normalize_review_payload(
        payload: Any,
        *,
        evidence_catalog: list[dict[str, Any]] | None = None,
        contract_version: str = "2.0",
    ) -> tuple[dict[str, Any], list[dict[str, str]]]:
        if not isinstance(payload, dict):
            return {}, []
        normalized = dict(payload)
        declared_version = str(normalized.get("schema_version", "") or "").strip()
        if declared_version and declared_version != contract_version:
            return normalized, [
                {
                    "location": "",
                    "warning": (
                        "review report schema_version does not match the active "
                        f"finding contract: {declared_version!r} != {contract_version!r}"
                    ),
                }
            ]
        normalized["schema_version"] = contract_version
        issues = normalized.get("issues")
        if not isinstance(issues, list):
            return normalized, []
        normalized_issues: list[Any] = []
        warnings: list[dict[str, str]] = []
        for issue in issues:
            if not isinstance(issue, dict):
                normalized_issues.append(issue)
                continue
            issue_dict = normalize_model_finding_payload(
                issue,
                evidence_catalog=evidence_catalog,
            )
            raw_severity = str(issue_dict.get("severity", "")).strip().lower()
            mapped = InferenceEngine._normalize_severity(raw_severity)
            if mapped:
                issue_dict["severity"] = mapped
            raw_location = str(issue_dict.get("location", "")).strip()
            if raw_location:
                parsed_location = normalize_location(raw_location)
                issue_dict["location"] = parsed_location.canonical
                if parsed_location.warning:
                    warnings.append(
                        {
                            "location": raw_location,
                            "warning": parsed_location.warning,
                        }
                    )
            normalized_issues.append(issue_dict)
        normalized["issues"] = normalized_issues
        return normalized, warnings

    @staticmethod
    def _normalize_severity(value: str) -> str:
        mapping = {
            "critical": "critical",
            "high": "critical",
            "major": "critical",
            "warning": "warning",
            "warn": "warning",
            "medium": "warning",
            "info": "info",
            "informational": "info",
            "low": "info",
            "minor": "info",
            "style": "style",
            "nit": "style",
            "nits": "style",
        }
        return mapping.get(value, value)

    @staticmethod
    def _build_draft_checkpoint_message(
        drafts: list[DraftFinding],
        states: list[DraftFindingState],
    ) -> Message:
        """Return the short next-round checkpoint for unresolved hypotheses."""

        states_by_id = {item.draft_id: item for item in states}
        lines = [
            "draft_checkpoint:",
            "Draft recordings are state checkpoints, never completion. Review each "
            "hypothesis and choose one targeted next action; do not repeat a read "
            "unless it can answer a stated missing check.",
        ]
        for draft in drafts:
            checkpoint = states_by_id.get(
                draft.id,
                DraftFindingState(draft_id=draft.id),
            )
            lines.append(
                f"- {draft.id} status={checkpoint.status} "
                f"hypothesis={draft.claim} at {draft.file}"
                + (f":{draft.line}" if draft.line is not None else "")
            )
            if checkpoint.reason:
                lines.append(f"  reason: {checkpoint.reason}")
            if checkpoint.missing_checks:
                lines.append(
                    "  missing_checks: " + "; ".join(checkpoint.missing_checks)
                )
            elif checkpoint.status == "pending":
                lines.append(
                    "  missing_checks: inspect the cited implementation and its "
                    "relevant caller or contract, then confirm or disprove the claim"
                )
            if checkpoint.evidence_refs:
                lines.append(
                    "  selected_evidence_refs: "
                    + ", ".join(checkpoint.evidence_refs)
                )
        return Message(role="user", content="\n".join(lines))

    @staticmethod
    def _build_evidence_catalog_message(
        evidence_ledger: list[dict[str, Any]],
    ) -> Message | None:
        """Expose exact delivered evidence ids without exposing unobserved spans."""

        records = [
            item
            for item in evidence_ledger
            if isinstance(item, dict)
            and str(item.get("lifecycle", "delivered")).strip() == "delivered"
            and not bool(item.get("truncated", False))
        ]
        if not records:
            return None
        lines = [
            "delivered_evidence_catalog:",
            "Select supports.evidence_refs only from these exact ids. Unknown, "
            "stale, or out-of-scope ids will be rejected; do not guess a nearest span.",
        ]
        # Do not hide a relevant delivered span behind an arbitrary first-40
        # cutoff.  Final-submit context performs relevance ranking and atomic
        # budget accounting; exploration still exposes the complete catalog so
        # the model can select an exact id without nearest-span guessing.
        for record in records:
            evidence_id = str(record.get("evidence_id", "")).strip()
            artifact_id = str(record.get("artifact_id", "")).strip()
            path = str(record.get("path", record.get("file", ""))).strip()
            start = record.get("start_line", record.get("line", ""))
            end = record.get("end_line", start)
            source = str(
                record.get("source_type", record.get("retrieval_source", ""))
            ).strip()
            snapshot = str(record.get("snapshot_id", "")).strip()
            revision = str(record.get("revision", "")).strip()
            if not evidence_id or not path:
                continue
            range_text = f"{path}:{start}"
            if end not in (None, "", start):
                range_text += f"-{end}"
            lines.append(
                f"- evidence_id={evidence_id} location={range_text} source={source} "
                f"snapshot={snapshot} revision={revision}"
                + (f" aliases={artifact_id}" if artifact_id and artifact_id != evidence_id else "")
            )
        return Message(role="user", content="\n".join(lines))

    @classmethod
    def _build_tool_feedback_messages(
        cls,
        tool_feedback: list[dict[str, Any]],
        *,
        selected_file_complete_lines: dict[str, int] | None = None,
    ) -> list[Message]:
        messages: list[Message] = []
        selected_file_complete_lines = selected_file_complete_lines or {}
        for item in tool_feedback:
            raw_tool_call = item.get("tool_call", {})
            if not isinstance(raw_tool_call, dict):
                continue
            function_block = raw_tool_call.get("function", {})
            if not isinstance(function_block, dict):
                continue

            tool_result = item.get("result")
            if isinstance(tool_result, ToolResult):
                result_payload = tool_result.model_dump()
            elif isinstance(tool_result, dict):
                result_payload = tool_result
            else:
                result_payload = {"ok": False, "error": "invalid_tool_result"}

            iteration = item.get("iteration")
            iter_tag = f"[iter={iteration}] " if iteration is not None else ""
            if raw_tool_call.get("synthetic_context") is True:
                if cls._prefetch_covered_by_selected_file(
                    raw_tool_call,
                    result_payload,
                    selected_file_complete_lines,
                ):
                    continue
                result_payload = InferenceEngine._compact_synthetic_context_payload(
                    result_payload
                )
                messages.append(
                    Message(
                        role="user",
                        content=(
                            f"{iter_tag}prefetched_tool_context: "
                            + serialize_json(
                                {
                                    "tool": function_block.get("name", "unknown"),
                                    "tool_call_id": str(
                                        raw_tool_call.get("id", "")
                                    ).strip(),
                                    "arguments": function_block.get("arguments", "{}"),
                                    "result": result_payload,
                                }
                            )
                        ),
                    )
                )
                continue

        return messages

    @classmethod
    def _prefetch_covered_by_selected_file(
        cls,
        raw_tool_call: dict[str, Any],
        result_payload: dict[str, Any],
        selected_file_complete_lines: dict[str, int],
    ) -> bool:
        entry = cls._prefetch_coverage_entry(
            raw_tool_call,
            result_payload,
            selected_file_complete_lines,
        )
        return bool(entry and entry["covered_by_file_context"])

    @staticmethod
    def _compact_synthetic_context_payload(payload: dict[str, Any]) -> dict[str, Any]:
        compacted = dict(payload)
        data = compacted.get("data")
        if not isinstance(data, dict):
            return compacted
        compacted_data = dict(data)
        content = compacted_data.get("content")
        if isinstance(content, str) and len(content) > _SYNTHETIC_CONTEXT_MAX_CHARS:
            compacted_data["content"] = content[:_SYNTHETIC_CONTEXT_MAX_CHARS]
            compacted_data["truncated_for_prompt"] = True
            compacted_data["original_content_chars"] = len(content)
        compacted["data"] = compacted_data
        return compacted

    @staticmethod
    def _empty_final_evidence_telemetry(token_budget: int) -> dict[str, Any]:
        return {
            "token_budget": max(0, token_budget),
            "available_draft_finding_count": 0,
            "included_draft_finding_count": 0,
            "available_tool_result_count": 0,
            "included_tool_result_count": 0,
            "available_concern_count": 0,
            "included_concern_count": 0,
            "validator_result_included": 0,
            "manifest_span_count": 0,
            "available_catalog_count": 0,
            "exposed_catalog_count": 0,
            "historical_ledger_count": 0,
            "included_catalog_count": 0,
            "required_catalog_count": 0,
            "required_catalog_missing_count": 0,
            "required_catalog_ids": [],
            "candidate_evidence_dependencies": {},
            "unresolved_required_catalog_refs": [],
            "included_catalog_ids": [],
            "omitted_catalog_ids": [],
            "catalog_token_count": 0,
            "graph_token_count": 0,
            "source_evidence_token_count": 0,
            "context_insufficient": False,
            "context_insufficient_reason": "",
            "included_count": 0,
            "deduplicated_count": 0,
            "truncated_count": 0,
            "estimated_tokens": 0,
        }

    @classmethod
    def _build_final_submit_evidence_summary(
        cls,
        tool_feedback: list[dict[str, Any]],
        digest_index: dict[str, dict[str, Any]],
        draft_findings: list[DraftFinding],
        *,
        validator_result: dict[str, Any] | None = None,
        candidate_context_manifests: list[dict[str, Any]] | None = None,
        draft_states: list[DraftFindingState] | None = None,
        evidence_ledger: list[dict[str, Any]] | None = None,
        token_budget: int,
    ) -> tuple[Message | None, dict[str, Any]]:
        """Build a bounded, atomic, citation-first submit-only evidence handoff."""

        telemetry = cls._empty_final_evidence_telemetry(token_budget)
        candidates: list[tuple[str, str]] = []
        seen_tools: set[str] = set()

        for draft in draft_findings:
            telemetry["available_draft_finding_count"] += 1
            checkpoint = next(
                (
                    item
                    for item in (draft_states or [])
                    if item.draft_id == draft.id
                ),
                DraftFindingState(draft_id=draft.id),
            )
            location = draft.file
            if draft.line is not None:
                location += f":{draft.line}"
            if draft.symbol:
                location += f" ({draft.symbol})"
            candidates.append(
                (
                    "draft",
                    f"- {draft.id}: {location}\n  status: {checkpoint.status}\n"
                    f"  claim: {draft.claim}"
                    + (
                        f"\n  reason: {checkpoint.reason}"
                        if checkpoint.reason
                        else ""
                    )
                    + (
                        "\n  missing_checks: "
                        + "; ".join(checkpoint.missing_checks)
                        if checkpoint.missing_checks
                        else ""
                    ),
                )
            )

        if validator_result:
            repair_feedback = cls._build_repair_feedback_message(
                validator_result,
                token_budget=max(1, token_budget),
            )
            validator_text = (
                repair_feedback.content
                if repair_feedback is not None
                else "validator_result="
                + serialize_json(cls._compact_validator_result(validator_result))
            )
            candidates.append(
                (
                    "validator",
                    validator_text,
                )
            )

        manifest_evidence = cls._manifest_evidence_for_drafts(
            candidate_context_manifests or [], draft_findings
        )
        for evidence in manifest_evidence:
            candidates.append(("manifest", "- " + evidence))

        for item in reversed(tool_feedback):
            if not isinstance(item, dict):
                continue
            tool_call = item.get("tool_call")
            function_block = (
                tool_call.get("function") if isinstance(tool_call, dict) else None
            )
            if isinstance(function_block, dict):
                name = str(function_block.get("name", "")).strip()
                result_payload = cls._tool_result_payload(item.get("result"))
                if (
                    name in _FINAL_EVIDENCE_TOOL_NAMES
                    and result_payload.get("ok") is True
                ):
                    signature = cls._final_evidence_tool_signature(function_block)
                    if signature in seen_tools:
                        telemetry["deduplicated_count"] += 1
                    else:
                        seen_tools.add(signature)
                        telemetry["available_tool_result_count"] += 1
                        arguments = cls._json_preview(
                            function_block.get("arguments", "{}"), 400
                        )
                        result = cls._json_preview(
                            result_payload, _FINAL_EVIDENCE_ENTRY_MAX_CHARS
                        )
                        candidates.append(
                            (
                                "tool",
                                f"- tool_evidence iter={item.get('iteration')} "
                                f"name={name} args={arguments} result={result}",
                            )
                        )

        folded = sorted(
            digest_index.items(),
            key=lambda item: (
                int(item[1].get("iteration", 0) or 0),
                str(item[1].get("name", "")),
            ),
            reverse=True,
        )
        for signature, record in folded:
            name = str(record.get("name", "")).strip()
            if name not in _FINAL_EVIDENCE_TOOL_NAMES or record.get("ok") is not True:
                continue
            if signature in seen_tools:
                telemetry["deduplicated_count"] += 1
                continue
            seen_tools.add(signature)
            telemetry["available_tool_result_count"] += 1
            candidates.append(
                (
                    "tool",
                    f"- tool_evidence iter={record.get('iteration')} name={name} "
                    f"args={record.get('args_preview', '')} "
                    f"result={record.get('result_preview', '')}",
                )
            )

        delivered_catalog = [
            record
            for record in (evidence_ledger or [])
            if isinstance(record, dict)
            and str(record.get("lifecycle", "delivered")).strip() == "delivered"
            and not bool(record.get("truncated", False))
        ]
        telemetry["historical_ledger_count"] = len(evidence_ledger or [])

        # The model may cite only these delivered records. Exact refs are hard
        # dependencies; same-file records are merely optional background. The
        # old path-based rule made every record in the draft file a required
        # dependency, which inflated the final handoff and was equivalent to
        # nearest-evidence filling.
        draft_paths = {
            normalize_repo_path(draft.file) for draft in draft_findings if draft.file
        }
        selected_refs = {
            str(reference).strip()
            for state in (draft_states or [])
            for reference in state.evidence_refs
            if str(reference).strip()
        }
        gap_paths: set[str] = set()
        gap_refs: set[str] = set()
        candidate_dependencies: dict[str, set[str]] = {}
        for state in draft_states or []:
            refs = {
                str(reference).strip()
                for reference in state.evidence_refs
                if str(reference).strip()
            }
            if refs:
                candidate_dependencies.setdefault(state.draft_id, set()).update(refs)

        def collect_gap_values(value: Any, candidate_id: str = "") -> None:
            if isinstance(value, dict):
                local_candidate_id = str(
                    value.get("candidate_id")
                    or value.get("target_candidate_id")
                    or value.get("draft_id")
                    or candidate_id
                ).strip()
                reference = str(
                    value.get("reference_id") or value.get("artifact_id") or ""
                ).strip()
                if reference:
                    gap_refs.add(reference)
                    if local_candidate_id:
                        candidate_dependencies.setdefault(
                            local_candidate_id, set()
                        ).add(reference)
                location = str(value.get("location", "")).strip()
                if location:
                    gap_paths.add(normalize_location(location).path or "")
                raw_file = str(value.get("file", "")).strip()
                if raw_file:
                    gap_paths.add(normalize_repo_path(raw_file))
                for item in value.values():
                    collect_gap_values(item, local_candidate_id)
            elif isinstance(value, list):
                for item in value:
                    collect_gap_values(item, candidate_id)

        collect_gap_values(validator_result or {})
        exact_refs = selected_refs | gap_refs

        catalog_candidates: list[tuple[int, bool, bool, dict[str, Any], str]] = []
        reference_to_evidence: dict[str, str] = {}
        for record in delivered_catalog:
            # Older in-process callers may hand this helper a pre-ledger
            # artifact record. Treat its exact artifact id as a compatibility
            # alias only; live ledgers always supply the generated evidence_id.
            evidence_id = str(
                record.get("evidence_id") or record.get("artifact_id") or ""
            ).strip()
            artifact_id = str(record.get("artifact_id", "")).strip()
            path = str(record.get("path", record.get("file", ""))).strip()
            start = record.get("start_line", record.get("line", ""))
            end = record.get("end_line", start)
            if not evidence_id or not path:
                continue
            aliases = {
                str(item).strip()
                for item in record.get("aliases", [])
                if str(item).strip()
            }
            ids = {evidence_id, artifact_id, *aliases}
            normalized_path = normalize_repo_path(path)
            for reference_id in ids:
                reference_to_evidence[reference_id] = evidence_id
            exact_ref = bool(ids & exact_refs)
            path_ref = normalized_path in draft_paths or normalized_path in gap_paths
            # Lower score is higher priority. Only an explicit id/reference is
            # required; a same-file record is optional context and never a
            # substitute for an unresolved or missing exact reference.
            score = 0 if exact_ref else 1 if path_ref else 2
            catalog_candidates.append((score, exact_ref, path_ref, record, evidence_id))

        catalog_candidates.sort(
            key=lambda item: (item[0], item[3].get("source_type", ""), item[4])
        )
        telemetry["available_catalog_count"] = len(catalog_candidates)
        required_catalog_ids: list[str] = []
        for score, exact_ref, path_ref, record, evidence_id in catalog_candidates:
            if exact_ref:
                required_catalog_ids.append(evidence_id)
            if exact_ref:
                path = str(record.get("path", record.get("file", ""))).strip()
                start = record.get("start_line", record.get("line", ""))
                end = record.get("end_line", start)
                location = f"{path}:{start}"
                if end not in (None, "", start):
                    location += f"-{end}"
                alias_labels = [
                    str(item).strip()
                    for item in record.get("aliases", [])
                    if str(item).strip() and str(item).strip() != evidence_id
                ]
                body = str(record.get("content", "") or "").replace("\n", "\\n")
                if len(body) > 720:
                    body = body[:700].rstrip() + "...[body preview]"
                candidates.append(
                    (
                        "catalog_required",
                        f"- evidence_catalog evidence_id={evidence_id}"
                        + (f" aliases={','.join(alias_labels)}" if alias_labels else "")
                        + f" location={location} "
                        f"source={record.get('source_type', '')} "
                        f"snapshot={record.get('snapshot_id', '')} "
                        f"revision={record.get('revision', '')}"
                        + (f" content={body}" if body else ""),
                    )
                )
            elif path_ref:
                path = str(record.get("path", record.get("file", ""))).strip()
                start = record.get("start_line", record.get("line", ""))
                end = record.get("end_line", start)
                location = f"{path}:{start}"
                if end not in (None, "", start):
                    location += f"-{end}"
                candidates.append(
                    (
                        "catalog_optional",
                        f"- optional_evidence_catalog evidence_id={evidence_id} "
                        f"location={location} source={record.get('source_type', '')} "
                        f"snapshot={record.get('snapshot_id', '')} "
                        f"revision={record.get('revision', '')}",
                    )
                )

        # If no candidate path is known, expose the catalog as optional choices
        # only. This lets the model select an exact id without turning any
        # nearby record into a hidden dependency.
        if not draft_paths and not gap_paths:
            for _, exact_ref, _, record, evidence_id in catalog_candidates:
                if exact_ref:
                    continue
                path = str(record.get("path", record.get("file", ""))).strip()
                start = record.get("start_line", record.get("line", ""))
                end = record.get("end_line", start)
                location = f"{path}:{start}"
                if end not in (None, "", start):
                    location += f"-{end}"
                candidates.append(
                    (
                        "catalog_optional",
                        f"- optional_evidence_catalog evidence_id={evidence_id} "
                        f"location={location} source={record.get('source_type', '')} "
                        f"snapshot={record.get('snapshot_id', '')} "
                        f"revision={record.get('revision', '')}",
                    )
                )
        telemetry["required_catalog_ids"] = required_catalog_ids
        telemetry["required_catalog_count"] = len(required_catalog_ids)
        telemetry["candidate_evidence_dependencies"] = {
            candidate_id: sorted(refs)
            for candidate_id, refs in sorted(candidate_dependencies.items())
            if refs
        }
        telemetry["unresolved_required_catalog_refs"] = sorted(
            reference for reference in exact_refs if reference not in reference_to_evidence
        )
        unresolved_refs = telemetry["unresolved_required_catalog_refs"]
        if unresolved_refs:
            candidates.append(
                (
                    "validator",
                    "- unresolved_required_evidence_refs="
                    + ",".join(unresolved_refs)
                    + " action=select a delivered exact catalog id or keep the "
                    "candidate unresolved; never substitute by path",
                )
            )

        # Citation choices are hard handoff dependencies. Put them ahead of
        # ordinary draft/graph/tool summaries so a bounded request cannot
        # spend its entire budget on explanatory context and force the model
        # to invent an evidence reference.
        priority = {
            "catalog_required": 0,
            "draft": 1,
            "validator": 2,
            "manifest": 3,
            "tool": 4,
            "catalog_optional": 5,
        }
        candidates.sort(key=lambda item: priority.get(item[0], 99))
        telemetry["exposed_catalog_count"] = sum(
            kind in {"catalog_optional", "catalog_required"} for kind, _ in candidates
        )

        if token_budget <= 0 or not candidates:
            telemetry["truncated_count"] = len(candidates)
            if required_catalog_ids:
                telemetry["required_catalog_missing_count"] = len(
                    required_catalog_ids
                )
                telemetry["omitted_catalog_ids"] = [
                    {"id": item, "reason": "final_submit_feedback_budget_zero"}
                    for item in required_catalog_ids
                ]
                telemetry["context_insufficient"] = True
                telemetry["context_insufficient_reason"] = (
                    "required_delivered_catalog_entries_do_not_fit"
                )
            return None, telemetry

        builder = ContextBuilder()
        lines = [
            "final_submit_evidence_summary:",
            "Known draft findings are investigation hypotheses, not automatic final "
            "findings. Decide whether retained evidence supports submitting each one. "
            "Do not discard a supported concern merely because the exploration turn "
            "ended at the length limit.",
        ]
        if draft_findings:
            lines.append("Known draft findings:")
        if builder.estimate_tokens("\n".join(lines)) > token_budget:
            telemetry["truncated_count"] = len(candidates)
            if required_catalog_ids:
                telemetry["required_catalog_missing_count"] = len(
                    required_catalog_ids
                )
                telemetry["omitted_catalog_ids"] = [
                    {"id": item, "reason": "summary_header_does_not_fit"}
                    for item in required_catalog_ids
                ]
                telemetry["context_insufficient"] = True
                telemetry["context_insufficient_reason"] = (
                    "required_delivered_catalog_entries_do_not_fit"
                )
            return None, telemetry

        full_included = 0
        omitted = 0
        for kind, candidate in candidates:
            proposed = "\n".join([*lines, candidate])
            if builder.estimate_tokens(proposed) <= token_budget:
                lines.append(candidate)
                full_included += 1
            else:
                # Entries are atomic: never cut an id/location/body line in
                # half. A required catalog item becoming unavailable is an
                # explicit handoff failure, not a successful partial submit.
                omitted += 1
                if kind == "catalog_required":
                    telemetry["required_catalog_missing_count"] += 1
                if kind in {"catalog_optional", "catalog_required"}:
                    omitted_id = (
                        candidate.split(" evidence_id=", 1)[-1].split(" ", 1)[0]
                    )
                    telemetry["omitted_catalog_ids"].append(
                        {
                            "id": omitted_id,
                            "reason": (
                                "required_entry_does_not_fit"
                                if kind == "catalog_required"
                                else "optional_entry_does_not_fit"
                            ),
                        }
                    )
                continue
            telemetry["included_count"] += 1
            if kind == "draft":
                telemetry["included_draft_finding_count"] += 1
            elif kind == "tool":
                telemetry["included_tool_result_count"] += 1
            elif kind == "validator":
                telemetry["validator_result_included"] += 1
            elif kind == "manifest":
                telemetry["manifest_span_count"] += 1
            elif kind in {"catalog_optional", "catalog_required"}:
                # Catalog entries are identity hints; the full tool-result
                # counters remain reserved for observed tool payloads.
                telemetry["included_catalog_count"] += 1
                evidence_id = (
                    candidate.split(" evidence_id=", 1)[-1].split(" ", 1)[0]
                )
                telemetry["included_catalog_ids"].append(evidence_id)
            entry_tokens = builder.estimate_tokens(candidate)
            if kind in {"catalog_optional", "catalog_required"}:
                telemetry["catalog_token_count"] += entry_tokens
            elif kind == "manifest":
                telemetry["graph_token_count"] += entry_tokens
            elif kind == "tool":
                telemetry["source_evidence_token_count"] += entry_tokens
        telemetry["truncated_count"] = max(omitted, len(candidates) - full_included)
        missing_required = set(required_catalog_ids) - set(
            telemetry["included_catalog_ids"]
        )
        if missing_required:
            telemetry["required_catalog_missing_count"] = len(missing_required)
            telemetry["context_insufficient"] = True
            telemetry["context_insufficient_reason"] = (
                "required_delivered_catalog_entries_do_not_fit"
            )
        content = "\n".join(lines)
        telemetry["estimated_tokens"] = builder.estimate_tokens(content)
        return Message(role="user", content=content, preserve_on_trim=True), telemetry

    @staticmethod
    def _compact_validator_result(result: dict[str, Any]) -> dict[str, Any]:
        """Keep only validator decisions needed by a submit-only reviewer."""

        compact: dict[str, Any] = {}
        for key in (
            "validated_draft_ids",
            "validated_finding_ids",
            "validator_passed",
            "submit_allowed",
            "effective_issue_count",
            "unresolved_evidence_gaps",
            "rejected_candidates",
            "policy_warnings",
            "repair_instruction",
        ):
            if key in result:
                compact[key] = result[key]
        issue_results = result.get("issue_results")
        if isinstance(issue_results, list):
            compact["issue_results"] = [
                {
                    key: item[key]
                    for key in (
                        "original_index",
                        "normalized_location",
                        "severity",
                        "passes_current_filter",
                        "fail_reasons",
                    )
                    if key in item
                }
                for item in issue_results[:16]
                if isinstance(item, dict)
            ]
        return compact

    @classmethod
    def _build_repair_feedback_message(
        cls,
        result: dict[str, Any] | None,
        *,
        token_budget: int | None = None,
    ) -> Message | None:
        """Return atomic candidate repair protocols for exploration turns.

        A repair protocol is never JSON-previewed or character-truncated.  If
        the feedback budget cannot carry every target, complete protocols are
        selected in order and the remaining target ids are explicitly deferred;
        the runtime keeps their original findings unchanged.
        """

        if not isinstance(result, dict):
            return None
        gap_items = result.get("unresolved_evidence_gaps")
        rejected_items = result.get("rejected_candidates")
        actionable = bool(gap_items) or bool(rejected_items)
        if not actionable and result.get("validator_passed") is True:
            return None
        if not isinstance(gap_items, list) and not isinstance(rejected_items, list):
            return None
        raw_items = [
            item
            for source in (gap_items, rejected_items)
            if isinstance(source, list)
            for item in source
            if isinstance(item, dict)
        ]
        if not raw_items:
            return None

        opaque_handle_items = [
            item
            for item in raw_items
            if str(item.get("target_handle", "") or "").strip()
        ]
        if opaque_handle_items:
            opaque_protocols: list[tuple[str, str]] = []
            seen_handles: set[str] = set()
            for item in opaque_handle_items:
                handle = str(item.get("target_handle", "") or "").strip()
                if not handle or handle in seen_handles:
                    continue
                seen_handles.add(handle)
                gaps = item.get("gaps", [])
                action_lines = [
                    str(gap.get("required_action", "")).strip()
                    for gap in gaps
                    if isinstance(gap, dict)
                    and str(gap.get("required_action", "")).strip()
                ]
                action = " ".join(dict.fromkeys(action_lines)) or (
                    "Preserve the runtime-owned finding if this target cannot be repaired."
                )
                protocol = "\n".join(
                    [
                        "opaque_repair_target:",
                        f"target_handle={handle}",
                        f"status={str(item.get('status', '')).strip()}",
                        "candidate_content="
                        + serialize_json(item.get("candidate_content", {})),
                        "gaps=" + serialize_json(gaps),
                        "required_action=" + action,
                    ]
                )
                opaque_protocols.append((handle, protocol))
            if not opaque_protocols:
                return None
            prefix = (
                "repair_review_feedback (this is not completion): address only the "
                "listed opaque target_handle values, then call repair_review. Each "
                "item must include repair_status. For repaired, include only the "
                "semantic fields that changed under repair_patch; omitted fields "
                "inherit the runtime-owned candidate. Use delete_fields for an "
                "explicit deletion and never use null to mean omission. Do not "
                "emit candidate ids, finding ids, content versions, snapshots, "
                "hashes, or a full finding object.\n"
            )
            builder = ContextBuilder()
            opaque_selected: list[str] = []
            opaque_deferred: list[str] = []
            limit = None if token_budget is None else max(1, int(token_budget))
            for handle, protocol in opaque_protocols:
                proposed = prefix + "\n".join([*opaque_selected, protocol])
                if opaque_selected and limit is not None and builder.estimate_tokens(proposed) > limit:
                    opaque_deferred.append(handle)
                    continue
                opaque_selected.append(protocol)
            if opaque_deferred:
                opaque_selected.append(
                    "deferred_target_handles=" + ",".join(opaque_deferred) + "\n"
                    "These targets were not included in this model-facing repair "
                    "message; the runtime preserves their original findings."
                )
            return Message(
                role="user",
                content=prefix + "\n".join(opaque_selected),
                preserve_on_trim=True,
            )

        if not any(
            str(item.get("target_candidate_id") or item.get("candidate_id") or "").strip()
            for item in raw_items
        ):
            return Message(
                role="user",
                content=(
                    "initial_submission_feedback (this is not a repair transaction): "
                    "the runtime has not registered a candidate identity yet. "
                    "Complete the initial submit_review using the semantic fields and "
                    "delivered evidence catalog. Do not invent a candidate id, finding "
                    "id, content version, Graph id, draft id, hash, or repository "
                    "revision; target_candidate_id and candidate_content_version are "
                    "not active until the runtime returns an exact repair transaction.\n"
                    + serialize_json({"gaps": raw_items})
                ),
                preserve_on_trim=True,
            )

        protocols: list[tuple[str, str]] = []
        seen_targets: set[str] = set()
        for index, item in enumerate(raw_items):
            target = str(
                item.get("target_candidate_id") or item.get("candidate_id") or ""
            ).strip()
            if not target:
                continue
            dedupe_target = target
            if dedupe_target in seen_targets:
                continue
            seen_targets.add(dedupe_target)
            display_target = dedupe_target
            original_finding = item.get("original_contents", {})
            gaps = item.get("gaps", [])
            action_lines = [
                str(gap.get("required_action", "")).strip()
                for gap in gaps
                if isinstance(gap, dict) and str(gap.get("required_action", "")).strip()
            ]
            action = " ".join(dict.fromkeys(action_lines)) or (
                "Preserve the original finding if this target cannot be repaired."
            )
            protocol = "\n".join(
                [
                    "candidate_repair_protocol:",
                    f"target_candidate_id={display_target}",
                    f"current_finding_id={str(item.get('current_finding_id', '')).strip()}",
                    f"candidate_content_version={str(item.get('candidate_content_version', item.get('content_hash', ''))).strip()}",
                    f"integrity_status={str(item.get('status', '')).strip()}",
                    "original_finding=" + serialize_json(original_finding),
                    "gaps=" + serialize_json(gaps),
                    "required_action=" + action,
                ]
            )
            protocols.append((display_target, protocol))

        if not protocols:
            return None
        prefix = (
            "candidate_repair_feedback (this is not completion): address only the "
            "listed exact runtime targets, then submit again. Each returned issue "
            "must carry the exact target_candidate_id, candidate_content_version, "
            "and repair_status. Prefer a repair_patch containing only changed "
            "semantic fields; do not rewrite the full finding to add one trigger, "
            "support role, or evidence reference. Use repair_status=repaired only "
            "after the same canonical integrity rules can pass; otherwise return "
            "the target with unchanged, incomplete, or deferred plus a reason. "
            "Never guess an evidence id, path, snapshot, hash, or range.\n"
        )
        builder = ContextBuilder()
        selected: list[str] = []
        deferred: list[str] = []
        limit = None if token_budget is None else max(1, int(token_budget))
        for target, protocol in protocols:
            proposed = prefix + "\n".join([*selected, protocol])
            if selected and limit is not None and builder.estimate_tokens(proposed) > limit:
                deferred.append(target)
                continue
            # Keep one complete candidate protocol even when it alone exceeds
            # the advisory feedback slice; RequestAssembler will then make the
            # whole request incomplete rather than cutting this protocol.
            selected.append(protocol)
        if deferred:
            selected.append(
                "deferred_target_candidate_ids=" + ",".join(deferred) + "\n"
                "These targets were not included in this repair transaction; "
                "the runtime preserves their original findings and does not count "
                "them as repaired."
            )
        return Message(
            role="user",
            content=prefix + "\n".join(selected),
            preserve_on_trim=True,
        )

    @staticmethod
    def _manifest_evidence_for_drafts(
        manifests: list[dict[str, Any]], drafts: list[DraftFinding]
    ) -> list[str]:
        """Select small manifest id/hash-bound spans relevant to known drafts."""

        if not manifests or not drafts:
            return []
        output: list[str] = []
        for manifest in manifests:
            manifest_id = str(manifest.get("candidate_id", "")).strip()
            if not manifest_id:
                continue
            raw_spans = manifest.get("included_spans", [])
            if not isinstance(raw_spans, list):
                continue
            selected: list[dict[str, Any]] = []
            for span in raw_spans:
                if not isinstance(span, dict):
                    continue
                path = str(span.get("file", "")).replace("\\", "/").lstrip("./")
                try:
                    start = int(span.get("start_line", 0) or 0)
                    end = int(span.get("end_line", start) or start)
                except (TypeError, ValueError):
                    continue
                if any(
                    draft.file.replace("\\", "/").lstrip("./") == path
                    and (draft.line is None or start <= draft.line <= end)
                    for draft in drafts
                ):
                    content = str(span.get("content", "") or "")
                    if len(content) > 640:
                        content = content[:640].rstrip() + "\n...[truncated]"
                    selected.append(
                        {
                            "file": path,
                            "start_line": start,
                            "end_line": end,
                            "symbol_id": span.get("symbol_id", ""),
                            "role": span.get("role", ""),
                            "content": content,
                            "retrieval_source": span.get("retrieval_source", ""),
                            "context_hash": span.get("context_hash", ""),
                        }
                    )
                if len(selected) >= 3:
                    break
            if selected:
                output.append(
                    "manifest_evidence manifest_id="
                    + manifest_id
                    + " spans="
                    + serialize_json(selected)
                )
        return output

    @staticmethod
    def _build_review_handoff(
        state: ContextState,
        *,
        diff_text: str,
        file_contents: dict[str, str],
        draft_findings: list[DraftFinding],
        tool_feedback: list[dict[str, Any]],
    ) -> ReviewHandoff:
        """Preserve the smallest useful change facts for final submission.

        The handoff is deliberately source-first: changed hunks and visible
        manifest spans survive even when no draft pseudo-call was recorded.
        Full historical tool messages remain in the separate bounded digest.
        """

        changed_diff, diff_gaps = InferenceEngine._complete_diff_handoff(
            diff_text, char_limit=14_000
        )
        selected_files: dict[str, str] = {}
        draft_paths = {
            item.file.replace("\\", "/").lstrip("./") for item in draft_findings
        }
        changed_paths = {
            str(manifest.get("changed_anchor", {}).get("file", ""))
            .replace("\\", "/")
            .lstrip("./")
            for manifest in state.candidate_context_manifests
            if isinstance(manifest.get("changed_anchor"), dict)
        }
        wanted = draft_paths | {item for item in changed_paths if item}
        covered_paths = {
            str(span.get("file", span.get("path", "")))
            .replace("\\", "/")
            .lstrip("./")
            for manifest in state.candidate_context_manifests
            for span in manifest.get("included_spans", [])
            if isinstance(span, dict) and str(span.get("content", "") or "")
        }
        for path, content in file_contents.items():
            normalized = path.replace("\\", "/").lstrip("./")
            if (not wanted or normalized in wanted) and normalized not in covered_paths:
                selected_files[normalized] = InferenceEngine._truncate_text_to_chars(
                    content, 8_000
                )
            if len(selected_files) >= 8:
                break
        gaps: list[str] = list(diff_gaps)
        if not changed_diff and not selected_files:
            gaps.append("changed_source_not_available_in_submit_handoff")
        if not draft_findings:
            gaps.append("no_draft_finding_recorded")
        manifests = [dict(item) for item in state.candidate_context_manifests]
        if not changed_diff and not state.evidence_ledger and not draft_findings:
            manifests = []
        return ReviewHandoff(
            changed_diff=changed_diff,
            file_contents=selected_files,
            candidate_context_manifests=manifests,
            evidence_ledger=list(state.evidence_ledger),
            evidence_gaps=gaps,
            has_draft_findings=bool(draft_findings),
        )

    @staticmethod
    def _complete_diff_handoff(
        diff_text: str,
        *,
        char_limit: int,
    ) -> tuple[str, list[str]]:
        """Return only complete unified-diff hunks for a bounded handoff."""

        if not diff_text or "@@" not in diff_text:
            return "", []
        parsed = parse_unified_diff_hunks(diff_text)
        if not parsed:
            return "", ["changed_diff_unparseable"]

        def hunk_is_complete(hunk: ParsedDiffHunk) -> bool:
            old_seen = 0
            new_seen = 0
            for line in hunk.lines:
                if line.startswith("\\"):
                    continue
                if line.startswith("+") and not line.startswith("+++"):
                    new_seen += 1
                elif line.startswith("-") and not line.startswith("---"):
                    old_seen += 1
                else:
                    old_seen += 1
                    new_seen += 1
            return old_seen == hunk.old_count and new_seen == hunk.new_count

        if len(diff_text) <= char_limit and all(
            hunk_is_complete(hunk)
            for hunks in parsed.values()
            for hunk in hunks
        ):
            return diff_text, []

        chunks: list[str] = []
        gaps: list[str] = []
        used = 0
        for path, hunks in parsed.items():
            for index, hunk in enumerate(hunks):
                if not hunk_is_complete(hunk):
                    gaps.append(f"changed_hunk_incomplete:{path}:{index}")
                    continue
                chunk = "\n".join(
                    [
                        f"diff --git a/{path} b/{path}",
                        f"--- a/{path}",
                        f"+++ b/{path}",
                        hunk.header,
                        *hunk.lines,
                    ]
                )
                extra = len(chunk) + (1 if chunks else 0)
                if used + extra > char_limit:
                    gaps.append(f"changed_hunk_omitted:{path}:{index}")
                    continue
                chunks.append(chunk)
                used += extra
        if not chunks:
            gaps.append("changed_source_not_available_in_submit_handoff")
        elif len(diff_text) > char_limit:
            gaps.append("changed_diff_bounded_to_complete_hunks")
        return "\n".join(chunks), list(dict.fromkeys(gaps))

    @staticmethod
    def _truncate_text_to_chars(text: str, limit: int) -> str:
        if len(text) <= limit:
            return text
        return text[: max(0, limit - 40)].rstrip() + "\n...[handoff truncated]"

    @staticmethod
    def _tool_result_payload(result: Any) -> dict[str, Any]:
        if isinstance(result, ToolResult):
            return result.model_dump()
        if isinstance(result, dict):
            return result
        return {"ok": False, "error": "invalid_tool_result"}

    @staticmethod
    def _final_evidence_tool_signature(function_block: dict[str, Any]) -> str:
        name = str(function_block.get("name", "")).strip()
        arguments = function_block.get("arguments", "{}")
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments)
            except Exception:  # noqa: BLE001
                parsed = {"raw": arguments}
        else:
            parsed = arguments
        serialized = serialize_json(parsed)
        return f"{name}:{hashlib.sha256(serialized.encode('utf-8')).hexdigest()}"

    @staticmethod
    def _json_preview(value: Any, max_chars: int) -> str:
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except Exception:  # noqa: BLE001
                parsed = value
        else:
            parsed = value
        try:
            serialized = serialize_json(parsed)
        except Exception:  # noqa: BLE001
            serialized = str(parsed)
        if len(serialized) <= max_chars:
            return serialized
        return serialized[: max(0, max_chars - 14)] + "...[truncated]"

    @staticmethod
    def _truncate_text_to_tokens(
        text: str,
        token_budget: int,
        builder: ContextBuilder,
    ) -> str:
        if token_budget <= 0 or not text:
            return ""
        if builder.estimate_tokens(text) <= token_budget:
            return text
        low = 0
        high = len(text)
        suffix = "...[truncated]"
        while low < high:
            middle = (low + high + 1) // 2
            candidate = text[:middle].rstrip() + suffix
            if builder.estimate_tokens(candidate) <= token_budget:
                low = middle
            else:
                high = middle - 1
        if low < 32:
            return ""
        return text[:low].rstrip() + suffix

    @staticmethod
    def _build_folded_feedback_summary(
        digest_index: dict[str, dict[str, Any]],
        window_iterations: set[Any],
    ) -> Message | None:
        """Produce a compact summary of prior tool results whose iterations are no longer
        part of the in-window feedback (so the model remembers them without reloading)."""
        if not digest_index:
            return None
        folded = [
            record
            for record in digest_index.values()
            if record.get("iteration") not in window_iterations
        ]
        if not folded:
            return None
        folded.sort(key=lambda item: (item.get("iteration", 0), item.get("name", "")))
        lines = [
            "prior_tool_results_summary: the following tool calls were already executed in earlier "
            "iterations of this run. Their full results are no longer in context, but you must NOT "
            "re-request them with the same arguments — synthesize using these summaries.",
        ]
        for record in folded:
            lines.append(
                f"- iter={record.get('iteration')} name={record.get('name')} "
                f"ok={record.get('ok')} args={record.get('args_preview')} "
                f"result={record.get('result_preview')}"
            )
        return Message(role="user", content="\n".join(lines))

    @staticmethod
    def _build_failure_guidance_message(
        tool_feedback: list[dict[str, Any]],
    ) -> Message | None:
        failed: list[str] = []
        for item in tool_feedback:
            result = item.get("result")
            payload: dict[str, Any]
            if isinstance(result, ToolResult):
                payload = result.model_dump()
            elif isinstance(result, dict):
                payload = result
            else:
                continue
            if payload.get("ok") is not False:
                continue
            call = item.get("tool_call", {}) if isinstance(item, dict) else {}
            fn = ""
            if isinstance(call, dict):
                fn_block = call.get("function", {})
                if isinstance(fn_block, dict):
                    fn = str(fn_block.get("name", "")).strip()
            error = str(payload.get("error") or "")
            recommendation = ""
            data = payload.get("data")
            if isinstance(data, dict):
                recommendation = str(data.get("recommended_next_step", "")).strip()
            failed.append(
                f"- tool={fn or 'unknown'} error={error} next={recommendation or 'inspect args'}"
            )
        if not failed:
            return None
        return Message(
            role="user",
            content=(
                "Tool failures observed. Do not blindly retry the same path/args. "
                "If path is uncertain, run list_dir on parent directory first.\n"
                + "\n".join(failed[:8])
            ),
        )

    def _record_trace(
        self,
        response: ModelResponse,
        plan: AnalysisPlan,
        parse_meta: dict[str, Any],
        iteration: int,
        fallback_json_found: bool,
        fallback_parse_valid: bool,
    ) -> None:
        if (
            self._trace_recorder is None
            or self._trace_event_writer is None
            or not self._trace_recorder.allows_detail()
        ):
            return
        self._trace_recorder.record(
            self._trace_event_writer,
            EventType.MODEL_RESPONSE_DETAIL,
            "analyze",
            {
                "iteration": iteration,
                "model": response.model,
                "finish_reason": response.finish_reason,
                "usage": response.usage.model_dump(),
                "assistant_content_preview": self._trace_recorder.build_text_preview(
                    response.content
                ),
                "content_length": len(response.content),
                "tool_choice": parse_meta.get("tool_choice"),
                "thinking_disabled": bool(parse_meta.get("thinking_disabled")),
                "tool_call_summaries": self._trace_recorder.build_tool_call_summaries(
                    response.tool_calls
                ),
            },
        )
        self._trace_recorder.record(
            self._trace_event_writer,
            EventType.PLAN_PARSED,
            "analyze",
            {
                "iteration": iteration,
                "needs_tools": plan.needs_tools,
                "tool_calls_count": len(plan.tool_calls),
                "has_draft_review": plan.draft_review is not None,
                "has_draft_debug": plan.draft_debug is not None,
                "draft_finding_call_count": len(plan.draft_finding_calls),
                "draft_finding_validation_errors": parse_meta.get(
                    "draft_finding_validation_errors", []
                ),
                "draft_finding_update_count": len(plan.draft_finding_updates),
                "draft_finding_update_validation_errors": parse_meta.get(
                    "draft_finding_update_validation_errors", []
                ),
                "valid_draft_call_ids": parse_meta.get("valid_draft_call_ids", []),
                "valid_draft_update_call_ids": parse_meta.get(
                    "valid_draft_update_call_ids", []
                ),
                "submit_review_seen": bool(parse_meta.get("submit_review_seen")),
                "submit_debug_seen": bool(parse_meta.get("submit_debug_seen")),
                "submit_review_validation_error": self._trace_recorder.build_text_preview(
                    str(parse_meta.get("submit_review_validation_error", ""))
                ),
                "submit_review_arguments_normalized": bool(
                    parse_meta.get("submit_review_arguments_normalized")
                ),
                "submit_debug_validation_error": self._trace_recorder.build_text_preview(
                    str(parse_meta.get("submit_debug_validation_error", ""))
                ),
                "location_warnings": parse_meta.get("location_warnings", []),
                "fallback_json_found": fallback_json_found,
                "fallback_parse_valid": fallback_parse_valid,
                "incomplete_reason": parse_meta.get("incomplete_reason", ""),
                "recovery_required": plan.recovery_required,
                "model_finish_reason": plan.model_finish_reason,
                "final_submit_evidence_included_count": (
                    plan.final_submit_evidence_included_count
                ),
                "final_submit_evidence_token_count": (
                    plan.final_submit_evidence_token_count
                ),
                "final_submit_evidence_truncated_count": (
                    plan.final_submit_evidence_truncated_count
                ),
                "force_submit_discarded_count": parse_meta.get(
                    "force_submit_discarded_count", 0
                ),
                "schema_repair_attempted_count": plan.schema_repair_attempted_count,
                "schema_repair_skipped_budget": bool(
                    parse_meta.get("schema_repair_skipped_budget")
                ),
            },
        )

    def _record_context_telemetry(
        self,
        *,
        context_telemetry: dict[str, Any],
        messages: list[Message],
        tools: list[dict[str, Any]],
        config: ModelConfig,
        policy: ModelCallPolicy,
        file_contents: dict[str, str],
        tool_feedback: list[dict[str, Any]],
        conversation_history_count: int,
        iteration: int,
        prompt_input_token_budget: int,
        base_context_token_budget: int,
        final_submit_feedback_token_budget: int,
        final_evidence_telemetry: dict[str, Any],
        force_submit: bool,
        stage: str = "explore",
        relation_graph_summary: dict[str, Any] | None = None,
        assembled_request: AssembledRequest | None = None,
        assembled_request_budget: int | None = None,
    ) -> None:
        if self._trace_event_writer is None:
            return
        builder = ContextBuilder()
        message_tokens = sum(builder.estimate_tokens(item.content) for item in messages)
        tool_schema_json = serialize_json(tools)
        tool_schema_tokens = builder.estimate_tokens(tool_schema_json)
        message_shapes = [
            {
                "index": index,
                "role": item.role,
                "chars": len(item.content),
                "estimated_tokens": builder.estimate_tokens(item.content),
                "component": self._message_component(item),
            }
            for index, item in enumerate(messages)
        ]
        role_counts = {
            role: sum(item.role == role for item in messages)
            for role in ("system", "user", "assistant", "tool")
        }
        role_chars = {
            role: sum(len(item.content) for item in messages if item.role == role)
            for role in role_counts
        }
        tool_shapes = [self._tool_schema_shape(item, builder) for item in tools]
        assembled_request_text = (
            assembled_request.serialized_payload
            if assembled_request is not None
            and assembled_request.serialized_payload
            else serialize_json(
                {
                    "model": config.model,
                    "messages": [self._safe_wire_message(item) for item in messages],
                    "temperature": config.temperature,
                    "max_tokens": config.max_tokens,
                    "top_p": config.top_p,
                    "tools": tools,
                    "tool_choice": config.tool_choice,
                    "extra_body": config.extra_body,
                    "thinking": policy.thinking,
                    "forced_tool": policy.forced_tool,
                }
            )
        )
        try:
            decoded_request = json.loads(assembled_request_text)
        except json.JSONDecodeError:
            decoded_request = {}
        decoded_messages = (
            decoded_request.get("messages")
            if isinstance(decoded_request, dict)
            else None
        )
        wire_messages = (
            decoded_messages
            if isinstance(decoded_messages, list)
            else [self._safe_wire_message(item) for item in messages]
        )
        assembled_request_chars = len(assembled_request_text)
        assembled_request_tokens = estimate_tokens(assembled_request_text)
        component_records = self._build_component_records(
            messages=messages,
            tools=tools,
            tool_feedback=tool_feedback,
            relation_graph_summary=relation_graph_summary or {},
            wire_messages=wire_messages,
            assembled_request_text=assembled_request_text,
        )
        component_token_sum = sum(
            int(item["estimated_tokens"])
            for item in component_records
            if item["component"] != "assembled_request_total"
        )
        prefetch_coverage = self._measure_prefetch_coverage(
            file_contents,
            tool_feedback,
            selected_file_complete_lines=context_telemetry.get(
                "selected_file_complete_lines", {}
            ),
        )
        self._trace_event_writer(
            EventType.CONTEXT_TELEMETRY,
            "analyze",
            {
                "iteration": iteration,
                "prompt_input_token_budget": prompt_input_token_budget,
                "base_context_token_budget": base_context_token_budget,
                "final_submit_feedback_token_budget": (
                    final_submit_feedback_token_budget
                ),
                "estimated_message_tokens": message_tokens,
                "estimated_tool_schema_tokens": tool_schema_tokens,
                "estimated_prompt_tokens": message_tokens + tool_schema_tokens,
                "assembled_request_estimated_tokens": assembled_request_tokens,
                "assembled_request_token_budget": assembled_request_budget,
                "assembled_request_within_budget": (
                    assembled_request is None
                    or assembled_request.estimated_tokens
                    <= int(assembled_request_budget or 0)
                ),
                "assembled_request_trimmed": bool(
                    assembled_request and assembled_request.trimmed
                ),
                "assembled_request_dropped_message_count": int(
                    assembled_request.dropped_message_count
                    if assembled_request is not None
                    else 0
                ),
                "assembled_request_hash": (
                    assembled_request.request_hash if assembled_request else ""
                ),
                "component_token_sum": component_token_sum,
                "assembled_envelope_overhead_tokens": max(
                    0, assembled_request_tokens - component_token_sum
                ),
                "tokenizer": "cl100k_base",
                "message_count": len(messages),
                "message_count_by_role": role_counts,
                "message_chars": sum(len(item.content) for item in messages),
                "message_chars_by_role": role_chars,
                "message_shapes": message_shapes,
                "conversation_history_count": conversation_history_count,
                "tool_schema_chars": len(tool_schema_json),
                "tool_schema_shapes": tool_shapes,
                "assembled_request_chars": assembled_request_chars,
                "component_records": component_records,
                "max_output_tokens": config.max_tokens,
                "effective_stage_output_token_budget": config.max_tokens,
                "effective_stage_output_token_budgets": {
                    "explore": get_settings().exploration_max_output_tokens,
                    "validate": get_settings().exploration_max_output_tokens,
                    "submit_only": get_settings().submit_max_output_tokens,
                },
                "thinking": policy.thinking,
                "stage": stage,
                "forced_tool": policy.forced_tool or "none",
                "prefetch_coverage": prefetch_coverage,
                "force_submit": force_submit,
                "final_submit_evidence": final_evidence_telemetry,
                "tool_schema_count": len(tools),
                **context_telemetry,
            },
        )

    @staticmethod
    def _validate_final_submit_request_context(
        assembled_request: AssembledRequest,
        telemetry: dict[str, Any],
        *,
        budget: int,
    ) -> dict[str, Any]:
        """Validate the exact serialized request, not the pre-fit message list."""

        serialized = assembled_request.serialized_payload or ""
        required = [
            str(item).strip()
            for item in telemetry.get("required_catalog_ids", [])
            if str(item).strip()
        ]
        missing = [
            item
            for item in required
            if re.search(
                rf"(?<![A-Za-z0-9_])(?:evidence_)?id={re.escape(item)}(?![A-Za-z0-9_])",
                serialized,
            )
            is None
        ]
        if missing:
            return {
                "valid": False,
                "reason": "required_delivered_catalog_entries_missing_from_serialized_request",
                "missing_catalog_ids": missing,
                "serialized_request_within_budget": assembled_request.estimated_tokens
                <= max(1, budget),
            }
        if assembled_request.estimated_tokens > max(1, budget):
            return {
                "valid": False,
                "reason": "serialized_submit_request_over_budget",
                "missing_catalog_ids": [],
                "serialized_request_within_budget": False,
            }
        return {
            "valid": True,
            "reason": "",
            "missing_catalog_ids": [],
            "serialized_request_within_budget": True,
        }

    @classmethod
    def _record_delivered_review_evidence(
        cls,
        state: ContextState,
        assembled_request: AssembledRequest,
        tool_feedback: list[dict[str, Any]],
        *,
        repo_path: str,
    ) -> None:
        """Register only source bodies present in the successful wire request.

        Prompt construction and graph planning happen before the final request
        cap is applied.  Reading the post-assembly payload here prevents a
        selected-but-dropped source span, a summary replacement, or an invalid
        shortened JSON body from becoming verifier evidence by implication.
        """

        try:
            wire_payload = json.loads(assembled_request.serialized_payload)
        except (TypeError, json.JSONDecodeError):
            return
        if not isinstance(wire_payload, dict):
            return
        raw_messages = wire_payload.get("messages")
        if not isinstance(raw_messages, list):
            return
        review_payload = cls._extract_review_payload(raw_messages)
        if review_payload is None:
            return

        actual_files: dict[str, str] = {}
        raw_files = review_payload.get("files")
        summarized = {
            str(item).strip()
            for item in review_payload.get("summarized", [])
            if isinstance(item, str)
        }
        if isinstance(raw_files, dict):
            for raw_path, raw_content in raw_files.items():
                if not isinstance(raw_content, str) or not raw_content:
                    continue
                path = normalize_repo_path(str(raw_path))
                if not path or f"file:{path}" in summarized:
                    continue
                if cls._contains_request_shortening_marker(raw_content):
                    continue
                actual_files[path] = raw_content

        raw_diff = review_payload.get("diff_text")
        if not isinstance(raw_diff, str) or not raw_diff:
            raw_diff = review_payload.get("diff_loaded")
        actual_diff = (
            raw_diff
            if isinstance(raw_diff, str)
            and raw_diff
            and not any(
                item.startswith("diff_hunk_") for item in summarized
            )
            and "[SUMMARIZED]" not in raw_diff
            and not cls._contains_request_shortening_marker(raw_diff)
            else ""
        )

        delivered_manifests = cls._delivered_manifest_sources(
            review_payload.get("candidate_context_manifests"),
            state.candidate_context_manifests,
            snapshot_id=state.evidence_snapshot_id,
            revision=state.evidence_revision,
        )
        try:
            workspace_root = Path(repo_path).resolve()
        except (OSError, ValueError):
            workspace_root = None
        captured_tools = capture_verifier_tool_evidence(
            tool_feedback,
            workspace_root,
            snapshot_id=state.evidence_snapshot_id,
            revision=state.evidence_revision,
        )
        delivered_tools = cls._delivered_tool_evidence(
            captured_tools,
            raw_messages,
            workspace_root=workspace_root,
        )
        state.evidence_ledger = ledger_from_sources(
            tool_evidence=delivered_tools,
            context_manifests=delivered_manifests,
            diff_text=actual_diff,
            file_contents=actual_files,
            existing_payload=state.evidence_ledger,
            snapshot_id=state.evidence_snapshot_id,
            revision=state.evidence_revision,
        ).to_payload()

    @staticmethod
    def _extract_review_payload(
        raw_messages: list[Any],
    ) -> dict[str, Any] | None:
        """Decode the unshortened reviewer JSON from a wire message list."""

        for raw_message in raw_messages:
            if not isinstance(raw_message, dict):
                continue
            if raw_message.get("role") != "user":
                continue
            content = raw_message.get("content")
            if not isinstance(content, str):
                continue
            prefix = (
                USER_PREFIX_REVIEW_V3
                if content.startswith(USER_PREFIX_REVIEW_V3)
                else USER_PREFIX_REVIEW
                if content.startswith(USER_PREFIX_REVIEW)
                else ""
            )
            if not prefix:
                continue
            try:
                payload = json.loads(content[len(prefix) :])
            except (TypeError, json.JSONDecodeError):
                return None
            return payload if isinstance(payload, dict) else None
        return None

    @staticmethod
    def _contains_request_shortening_marker(value: str) -> bool:
        """Identify bodies that the request assembler explicitly shortened."""

        return any(
            marker in value
            for marker in (
                "...[handoff truncated]",
                "[request context shortened; retrieve missing evidence]",
            )
        )

    @classmethod
    def _delivered_manifest_sources(
        cls,
        raw_manifests: Any,
        source_manifests: list[dict[str, Any]],
        *,
        snapshot_id: str,
        revision: str,
    ) -> list[dict[str, Any]]:
        """Restore system identity only for body-bearing spans in the payload."""

        if not isinstance(raw_manifests, list):
            return []
        sources_by_id = {
            str(item.get("candidate_id", "")).strip(): item
            for item in source_manifests
            if isinstance(item, dict) and str(item.get("candidate_id", "")).strip()
        }
        delivered: list[dict[str, Any]] = []
        for raw_manifest in raw_manifests:
            if not isinstance(raw_manifest, dict):
                continue
            candidate_id = str(raw_manifest.get("candidate_id", "")).strip()
            source_manifest = sources_by_id.get(candidate_id)
            if source_manifest is None:
                continue
            source_spans = [
                span
                for span in source_manifest.get("included_spans", [])
                if isinstance(span, dict)
            ]
            source_by_id = {
                str(span.get("span_id", "")).strip(): span
                for span in source_spans
                if str(span.get("span_id", "")).strip()
            }
            source_by_location: dict[
                tuple[str, int, int], list[dict[str, Any]]
            ] = {}
            for span in source_spans:
                span_key = cls._manifest_span_key(span)
                if span_key is not None:
                    source_by_location.setdefault(span_key, []).append(span)
            retained_spans: list[dict[str, Any]] = []
            raw_spans = raw_manifest.get("included_spans")
            if not isinstance(raw_spans, list):
                continue
            for raw_span in raw_spans:
                if not isinstance(raw_span, dict):
                    continue
                raw_content = str(raw_span.get("content", "") or "")
                if not raw_content or cls._contains_request_shortening_marker(
                    raw_content
                ):
                    continue
                span_id = str(raw_span.get("span_id", "")).strip()
                source_span = source_by_id.get(span_id)
                if source_span is None:
                    raw_key = cls._manifest_span_key(raw_span)
                    location_matches = (
                        source_by_location.get(raw_key, [])
                        if raw_key is not None
                        else []
                    )
                    source_span = (
                        location_matches[0]
                        if len(location_matches) == 1
                        else None
                    )
                if source_span is None:
                    continue
                if cls._manifest_span_key(raw_span) != cls._manifest_span_key(
                    source_span
                ):
                    continue
                if raw_content != str(source_span.get("content", "") or ""):
                    continue
                source_key = cls._manifest_span_key(source_span)
                if source_key is None:
                    continue
                source_path, source_start, source_end = source_key
                trusted_snapshot = str(
                    source_span.get("snapshot_id")
                    or source_manifest.get("snapshot_id")
                    or snapshot_id
                )
                trusted_revision = str(
                    source_span.get("revision")
                    or source_manifest.get("revision")
                    or revision
                )
                enriched = {
                    "span_id": str(
                        source_span.get("span_id")
                        or f"{candidate_id}:{source_path}:{source_start}"
                    ),
                    "file": source_path,
                    "start_line": source_start,
                    "end_line": source_end,
                    "content": raw_content,
                    "context_hash": str(source_span.get("context_hash", "") or ""),
                    "retrieval_source": str(
                        source_span.get("retrieval_source")
                        or source_manifest.get("retrieval_source")
                        or "context_manifest"
                    ),
                    "symbol_id": str(source_span.get("symbol_id", "") or ""),
                    "snapshot_id": trusted_snapshot,
                    "revision": trusted_revision,
                    "side": str(
                        source_span.get("side")
                        or source_manifest.get("side")
                        or "new"
                    ),
                    "truncated": bool(source_span.get("truncated", False)),
                    "lifecycle": "delivered",
                }
                retained_spans.append(enriched)
            if not retained_spans:
                continue
            enriched_manifest = dict(raw_manifest)
            enriched_manifest["snapshot_id"] = str(
                source_manifest.get("snapshot_id") or snapshot_id
            )
            enriched_manifest["revision"] = str(
                source_manifest.get("revision") or revision
            )
            enriched_manifest["included_spans"] = retained_spans
            delivered.append(enriched_manifest)
        return delivered

    @staticmethod
    def _manifest_span_key(span: dict[str, Any]) -> tuple[str, int, int] | None:
        path = normalize_repo_path(str(span.get("file", span.get("path", ""))))
        start = _optional_non_negative_int(span.get("start_line", span.get("line")))
        end = _optional_non_negative_int(
            span.get("end_line", span.get("line", start))
        )
        if start is None or end is None:
            return None
        if not path or start < 1 or end < start:
            return None
        return path, start, end

    @staticmethod
    def _delivered_tool_evidence(
        captured: list[dict[str, Any]],
        raw_messages: list[Any],
        *,
        workspace_root: Path | None = None,
    ) -> list[dict[str, Any]]:
        """Keep tool observations whose result is present in this wire request."""

        tool_message_data: dict[str, dict[str, Any]] = {}
        for message in raw_messages:
            if not isinstance(message, dict) or message.get("role") != "tool":
                continue
            call_id = str(message.get("tool_call_id", "")).strip()
            content = message.get("content")
            if not call_id or not isinstance(content, str):
                continue
            try:
                payload = json.loads(content)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict) or not bool(payload.get("ok")):
                continue
            data = payload.get("data")
            if isinstance(data, dict):
                tool_message_data[call_id] = data
        synthetic_results: dict[str, dict[str, Any]] = {}
        marker = "prefetched_tool_context:"
        for message in raw_messages:
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            content = message.get("content")
            if not isinstance(content, str):
                continue
            marker_index = content.find(marker)
            if marker_index < 0:
                continue
            try:
                payload = json.loads(content[marker_index + len(marker) :].strip())
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            call_id = str(payload.get("tool_call_id", "")).strip()
            result = payload.get("result")
            if call_id and isinstance(result, dict):
                synthetic_results[call_id] = result

        delivered: list[dict[str, Any]] = []
        for entry in captured:
            call_id = str(entry.get("tool_call_id", "")).strip()
            wire_data = tool_message_data.get(call_id)
            if wire_data is not None and InferenceEngine._same_tool_data(
                entry.get("data"),
                wire_data,
                workspace_root=workspace_root,
            ):
                delivered.append(entry)
                continue
            synthetic = synthetic_results.get(call_id)
            if synthetic is None:
                continue
            data = synthetic.get("data")
            if not isinstance(data, dict) or not bool(synthetic.get("ok", True)):
                continue
            projected = dict(entry)
            projected["data"] = data
            delivered.append(projected)
        return delivered

    @staticmethod
    def _same_tool_data(
        captured: Any,
        delivered: Any,
        *,
        workspace_root: Path | None,
    ) -> bool:
        """Require the full tool result body, allowing only path normalization."""

        return serialize_json(
            InferenceEngine._normalize_wire_paths(
                captured,
                workspace_root,
            )
        ) == serialize_json(
            InferenceEngine._normalize_wire_paths(
                delivered,
                workspace_root,
            )
        )

    @staticmethod
    def _normalize_wire_paths(
        value: Any,
        workspace_root: Path | None,
        *,
        key: str = "",
    ) -> Any:
        """Mirror verifier-context path normalization for wire comparisons."""

        if isinstance(value, dict):
            return {
                str(item_key): InferenceEngine._normalize_wire_paths(
                    item,
                    workspace_root,
                    key=str(item_key),
                )
                for item_key, item in value.items()
            }
        if isinstance(value, list):
            return [
                InferenceEngine._normalize_wire_paths(
                    item,
                    workspace_root,
                    key=key,
                )
                for item in value
            ]
        if isinstance(value, str) and key in {"file_path", "path"}:
            raw = value.strip()
            if workspace_root is not None and raw:
                try:
                    root = workspace_root.resolve()
                    path = Path(raw)
                    resolved = (
                        path.resolve()
                        if path.is_absolute()
                        else (root / path).resolve()
                    )
                    raw = resolved.relative_to(root).as_posix()
                except (OSError, ValueError):
                    pass
            return normalize_repo_path(raw)
        return value

    @staticmethod
    def _safe_wire_message(message: Message) -> dict[str, Any]:
        """Serialize message fields used for input sizing without transient thinking."""

        item: dict[str, Any] = {
            "role": message.role,
            "content": message.content,
        }
        if message.tool_call_id is not None:
            item["tool_call_id"] = message.tool_call_id
        if message.tool_calls:
            item["tool_calls"] = message.tool_calls
        return item

    @classmethod
    def _build_component_records(
        cls,
        *,
        messages: list[Message],
        tools: list[dict[str, Any]],
        tool_feedback: list[dict[str, Any]],
        relation_graph_summary: dict[str, Any],
        wire_messages: list[dict[str, Any]],
        assembled_request_text: str,
    ) -> list[dict[str, Any]]:
        """Build size/hash records for all visible request components."""

        by_component: dict[str, list[str]] = {}
        for message in messages:
            component = cls._message_component(message)
            by_component.setdefault(component, []).append(message.content)

        records: list[dict[str, Any]] = []

        def add(name: str, text: str) -> None:
            records.append(token_component(name, text))

        add("system", "\n".join(by_component.get("system", [])))
        review_payload = "\n".join(by_component.get("review_payload", []))
        if review_payload:
            payload_start = review_payload.find("{")
            if payload_start >= 0:
                review_payload = review_payload[payload_start:]
        add("review_payload", review_payload)

        graph_manifests: list[Any] = []
        graph_paths: list[Any] = []
        if review_payload:
            try:
                decoded = json.loads(review_payload)
            except json.JSONDecodeError:
                decoded = {}
            if isinstance(decoded, dict):
                raw_manifests = decoded.get("candidate_context_manifests", [])
                if isinstance(raw_manifests, list):
                    for manifest in raw_manifests:
                        if not isinstance(manifest, dict):
                            continue
                        graph_manifests.append(manifest)
                        raw_paths = manifest.get("included_graph_paths", [])
                        if isinstance(raw_paths, list):
                            graph_paths.extend(
                                {"candidate_id": manifest.get("candidate_id"), "path": path}
                                for path in raw_paths
                                if isinstance(path, dict)
                            )
        add("graph_manifest_projection", serialize_json(graph_manifests))
        add("graph_path_projection", serialize_json(graph_paths))
        add("relation_graph_summary", serialize_json(relation_graph_summary))
        add(
            "conversation_history",
            serialize_json(
                [
                    message
                    for message in wire_messages
                    if message.get("role") in {"assistant", "tool"}
                ]
            ),
        )
        add("tool_feedback", serialize_json(tool_feedback))
        add(
            "final_submit_evidence",
            "\n".join(by_component.get("final_submit_evidence", [])),
        )
        add(
            "defer_notice",
            "\n".join(by_component.get("defer_submit_notice", [])),
        )
        add(
            "finalize_notice",
            "\n".join(by_component.get("finalize_notice", [])),
        )
        add(
            "near_last_notice",
            "\n".join(by_component.get("near_last_notice", [])),
        )
        add("tool_schemas", serialize_json(tools))
        add("assembled_request_total", assembled_request_text)
        return records

    @staticmethod
    def _message_component(message: Message) -> str:
        if message.role == "system":
            return "system"
        content = message.content
        if "prefetched_tool_context:" in content:
            return "prefetch_context"
        if content.startswith("Do not call submit_review yet."):
            return "defer_submit_notice"
        if content.startswith("final_submit_evidence_summary:"):
            return "final_submit_evidence"
        if content.startswith("FINAL CALL"):
            return "finalize_notice"
        if content.startswith("Note: you are at the last allowed iteration"):
            return "near_last_notice"
        if content.startswith("Review the payload"):
            return "review_payload"
        if content.startswith("Return tool calls if needed"):
            return "debug_payload"
        return "conversation_or_feedback"

    @staticmethod
    def _tool_schema_shape(
        schema: dict[str, Any], builder: ContextBuilder
    ) -> dict[str, Any]:
        serialized = serialize_json(schema)
        function = schema.get("function", {})
        name = (
            function.get("name", "unknown") if isinstance(function, dict) else "unknown"
        )
        return {
            "name": str(name),
            "chars": len(serialized),
            "estimated_tokens": builder.estimate_tokens(serialized),
        }

    @classmethod
    def _measure_prefetch_coverage(
        cls,
        file_contents: dict[str, str],
        tool_feedback: list[dict[str, Any]],
        *,
        selected_file_complete_lines: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        entries: list[dict[str, Any]] = []
        selected_file_complete_lines = selected_file_complete_lines or {}
        for item in tool_feedback:
            raw_call = item.get("tool_call")
            if (
                not isinstance(raw_call, dict)
                or raw_call.get("synthetic_context") is not True
            ):
                continue
            function = raw_call.get("function")
            if not isinstance(function, dict) or function.get("name") != "read_file":
                continue
            result_payload = cls._tool_result_payload(item.get("result"))
            entry = cls._prefetch_coverage_entry(
                raw_call,
                result_payload,
                selected_file_complete_lines,
                file_contents=file_contents,
            )
            if entry is not None:
                entries.append(entry)
        return {
            "entry_count": len(entries),
            "covered_entry_count": sum(
                bool(item["covered_by_file_context"]) for item in entries
            ),
            "covered_prefetch_content_chars": sum(
                int(item["prefetch_content_chars"])
                for item in entries
                if item["covered_by_file_context"]
            ),
            "suppressed_entry_count": sum(
                bool(item["covered_by_file_context"]) for item in entries
            ),
            "entries": entries,
        }

    @staticmethod
    def _prefetch_coverage_entry(
        raw_tool_call: dict[str, Any],
        result_payload: dict[str, Any],
        selected_file_complete_lines: dict[str, int],
        *,
        file_contents: dict[str, str] | None = None,
    ) -> dict[str, Any] | None:
        function = raw_tool_call.get("function")
        if not isinstance(function, dict) or function.get("name") != "read_file":
            return None
        try:
            arguments = json.loads(str(function.get("arguments", "{}")))
        except json.JSONDecodeError:
            arguments = {}
        path = str(arguments.get("file_path", "")).replace("\\", "/")
        while path.startswith("./"):
            path = path[2:]
        path = path.lstrip("/")
        data = result_payload.get("data")
        if result_payload.get("ok") is not True or not isinstance(data, dict):
            return None
        start_line = int(data.get("start_line", 0) or 0)
        line_count = int(data.get("line_count", 0) or 0)
        end_line = start_line + line_count - 1 if start_line and line_count else 0
        loaded_complete_lines = int(selected_file_complete_lines.get(path, 0) or 0)
        covered = bool(end_line and end_line <= loaded_complete_lines)
        content = data.get("content")
        loaded = (file_contents or {}).get(path, "")
        return {
            "file": path,
            "start_line": start_line,
            "end_line": end_line,
            "prefetch_content_chars": len(content) if isinstance(content, str) else 0,
            "loaded_file_chars": len(loaded),
            "loaded_complete_lines": loaded_complete_lines,
            "covered_by_file_context": covered,
        }

    def _record_length_finish(
        self,
        response: ModelResponse,
        iteration: int,
        config: ModelConfig | None,
    ) -> None:
        if response.finish_reason != "length" or self._trace_event_writer is None:
            return
        self._trace_event_writer(
            EventType.ERROR,
            "analyze",
            {
                "iteration": iteration,
                "reason": "model_finish_reason_length",
                "model": response.model,
                "usage": response.usage.model_dump(),
                "max_tokens": config.max_tokens if config is not None else None,
                "content_length": len(response.content),
            },
        )

    @staticmethod
    def _length_incomplete_reason(
        response: ModelResponse,
        plan: AnalysisPlan,
    ) -> str:
        if response.finish_reason != "length":
            return ""
        if plan.draft_review is not None and (
            plan.draft_review.summary.strip() or plan.draft_review.issues
        ):
            return ""
        if plan.draft_debug is not None:
            return ""
        return "model_finish_reason_length_no_submit"

    def _record_incomplete_response(
        self,
        response: ModelResponse,
        iteration: int,
        config: ModelConfig | None,
        reason: str,
    ) -> None:
        if self._trace_event_writer is None:
            return
        self._trace_event_writer(
            EventType.ERROR,
            "analyze",
            {
                "iteration": iteration,
                "reason": reason,
                "model": response.model,
                "finish_reason": response.finish_reason,
                "usage": response.usage.model_dump(),
                "max_tokens": config.max_tokens if config is not None else None,
                "content_length": len(response.content),
            },
        )
