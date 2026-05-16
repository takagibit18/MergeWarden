"""Tests for model prompt contracts."""

from src.analyzer.prompts import FINALIZE_REVIEW_NOTICE


def test_finalize_review_notice_requires_empty_issues_for_speculative_suggestions() -> None:
    assert "speculative" in FINALIZE_REVIEW_NOTICE
    assert "info/style/design" in FINALIZE_REVIEW_NOTICE
    assert "issues: []" in FINALIZE_REVIEW_NOTICE
