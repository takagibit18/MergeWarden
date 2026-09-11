"""Focused offline regressions for the v3 runtime closeout boundary."""

from __future__ import annotations

import asyncio
import json
import re
from time import perf_counter
from typing import Any

import pytest

from src.analyzer.finding_contract import (
    ModelFindingInputV3,
    ModelSaveFindingActionV3,
    normalize_model_finding_v3_payload,
)
from src.analyzer.finding_integrity import FindingIntegrityGuard, build_candidates
from src.analyzer.finding_schema import FindingContentV3, SourceAnchor
from src.analyzer.output_formatter import ReviewIssue, ReviewReport
from src.analyzer.schemas import (
    AnalysisPlan,
    ReviewRequest,
    ReviewResponse,
    V3ActionCallRef,
)
from src.analyzer.semantic_verifier import (
    InvestigationResult,
    SemanticVerifier,
    SemanticVerifierBudget,
    SemanticVerifierCandidate,
)
from src.analyzer.finding_delivery import relevant_evidence_context_digest
from src.models.schemas import ModelConfig, ModelResponse, TokenUsage
from src.models.exceptions import ModelClientError
from src.orchestrator.agent_loop import AgentOrchestrator
from src.models.conversation import ToolResultTurn
from src.analyzer.context_state import ContextState
from src.analyzer.evidence_ledger import ledger_from_sources
from src.tools.base import ToolRegistry
from tests.test_harness_slimming_v3 import _ScriptedV3RunClient


CATALOG = [
    {
        "evidence_id": "ev-diff",
        "artifact_id": "artifact-diff",
        "path": "src/app.py",
        "start_line": 2,
        "end_line": 2,
        "source_type": "git_diff",
        "snapshot_id": "snapshot-a",
        "revision": "revision-a",
    }
]


def _issue(
    description: str = "The changed return value violates the caller contract.",
) -> ReviewIssue:
    return ReviewIssue.model_validate(
        normalize_model_finding_v3_payload(
            {
                "anchor": {"file": "src/app.py", "line": 2},
                "description": description,
                "evidence_refs": ["ev-diff"],
                "severity": "warning",
                "suggestion": "Preserve the established return value.",
            },
            evidence_catalog=CATALOG,
        )
    )


def _orchestrator(
    tmp_path: Any, *, timeout: float = 1.0
) -> tuple[AgentOrchestrator, ContextState]:
    orchestrator = AgentOrchestrator(
        review_max_iterations=3,
        agent_run_timeout_seconds=timeout,
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]
    orchestrator._reset_run(3, str(tmp_path))
    state = ContextState(
        goal="review",
        evidence_snapshot_id="snapshot-a",
        evidence_revision="revision-a",
        evidence_ledger=list(CATALOG),
    )
    orchestrator._live_evidence_catalog = list(CATALOG)
    return orchestrator, state


def _save_action(description: str) -> ModelSaveFindingActionV3:
    return ModelSaveFindingActionV3(
        finding=ModelFindingInputV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description=description,
            evidence_refs=["ev-diff"],
            severity="warning",
            suggestion="Preserve the established return value.",
        )
    )


def _verification_call(payload: dict[str, object]) -> dict[str, object]:
    return {
        "function": {
            "name": "verify_findings",
            "arguments": json.dumps(payload),
        }
    }


def test_v3_closeout_done_branch_is_idempotent_without_report_rollback(
    tmp_path: Any,
) -> None:
    orchestrator, state = _orchestrator(tmp_path)
    original = _issue("original candidate")
    orchestrator._candidate_registry.save_finding(
        original,
        source_issue_index=0,
        iteration=0,
    )
    response = ReviewResponse(
        run_id="run-closeout",
        report=ReviewReport(schema_version="3.0"),
        context=state,
    )

    closed = orchestrator._closeout_v3_response(state, response)
    assert closed.report.issues[0].description == "original candidate"

    # A later gate/repair owns the response object after the first closeout.
    # Calling the compatibility hook again must not restore the first snapshot.
    response.report = ReviewReport(
        summary="latest downstream state",
        issues=[],
        schema_version="3.0",
    )
    repeated = orchestrator._closeout_v3_response(state, response)
    assert repeated.report.summary == "latest downstream state"
    assert repeated.report.issues == []


