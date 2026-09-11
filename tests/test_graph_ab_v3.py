import asyncio
from types import SimpleNamespace

import pytest

import eval.graph_ab_pilot as pilot
from eval.schemas import EvalVariant, Fixture
from src.analyzer.output_formatter import ReviewReport
from src.analyzer.schemas import ReviewResponse


@pytest.mark.parametrize("warm", [False, True])
def test_v3_lifecycle_preserves_empty_version_and_warm_priming(
    tmp_path, monkeypatch, warm
):
    monkeypatch.setenv("FINDING_CONTRACT_VERSION", "3.0")
    fixture = Fixture.model_validate(
        {
            "id": "v3-empty",
            "type": "review",
            "source": {"repo_full_name": "local/test", "pr_number": 1},
            "input": {"files": {}},
            "expected": {"issues": []},
        }
    )
    monkeypatch.setattr(
        pilot.base_runner, "_prepare_fixture_workspace", lambda *a, **k: tmp_path
    )
    monkeypatch.setattr(
        pilot.base_runner, "_validate_diff_added_lines_against_workspace", lambda *a: []
    )
    monkeypatch.setattr(
        pilot.base_runner, "_validate_expected_locations_against_diff", lambda *a: []
    )
    calls = []

    class Agent:
        def __init__(self, **kwargs):
            calls.append(kwargs["context_mode"])

        async def run_review(self, request):
            return ReviewResponse(
                run_id="offline-v3",
                context={},
                report=ReviewReport(schema_version="3.0", summary="No findings"),
                report_ready=True,
                delivery_complete=True,
                review_complete=True,
            )

    index = tmp_path / "index.sqlite"

    class Strategy:
        def __init__(self, **kwargs):
            pass

        async def prepare(self, request):
            index.touch()
            return SimpleNamespace(
                graph_telemetry={
                    "graph_status": "ready",
                    "graph_cache_mode": "cold",
                    "cache_hit": False,
                }
            )

    monkeypatch.setattr(pilot, "AgentOrchestrator", Agent)
    monkeypatch.setattr(pilot, "GraphHybridContextStrategy", Strategy)
    monkeypatch.setattr(
        pilot,
        "inspect_index",
        lambda path: pilot.IndexArtifact(path=str(path), exists=True),
    )
    variant = EvalVariant(
        id="B2-graph-hybrid-warm" if warm else "A-agent-search",
        context_mode="graph_hybrid" if warm else "agent_search",
        graph_cache_mode="warm" if warm else "disabled",
    )
    result, lifecycle = asyncio.run(
        pilot.run_single_lifecycle(
            fixture,
            variant=variant,
            relation_graph_index_path=index if warm else None,
            prime_graph_index=warm,
            temperature=0,
            review_max_iterations=3,
            matcher_version="semantic-v3-content-v1",
        )
    )
    assert result.error is None
    assert result.finding_contract_version == "3.0"
    assert result.raw_output["report"]["schema_version"] == "3.0"
    assert len(calls) == 1
    assert ("priming" in lifecycle) == warm
    if warm:
        assert lifecycle["priming"]["measured"] is False


def test_v3_historical_matcher_rejected_before_workspace(monkeypatch):
    monkeypatch.setenv("FINDING_CONTRACT_VERSION", "3.0")
    fixture = Fixture.model_validate(
        {
            "id": "invalid",
            "type": "review",
            "source": {"repo_full_name": "local/test", "pr_number": 1},
            "input": {},
            "expected": {"issues": []},
        }
    )
    with pytest.raises(ValueError):
        asyncio.run(
            pilot.run_single_lifecycle(
                fixture,
                variant=EvalVariant(
                    id="A", context_mode="agent_search", graph_cache_mode="disabled"
                ),
                relation_graph_index_path=None,
                prime_graph_index=False,
                temperature=0,
                review_max_iterations=3,
                matcher_version="semantic-v3",
            )
        )
