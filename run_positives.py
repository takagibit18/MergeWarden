"""Run 2 positive + 1 negative golden fixtures with diff-first prefetch enabled."""
import asyncio
import os
import sys

# Must be set before any project imports that read config.
os.environ["REVIEW_DIFF_FIRST_CHANGED_FILES"] = "true"

from eval.runner import load_fixtures, run_suite
from eval.metrics import build_eval_report
from eval.report import render_report, save_report_json

TARGET_IDS = {
    "golden_pytest-dev_pytest_pr8513",           # positive: 1 expected warning (Decimal/float)
    "golden_pytest-dev_pytest_pr9350",           # positive: 1 expected warning (SafeHashWrapper)
}


async def main():
    all_fixtures = load_fixtures(suite="golden", reviewed_only=True)
    fixtures = [f for f in all_fixtures if f.id in TARGET_IDS]
    if not fixtures:
        print("No matching fixtures found!", file=sys.stderr)
        return

    fixture_ids = [f.id for f in fixtures]
    pos_ids = [fid for fid in fixture_ids if "ruff" not in fid.lower()]
    neg_ids = [fid for fid in fixture_ids if "ruff" in fid.lower()]
    print(f"Positive samples ({len(pos_ids)}): {pos_ids}")
    print(f"Negative samples ({len(neg_ids)}): {neg_ids}")
    print(f"REVIEW_DIFF_FIRST_CHANGED_FILES={os.environ['REVIEW_DIFF_FIRST_CHANGED_FILES']}")
    print(f"MODEL_NAME={os.environ.get('MODEL_NAME', 'default')}")

    sampled_results = await run_suite(fixtures, samples=1, concurrency=1, temperature=0.0)
    results = [item.runs[0] for item in sampled_results if item.runs]
    report = build_eval_report(suite="golden", results=results, sampled_results=sampled_results)
    report_path = save_report_json(report, output_path="eval/outputs/golden_2p1n_report.json")
    render_report(report)
    print(f"\nReport saved to: {report_path}")


if __name__ == "__main__":
    asyncio.run(main())
