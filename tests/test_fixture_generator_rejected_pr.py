"""Tests for rejected-PR fixture generation behavior."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from eval.crawler.fixture_generator import FixtureGenerator
from eval.crawler.github_client import PullRequestCandidate
from eval.schemas import ExpectedIssue, ExpectedResult
from src.analyzer.output_formatter import Severity


class NoopAnnotator:
    async def close(self) -> None:
        return None

    async def annotate_with_diagnostics(
        self, **kwargs: Any
    ) -> tuple[ExpectedResult, dict[str, int]]:
        return ExpectedResult(issues=[], is_empty_annotation=True), {
            "issues_draft": 0,
            "issues_after_critique": 0,
        }


class EmptyCandidateClient:
    async def close(self) -> None:
        return None

    async def discover_pull_request_candidates(
        self, **kwargs: Any
    ) -> list[PullRequestCandidate]:
        return []


class RecordingGithubClient:
    def __init__(self, candidate: PullRequestCandidate) -> None:
        self.candidate = candidate
        self.content_refs: list[str] = []

    async def close(self) -> None:
        return None

    async def discover_pull_request_candidates(
        self, **kwargs: Any
    ) -> list[PullRequestCandidate]:
        return [self.candidate]

    async def get_pull_request(
        self, repo_full_name: str, pr_number: int
    ) -> dict[str, Any]:
        return {"body": "Please see the review thread."}

    async def get_pull_request_diff(self, repo_full_name: str, pr_number: int) -> str:
        return (
            "diff --git a/src/parser.py b/src/parser.py\n"
            "--- a/src/parser.py\n"
            "+++ b/src/parser.py\n"
            "@@ -1 +1 @@\n"
            "-return parse(value)\n"
            "+return parse(value.strip())\n"
        )

    async def get_pull_request_files(
        self, repo_full_name: str, pr_number: int
    ) -> list[dict[str, Any]]:
        return [{"filename": "src/parser.py"}]

    async def get_file_content(self, repo_full_name: str, path: str, ref: str) -> str:
        self.content_refs.append(ref)
        return "def parser(value):\n    return parse(value.strip())\n"


class RecordingAnnotator:
    def __init__(self) -> None:
        self.review_context = ""

    async def close(self) -> None:
        return None

    async def annotate_with_diagnostics(
        self,
        *,
        review_context: str,
        **kwargs: Any,
    ) -> tuple[ExpectedResult, dict[str, int]]:
        self.review_context = review_context
        return (
            ExpectedResult(
                issues=[
                    ExpectedIssue(
                        severity=Severity.WARNING,
                        location_pattern="src/parser.py",
                        category="logic",
                        description="strip() hides invalid whitespace input instead of rejecting it.",
                    )
                ],
                min_issues=0,
                max_issues=5,
                is_empty_annotation=False,
            ),
            {"issues_draft": 1, "issues_after_critique": 1},
        )


def test_generate_does_not_rewrite_manifest_or_checklist_when_no_fixtures_written(
    tmp_path: Path,
) -> None:
    fixtures_dir = tmp_path / "fixtures"
    fixtures_dir.mkdir()
    manifest = fixtures_dir / "manifest.json"
    checklist = fixtures_dir / "review_checklist.md"
    manifest.write_text('{"entries":[]}', encoding="utf-8")
    checklist.write_text("keep me\n", encoding="utf-8")

    generator = FixtureGenerator(
        fixtures_dir=fixtures_dir,
        outputs_dir=tmp_path / "outputs",
        github_client=EmptyCandidateClient(),  # type: ignore[arg-type]
        annotator=NoopAnnotator(),  # type: ignore[arg-type]
    )

    written = asyncio.run(
        generator.generate(
            suite="golden_candidates",
            max_repos=1,
            max_prs_per_repo=1,
            curated_repos=["example/repo"],
            candidate_mode="rejected-pr",
        )
    )

    assert written == []
    assert manifest.read_text(encoding="utf-8") == '{"entries":[]}'
    assert checklist.read_text(encoding="utf-8") == "keep me\n"


def test_rejected_pr_fixture_uses_head_sha_and_review_context_without_leaking_to_input(
    tmp_path: Path,
) -> None:
    candidate = PullRequestCandidate(
        repo_full_name="example/repo",
        pr_number=12,
        title="Improve parser",
        html_url="https://github.com/example/repo/pull/12",
        merged_at="",
        merge_commit_sha="",
        head_sha="head-sha",
        base_sha="base-sha",
        candidate_mode="rejected-pr",
        rejection_evidence=["MEMBER: This breaks empty input handling."],
        evidence_source_count=1,
    )
    github_client = RecordingGithubClient(candidate)
    annotator = RecordingAnnotator()
    generator = FixtureGenerator(
        fixtures_dir=tmp_path / "fixtures",
        outputs_dir=tmp_path / "outputs",
        github_client=github_client,  # type: ignore[arg-type]
        annotator=annotator,  # type: ignore[arg-type]
    )

    written = asyncio.run(
        generator.generate(
            suite="golden_candidates",
            max_repos=1,
            max_prs_per_repo=1,
            curated_repos=["example/repo"],
            candidate_mode="rejected-pr",
        )
    )

    assert github_client.content_refs == []
    assert annotator.review_context == "MEMBER: This breaks empty input handling."
    fixture_payload = written[0].read_text(encoding="utf-8")
    assert "This breaks empty input handling" not in fixture_payload
    assert '"rejected-pr"' in fixture_payload
    assert '"should-detect"' in fixture_payload
    assert '"workspace"' in fixture_payload
    assert '"files": {}' in fixture_payload
    assert '"repo_url": "https://github.com/example/repo.git"' in fixture_payload
    assert '"base_sha": "base-sha"' in fixture_payload
    assert '"head_sha": "head-sha"' in fixture_payload
    assert '"checkout_sha": "head-sha"' in fixture_payload
    assert '"diff_base_sha": "base-sha"' in fixture_payload