def test_v3_verification_rebuilds_from_current_registry_version(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    orchestrator, state = _orchestrator(tmp_path)
    original = _issue("original version")
    record = orchestrator._candidate_registry.save_finding(
        original,
        source_issue_index=0,
        iteration=0,
    )
    response = ReviewResponse(
        run_id="run-revision",
        report=ReviewReport(schema_version="3.0"),
        context=state,
    )
    orchestrator._closeout_v3_response(state, response)
    revised = _issue("revised version")
    assert orchestrator._candidate_registry.revise_finding(
        record.candidate_id,
        revised,
        base_version=record.candidate_content_version,
    )

    captured: list[ReviewReport] = []

    def fake_guard(*args: Any, **kwargs: Any) -> ReviewResponse:
        del args, kwargs
        return response

    async def fake_semantic(
        guarded: ReviewResponse,
        submitted_report: ReviewReport,
        request: ReviewRequest,
        current_state: ContextState,
    ) -> ReviewResponse:
        del request, current_state
        captured.append(submitted_report)
        return guarded

    monkeypatch.setattr(orchestrator, "_verify_with_integrity_guard", fake_guard)
    monkeypatch.setattr(orchestrator, "_run_semantic_verifier", fake_semantic)
    asyncio.run(
        orchestrator._verify_review_response(
            response,
            ReviewRequest(repo_path=str(tmp_path), diff_text="diff"),
            state,
        )
    )
    assert captured
    assert [item.description for item in captured[0].issues] == ["revised version"]


def test_v3_action_receipts_pair_bad_and_good_actions_by_provider_id(
    tmp_path: Any,
) -> None:
    orchestrator, state = _orchestrator(tmp_path)
    bad_id = "call-bad-save"
    good_id = "call-good-save"
    raw_calls = [
        {
            "id": bad_id,
            "type": "function",
            "function": {"name": "save_finding", "arguments": "{bad"},
        },
        {
            "id": good_id,
            "type": "function",
            "function": {"name": "save_finding", "arguments": "{}"},
        },
    ]
    orchestrator._model_conversation.add_assistant_tool_turn(
        response_id="provider-response",
        content="",
        thinking="",
        tool_calls=raw_calls,
    )
    plan = AnalysisPlan(
        source_response_id="provider-response",
        v3_save_findings=[_save_action("good candidate")],
        v3_action_call_refs=[
            V3ActionCallRef(
                name="save_finding",
                provider_call_id=bad_id,
                raw_arguments="{bad",
                raw_call_index=0,
                action_index=None,
                validation_error="invalid save_finding arguments",
            ),
            V3ActionCallRef(
                name="save_finding",
                provider_call_id=good_id,
                raw_arguments={},
                raw_call_index=1,
                action_index=0,
            ),
        ],
    )

    actions = orchestrator._execute_v3_finding_actions(plan, state)

    assert len(actions) == 2
    assert actions[0][0]["id"] == bad_id
    assert not actions[0][1].ok
    assert actions[1][0]["id"] == good_id
    assert actions[1][1].ok
    result_turns = [
        turn
        for turn in orchestrator._model_conversation.turns
        if isinstance(turn, ToolResultTurn)
    ]
    assert [turn.tool_call_id for turn in result_turns] == [bad_id, good_id]
    journal_ids = [
        entry.payload["tool_call_id"]
        for entry in orchestrator._run_journal.replay()
        if entry.type == "tool_result"
    ]
    assert journal_ids == [bad_id, good_id]


def test_integrity_guard_requires_expected_evidence_snapshot_and_revision(
    tmp_path: Any,
) -> None:
    source = tmp_path / "src" / "app.py"
    source.parent.mkdir(parents=True)
    source.write_text("return_value = old\nreturn_value = changed\n", encoding="utf-8")
    diff = (
        "diff --git a/src/app.py b/src/app.py\n"
        "--- a/src/app.py\n"
        "+++ b/src/app.py\n"
        "@@ -2,1 +2,1 @@\n"
        "-return_value = old\n"
        "+return_value = changed\n"
    )
    candidate = build_candidates(
        ReviewReport(issues=[_issue()], schema_version="3.0"),
        iteration=0,
        include_non_risk=True,
    )[0]
    ledger = ledger_from_sources(
        existing_payload=CATALOG,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    request = ReviewRequest(
        repo_path=str(tmp_path),
        diff_mode=True,
        diff_text=diff,
    )
    guard = FindingIntegrityGuard(tmp_path)

    valid = guard.validate(
        [candidate],
        request,
        evidence_ledger=ledger,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    assert valid.results[0].passed

    tampered_snapshot = guard.validate(
        [candidate],
        request,
        evidence_ledger=ledger,
        snapshot_id="tampered-runtime-snapshot",
        revision="revision-a",
    )
    assert not tampered_snapshot.results[0].passed
    assert "evidence_identity_mismatch" in {
        failure.code for failure in tampered_snapshot.results[0].failures
    }

    tampered_revision = guard.validate(
        [candidate],
        request,
        evidence_ledger=ledger,
        snapshot_id="snapshot-a",
        revision="tampered-runtime-revision",
    )
    assert not tampered_revision.results[0].passed
    assert "evidence_identity_mismatch" in {
        failure.code for failure in tampered_revision.results[0].failures
    }


class _UnknownUsageRecheckClient:
    def __init__(self) -> None:
        self.calls = 0
        self.configs: list[ModelConfig] = []
        self.default_config = ModelConfig(model="offline-unknown", max_tokens=1000)

    async def chat(self, messages: Any, **kwargs: Any) -> ModelResponse:
        del messages
        config = kwargs["config"]
        self.configs.append(config)
        self.calls += 1
        decision = (
            {
                "opaque_handle": "h-1",
                "verdict": "needs_revision",
                "reason": "A targeted source check is required.",
                "request": "Read the exact helper range.",
                "investigation": {
                    "tool": "read_file",
                    "file": "src/app.py",
                    "start_line": 2,
                    "end_line": 2,
                },
            }
            if self.calls == 1
            else {
                "opaque_handle": "h-1",
                "verdict": "accept",
                "reason": "The targeted source confirms the candidate.",
            }
        )
        return ModelResponse(
            model="offline-unknown",
            usage=TokenUsage(),
            usage_present=False,
            tool_calls=[
                {
                    "function": {
                        "name": "verify_findings",
                        "arguments": json.dumps({"decisions": [decision]}),
                    }
                }
            ],
        )

    def consume_call_telemetry(self) -> list[dict[str, object]]:
        return [
            {
                "success": True,
                "usage_present": False,
                "usage_unknown": True,
            }
        ]


def test_semantic_recheck_keeps_shared_quota_and_unknown_output_charge() -> None:
    client = _UnknownUsageRecheckClient()
    candidate = SemanticVerifierCandidate(
        opaque_handle="h-1",
        content=FindingContentV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description="The changed return value violates the caller contract.",
            evidence_refs=["ev-diff"],
            severity="warning",
            suggestion="Preserve the established return value.",
        ),
    )

    async def investigate(*args: Any) -> InvestigationResult:
        del args
        return InvestigationResult(answer="targeted source", tool_call_count=1)

    result = asyncio.run(
        SemanticVerifier(
            client,
            budget=SemanticVerifierBudget(
                max_model_calls=2,
                max_investigation_calls=1,
                hard_token_budget=100_000,
            ),
        ).verify([candidate], investigator=investigate)
    )

    assert client.calls == 2
    assert result.model_call_count == 2
    assert result.accepted_count == 1
    assert result.total_tokens == 0
    assert result.budget_tokens_used >= sum(
        config.max_tokens for config in client.configs
    )


class _CancelledSemanticClient:
    default_config = ModelConfig(model="offline-cancel", max_tokens=64)

    async def chat(self, *args: Any, **kwargs: Any) -> ModelResponse:
        del args, kwargs
        raise asyncio.CancelledError

    def consume_call_telemetry(self) -> list[dict[str, object]]:
        return [
            {
                "success": False,
                "usage_present": False,
                "usage_unknown": True,
                "cancelled": True,
            }
        ]


def test_semantic_cancellation_charges_unknown_attempt_then_propagates() -> None:
    verifier = SemanticVerifier(
        _CancelledSemanticClient(),
        budget=SemanticVerifierBudget(max_model_calls=2),
    )
    candidate = SemanticVerifierCandidate(
        opaque_handle="h-cancel",
        content=FindingContentV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description="The changed return value violates the caller contract.",
            evidence_refs=["ev-diff"],
            severity="warning",
            suggestion="Preserve the established return value.",
        ),
    )

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(verifier.verify([candidate]))

    assert verifier.last_budget_tokens_used >= 64


class _PreflightRejectedSemanticClient:
    default_config = ModelConfig(model="offline-preflight", max_tokens=64)

    async def chat(self, *args: Any, **kwargs: Any) -> ModelResponse:
        del args, kwargs
        raise ModelClientError(
            "call budget exhausted before provider send",
            code="call_token_budget_exhausted",
        )

    def consume_call_telemetry(self) -> list[dict[str, object]]:
        return []


def test_semantic_call_budget_preflight_without_attempt_is_not_charged() -> None:
    candidate = SemanticVerifierCandidate(
        opaque_handle="h-preflight",
        content=FindingContentV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description="The changed return value violates the caller contract.",
            evidence_refs=["ev-diff"],
            severity="warning",
            suggestion="Preserve the established return value.",
        ),
    )
    result = asyncio.run(
        SemanticVerifier(
            _PreflightRejectedSemanticClient(),
            budget=SemanticVerifierBudget(max_model_calls=1),
        ).verify([candidate])
    )

    assert result.model_call_count == 0
    assert result.provider_attempt_count == 0
    assert result.budget_tokens_used == 0


