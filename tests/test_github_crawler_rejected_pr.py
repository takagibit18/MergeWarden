"""Tests for rejected-PR candidate discovery."""

from __future__ import annotations

import asyncio
from typing import Any

from eval.crawler.github_client import GithubCrawlerClient


class FakeGithubCrawlerClient(GithubCrawlerClient):
    def __init__(
        self,
        *,
        prs: list[dict[str, Any]],
        files_by_pr: dict[int, list[dict[str, Any]]],
        issue_comments_by_pr: dict[int, list[dict[str, Any]]] | None = None,
        review_comments_by_pr: dict[int, list[dict[str, Any]]] | None = None,
        reviews_by_pr: dict[int, list[dict[str, Any]]] | None = None,
    ) -> None:
        self._prs = prs
        self._files_by_pr = files_by_pr
        self._issue_comments_by_pr = issue_comments_by_pr or {}
        self._review_comments_by_pr = review_comments_by_pr or {}
        self._reviews_by_pr = reviews_by_pr or {}

    async def list_closed_pull_requests(
        self, repo_full_name: str, *, per_page: int = 30, page: int = 1
    ) -> list[dict[str, Any]]:
        return self._prs

    async def get_pull_request_files(
        self, repo_full_name: str, pr_number: int, *, per_page: int = 100, page: int = 1
    ) -> list[dict[str, Any]]:
        return self._files_by_pr.get(pr_number, [])

    async def get_pull_request_issue_comments(
        self, repo_full_name: str, pr_number: int
    ) -> list[dict[str, Any]]:
        return self._issue_comments_by_pr.get(pr_number, [])

    async def get_pull_request_review_comments(
        self, repo_full_name: str, pr_number: int
    ) -> list[dict[str, Any]]:
        return self._review_comments_by_pr.get(pr_number, [])

    async def list_pull_request_reviews(
        self, repo_full_name: str, pr_number: int
    ) -> list[dict[str, Any]]:
        return self._reviews_by_pr.get(pr_number, [])


def _closed_pr(
    number: int,
    *,
    title: str = "Improve parser",
    merged_at: str = "",
    head_sha: str = "head-sha",
    base_sha: str = "base-sha",
) -> dict[str, Any]:
    return {
        "number": number,
        "title": title,
        "html_url": f"https://github.com/example/repo/pull/{number}",
        "merged_at": merged_at,
        "merge_commit_sha": "merge-sha" if merged_at else "",
        "head": {"sha": head_sha},
        "base": {"sha": base_sha},
        "labels": [],
    }


def test_rejected_pr_mode_requires_unmerged_pr_with_trusted_problem_evidence() -> None:
    client = FakeGithubCrawlerClient(
        prs=[
            _closed_pr(1, title="Fix parser", merged_at="2026-05-01T00:00:00Z"),
            _closed_pr(2, title="Improve parser"),
            _closed_pr(3, title="Improve parser"),
            _closed_pr(4, title="Improve docs"),
        ],
        files_by_pr={
            1: [{"filename": "src/parser.py"}],
            2: [{"filename": "src/parser.py"}],
            3: [{"filename": "src/parser.py"}],
            4: [{"filename": "docs/parser.md"}],
        },
        issue_comments_by_pr={
            2: [
                {
                    "author_association": "NONE",
                    "body": "This breaks parsing for empty input.",
                }
            ],
            3: [
                {
                    "author_association": "MEMBER",
                    "body": "This breaks parsing for empty input and needs a missing check.",
                }
            ],
            4: [
                {
                    "author_association": "MEMBER",
                    "body": "This fails to document the new option correctly.",
                }
            ],
        },
    )

    candidates = asyncio.run(
        client.discover_pull_request_candidates(
            max_repos=1,
            max_prs_per_repo=10,
            curated_repos=["example/repo"],
            candidate_mode="rejected-pr",
        )
    )

    assert [candidate.pr_number for candidate in candidates] == [3]
    assert candidates[0].candidate_mode == "rejected-pr"
    assert candidates[0].evidence_source_count == 1
    assert "breaks parsing" in candidates[0].rejection_evidence[0]


def test_merged_bugfix_mode_keeps_existing_merged_pr_behavior() -> None:
    client = FakeGithubCrawlerClient(
        prs=[
            _closed_pr(10, title="Fix parser bug", merged_at="2026-05-01T00:00:00Z"),
            _closed_pr(11, title="Improve parser"),
        ],
        files_by_pr={
            10: [{"filename": "src/parser.py"}],
            11: [{"filename": "src/parser.py"}],
        },
    )

    candidates = asyncio.run(
        client.discover_pull_request_candidates(
            max_repos=1,
            max_prs_per_repo=10,
            curated_repos=["example/repo"],
            candidate_mode="merged-bugfix",
        )
    )

    assert [candidate.pr_number for candidate in candidates] == [10]
    assert candidates[0].candidate_mode == "merged-bugfix"
