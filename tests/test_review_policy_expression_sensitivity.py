"""Offline policy-expression diagnostics using the real Discount journal.

These tests never call a provider and never replace the historical event log.
The rewritten evidence strings and the repaired object are diagnostic fixtures
derived from the real candidate and delivered evidence catalog.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from src.analyzer.evidence_ledger import ledger_from_sources
from src.analyzer.finding_contract import normalize_model_finding_payload
from src.analyzer.finding_integrity import FindingIntegrityGuard, build_candidates
from src.analyzer.output_formatter import ReviewIssue, ReviewReport
from src.analyzer.review_policy import evaluate_issue_filter
from src.analyzer.schemas import ReviewRequest


ROOT = Path(__file__).resolve().parents[1]
DISCOUNT_EVENT_LOG = (
    ROOT
    / "eval"
    / "outputs"
    / "event_logs"
    / "development_agent_search_cross_file_22b62d9d-dd66-4f98-a980-7a796fa17c0b.jsonl"
)
DISCOUNT_JOURNAL = (
    ROOT
    / "eval"
    / "outputs"
    / "finding-delivery-next-round-discount-normal-20260909"
    / "run_journals"
    / "development_agent_search_cross_file_A-agent-search_22b62d9d-dd66-4f98-a980-7a796fa17c0b_journal.jsonl"
)


def _load_discount_fixture() -> tuple[ReviewIssue, list[dict[str, Any]]]:
    events = [
        json.loads(line)
        for line in DISCOUNT_EVENT_LOG.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    registration = next(
        event
        for event in events
        if event.get("event_type") == "candidate_registered"
    )
    issue_payload = registration["payload"]["registrations"][0]["current_content"]

    journal_entries = [
        json.loads(line)
        for line in DISCOUNT_JOURNAL.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    catalogs = [
        entry["payload"]["records"]
        for entry in journal_entries
        if entry.get("type") == "evidence_catalog"
    ]
    assert catalogs, "the natural Discount journal must contain delivered evidence"
    return ReviewIssue.model_validate(issue_payload), catalogs[-1]


def _repair_contract_role(
    issue: ReviewIssue,
    catalog: list[dict[str, Any]],
) -> ReviewIssue:
    """Build a diagnostic contract-role patch from real delivered references."""

    payload = issue.model_dump(mode="json")
    payload["supports"] = [
        *payload["supports"],
        {
            "role": "contract",
            "statement": (
                "The existing checkout contract applies exactly one discount."
            ),
            "evidence_refs": [
                "ev_c83c5ddeb0b321bf1cabfd06",
                "ev_e4742bca8657586f05475976",
            ],
        },
    ]
    normalized = normalize_model_finding_payload(
        payload,
        evidence_catalog=catalog,
    )
    return ReviewIssue.model_validate(normalized)


@pytest.fixture(scope="module")
def discount_fixture() -> tuple[ReviewIssue, list[dict[str, Any]]]:
    return _load_discount_fixture()


@pytest.mark.parametrize(
    ("label", "evidence_builder", "expected_specific", "expected_passed"),
    [
        (
            "historical-natural-text",
            lambda issue: issue.evidence,
            False,
            False,
        ),
        (
            "same-fact-inline-code",
            lambda issue: issue.evidence.replace(
                "checkout(100, 0.2)", "`checkout(100, 0.2)`"
            ),
            True,
            True,
        ),
        (
            "same-fact-code-at-line-start",
            lambda issue: issue.evidence.replace(
                "so checkout(100, 0.2)", "so\ncheckout(100, 0.2)"
            ),
            True,
            True,
        ),
        (
            "same-fact-code-block",
            lambda issue: issue.evidence.replace(
                "so checkout(100, 0.2) evaluates",
                "so\n```\ncheckout(100, 0.2)\n```\nevaluates",
            ),
            True,
            True,
        ),
        (
            "same-fact-equivalent-plain-language",
            lambda _issue: (
                "src/discounts.py:2 shows apply_discount returns total - total*rate; "
                "the diff adds a second discount in checkout, so the function receives "
                "total 100 and rate 0.2 and evaluates to 60 instead of 80."
            ),
            False,
            False,
        ),
        (
            "empty-evidence",
            lambda _issue: "",
            False,
            False,
        ),
        (
            "format-only-no-substance",
            lambda _issue: "`x()`",
            True,
            True,
        ),
    ],
)
def test_policy_is_sensitive_to_evidence_expression_format(
    discount_fixture: tuple[ReviewIssue, list[dict[str, Any]]],
    label: str,
    evidence_builder: Any,
    expected_specific: bool,
    expected_passed: bool,
) -> None:
    issue, _catalog = discount_fixture
    variant = issue.model_copy(update={"evidence": evidence_builder(issue)})
    decision = evaluate_issue_filter(variant)

    # The fixture changes only the free-text expression. All runtime identity,
    # severity, confidence, supports and references remain identical.
    assert variant.model_dump(mode="json", exclude={"evidence"}) == issue.model_dump(
        mode="json", exclude={"evidence"}
    ), label
    assert decision.evidence_specific is expected_specific, label
    assert decision.passed is expected_passed, label
    if expected_passed:
        assert decision.reason_codes == ("critical_policy_passed",), label
    else:
        assert decision.reason_codes == ("critical_evidence_not_specific",), label


def test_real_discount_and_contract_repair_object_keep_policy_rejection(
    discount_fixture: tuple[ReviewIssue, list[dict[str, Any]]],
) -> None:
    issue, catalog = discount_fixture
    repaired = _repair_contract_role(issue, catalog)

    original_decision = evaluate_issue_filter(issue)
    repaired_decision = evaluate_issue_filter(repaired)
    delivered_ids = {
        str(record["evidence_id"])
        for record in catalog
        if str(record.get("evidence_id", "")).strip()
    }

    assert [item.role for item in issue.supports] == ["cause", "trigger", "impact"]
    assert [item.role for item in repaired.supports] == [
        "cause",
        "trigger",
        "impact",
        "contract",
    ]
    assert {
        ref
        for support in repaired.supports
        if support.role == "contract"
        for ref in support.evidence_refs
    } <= delivered_ids
    assert repaired.evidence == issue.evidence
    assert repaired.severity == issue.severity
    assert repaired.confidence == issue.confidence
    assert repaired.primary_anchor == issue.primary_anchor
    assert repaired_decision.evidence_specific is False
    assert repaired_decision.passed is False
    assert repaired_decision.reason_codes == ("critical_evidence_not_specific",)
    assert original_decision.reason_codes == repaired_decision.reason_codes


def test_policy_local_pass_does_not_make_invalid_evidence_publishable(
    discount_fixture: tuple[ReviewIssue, list[dict[str, Any]]],
    tmp_path: Path,
) -> None:
    issue, catalog = discount_fixture
    payload = issue.model_dump(mode="json")
    payload["evidence"] = "`checkout()`"
    payload["supports"] = [
        {
            "role": role,
            "statement": f"The {role} claim is asserted.",
            "evidence_refs": ["ev-not-delivered"],
        }
        for role in ("cause", "contract", "trigger", "impact")
    ]
    invalid_binding_issue = ReviewIssue.model_validate(
        normalize_model_finding_payload(payload, evidence_catalog=catalog)
    )
    policy = evaluate_issue_filter(invalid_binding_issue)
    assert policy.evidence_specific is True
    assert policy.passed is True

    for record in catalog:
        file_path = tmp_path / str(record["path"])
        file_path.parent.mkdir(parents=True, exist_ok=True)
        content = str(record.get("content", ""))
        file_path.write_text(
            "\n".join(line.split(": ", 1)[-1] for line in content.splitlines())
            + "\n",
            encoding="utf-8",
        )

    candidate = build_candidates(
        ReviewReport(issues=[invalid_binding_issue]),
        iteration=0,
    )[0]
    ledger = ledger_from_sources(existing_payload=catalog)
    result = FindingIntegrityGuard(tmp_path).validate(
        [candidate],
        ReviewRequest(repo_path=str(tmp_path), diff_mode=False),
        evidence_ledger=ledger,
        snapshot_id=str(catalog[0]["snapshot_id"]),
        revision=str(catalog[0]["revision"]),
    ).results[0]

    assert result.status != "verified"
    codes = {failure.code for failure in result.failures}
    assert {
        "support_reference_unresolved",
        "support_reference_missing",
    } & codes
