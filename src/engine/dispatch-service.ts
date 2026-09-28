import { createHash } from "node:crypto";
import { BudgetClosingError } from './budget.ts';
import { evidenceRefId, fullEvidence } from "../application/evidence-registry.ts";
import { PersistenceFailure } from "../ports/journal.ts";
import { ObservedAnchors } from "./dispatch-anchors.ts";
import { DISPATCH_LIMITS, DISPATCH_VERSION } from "./dispatch-contracts.ts";
import type { ContextPackage, DispatchBridge, DispatchEntity, DispatchObservation, DispatchSource, DispatchTrigger, InvestigationRequest } from "./dispatch-contracts.ts";
import { retrieveStructure } from "./dispatch-retrieval.ts";
import type { DispatchOperation } from "./dispatch-retrieval.ts";
import type { RoutingBudget } from "./routing-contracts.ts";
import { isObject } from "./tool-result.ts";

export const DISPATCH_MESSAGE = "mergewarden-structural-context-v1";
export const DISPATCH_EVENT = "mergewarden-host-dispatch-v1";
export const packageText = (pack: ContextPackage) => JSON.stringify(pack);
const bytes = (pack: ContextPackage) => Buffer.byteLength(packageText(pack));
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const payloadContains = (payload: unknown, text: string): boolean => typeof payload === "string" ? payload.includes(text)
  : Array.isArray(payload) ? payload.some(v => payloadContains(v, text))
  : isObject(payload) ? Object.values(payload).some(v => payloadContains(v, text)) : false;
