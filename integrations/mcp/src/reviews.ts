import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { checkEvidence } from '../../../src/application/evidence-check.ts';
import type { InferenceOptions, ModelSelection, ReviewOptions, ReviewProgress, RunManifest, RuntimeFactory } from '../../../src/engine/contracts.ts';
import { history, readReport, readRun } from '../../../src/engine/reports.ts';
import { ReviewEngine } from '../../../src/engine/review.ts';
import { isolatedState, safePath, sha256, writeJson } from '../../../src/infrastructure/files.ts';
import type { ReviewInput } from '../../../src/snapshot/contracts.ts';
import { SnapshotStore } from '../../../src/snapshot/store.ts';
import { idSchema, startSchema, ToolError } from './schemas.ts';
import type { StartRequest } from './schemas.ts';

export interface ReviewHost {
  repositoryPath: string; stateDir: string; model: ModelSelection;
  inference?: InferenceOptions; skills?: 'auto' | 'off';
}
interface Receipt {
  schemaVersion: 1; taskId: string; repositoryPath: string; createdAt: string;
  owner: { id: string; pid: number }; requestSha256: string;
  runId?: string; finishedAt?: string; failure?: 'failed' | 'cancelled';
  noChanges?: { snapshotId: string };
}
interface Active {
  receipt: Receipt; abort: AbortController; progress: ReviewProgress; settled: Promise<void>;
}
const existsError = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
function ownerAlive(receipt: Receipt): boolean {
  // A different service object in the same process is not the original owner.
  if (receipt.owner.pid === process.pid) return false;
  try { process.kill(receipt.owner.pid, 0); return true; } catch (error) { return !existsError(error, 'ESRCH'); }
}
function runView(run: RunManifest) {
  // Never return runtime configuration, native session entries, or credential files.
  return { runId: run.runId, snapshotId: run.snapshotId, repositoryPath: run.repositoryPath, model: run.model,
    status: run.status, createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.termination ? { termination: run.termination } : {}),
    ...(run.usage ? { usage: run.usage } : {}) };
}

/** Explicit task handles around ReviewEngine; no second review loop or report store. */
export class ReviewTasks {
  readonly host: ReviewHost;
  private factory: RuntimeFactory;
  private ownerId = randomUUID();
  private active = new Map<string, Active>();
  private admitting = false;
  private closed = false;