class _MixedSemanticRepairClient(_ScriptedV3RunClient):
    """Reuse D's provider harness with mixed unresolved/repairable findings."""

    def __init__(self, first_verdict: str = "unresolved") -> None:
        super().__init__()
        self.first_verdict = first_verdict

    async def chat(
        self, messages, config=None, tools=None, policy=None, conversation=None
    ):  # type: ignore[no-untyped-def]
        del config, policy, conversation
        self.calls += 1
        names = {
            str(item.get("function", {}).get("name", ""))
            for item in (tools or [])
            if isinstance(item, dict)
        }
        self.name_history.append(names)
        if "verify_findings" in names:
            self.verifier_calls += 1
            self.stages.append("verify" if self.verifier_calls == 1 else "recheck")
            text = "\n".join(
                str(getattr(message, "content", "")) for message in messages
            )
            handles = list(
                dict.fromkeys(re.findall(r'"opaque_handle"\s*:\s*"([^"]+)"', text))
            )
            assert handles
            if self.verifier_calls == 1:
                assert len(handles) == 2
                decisions = [
                    {
                        "opaque_handle": handles[0],
                        "verdict": self.first_verdict,
                        "reason": (
                            "Evidence remains inconclusive."
                            if self.first_verdict == "unresolved"
                            else "The first distinct finding is supported."
                        ),
                    },
                    {
                        "opaque_handle": handles[1],
                        "verdict": "needs_revision",
                        "reason": "Clarify second finding.",
                        "request": "Clarify second finding",
                    },
                ]
            else:
                decisions = [
                    {
                        "opaque_handle": handles[0],
                        "verdict": "accept",
                        "reason": "The corrected explanation is supported.",
                    }
                ]
            return ModelResponse(
                model="offline-mixed",
                provider_request_id=f"mixed-provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[_verification_call({"decisions": decisions})],
            )
        if "repair_review" in names:
            self.stages.append("repair")
            text = "\n".join(
                str(getattr(message, "content", "")) for message in messages
            )
            match = re.search(r'"target_handle"\s*:\s*"([^"]+)"', text)
            if match is None:
                match = re.search(r"target_handle=([A-Za-z0-9_-]+)", text)
            assert match is not None
            return ModelResponse(
                model="offline-mixed",
                provider_request_id=f"mixed-provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[
                    {
                        "function": {
                            "name": "repair_review",
                            "arguments": json.dumps(
                                {
                                    "repairs": [
                                        {
                                            "target_handle": match.group(1),
                                            "repair_status": "repaired",
                                            "repair_patch": {
                                                "description": (
                                                    "Second finding with corrected explanation."
                                                )
                                            },
                                        }
                                    ]
                                }
                            ),
                        }
                    }
                ],
            )

        self.reviewer_calls += 1
        self.stages.append("reviewer")
        if self.reviewer_calls <= 2:
            text = "\n".join(
                str(getattr(message, "content", "")) for message in messages
            )
            evidence_match = re.search(r'"evidence_id"\s*:\s*"([^"]+)"', text)
            if evidence_match is None and self.orchestrator is not None:
                evidence_match = re.match(
                    r"(.*)",
                    str(self.orchestrator._live_evidence_catalog[0]["evidence_id"]),  # noqa: SLF001
                )
            assert evidence_match is not None
            description = (
                "First distinct unresolved finding."
                if self.reviewer_calls == 1
                else "Second distinct repairable finding."
            )
            return ModelResponse(
                model="offline-mixed",
                provider_request_id=f"mixed-provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[
                    {
                        "function": {
                            "name": "save_finding",
                            "arguments": json.dumps(
                                {
                                    "finding": {
                                        "anchor": {"file": "src/app.py", "line": 1},
                                        "description": description,
                                        "evidence_refs": [evidence_match.group(1)],
                                        "severity": "warning",
                                    }
                                }
                            ),
                        }
                    }
                ],
            )
        return ModelResponse(
            model="offline-mixed",
            provider_request_id=f"mixed-provider-{self.calls}",
            usage=TokenUsage(total_tokens=1),
            tool_calls=[
                {
                    "function": {
                        "name": "finish_review",
                        "arguments": json.dumps({"summary": "Review done"}),
                    }
                }
            ],
        )


