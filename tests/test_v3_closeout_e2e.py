"""Offline public-entry end-to-end coverage for the v3 review closeout."""

from __future__ import annotations

import asyncio
import copy
import json
import re
from pathlib import Path
from typing import Any

import pytest

from src.analyzer.evidence_ledger import ledger_from_sources
from src.analyzer.schemas import ReviewRequest
from src.models.schemas import ModelConfig, ModelResponse, TokenUsage
from src.orchestrator.agent_loop import AgentOrchestrator
from src.tools.base import BaseTool, ToolRegistry, ToolSafety, ToolSpec


SYNTHETIC_DIFF = """\
diff --git a/src/app.py b/src/app.py
index 1111111..2222222 100644
--- a/src/app.py
+++ b/src/app.py
@@ -1,2 +1,2 @@
 def compute(value):
-    return value
+    return value + 1
"""

ARCHIVED_PAID_FIXTURE = (
    Path(__file__).parent / "fixtures" / "v3_closeout" / "haystack_paid_20260911.json"
)


def _archived_fixture() -> dict[str, Any]:
    payload = json.loads(ARCHIVED_PAID_FIXTURE.read_text(encoding="utf-8"))
    assert payload["schema_version"] == "archived-v3-provider-actions-v1"
    return payload


def _archived_variant(variant_id: str) -> dict[str, Any]:
    variants = [
        item
        for item in _archived_fixture()["variants"]
        if item.get("variant_id") == variant_id
    ]
    assert len(variants) == 1
    variant = variants[0]
    assert len(variant["model_responses"]) == 4
    return variant


def _archived_records(variant: dict[str, Any]) -> list[dict[str, Any]]:
    core_fields = (
        "evidence_id",
        "artifact_id",
        "snapshot_id",
        "revision",
        "path",
        "side",
        "start_line",
        "end_line",
        "content",
        "content_hash",
        "body_hash",
        "source_type",
        "source_tool_call_id",
        "delivery_request_id",
        "lifecycle",
        "displayed_ranges",
        "displayed_line_numbers",
        "truncated",
        "scope",
    )
    records: dict[str, dict[str, Any]] = {}
    for event in sorted(
        variant["referenced_catalog_events"], key=lambda item: int(item["seq"])
    ):
        assert event["type"] == "evidence_catalog"
        for record in event["records"]:
            evidence_id = str(record["evidence_id"])
            previous = records.get(evidence_id)
            if previous is not None:
                # Catalog aliases are intentionally cumulative across journal
                # events.  The source body and its system identity must not
                # drift; retain the last event's alias snapshot for the
                # supplementary controlled replay.
                assert all(
                    previous.get(field) == record.get(field) for field in core_fields
                )
                assert set(previous.get("aliases", [])) <= set(
                    record.get("aliases", [])
                )
            records[evidence_id] = copy.deepcopy(record)
    assert set(records) == set(variant["referenced_evidence_ids"])
    return list(records.values())


def _archive_relative_path(value: str) -> str:
    normalized = str(value).replace("\\", "/")
    marker = "haystack/"
    index = normalized.lower().find(marker)
    if index < 0:
        raise AssertionError(f"archive action path is not under haystack/: {value}")
    return normalized[index:]


def _archived_diff(variant: dict[str, Any]) -> str:
    """Reassemble only the archived git-diff hunk bodies for changed-line gating."""

    hunks: list[str] = []
    seen: set[str] = set()
    for record in _archived_records(variant):
        if str(record.get("source_type", "")) != "git_diff":
            continue
        path = str(record.get("path", "")).replace("\\", "/")
        content = str(record.get("content", ""))
        key = f"{path}\n{content}"
        if key in seen:
            continue
        seen.add(key)
        hunks.append(
            f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n{content}\n"
        )
    assert hunks
    return "".join(hunks)


