"""Minimal in-memory working state for durable draft findings."""

from __future__ import annotations

import re
from uuid import uuid4

from src.models.schemas import (
    DraftFinding,
    DraftFindingInput,
    DraftFindingState,
    DraftFindingStatus,
    DraftFindingUpdateInput,
)

_VISIBLE_DRAFT_PATTERN = re.compile(
    r"(?im)^[ \t]*(?:[-*]\s*)?(?:finding\s*:\s*)?"
    r"`?(?P<file>(?:[a-z0-9_.-]+/)+[a-z0-9_.-]+\.[a-z0-9]+)"
    r"(?::(?P<line>\d+))?`?\s*(?:[-:\u2013\u2014]\s+)"
    r"(?P<claim>[^\r\n]{20,600})$"
)
_VISIBLE_CLAIM_SIGNAL = re.compile(
    r"\b(?:bug|regression|incorrect|wrong|fail(?:s|ure)?|break(?:s|ing)?|"
    r"may|can|does\s+not|instead|data\s+loss|exception|truncat(?:e|es|ed|ion)|"
    r"compar(?:e|es|ed|ison))\b",
    re.IGNORECASE,
)
_VISIBLE_REPOSITORY_PATH = re.compile(
    r"`?(?P<file>(?:[a-z0-9_.-]+/)*[a-z0-9_.-]+\.(?:py|pyi|js|jsx|ts|tsx|"
    r"java|go|rs|rb|php|cs|cpp|cc|c|h|hpp|swift|kt|kts|scala|sh|ps1|sql))"
    r"(?::(?P<line>\d+))?`?",
    re.IGNORECASE,
)
_VISIBLE_SYMBOL_CLAIM = re.compile(
    r"(?is)(?P<symbol>[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\s+"
    r"(?P<claim>(?:compares?|routes?|drops?|writes?|returns?|raises?|fails?|"
    r"breaks?|changes?|may\b|can\b|does\s+not\b)[^.\r\n]{20,600}[.])"
)


