"""Run-scoped ledger for source evidence actually shown to the reviewer.

The graph/index and the prompt are deliberately different things.  An index can
point at a source span without the model ever seeing its body, and a prompt can
truncate a body after it has been selected.  This module keeps the small,
exactly-ranged record needed by the integrity guard so those states cannot be
confused.
"""

from __future__ import annotations

import hashlib
from typing import Any, Literal, cast

from pydantic import BaseModel, Field, model_validator

from src.analyzer.diff_lines import parse_unified_diff_hunks
from src.analyzer.finding_schema import EvidenceSide, normalize_repo_path

EvidenceLifecycle = Literal["indexed", "selected", "delivered"]


class EvidenceRange(BaseModel):
    """A complete source range delivered in one reviewer request."""

    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)

    @model_validator(mode="after")
    def _ordered(self) -> "EvidenceRange":
        if self.end_line < self.start_line:
            raise ValueError("evidence range end_line must be >= start_line")
        return self


class ObservedEvidence(BaseModel):
    """One source artifact and its request-visible lifecycle."""

    artifact_id: str = Field(min_length=1)
    evidence_id: str = Field(
        default="",
        description=(
            "Single model-facing evidence identity. It is distinct from source "
            "artifact, Graph span/candidate ids, content hashes, and revisions."
        ),
    )
    snapshot_id: str = ""
    revision: str = ""
    path: str = Field(min_length=1)
    side: EvidenceSide = "new"
    start_line: int = Field(ge=1)
    end_line: int = Field(ge=1)
    content: str = ""
    content_hash: str = ""
    source_type: str = Field(min_length=1)
    source_tool_call_id: str = ""
    delivery_request_id: str = ""
    lifecycle: EvidenceLifecycle = "delivered"
    displayed_ranges: list[EvidenceRange] = Field(default_factory=list)
    displayed_line_numbers: list[int] = Field(default_factory=list)
    body_hash: str = ""
    truncated: bool = False
    scope: str = ""
    aliases: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _normalize(self) -> "ObservedEvidence":
        self.path = normalize_repo_path(self.path)
        if self.end_line < self.start_line:
            raise ValueError("evidence end_line must be >= start_line")
        if not self.content_hash and self.content:
            self.content_hash = hashlib.sha256(self.content.encode("utf-8")).hexdigest()
        if self.content and not self.body_hash:
            self.body_hash = hashlib.sha256(self.content.encode("utf-8")).hexdigest()
        if not self.delivery_request_id and self.source_tool_call_id:
            # Tool call ids are the smallest durable request boundary available
            # for runtime evidence; provider request ids are intentionally not
            # copied into model-facing provenance.
            self.delivery_request_id = self.source_tool_call_id
        if not self.evidence_id:
            identity = "|".join(
                (
                    self.artifact_id,
                    self.path,
                    str(self.start_line),
                    str(self.end_line),
                    self.side,
                    self.content_hash,
                    self.source_type,
                    self.snapshot_id,
                    self.revision,
                )
            )
            self.evidence_id = "ev_" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
        if self.artifact_id and self.artifact_id != self.evidence_id:
            self.aliases = sorted(set(self.aliases) | {self.artifact_id})
        displayed_lines: set[int] = set()
        for line in self.displayed_line_numbers:
            parsed_line = _as_int(line)
            if (
                parsed_line is not None
                and self.start_line <= parsed_line <= self.end_line
            ):
                displayed_lines.add(parsed_line)
        self.displayed_line_numbers = sorted(displayed_lines)
        if (
            not self.displayed_ranges
            and not self.displayed_line_numbers
            and self.lifecycle == "delivered"
        ):
            self.displayed_ranges = [
                EvidenceRange(start_line=self.start_line, end_line=self.end_line)
            ]
        elif self.displayed_line_numbers and not self.displayed_ranges:
            self.displayed_ranges = _ranges_from_lines(self.displayed_line_numbers)
        return self

    def covers(self, start_line: int, end_line: int) -> bool:
        """Return whether the exact requested range was displayed."""

        if self.lifecycle != "delivered" or self.truncated:
            return False
        if self.displayed_line_numbers:
            return all(
                line in self.displayed_line_numbers
                for line in range(start_line, end_line + 1)
            )
        return any(
            item.start_line <= start_line and end_line <= item.end_line
            for item in self.displayed_ranges
        )