@pytest.fixture(autouse=True)
def _offline_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep the test process offline and signing/config independent."""

    values = {
        "GIT_CONFIG_GLOBAL": "NUL",
        "MODEL_NAME": "offline-v3-e2e",
        "MODEL_PROVIDER": "offline",
        "OPENAI_API_KEY": "offline-test-key",
        "OPENAI_BASE_URL": "http://127.0.0.1:9/v1",
        "REVIEW_CONTEXT_MODE": "agent_search",
        "RELATION_GRAPH_ENABLED": "false",
        "CONTEXT_SUMMARY_ENABLED": "false",
        "FINDING_CONTRACT_VERSION": "3.0",
        "REVIEW_WORKFLOW_ENFORCEMENT": "off",
        "REVIEW_DIFF_FIRST_CHANGED_FILES": "false",
        "REVIEW_SKILL_RETRIEVAL_MODE": "sequential",
        "MODEL_MAX_RETRIES": "1",
        "REVIEW_REPAIR_MAX_ATTEMPTS": "1",
        "TOKEN_BUDGET": "30000",
        "TOKEN_HARD_BUDGET": "36000",
        "FINAL_SUBMIT_RESERVE_TOKENS": "12000",
        "FINAL_SUBMIT_PROMPT_TOKEN_BUDGET": "4000",
        "FINAL_SUBMIT_FEEDBACK_TOKEN_BUDGET": "1200",
        "PROMPT_INPUT_TOKEN_BUDGET": "32000",
        "ASSEMBLED_REQUEST_TOKEN_BUDGET": "36000",
        "EXPLORATION_MAX_OUTPUT_TOKENS": "4096",
        "SUBMIT_MAX_OUTPUT_TOKENS": "2048",
        "SEMANTIC_VERIFIER_BATCH_SIZE": "32",
        "SEMANTIC_VERIFIER_MAX_MODEL_CALLS": "2",
        "SEMANTIC_VERIFIER_MAX_INVESTIGATION_CALLS": "1",
        "SEMANTIC_VERIFIER_MAX_INVESTIGATION_TOOL_CALLS": "2",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)


def _message_text(messages: Any) -> str:
    parts: list[str] = []
    for message in messages or []:
        if isinstance(message, dict):
            parts.append(str(message.get("content", "")))
        else:
            parts.append(str(getattr(message, "content", "")))
    return "\n".join(parts)


def _tool_names(tools: Any) -> set[str]:
    result: set[str] = set()
    for item in tools or []:
        if isinstance(item, dict) and isinstance(item.get("function"), dict):
            result.add(str(item["function"].get("name", "")).strip())
    return result


def _candidate_handles(text: str) -> list[str]:
    values = re.findall(
        r'"(?:opaque_handle|target_handle)"\s*:\s*"([^"]+)"',
        text,
    )
    return list(dict.fromkeys(value for value in values if value.startswith("vh_")))


def _repair_handles(text: str) -> list[str]:
    values = re.findall(r"repair_target_[A-Za-z0-9]+", text)
    return list(
        dict.fromkeys(value for value in values if value.startswith("repair_target_"))
    )


def _action_call(
    call_id: str,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(
                arguments,
                ensure_ascii=True,
                separators=(",", ":"),
            ),
        },
    }


class _ScriptedProvider:
    """Wire-level fake for reviewer, verifier, and repair model calls."""

    def __init__(
        self,
        reviewer_steps: list[dict[str, Any] | str],
        *,
        semantic_steps: list[dict[str, Any] | str] | None = None,
        repair_step: dict[str, Any] | None = None,
        cancel_on_semantic: bool = False,
    ) -> None:
        self.default_config = ModelConfig(model="offline-v3-e2e", max_tokens=4096)
        self.reviewer_steps = copy.deepcopy(reviewer_steps)
        self.semantic_steps = copy.deepcopy(semantic_steps or [])
        self.repair_step = copy.deepcopy(repair_step)
        self.cancel_on_semantic = cancel_on_semantic
        self.orchestrator: AgentOrchestrator | None = None
        self.diff_text = ""
        self.calls: list[dict[str, Any]] = []
        self.reviewer_calls = 0
        self.semantic_calls = 0
        self.repair_calls = 0
        self.unexpected_reviewer_calls = 0
        self.finish_actions: list[dict[str, Any]] = []
        self.review_action_payloads: list[dict[str, Any]] = []

    def _evidence_ref(self, message_text: str = "") -> str:
        prompt_ids = re.findall(r'"evidence_id"\s*:\s*"(ev_[^"]+)"', message_text)
        catalog: list[dict[str, Any]] = []
        if self.orchestrator is not None:
            catalog = list(self.orchestrator._live_evidence_catalog)  # noqa: SLF001
        catalog_by_id = {
            str(record.get("evidence_id", "")).strip(): record
            for record in catalog
            if str(record.get("evidence_id", "")).strip()
        }
        for evidence_id in prompt_ids:
            record = catalog_by_id.get(evidence_id)
            if record is not None:
                return evidence_id
        if not catalog and self.orchestrator is not None:
            catalog = ledger_from_sources(
                diff_text=self.diff_text,
                snapshot_id=self.orchestrator._evidence_snapshot_id,  # noqa: SLF001
                revision=self.orchestrator._evidence_revision,  # noqa: SLF001
            ).to_payload()
        for record in catalog:
            if (
                str(record.get("source_type", "")) == "git_diff"
                and str(record.get("evidence_id", "")).strip()
            ):
                return str(record["evidence_id"])
        raise AssertionError("no synthetic diff evidence was delivered")

    def _finding(
        self,
        step: dict[str, Any],
        message_text: str = "",
    ) -> dict[str, Any]:
        finding = copy.deepcopy(step.get("finding"))
        if isinstance(finding, dict):
            return finding
        return {
            "anchor": {"file": "src/app.py", "line": 2},
            "description": str(
                step.get(
                    "description",
                    "The changed return value violates the caller contract.",
                )
            ),
            "evidence_refs": [self._evidence_ref(message_text)],
            "severity": str(step.get("severity", "warning")),
            "suggestion": str(
                step.get("suggestion", "Preserve the established return value.")
            ),
        }

    def _review_response(
        self,
        step: dict[str, Any] | str,
        response_number: int,
        message_text: str = "",
    ) -> ModelResponse:
        if isinstance(step, str):
            return ModelResponse(
                model="offline-v3-e2e",
                provider_request_id=f"review-provider-{response_number}",
                finish_reason="stop",
                content=step,
                usage=TokenUsage(total_tokens=2),
            )
        kind = str(step.get("kind", "text"))
        if "tool_calls" in step:
            tool_calls = copy.deepcopy(step["tool_calls"])
        elif kind == "save":
            payload = {"finding": self._finding(step, message_text)}
            self.review_action_payloads.append(copy.deepcopy(payload))
            tool_calls = [
                _action_call(
                    f"review-call-{response_number}",
                    "save_finding",
                    payload,
                )
            ]
        elif kind == "revise":
            handles = _candidate_handles(str(step.get("_messages", "")))
            target = str(step.get("opaque_handle", "")).strip()
            target = target or (handles[0] if handles else "")
            payload = {
                "opaque_handle": target,
                "patch": copy.deepcopy(
                    step.get(
                        "patch",
                        {"description": "The revised description is precise."},
                    )
                ),
            }
            self.review_action_payloads.append(copy.deepcopy(payload))
            tool_calls = [
                _action_call(
                    f"review-call-{response_number}",
                    "revise_finding",
                    payload,
                )
            ]
        elif kind == "finish":
            payload = {"summary": str(step.get("summary", "Offline review finished."))}
            self.finish_actions.append(copy.deepcopy(payload))
            tool_calls = [
                _action_call(
                    f"review-call-{response_number}",
                    "finish_review",
                    payload,
                )
            ]
        else:
            return ModelResponse(
                model="offline-v3-e2e",
                provider_request_id=f"review-provider-{response_number}",
                finish_reason=str(step.get("finish_reason", "stop")),
                content=str(step.get("content", "")),
                usage=TokenUsage(total_tokens=int(step.get("total_tokens", 2))),
            )
        return ModelResponse(
            model="offline-v3-e2e",
            provider_request_id=f"review-provider-{response_number}",
            finish_reason=str(step.get("finish_reason", "tool_calls")),
            content=str(step.get("content", "")),
            tool_calls=tool_calls,
            usage=TokenUsage(total_tokens=int(step.get("total_tokens", 2))),
        )

    def _semantic_response(
        self,
        step: dict[str, Any] | str,
        call_number: int,
        text: str,
    ) -> ModelResponse:
        if self.cancel_on_semantic or step == "cancel":
            raise asyncio.CancelledError
        handles = _candidate_handles(text)
        if isinstance(step, dict) and isinstance(step.get("decisions"), list):
            decisions = copy.deepcopy(step["decisions"])
        else:
            verdict = (
                str(step.get("verdict", "accept"))
                if isinstance(step, dict)
                else "accept"
            )
            decisions = []
            for handle in handles:
                decision = {
                    "opaque_handle": handle,
                    "verdict": verdict,
                    "reason": str(
                        step.get("reason", "The synthetic finding is supported.")
                        if isinstance(step, dict)
                        else "The synthetic finding is supported."
                    ),
                }
                if verdict == "needs_revision":
                    decision["request"] = str(
                        step.get(
                            "request",
                            "Clarify the finding before accepting it.",
                        )
                    )
                    if isinstance(step, dict) and step.get("investigation") is not None:
                        decision["investigation"] = copy.deepcopy(step["investigation"])
                decisions.append(decision)
        return ModelResponse(
            model="offline-v3-e2e",
            provider_request_id=f"semantic-provider-{call_number}",
            finish_reason="tool_calls",
            tool_calls=[
                _action_call(
                    f"semantic-call-{call_number}",
                    "verify_findings",
                    {"decisions": decisions},
                )
            ],
            usage=TokenUsage(
                total_tokens=int(
                    step.get("total_tokens", 2) if isinstance(step, dict) else 2
                )
            ),
        )

    def _repair_response(self, text: str, call_number: int) -> ModelResponse:
        step = self.repair_step or {}
        target = str(step.get("target_handle", "")).strip()
        if not target:
            targets = _repair_handles(text)
            target = targets[0] if targets else ""
        payload = {
            "repairs": [
                {
                    "target_handle": target,
                    "repair_status": str(step.get("repair_status", "repaired")),
                    "repair_reason": str(
                        step.get("repair_reason", "Bounded offline repair.")
                    ),
                    "repair_patch": copy.deepcopy(
                        step.get(
                            "repair_patch",
                            {"description": "The revised description is precise."},
                        )
                    ),
                }
            ]
        }
        return ModelResponse(
            model="offline-v3-e2e",
            provider_request_id=f"repair-provider-{call_number}",
            finish_reason="tool_calls",
            tool_calls=[
                _action_call(
                    f"repair-call-{call_number}",
                    "repair_review",
                    payload,
                )
            ],
            usage=TokenUsage(total_tokens=2),
        )

    async def chat(
        self,
        messages: Any,
        config: ModelConfig | None = None,
        tools: Any = None,
        policy: Any = None,
        conversation: Any = None,
    ) -> ModelResponse:
        del config, policy, conversation
        names = _tool_names(tools)
        text = _message_text(messages)
        if "verify_findings" in names:
            self.semantic_calls += 1
            index = self.semantic_calls - 1
            step = (
                self.semantic_steps[index] if index < len(self.semantic_steps) else {}
            )
            self.calls.append({"stage": "semantic", "tools": names, "text": text})
            return self._semantic_response(step, self.semantic_calls, text)
        if "repair_review" in names:
            self.repair_calls += 1
            self.calls.append({"stage": "repair", "tools": names, "text": text})
            return self._repair_response(text, self.repair_calls)
        self.reviewer_calls += 1
        index = self.reviewer_calls - 1
        self.calls.append({"stage": "reviewer", "tools": names, "text": text})
        if index >= len(self.reviewer_steps):
            self.unexpected_reviewer_calls += 1
            return ModelResponse(
                model="offline-v3-e2e",
                provider_request_id=f"unexpected-review-provider-{self.reviewer_calls}",
                finish_reason="stop",
                content="No further reviewer action.",
                usage=TokenUsage(total_tokens=2),
            )
        step = copy.deepcopy(self.reviewer_steps[index])
        if isinstance(step, dict):
            step["_messages"] = text
        return self._review_response(step, self.reviewer_calls, text)


class _ReadFileTool(BaseTool):
    def __init__(self, root: Path) -> None:
        self.root = root
        self.calls: list[dict[str, Any]] = []

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="read_file",
            description="Read a bounded source window.",
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string"},
                    "offset": {"type": "integer"},
                    "limit": {"type": "integer"},
                },
                "required": ["file_path"],
            },
            safety=ToolSafety.READONLY,
        )

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(copy.deepcopy(kwargs))
        relative = str(kwargs.get("file_path", "")).replace("\\", "/").lstrip("/")
        lines = (self.root / relative).read_text(encoding="utf-8").splitlines()
        offset = max(0, int(kwargs.get("offset", 0) or 0))
        limit = max(1, min(128, int(kwargs.get("limit", 64) or 64)))
        selected = lines[offset : offset + limit]
        return {
            "ok": True,
            "file_path": relative,
            "start_line": offset + 1,
            "line_count": len(selected),
            "content": "\n".join(selected),
            "truncated": offset + limit < len(lines),
        }


class _GrepFilesTool(BaseTool):
    def __init__(self, root: Path) -> None:
        self.root = root
        self.calls: list[dict[str, Any]] = []

    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="grep_files",
            description="Search a bounded source file.",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string"},
                    "path": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["pattern", "path"],
            },
            safety=ToolSafety.READONLY,
        )

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(copy.deepcopy(kwargs))
        relative = str(kwargs.get("path", "")).replace("\\", "/").lstrip("/")
        pattern = str(kwargs.get("pattern", ""))
        matches: list[dict[str, Any]] = []
        for number, line in enumerate(
            (self.root / relative).read_text(encoding="utf-8").splitlines(),
            1,
        ):
            if pattern and pattern not in line:
                continue
            matches.append(
                {
                    "file_path": relative,
                    "line_number": number,
                    "line_text": line,
                }
            )
            if len(matches) >= int(kwargs.get("limit", 50) or 50):
                break
        return {"ok": True, "matches": matches, "truncated": False}


class _ArchiveReadFileTool(_ReadFileTool):
    """Read an archived absolute path through an exact suffix mapping."""

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        original_path = str(kwargs.get("file_path", ""))
        mapped = dict(kwargs)
        mapped["file_path"] = _archive_relative_path(original_path)
        result = await super().execute(**mapped)
        result["controlled_archive_mapping"] = "exact_path_suffix"
        return result


class _ArchiveGrepFilesTool(_GrepFilesTool):
    """Search an archived absolute path through an exact suffix mapping."""

    def spec(self) -> ToolSpec:
        base = super().spec()
        parameters = copy.deepcopy(base.parameters)
        properties = parameters.setdefault("properties", {})
        properties["glob"] = {
            "type": "string",
            "description": "Optional file glob when path names a directory.",
        }
        return base.model_copy(update={"parameters": parameters})

    async def execute(self, **kwargs: Any) -> dict[str, Any]:
        original_path = str(kwargs.get("path", ""))
        mapped = dict(kwargs)
        mapped["path"] = _archive_relative_path(original_path)
        self.calls.append(copy.deepcopy(mapped))
        target = self.root / Path(*str(mapped["path"]).split("/"))
        if not target.exists():
            # This action's source was not retained by the archive's finding
            # catalog.  Keep it a successful read-only replay with no source
            # evidence, rather than inventing a body for a missing path.
            return {
                "ok": True,
                "matches": [],
                "truncated": False,
                "controlled_archive_mapping": "exact_path_suffix_unmaterialized",
            }
        pattern = str(mapped.get("pattern", ""))
        try:
            glob = str(mapped.get("glob", "") or "")
            paths = (
                [target]
                if target.is_file()
                else sorted(
                    item for item in target.glob(glob or "**/*") if item.is_file()
                )
            )
        except (OSError, ValueError):
            paths = []
        limit = max(1, int(mapped.get("limit", 50) or 50))
        matches: list[dict[str, Any]] = []
        for path in paths:
            relative = path.relative_to(self.root).as_posix()
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for number, line in enumerate(lines, 1):
                matched = False
                if pattern:
                    try:
                        matched = re.search(pattern, line) is not None
                    except re.error:
                        matched = pattern in line
                if not matched:
                    continue
                matches.append(
                    {
                        "file_path": relative,
                        "line_number": number,
                        "line_text": line,
                    }
                )
                if len(matches) >= limit:
                    return {
                        "ok": True,
                        "matches": matches,
                        "truncated": True,
                        "controlled_archive_mapping": "exact_path_suffix",
                    }
        return {
            "ok": True,
            "matches": matches,
            "truncated": False,
            "controlled_archive_mapping": "exact_path_suffix",
        }


def _archive_source_lines(record: dict[str, Any]) -> list[str]:
    start_line = int(record["start_line"])
    end_line = int(record["end_line"])
    lines = str(record["content"]).splitlines()
    assert len(lines) == end_line - start_line + 1
    numbered: list[str] = []
    for expected_line, line in enumerate(lines, start_line):
        match = re.match(r"^(\d+): ?(.*)$", line)
        if match is None or int(match.group(1)) != expected_line:
            numbered = []
            break
        numbered.append(match.group(2))
    return numbered or lines


def _materialize_archived_sources(
    tmp_path: Path,
    records: list[dict[str, Any]],
) -> None:
    """Materialize only exact catalog bodies needed by the controlled replay."""

    candidates_by_path: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        source_type = str(record.get("source_type", ""))
        if source_type not in {"file_context", "read_file", "grep_files"}:
            continue
        path = str(record.get("path", "")).replace("\\", "/")
        candidates_by_path.setdefault(path, []).append(record)

    source_priority = {"file_context": 0, "read_file": 1, "grep_files": 2}
    for path, candidates in candidates_by_path.items():
        max_line = max(int(item["end_line"]) for item in candidates)
        materialized = ["# controlled archive source placeholder"] * max_line
        priorities = [99] * max_line
        for record in sorted(
            candidates,
            key=lambda item: (
                source_priority[str(item.get("source_type", ""))],
                -(int(item["end_line"]) - int(item["start_line"]) + 1),
            ),
        ):
            priority = source_priority[str(record["source_type"])]
            start_line = int(record["start_line"])
            source_lines = _archive_source_lines(record)
            for offset, line in enumerate(source_lines, start_line):
                index = offset - 1
                if priorities[index] < priority:
                    continue
                if priorities[index] == priority and materialized[index] != line:
                    raise AssertionError(
                        f"conflicting controlled source bodies at {path}:{offset}"
                    )
                materialized[index] = line
                priorities[index] = priority
        target = tmp_path / Path(*path.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("\n".join(materialized) + "\n", encoding="utf-8")


class _ControlledArchiveOrchestrator(AgentOrchestrator):
    """Supplementary replay with the archived run identity restored explicitly."""

    def __init__(
        self,
        *args: Any,
        archive_records: list[dict[str, Any]],
        archive_snapshot_id: str,
        archive_revision: str,
        **kwargs: Any,
    ) -> None:
        self._controlled_archive_records = copy.deepcopy(archive_records)
        self._archive_snapshot_id = archive_snapshot_id
        self._archive_revision = archive_revision
        super().__init__(*args, **kwargs)

    def _reset_run(self, max_iterations: int, repo_path: str) -> None:
        super()._reset_run(max_iterations=max_iterations, repo_path=repo_path)
        # Restore the exact archived run identity for binding checks.  The
        # temp workspace is only a controlled body/path materialization; this
        # does not claim it is a complete checkout of the archived snapshot.
        self._evidence_snapshot_id = self._archive_snapshot_id
        self._evidence_revision = self._archive_revision

    def _build_review_tool_context(self, request: ReviewRequest) -> Any:
        context = super()._build_review_tool_context(request)
        # Building a diff context derives a temp-worktree identity; restore
        # the archived identity after that normal preparation step as well.
        self._evidence_snapshot_id = self._archive_snapshot_id
        self._evidence_revision = self._archive_revision
        return context

    def _publish_evidence_catalog(self, state: Any) -> None:
        existing_ids = {
            str(item.get("evidence_id", "")).strip()
            for item in state.evidence_ledger
            if isinstance(item, dict)
        }
        missing_archive_records = [
            copy.deepcopy(record)
            for record in self._controlled_archive_records
            if str(record.get("evidence_id", "")).strip() not in existing_ids
        ]
        state.evidence_ledger = ledger_from_sources(
            existing_payload=[
                *state.evidence_ledger,
                *missing_archive_records,
            ],
            snapshot_id=self._archive_snapshot_id,
            revision=self._archive_revision,
        ).to_payload()
        super()._publish_evidence_catalog(state)


class _ArchivedActionProvider:
    """Return each archived reviewer event verbatim, one provider call at a time."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.default_config = ModelConfig(model="archived-paid-replay", max_tokens=4096)
        self.events = copy.deepcopy(events)
        self.archive_cursor = 0
        self.archive_calls: list[dict[str, Any]] = []
        self.semantic_calls = 0
        self.calls: list[dict[str, Any]] = []
        self.finish_actions: list[dict[str, Any]] = []

    async def chat(
        self,
        messages: Any,
        config: ModelConfig | None = None,
        tools: Any = None,
        policy: Any = None,
        conversation: Any = None,
    ) -> ModelResponse:
        del config, policy, conversation
        names = _tool_names(tools)
        text = _message_text(messages)
        if "verify_findings" in names:
            self.semantic_calls += 1
            handles = _candidate_handles(text)
            self.calls.append({"stage": "semantic", "tools": names})
            return ModelResponse(
                model="archived-paid-replay",
                provider_request_id=f"controlled-semantic-{self.semantic_calls}",
                finish_reason="tool_calls",
                tool_calls=[
                    _action_call(
                        f"controlled-semantic-call-{self.semantic_calls}",
                        "verify_findings",
                        {
                            "decisions": [
                                {
                                    "opaque_handle": handle,
                                    "verdict": "accept",
                                    "reason": "Controlled archive replay entered the semantic gate.",
                                }
                                for handle in handles
                            ]
                        },
                    )
                ],
                usage=TokenUsage(total_tokens=2),
            )
        if "repair_review" in names:
            raise AssertionError("archive replay unexpectedly entered repair_review")
        if self.archive_cursor >= len(self.events):
            raise AssertionError(
                "archive replay requested a response beyond its exact boundary"
            )
        event = self.events[self.archive_cursor]
        self.archive_cursor += 1
        payload = copy.deepcopy(event["payload"])
        response = ModelResponse.model_validate(payload)
        response.provider_request_id = str(event["id"])
        tool_names = [
            str(item.get("function", {}).get("name", ""))
            for item in response.tool_calls
            if isinstance(item, dict)
        ]
        self.archive_calls.append(
            {
                "id": event["id"],
                "seq": event["seq"],
                "iteration": payload.get("iteration"),
                "tool_names": tool_names,
                "payload": copy.deepcopy(payload),
            }
        )
        self.calls.append(
            {"stage": "reviewer", "tools": names, "event_id": event["id"]}
        )
        return response


