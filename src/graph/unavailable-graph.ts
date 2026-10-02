import type { CodeGraph, GraphPage } from "./contracts.ts";
import { emptyCoverage } from "./contracts.ts";
/** Explicit boundary, NOT a regex fallback and NOT evidence of absent relations. */
export class UnavailableGraph implements CodeGraph {
  private result<T>(snapshotId: string): GraphPage<T> {
    return { status: "not_indexed", snapshotId, items: [], truncated: false,
      coverage: emptyCoverage(),
      warnings: ["No index is attached. An empty result here does not mean no callers exist."] };
  }
  async lookup(input: Parameters<CodeGraph["lookup"]>[0]) { return this.result<import("./contracts.ts").SymbolFact>(input.snapshotId); }
  async neighbors(input: Parameters<CodeGraph["neighbors"]>[0]) { return this.result<import("./contracts.ts").RelationFact>(input.snapshotId); }
}