class EvidenceLedger(BaseModel):
    """Deduplicated, revisioned source evidence for one review run."""

    revision: int = Field(default=0, ge=0)
    records: list[ObservedEvidence] = Field(default_factory=list)

    def add(self, record: ObservedEvidence) -> ObservedEvidence:
        """Insert or merge an observation, preserving exact source identity."""

        for index, existing in enumerate(self.records):
            if not _same_artifact(existing, record):
                continue
            merged = existing.model_copy(
                update={
                    "lifecycle": _max_lifecycle(existing.lifecycle, record.lifecycle),
                    "displayed_ranges": _merge_ranges(
                        existing.displayed_ranges, record.displayed_ranges
                    ),
                    "aliases": sorted(
                        set(existing.aliases)
                        | set(record.aliases)
                        | {
                            record.artifact_id,
                            existing.artifact_id,
                            record.evidence_id,
                            existing.evidence_id,
                        }
                    ),
                    # A later clipped representation must not poison an
                    # already-complete representation of the same body.  A
                    # record is marked truncated only when its own cited
                    # range is incomplete.
                    "truncated": existing.truncated and record.truncated,
                    "displayed_line_numbers": sorted(
                        set(existing.displayed_line_numbers)
                        | set(record.displayed_line_numbers)
                    ),
                }
            )
            self.records[index] = merged
            self.revision += 1
            return merged
        self.records.append(record)
        self.revision += 1
        return record

    def covers(
        self,
        path: str,
        start_line: int,
        end_line: int | None = None,
        *,
        side: EvidenceSide = "new",
        artifact_id: str = "",
        snapshot_id: str = "",
        revision: str = "",
        content_hash: str = "",
        source_type: str = "",
        evidence_id: str = "",
    ) -> bool:
        """Check full coverage, never mere overlap, for a cited range."""

        normalized = normalize_repo_path(path)
        end = end_line or start_line
        for record in self.records:
            if record.path != normalized or record.side != side:
                continue
            if artifact_id and artifact_id not in {
                record.artifact_id,
                record.evidence_id,
                *record.aliases,
            }:
                continue
            if evidence_id and evidence_id not in {
                record.evidence_id,
                *record.aliases,
            }:
                continue
            if snapshot_id and record.snapshot_id != snapshot_id:
                continue
            if revision and record.revision != revision:
                continue
            if content_hash and content_hash not in {
                record.content_hash,
                record.body_hash,
            }:
                continue
            if source_type and record.source_type != source_type:
                continue
            if record.covers(start_line, end):
                return True
        return False

    def to_payload(self) -> list[dict[str, Any]]:
        """Return a stable JSON-compatible snapshot for state and event logs."""

        return [item.model_dump(mode="json") for item in self.records]


def ledger_from_sources(
    *,
    tool_evidence: list[dict[str, Any]] | None = None,
    context_manifests: list[dict[str, Any]] | None = None,
    diff_text: str = "",
    file_contents: dict[str, str] | None = None,
    existing_payload: list[dict[str, Any]] | None = None,
    snapshot_id: str = "",
    revision: str = "",
) -> EvidenceLedger:
    """Build a ledger only from bodies known to have been delivered.

    Header-only graph spans and metadata records are intentionally ignored.
    """

    ledger = EvidenceLedger(
        records=[
            ObservedEvidence.model_validate(item)
            for item in (existing_payload or [])
            if isinstance(item, dict)
        ]
    )
    for entry in tool_evidence or []:
        _add_tool_entry(
            ledger,
            entry,
            snapshot_id=snapshot_id,
            revision=revision,
        )
    for manifest in context_manifests or []:
        _add_manifest(
            ledger,
            manifest,
            snapshot_id=snapshot_id,
            revision=revision,
        )
    for path, content in (file_contents or {}).items():
        lines = content.splitlines()
        if lines:
            _add_record(
                ledger,
                path=path,
                start=1,
                end=len(lines),
                content=content,
                source_type="file_context",
                call_id="",
                truncated=False,
                scope="prompt_file",
                snapshot_id=snapshot_id,
                revision=revision,
            )
    _add_diff(ledger, diff_text, snapshot_id=snapshot_id, revision=revision)
    return ledger


def _add_diff(
    ledger: EvidenceLedger,
    diff_text: str,
    *,
    snapshot_id: str = "",
    revision: str = "",
) -> None:
    for path, hunks in parse_unified_diff_hunks(diff_text or "").items():
        for index, hunk in enumerate(hunks):
            if not hunk.lines:
                continue
            displayed_lines = _diff_new_side_lines(hunk)
            if not displayed_lines:
                continue
            expected_end = hunk.new_start + max(0, hunk.new_count - 1)
            parsed_end = max(displayed_lines)
            complete = (
                len(displayed_lines) == hunk.new_count and parsed_end == expected_end
            )
            ledger.add(
                ObservedEvidence(
                    artifact_id=f"diff:{path}:{index}:{hunk.new_start}",
                    path=path,
                    start_line=hunk.new_start,
                    end_line=max(hunk.new_start, expected_end),
                    content="\n".join([hunk.header, *hunk.lines]),
                    source_type="git_diff",
                    scope="prompt_diff",
                    displayed_line_numbers=displayed_lines,
                    truncated=not complete,
                    snapshot_id=snapshot_id,
                    revision=revision,
                )
            )