def _registry(tmp_path: Path) -> tuple[ToolRegistry, _ReadFileTool, _GrepFilesTool]:
    read_file = _ReadFileTool(tmp_path)
    grep_files = _GrepFilesTool(tmp_path)
    registry = ToolRegistry()
    registry.register(read_file)
    registry.register(grep_files)
    return registry, read_file, grep_files


def _prepare_workspace(tmp_path: Path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "def compute(value):\n"
        "    return value + 1\n"
        "\n"
        "def caller(value):\n"
        "    return compute(value)\n",
        encoding="utf-8",
    )


def _run(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    provider: _ScriptedProvider,
    *,
    max_iterations: int = 3,
    timeout: float | None = None,
) -> tuple[Any, AgentOrchestrator, _ReadFileTool, _GrepFilesTool]:
    monkeypatch.chdir(tmp_path)
    _prepare_workspace(tmp_path)
    registry, read_file, grep_files = _registry(tmp_path)
    orchestrator = AgentOrchestrator(
        registry=registry,
        review_max_iterations=max_iterations,
        review_workflow_enforcement="off",
        context_mode="agent_search",
        agent_run_timeout_seconds=timeout,
    )
    provider.orchestrator = orchestrator
    provider.diff_text = SYNTHETIC_DIFF
    orchestrator._model_client = provider  # noqa: SLF001
    response = asyncio.run(
        orchestrator.run_review(
            ReviewRequest(
                repo_path=str(tmp_path),
                diff_mode=True,
                diff_text=SYNTHETIC_DIFF,
                model_name="offline-v3-e2e",
            )
        )
    )
    return response, orchestrator, read_file, grep_files


