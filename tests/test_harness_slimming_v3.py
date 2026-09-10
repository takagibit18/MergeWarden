"""Offline contract and orchestration tests for the 3.0 harness path."""

from __future__ import annotations

import asyncio
import json
import re
from time import perf_counter

import pytest

from src.analyzer.finding_contract import (
    FindingPatchV3,
    ModelFinishReviewActionV3,
    ModelFindingInputV3,
    ModelSaveFindingActionV3,
    canonical_contract_gaps,
    normalize_model_finding_payload,
    normalize_model_finding_v3_payload,
)
from src.analyzer.evidence_ledger import ledger_from_sources
from src.analyzer.finding_delivery import (
    CandidateRegistry,
    candidate_content_version,
    relevant_evidence_context_digest,
)
from src.analyzer.context_state import ContextState
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.review_policy import evaluate_issue_filter
from src.analyzer.schemas import AnalysisPlan, ReviewRequest, ReviewResponse
from src.analyzer.semantic_verifier import (
    InvestigationResult,
    SemanticVerifier,
    SemanticVerifierBudget,
    SemanticVerifierCandidate,
)
from src.analyzer.finding_schema import FindingContentV3, SourceAnchor
from src.models.schemas import ModelConfig, ModelResponse, TokenUsage
from src.integrations.github_adapter import build_github_advisory_payload
from src.integrations.github_publisher import (
    GitHubPublishRequest,
    GitHubPublisher,
    validate_v3_publish_binding,
)
from src.orchestrator.tool_schemas import (
    build_model_submit_tool_schemas,
    build_repair_tool_schemas,
    build_v3_finding_action_tool_schemas,
)
from src.orchestrator.agent_loop import AgentOrchestrator
from src.tools.base import ToolRegistry


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


def _issue() -> ReviewIssue:
    return ReviewIssue.model_validate(
        normalize_model_finding_payload(
            {
                "anchor": {"file": "src/app.py", "line": 2},
                "description": "The changed return value violates the caller contract.",
                "evidence_refs": ["ev-diff"],
                "severity": "warning",
                "suggestion": "Preserve the established return value.",
            },
            evidence_catalog=CATALOG,
        )
    )


def _v3_issue() -> ReviewIssue:
    return ReviewIssue.model_validate(
        normalize_model_finding_v3_payload(
            {
                "anchor": {"file": "src/app.py", "line": 2},
                "description": "The changed return value violates the caller contract.",
                "evidence_refs": ["ev-diff"],
                "severity": "warning",
                "suggestion": "Preserve the established return value.",
            },
            evidence_catalog=CATALOG,
        )
    )


class _NoNetworkPublisherClient:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def list_check_runs(
        self,
        owner_repo: str,
        head_sha: str,
        check_name: str,
    ) -> list[dict[str, object]]:
        del owner_repo, head_sha, check_name
        self.calls.append("list_check_runs")
        return []

    async def create_check_run(
        self,
        owner_repo: str,
        payload: dict[str, object],
    ) -> dict[str, object]:
        del owner_repo
        self.calls.append("create_check_run")
        return {"id": 901, **payload}


