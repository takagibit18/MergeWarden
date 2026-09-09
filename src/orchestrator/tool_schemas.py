"""Orchestrator-owned conversion from ToolSpec to model tool schemas."""

from __future__ import annotations

from typing import Any

from src.analyzer.finding_contract import (
    ModelFindingInput,
    ModelRepairIssueInput,
    ModelRepairResponse,
)
from src.models.schemas import DraftFindingInput, DraftFindingUpdateInput
from src.tools.base import ToolSpec


def build_tool_schemas(specs: list[ToolSpec]) -> list[dict[str, Any]]:
    """Convert ToolSpec objects to OpenAI function-calling schema."""
    schemas: list[dict[str, Any]] = []
    for spec in specs:
        schemas.append(
            {
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": _llm_facing_schema(
                        spec.parameters or {"type": "object", "properties": {}}
                    ),
                },
            }
        )
    return schemas


def _llm_facing_schema(value: Any) -> Any:
    """Drop generated metadata that does not affect the callable contract."""

    if isinstance(value, list):
        return [_llm_facing_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        if key == "title":
            continue
        if key == "default" and (item is None or item == "" or item == []):
            continue
        cleaned[key] = _llm_facing_schema(item)
    return cleaned


def build_draft_finding_tool_schema() -> dict[str, Any]:
    """Return the review-only pseudo-tool for a minimal durable hypothesis."""

    parameters = _llm_facing_schema(
        _inline_json_schema_refs(DraftFindingInput.model_json_schema())
    )
    return {
        "type": "function",
        "function": {
            "name": "record_draft_finding",
            "description": (
                "Durably record a minimal review hypothesis as soon as it becomes "
                "concrete. This is working state, not a final finding; continue "
                "gathering evidence and eventually call submit_review."
            ),
            "parameters": parameters,
        },
    }


def build_draft_finding_update_tool_schema() -> dict[str, Any]:
    """Return the review-only pseudo-tool for a draft state transition."""

    parameters = _llm_facing_schema(
        _inline_json_schema_refs(DraftFindingUpdateInput.model_json_schema())
    )
    return {
        "type": "function",
        "function": {
            "name": "update_draft_finding",
            "description": (
                "Update the investigation state of an existing draft hypothesis. "
                "Use pending while checks remain, evidence_sufficient when it can "
                "support a final finding, disproved when evidence rules it out, or "
                "incomplete when the run cannot finish the checks."
            ),
            "parameters": parameters,
        },
    }


def build_submit_tool_schemas(
    *, model_input: bool = False, repair: bool = False
) -> list[dict[str, Any]]:
    """Pseudo-tools used for structured final output submission.

    ``model_input=True`` is the current semantic contract.  The default keeps
    the historical full envelope available to old callers and replay fixtures.
    """

    if model_input:
        return _build_model_submit_tool_schemas(repair=repair)
    return _build_legacy_submit_tool_schemas()


def build_model_submit_tool_schemas(*, repair: bool = False) -> list[dict[str, Any]]:
    """Return the current semantic model-input submit contract."""

    return build_submit_tool_schemas(model_input=True, repair=repair)


def build_repair_tool_schemas() -> list[dict[str, Any]]:
    """Return the dedicated patch-only repair interface.

    This is intentionally a different tool from ``submit_review``.  Keeping
    the wire envelopes separate prevents a repair call from being interpreted
    as a fresh finding report or being format-recovered into one.
    """

    response_schema = _llm_facing_schema(
        _inline_json_schema_refs(ModelRepairResponse.model_json_schema())
    )
    return [
        {
            "type": "function",
            "function": {
                "name": "repair_review",
                "description": (
                    "Repair only the exact opaque targets listed in the active "
                    "runtime transaction. Return one item per target you address. "
                    "This is not a new finding submission: do not include summary, "
                    "issues, finding ids, candidate ids, content versions, paths, "
                    "snapshots, hashes, or full finding objects. For repaired, put "
                    "only changed semantic fields in repair_patch; omitted fields "
                    "are preserved. Use delete_fields for explicit deletion and "
                    "never use null to mean omission."
                ),
                "parameters": response_schema,
            },
        }
    ]


def _build_model_submit_tool_schemas(*, repair: bool = False) -> list[dict[str, Any]]:
    model_input_type = ModelRepairIssueInput if repair else ModelFindingInput
    model_issue_schema = _llm_facing_schema(
        _inline_json_schema_refs(model_input_type.model_json_schema())
    )
    model_issue_properties = model_issue_schema.get("properties")
    if isinstance(model_issue_properties, dict) and not repair:
        # Candidate identity belongs to the runtime on the initial submit path.
        # Keeping these fields out of the wire schema prevents the model from
        # accidentally turning a first submission into an implicit repair.
        model_issue_properties.pop("target_candidate_id", None)
        model_issue_properties.pop("repair_status", None)
        model_issue_properties.pop("candidate_content_version", None)
        model_issue_properties.pop("repair_reason", None)
        model_issue_properties.pop("repair_patch", None)
        model_issue_properties.pop("finding_id", None)
    if repair:
        required = model_issue_schema.setdefault("required", [])
        for field in (
            "target_candidate_id",
            "repair_status",
            "candidate_content_version",
        ):
            if field not in required:
                required.append(field)
    # Initial findings retain the conditional structured-risk requirements.
    # Repair findings are intentionally patch-only: adding full finding fields
    # here would make omission/inheritance ambiguous and would let the model
    # replace runtime-owned content accidentally.
    if not repair:
        risk_condition: dict[str, Any] = {
            "properties": {
                "severity": {"enum": ["critical", "warning"]}
            }
        }
        model_issue_schema.setdefault("allOf", []).append(
            {
                "if": risk_condition,
                "then": {
                    "required": [
                        "primary_anchor",
                        "evidence",
                        "suggestion",
                        "confidence",
                        "observed_behavior",
                        "causal_mechanism",
                        "violated_invariant",
                        "repair_intent",
                        "trigger",
                        "impact",
                        "supports",
                    ]
                },
            }
        )
    return [
        {
            "type": "function",
            "function": {
                "name": "submit_review",
                "description": (
                    "Submit semantic review findings. Provide one primary_anchor "
                    "and choose exact evidence_refs from the delivered evidence "
                    "catalog. "
                    + (
                        "This is an atomic repair transaction: every issue must set "
                        "target_candidate_id to one exact runtime candidate_id, "
                        "candidate_content_version copied exactly from the feedback, "
                        "and repair_status to repaired, unchanged, incomplete, or "
                        "deferred. For repaired, prefer repair_patch with only the "
                        "semantic fields that changed. Unchanged, incomplete, and "
                        "deferred may return only identity, status, and repair_reason. "
                        if repair
                        else "Do not provide runtime candidate identity or repair status. "
                    )
                    + "Runtime identity, location, snapshot, revision, and hash "
                    "fields are generated and validated by the program."
                ),
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": (
                                "High-level result. Do not mention an actionable "
                                "concern in the summary unless it is in issues."
                            ),
                        },
                        "issues": {
                            "type": "array",
                            "description": (
                                "Semantic findings. Use [] only when no supported "
                                "issue remains, including after disproving drafts."
                            ),
                            "items": model_issue_schema,
                        },
                    },
                    "required": ["summary", "issues"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "submit_debug",
                "description": "Submit structured debug output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "hypotheses": {"type": "array", "items": {"type": "string"}},
                        "steps": {"type": "array", "items": {"type": "object"}},
                        "suggested_commands": {"type": "array"},
                        "suggested_patch": {"type": ["string", "null"]},
                    },
                    "required": ["summary"],
                },
            },
        },
    ]