def _run_archived(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    variant: dict[str, Any],
    response_count: int,
    *,
    records_override: list[dict[str, Any]] | None = None,
    archive_snapshot_override: str | None = None,
) -> tuple[
    Any,
    _ControlledArchiveOrchestrator,
    _ArchivedActionProvider,
    _ArchiveReadFileTool,
    _ArchiveGrepFilesTool,
]:
    records = (
        copy.deepcopy(records_override)
        if records_override is not None
        else _archived_records(variant)
    )
    _materialize_archived_sources(tmp_path, records)
    read_file = _ArchiveReadFileTool(tmp_path)
    grep_files = _ArchiveGrepFilesTool(tmp_path)
    registry = ToolRegistry()
    registry.register(read_file)
    registry.register(grep_files)
    provider = _ArchivedActionProvider(variant["model_responses"][:response_count])
    orchestrator = _ControlledArchiveOrchestrator(
        registry=registry,
        archive_records=records,
        archive_snapshot_id=(
            archive_snapshot_override
            or str(variant["referenced_catalog_events"][0]["records"][0]["snapshot_id"])
        ),
        archive_revision=str(
            variant["referenced_catalog_events"][0]["records"][0]["revision"]
        ),
        review_max_iterations=response_count,
        review_workflow_enforcement="off",
        context_mode="agent_search",
    )
    provider.orchestrator = orchestrator
    orchestrator._model_client = provider  # noqa: SLF001
    response = asyncio.run(
        orchestrator.run_review(
            ReviewRequest(
                repo_path=str(tmp_path),
                diff_mode=True,
                diff_text=_archived_diff(variant),
                model_name="archived-paid-replay",
            )
        )
    )
    return response, orchestrator, provider, read_file, grep_files


