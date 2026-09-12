"""Metric computation for evaluation results."""

from __future__ import annotations

from pathlib import Path

from eval.schemas import (
    EVAL_MATCHER_VERSIONS,
    EvalReport,
    EvalResult,
    MetricSummary,
    SampledFixtureResult,
    validate_eval_matcher_contract,
)


def build_metric_summary(
    results: list[EvalResult],
    *,
    sampled_results: list[SampledFixtureResult] | None = None,
) -> MetricSummary:
    """Compute all required metrics from per-fixture results."""
    if sampled_results:
        return MetricSummary.from_sampled_results(sampled_results)
    return MetricSummary.from_results(results)


def build_eval_report(
    suite: str,
    results: list[EvalResult],
    *,
    sampled_results: list[SampledFixtureResult] | None = None,
) -> EvalReport:
    """Build suite-level report with aggregated metrics."""
    sampled = sampled_results or []
    metrics = build_metric_summary(results, sampled_results=sampled)
    sampled_runs = [run for item in sampled for run in item.runs]
    versions = {
        item.matcher_version
        for item in results
    } | {item.matcher_version for item in sampled} | {
        item.matcher_version for item in sampled_runs
    }
    if len(versions) > 1:
        raise ValueError(
            "Cannot build an evaluation report from mixed matcher versions: "
            f"{sorted(versions)}"
        )
    matcher_version = next(iter(versions), "unknown")
    recognized_contracts = {"1.0", "2.0", "3.0"}
    contract_values = [
        item.finding_contract_version
        for item in results
    ] + [
        item.finding_contract_version for item in sampled
    ] + [item.finding_contract_version for item in sampled_runs]
    contracts = {
        str(value).strip()
        for value in contract_values
        if str(value).strip() in recognized_contracts
    }
    unspecified_contracts = {
        str(value).strip() or "unknown"
        for value in contract_values
        if str(value).strip() not in recognized_contracts
    }
    if len(contracts) > 1:
        raise ValueError(
            "Cannot build an evaluation report from mixed finding contract versions: "
            f"{sorted(contracts)}"
        )
    if contracts and unspecified_contracts:
        raise ValueError(
            "Cannot build an evaluation report with unspecified and explicit "
            "finding contract versions together: "
            f"{sorted(unspecified_contracts)}"
        )
    contract_version = next(iter(contracts), "unknown")
    if matcher_version != "unknown" and contract_version != "unknown":
        if matcher_version not in EVAL_MATCHER_VERSIONS:
            raise ValueError(
                f"Unsupported matcher version in eval report: {matcher_version!r}"
            )
        validate_eval_matcher_contract(matcher_version, contract_version)
    return EvalReport(
        suite=suite,
        fixture_count=len(results),
        matcher_version=matcher_version,
        finding_contract_version=contract_version,
        metrics=metrics,
        results=results,
        sampled_results=sampled,
    )


def write_human_review_template(
    report: EvalReport,
    output_path: str | Path,
) -> Path:
    """Generate human acceptability scoring template."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Human Acceptability Review Sheet",
        "",
        "请为每条样本填写 score(0-5) 与 comment。",
        "",
        "| fixture_id | schema_valid | placeholder | budget_state | matched/expected | false_positive | pass@k | mean_hit | stddev | score(0-5) | comment |",
        "|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    sampled_by_fixture = {item.fixture_id: item for item in report.sampled_results}
    for item in report.results:
        ratio = f"{item.matched_count}/{item.expected_count}"
        sampled = sampled_by_fixture.get(item.fixture_id)
        pass_at_k = f"{sampled.pass_at_k_hit_rate:.2%}" if sampled else "-"
        mean_hit = f"{sampled.mean_hit_rate:.2%}" if sampled else "-"
        stddev = f"{sampled.hit_rate_stddev:.2%}" if sampled else "-"
        lines.append(
            "| "
            f"{item.fixture_id} | {item.schema_valid} | "
            f"{item.placeholder_summary} | {item.budget_state} | {ratio} | "
            f"{item.false_positive_count} | {pass_at_k} | {mean_hit} | {stddev} |  |  |"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path

