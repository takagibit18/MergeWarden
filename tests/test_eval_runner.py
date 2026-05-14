"""Tests for eval runner utilities."""

from __future__ import annotations

import subprocess
from pathlib import Path

import eval.runner as runner_module
from eval.runner import (
    _aggregate_sampled_result,
    _prepare_fixture_workspace,
    _is_empty_business_output,
    _match_issues,
    _persist_event_log_to_outputs,
    _semantic_location_matches,
    _validate_expected_locations_against_diff,
    _resolve_event_log_path,
    _resolve_fixture_paths,
    _sanitize_fixture_id_for_filename,
    load_fixtures,
)
from eval.schemas import EvalResult, Fixture, MetricSummary, SampledFixtureResult
from src.analyzer.context_state import ContextState
from src.analyzer.output_formatter import ReviewIssue, ReviewReport, Severity
from src.analyzer.schemas import ReviewResponse


def _git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return completed.stdout.strip()


def _build_source_repo(tmp_path: Path) -> tuple[Path, str, str, str]:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init")
    _git(source, "config", "user.email", "eval@example.com")
    _git(source, "config", "user.name", "Eval Test")
    package_dir = source / "pkg"
    package_dir.mkdir()
    (package_dir / "module.py").write_text(
        "from .helper import normalize\n\ndef parse(value):\n    return value\n",
        encoding="utf-8",
    )
    (package_dir / "helper.py").write_text(
        "def normalize(value):\n    return value.strip()\n",
        encoding="utf-8",
    )
    _git(source, "add", ".")
    _git(source, "commit", "-m", "base")
    base_sha = _git(source, "rev-parse", "HEAD")

    (package_dir / "module.py").write_text(
        "from .helper import normalize\n\n"
        "def parse(value):\n"
        "    return normalize(value)\n",
        encoding="utf-8",
    )
    _git(source, "add", ".")
    _git(source, "commit", "-m", "head")
    head_sha = _git(source, "rev-parse", "HEAD")
    diff_text = _git(source, "diff", f"{base_sha}..{head_sha}")
    return source, base_sha, head_sha, diff_text


def _build_source_repo_with_hidden_pr_ref(
    tmp_path: Path,
) -> tuple[Path, str, str, str]:
    source, base_sha, head_sha, diff_text = _build_source_repo(tmp_path)
    remote = tmp_path / "remote.git"
    _git(tmp_path, "clone", "--bare", str(source), str(remote))
    _git(remote, "update-ref", "refs/heads/main", base_sha)
    _git(remote, "update-ref", "refs/pull/12/head", head_sha)
    _git(remote, "update-ref", "-d", "refs/heads/master")
    return remote, base_sha, head_sha, diff_text


def test_resolve_event_log_path_returns_existing_file(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("EVENT_LOG_DIR", ".mergewarden/logs")
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)
    log_dir = repo_root / ".mergewarden" / "logs"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "run-1.jsonl"
    log_path.write_text('{"event_type":"model_call"}\n', encoding="utf-8")

    resolved = _resolve_event_log_path(repo_root, "run-1")
    assert resolved == str(log_path)


def test_resolve_event_log_path_returns_none_when_missing(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("EVENT_LOG_DIR", ".mergewarden/logs")
    repo_root = tmp_path / "repo"
    repo_root.mkdir(parents=True)

    resolved = _resolve_event_log_path(repo_root, "missing")
    assert resolved is None


def test_sanitize_fixture_id_for_filename() -> None:
    assert _sanitize_fixture_id_for_filename("a/b\\c") == "a_b_c"


def test_persist_event_log_to_outputs_copies_and_returns_absolute(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)
    src = tmp_path / "run-1.jsonl"
    src.write_text('{"event_type":"model_call"}\n', encoding="utf-8")

    out = _persist_event_log_to_outputs(src, "golden_fixture", "run-1")
    assert out is not None
    dest = tmp_path / "eval" / "outputs" / "event_logs" / "golden_fixture_run-1.jsonl"
    assert Path(out) == dest.resolve()
    assert dest.read_text(encoding="utf-8") == '{"event_type":"model_call"}\n'


def test_persist_event_log_to_outputs_returns_none_when_missing_src() -> None:
    assert _persist_event_log_to_outputs(None, "f", "r") is None


def test_persist_event_log_to_outputs_returns_none_when_file_missing(
    tmp_path: Path,
) -> None:
    assert _persist_event_log_to_outputs(tmp_path / "nope.jsonl", "f", "r") is None


def test_resolve_fixture_paths_prefers_manifest(tmp_path: Path) -> None:
    fixtures_root = tmp_path / "eval" / "fixtures"
    fixtures_root.mkdir(parents=True)
    fixture_path = fixtures_root / "sample.json"
    fixture_path.write_text(
        '{"id":"x","type":"review","source":{"repo_full_name":"a/b","pr_number":1},'
        '"input":{"diff_text":"","files":{}},"expected":{"issues":[]},"metadata":{"reviewed":true}}',
        encoding="utf-8",
    )
    (fixtures_root / "manifest.json").write_text(
        '{"generated_at":"2026-01-01T00:00:00+00:00","entries":['
        '{"fixture_id":"x","fixture_type":"review","repo_full_name":"a/b","pr_number":1,'
        '"suite":"golden","path":"eval/fixtures/sample.json","reviewed":true}]}',
        encoding="utf-8",
    )
    resolved = _resolve_fixture_paths(fixtures_root)
    assert resolved == [fixture_path.resolve()]
    fixtures = load_fixtures(fixtures_root, reviewed_only=True)
    assert len(fixtures) == 1


def test_fixture_input_accepts_git_workspace_metadata() -> None:
    fixture = Fixture.model_validate(
        {
            "id": "workspace-fixture",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {
                "diff_text": "",
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": "https://github.com/example/repo.git",
                    "base_sha": "base",
                    "head_sha": "head",
                    "checkout_sha": "head",
                    "diff_base_sha": "base",
                },
            },
            "expected": {"issues": []},
        }
    )

    assert fixture.input.workspace is not None
    assert fixture.input.workspace.kind == "git"
    assert fixture.input.workspace.checkout_sha == "head"