def _assert_restricted(response: Any) -> None:
    assert response.completion_status == "incomplete"
    assert response.report_ready is False
    assert response.delivery_complete is False
    assert response.external_publish_status != "ready"
    assert response.incomplete_reasons


def _one_candidate(response: Any) -> dict[str, Any]:
    assert len(response.context.candidate_registrations) == 1
    return response.context.candidate_registrations[0]


@pytest.mark.parametrize("max_iterations", [1, 3])
def test_save_only_round_cap_is_registry_handoff_without_finish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    max_iterations: int,
) -> None:
    """Both cap sizes preserve saves and never manufacture a finish action."""

    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": f"Bounded candidate from round {index + 1}.",
            }
            for index in range(max_iterations)
        ],
        semantic_steps=[{"verdict": "accept"}],
    )

    response, _, _, _ = _run(
        tmp_path,
        monkeypatch,
        provider,
        max_iterations=max_iterations,
    )

    assert provider.reviewer_calls == max_iterations
    assert provider.semantic_calls == 1
    assert provider.finish_actions == []
    assert provider.unexpected_reviewer_calls == 0
    assert response.submission_received is True
    _assert_restricted(response)
    assert len(response.context.candidate_registrations) == max_iterations


def test_saved_finding_then_natural_text_stop_can_complete_without_finish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A saved Registry candidate is enough for an approved natural closeout."""

    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The changed return violates the caller contract.",
            },
            "The targeted review is complete.",
        ],
        semantic_steps=[
            {
                "verdict": "accept",
                "reason": "The saved candidate is supported.",
            }
        ],
    )

    response, _, _, _ = _run(tmp_path, monkeypatch, provider, max_iterations=3)

    assert provider.reviewer_calls == 2
    assert provider.semantic_calls == 1
    assert provider.finish_actions == []
    assert provider.unexpected_reviewer_calls == 0
    assert response.submission_received is True
    assert response.completion_status == "complete"
    assert response.report_ready is True
    assert response.delivery_complete is True
    assert response.external_publish_status in {
        "ready",
        "published",
        "not_requested",
    }
    assert response.report.issues
    assert _one_candidate(response)["semantic_verdict"] == "accept"


def test_unsaved_natural_text_stop_is_not_a_clean_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Ordinary stop text without a Registry candidate cannot imply no issues."""

    provider = _ScriptedProvider(["Everything looks good; stopping now."])

    response, _, _, _ = _run(tmp_path, monkeypatch, provider, max_iterations=3)

    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 0
    assert provider.finish_actions == []
    assert response.submission_received is True
    assert response.report.issues == []
    _assert_restricted(response)
    summary = response.report.summary.lower()
    assert "no finding" in summary or "finish" in summary


