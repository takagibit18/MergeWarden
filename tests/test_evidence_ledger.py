"""Regression tests for delivered-source accounting and exact range coverage."""

from __future__ import annotations

import asyncio
from pathlib import Path

from src.analyzer.evidence_ledger import ledger_from_sources
from src.analyzer.evidence_binding import _tool_entry_covers
from src.tools.grep_tool import GrepTool
from src.tools.path_utils import tool_workspace_root


def test_ledger_accepts_full_tool_range_but_not_partial_or_truncated() -> None:
    ledger = ledger_from_sources(
        tool_evidence=[
            {
                "tool_name": "read_file",
                "tool_call_id": "call-1",
                "data": {
                    "file_path": "src/example.py",
                    "start_line": 10,
                    "line_count": 4,
                    "content": "10: a\n11: b\n12: c\n13: d",
                    "truncated": False,
                },
            },
            {
                "tool_name": "read_file",
                "tool_call_id": "call-2",
                "data": {
                    "file_path": "src/partial.py",
                    "start_line": 1,
                    "line_count": 5,
                    "content": "1: a\n2: b",
                    "truncated": True,
                },
            },
        ]
    )

    assert ledger.covers("src/example.py", 11, 13)
    assert not ledger.covers("src/example.py", 9, 11)
    assert not ledger.covers("src/partial.py", 1, 2)


def test_ledger_ignores_header_only_manifest_spans() -> None:
    ledger = ledger_from_sources(
        context_manifests=[
            {
                "candidate_id": "C-001",
                "included_spans": [
                    {
                        "span_id": "header",
                        "file": "src/a.py",
                        "start_line": 1,
                        "end_line": 4,
                    },
                    {
                        "span_id": "body",
                        "file": "src/a.py",
                        "start_line": 5,
                        "end_line": 7,
                        "content": "5: x\n6: y\n7: z",
                    },
                ],
            }
        ]
    )

    assert not ledger.covers("src/a.py", 1, 4)
    assert ledger.covers("src/a.py", 5, 7)


def test_tool_binding_requires_full_range_coverage() -> None:
    data = {
        "file_path": "src/example.py",
        "start_line": 10,
        "line_count": 4,
    }
    assert _tool_entry_covers("read_file", {}, data, "src/example.py", 11, 13)
    assert not _tool_entry_covers("read_file", {}, data, "src/example.py", 9, 11)


def test_complete_observation_is_not_poisoned_by_a_later_clipped_duplicate() -> None:
    base = {
        "tool_name": "read_file",
        "tool_call_id": "call-1",
        "data": {
            "file_path": "src/example.py",
            "start_line": 10,
            "line_count": 2,
            "content": "10: a\n11: b",
            "truncated": False,
        },
    }
    clipped = {
        **base,
        "tool_call_id": "call-2",
        "data": {**base["data"], "truncated": True},
    }

    ledger = ledger_from_sources(tool_evidence=[base, clipped])

    assert len(ledger.records) == 1
    assert ledger.records[0].truncated is False
    assert ledger.covers("src/example.py", 10, 11)


def test_ledger_requires_the_same_snapshot_revision_and_side() -> None:
    ledger = ledger_from_sources(
        file_contents={"src/example.py": "return value"},
        snapshot_id="snapshot-a",
        revision="revision-a",
    )

    assert ledger.covers(
        "src/example.py", 1, snapshot_id="snapshot-a", revision="revision-a"
    )
    assert not ledger.covers(
        "src/example.py", 1, snapshot_id="snapshot-b", revision="revision-a"
    )
    assert not ledger.covers(
        "src/example.py",
        1,
        side="old",
        snapshot_id="snapshot-a",
        revision="revision-a",
    )


def test_evidence_id_is_distinct_from_artifact_but_legacy_alias_resolves_exactly() -> None:
    ledger = ledger_from_sources(
        tool_evidence=[
            {
                "tool_name": "read_file",
                "tool_call_id": "request-call-1",
                "data": {
                    "file_path": "src/example.py",
                    "start_line": 10,
                    "line_count": 2,
                    "content": "10: a\n11: b",
                    "truncated": False,
                },
            }
        ],
        snapshot_id="snapshot-a",
        revision="revision-a",
    )

    record = ledger.records[0]
    assert record.evidence_id.startswith("ev_")
    assert record.evidence_id != record.artifact_id
    assert record.delivery_request_id == "request-call-1"
    assert ledger.covers(
        record.path,
        10,
        11,
        evidence_id=record.evidence_id,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )
    assert ledger.covers(
        record.path,
        10,
        11,
        artifact_id=record.artifact_id,
        snapshot_id="snapshot-a",
        revision="revision-a",
    )


def test_diff_hunk_with_an_omitted_line_cannot_prove_even_its_visible_prefix() -> None:
    diff = (
        "diff --git a/src/example.py b/src/example.py\n"
        "--- a/src/example.py\n"
        "+++ b/src/example.py\n"
        "@@ -9,3 +10,3 @@\n"
        "+first\n"
    )

    ledger = ledger_from_sources(diff_text=diff)

    assert ledger.records[0].truncated is True
    assert not ledger.covers("src/example.py", 10)


def test_grep_excludes_mergewarden_runtime_artifacts(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / ".mergewarden" / "logs").mkdir(parents=True)
    (tmp_path / "src" / "real.py").write_text("needle = 1\n", encoding="utf-8")
    (tmp_path / ".mergewarden" / "logs" / "run.jsonl").write_text(
        "needle = from a previous run\n", encoding="utf-8"
    )

    with tool_workspace_root(tmp_path):
        result = asyncio.run(GrepTool().execute(pattern="needle", path=str(tmp_path)))

    assert result["match_count"] == 1
    assert result["matches"][0]["file_path"].endswith("src\\real.py") or result[
        "matches"
    ][0]["file_path"].endswith("src/real.py")
