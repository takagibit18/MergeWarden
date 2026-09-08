"""Stable per-stage finding funnel shared by runtime and evaluation reports."""

from __future__ import annotations

from pydantic import BaseModel, Field


class FindingFunnel(BaseModel):
    """Counts that explain where submitted review findings leave the risk path."""

    # These counters are intentionally independent.  A candidate can be
    # submitted more than once, can fail policy before verification, or can
    # require repair without ever becoming publishable.
    logical_candidate_count: int = Field(default=0, ge=0)
    submitted_finding_count: int = Field(default=0, ge=0)
    submitted_attempt_count: int = Field(default=0, ge=0)
    provider_attempt_count: int = Field(default=0, ge=0)
    no_finding_run_count: int = Field(default=0, ge=0)
    non_risk_not_routed_count: int = Field(default=0, ge=0)
    pre_verifier_rejected_count: int = Field(default=0, ge=0)
    policy_passed_count: int = Field(default=0, ge=0)
    policy_rejected_count: int = Field(default=0, ge=0)
    risk_candidate_count: int = Field(default=0, ge=0)
    integrity_checked_count: int = Field(default=0, ge=0)
    integrity_verified_count: int = Field(default=0, ge=0)
    integrity_needs_repair_count: int = Field(default=0, ge=0)
    integrity_invalid_count: int = Field(default=0, ge=0)
    deterministic_rejected_count: int = Field(default=0, ge=0)
    repair_attempted_count: int = Field(default=0, ge=0)
    repair_succeeded_count: int = Field(default=0, ge=0)
    evidence_complete_count: int = Field(default=0, ge=0)
    evidence_validated_count: int = Field(default=0, ge=0)
    final_published_count: int = Field(default=0, ge=0)
    final_risk_finding_count: int = Field(default=0, ge=0)

    @classmethod
    def sum(cls, funnels: list["FindingFunnel"]) -> "FindingFunnel":
        """Add compatible funnel records without requiring every producer to aggregate."""

        return cls(
            **{
                field_name: sum(
                    int(getattr(funnel, field_name)) for funnel in funnels
                )
                for field_name in cls.model_fields
            }
        )