def _add_manifest(
    ledger: EvidenceLedger,
    manifest: dict[str, Any],
    *,
    snapshot_id: str = "",
    revision: str = "",
) -> None:
    manifest_id = str(manifest.get("candidate_id", "")).strip()
    for span in manifest.get("included_spans", []):
        if not isinstance(span, dict):
            continue
        content = str(span.get("content", "") or "")
        if not content:
            continue
        start = _as_int(span.get("start_line", span.get("line")))
        end = _as_int(span.get("end_line", span.get("line"))) or start
        path = normalize_repo_path(str(span.get("file", span.get("path", ""))))
        if not path or start is None or end is None:
            continue
        ledger.add(
            ObservedEvidence(
                artifact_id=str(span.get("span_id") or f"{manifest_id}:{path}:{start}"),
                path=path,
                start_line=start,
                end_line=end,
                content=content,
                content_hash=str(span.get("context_hash", "")),
                source_type=str(span.get("retrieval_source", "graph")),
                lifecycle=cast(
                    EvidenceLifecycle, str(span.get("lifecycle", "delivered"))
                ),
                scope="context_manifest",
                aliases=[manifest_id] if manifest_id else [],
                snapshot_id=str(
                    span.get(
                        "snapshot_id",
                        manifest.get("snapshot_id", snapshot_id),
                    )
                ),
                revision=str(span.get("revision", manifest.get("revision", revision))),
                displayed_line_numbers=_content_line_numbers(content, start, end),
                truncated=bool(span.get("truncated", False)),
                side=cast(
                    EvidenceSide,
                    str(span.get("side", manifest.get("side", "new")) or "new"),
                ),
                delivery_request_id=str(
                    span.get(
                        "delivery_request_id",
                        manifest.get("delivery_request_id", ""),
                    )
                ),
            )
        )


def _add_tool_entry(
    ledger: EvidenceLedger,
    entry: dict[str, Any],
    *,
    snapshot_id: str = "",
    revision: str = "",
) -> None:
    tool_name = str(entry.get("tool_name", "")).strip().lower()
    data = entry.get("data")
    if not isinstance(data, dict) or not bool(data.get("ok", True)):
        return
    call_id = str(entry.get("tool_call_id", "")).strip()
    if tool_name == "grep_files":
        for match in data.get("matches", []):
            if not isinstance(match, dict):
                continue
            _add_record(
                ledger,
                path=match.get("file_path"),
                start=match.get("line_number"),
                end=match.get("line_number"),
                content=str(match.get("line_text", "")),
                source_type="grep_files",
                call_id=call_id,
                # ``data.truncated`` describes omitted matches, not the
                # complete line body returned in this individual match.
                truncated=bool(
                    match.get("truncated")
                    or match.get("line_truncated")
                    or match.get("line_text_truncated")
                ),
                scope="match",
                snapshot_id=snapshot_id,
                revision=revision,
            )
        return
    if tool_name == "read_file":
        start_line = _as_int(data.get("start_line"))
        line_count = _as_int(data.get("line_count")) or 1
        content = str(data.get("content", ""))
        displayed_lines = _content_line_numbers(
            content,
            start_line or 1,
            (start_line or 1) + max(0, line_count) - 1,
        )
        expected = max(0, line_count)
        body_complete = bool(displayed_lines) and len(displayed_lines) >= expected
        _add_record(
            ledger,
            path=data.get("file_path"),
            start=start_line,
            end=start_line + max(0, line_count) - 1 if start_line is not None else None,
            content=content,
            source_type=tool_name,
            call_id=call_id,
            truncated=not body_complete,
            scope="file_read",
            displayed_line_numbers=displayed_lines,
            snapshot_id=snapshot_id,
            revision=revision,
        )
        return
    if tool_name in {"get_changed_context", "changed_context"}:
        window = data.get("file_window")
        if isinstance(window, dict):
            content = str(window.get("content", ""))
            start = _as_int(window.get("start_line"))
            end = _as_int(window.get("end_line"))
            displayed_lines = _content_line_numbers(content, start, end)
            expected = (end - start + 1) if start is not None and end is not None else 0
            _add_record(
                ledger,
                path=data.get("file_path"),
                start=window.get("start_line"),
                end=window.get("end_line"),
                content=content,
                source_type="get_changed_context",
                call_id=call_id,
                truncated=not displayed_lines or len(displayed_lines) < expected,
                scope="file_window",
                displayed_line_numbers=displayed_lines,
                snapshot_id=snapshot_id,
                revision=revision,
            )
        return
    if tool_name in {"find_symbol_context", "symbol_context"}:
        for key in ("definitions", "references", "enclosing_symbols"):
            for item in data.get(key, []):
                if not isinstance(item, dict):
                    continue
                start = item.get("line", item.get("start_line"))
                end = item.get("end_line", start)
                content = str(
                    item.get("content", item.get("context", item.get("line_text", "")))
                    or ""
                )
                start_int = _as_int(start)
                end_int = _as_int(end) or start_int
                displayed_lines = _content_line_numbers(content, start_int, end_int)
                expected = (
                    end_int - start_int + 1
                    if start_int is not None and end_int is not None
                    else 0
                )
                _add_record(
                    ledger,
                    path=item.get("path", item.get("file")),
                    start=start,
                    end=end,
                    content=content,
                    source_type="find_symbol_context",
                    call_id=call_id,
                    truncated=not displayed_lines or len(displayed_lines) < expected,
                    scope=key,
                    displayed_line_numbers=displayed_lines,
                    snapshot_id=snapshot_id,
                    revision=revision,
                )