def test_last_round_revise_updates_the_same_registry_candidate_without_finish(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The initial candidate needs a more precise explanation.",
            },
            {
                "kind": "revise",
                "patch": {
                    "description": "The revised candidate has a precise explanation."
                },
            },
        ],
        semantic_steps=[{"verdict": "accept"}],
    )

    response, _, _, _ = _run(tmp_path, monkeypatch, provider, max_iterations=2)

    assert provider.reviewer_calls == 2
    assert provider.semantic_calls == 1
    assert provider.finish_actions == []
    assert len(response.context.candidate_registrations) == 1
    record = _one_candidate(response)
    assert record["current_content"]["description"] == (
        "The revised candidate has a precise explanation."
    )
    assert record["previous_content_versions"]
    assert response.submission_received is True
    _assert_restricted(response)


def test_semantic_reject_does_not_publish_the_candidate_or_finish_review(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "This candidate is rejected by the verifier.",
            }
        ],
        semantic_steps=[
            {
                "verdict": "reject",
                "reason": "The causal claim is not supported by the diff.",
            }
        ],
    )

    response, _, _, _ = _run(tmp_path, monkeypatch, provider, max_iterations=1)

    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 1
    assert provider.finish_actions == []
    assert response.semantic_rejected_count == 1
    assert response.report.issues == []
    assert _one_candidate(response)["semantic_verdict"] == "reject"
    assert response.submission_received is True
    _assert_restricted(response)