class DispatchBudget extends Error {}
interface Options {
  runId: string; snapshotId: string; changedPaths: string[]; signal: AbortSignal;
  operation: DispatchOperation; promote(source: DispatchSource): void; budget?: Partial<RoutingBudget>;
  onPersistenceFailure?(error: PersistenceFailure): void;
}
/** Host service: no SDK, repository filesystem or database handles. */
export class StructuralDispatch implements DispatchBridge {
  private options: Options;
  private observations: ObservedAnchors;
  private requests = new Set<string>();
  private pending = new Map<string, { pack: ContextPackage; text: string }>();
  private shown: { path: string; startLine: number; endLine: number }[] = [];
  private recorder: (event: Record<string, unknown>) => void = () => {};
  private totalStructural = 0;
  private persistenceFailure: PersistenceFailure | undefined;
  readonly metrics = { requests: 0, terminals: {} as Record<string, number>, structuralOperations: 0, sourceReads: 0, packagesQueued: 0, packagesDelivered: 0, contextBytes: 0, latencyMs: 0 };
  constructor(options: Options) {
    for (const [key, value] of Object.entries(options.budget ?? {})) {
      const cap = DISPATCH_LIMITS[key as keyof RoutingBudget];
      if (!Number.isInteger(value) || value < 1 || value > cap) throw Error("Invalid dispatch budget: " + key);
    }
    this.options = options; this.observations = new ObservedAnchors(options.changedPaths);
  }
  setRecorder(record: (event: Record<string, unknown>) => void) { this.recorder = record; }
  private record(event: Record<string, unknown>) {
    if (this.persistenceFailure) throw this.persistenceFailure;
    try { this.recorder({ version: DISPATCH_VERSION, origin: "host_dispatch", runId: this.options.runId, snapshotId: this.options.snapshotId, ...event }); }
    catch {
      this.persistenceFailure = new PersistenceFailure();
      this.options.onPersistenceFailure?.(this.persistenceFailure); throw this.persistenceFailure;
    }
  }
  observe(event: DispatchObservation) {
    if (event.isError || event.result.snapshotId !== this.options.snapshotId) return;
    this.observations.observe(event);
    if (event.toolName === "read_source" && event.result.status === "ok" && event.result.revision === "head")
      this.shown.push({ path: String(event.result.path), startLine: Number(event.result.startLine), endLine: Number(event.result.endLine) });
  }
  hasPending() { return this.pending.size > 0; }
  queued(pack: ContextPackage) {
    if (this.options.signal.aborted || this.pending.has(pack.requestId)) return;
    this.pending.set(pack.requestId, { pack: structuredClone(pack), text: packageText(pack) });
    this.metrics.packagesQueued++; this.record({ type: "context_queued", requestId: pack.requestId, sources: pack.sources.map(s => s.evidenceRefId) });
  }
  providerPayload(payload: unknown) {
    this.options.signal.throwIfAborted();
    for (const [id, pending] of this.pending) {
      if (!payloadContains(payload, pending.text)) continue;
      // Durable exposure record first. Failed persistence cannot grant evidence eligibility.
      this.record({ type: "context_delivered", requestId: id, packageSha256: createHash("sha256").update(pending.text).digest("hex"), evidenceRefIds: pending.pack.sources.map(s => s.evidenceRefId) });
      for (const source of pending.pack.sources) { this.options.promote(source); this.shown.push(source); }
      this.pending.delete(id); this.metrics.packagesDelivered++; this.metrics.contextBytes += Buffer.byteLength(pending.text);
    }
  }
  async dispatch(trigger: DispatchTrigger): Promise<ContextPackage | undefined> {
    const requestId = "dispatch_" + createHash("sha256").update(JSON.stringify([this.options.runId, trigger.routeId])).digest("hex");
    if (this.requests.has(requestId)) return;
    this.requests.add(requestId);
    const started = performance.now();
    const request: InvestigationRequest = { ...trigger, requestId, runId: this.options.runId, snapshotId: this.options.snapshotId,
      strategyVersion: DISPATCH_VERSION, anchors: this.observations.complete(trigger), changedPaths: this.options.changedPaths,
      template: trigger.routeType, budget: { ...DISPATCH_LIMITS, ...this.options.budget } };
    const pack: ContextPackage = { version: DISPATCH_VERSION, origin: "host_dispatch", requestId, runId: request.runId,
      snapshotId: request.snapshotId, template: request.template, relations: [], sources: [], omitted: [],
      limitations: ["Execution completion does not answer the review question. Empty relations do not establish absence; candidates are not relevance or defect judgments."], terminal: "no_definite_relation" };
    this.metrics.requests++; this.record({ type: "investigation_requested", request });
    let structural = 0, reads = 0;
    const operation: DispatchOperation = async (name, input) => {
      this.options.signal.throwIfAborted();
      const source = name === "read_source";
      if (this.metrics.requests > request.budget.maxRouteEpisodes || source && reads >= request.budget.maxSourceReadsPerEpisode
        || !source && (structural >= request.budget.maxStructuralCallsPerEpisode || this.totalStructural >= request.budget.maxStructuralCallsTotal)) throw new DispatchBudget("Frozen dispatch budget exhausted");
      if (source) { reads++; this.metrics.sourceReads++; } else { structural++; this.totalStructural++; this.metrics.structuralOperations++; }
      const operationId = `${requestId}:${structural + reads}`;
      this.record({ type: "operation_requested", requestId, operationId, name, input });
      try {
        const result = await this.options.operation(name, input);
        this.record({ type: "operation_result", requestId, operationId, name, result }); return result;
      } catch (error) {
        if (error instanceof PersistenceFailure) throw error;
        this.record({ type: "operation_failed", requestId, operationId, name, message: String(error) }); throw error;
      }
    };
    const candidates: DispatchEntity[] = [];
    const failure = (error: unknown) => {
      if (error instanceof PersistenceFailure) throw error;
      pack.terminal = this.options.signal.aborted ? (/budget/i.test(String(this.options.signal.reason)) ? "budget_exhausted" : "cancelled")
        : error instanceof DispatchBudget || error instanceof BudgetClosingError ? "budget_exhausted" : "error";
      pack.limitations.push(String(error).slice(0, 512));
    };
    if (this.observations.limited) {
      pack.terminal = "anchor_ambiguous"; pack.limitations.push("Observed anchor hints exceed the frozen bound; no prefix candidate is guessed.");
    } else try { await retrieveStructure(request, pack, operation, candidates); } catch (error) { failure(error); }
    const alreadyShown = (e: DispatchEntity) => this.shown.some(s => s.path === e.path && s.startLine <= e.startLine && s.endLine >= e.endLine);
    const sorted = candidates.sort((a, b) => Number(alreadyShown(a)) - Number(alreadyShown(b))
      || Number(request.changedPaths.includes(a.path)) - Number(request.changedPaths.includes(b.path))
      || (a.depth ?? 0) - (b.depth ?? 0) || cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.entityId, b.entityId));
    const windows = new Set<string>();
    for (const candidate of sorted) {
      const site = pack.relations.find(e => e.sourcePath === candidate.path && e.sourceLine >= candidate.startLine && e.sourceLine <= candidate.endLine);
      const startLine = Math.max(candidate.startLine, (site?.sourceLine ?? candidate.startLine) - 10);
      const endLine = Math.min(candidate.endLine, startLine + DISPATCH_LIMITS.sourceWindowLines - 1);
      const window = `${candidate.path}:${startLine}-${endLine}`;
      if (windows.has(window) || this.shown.some(s => s.path === candidate.path && s.startLine <= startLine && s.endLine >= endLine)) continue;
      windows.add(window);
      if (reads >= request.budget.maxSourceReadsPerEpisode || this.options.signal.aborted) { pack.omitted.push(window); continue; }
      try {
        const page = await operation("read_source", { revision: "head", path: candidate.path, startLine, endLine });
        if (page.status !== "ok" || page.snapshotId !== request.snapshotId || page.revision !== "head" || page.path !== candidate.path || typeof page.text !== "string") throw Error("Invalid host source result");
        const ref = fullEvidence(page as unknown as DispatchSource);
        if (ref.startLine !== startLine || ref.endLine > endLine || ref.endLine < startLine || createHash("sha256").update(page.text).digest("hex") !== ref.contentSha256) throw Error("Host source integrity mismatch");
        const source = { ...ref, evidenceRefId: evidenceRefId(ref), text: page.text, entity: candidate };
        pack.sources.push(source);
        if (bytes(pack) > DISPATCH_LIMITS.maxPackageBytes - 2048) { pack.sources.pop(); pack.omitted.push(window + " (package byte limit)"); }
        if (startLine > candidate.startLine || endLine < candidate.endLine) pack.omitted.push(`${candidate.path}: definition ${candidate.startLine}-${candidate.endLine}, shown window ${startLine}-${endLine}`);
      } catch (error) { failure(error); pack.omitted.push(window); if (this.options.signal.aborted) break; }
    }
    if (pack.terminal === "no_definite_relation" && pack.relations.length && !pack.sources.length) pack.limitations.push("Definite relations returned, but no new candidate source was included; existing exposure or output bounds may account for this.");
    if (pack.terminal === "no_definite_relation") pack.terminal = pack.limitations.length > 1 || pack.omitted.length ? "coverage_limited" : pack.sources.length ? "context_returned" : "no_definite_relation";
    // Bound diagnostics too, preserving whole source pages and their hashes.
    pack.omitted = pack.omitted.slice(0, 30); pack.limitations = [...new Set(pack.limitations)].slice(0, 12);
    while (bytes(pack) > DISPATCH_LIMITS.maxPackageBytes && pack.sources.length) { const s = pack.sources.pop()!; pack.omitted.push(`${s.path}:${s.startLine}-${s.endLine} (package byte limit)`); pack.terminal = "coverage_limited"; }
    if (bytes(pack) > DISPATCH_LIMITS.maxPackageBytes) { pack.relations = []; pack.omitted = ["Relation details omitted by package byte limit; no source is eligible without its complete package."]; pack.terminal = "coverage_limited"; }
    if (bytes(pack) > DISPATCH_LIMITS.maxPackageBytes) { delete pack.anchor; pack.limitations = ["Anchor metadata exceeds package limit."]; }
    this.metrics.terminals[pack.terminal] = (this.metrics.terminals[pack.terminal] ?? 0) + 1;
    this.metrics.latencyMs += performance.now() - started;
    this.record({ type: "investigation_terminal", requestId, generationId: pack.generationId, terminal: pack.terminal, structuralOperations: structural, sourceReads: reads });
    return pack;
  }
}