def _add_record(
    ledger: EvidenceLedger,
    *,
    path: Any,
    start: Any,
    end: Any,
    content: str,
    source_type: str,
    call_id: str,
    truncated: bool,
    scope: str,
    displayed_line_numbers: list[int] | None = None,
    snapshot_id: str = "",
    revision: str = "",
    side: EvidenceSide = "new",
) -> None:
    normalized_path = normalize_repo_path(str(path or ""))
    start_line = _as_int(start)
    end_line = _as_int(end) or start_line
    if not normalized_path or start_line is None or end_line is None or not content:
        return
    artifact_id = hashlib.sha256(
        f"{source_type}:{normalized_path}:{start_line}:{end_line}:{content}".encode(
            "utf-8"
        )
    ).hexdigest()[:24]
    ledger.add(
        ObservedEvidence(
            artifact_id=artifact_id,
            path=normalized_path,
            start_line=start_line,
            end_line=end_line,
            content=content,
            source_type=source_type,
            source_tool_call_id=call_id,
            snapshot_id=snapshot_id,
            revision=revision,
            side=side,
            truncated=truncated,
            scope=scope,
            displayed_line_numbers=displayed_line_numbers or [],
        )
    )


def _same_artifact(left: ObservedEvidence, right: ObservedEvidence) -> bool:
    return (
        left.path == right.path
        and left.side == right.side
        and left.start_line == right.start_line
        and left.end_line == right.end_line
        and left.content_hash == right.content_hash
        and left.source_type == right.source_type
        and left.snapshot_id == right.snapshot_id
        and left.revision == right.revision
    )


def _merge_ranges(
    left: list[EvidenceRange], right: list[EvidenceRange]
) -> list[EvidenceRange]:
    ranges = sorted([*left, *right], key=lambda item: (item.start_line, item.end_line))
    merged: list[EvidenceRange] = []
    for item in ranges:
        if merged and item.start_line <= merged[-1].end_line + 1:
            merged[-1] = EvidenceRange(
                start_line=merged[-1].start_line,
                end_line=max(merged[-1].end_line, item.end_line),
            )
        else:
            merged.append(item)
    return merged


def _max_lifecycle(
    left: EvidenceLifecycle, right: EvidenceLifecycle
) -> EvidenceLifecycle:
    order = {"indexed": 0, "selected": 1, "delivered": 2}
    return left if order[left] >= order[right] else right


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _content_line_numbers(
    content: str,
    start_line: int | None,
    end_line: int | None,
) -> list[int]:
    """Infer only line numbers whose body is present in a returned payload."""

    if not content or start_line is None:
        return []
    finish = end_line or start_line
    lines = content.splitlines()
    if not lines:
        return []
    explicit: list[int] = []
    for raw in lines:
        prefix = raw.split(":", 1)[0].strip()
        if prefix.isdigit():
            number = int(prefix)
            if start_line <= number <= finish:
                explicit.append(number)
    if explicit:
        return sorted(set(explicit))
    count = min(len(lines), finish - start_line + 1)
    return list(range(start_line, start_line + count))


def _diff_new_side_lines(hunk: Any) -> list[int]:
    """Map the body lines of one complete-or-partial hunk to new-side lines."""

    current = int(hunk.new_start)
    displayed: list[int] = []
    for line in hunk.lines:
        if line.startswith("\\"):
            continue
        if line.startswith("-") and not line.startswith("---"):
            continue
        if current > 0:
            displayed.append(current)
        current += 1
    return displayed


def _ranges_from_lines(lines: list[int]) -> list[EvidenceRange]:
    if not lines:
        return []
    ranges: list[EvidenceRange] = []
    start = previous = lines[0]
    for line in lines[1:]:
        if line == previous + 1:
            previous = line
            continue
        ranges.append(EvidenceRange(start_line=start, end_line=previous))
        start = previous = line
    ranges.append(EvidenceRange(start_line=start, end_line=previous))
    return ranges