def test_prepare_fixture_workspace_restores_git_snapshot(tmp_path: Path) -> None:
    source, base_sha, head_sha, diff_text = _build_source_repo(tmp_path)
    fixture = Fixture.model_validate(
        {
            "id": "workspace-fixture",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {
                "diff_text": diff_text,
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": str(source),
                    "base_sha": base_sha,
                    "head_sha": head_sha,
                    "checkout_sha": head_sha,
                    "diff_base_sha": base_sha,
                },
            },
            "expected": {"issues": []},
        }
    )

    workspace = _prepare_fixture_workspace(fixture, tmp_path / "workspace")

    assert _git(workspace, "rev-parse", "HEAD") == head_sha
    assert "return normalize(value)" in (workspace / "pkg" / "module.py").read_text(
        encoding="utf-8"
    )
    assert (workspace / "pkg" / "helper.py").exists()


def test_prepare_fixture_workspace_fetches_pr_ref_when_checkout_is_not_cloned(
    tmp_path: Path,
) -> None:
    remote, base_sha, head_sha, diff_text = _build_source_repo_with_hidden_pr_ref(
        tmp_path
    )
    fixture = Fixture.model_validate(
        {
            "id": "workspace-fixture",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 12},
            "input": {
                "diff_text": diff_text,
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": str(remote),
                    "base_sha": base_sha,
                    "head_sha": head_sha,
                    "checkout_sha": head_sha,
                    "diff_base_sha": base_sha,
                },
            },
            "expected": {"issues": []},
        }
    )

    workspace = _prepare_fixture_workspace(fixture, tmp_path / "workspace")

    assert _git(workspace, "rev-parse", "HEAD") == head_sha


def test_prepare_fixture_workspace_fetches_pr_ref_after_checkout_failure(
    monkeypatch,
    tmp_path: Path,
) -> None:
    fixture = Fixture.model_validate(
        {
            "id": "workspace-fixture",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 12},
            "input": {
                "diff_text": "",
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": "https://github.com/example/repo.git",
                    "base_sha": "base",
                    "head_sha": "head",
                    "checkout_sha": "head",
                    "diff_base_sha": "base",
                },
            },
            "expected": {"issues": []},
        }
    )
    calls: list[list[str]] = []
    checkout_attempts = 0

    def fake_run_git(args: list[str], *, cwd: Path | None = None) -> str:
        nonlocal checkout_attempts
        calls.append(args)
        if args[0] == "clone":
            Path(args[-1]).mkdir(parents=True)
            return ""
        if args[:2] == ["checkout", "--quiet"]:
            checkout_attempts += 1
            if checkout_attempts == 1:
                raise subprocess.CalledProcessError(1, ["git", *args])
            return ""
        if args[0] == "fetch":
            return ""
        if args == ["rev-parse", "HEAD"]:
            return "head"
        raise AssertionError(f"Unexpected git args: {args}")

    monkeypatch.setattr(runner_module, "_run_git", fake_run_git)

    _prepare_fixture_workspace(fixture, tmp_path / "workspace")

    assert ["fetch", "--quiet", "origin", "refs/pull/12/head"] in calls
    assert checkout_attempts == 2