def test_soft_budget_stops_review_but_preserves_the_verified_partial_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TOKEN_BUDGET", "10000")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "16000")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "1000")
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The saved candidate remains reviewable at the soft cap.",
                "total_tokens": 10000,
            }
        ],
        semantic_steps=[{"verdict": "accept", "total_tokens": 2}],
    )

    response, orchestrator, _, _ = _run(
        tmp_path, monkeypatch, provider, max_iterations=3
    )

    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 1
    assert provider.finish_actions == []
    assert orchestrator._budget_state == "soft_capped"  # noqa: SLF001
    assert response.submission_received is True
    assert response.report.issues
    _assert_restricted(response)
    assert any(
        "budget" in reason.lower() or "token" in reason.lower()
        for reason in response.incomplete_reasons
    )


def test_hard_budget_forbids_post_stop_model_calls_and_keeps_registry_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TOKEN_BUDGET", "8000")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "10000")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "1000")
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The hard-capped candidate remains in the Registry.",
                "total_tokens": 10000,
            }
        ],
        semantic_steps=[{"verdict": "accept"}],
    )

    response, orchestrator, _, _ = _run(
        tmp_path, monkeypatch, provider, max_iterations=3
    )

    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 0
    assert provider.repair_calls == 0
    assert provider.finish_actions == []
    assert orchestrator._budget_state == "hard_capped"  # noqa: SLF001
    assert response.submission_received is True
    assert len(response.context.candidate_registrations) == 1
    _assert_restricted(response)
    assert any(
        "budget" in reason.lower() or "token" in reason.lower()
        for reason in response.incomplete_reasons
    )


def test_hard_budget_preflight_blocks_the_first_provider_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TOKEN_BUDGET", "1")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "1")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "1")
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "This action must never be sent at hard cap one.",
            }
        ],
        semantic_steps=[{"verdict": "accept"}],
    )

    response, orchestrator, _, _ = _run(
        tmp_path, monkeypatch, provider, max_iterations=3
    )

    assert provider.calls == []
    assert provider.reviewer_calls == 0
    assert provider.semantic_calls == 0
    assert provider.repair_calls == 0
    assert response.context.candidate_registrations == []
    assert response.submission_received is True
    assert any(
        "runtime_token_soft_preflight" in str(getattr(error, "message", error))
        for error in response.context.errors
    )
    assert orchestrator._total_tokens == 0  # noqa: SLF001
    _assert_restricted(response)


def test_semantic_repair_does_not_refresh_run_wide_verifier_or_investigation_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The initial candidate needs a bounded recheck.",
            }
        ],
        semantic_steps=[
            {
                "verdict": "needs_revision",
                "request": "Read the changed implementation before deciding again.",
                "investigation": {
                    "tool": "read_file",
                    "file": "src/app.py",
                    "start_line": 1,
                    "end_line": 2,
                },
            },
            {
                "verdict": "needs_revision",
                "request": "Clarify the candidate before accepting it.",
            },
            {
                "verdict": "accept",
            },
        ],
        repair_step={
            "repair_patch": {
                "description": "The revised candidate states the bounded contract precisely."
            }
        },
    )

    response, orchestrator, read_file, _ = _run(
        tmp_path,
        monkeypatch,
        provider,
        max_iterations=1,
    )

    assert [call["stage"] for call in provider.calls] == [
        "reviewer",
        "semantic",
        "semantic",
        "repair",
    ]
    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 2
    assert provider.repair_calls == 1
    assert provider.unexpected_reviewer_calls == 0
    assert provider.finish_actions == []
    assert orchestrator._semantic_model_call_count == 2  # noqa: SLF001
    assert orchestrator._semantic_investigation_call_count == 1  # noqa: SLF001
    assert orchestrator._semantic_investigation_tool_call_count == 1  # noqa: SLF001
    assert len(read_file.calls) == 1
    assert len(response.context.candidate_registrations) == 1
    assert response.semantic_needs_revision_count == 0
    assert response.semantic_unresolved_count == 1
    assert response.semantic_verifier_completed is False
    assert response.submission_received is True
    _assert_restricted(response)
    assert any(
        "needs_revision" in reason or "unresolved" in reason
        for reason in response.incomplete_reasons
    )


def test_cancel_propagates_without_new_model_calls_and_keeps_registry_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = _ScriptedProvider(
        [
            {
                "kind": "save",
                "description": "The saved candidate must survive cancellation.",
            }
        ],
        cancel_on_semantic=True,
    )

    monkeypatch.chdir(tmp_path)
    _prepare_workspace(tmp_path)
    registry, _, _ = _registry(tmp_path)
    orchestrator = AgentOrchestrator(
        registry=registry,
        review_max_iterations=1,
        review_workflow_enforcement="off",
        context_mode="agent_search",
    )
    provider.orchestrator = orchestrator
    provider.diff_text = SYNTHETIC_DIFF
    orchestrator._model_client = provider  # noqa: SLF001

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            orchestrator.run_review(
                ReviewRequest(
                    repo_path=str(tmp_path),
                    diff_mode=True,
                    diff_text=SYNTHETIC_DIFF,
                    model_name="offline-v3-e2e",
                )
            )
        )

    assert [call["stage"] for call in provider.calls] == ["reviewer", "semantic"]
    assert provider.reviewer_calls == 1
    assert provider.semantic_calls == 1
    assert provider.repair_calls == 0
    assert provider.finish_actions == []
    assert len(orchestrator._candidate_registry.records) == 1  # noqa: SLF001
    assert orchestrator._cancellation_persisted is True  # noqa: SLF001
    journal_dir = tmp_path / ".mergewarden" / "logs"
    journal_files = list(journal_dir.glob("*.jsonl"))
    assert journal_files
    journal_text = journal_files[0].read_text(encoding="utf-8")
    assert "cancelled" in journal_text.lower()
    assert "save_finding" in journal_text


