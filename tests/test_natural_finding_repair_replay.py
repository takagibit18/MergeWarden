"""Offline cross-stage replays for natural finding-delivery gaps.

The inputs below are deliberately small, sanitized projections of the previous
Haystack and Discount journals.  The repair responses are test fixtures, not
model output.  The tests still run the orchestrator's submit -> integrity ->
repair transaction -> patch merge -> revalidation -> finalization path.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from src.analyzer.evidence_ledger import ObservedEvidence
from src.analyzer.finding_contract import ModelRepairResponse
from src.analyzer.finding_integrity import (
    FindingIntegrityResult,
    IntegrityFailure,
    classify_integrity_failure,
)
from src.analyzer.context_state import ContextState
from src.analyzer.finding_schema import (
    ClaimSupport,
    EvidenceProvenance,
    RepairIntent,
    SourceAnchor,
)
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import AnalysisPlan, ReviewRequest
from src.orchestrator.agent_loop import AgentOrchestrator


_REPLAY_REVISION = "3ad4876"


def _evidence(
    evidence_id: str,
    *,
    file: str,
    line: int,
    statement: str,
) -> EvidenceProvenance:
    return EvidenceProvenance(
        artifact_id=evidence_id,
        evidence_id=evidence_id,
        reference_id=evidence_id,
        file=file,
        line=line,
        end_line=line,
        retrieval_source="read_file",
        evidence_eligibility="strong",
        statement=statement,
    )


def _issue(
    *,
    file: str,
    severity: Severity,
    evidence: str,
    missing_contract: bool,
    duplicate_cause: bool = False,
    missing_invariant: bool = False,
) -> ReviewIssue:
    role_evidence = {
        "cause": _evidence(
            "ev-cause",
            file=file,
            line=2,
            statement="The changed code causes the reported behavior.",
        ),
        "trigger": _evidence(
            "ev-trigger",
            file=file,
            line=2,
            statement="The changed branch is reached by the triggering call.",
        ),
        "impact": _evidence(
            "ev-impact",
            file=file,
            line=2,
            statement="The observed result violates the caller-visible behavior.",
        ),
    }
    cause_evidence = [role_evidence["cause"]]
    supports: list[ClaimSupport] = [
        ClaimSupport(
            role="cause",
            statement="The changed code causes the reported behavior.",
            evidence_refs=["ev-cause"],
        )
    ]
    if duplicate_cause:
        for index in (2, 3):
            evidence_id = f"ev-cause-{index}"
            cause_evidence.append(
                _evidence(
                    evidence_id,
                    file=file,
                    line=2,
                    statement=f"Cause evidence span {index} supports the same claim.",
                )
            )
            supports.append(
                ClaimSupport(
                    role="cause",
                    statement=f"Cause evidence span {index} supports the same claim.",
                    evidence_refs=[evidence_id],
                )
            )
    supports.extend(
        [
            ClaimSupport(
                role="trigger",
                statement="The changed branch is reached by the triggering call.",
                evidence_refs=["ev-trigger"],
            ),
            ClaimSupport(
                role="impact",
                statement="The observed result violates the caller-visible behavior.",
                evidence_refs=["ev-impact"],
            ),
        ]
    )
    if not missing_contract:
        role_evidence["contract"] = _evidence(
            "ev-contract",
            file=file,
            line=2,
            statement="The existing caller contract requires the expected behavior.",
        )
        supports.insert(
            1,
            ClaimSupport(
                role="contract",
                statement="The existing caller contract requires the expected behavior.",
                evidence_refs=["ev-contract"],
            ),
        )
    return ReviewIssue(
        schema_version="2.0",
        severity=severity,
        location=f"{file}:2",
        primary_anchor=SourceAnchor(file=file, line=2, symbol_id="replay.target"),
        evidence=evidence,
        suggestion="Restore the established caller-visible behavior.",
        confidence=0.95,
        observed_behavior="The changed code produces the incorrect caller-visible result.",
        causal_mechanism="The changed expression applies the incompatible behavior.",
        violated_invariant="" if missing_invariant else "The established behavior must hold exactly once.",
        repair_intent=RepairIntent(
            action="Restore the established behavior at the changed line.",
            targets=[f"{file}:2"],
            boundary=f"{file}:2",
        ),
        trigger="A caller reaches the changed branch.",
        impact="Affected callers observe an incorrect result.",
        supports=supports,
        cause_evidence=cause_evidence,
        contract_evidence=[role_evidence["contract"]]
        if "contract" in role_evidence
        else [],
        trigger_evidence=[role_evidence["trigger"]],
        impact_evidence=[role_evidence["impact"]],
    )


def _write_fixture_repo(tmp_path: Path, file: str) -> ReviewRequest:
    target = tmp_path / file
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "first line\nchanged line\nthird line\nfourth line\n",
        encoding="utf-8",
    )
    diff = (
        f"diff --git a/{file} b/{file}\n"
        f"--- a/{file}\n+++ b/{file}\n"
        "@@ -1,4 +1,4 @@\n"
        " first line\n"
        "-old line\n"
        "+changed line\n"
        " third line\n"
        " fourth line\n"
    )
    return ReviewRequest(repo_path=str(tmp_path), diff_mode=True, diff_text=diff)


class _ReplayOrchestrator(AgentOrchestrator):
    """Use fixture plans while retaining the production orchestration stages."""

    def __init__(
        self,
        report: ReviewReport,
        repair_patch: Callable[[str], dict[str, Any]],
        *,
        repair_budget: int,
    ) -> None:
        super().__init__(
            context_mode="agent_search",
            review_max_iterations=1,
            review_workflow_enforcement="off",
        )
        self._settings.review_repair_max_attempts = repair_budget
        self._replay_report = report
        self._repair_patch = repair_patch
        self.calls: list[dict[str, Any]] = []

    async def _prepare_review_context(self, state, request) -> None:  # type: ignore[no-untyped-def]
        state.context_mode = "agent_search"
        state.evidence_snapshot_id = self._evidence_snapshot_id
        state.evidence_revision = self._evidence_revision
        for issue in self._replay_report.issues:
            for evidence in issue.all_evidence():
                evidence.snapshot_id = self._evidence_snapshot_id
                evidence.revision = self._evidence_revision
        state.evidence_ledger = [
            ObservedEvidence(
                artifact_id=f"artifact-{evidence_id}",
                evidence_id=evidence_id,
                snapshot_id=self._evidence_snapshot_id,
                revision=self._evidence_revision,
                path=issue.location.split(":", 1)[0],
                start_line=2,
                end_line=2,
                content="changed line",
                source_type="read_file",
            ).model_dump(mode="json")
            for issue in self._replay_report.issues
            for evidence_id in (
                "ev-cause",
                "ev-cause-2",
                "ev-cause-3",
                "ev-contract",
                "ev-trigger",
                "ev-impact",
            )
        ]
        self._publish_evidence_catalog(state)

    async def _maybe_prefetch_review_changed_files(
        self,
        state: ContextState,
        request: ReviewRequest,
        *,
        force: bool = False,
        trigger: str = "",
    ) -> None:
        return None

    async def analyze(  # type: ignore[override]
        self,
        state,
        request,
        tool_specs,
        *,
        force_submit: bool = False,
        allow_exploration: bool = False,
        repair_mode: bool = False,
    ) -> AnalysisPlan:
        self.calls.append(
            {
                "repair_mode": repair_mode,
                "force_submit": force_submit,
                "tool_count": len(tool_specs),
            }
        )
        if repair_mode:
            transaction = self._active_repair_transaction
            assert transaction is not None
            handle = next(iter(transaction.target_handles))
            response = ModelRepairResponse.model_validate(
                {
                    "repairs": [
                        {
                            "target_handle": handle,
                            "repair_status": "repaired",
                            "repair_patch": self._repair_patch(handle),
                        }
                    ]
                }
            )
            return AnalysisPlan(
                source_response_id="offline-repair-fixture",
                repair_response=response,
            )
        self._submit_review_seen_any = True  # noqa: SLF001
        self._submit_iteration = self._iteration  # noqa: SLF001
        self._submitted_attempt_count += 1  # noqa: SLF001
        return AnalysisPlan(
            source_response_id="offline-submit-fixture",
            draft_review=self._replay_report,
        )


def _event_log(repo: Path, run_id: str) -> list[dict[str, Any]]:
    path = repo / ".mergewarden" / "logs" / f"{run_id}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def _haystack_patch(_handle: str) -> dict[str, Any]:
    return {
        "violated_invariant": "Malformed sources must be skipped without a metadata KeyError.",
        "supports": [
            {
                "role": "cause",
                "statement": "The direct metadata lookup causes the exception-path failure.",
                "evidence_refs": ["ev-cause", "ev-cause-2", "ev-cause-3"],
            },
            {
                "role": "contract",
                "statement": "The converter must skip malformed inputs safely.",
                "evidence_refs": ["ev-contract"],
            },
        ],
    }


def _discount_contract_patch(_handle: str) -> dict[str, Any]:
    return {
        "supports": [
            {
                "role": "contract",
                "statement": "checkout must apply the discount exactly once.",
                "evidence_refs": ["ev-contract"],
            }
        ]
    }


def test_haystack_natural_gaps_replay_through_one_repair_and_publish(tmp_path: Path) -> None:
    request = _write_fixture_repo(
        tmp_path,
        "haystack/components/converters/json.py",
    )
    original = _issue(
        file="haystack/components/converters/json.py",
        severity=Severity.WARNING,
        evidence=(
            "The exception handlers use source.meta[\"file_path\"] directly; "
            "ByteStream metadata may be empty, so malformed input raises KeyError."
        ),
        missing_contract=True,
        duplicate_cause=True,
        missing_invariant=True,
    )
    orchestrator = _ReplayOrchestrator(
        ReviewReport(summary="sanitized Haystack journal", issues=[original]),
        _haystack_patch,
        repair_budget=1,
    )

    response = asyncio.run(orchestrator.run_review(request))

    assert len(response.report.issues) == 1
    repaired = response.report.issues[0]
    assert repaired.violated_invariant
    assert {item.role for item in repaired.supports} == {
        "cause",
        "contract",
        "trigger",
        "impact",
    }
    assert len(repaired.supports) == 4
    assert repaired.suggestion == original.suggestion
    assert repaired.evidence == original.evidence
    assert repaired.confidence == original.confidence
    assert repaired.primary_anchor == original.primary_anchor
    assert repaired.trigger == original.trigger
    assert repaired.impact == original.impact
    assert repaired.cause_evidence[0].evidence_id == "ev-cause"
    assert repaired.trigger_evidence[0].evidence_id == "ev-trigger"
    assert repaired.impact_evidence[0].evidence_id == "ev-impact"
    assert response.delivery_complete is True
    assert response.finding_run_status == "complete"
    assert [call["repair_mode"] for call in orchestrator.calls] == [False, True]
    assert orchestrator.calls[1]["tool_count"] == 0
    assert orchestrator._review_repair_attempt_count == 1  # noqa: SLF001
    assert orchestrator._repair_model_call_count == 1  # noqa: SLF001
    assert orchestrator._review_repair_succeeded_count == 1  # noqa: SLF001
    transaction = orchestrator._repair_transactions[0]  # noqa: SLF001
    assert transaction.status == "accepted"
    assert list(transaction.target_results.values()) == ["verified"]
    assert transaction.applied_response_fingerprints
    candidate_id = repaired.candidate_id
    registration = orchestrator._candidate_registry.registration(candidate_id)  # noqa: SLF001
    assert registration is not None
    assert registration.status == "verified"
    authoritative = orchestrator._candidate_registry.authoritative_issue(candidate_id)  # noqa: SLF001
    assert authoritative is not None
    assert authoritative.violated_invariant == repaired.violated_invariant
    events = _event_log(tmp_path, response.run_id)
    assert any(item["event_type"] == "candidate_registered" for item in events)
    assert any(
        item["event_type"] == "decision"
        and item["phase"] == "finding_repair"
        and item["payload"].get("stage") == "pre_publish_preflight"
        and item["payload"].get("needs_repair_count") == 1
        for item in events
    )
    preflight = next(
        item
        for item in events
        if item["event_type"] == "decision"
        and item["phase"] == "finding_repair"
        and item["payload"].get("stage") == "pre_publish_preflight"
    )
    gap_codes = [
        item["code"] for item in preflight["payload"]["gaps"][0]["gaps"]
    ]
    assert set(gap_codes) == {
        "finding_contract_incomplete",
        "role_claim_missing",
        "finding_contract_invalid",
        "support_role_missing",
    }
    assert len(gap_codes) == 6
    assert any(
        item["event_type"] == "finding_verification_completed"
        and item["payload"]["verified_count"] == 1
        for item in events
    )
    funnel = next(item for item in events if item["event_type"] == "finding_funnel_completed")
    assert funnel["payload"]["repair_attempted_count"] == 1
    assert funnel["payload"]["repair_succeeded_count"] == 1
    assert funnel["payload"]["final_published_count"] == 1


def test_discount_contract_repair_does_not_bypass_independent_policy_gate(
    tmp_path: Path,
) -> None:
    request = _write_fixture_repo(tmp_path, "src/checkout.py")
    original = _issue(
        file="src/checkout.py",
        severity=Severity.CRITICAL,
        evidence=(
            "src/discounts.py:2 shows apply_discount returns total - total*rate; "
            "the diff adds '- total * rate' in checkout, so checkout(100, 0.2) "
            "evaluates to 60 while the existing test expects 80."
        ),
        missing_contract=True,
    )
    orchestrator = _ReplayOrchestrator(
        ReviewReport(summary="sanitized Discount journal", issues=[original]),
        _discount_contract_patch,
        repair_budget=1,
    )

    response = asyncio.run(orchestrator.run_review(request))

    # The legal contract patch repairs integrity, but does not change the
    # original evidence or confidence.  The independent policy rejection must
    # therefore remain a rejection at final publication.
    assert orchestrator._review_repair_succeeded_count == 1  # noqa: SLF001
    assert orchestrator._policy_rejected_issue_count == 1  # noqa: SLF001
    assert response.report.issues == []
    events = _event_log(tmp_path, response.run_id)
    filter_event = next(
        item for item in events if item["event_type"] == "finding_filter_decision"
    )
    assert filter_event["payload"]["reason_codes"] == [
        "critical_evidence_not_specific"
    ]
    assert response.finding_run_status == "complete"
    assert response.delivery_complete is False
    funnel = next(item for item in events if item["event_type"] == "finding_funnel_completed")
    assert funnel["payload"]["policy_rejected_count"] == 1
    assert funnel["payload"]["integrity_verified_count"] == 1
    assert funnel["payload"]["final_published_count"] == 0
    assert funnel["payload"]["delivery_complete"] is False


def test_zero_repair_budget_is_explicitly_disabled_and_not_an_attempt(tmp_path: Path) -> None:
    request = _write_fixture_repo(tmp_path, "haystack/components/converters/json.py")
    issue = _issue(
        file="haystack/components/converters/json.py",
        severity=Severity.WARNING,
        evidence="source.meta[\"file_path\"] is unsafe for an in-memory source.",
        missing_contract=True,
        duplicate_cause=True,
        missing_invariant=True,
    )
    orchestrator = _ReplayOrchestrator(
        ReviewReport(summary="zero-budget fixture", issues=[issue]),
        _haystack_patch,
        repair_budget=0,
    )

    response = asyncio.run(orchestrator.run_review(request))

    assert len(orchestrator.calls) == 1
    assert orchestrator.calls[0]["repair_mode"] is False
    assert orchestrator._review_repair_attempt_count == 0  # noqa: SLF001
    assert response.report.issues == []
    events = _event_log(tmp_path, response.run_id)
    disabled = [
        item
        for item in events
        if item["event_type"] == "decision"
        and item["phase"] == "finding_repair"
        and item["payload"].get("reason") == "configured_zero_budget"
    ]
    assert len(disabled) == 1
    assert disabled[0]["payload"]["repair_disabled"] is True


def test_contract_invalid_is_repairable_but_identity_failures_stay_invalid() -> None:
    contract_gap = IntegrityFailure(
        code="finding_contract_invalid",
        message="duplicate role envelope",
    )
    identity_gap = IntegrityFailure(
        code="evidence_identity_mismatch",
        message="wrong snapshot",
    )
    assert classify_integrity_failure(contract_gap) == "contract_gap"
    assert classify_integrity_failure(identity_gap) == "untrusted_identity"
    assert FindingIntegrityResult("cand-contract", False, (contract_gap,)).status == (
        "needs_repair"
    )
    assert FindingIntegrityResult("cand-identity", False, (identity_gap,)).status == (
        "invalid"
    )