def _inline_json_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Inline Pydantic local refs so providers receive one self-contained schema."""

    definitions = schema.get("$defs", {})

    def resolve(value: Any) -> Any:
        if isinstance(value, list):
            return [resolve(item) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/$defs/"):
            name = reference.rsplit("/", 1)[-1]
            base = resolve(definitions.get(name, {}))
            overlays = {
                key: resolve(item) for key, item in value.items() if key != "$ref"
            }
            if isinstance(base, dict):
                return {**base, **overlays}
            return base
        return {
            key: resolve(item) for key, item in value.items() if key != "$defs"
        }

    resolved = resolve(schema)
    if not isinstance(resolved, dict):
        raise TypeError("Inline JSON schema must resolve to an object")
    return resolved


def _build_legacy_submit_tool_schemas() -> list[dict[str, Any]]:
    """Historical full submit schemas retained for compatibility tests/replay."""
    anchor_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "file": {"type": "string"},
            "line": {"type": "integer", "minimum": 1},
            "end_line": {"type": "integer", "minimum": 1},
            "symbol_id": {"type": "string"},
        },
        "required": ["file", "line", "symbol_id"],
    }
    evidence_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "candidate_id": {
                "type": "string",
                "description": "Optional legacy input; the runtime overwrites candidate identity.",
            },
            "context_manifest_id": {
                "type": "string",
                "description": "Optional legacy input; explicit values must match runtime context.",
            },
            "retrieval_source": {
                "type": "string",
                "description": "Optional legacy hint; the runtime selects the trusted source.",
            },
            "file": {"type": "string", "minLength": 1},
            "line": {"type": "integer", "minimum": 1},
            "end_line": {"type": "integer", "minimum": 1},
            "symbol_id": {"type": "string", "minLength": 1},
            "context_hash": {
                "type": "string",
                "description": "Optional legacy input; the runtime binds the canonical hash.",
            },
            "edge_kind": {"type": "string"},
            "edge_confidence": {
                "type": "number",
                "minimum": 0.0,
                "maximum": 1.0,
            },
            "resolver": {"type": "string", "minLength": 1},
            "evidence_eligibility": {
                "type": "string",
                "enum": ["strong", "exploratory", "none"],
            },
            "statement": {"type": "string", "minLength": 1},
        },
        "required": [
            "file",
            "line",
            "statement",
        ],
    }
    return [
        {
            "type": "function",
            "function": {
                "name": "submit_review",
                "description": "Submit structured review output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": (
                                "High-level result. The summary must not mention bugs, "
                                "regressions, breaking changes, compatibility risks, or "
                                "user-visible behavior changes unless the same finding is "
                                "present in issues."
                            ),
                        },
                        "issues": {
                            "type": "array",
                            "description": (
                                "Structured findings. Use [] only when there are no "
                                "supported bugs, regressions, breaking changes, "
                                "compatibility risks, or actionable review findings."
                            ),
                            "items": {
                                "type": "object",
                                "properties": {
                                    "severity": {
                                        "type": "string",
                                        "enum": [
                                            "critical",
                                            "warning",
                                            "info",
                                            "style",
                                        ],
                                    },
                                    "location": {
                                        "type": "string",
                                        "description": (
                                            "Canonical display location: "
                                            "path[:line[-end_line]]. It may be unchanged; "
                                            "the finding must still include a changed-code "
                                            "anchor; supporting evidence may be unchanged."
                                        ),
                                        "pattern": r"^[^:\s][^:]*(:\d+(-\d+)?)?$",
                                    },
                                    "evidence": {"type": "string"},
                                    "suggestion": {"type": "string"},
                                    "confidence": {
                                        "type": "number",
                                        "description": (
                                            "Use >= 0.85 for concrete changed-code bugs, "
                                            "regressions, compatibility breaks, or user-visible "
                                            "behavior changes; use lower values for speculative "
                                            "or non-blocking concerns."
                                        ),
                                    },
                                    "schema_version": {
                                        "type": "string",
                                        "enum": ["2.0"],
                                    },
                                    "finding_id": {
                                        "type": "string",
                                        "description": "Reviewer-local id such as F-01. Do not emit root_cause_id.",
                                    },
                                    "primary_anchor": {
                                        **anchor_schema,
                                        "description": (
                                            "Primary display anchor matching location; it need "
                                            "not be changed when another finding anchor proves "
                                            "PR association."
                                        ),
                                    },
                                    "related_locations": {
                                        "type": "array",
                                        "items": {
                                            **anchor_schema,
                                            "properties": {
                                                **anchor_schema["properties"],
                                                "role": {
                                                    "type": "string",
                                                    "enum": [
                                                        "cause",
                                                        "contract",
                                                        "trigger",
                                                        "impact",
                                                        "related",
                                                    ],
                                                },
                                                "description": {"type": "string"},
                                            },
                                        },
                                    },
                                    "observed_behavior": {"type": "string"},
                                    "causal_mechanism": {"type": "string"},
                                    "violated_invariant": {"type": "string"},
                                    "repair_intent": {
                                        "type": "object",
                                        "properties": {
                                            "action": {"type": "string"},
                                            "targets": {
                                                "type": "array",
                                                "items": {"type": "string"},
                                            },
                                            "boundary": {"type": "string"},
                                        },
                                        "required": ["action", "targets", "boundary"],
                                    },
                                    "trigger": {"type": "string"},
                                    "impact": {"type": "string"},
                                    "supports": {
                                        "type": "array",
                                        "description": (
                                            "Canonical role envelopes. Each support must "
                                            "reference evidence declared in the matching "
                                            "role-specific evidence array."
                                        ),
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "role": {
                                                    "type": "string",
                                                    "enum": [
                                                        "cause",
                                                        "contract",
                                                        "trigger",
                                                        "impact",
                                                        "related",
                                                    ],
                                                },
                                                "statement": {
                                                    "type": "string",
                                                    "minLength": 1,
                                                },
                                                "evidence_refs": {
                                                    "type": "array",
                                                    "items": {"type": "string", "minLength": 1},
                                                    "minItems": 1,
                                                },
                                            },
                                            "required": [
                                                "role",
                                                "statement",
                                                "evidence_refs",
                                            ],
                                            "additionalProperties": False,
                                        },
                                    },
                                    "cause_evidence": {
                                        "type": "array",
                                        "items": evidence_schema,
                                        "description": (
                                            "Causal evidence. It may cite unchanged supporting "
                                            "code when that code was actually observed."
                                        ),
                                    },
                                    "contract_evidence": {
                                        "type": "array",
                                        "items": evidence_schema,
                                    },
                                    "trigger_evidence": {
                                        "type": "array",
                                        "items": evidence_schema,
                                    },
                                    "impact_evidence": {
                                        "type": "array",
                                        "items": evidence_schema,
                                    },
                                    "context_manifest_id": {"type": "string"},
                                    "context_hash": {"type": "string"},
                                },
                                "required": [
                                    "severity",
                                    "location",
                                    "evidence",
                                    "suggestion",
                                    "confidence",
                                    "schema_version",
                                    "finding_id",
                                    "primary_anchor",
                                    "related_locations",
                                    "observed_behavior",
                                    "causal_mechanism",
                                    "violated_invariant",
                                    "repair_intent",
                                    "trigger",
                                    "impact",
                                    "cause_evidence",
                                    "contract_evidence",
                                    "trigger_evidence",
                                    "impact_evidence",
                                    "supports",
                                ],
                            },
                        },
                    },
                    "required": ["summary", "issues"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "submit_debug",
                "description": "Submit structured debug output.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "hypotheses": {"type": "array", "items": {"type": "string"}},
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "title": {"type": "string"},
                                    "detail": {"type": "string"},
                                    "location": {
                                        "type": "string",
                                        "description": "Canonical location: path[:line[-end_line]]",
                                        "pattern": r"^[^:\s][^:]*(:\d+(-\d+)?)?$",
                                    },
                                    "evidence": {"type": "string"},
                                    "confidence": {"type": "number"},
                                },
                                "required": ["title", "detail"],
                            },
                        },
                        "suggested_commands": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "command": {"type": "string"},
                                    "rationale": {"type": "string"},
                                    "risk": {"type": "string"},
                                },
                                "required": ["command", "rationale"],
                            },
                        },
                        "suggested_patch": {"type": "string"},
                    },
                    "required": ["summary", "hypotheses", "steps"],
                },
            },
        },
    ]
