import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { emptyCoverage } from "./contracts.ts";
import type { CodeGraph, GraphPage, RelationFact, SymbolFact } from "./contracts.ts";
import { releaseGraphBuildLock } from "./sqlite-store.ts";
import type { GraphMetrics } from "./sqlite-store.ts";

type WorkerResult<T> = { id: number; page?: GraphPage<T>; metrics?: GraphMetrics; error?: string };
/** One terminable graph service per review. Parser, verified SQLite and indexes are reused. */
export class LazyCodeGraph implements CodeGraph {
  private stateDir: string; private snapshotId: string; private preparedOnly: boolean; private worker: Worker | undefined; private sequence = 0;
  private ownerToken = randomUUID(); private closed = false;
  private pending = new Map<number, { resolve(value: WorkerResult<unknown>): void; reject(error: unknown): void }>();
  metrics = { buildMs: 0, queryMs: 0, warmRequestMs: [] as number[], coldRequestMs: [] as number[], calls: 0, workerStarts: 0, coverage: emptyCoverage(), resumedFiles: 0, extractedFiles: 0, resumedResolutionFiles: 0, resolvedFiles: 0, storage: { generationBytes: 0, checkpointBytes: 0 }, generationId: undefined as GraphMetrics["generationId"], generationState: undefined as GraphMetrics["generationState"], scope: undefined as GraphMetrics["scope"] };
  constructor(stateDir: string, snapshotId: string, options: { preparedOnly?: boolean } = {}) { this.stateDir = stateDir; this.snapshotId = snapshotId; this.preparedOnly = options.preparedOnly === true; }
  private start(): Worker {
    if (this.closed) throw new Error("Graph service is closed");
    if (this.worker) return this.worker;
    this.metrics.workerStarts++;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { stateDir: this.stateDir, snapshotId: this.snapshotId, ownerToken: this.ownerToken, preparedOnly: this.preparedOnly }, execArgv: ["--experimental-strip-types"], resourceLimits: { maxOldGenerationSizeMb: 512 } });
    worker.on("message", (value: WorkerResult<unknown>) => { const request = this.pending.get(value.id); if (!request) return; this.pending.delete(value.id); request.resolve(value); if (!this.pending.size) worker.unref(); });
    const failed = (error: unknown) => { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); if (this.worker === worker) this.worker = undefined; };
    worker.once("error", () => failed(new Error("Graph worker failed; empty results cannot establish absence.")));
    worker.once("exit", code => { if (code !== 0 || this.pending.size) failed(new Error("Graph worker exited before a verified result.")); if (this.worker === worker) this.worker = undefined; });
    worker.unref();
    this.worker = worker; return worker;
  }
  private async stop(reason: unknown): Promise<void> {
    const worker = this.worker; this.worker = undefined;
    for (const request of this.pending.values()) request.reject(reason); this.pending.clear();
    if (worker) {
      // Keep Node 22 alive until cancellation has actually stopped the worker.
      worker.ref();
      await worker.terminate().catch(() => undefined);
    }
    await releaseGraphBuildLock(this.stateDir, this.snapshotId, this.ownerToken).catch(() => undefined);
  }
  private async query<T>(method: string, input: { snapshotId: string }, signal?: AbortSignal): Promise<GraphPage<T>> {
    signal?.throwIfAborted(); if (input.snapshotId !== this.snapshotId) throw new Error("Graph snapshot mismatch");
    const started = performance.now(); this.metrics.calls++; const id = ++this.sequence; const worker = this.start();
    const result = await new Promise<WorkerResult<T>>((resolve, reject) => {
      let settled = false;
      const finishResolve = (value: WorkerResult<unknown>) => { if (settled) return; settled = true; signal?.removeEventListener("abort", cancel); resolve(value as WorkerResult<T>); };
      const finishReject = (error: unknown) => { if (settled) return; settled = true; signal?.removeEventListener("abort", cancel); reject(error); };
      const cancel = () => { this.pending.delete(id); const reason = signal?.reason ?? new Error("Graph cancelled"); void this.stop(reason).finally(() => finishReject(reason)); };
      this.pending.set(id, { resolve: finishResolve, reject: finishReject }); worker.ref(); signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else worker.postMessage({ id, method, input });
    });
    signal?.throwIfAborted();
    if (result.metrics) {
      this.metrics.buildMs += result.metrics.buildMs; this.metrics.queryMs += result.metrics.queryMs; this.metrics.coverage = result.metrics.coverage;
      this.metrics.resumedFiles += result.metrics.resumedFiles; this.metrics.extractedFiles += result.metrics.extractedFiles; this.metrics.resumedResolutionFiles += result.metrics.resumedResolutionFiles; this.metrics.resolvedFiles += result.metrics.resolvedFiles; this.metrics.storage = result.metrics.storage;
      this.metrics.generationId = result.metrics.generationId; this.metrics.generationState = result.metrics.generationState; this.metrics.scope = result.metrics.scope;
      (result.metrics.cacheHit ? this.metrics.warmRequestMs : this.metrics.coldRequestMs).push(performance.now() - started);
    }
    return result.page ?? { status: "error", snapshotId: this.snapshotId, revision: "head", items: [], truncated: false, coverage: result.metrics?.coverage ?? emptyCoverage(), warnings: [result.error ?? "Graph failed"] };
  }
  lookup(input: Parameters<CodeGraph["lookup"]>[0], signal?: AbortSignal) { return this.query<SymbolFact>("lookup", input, signal); }
  neighbors(input: Parameters<CodeGraph["neighbors"]>[0], signal?: AbortSignal) { return this.query<RelationFact>("neighbors", input, signal); }
  async dispose(): Promise<void> { if (this.closed) return; this.closed = true; await this.stop(new Error("Graph service closed")); }
}