@pytest.mark.parametrize(
    ("first_verdict", "expected_accepted", "expected_rejected", "expected_unresolved"),
    [
        ("unresolved", 1, 0, 1),
        ("accept", 2, 0, 0),
        ("reject", 1, 1, 0),
    ],
)
def test_run_review_mixed_projection_preserves_prior_verdicts_after_repair(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
    first_verdict: str,
    expected_accepted: int,
    expected_rejected: int,
    expected_unresolved: int,
) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    source = tmp_path / "src" / "app.py"
    source.parent.mkdir(parents=True)
    source.write_text("return_value = changed\n", encoding="utf-8")
    diff = (
        "diff --git a/src/app.py b/src/app.py\n"
        "--- a/src/app.py\n"
        "+++ b/src/app.py\n"
        "@@ -1,1 +1,1 @@\n"
        "-return_value = old\n"
        "+return_value = changed\n"
    )
    client = _MixedSemanticRepairClient(first_verdict)
    orchestrator = AgentOrchestrator(
        registry=ToolRegistry(),
        review_max_iterations=4,
        review_min_tool_iterations=0,
        review_workflow_enforcement="off",
        agent_run_timeout_seconds=60.0,
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]
    # Keep this provider script independent of repository/test-process env
    # budgets.  These are local offline-test limits, not production defaults.
    orchestrator._settings.token_budget = 48_000  # noqa: SLF001
    orchestrator._settings.token_hard_budget = 64_000  # noqa: SLF001
    orchestrator._settings.final_submit_reserve_tokens = 8_000  # noqa: SLF001
    orchestrator._settings.final_submit_request_token_budget = 8_000  # noqa: SLF001
    orchestrator._settings.prompt_input_token_budget = 12_000  # noqa: SLF001
    orchestrator._settings.assembled_request_token_budget = 24_000  # noqa: SLF001
    orchestrator._settings.exploration_max_output_tokens = 2_048  # noqa: SLF001
    orchestrator._settings.submit_max_output_tokens = 2_048  # noqa: SLF001
    orchestrator._settings.model_request_timeout_seconds = 30.0  # noqa: SLF001
    orchestrator._settings.review_repair_max_attempts = 1  # noqa: SLF001
    orchestrator._settings.semantic_verifier_max_model_calls = 2  # noqa: SLF001
    orchestrator._settings.semantic_verifier_max_investigation_calls = 1  # noqa: SLF001
    client.orchestrator = orchestrator
    client.diff_text = diff
    orchestrator._model_client = client  # type: ignore[assignment]

    async def prepare_context(state, request):  # type: ignore[no-untyped-def]
        state.context_mode = "agent_search"
        state.evidence_ledger = ledger_from_sources(
            diff_text=request.diff_text or "",
            snapshot_id=orchestrator._evidence_snapshot_id,  # noqa: SLF001
            revision=orchestrator._evidence_revision,  # noqa: SLF001
        ).to_payload()
        orchestrator._publish_evidence_catalog(state)  # noqa: SLF001

    monkeypatch.setattr(orchestrator, "_prepare_review_context", prepare_context)
    response = asyncio.run(
        orchestrator.run_review(
            ReviewRequest(repo_path=str(tmp_path), diff_mode=True, diff_text=diff)
        )
    )

    assert client.stages == [
        "reviewer",
        "reviewer",
        "reviewer",
        "verify",
        "repair",
        "recheck",
    ]
    expected_descriptions = (
        [
            "First distinct unresolved finding.",
            "Second finding with corrected explanation.",
        ]
        if first_verdict == "accept"
        else ["Second finding with corrected explanation."]
    )
    assert [
        issue.description for issue in response.report.issues
    ] == expected_descriptions
    assert response.semantic_accepted_count == expected_accepted
    assert response.semantic_rejected_count == expected_rejected
    assert response.semantic_unresolved_count == expected_unresolved
    assert response.semantic_needs_revision_count == 0
    if first_verdict == "unresolved":
        assert response.semantic_verifier_completed is False
        assert response.report_ready is False
        assert response.completion_status == "incomplete"
        assert "semantic_verifier_unresolved" in response.incomplete_reasons
        assert response.external_publish_status != "ready"
        assert response.delivery_complete is False
    else:
        assert response.semantic_unresolved_count == 0
        assert response.semantic_verifier_completed is True
        assert response.report_ready is True
        assert response.completion_status == "complete"
        assert response.external_publish_status == "ready"
        assert response.delivery_complete is True