  private constructor(host: ReviewHost, factory: RuntimeFactory) { this.host = host; this.factory = factory; }
  static async create(host: ReviewHost, factory: RuntimeFactory): Promise<ReviewTasks> {
    const repositoryPath = await realpath(host.repositoryPath);
    const stateDir = await isolatedState(host.stateDir, repositoryPath);
    return new ReviewTasks({ ...host, repositoryPath, stateDir }, factory);
  }
  private directory(id: string): string { return join(this.host.stateDir, 'mcp', 'tasks', idSchema.parse(id)); }
  private save(receipt: Receipt): Promise<void> { return writeJson(join(this.directory(receipt.taskId), 'task.json'), receipt); }
  private async receipt(id: string): Promise<Receipt | undefined> {
    let value: Receipt;
    try { value = JSON.parse(await readFile(join(this.directory(id), 'task.json'), 'utf8')) as Receipt; }
    catch (error) { if (existsError(error, 'ENOENT')) return undefined; throw new ToolError('TASK_UNREADABLE', 'Task receipt is unreadable; no successful review is confirmed.'); }
    if (value.schemaVersion !== 1 || value.taskId !== id || value.repositoryPath !== this.host.repositoryPath ||
      !value.owner || !Number.isInteger(value.owner.pid) || value.owner.pid <= 0 || typeof value.owner.id !== 'string' ||
      typeof value.createdAt !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestSha256) ||
      (value.runId !== undefined && !idSchema.safeParse(value.runId).success) ||
      (value.failure !== undefined && !['failed', 'cancelled'].includes(value.failure)) ||
      (value.noChanges !== undefined && !/^[a-f0-9]{64}$/.test(value.noChanges.snapshotId))) {
      throw new ToolError('TASK_UNREADABLE', 'Task receipt is invalid or belongs to another configured repository.');
    }
    return value;
  }
  private async nativeRun(id: string): Promise<RunManifest> {
    const run = await readRun(this.host.stateDir, id);
    if (run.repositoryPath !== this.host.repositoryPath) throw new ToolError('REPOSITORY_MISMATCH', 'Run belongs to another configured repository.');
    return run;
  }

  async start(request: StartRequest, signal?: AbortSignal) {
    const parsed = startSchema.parse(request);
    const input: ReviewInput = parsed.scope === 'commits' ? { kind: 'commits', base: parsed.base!, head: parsed.head! }
      : parsed.scope === 'worktree' ? { kind: 'worktree', includeUntracked: (parsed.includeUntracked ?? []).map(safePath) } : { kind: 'staged' };
    const options: ReviewOptions = { ...this.host, input, learn: 'off', timeoutMs: parsed.timeoutMs ?? 600_000, maxToolCalls: parsed.maxToolCalls ?? 100 };
    const requestSha256 = sha256(JSON.stringify(options));
    const taskId = parsed.requestId ?? randomUUID();
    const existing = await this.receipt(taskId);
    if (existing) {
      if (existing.requestSha256 !== requestSha256) throw new ToolError('REQUEST_CONFLICT', 'This requestId already names a different review. Use a new UUID for a new review.');
      return this.get(taskId, false);
    }
    if (this.closed) throw new ToolError('SERVER_CLOSING', 'Server is closing; no new review can start.');
    if (this.admitting || this.active.size) throw new ToolError('REVIEW_BUSY', 'A review is already active in this server. Query or cancel it before starting another.');
    this.admitting = true;
    try {
      signal?.throwIfAborted();
      await isolatedState(this.host.stateDir, this.host.repositoryPath);
      await mkdir(join(this.host.stateDir, 'mcp', 'tasks'), { recursive: true, mode: 0o700 });
      try { await mkdir(this.directory(taskId), { mode: 0o700 }); }
      catch (error) {
        if (!existsError(error, 'EEXIST')) throw error;
        const winner = await this.receipt(taskId);
        if (!winner) throw new ToolError('START_PENDING', 'Task admission is pending or interrupted. Retry the same requestId; do not assume a review started.');
        if (winner.requestSha256 !== requestSha256) throw new ToolError('REQUEST_CONFLICT', 'This requestId already names a different review.');
        return this.get(taskId, false);
      }
      const receipt: Receipt = { schemaVersion: 1, taskId, repositoryPath: this.host.repositoryPath, requestSha256,
        createdAt: new Date().toISOString(), owner: { id: this.ownerId, pid: process.pid } };
      await this.save(receipt);
      if (signal?.aborted || this.closed) {
        receipt.failure = 'cancelled'; receipt.finishedAt = new Date().toISOString(); await this.save(receipt);
        throw new ToolError('START_CANCELLED', 'Admission was cancelled before starting ReviewEngine.');
      }
      const active: Active = { receipt, abort: new AbortController(), progress: { phase: 'preparing' }, settled: Promise.resolve() };
      this.active.set(taskId, active);
      active.settled = this.execute(active, options);
      return { taskId, status: 'accepted', done: false, canCancel: true, pollAfterMs: 1000, repositoryPath: this.host.repositoryPath };
    } finally { this.admitting = false; }
  }
  private async execute(active: Active, options: ReviewOptions): Promise<void> {
    const receipt = active.receipt;
    let completion: Partial<Receipt> = {};
    try {
      const engine = new ReviewEngine(async runtimeOptions => {
        // This native run already has its manifest; link it before any Pi authentication/model work.
        receipt.runId = basename(runtimeOptions.runDir); await this.save(receipt);
        active.progress = { phase: 'preparing', runId: receipt.runId };
        return this.factory(runtimeOptions);
      });
      const result = await engine.run({ ...options, signal: active.abort.signal }, progress => { active.progress = progress; });
      if (result.kind === 'no_changes') completion = { noChanges: { snapshotId: result.snapshotId } };
      else completion = { runId: result.runId };
    } catch {
      completion = { failure: active.abort.signal.aborted ? 'cancelled' : 'failed' };
    } finally {
      // Do not publish a no-run terminal result from memory before its receipt is durable.
      // A reconnect must observe the same outcome as the client that polled this owner.
      try { await this.save({ ...receipt, ...completion, finishedAt: new Date().toISOString() }); }
      catch { console.error('MergeWarden MCP task receipt could not be saved; query the native run to verify delivery.'); }
      this.active.delete(receipt.taskId);
    }
  }

  async get(id: string, includeReport = true): Promise<Record<string, unknown>> {
    idSchema.parse(id);
    const active = this.active.get(id);
    const receipt = active?.receipt ?? await this.receipt(id);
    const task = receipt ? { taskId: receipt.taskId, repositoryPath: receipt.repositoryPath, createdAt: receipt.createdAt } : {};
    const runId = receipt?.runId ?? (receipt ? undefined : id);
    if (runId) {
      const run = await this.nativeRun(runId);
      if (run.status === 'delivered') {
        // Delivery hashes and identity are checked even for lightweight status polling.
        const report = await readReport(this.host.stateDir, runId);
        return { ...task, runId, run: runView(run), status: report.status, done: true, canCancel: false, ...(includeReport ? { report } : {}) };
      }
      if (run.status === 'delivery_failed') return { ...task, runId, run: runView(run), status: 'delivery_failed', done: true, canCancel: false };
      if (run.status !== 'running') throw new ToolError('RUN_UNREADABLE', 'Native run has an invalid state; no delivery is confirmed.');
      if (!receipt) {
        // CLI runs do not have an MCP owner. Do not invent liveness from a running manifest.
        return { runId, run: runView(run), status: 'running', done: false, canCancel: false, liveness: 'unknown', pollAfterMs: 1000 };
      }
    }
    if (receipt?.noChanges) return { ...task, status: 'no_changes', done: true, canCancel: false, snapshotId: receipt.noChanges.snapshotId };
    if (receipt?.failure) return { ...task, ...(runId ? { runId } : {}), status: receipt.failure, done: true, canCancel: false, error: 'Review ended without a confirmed report.' };
    const live = !!active || !!receipt && ownerAlive(receipt);
    return { ...task, ...(runId ? { runId } : {}), status: live ? 'running' : 'interrupted', done: !live,
      canCancel: !!active && !active.abort.signal.aborted, ...(active ? { progress: active.progress, cancellationRequested: active.abort.signal.aborted } : {}),
      ...(live ? { pollAfterMs: 1000 } : { error: 'Task owner exited without a confirmed delivery. Inspect the native run and repository lock with CLI doctor.' }) };
  }

  async evidence(runId: string, findingId: string, evidenceIndex = 0) {
    await this.nativeRun(runId);
    const report = await readReport(this.host.stateDir, runId);
    const finding = report.findings.find(item => item.id === findingId);
    if (!finding) throw new ToolError('FINDING_NOT_FOUND', 'Finding is not in the verified report.');
    const ref = finding.evidence[evidenceIndex];
    if (!Number.isInteger(evidenceIndex) || evidenceIndex < 0 || !ref) throw new ToolError('EVIDENCE_NOT_FOUND', 'Evidence index is outside this finding.');
    const snapshot = await SnapshotStore.load(this.host.stateDir, report.snapshot.id);
    if (snapshot.manifest.repositoryPath !== this.host.repositoryPath) throw new ToolError('REPOSITORY_MISMATCH', 'Snapshot belongs to another configured repository.');
    const checked = await checkEvidence({ ...finding, evidence: [ref] }, snapshot);
    if (!checked.ok) throw new ToolError('EVIDENCE_INTEGRITY', 'Frozen evidence failed the existing source integrity check.');
    return { runId, findingId, evidenceIndex, evidenceCount: finding.evidence.length, evidence: ref,
      source: await snapshot.source(ref.revision, ref.path, ref.startLine, ref.endLine) };
  }
  async list(limit = 10) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolError('INVALID_LIMIT', 'Limit must be 1..50.');
    const runs = (await history(this.host.stateDir)).filter(run => run.repositoryPath === this.host.repositoryPath);
    const byRun = new Map(runs.map(run => [run.runId, run]));
    const items: Record<string, unknown>[] = [];
    let ids: string[] = [];
    try { ids = await readdir(join(this.host.stateDir, 'mcp', 'tasks')); } catch (error) { if (!existsError(error, 'ENOENT')) throw error; }
    for (const id of ids) {
      try {
        const receipt = await this.receipt(id); if (!receipt) continue;
        const item = await this.get(id, false);
        items.push(item); if (receipt.runId) byRun.delete(receipt.runId);
      } catch { /* Unreadable tasks and corrupt reports cannot enter successful history. */ }
    }
    for (const run of byRun.values()) items.push(await this.get(run.runId, false));
    items.sort((a, b) => String(b.createdAt ?? (b.run as RunManifest)?.createdAt).localeCompare(String(a.createdAt ?? (a.run as RunManifest)?.createdAt)));
    return { repositoryPath: this.host.repositoryPath, reviews: items.slice(0, limit), hasMore: items.length > limit };
  }
  async cancel(taskId: string, signal?: AbortSignal) {
    const status = await this.get(taskId, false);
    if (status.done) return { ...status, cancellationRequested: false };
    const active = this.active.get(taskId);
    if (!active) throw new ToolError('TASK_OWNER_UNAVAILABLE', 'This live task belongs to another MCP process. Cancel through its owning Codex connection.');
    signal?.throwIfAborted(); active.abort.abort();
    return { ...status, canCancel: false, cancellationRequested: true };
  }
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.active.values()]; pending.forEach(task => task.abort.abort());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(pending.map(task => task.settled)), new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}
