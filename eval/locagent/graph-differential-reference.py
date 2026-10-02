"""Run the pinned, separately checked-out LocAgent graph builder on an inert fixture."""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path


def normalized(value: str) -> str:
    return value.replace(os.sep, "/")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: graph-differential-reference.py LOCAGENT_ROOT FIXTURE_ROOT")
    source = Path(sys.argv[1]).resolve() / "dependency_graph" / "build_graph.py"
    fixture = Path(sys.argv[2]).resolve()
    spec = importlib.util.spec_from_file_location("pinned_locagent_build_graph", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load pinned LocAgent builder")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    graph = module.build_graph(str(fixture), fuzzy_search=True, global_import=False)
    nodes = [
        {"id": normalized(str(node)), "type": data.get("type")}
        for node, data in graph.nodes(data=True)
    ]
    edges = [
        {
            "from": normalized(str(source_id)),
            "to": normalized(str(target_id)),
            "type": data.get("type"),
            **({"alias": data.get("alias")} if "alias" in data else {}),
        }
        for source_id, target_id, data in graph.edges(data=True)
    ]
    print(json.dumps({
        "referenceCommit": "4935b557326c154bad8e8dcf3747cc8d32d1f387",
        "builderVersion": module.VERSION,
        "nodes": sorted(nodes, key=lambda item: (item["id"], item["type"] or "")),
        "edges": sorted(edges, key=lambda item: (item["from"], item["to"], item["type"] or "", str(item.get("alias")))),
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