def test_validate_expected_locations_against_diff_requires_changed_workspace_line(
    tmp_path: Path,
) -> None:
    source, base_sha, head_sha, diff_text = _build_source_repo(tmp_path)
    fixture = Fixture.model_validate(
        {
            "id": "workspace-fixture",
            "type": "review",
            "source": {"repo_full_name": "example/repo", "pr_number": 1},
            "input": {
                "diff_text": diff_text,
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": str(source),
                    "base_sha": base_sha,
                    "head_sha": head_sha,
                    "checkout_sha": head_sha,
                    "diff_base_sha": base_sha,
                },
            },
            "expected": {
                "issues": [
                    {
                        "path": "pkg/module.py",
                        "line": 4,
                        "end_line": 4,
                        "description": "normalize hides invalid whitespace.",
                    }
                ]
            },
        }
    )
    workspace = _prepare_fixture_workspace(fixture, tmp_path / "workspace")

    assert _validate_expected_locations_against_diff(fixture, workspace) == []

    bad_fixture = fixture.model_copy(
        update={
            "expected": fixture.expected.model_copy(
                update={
                    "issues": [
                        fixture.expected.issues[0].model_copy(update={"line": 99})
                    ]
                }
            )
        }
    )
    errors = _validate_expected_locations_against_diff(bad_fixture, workspace)

    assert errors
    assert "pkg/module.py:99" in errors[0]


def test_semantic_location_matches_with_overlap() -> None:
    class _Expected:
        path = "src/main.py"
        line = 10
        end_line = 12
        location_pattern = ""

    assert _semantic_location_matches(_Expected(), "src/main.py:11-13")


def test_sampled_metrics_exclude_empty_fixtures_from_hit_rate() -> None:
    positive = SampledFixtureResult(
        fixture_id="positive",
        fixture_type="review",
        expected_count=1,
        runs=[
            EvalResult(fixture_id="positive", fixture_type="review", expected_count=1)
        ],
        pass_at_k_hit_rate=0.0,
        mean_hit_rate=0.0,
        schema_valid_rate=1.0,
    )
    empty = SampledFixtureResult(
        fixture_id="empty",
        fixture_type="review",
        expected_count=0,
        runs=[
            EvalResult(
                fixture_id="empty",
                fixture_type="review",
                actual_count=1,
                false_positive_count=1,
            )
        ],
        pass_at_k_hit_rate=1.0,
        mean_hit_rate=1.0,
        mean_false_positive_rate=1.0,
        schema_valid_rate=1.0,
    )

    metrics = MetricSummary.from_sampled_results([positive, empty])

    assert metrics.hit_rate == 0.0
    assert metrics.mean_hit_rate == 0.0
    assert metrics.pass_at_k_hit_rate == 0.0
    assert metrics.false_positive_rate == 0.5


def test_aggregate_sampled_result_preserves_pass_at_k_for_positive_fixture() -> None:
    fixture = Fixture.model_validate(
        {
            "id": "fixture",
            "type": "review",
            "source": {"repo_full_name": "a/b", "pr_number": 1},
            "input": {"diff_text": "", "files": {}},
            "expected": {"issues": [{"location_pattern": "src/main.py"}]},
        }
    )
    runs = [
        EvalResult(
            fixture_id="fixture",
            fixture_type="review",
            expected_count=1,
            matched_count=0,
        ),
        EvalResult(
            fixture_id="fixture",
            fixture_type="review",
            expected_count=1,
            matched_count=1,
        ),
    ]

    sampled = _aggregate_sampled_result(fixture, runs)

    assert sampled.expected_count == 1
    assert sampled.pass_at_k_hit_rate == 1.0
    assert sampled.mean_hit_rate == 0.5


def test_empty_review_output_is_invalid_business_output() -> None:
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(summary="", issues=[]),
        context=ContextState(),
    )

    assert _is_empty_business_output(response) is True


def test_placeholder_review_output_is_not_empty_business_output() -> None:
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(
            summary="Review pipeline completed with placeholder summary.",
            issues=[],
        ),
        context=ContextState(),
    )

    assert _is_empty_business_output(response) is False


def test_nonempty_no_issue_review_output_is_valid_business_output() -> None:
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(summary="No issues found.", issues=[]),
        context=ContextState(),
    )

    assert _is_empty_business_output(response) is False