class DraftFindingStore:
    """Keep runtime-bound draft hypotheses for the current process and run."""

    def __init__(self) -> None:
        self._items: dict[str, DraftFinding] = {}
        self._states: dict[str, DraftFindingState] = {}

    @staticmethod
    def bind(
        draft_input: DraftFindingInput,
        *,
        source_response_id: str,
    ) -> DraftFinding:
        """Bind trusted provenance without mutating in-memory state."""

        return DraftFinding(
            id=f"df_{uuid4().hex[:16]}",
            source_response_id=source_response_id,
            file=draft_input.file,
            line=draft_input.line,
            symbol=draft_input.symbol,
            claim=draft_input.claim,
        )

    def add(self, draft: DraftFinding) -> None:
        """Add a previously runtime-bound draft, replacing only the same id."""

        self._items[draft.id] = draft
        self._states.setdefault(
            draft.id,
            DraftFindingState(draft_id=draft.id),
        )

    def add_if_new(self, draft: DraftFinding) -> tuple[DraftFinding, bool]:
        """Add a bound draft unless the same hypothesis already exists.

        Duplicate state actions are observable through ``repeat_count`` but do
        not create a second runtime identity or a second journal finding.
        """

        duplicate = self.find_duplicate(draft)
        if duplicate is not None:
            state = self._states[duplicate.id]
            self._states[duplicate.id] = state.model_copy(
                update={"repeat_count": state.repeat_count + 1}
            )
            return duplicate, False
        self.add(draft)
        return draft, True

    def find_duplicate(self, draft: DraftFinding) -> DraftFinding | None:
        """Find an exact normalized hypothesis already in this run."""

        fingerprint = self.fingerprint(draft)
        return next(
            (item for item in self._items.values() if self.fingerprint(item) == fingerprint),
            None,
        )

    @staticmethod
    def fingerprint(draft: DraftFinding | DraftFindingInput) -> tuple[object, ...]:
        """Return the stable identity used for duplicate draft detection."""

        return (
            draft.file.replace("\\", "/").lstrip("./").strip().lower(),
            draft.line,
            (draft.symbol or "").strip().lower(),
            " ".join(draft.claim.split()).strip().lower(),
        )

    def all(self) -> list[DraftFinding]:
        """Return drafts in creation order."""

        return list(self._items.values())

    def get(self, draft_id: str) -> DraftFinding | None:
        """Return one draft by id."""

        return self._items.get(draft_id)

    def get_state(self, draft_id: str) -> DraftFindingState | None:
        """Return the explicit investigation state for one draft."""

        return self._states.get(draft_id)

    def states(self) -> list[DraftFindingState]:
        """Return checkpoint states in draft creation order."""

        return [self._states[item.id] for item in self._items.values()]

    def update(
        self,
        update: DraftFindingUpdateInput,
        *,
        iteration: int = 0,
    ) -> tuple[DraftFindingState, bool] | None:
        """Apply one model-requested state transition, if its id is trusted."""

        current = self._states.get(update.draft_id)
        if current is None:
            return None
        changed = any(
            (
                current.status != update.status,
                current.reason != update.reason,
                current.missing_checks != update.missing_checks,
                current.evidence_refs != update.evidence_refs,
            )
        )
        next_state = DraftFindingState(
            draft_id=current.draft_id,
            status=update.status,
            reason=update.reason,
            missing_checks=list(update.missing_checks),
            evidence_refs=list(update.evidence_refs),
            updated_iteration=max(0, iteration),
            repeat_count=current.repeat_count + (0 if changed else 1),
        )
        self._states[update.draft_id] = next_state
        return next_state, changed

    def has_pending(self) -> bool:
        """Return whether any hypothesis still needs investigation."""

        return any(state.status == "pending" for state in self._states.values())

    def has_incomplete(self) -> bool:
        """Return whether a hypothesis was explicitly left incomplete."""

        return any(state.status == "incomplete" for state in self._states.values())

    def has_evidence_sufficient(self) -> bool:
        """Return whether at least one hypothesis is ready for final submission."""

        return any(
            state.status == "evidence_sufficient" for state in self._states.values()
        )

    def status_counts(self) -> dict[DraftFindingStatus, int]:
        """Summarize checkpoint states for telemetry and final context."""

        counts: dict[DraftFindingStatus, int] = {
            "pending": 0,
            "evidence_sufficient": 0,
            "disproved": 0,
            "incomplete": 0,
        }
        for state in self._states.values():
            counts[state.status] += 1
        return counts

    def __len__(self) -> int:
        return len(self._items)


def extract_visible_draft_finding(content: str) -> DraftFindingInput | None:
    """Conservatively extract one minimal draft from visible truncated content."""

    if not content.strip():
        return None
    for match in _VISIBLE_DRAFT_PATTERN.finditer(content):
        claim = " ".join(match.group("claim").split()).strip()
        if not _VISIBLE_CLAIM_SIGNAL.search(claim):
            continue
        raw_line = match.group("line")
        return DraftFindingInput(
            file=match.group("file"),
            line=int(raw_line) if raw_line else None,
            claim=claim,
        )
    for match in _VISIBLE_SYMBOL_CLAIM.finditer(content):
        preceding_paths = list(
            _VISIBLE_REPOSITORY_PATH.finditer(content, 0, match.start())
        )
        if not preceding_paths:
            continue
        path_match = preceding_paths[-1]
        if match.start() - path_match.end() > 800:
            continue
        claim = " ".join(match.group("claim").split()).strip()
        if not _VISIBLE_CLAIM_SIGNAL.search(claim):
            continue
        raw_line = path_match.group("line")
        return DraftFindingInput(
            file=path_match.group("file"),
            line=int(raw_line) if raw_line else None,
            symbol=match.group("symbol"),
            claim=claim,
        )
    return None