def _approved_v3_response() -> ReviewResponse:
    registry = CandidateRegistry()
    issue = _v3_issue()
    record = registry.save_finding(issue, source_issue_index=0, iteration=0)
    bound = registry.authoritative_issue(record.candidate_id)
    assert bound is not None
    evidence_digest = relevant_evidence_context_digest(
        CATALOG,
        bound.evidence_refs,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    version = registry.commit_verified_version(
        record.candidate_id,
        bound,
        evidence_context_digest=evidence_digest,
    )
    receipt = {
        "opaque_handle": registry.opaque_handle(record.candidate_id),
        "candidate_id": record.candidate_id,
        "content_version": version,
        "evidence_context_digest": evidence_digest,
        "verdict": "accept",
        "status": "completed",
        "input_digest": "input-digest",
        "request_hash": "request-hash",
        "response_digest": "response-digest",
        "provider_request_id": "provider-request-1",
        "investigation_evidence_refs": [],
    }
    assert registry.record_semantic_receipt(
        record.candidate_id,
        receipt,
        content_version=version,
        evidence_context_digest=evidence_digest,
    )
    return ReviewResponse(
        run_id="run-v3-publish",
        report=ReviewReport(issues=[bound], schema_version="3.0"),
        context=ContextState(
            evidence_snapshot_id="snapshot-a",
            evidence_revision="revision-a",
            evidence_ledger=list(CATALOG),
            candidate_registrations=registry.snapshot(),
        ),
        semantic_verifier_required=True,
        semantic_verifier_completed=True,
        report_ready=True,
    )


def _candidate(handle: str = "h-1") -> SemanticVerifierCandidate:
    return SemanticVerifierCandidate(
        opaque_handle=handle,
        content=FindingContentV3(
            anchor=SourceAnchor(file="src/app.py", line=2),
            description="The changed return value violates the caller contract.",
            evidence_refs=["ev-diff"],
            severity="warning",
        ),
    )


class _VerifierClient:
    def __init__(self, payloads: list[dict[str, object]]) -> None:
        self.payloads = list(payloads)
        self.calls = 0
        self.default_config = ModelConfig(model="offline-mock")
        self.messages: list[object] = []

    async def chat(self, *args: object, **kwargs: object) -> ModelResponse:
        self.messages.append(args[0] if args else kwargs)
        self.calls += 1
        payload = self.payloads.pop(0)
        return ModelResponse(
            model="offline-mock",
            tool_calls=[
                {
                    "function": {
                        "name": "verify_findings",
                        "arguments": json.dumps(payload),
                    }
                }
            ],
        )


class _RawVerifierClient(_VerifierClient):
    def __init__(self, responses: list[list[dict[str, object]]]) -> None:
        super().__init__([])
        self.responses = list(responses)

    async def chat(self, *args: object, **kwargs: object) -> ModelResponse:
        del args, kwargs
        self.calls += 1
        return ModelResponse(
            model="offline-mock",
            tool_calls=self.responses.pop(0),
        )


class _UsageVerifierClient(_VerifierClient):
    def __init__(
        self,
        payloads: list[dict[str, object]],
        *,
        total_tokens: int,
        clock: list[float] | None = None,
        telemetry: list[dict[str, object]] | None = None,
    ) -> None:
        super().__init__(payloads)
        self.total_tokens = total_tokens
        self.clock = clock
        self.telemetry = list(telemetry or [])

    async def chat(self, *args: object, **kwargs: object) -> ModelResponse:
        response = await super().chat(*args, **kwargs)
        if self.clock is not None:
            self.clock[0] += 1.0
        response.usage = TokenUsage(total_tokens=self.total_tokens)
        return response

    def consume_call_telemetry(self) -> list[dict[str, object]]:
        telemetry = self.telemetry
        self.telemetry = []
        return telemetry


class _MutableClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


class _ClockAdvancingInvestigator:
    def __init__(self, clock: _MutableClock, advance: float) -> None:
        self.clock = clock
        self.advance = advance
        self.calls = 0

    async def __call__(self, *args: object) -> InvestigationResult:
        del args
        self.calls += 1
        self.clock.value += self.advance
        return InvestigationResult(answer="bounded source", tool_call_count=1)


def _verification_call(payload: dict[str, object]) -> dict[str, object]:
    return {
        "function": {
            "name": "verify_findings",
            "arguments": json.dumps(payload),
        }
    }


class _ScriptedV3RunClient:
    """Offline provider script for the complete reviewer/verifier/repair path."""

    def __init__(self) -> None:
        self.default_config = ModelConfig(model="offline-v3")
        self.calls = 0
        self.reviewer_calls = 0
        self.verifier_calls = 0
        self.stages: list[str] = []
        self.name_history: list[set[str]] = []
        self.orchestrator: AgentOrchestrator | None = None
        self.diff_text = ""

    async def chat(self, messages, config=None, tools=None, policy=None, conversation=None):  # type: ignore[no-untyped-def]
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
            handle_match = re.search(r'"opaque_handle"\s*:\s*"([^"]+)"', text)
            assert handle_match is not None
            handle = handle_match.group(1)
            if self.verifier_calls == 1:
                decisions = [
                    {
                        "opaque_handle": handle,
                        "verdict": "accept",
                        "reason": "The claim is supported but severity must be corrected.",
                        "severity_correction": "info",
                    }
                ]
            else:
                decisions = [
                    {
                        "opaque_handle": handle,
                        "verdict": "accept",
                        "reason": "The revised finding is supported.",
                    }
                ]
            return ModelResponse(
                model="offline-v3",
                provider_request_id=f"provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[
                    {
                        "function": {
                            "name": "verify_findings",
                            "arguments": json.dumps({"decisions": decisions}),
                        }
                    }
                ],
            )
        if "repair_review" in names:
            self.stages.append("repair")
            text = "\n".join(
                str(getattr(message, "content", "")) for message in messages
            )
            handle_match = re.search(r"target_handle=(repair_target_[a-z0-9]+)", text)
            assert handle_match is not None
            return ModelResponse(
                model="offline-v3",
                provider_request_id=f"provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[
                    {
                        "function": {
                            "name": "repair_review",
                            "arguments": json.dumps(
                                {
                                    "repairs": [
                                        {
                                            "target_handle": handle_match.group(1),
                                            "repair_status": "repaired",
                                            "repair_patch": {"severity": "info"},
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
        text = "\n".join(
            str(getattr(message, "content", "")) for message in messages
        )
        evidence_match = re.search(r'"evidence_id"\s*:\s*"([^"]+)"', text)
        if evidence_match is None and self.orchestrator is not None:
            catalog = self.orchestrator._live_evidence_catalog  # noqa: SLF001
            if not catalog and self.diff_text:
                catalog = ledger_from_sources(
                    diff_text=self.diff_text,
                    snapshot_id=self.orchestrator._evidence_snapshot_id,  # noqa: SLF001
                    revision=self.orchestrator._evidence_revision,  # noqa: SLF001
                ).to_payload()
            if catalog:
                evidence_match = re.match(
                    r"(.*)", str(catalog[0].get("evidence_id", ""))
                )
        assert evidence_match is not None
        finding = {
            "anchor": {"file": "src/app.py", "line": 1},
            "description": "The changed return value violates the caller contract.",
            "evidence_refs": [evidence_match.group(1)],
            "severity": "warning",
        }
        calls = [
            {
                "function": {
                    "name": "save_finding",
                    "arguments": json.dumps({"finding": finding}),
                }
            }
        ]
        if "finish_review" in names:
            calls.append(
                {
                    "function": {
                        "name": "finish_review",
                        "arguments": json.dumps({"summary": "offline v3 review"}),
                    }
                }
            )
        return ModelResponse(
            model="offline-v3",
            provider_request_id=f"provider-{self.calls}",
            usage=TokenUsage(total_tokens=1),
            tool_calls=calls,
        )


class _MultiCandidateV3RunClient:
    """Offline reviewer/verifier script for partial and unresolved outcomes."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.default_config = ModelConfig(model="offline-v3-multi")
        self.calls = 0
        self.orchestrator: AgentOrchestrator | None = None
        self.diff_text = ""
        self.verifier_decisions: list[str] = []

    async def chat(self, messages, config=None, tools=None, policy=None, conversation=None):  # type: ignore[no-untyped-def]
        del config, policy, conversation
        self.calls += 1
        names = {
            str(item.get("function", {}).get("name", ""))
            for item in (tools or [])
            if isinstance(item, dict)
        }
        if "verify_findings" in names:
            text = "\n".join(
                str(getattr(message, "content", "")) for message in messages
            )
            handles = re.findall(r'"opaque_handle"\s*:\s*"([^"]+)"', text)
            assert len(handles) == 2
            decisions = [
                {
                    "opaque_handle": handles[0],
                    "verdict": "accept",
                    "reason": "The first candidate is supported by the supplied material.",
                }
            ]
            self.verifier_decisions.append("accept")
            if self.mode == "partial":
                decisions.append(
                    {
                        "opaque_handle": handles[1],
                        "verdict": "reject",
                        "reason": "The second candidate is not supported by the supplied material.",
                    }
                )
                self.verifier_decisions.append("reject")
            return ModelResponse(
                model="offline-v3-multi",
                provider_request_id=f"multi-provider-{self.calls}",
                usage=TokenUsage(total_tokens=1),
                tool_calls=[_verification_call({"decisions": decisions})],
            )

        text = "\n".join(
            str(getattr(message, "content", "")) for message in messages
        )
        evidence_match = re.search(r'"evidence_id"\s*:\s*"([^"]+)"', text)
        if evidence_match is None and self.orchestrator is not None:
            catalog = self.orchestrator._live_evidence_catalog  # noqa: SLF001
            if not catalog and self.diff_text:
                catalog = ledger_from_sources(
                    diff_text=self.diff_text,
                    snapshot_id=self.orchestrator._evidence_snapshot_id,  # noqa: SLF001
                    revision=self.orchestrator._evidence_revision,  # noqa: SLF001
                ).to_payload()
            if catalog:
                evidence_match = re.match(
                    r"(.*)", str(catalog[0].get("evidence_id", ""))
                )
        assert evidence_match is not None
        calls: list[dict[str, object]] = []
        for suffix in ("A", "B"):
            calls.append(
                {
                    "function": {
                        "name": "save_finding",
                        "arguments": json.dumps(
                            {
                                "finding": {
                                    "anchor": {"file": "src/app.py", "line": 1},
                                    "description": f"Candidate {suffix} describes a distinct claim.",
                                    "evidence_refs": [evidence_match.group(1)],
                                    "severity": "warning",
                                }
                            }
                        ),
                    }
                }
            )
        calls.append(
            {
                "function": {
                    "name": "finish_review",
                    "arguments": json.dumps({"summary": "offline multi-candidate review"}),
                }
            }
        )
        return ModelResponse(
            model="offline-v3-multi",
            provider_request_id=f"multi-provider-{self.calls}",
            usage=TokenUsage(total_tokens=1),
            tool_calls=calls,
        )


def test_v3_wire_schema_is_slim_and_has_no_legacy_fields() -> None:
    issue_schema = build_model_submit_tool_schemas(contract_version="3.0")[0][
        "function"
    ]["parameters"]["properties"]["issues"]["items"]
    assert set(issue_schema["properties"]) == {
        "anchor",
        "description",
        "evidence_refs",
        "severity",
        "suggestion",
        "related_locations",
    }
    assert "confidence" not in json.dumps(issue_schema)
    assert set(issue_schema["required"]) == {
        "anchor",
        "description",
        "evidence_refs",
        "severity",
    }


def test_v3_registry_actions_finish_without_repeating_finding_body() -> None:
    actions = build_v3_finding_action_tool_schemas()
    by_name = {item["function"]["name"]: item for item in actions}
    assert set(by_name) == {"save_finding", "revise_finding", "finish_review"}
    finish_schema = by_name["finish_review"]["function"]["parameters"]
    assert set(finish_schema["properties"]) == {"summary"}
    assert "issues" not in json.dumps(finish_schema)
    save_schema = by_name["save_finding"]["function"]["parameters"]
    assert "candidate_id" not in json.dumps(save_schema)
    assert "confidence" not in json.dumps(save_schema)


def test_v3_actions_write_and_finish_from_one_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    orchestrator = AgentOrchestrator(
        registry=ToolRegistry(),
        review_workflow_enforcement="off",
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]
    state = ContextState(evidence_ledger=list(CATALOG))
    save_plan = AnalysisPlan(
        v3_save_findings=[
            ModelSaveFindingActionV3(
                finding={
                    "anchor": {"file": "src/app.py", "line": 2},
                    "description": "The changed return value violates the caller contract.",
                    "evidence_refs": ["ev-diff"],
                    "severity": "warning",
                }
            )
        ]
    )
    save_results = asyncio.run(
        orchestrator.execute_tools(save_plan, ToolRegistry(), state)
    )
    assert save_results[0].data["opaque_handle"].startswith("vh_")
    handle = save_results[0].data["opaque_handle"]
    finish_plan = AnalysisPlan(
        v3_finish_review=ModelFinishReviewActionV3(summary="Saved finding set")
    )
    asyncio.run(orchestrator.execute_tools(finish_plan, ToolRegistry(), state))
    assert finish_plan.draft_review is not None
    assert len(finish_plan.draft_review.issues) == 1
    assert handle == orchestrator._candidate_registry.opaque_handle(  # noqa: SLF001
        finish_plan.draft_review.issues[0].candidate_id
    )


def test_v3_action_replay_and_duplicate_saves_never_replace_a_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CONTEXT_SUMMARY_ENABLED", "false")
    orchestrator = AgentOrchestrator(
        registry=ToolRegistry(),
        review_workflow_enforcement="off",
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]
    state = ContextState(evidence_ledger=list(CATALOG))

    def save(description: str) -> ModelSaveFindingActionV3:
        return ModelSaveFindingActionV3(
            finding={
                "anchor": {"file": "src/app.py", "line": 2},
                "description": description,
                "evidence_refs": ["ev-diff"],
                "severity": "warning",
            }
        )

    save_a = AnalysisPlan(v3_save_findings=[save("finding A")])
    save_b = AnalysisPlan(v3_save_findings=[save("finding B")])
    asyncio.run(orchestrator.execute_tools(save_a, ToolRegistry(), state))
    # Replaying the exact response is idempotent.
    asyncio.run(orchestrator.execute_tools(save_a, ToolRegistry(), state))
    # A duplicate in one batch and a distinct finding in a later batch both
    # route through the save transaction, never through source-index lookup.
    asyncio.run(
        orchestrator.execute_tools(
            AnalysisPlan(v3_save_findings=[save("finding A"), save("finding A")]),
            ToolRegistry(),
            state,
        )
    )
    failed_results = asyncio.run(
        orchestrator.execute_tools(
            AnalysisPlan(
                v3_save_findings=[
                    ModelSaveFindingActionV3.model_construct(finding=object())
                ]
            ),
            ToolRegistry(),
            state,
        )
    )
    assert failed_results[-1].ok is False
    asyncio.run(orchestrator.execute_tools(save_b, ToolRegistry(), state))

    records = orchestrator._candidate_registry.records  # noqa: SLF001
    assert len(records) == 2
    assert {record.current_content["description"] for record in records} == {
        "finding A",
        "finding B",
    }
    record_a = next(record for record in records if record.current_content["description"] == "finding A")
    record_b = next(record for record in records if record.current_content["description"] == "finding B")
    assert record_a.source_issue_indexes
    assert record_b.source_issue_indexes
    assert record_a.candidate_id != record_b.candidate_id

    reordered = AgentOrchestrator(
        registry=ToolRegistry(),
        review_workflow_enforcement="off",
    )
    reordered._settings.finding_contract_version = "3.0"  # type: ignore[assignment]
    reordered_state = ContextState(evidence_ledger=list(CATALOG))
    asyncio.run(
        reordered.execute_tools(
            AnalysisPlan(v3_save_findings=[save("finding B"), save("finding A")]),
            ToolRegistry(),
            reordered_state,
        )
    )
    assert {
        record.current_content["description"]
        for record in reordered._candidate_registry.records  # noqa: SLF001
    } == {"finding A", "finding B"}


def test_v3_public_result_and_artifact_do_not_emit_fake_confidence() -> None:
    response = ReviewResponse(
        run_id="run-v3",
        report=ReviewReport(issues=[_issue()], schema_version="3.0"),
        context=ContextState(),
        semantic_verifier_required=True,
        semantic_verifier_completed=True,
        report_ready=True,
    )
    payload = response.contract_payload()
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "confidence" not in serialized
    assert set(payload["report"]["issues"][0]) == {
        "schema_version",
        "anchor",
        "description",
        "evidence_refs",
        "severity",
        "suggestion",
    }
    restored = ReviewResponse.model_validate(payload)
    assert restored.report.issues[0].primary_anchor is not None
    assert restored.report.issues[0].confidence == 0.0

    # The artifact helper is exercised through its JSON conversion without
    # creating a workspace artifact in the repository.
    from src.platform.artifacts import _jsonable

    assert "confidence" not in json.dumps(_jsonable(response), ensure_ascii=False)


def test_v3_publisher_rejects_unapproved_response_before_fake_client() -> None:
    response = _approved_v3_response().model_copy(
        update={"report_ready": False}
    )
    client = _NoNetworkPublisherClient()
    request = GitHubPublishRequest(
        owner_repo="owner/repo",
        pr_number=7,
        head_sha="head-sha",
        response=response,
        changed_lines={"src/app.py": [2]},
        dry_run=False,
        publish_comments=False,
    )
    with pytest.raises(ValueError, match="report_not_ready"):
        asyncio.run(GitHubPublisher(client).publish(request))
    assert client.calls == []


def test_v3_publisher_does_not_treat_report_ready_as_approval() -> None:
    approved = _approved_v3_response()
    response = approved.model_copy(
        update={"context": ContextState(), "report_ready": True}
    )
    assert validate_v3_publish_binding(response) == (
        False,
        "v3_candidate_registration_missing",
    )
    client = _NoNetworkPublisherClient()
    request = GitHubPublishRequest(
        owner_repo="owner/repo",
        pr_number=7,
        head_sha="head-sha",
        response=response,
        dry_run=False,
        publish_comments=False,
    )
    with pytest.raises(ValueError, match="v3_candidate_registration_missing"):
        asyncio.run(GitHubPublisher(client).publish(request))
    assert client.calls == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("description", "tampered description"),
        ("location", "src/other.py:99"),
        ("primary_anchor", SourceAnchor(file="src/other.py", line=99)),
        ("evidence_refs", ["ev-other"]),
        ("severity", Severity.CRITICAL),
    ],
)
def test_v3_publisher_rejects_report_mutation_after_approval(
    field: str,
    value: object,
) -> None:
    approved = _approved_v3_response()
    issue = approved.report.issues[0].model_copy(update={field: value})
    response = approved.model_copy(
        deep=True,
        update={
            "report": ReviewReport(issues=[issue], schema_version="3.0"),
        },
    )
    assert validate_v3_publish_binding(response)[0] is False
    client = _NoNetworkPublisherClient()
    request = GitHubPublishRequest(
        owner_repo="owner/repo",
        pr_number=7,
        head_sha="head-sha",
        response=response,
        dry_run=False,
        publish_comments=False,
    )
    with pytest.raises(ValueError, match="external publication is blocked"):
        asyncio.run(GitHubPublisher(client).publish(request))
    assert client.calls == []


def test_v3_publisher_enters_fake_client_only_for_version_consistent_approval() -> None:
    response = _approved_v3_response()
    client = _NoNetworkPublisherClient()
    result = asyncio.run(
        GitHubPublisher(client).publish(
            GitHubPublishRequest(
                owner_repo="owner/repo",
                pr_number=7,
                head_sha="head-sha",
                response=response,
                changed_lines={"src/app.py": [2]},
                dry_run=False,
                publish_comments=False,
            )
        )
    )
    assert result.status == "published"
    assert client.calls == ["create_check_run"]


def test_v3_publisher_invalidates_related_evidence_but_not_unrelated_evidence() -> None:
    approved = _approved_v3_response()
    related_change = {**CATALOG[0], "content_hash": "changed-related-body"}
    changed_context = approved.context.model_copy(
        update={"evidence_ledger": [related_change]}
    )
    changed_response = approved.model_copy(
        deep=True,
        update={"context": changed_context},
    )
    assert validate_v3_publish_binding(changed_response) == (
        False,
        "v3_semantic_receipt_evidence_changed",
    )

    unrelated = {
        **CATALOG[0],
        "evidence_id": "ev-unrelated",
        "artifact_id": "artifact-unrelated",
        "path": "src/other.py",
    }
    unrelated_context = approved.context.model_copy(
        update={"evidence_ledger": [*CATALOG, unrelated]}
    )
    unaffected_response = approved.model_copy(
        deep=True,
        update={"context": unrelated_context},
    )
    assert validate_v3_publish_binding(unaffected_response) == (
        True,
        "v3_runtime_approval_bound",
    )


def test_v3_publisher_dry_run_plans_without_claiming_or_using_approval() -> None:
    response = _approved_v3_response().model_copy(
        update={"report_ready": False}
    )
    client = _NoNetworkPublisherClient()
    result = asyncio.run(
        GitHubPublisher(client).publish(
            GitHubPublishRequest(
                owner_repo="owner/repo",
                pr_number=7,
                head_sha="head-sha",
                response=response,
                dry_run=True,
                publish_comments=False,
            )
        )
    )
    assert result.status == "dry_run"
    assert client.calls == []


def test_v3_normalization_binds_refs_without_recreating_old_narrative() -> None:
    issue = _issue()
    assert issue.is_v3_finding
    assert issue.description.startswith("The changed")
    assert issue.evidence_refs == ["ev-diff"]
    assert issue.observed_behavior == ""
    assert issue.causal_mechanism == ""
    assert issue.violated_invariant == ""
    assert issue.trigger == ""
    assert issue.impact == ""
    assert issue.supports == []
    assert issue.confidence == 0.0  # compatibility storage only; never model-facing
    assert canonical_contract_gaps(issue) == []


def test_v3_policy_does_not_use_text_format_or_confidence_as_semantics() -> None:
    issue = _issue().model_copy(
        update={
            "evidence": "decorative prose without backticks",
            "confidence": 0.0,
        }
    )
    decision = evaluate_issue_filter(issue)
    assert decision.passed is True
    assert decision.reason_codes == ("v3_semantic_verifier_required",)


def test_semantic_verifier_rejects_causal_error_even_when_integrity_is_complete() -> (
    None
):
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "reject",
                        "reason": "The cited line does not establish the claimed caller contract.",
                    }
                ]
            }
        ]
    )
    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate()],
            changed_diff="+ return value",
            evidence=CATALOG,
            content_versions={"h-1": "v1"},
            evidence_context_digests={"h-1": "d1"},
        )
    )
    assert result.rejected_count == 1
    assert result.unresolved_count == 0
    assert client.calls == 1


def test_semantic_verifier_sufficient_material_never_investigates() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "The supplied diff and evidence support the claim.",
                    }
                ]
            }
        ]
    )

    async def investigator(*args: object) -> InvestigationResult:
        raise AssertionError("sufficient material must not trigger investigation")

    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate()], evidence=CATALOG, investigator=investigator
        )
    )
    assert result.accepted_count == 1
    assert result.investigation_call_count == 0


def test_orchestrator_investigation_adapter_uses_explicit_bounded_read_only_action(
    tmp_path,
) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir(parents=True)
    target.write_text("one\ntwo\nthree\nfour\n", encoding="utf-8")
    orchestrator = AgentOrchestrator()
    orchestrator._workspace_root = tmp_path  # noqa: SLF001
    orchestrator._run_started_at = perf_counter()  # noqa: SLF001
    orchestrator._run_timeout_seconds = 30.0  # noqa: SLF001
    orchestrator._evidence_snapshot_id = "snapshot-test"  # noqa: SLF001
    orchestrator._evidence_revision = "revision-test"  # noqa: SLF001
    state = ContextState()

    explicit = json.dumps(
        {
            "question": "Confirm the helper body.",
            "action": {
                "tool": "read_file",
                "file": "src/app.py",
                "start_line": 2,
                "end_line": 3,
            },
        }
    )
    result = asyncio.run(
        orchestrator._investigate_semantic_candidate(  # noqa: SLF001
            explicit,
            _candidate(),
            max_calls=2,
            state=state,
        )
    )
    assert result.tool_call_count == 1
    assert result.evidence
    assert orchestrator._tool_name_counts["read_file"] == 1  # noqa: SLF001
    assert any(item.get("path") == "src/app.py" for item in state.evidence_ledger)
    assert any(item.get("start_line") == 2 for item in state.evidence_ledger)

    fallback = asyncio.run(
        orchestrator._investigate_semantic_candidate(  # noqa: SLF001
            "Read src/app.py:2 and see what it says.",
            _candidate(),
            max_calls=2,
            state=state,
        )
    )
    assert fallback.tool_call_count == 0
    assert fallback.answer == "investigation_action_missing"


def test_severity_correction_cannot_silently_accept_the_old_content_version() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "The behavior is supported but severity needs correction.",
                        "severity_correction": "info",
                    }
                ]
            }
        ]
    )
    result = asyncio.run(SemanticVerifier(client).verify([_candidate()]))
    assert result.accepted_count == 0
    assert result.needs_revision_count == 1
    assert result.receipts[0].verdict == "needs_revision"


def test_semantic_verifier_investigates_once_only_for_concrete_revision_request() -> (
    None
):
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "needs_revision",
                        "reason": "The called helper's return contract is missing.",
                        "request": "Read helper.py:8 to confirm its return contract.",
                    }
                ]
            },
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "The helper confirms the changed behavior.",
                    }
                ]
            },
        ]
    )
    investigation_calls: list[tuple[str, int]] = []

    async def investigate(
        question: str, candidate: SemanticVerifierCandidate, max_calls: int
    ) -> InvestigationResult:
        investigation_calls.append((question, max_calls))
        assert candidate.opaque_handle == "h-1"
        return InvestigationResult(
            answer="helper returns the incompatible value", tool_call_count=2
        )

    result = asyncio.run(
        SemanticVerifier(
            client,
            budget=SemanticVerifierBudget(max_model_calls=2),
        ).verify(
            [_candidate()],
            evidence=CATALOG,
            evidence_context_digests={"h-1": "digest-with-investigation"},
            investigator=investigate,
            investigation_evidence_refs={"h-1": ["ev-investigated"]},
        )
    )
    assert result.accepted_count == 1
    assert result.investigation_call_count == 1
    assert result.investigation_tool_call_count == 2
    assert len(investigation_calls) == 1
    assert result.receipts[0].investigation_calls == 1
    assert result.receipts[0].investigation_evidence_refs == ["ev-investigated"]
    assert result.receipts[0].evidence_context_digest == "digest-with-investigation"
    assert result.receipts[0].input_digest
    assert result.receipts[0].request_hash
    assert result.receipts[0].response_digest
    assert len(client.messages) == 2
    assert "targeted_investigation" not in client.messages[0][1].content
    assert "targeted_investigation" in client.messages[1][1].content
    assert client.messages[0][1].content != client.messages[1][1].content


def test_semantic_recheck_wrong_handle_is_unresolved_not_first_item_accept() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
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
                ]
            },
            {
                "decisions": [
                    {
                        "opaque_handle": "WRONG-HANDLE",
                        "verdict": "accept",
                        "reason": "wrong target",
                    }
                ]
            },
        ]
    )

    async def investigate(*args: object) -> InvestigationResult:
        del args
        return InvestigationResult(answer="targeted source", tool_call_count=1)

    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate()],
            investigator=investigate,
        )
    )
    assert client.calls == 2
    assert result.accepted_count == 0
    assert result.unresolved_count == 1
    assert result.receipts[0].error_code == "semantic_verifier_unknown_handle"


def test_semantic_recheck_mixed_handles_fails_closed_for_the_target() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "needs_revision",
                        "reason": "A targeted source check is required.",
                        "request": "Read the exact helper range.",
                    }
                ]
            },
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "confirmed",
                    },
                    {
                        "opaque_handle": "WRONG-HANDLE",
                        "verdict": "accept",
                        "reason": "unknown target",
                    },
                ]
            },
        ]
    )

    async def investigate(*args: object) -> InvestigationResult:
        del args
        return InvestigationResult(answer="targeted source", tool_call_count=1)

    result = asyncio.run(
        SemanticVerifier(client).verify([_candidate()], investigator=investigate)
    )
    assert result.accepted_count == 0
    assert result.unresolved_count == 1
    assert "semantic_verifier_unknown_handle" in result.errors


def test_semantic_verifier_duplicate_conflicting_handle_is_fail_closed() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "first",
                    },
                    {
                        "opaque_handle": "h-1",
                        "verdict": "reject",
                        "reason": "conflict",
                    },
                ]
            }
        ]
    )
    result = asyncio.run(SemanticVerifier(client).verify([_candidate()]))
    assert result.accepted_count == 0
    assert result.rejected_count == 0
    assert result.unresolved_count == 1
    assert result.receipts[0].error_code == "semantic_verifier_duplicate_handle"


def test_semantic_verifier_multiple_tool_calls_make_the_batch_unresolved() -> None:
    client = _RawVerifierClient(
        [
            [
                _verification_call(
                    {
                        "decisions": [
                            {
                                "opaque_handle": "h-1",
                                "verdict": "accept",
                                "reason": "first",
                            }
                        ]
                    }
                ),
                _verification_call(
                    {
                        "decisions": [
                            {
                                "opaque_handle": "h-1",
                                "verdict": "reject",
                                "reason": "second",
                            }
                        ]
                    }
                ),
            ]
        ]
    )
    result = asyncio.run(SemanticVerifier(client).verify([_candidate()]))
    assert result.unresolved_count == 1
    assert result.accepted_count == 0
    assert result.rejected_count == 0
    assert result.receipts[0].error_code == "semantic_verifier_multiple_tool_calls"


@pytest.mark.parametrize(
    "decision",
    [
        {"opaque_handle": "h-1", "verdict": "accept", "reason": ""},
        {"opaque_handle": "h-1", "verdict": "needs_revision", "reason": "missing request"},
    ],
)
def test_semantic_verifier_invalid_reason_or_revision_request_is_unresolved(
    decision: dict[str, object],
) -> None:
    client = _VerifierClient([{"decisions": [decision]}])
    result = asyncio.run(SemanticVerifier(client).verify([_candidate()]))
    assert result.unresolved_count == 1
    assert result.accepted_count == 0
    assert result.rejected_count == 0


def test_semantic_verifier_batch_result_is_order_independent() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-2",
                        "verdict": "accept",
                        "reason": "supported",
                    },
                    {
                        "opaque_handle": "h-1",
                        "verdict": "reject",
                        "reason": "unsupported",
                    },
                ]
            }
        ]
    )
    result = asyncio.run(
        SemanticVerifier(client).verify([_candidate("h-1"), _candidate("h-2")])
    )
    by_handle = {receipt.opaque_handle: receipt for receipt in result.receipts}
    assert by_handle["h-1"].verdict == "reject"
    assert by_handle["h-2"].verdict == "accept"


def test_semantic_batch_keeps_valid_handle_and_marks_missing_other_handle() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {"opaque_handle": "h-1", "verdict": "accept", "reason": "ok"},
                    {
                        "opaque_handle": "WRONG-HANDLE",
                        "verdict": "accept",
                        "reason": "unknown",
                    },
                ]
            }
        ]
    )
    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate("h-1"), _candidate("h-2")],
        )
    )
    by_handle = {receipt.opaque_handle: receipt for receipt in result.receipts}
    assert by_handle["h-1"].verdict == "accept"
    assert by_handle["h-2"].verdict == "unresolved"
    assert "semantic_verifier_unknown_handle" in result.errors


def test_semantic_budget_stops_the_next_batch_after_first_usage_exhausts_hard_cap() -> None:
    client = _UsageVerifierClient(
        [
            {
                "decisions": [
                    {"opaque_handle": "h-1", "verdict": "accept", "reason": "ok"}
                ]
            },
            {
                "decisions": [
                    {"opaque_handle": "h-2", "verdict": "accept", "reason": "ok"}
                ]
            },
        ],
        total_tokens=2,
    )
    result = asyncio.run(
        SemanticVerifier(
            client,
            budget=SemanticVerifierBudget(
                batch_size=1,
                max_model_calls=2,
                hard_token_budget=2,
            ),
        ).verify([_candidate("h-1"), _candidate("h-2")])
    )
    assert client.calls == 1
    assert result.model_call_count == 1
    assert result.accepted_count == 1
    assert result.unresolved_count == 1


def test_semantic_recheck_is_skipped_when_investigation_consumes_wall_clock() -> None:
    clock = _MutableClock()
    client = _UsageVerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "needs_revision",
                        "reason": "The helper range is required.",
                        "request": "Read the exact helper range.",
                    }
                ]
            }
        ],
        total_tokens=1,
    )
    investigator = _ClockAdvancingInvestigator(clock, advance=2.0)
    result = asyncio.run(
        SemanticVerifier(
            client,
            budget=SemanticVerifierBudget(
                max_model_calls=2,
                max_investigation_calls=1,
                timeout_seconds=1.0,
            ),
            clock=clock,
        ).verify([_candidate()], investigator=investigator)
    )
    assert investigator.calls == 1
    assert client.calls == 1
    assert result.unresolved_count == 1
    assert (
        result.receipts[0].error_code
        == "semantic_verifier_budget_exhausted_before_recheck"
    )


def test_semantic_request_is_rejected_before_provider_send_when_over_hard_input_cap() -> None:
    client = _UsageVerifierClient(
        [
            {
                "decisions": [
                    {"opaque_handle": "h-1", "verdict": "accept", "reason": "ok"}
                ]
            }
        ],
        total_tokens=1,
    )
    huge = _candidate().model_copy(
        update={
            "content": _candidate().content.model_copy(
                update={"description": "x" * 20_000}
            )
        }
    )
    result = asyncio.run(
        SemanticVerifier(
            client,
            budget=SemanticVerifierBudget(request_token_budget=512),
        ).verify([huge])
    )
    assert client.calls == 0
    assert result.unresolved_count == 1
    assert result.receipts[0].error_code == "semantic_verifier_request_over_budget"


def test_semantic_provider_attempts_are_reconciled_separately_from_logical_calls() -> None:
    client = _UsageVerifierClient(
        [
            {
                "decisions": [
                    {"opaque_handle": "h-1", "verdict": "accept", "reason": "ok"}
                ]
            }
        ],
        total_tokens=1,
        telemetry=[
            {"success": False, "usage_present": False, "usage_unknown": True},
            {"success": True, "usage_present": True, "usage_unknown": False},
        ],
    )
    result = asyncio.run(SemanticVerifier(client).verify([_candidate()]))
    assert result.model_call_count == 1
    assert result.provider_attempt_count == 2
    assert result.failed_provider_attempt_count == 1
    assert result.failed_unknown_usage_count == 1
    assert result.accepted_count == 1


def test_missing_verdict_or_timeout_is_unresolved_not_guard_only_accept() -> None:
    missing = _VerifierClient([{"decisions": []}])
    missing_result = asyncio.run(SemanticVerifier(missing).verify([_candidate()]))
    assert missing_result.unresolved_count == 1
    assert missing_result.receipts[0].error_code == "semantic_verifier_missing_verdict"

    class TimeoutClient(_VerifierClient):
        async def chat(self, *args: object, **kwargs: object) -> ModelResponse:
            del args, kwargs
            raise TimeoutError("offline timeout")

    timeout_result = asyncio.run(
        SemanticVerifier(TimeoutClient([])).verify([_candidate()])
    )
    assert timeout_result.unresolved_count == 1
    assert timeout_result.receipts[0].error_code == "semantic_verifier_timeout"


def test_batch_missing_one_handle_is_unresolved_without_dropping_other_handle() -> None:
    client = _VerifierClient(
        [
            {
                "decisions": [
                    {
                        "opaque_handle": "h-1",
                        "verdict": "accept",
                        "reason": "supported",
                    }
                ]
            }
        ]
    )
    result = asyncio.run(
        SemanticVerifier(client).verify(
            [_candidate("h-1"), _candidate("h-2")],
            content_versions={"h-1": "v1", "h-2": "v2"},
            evidence_context_digests={"h-1": "d1", "h-2": "d2"},
        )
    )
    by_handle = {item.opaque_handle: item for item in result.receipts}
    assert by_handle["h-1"].verdict == "accept"
    assert by_handle["h-2"].verdict == "unresolved"
    assert result.accepted_count == 1
    assert result.unresolved_count == 1


def test_candidate_registry_revision_and_relevant_evidence_digest_are_version_bound() -> (
    None
):
    registry = CandidateRegistry()
    issue = _issue()
    record = registry.save_finding(issue, source_issue_index=0, iteration=0)
    handle = registry.opaque_handle(record.candidate_id)
    assert handle.startswith("vh_")
    assert registry.candidate_for_handle(handle) == record.candidate_id
    old_version = record.candidate_content_version
    revised = issue.model_copy(
        update={"description": "A revised supported conclusion."}
    )
    assert registry.revise_finding(
        record.candidate_id, revised, base_version=old_version
    )
    assert registry.expected_version(record.candidate_id) != old_version
    assert not registry.revise_finding(
        record.candidate_id, issue, base_version=old_version
    )

    unrelated = {
        **CATALOG[0],
        "evidence_id": "ev-unrelated",
        "artifact_id": "artifact-unrelated",
        "path": "src/other.py",
        "content_hash": "other",
    }
    before = relevant_evidence_context_digest(
        CATALOG, ["ev-diff"], snapshot_id="s", revision="r"
    )
    after = relevant_evidence_context_digest(
        [*CATALOG, unrelated], ["ev-diff"], snapshot_id="s", revision="r"
    )
    changed = relevant_evidence_context_digest(
        [{**CATALOG[0], "content_hash": "changed"}],
        ["ev-diff"],
        snapshot_id="s",
        revision="r",
    )
    assert before == after
    assert changed != before
    assert candidate_content_version(issue) == candidate_content_version(
        issue.model_copy(update={"evidence_provenance": []})
    )


def test_v3_repair_is_opaque_and_null_requires_explicit_delete() -> None:
    schema = build_repair_tool_schemas(contract_version="3.0")[0]["function"][
        "parameters"
    ]
    schema_text = json.dumps(schema, ensure_ascii=False)
    assert "candidate_id" not in schema_text
    assert "candidate_content_version" not in schema_text
    assert "target_handle" in schema_text

    with pytest.raises(Exception, match="null is ambiguous"):
        FindingPatchV3(suggestion=None)
    assert FindingPatchV3(delete_fields=["suggestion"]).delete_fields == ["suggestion"]


def test_github_v3_projection_uses_description_and_refs_without_confidence() -> None:
    response = ReviewResponse(
        run_id="run-gh-v3",
        report=ReviewReport(issues=[_issue()], schema_version="3.0"),
        context=ContextState(),
    )
    payload = build_github_advisory_payload(response, {"src/app.py": {2}})
    assert payload.inline_comments
    body = payload.inline_comments[0].body
    assert "The changed return value" in body
    assert "Evidence refs: ev-diff" in body
    assert "confidence" not in body.lower()


@pytest.mark.parametrize(
    "bad", [{"evidence_refs": ["ev-diff", "ev-diff"]}, {"description": ""}]
)
def test_v3_contract_rejects_duplicate_or_empty_core_fields(
    bad: dict[str, object],
) -> None:
    payload = {
        "anchor": {"file": "src/app.py", "line": 2},
        "description": "supported",
        "evidence_refs": ["ev-diff"],
        "severity": "warning",
        **bad,
    }
    with pytest.raises(Exception):
        ModelFindingInputV3.model_validate(payload)


def test_v3_run_review_closes_verifier_severity_repair_and_independent_recheck(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
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
    client = _ScriptedV3RunClient()
    orchestrator = AgentOrchestrator(
        registry=ToolRegistry(),
        review_max_iterations=2,
        review_min_tool_iterations=0,
        review_workflow_enforcement="off",
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]  # noqa: SLF001
    orchestrator._settings.review_repair_max_attempts = 1  # noqa: SLF001
    orchestrator._settings.semantic_verifier_max_model_calls = 2  # noqa: SLF001
    client.orchestrator = orchestrator
    client.diff_text = diff
    orchestrator._model_client = client  # type: ignore[assignment]  # noqa: SLF001

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

    assert client.stages == ["reviewer", "verify", "repair", "recheck"], (
        client.stages,
        client.name_history,
        len(response.report.issues),
        [item.model_dump(mode="json") for item in orchestrator._candidate_registry.records],  # noqa: SLF001
        response.incomplete_reasons,
        orchestrator._integrity_failure_codes,  # noqa: SLF001
    )
    assert len(response.report.issues) == 1
    assert response.report.issues[0].severity.value == "info"
    assert response.semantic_verifier_completed is True
    assert response.semantic_needs_revision_count == 0
    assert response.report_ready is True, (
        response.incomplete_reasons,
        orchestrator._integrity_needs_repair_count,  # noqa: SLF001
        orchestrator._integrity_invalid_count,  # noqa: SLF001
        orchestrator._semantic_unresolved_count,  # noqa: SLF001
    )
    assert orchestrator._review_repair_attempt_count == 1  # noqa: SLF001
    assert orchestrator._repair_model_call_count == 1  # noqa: SLF001
    assert orchestrator._repair_transactions[0].status == "accepted"  # noqa: SLF001
    registration = orchestrator._candidate_registry.records[0]  # noqa: SLF001
    assert registration.semantic_verdict == "accept"
    assert registration.semantic_validated_content_version == (
        registration.candidate_content_version
    )
    assert orchestrator._run_journal is not None  # noqa: SLF001
    semantic_entries = [
        entry
        for entry in orchestrator._run_journal.replay()  # noqa: SLF001
        if entry.type == "semantic_verifier_call"
    ]
    assert [entry.payload["phase"] for entry in semantic_entries].count("request") >= 2
    assert [entry.payload["phase"] for entry in semantic_entries].count("receipt") >= 2
    receipt_payloads = [
        entry.payload for entry in semantic_entries if entry.payload["phase"] == "receipt"
    ]
    assert all(
        payload["input_digest"]
        and payload["request_hash"]
        and payload["response_digest"]
        and payload["provider_request_id"]
        for payload in receipt_payloads
    )
    publisher_client = _NoNetworkPublisherClient()
    publish_result = asyncio.run(
        GitHubPublisher(publisher_client).publish(
            GitHubPublishRequest(
                owner_repo="owner/repo",
                pr_number=7,
                head_sha="head-sha",
                response=response,
                changed_lines={"src/app.py": [1]},
                dry_run=False,
                publish_comments=False,
            )
        )
    )
    assert publish_result.status == "published"
    assert publisher_client.calls == ["create_check_run"]


@pytest.mark.parametrize("mode", ["partial", "unresolved"])
def test_v3_run_review_keeps_partial_candidates_and_funnel_facts_consistent(
    mode: str,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
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
    client = _MultiCandidateV3RunClient(mode)
    orchestrator = AgentOrchestrator(
        registry=ToolRegistry(),
        review_max_iterations=2,
        review_min_tool_iterations=0,
        review_workflow_enforcement="off",
    )
    orchestrator._settings.finding_contract_version = "3.0"  # type: ignore[assignment]  # noqa: SLF001
    orchestrator._settings.semantic_verifier_max_model_calls = 1  # noqa: SLF001
    client.orchestrator = orchestrator
    client.diff_text = diff
    orchestrator._model_client = client  # type: ignore[assignment]  # noqa: SLF001

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

    assert len(orchestrator._candidate_registry.records) == 2  # noqa: SLF001
    assert len(response.report.issues) == 1
    assert response.report.issues[0].description == "Candidate A describes a distinct claim."
    registrations = {
        item["candidate_id"]: item for item in response.context.candidate_registrations
    }
    receipts = [
        receipt
        for registration in registrations.values()
        for receipt in registration.get("semantic_receipts", [])
    ]
    assert len(receipts) == 2
    assert {
        registration.get("semantic_verdict") for registration in registrations.values()
    } == ({"accept", "reject"} if mode == "partial" else {"accept", "unresolved"})
    assert all(issue.candidate_id in registrations for issue in response.report.issues)
    assert all(
        registrations[issue.candidate_id]["semantic_verdict"] == "accept"
        for issue in response.report.issues
    )
    assert response.semantic_accepted_count == 1
    if mode == "partial":
        assert response.semantic_rejected_count == 1
        assert response.semantic_unresolved_count == 0
        assert response.report_ready is True
    else:
        assert response.semantic_rejected_count == 0
        assert response.semantic_unresolved_count == 1
        assert response.report_ready is False
        assert "semantic_verifier_unresolved" in response.incomplete_reasons

    assert orchestrator._run_journal is not None  # noqa: SLF001
    journal_entries = orchestrator._run_journal.replay()  # noqa: SLF001
    journal_receipts = [
        entry
        for entry in journal_entries
        if entry.type == "semantic_verifier_call"
        and entry.payload["phase"] == "receipt"
    ]
    assert len(journal_receipts) == 2
    assert {
        entry.payload["candidate_id"] for entry in journal_receipts
    } == set(registrations)
    assert response.semantic_accepted_count + response.semantic_rejected_count + response.semantic_unresolved_count == 2