@pytest.mark.parametrize("variant_id", ["A-agent-search", "B2-graph-hybrid-warm"])
@pytest.mark.parametrize("response_count", [3, 4])
def test_archived_paid_actions_replay_each_raw_response_boundary_and_enter_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    variant_id: str,
    response_count: int,
) -> None:
    """Supplementary replay: exact provider actions, controlled source mapping only."""

    # Preserve the archived paid run's shared budget envelope.  The provider
    # usage remains historical telemetry; this is not a new cost measurement.
    monkeypatch.setenv("TOKEN_BUDGET", "120000")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "160000")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "24000")
    monkeypatch.setenv("PROMPT_INPUT_TOKEN_BUDGET", "160000")
    monkeypatch.setenv("ASSEMBLED_REQUEST_TOKEN_BUDGET", "160000")
    variant = _archived_variant(variant_id)
    events = variant["model_responses"]
    assert all(
        "finish_review"
        not in {
            str(item.get("function", {}).get("name", ""))
            for item in event["payload"].get("tool_calls", [])
            if isinstance(item, dict)
        }
        for event in events
    )

    response, orchestrator, provider, read_file, grep_files = _run_archived(
        tmp_path,
        monkeypatch,
        variant,
        response_count,
    )

    expected = events[:response_count]
    assert [item["id"] for item in provider.archive_calls] == [
        item["id"] for item in expected
    ]
    assert [item["seq"] for item in provider.archive_calls] == [
        item["seq"] for item in expected
    ]
    assert [item["payload"] for item in provider.archive_calls] == [
        item["payload"] for item in expected
    ]
    assert provider.archive_cursor == response_count
    if response_count == 3:
        assert events[3]["id"] not in {item["id"] for item in provider.archive_calls}
    assert orchestrator._v3_finish_seen is False  # noqa: SLF001
    assert provider.semantic_calls >= 1
    assert response.semantic_verifier_required is True
    assert response.submission_received is True
    assert response.context.candidate_registrations
    assert response.report.issues
    assert read_file.calls or grep_files.calls
    assert orchestrator._integrity_failure_codes == {}  # noqa: SLF001
    _assert_restricted(response)


def test_archived_replay_blocks_a_catalog_snapshot_identity_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A foreign expected runtime snapshot blocks the archived candidates."""

    monkeypatch.setenv("TOKEN_BUDGET", "120000")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "160000")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "24000")
    monkeypatch.setenv("PROMPT_INPUT_TOKEN_BUDGET", "160000")
    monkeypatch.setenv("ASSEMBLED_REQUEST_TOKEN_BUDGET", "160000")
    monkeypatch.setenv("REVIEW_REPAIR_MAX_ATTEMPTS", "0")
    variant = _archived_variant("A-agent-search")

    response, orchestrator, provider, _, _ = _run_archived(
        tmp_path,
        monkeypatch,
        variant,
        3,
        archive_snapshot_override="tampered-runtime-snapshot",
    )

    assert [item["id"] for item in provider.archive_calls] == [
        item["id"] for item in variant["model_responses"][:3]
    ]
    assert provider.semantic_calls == 0
    assert orchestrator._v3_finish_seen is False  # noqa: SLF001
    assert response.context.candidate_registrations
    assert not any(
        registration["status"] == "verified"
        for registration in response.context.candidate_registrations
    )
    assert response.report.issues == []
    assert orchestrator._integrity_failure_codes  # noqa: SLF001
    assert any(
        "evidence_identity_mismatch" in codes
        for codes in orchestrator._integrity_failure_codes.values()  # noqa: SLF001
    )
    assert response.submission_received is True
    _assert_restricted(response)


def test_archived_replay_rejects_one_tampered_catalog_record_but_keeps_other_candidate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A single foreign catalog record cannot poison an otherwise valid candidate."""

    monkeypatch.setenv("TOKEN_BUDGET", "120000")
    monkeypatch.setenv("TOKEN_HARD_BUDGET", "160000")
    monkeypatch.setenv("FINAL_SUBMIT_RESERVE_TOKENS", "24000")
    monkeypatch.setenv("PROMPT_INPUT_TOKEN_BUDGET", "160000")
    monkeypatch.setenv("ASSEMBLED_REQUEST_TOKEN_BUDGET", "160000")
    monkeypatch.setenv("REVIEW_REPAIR_MAX_ATTEMPTS", "0")
    variant = _archived_variant("A-agent-search")
    records = _archived_records(variant)
    target_evidence_id = "ev_bef315c2e3c9719d6eb126ab"
    for record in records:
        if record["evidence_id"] == target_evidence_id:
            record["snapshot_id"] = "foreign-catalog-snapshot"

    response, orchestrator, provider, _, _ = _run_archived(
        tmp_path,
        monkeypatch,
        variant,
        3,
        records_override=records,
    )

    assert [item["id"] for item in provider.archive_calls] == [
        item["id"] for item in variant["model_responses"][:3]
    ]
    registrations = response.context.candidate_registrations
    target = next(
        registration
        for registration in registrations
        if target_evidence_id in registration["current_content"]["evidence_refs"]
    )
    assert target["status"] != "verified"
    target_codes = orchestrator._integrity_failure_codes.get(  # noqa: SLF001
        target["candidate_id"],
        [],
    )
    assert set(target_codes) & {
        "evidence_identity_mismatch",
        "support_reference_unresolved",
        "evidence_not_observed",
    }
    accepted = [
        registration
        for registration in registrations
        if registration["status"] == "verified"
    ]
    assert accepted
    assert all(
        all(
            evidence["snapshot_id"]
            == variant["referenced_catalog_events"][0]["records"][0]["snapshot_id"]
            for evidence in registration["current_content"]["evidence_provenance"]
        )
        for registration in accepted
    )
    assert response.submission_received is True
    _assert_restricted(response)