def test_match_issues_ignores_low_confidence_warning_false_positive() -> None:
    fixture = Fixture.model_validate(
        {
            "id": "zero-fixture",
            "type": "review",
            "source": {"repo_full_name": "a/b", "pr_number": 1},
            "input": {"diff_text": "", "files": {}},
            "expected": {"issues": []},
            "metadata": {"suite": "golden", "reviewed": True},
        }
    )
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(
            summary="",
            issues=[
                ReviewIssue(
                    severity=Severity.WARNING,
                    location="src/x.py:1",
                    evidence="+ risky_change()",
                    suggestion="check it",
                    confidence=0.8,
                )
            ],
        ),
        context=ContextState(),
    )

    _, matched_count, false_positive_count = _match_issues(fixture, response)
    assert matched_count == 0
    assert false_positive_count == 0


def test_match_issues_ignores_info_and_style_for_golden_false_positives() -> None:
    fixture = Fixture.model_validate(
        {
            "id": "zero-fixture",
            "type": "review",
            "source": {"repo_full_name": "a/b", "pr_number": 1},
            "input": {"diff_text": "", "files": {}},
            "expected": {"issues": []},
            "metadata": {"suite": "golden", "reviewed": True},
        }
    )
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(
            summary="optional suggestions",
            issues=[
                ReviewIssue(
                    severity=Severity.INFO,
                    location="src/x.py:1",
                    evidence="+ optional_context()",
                    suggestion="Consider documenting this behavior.",
                    confidence=0.7,
                ),
                ReviewIssue(
                    severity=Severity.STYLE,
                    location="src/y.py:1",
                    evidence="+ import sys",
                    suggestion="Consider import grouping.",
                    confidence=0.3,
                ),
            ],
        ),
        context=ContextState(),
    )

    _, matched_count, false_positive_count = _match_issues(fixture, response)
    assert matched_count == 0
    assert false_positive_count == 0


def test_match_issues_counts_high_confidence_warning_on_changed_line() -> None:
    fixture = Fixture.model_validate(
        {
            "id": "positive-fixture",
            "type": "review",
            "source": {"repo_full_name": "a/b", "pr_number": 1},
            "input": {
                "diff_text": (
                    "diff --git a/src/main.py b/src/main.py\n"
                    "--- a/src/main.py\n"
                    "+++ b/src/main.py\n"
                    "@@ -8,4 +8,5 @@ def parse(value):\n"
                    "     old_call()\n"
                    "+    risky_change()\n"
                ),
                "files": {},
                "workspace": {
                    "kind": "git",
                    "repo_url": "https://github.com/a/b.git",
                    "checkout_sha": "head",
                },
            },
            "expected": {
                "issues": [
                    {
                        "severity": "warning",
                        "path": "src/main.py",
                        "line": 9,
                        "end_line": 9,
                    }
                ]
            },
            "metadata": {"suite": "golden", "reviewed": True},
        }
    )
    response = ReviewResponse(
        run_id="run-1",
        report=ReviewReport(
            summary="found regression",
            issues=[
                    ReviewIssue(
                        severity=Severity.WARNING,
                    location="src/main.py:9",
                    evidence="risky_change() now runs inside parse",
                    suggestion="Restore the original guard.",
                    confidence=0.9,
                )
            ],
        ),
        context=ContextState(),
    )

    _, matched_count, false_positive_count = _match_issues(fixture, response)
    assert matched_count == 1
    assert false_positive_count == 0


def test_golden_fixture_distribution_has_required_buckets() -> None:
    real = load_fixtures(Path("eval") / "fixtures", suite="golden", reviewed_only=True)
    synth = load_fixtures(
        Path("eval") / "fixtures", suite="golden_synth", reviewed_only=True
    )

    assert {fixture.id for fixture in real} == {
        "golden_astral-sh_ruff_pr24648",
        "golden_real_requests_netrc_pr7205",
        "golden_pytest-dev_pytest_pr8513",
        "golden_NethermindEth_nethermind_pr5381",
        "golden_pytest-dev_pytest_pr9350",
        "golden_pytest-dev_pytest_pr7254",
    }
    assert synth == []


def test_reviewed_golden_fixtures_use_git_workspaces_without_sparse_files(
    tmp_path: Path,
) -> None:
    fixtures = load_fixtures(Path("eval") / "fixtures", suite="golden", reviewed_only=True)

    assert fixtures
    for fixture in fixtures:
        assert fixture.input.files == {}
        assert fixture.input.workspace is not None
        assert fixture.input.workspace.kind == "git"
        assert fixture.input.workspace.repo_url.startswith("https://github.com/")
        assert fixture.input.workspace.checkout_sha
        assert fixture.input.workspace.diff_base_sha
        for issue in fixture.expected.issues:
            assert issue.path
            assert issue.line is not None
            target = tmp_path / fixture.id / issue.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(
                "\n".join("line" for _ in range(issue.end_line or issue.line)),
                encoding="utf-8",
            )
        assert _validate_expected_locations_against_diff(
            fixture, tmp_path / fixture.id
        ) == []
