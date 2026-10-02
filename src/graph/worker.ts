import { parentPort, workerData } from "node:worker_threads";
import { SnapshotStore } from "../snapshot/store.ts";
import { emptyCoverage } from "./contracts.ts";
import { GraphOpenError, SqliteCodeGraph } from "./sqlite-store.ts";
import type { GraphMetrics, SqliteCodeGraph as GraphHandle } from "./sqlite-store.ts";

let graph: GraphHandle | undefined; let openedMetrics: GraphMetrics | undefined; let deliveredOpenMetrics = false;
let queue: Promise<void> = Promise.resolve();
async function handle(message: { id: number; method: string; input: Parameters<GraphHandle["lookup"]>[0] & Parameters<GraphHandle["neighbors"]>[0] }): Promise<void> {
  try {
    if (!graph) {
      const store = await SnapshotStore.load(workerData.stateDir, workerData.snapshotId);
      const opened = workerData.preparedOnly ? await SqliteCodeGraph.openPublishedOnly(store) : await SqliteCodeGraph.open(store, { ownerToken: workerData.ownerToken }); graph = opened.graph; openedMetrics = opened.metrics;
    }
    const queryStarted = performance.now(); const page = message.method === "lookup" ? await graph.lookup(message.input) : await graph.neighbors(message.input);
    const base = openedMetrics!; const metrics: GraphMetrics = deliveredOpenMetrics ? { ...base, buildMs: 0, queryMs: performance.now() - queryStarted, cacheHit: true, resumedFiles: 0, extractedFiles: 0, resumedResolutionFiles: 0, resolvedFiles: 0 } : { ...base, queryMs: performance.now() - queryStarted };
    deliveredOpenMetrics = true; parentPort!.postMessage({ id: message.id, page, metrics });
  } catch (error) {
    if (error instanceof GraphOpenError) parentPort!.postMessage({ id: message.id, page: { status: error.status, snapshotId: workerData.snapshotId, revision: "head", items: [], truncated: false, coverage: error.coverage, warnings: error.warnings }, metrics: { buildMs: 0, queryMs: 0, cacheHit: false, coverage: error.coverage, resumedFiles: 0, extractedFiles: 0, resumedResolutionFiles: 0, resolvedFiles: 0, storage: { generationBytes: 0, checkpointBytes: 0 } } });
    else parentPort!.postMessage({ id: message.id, page: { status: "error", snapshotId: workerData.snapshotId, revision: "head", items: [], truncated: false, coverage: openedMetrics?.coverage ?? emptyCoverage(), warnings: [error instanceof Error ? error.message : "Graph index/query failed", "Empty results do not establish absence."] } });
  }
}
parentPort!.on("message", message => { queue = queue.then(() => handle(message)); });
process.once("exit", () => { graph?.close(); });