def test_v3_projection_does_not_approve_zero_budget_accept_with_severity_correction(
    tmp_path: Any,
) -> None:
    orchestrator, _ = _orchestrator(tmp_path)
    issue = _issue("severity still needs correction")
    record = orchestrator._candidate_registry.save_finding(  # noqa: SLF001
        issue,
        source_issue_index=0,
        iteration=0,
    )
    bound = orchestrator._candidate_registry.authoritative_issue(  # noqa: SLF001
        record.candidate_id
    )
    assert bound is not None
    digest = relevant_evidence_context_digest(
        CATALOG,
        bound.evidence_refs,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    version = orchestrator._candidate_registry.commit_verified_version(  # noqa: SLF001
        record.candidate_id,
        bound,
        evidence_context_digest=digest,
    )
    assert orchestrator._candidate_registry.record_semantic_receipt(  # noqa: SLF001
        record.candidate_id,
        {
            "opaque_handle": orchestrator._candidate_registry.opaque_handle(  # noqa: SLF001
                record.candidate_id
            ),
            "candidate_id": record.candidate_id,
            "content_version": version,
            "evidence_context_digest": digest,
            "verdict": "accept",
            "severity_correction": "info",
            "status": "completed",
            "budget_tokens_used": 0,
        },
        content_version=version,
        evidence_context_digest=digest,
    )

    projection = orchestrator._project_current_semantic_closeout(  # noqa: SLF001
        fallback_candidates={},
        fallback_integrity_blocked_count=0,
    )
    assert projection[:5] == (1, 0, 0, 1, 0)
    assert projection[5] == []


def test_v3_projection_requires_completed_current_digest_binding(
    tmp_path: Any,
) -> None:
    orchestrator, _ = _orchestrator(tmp_path)
    issue = _issue("binding must remain current")
    record = orchestrator._candidate_registry.save_finding(  # noqa: SLF001
        issue,
        source_issue_index=0,
        iteration=0,
    )
    bound = orchestrator._candidate_registry.authoritative_issue(  # noqa: SLF001
        record.candidate_id
    )
    assert bound is not None
    digest = relevant_evidence_context_digest(
        CATALOG,
        bound.evidence_refs,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    version = orchestrator._candidate_registry.commit_verified_version(  # noqa: SLF001
        record.candidate_id,
        bound,
        evidence_context_digest=digest,
    )
    receipt = {
        "opaque_handle": orchestrator._candidate_registry.opaque_handle(  # noqa: SLF001
            record.candidate_id
        ),
        "candidate_id": record.candidate_id,
        "content_version": version,
        "evidence_context_digest": digest,
        "verdict": "accept",
        "status": "completed",
    }
    assert orchestrator._candidate_registry.record_semantic_receipt(  # noqa: SLF001
        record.candidate_id,
        receipt,
        content_version=version,
        evidence_context_digest=digest,
    )
    assert (
        orchestrator._project_current_semantic_closeout(  # noqa: SLF001
            fallback_candidates={},
            fallback_integrity_blocked_count=0,
        )[:5]
        == (1, 1, 0, 0, 0)
    )

    record.semantic_receipts[-1]["evidence_context_digest"] = "stale-digest"
    assert (
        orchestrator._project_current_semantic_closeout(  # noqa: SLF001
            fallback_candidates={},
            fallback_integrity_blocked_count=0,
        )[:5]
        == (1, 0, 0, 0, 1)
    )

    record.semantic_receipts[-1]["evidence_context_digest"] = digest
    record.semantic_receipts[-1]["status"] = "pending"
    assert (
        orchestrator._project_current_semantic_closeout(  # noqa: SLF001
            fallback_candidates={},
            fallback_integrity_blocked_count=0,
        )[:5]
        == (1, 0, 0, 0, 1)
    )


class _SlowAnalysisEngine:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls = 0

    async def analyze(self, **kwargs: Any) -> tuple[AnalysisPlan, TokenUsage]:
        del kwargs
        self.calls += 1
        await asyncio.sleep(self.delay)
        return AnalysisPlan(), TokenUsage()


def test_v3_soft_exploration_deadline_preserves_verifier_window(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    orchestrator, state = _orchestrator(tmp_path, timeout=0.20)
    engine = _SlowAnalysisEngine(0.20)
    monkeypatch.setattr(orchestrator, "_build_engine", lambda: engine)

    asyncio.run(
        orchestrator.analyze(
            state,
            ReviewRequest(repo_path=str(tmp_path), diff_text="diff"),
            tool_specs=[],
        )
    )

    assert engine.calls == 1
    assert orchestrator._analysis_time_reserve_hit
    assert orchestrator._analysis_time_reserve_reason == "exploration_time_limit"
    assert not orchestrator._run_timeout_hit


def test_global_deadline_preflight_does_not_start_repair_provider_call(
    tmp_path: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    orchestrator, state = _orchestrator(tmp_path, timeout=0.20)
    engine = _SlowAnalysisEngine(0.01)
    monkeypatch.setattr(orchestrator, "_build_engine", lambda: engine)
    orchestrator._run_started_at = perf_counter() - 1.0

    asyncio.run(
        orchestrator.analyze(
            state,
            ReviewRequest(repo_path=str(tmp_path), diff_text="diff"),
            tool_specs=[],
            force_submit=True,
            repair_mode=True,
        )
    )

    assert engine.calls == 0
    assert orchestrator._run_timeout_hit
    assert not orchestrator._analysis_time_reserve_hit
