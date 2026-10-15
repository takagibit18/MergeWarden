import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffQuery, DiffSideDto, EvidenceDiffResponse, EvidenceRefDto, EvidenceResponse, HistoryItem, ProjectDto, ReportDto, TaskResponse, WorkspaceDto } from '../../../packages/contracts/src/types.ts';
import { checkEvidence } from '../../application/evidence-check.ts';
import { buildEvidenceDiff } from '../../application/evidence-diff.ts';
import type { FindingCandidate, ReviewReport, SnapshotIdentity } from '../../domain/contracts.ts';
import { assertCandidate, assertSnapshot, isRecord } from '../../domain/validation.ts';
import type { RunManifest } from '../../engine/contracts.ts';
import { readReport, readRun, runPath } from '../../engine/reports.ts';
import { inside, sha256 } from '../files.ts';
import { WorkbenchError } from '../../ports/workbench-errors.ts';
import { SnapshotStore } from '../../snapshot/store.ts';
import { fallbackTitle, verifiedTitle } from './display-title.ts';

export const isHistoryId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isTime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const normalizedTime = (value: string): string => new Date(value).toISOString();
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const unavailable = (item: HistoryItem, code = 'REPORT_INTEGRITY'): HistoryItem => ({ ...item, ...fallbackTitle(item), status: null, reportAvailability: 'unavailable',
  error: { code, message: 'The native record could not be verified. No report delivery is confirmed.' } });

interface Receipt {
  schemaVersion: 1; taskId: string; repositoryPath: string; createdAt: string;
  owner: { id: string; pid: number }; requestSha256: string;
  runId?: string; finishedAt?: string; failure?: 'failed' | 'cancelled'; noChanges?: { snapshotId: string };
}

function liveness(receipt: Receipt): 'unknown' | 'owner_present' | 'owner_exited' {
  try { process.kill(receipt.owner.pid, 0); return 'owner_present'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'owner_exited' : 'unknown'; }
}

function evidenceDto(ref: FindingCandidate['evidence'][number]): EvidenceRefDto {
  return { snapshotId: ref.snapshotId, revision: ref.revision, path: ref.path, startLine: ref.startLine, endLine: ref.endLine, contentSha256: ref.contentSha256 };
}

function snapshotDto(snapshot: SnapshotIdentity): ReportDto['snapshot'] {
  return { id: snapshot.id, repositoryId: snapshot.repositoryId, inputFingerprint: snapshot.inputFingerprint,
    configurationFingerprint: snapshot.configurationFingerprint,
    ...(snapshot.baseCommit ? { baseCommit: snapshot.baseCommit } : {}), ...(snapshot.headCommit ? { headCommit: snapshot.headCommit } : {}),
    ...(snapshot.baseVersion ? { baseVersion: { kind: snapshot.baseVersion.kind, id: snapshot.baseVersion.id } } : {}),
    ...(snapshot.headVersion ? { headVersion: { kind: snapshot.headVersion.kind, id: snapshot.headVersion.id } } : {}) };
}

/** Public DTOs are copied from freshly verified native artifacts, never from the projection. */
export class NativeHistorySource {
  readonly repositoryPath: string;
  readonly stateDir: string;
  private project: ProjectDto;
  private workspaces: Map<string, WorkspaceDto>;

  constructor(project: ProjectDto, stateDir: string) {
    this.project = project; this.repositoryPath = project.repositoryPath; this.stateDir = stateDir;
    this.workspaces = new Map(project.workspaces.map(workspace => [workspace.path, workspace]));
  }

  private workspace(path: string): WorkspaceDto {
    const workspace = this.workspaces.get(path);
    if (!workspace) throw new WorkbenchError('REPOSITORY_MISMATCH', 'Review was not found in the configured project.', 404);
    return workspace;
  }

  private async boundedFile(path: string, maximumBytes: number): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes || !inside(this.stateDir, await realpath(path))) {
      throw new WorkbenchError('REPORT_INTEGRITY', 'The native artifact is unavailable or outside its permitted storage.', 409);
    }
  }

  private async manifest(id: string): Promise<RunManifest> {
    if (!isHistoryId(id)) throw new WorkbenchError('INVALID_QUERY', 'A valid review UUID is required.', 400);
    let run: RunManifest;
    try {
      await this.boundedFile(join(runPath(this.stateDir, id), 'run.json'), 1024 * 1024);
      run = await readRun(this.stateDir, id);
    } catch (error) {
      if (isMissing(error)) throw new WorkbenchError('NOT_FOUND', 'Review was not found in the configured repository.', 404);
      throw new WorkbenchError('REPORT_INTEGRITY', 'The native run manifest could not be verified.', 409);
    }
    this.workspace(run.repositoryPath);
    if (!isHash(run.snapshotId) || !isHash(run.configurationFingerprint) || !isTime(run.createdAt) ||
      (run.finishedAt !== undefined && !isTime(run.finishedAt)) || !isRecord(run.model) || !isText(run.model.provider) || !isText(run.model.modelId) ||
      !['running', 'delivered', 'delivery_failed'].includes(run.status) ||
      (run.outcome !== undefined && !['completed', 'partial', 'failed', 'cancelled'].includes(run.outcome))) {
      throw new WorkbenchError('REPORT_INTEGRITY', 'The native run manifest could not be verified.', 409);
    }
    return run;
  }

  private async snapshot(id: string, repositoryPath: string, configurationFingerprint?: string): Promise<SnapshotStore> {
    try {
      this.workspace(repositoryPath);
      await this.boundedFile(join(this.stateDir, 'snapshots', `${id}.json`), 16 * 1024 * 1024);
      const store = await SnapshotStore.load(this.stateDir, id);
      if (store.manifest.repositoryPath !== repositoryPath || store.manifest.identity.repositoryId !== sha256(repositoryPath) ||
        (configurationFingerprint !== undefined && store.manifest.identity.configurationFingerprint !== configurationFingerprint) ||
        !['staged', 'worktree', 'commits'].includes(store.manifest.input.kind)) throw new Error('Snapshot identity mismatch');
      return store;
    } catch { throw new WorkbenchError('REPORT_INTEGRITY', 'The frozen snapshot could not be verified for this repository.', 409); }
  }

  private runMetadata(run: RunManifest): HistoryItem {
    const createdAt = normalizedTime(run.createdAt);
    return { id: run.runId, runId: run.runId, repositoryPath: run.repositoryPath, projectId: this.project.id,
      workspaceId: this.workspace(run.repositoryPath).id, ...fallbackTitle({ scope: null, createdAt }), createdAt,
      ...(run.finishedAt ? { finishedAt: normalizedTime(run.finishedAt) } : {}), status: run.status === 'delivery_failed' ? 'delivery_failed' : 'running',
      scope: null, model: { provider: run.model.provider, modelId: run.model.modelId }, snapshotId: run.snapshotId,
      reportAvailability: 'not_delivered', ...(run.status === 'running' ? { liveness: 'unknown' as const } : {}) };
  }

  async verifiedReport(id: string): Promise<{ run: RunManifest; report: ReportDto; snapshot: SnapshotStore; item: HistoryItem }> {
    const run = await this.manifest(id);
    if (run.status !== 'delivered') throw new WorkbenchError('NOT_DELIVERED', 'This review has no confirmed report delivery.', 409);
    try {
      const directory = runPath(this.stateDir, id);
      await this.boundedFile(join(directory, 'report.json'), 16 * 1024 * 1024);
      await this.boundedFile(join(directory, 'report.md'), 16 * 1024 * 1024);
      const native = await readReport(this.stateDir, id);
      const snapshot = await this.snapshot(run.snapshotId, run.repositoryPath, run.configurationFingerprint);
      this.validateReport(native, run, snapshot);
      const after = await this.manifest(id);
      if (after.status !== 'delivered' || after.snapshotId !== run.snapshotId || after.outcome !== run.outcome ||
        after.configurationFingerprint !== run.configurationFingerprint || after.reportSha256 !== run.reportSha256 || after.markdownSha256 !== run.markdownSha256) {
        throw new Error('Delivery changed while reading');
      }
      const report = this.reportDto(native);
      const item: HistoryItem = { ...this.runMetadata(run), status: report.status, scope: snapshot.manifest.input.kind,
        findingCount: report.findings.length, reportAvailability: 'verified' };
      return { run, report, snapshot, item: { ...item, ...verifiedTitle(item, report.summary) } };
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === 'REPOSITORY_MISMATCH') throw error;
      throw new WorkbenchError('REPORT_INTEGRITY', 'Native report delivery or snapshot integrity could not be verified.', 409);
    }
  }

  private validateReport(report: ReviewReport, run: RunManifest, snapshot: SnapshotStore): void {
    if (!isRecord(report) || report.schemaVersion !== 1 || report.publication !== 'not_requested' ||
      !['completed', 'partial', 'failed', 'cancelled'].includes(report.status) || typeof report.summary !== 'string' || report.summary.length > 8192 ||
      !Array.isArray(report.findings) || report.findings.length > 100 || !isRecord(report.coverage)) throw new Error('Invalid report');
    assertSnapshot(report.snapshot);
    if (JSON.stringify(snapshotDto(report.snapshot)) !== JSON.stringify(snapshotDto(snapshot.manifest.identity))) throw new Error('Report snapshot mismatch');
    const ids = new Set<string>();
    for (const finding of report.findings) {
      assertCandidate(finding, snapshot.manifest.identity.id);
      if (ids.has(finding.id)) throw new Error('Duplicate finding');
      ids.add(finding.id);
    }
    if (JSON.stringify(Object.keys(report.coverage).sort()) !== JSON.stringify([...snapshot.manifest.changedPaths].sort()) ||
      Object.values(report.coverage).some(value => !['pending', 'done', 'failed'].includes(value)) ||
      (report.status === 'completed' && (Object.values(report.coverage).some(value => value !== 'done') ||
        (run.termination !== undefined && (run.termination.reason !== 'completed' || run.termination.finalSubmission !== true))))) throw new Error('Report completion mismatch');
  }

  private reportDto(report: ReviewReport): ReportDto {
    return { schemaVersion: 1, runId: report.runId, snapshot: snapshotDto(report.snapshot), status: report.status, summary: report.summary,
      findings: report.findings.map(finding => ({ id: finding.id, title: finding.title, claim: finding.claim, trigger: finding.trigger,
        impact: finding.impact, severity: finding.severity, evidence: finding.evidence.map(evidenceDto) })),
      coverage: Object.fromEntries(Object.entries(report.coverage)), publication: 'not_requested' };
  }

  async runItem(id: string): Promise<HistoryItem | undefined> {
    let run: RunManifest;
    try { run = await this.manifest(id); }
    catch (error) {
      if (error instanceof WorkbenchError && ['NOT_FOUND', 'REPOSITORY_MISMATCH'].includes(error.code)) return undefined;
      throw error;
    }
    const item = this.runMetadata(run);
    try {
      if (run.status === 'delivered') return (await this.verifiedReport(id)).item;
      const snapshot = await this.snapshot(run.snapshotId, run.repositoryPath, run.configurationFingerprint);
      const scoped = { ...item, scope: snapshot.manifest.input.kind };
      return { ...scoped, ...fallbackTitle(scoped) };
    } catch { return unavailable(item); }
  }

  private async receipt(id: string): Promise<Receipt | undefined> {
    if (!isHistoryId(id)) throw new WorkbenchError('INVALID_QUERY', 'A valid review UUID is required.', 400);
    let value: Receipt;
    try {
      const path = join(this.stateDir, 'mcp', 'tasks', id, 'task.json');
      await this.boundedFile(path, 64 * 1024);
      value = JSON.parse(await readFile(path, 'utf8')) as Receipt;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new WorkbenchError('REPORT_INTEGRITY', 'The native task receipt could not be verified.', 409);
    }
    this.workspace(value?.repositoryPath);
    if (value.schemaVersion !== 1 || value.taskId !== id || !isTime(value.createdAt) ||
      (value.finishedAt !== undefined && !isTime(value.finishedAt)) || !isHash(value.requestSha256) || !isRecord(value.owner) ||
      !Number.isSafeInteger(value.owner.pid) || value.owner.pid <= 0 || !isHistoryId(value.owner.id) ||
      (value.runId !== undefined && !isHistoryId(value.runId)) || (value.failure !== undefined && !['failed', 'cancelled'].includes(value.failure)) ||
      (value.noChanges !== undefined && (!isRecord(value.noChanges) || !isHash(value.noChanges.snapshotId) || value.runId !== undefined || value.failure !== undefined || !value.finishedAt)) ||
      (value.failure !== undefined && !value.finishedAt)) throw new WorkbenchError('REPORT_INTEGRITY', 'The native task receipt could not be verified.', 409);
    return value;
  }

  async taskItem(id: string): Promise<HistoryItem | undefined> {
    const receipt = await this.receipt(id);
    if (!receipt) return undefined;
    const owner = liveness(receipt);
    const createdAt = normalizedTime(receipt.createdAt);
    const base: HistoryItem = { id: receipt.runId ?? id, taskId: id, repositoryPath: receipt.repositoryPath,
      projectId: this.project.id, workspaceId: this.workspace(receipt.repositoryPath).id,
      ...fallbackTitle({ scope: null, createdAt }), createdAt,
      ...(receipt.finishedAt ? { finishedAt: normalizedTime(receipt.finishedAt) } : {}), ...(receipt.runId ? { runId: receipt.runId } : {}), status: null,
      scope: null, reportAvailability: 'not_delivered', liveness: owner };
    if (receipt.runId) {
      let native: HistoryItem | undefined;
      try { native = await this.runItem(receipt.runId); }
      catch (error) {
        if (error instanceof WorkbenchError && error.code === 'REPORT_INTEGRITY') return unavailable(base);
        throw error;
      }
      if (!native || native.repositoryPath !== receipt.repositoryPath) return unavailable(base);
      const item = { ...native, taskId: id, liveness: owner };
      if (native.status === 'running') item.status = receipt.failure ?? (owner === 'owner_exited' ? 'interrupted' : 'running');
      return item;
    }
    if (receipt.noChanges) {
      try {
        const snapshot = await this.snapshot(receipt.noChanges.snapshotId, receipt.repositoryPath);
        if (snapshot.manifest.changedPaths.length) return unavailable(base);
        const scoped = { ...base, scope: snapshot.manifest.input.kind };
        return { ...scoped, ...fallbackTitle(scoped), status: 'no_changes', snapshotId: receipt.noChanges.snapshotId };
      } catch { return unavailable(base); }
    }
    if (receipt.failure) return { ...base, status: receipt.failure };
    return { ...base, status: owner === 'owner_exited' ? 'interrupted' : owner === 'owner_present' ? 'accepted' : 'running' };
  }

  async task(id: string): Promise<TaskResponse> {
    const item = await this.taskItem(id) ?? await this.runItem(id);
    if (!item) throw new WorkbenchError('NOT_FOUND', 'Review was not found in the configured repository.', 404);
    return { item, done: item.status !== null && !['accepted', 'running'].includes(item.status), canCancel: false };
  }

  private async checkedEvidence(runId: string, findingId: string, evidenceIndex: number): Promise<{ snapshot: SnapshotStore; ref: EvidenceRefDto; evidenceCount: number }> {
    if (typeof findingId !== 'string' || !findingId || findingId.length > 4000 || !Number.isInteger(evidenceIndex) || evidenceIndex < 0 || evidenceIndex >= 20) {
      throw new WorkbenchError('INVALID_QUERY', 'A finding ID and an evidence index between 0 and 19 are required.', 400);
    }
    const { report, snapshot } = await this.verifiedReport(runId);
    const finding = report.findings.find(item => item.id === findingId);
    if (!finding) throw new WorkbenchError('NOT_FOUND', 'Finding was not found in the verified report.', 404);
    const ref = finding.evidence[evidenceIndex];
    if (!ref) throw new WorkbenchError('NOT_FOUND', 'Evidence was not found in the verified finding.', 404);
    const checked = await checkEvidence({ ...finding, evidence: [ref] }, snapshot);
    if (!checked.ok) throw new WorkbenchError('EVIDENCE_INTEGRITY', 'Frozen evidence failed its source integrity check.', 409);
    return { snapshot, ref, evidenceCount: finding.evidence.length };
  }

  async evidence(runId: string, findingId: string, evidenceIndex: number): Promise<EvidenceResponse> {
    const { snapshot, ref, evidenceCount } = await this.checkedEvidence(runId, findingId, evidenceIndex);
    try {
      const page = await snapshot.source(ref.revision, ref.path, ref.startLine, ref.endLine);
      if (page.contentSha256 !== ref.contentSha256 || page.endLine !== ref.endLine) throw new Error('Evidence changed while reading');
      return { runId, findingId, evidenceIndex, evidenceCount, evidence: evidenceDto(ref),
        source: { snapshotId: page.snapshotId, revision: page.revision, path: page.path, status: page.status, text: page.text,
          startLine: page.startLine, endLine: page.endLine, totalLines: page.totalLines, contentSha256: page.contentSha256,
          truncated: page.truncated, ...(page.hasMoreLines === undefined ? {} : { hasMoreLines: page.hasMoreLines }), warnings: [...page.warnings] } };
    } catch { throw new WorkbenchError('EVIDENCE_INTEGRITY', 'Frozen evidence failed its source integrity check.', 409); }
  }

  async evidenceDiff(runId: string, findingId: string, evidenceIndex: number, query: DiffQuery = {}): Promise<EvidenceDiffResponse> {
    if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['offset', 'limit'].includes(key)) ||
      (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) ||
      (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200))) {
      throw new WorkbenchError('INVALID_QUERY', 'Diff offset and a limit between 1 and 200 are required.', 400);
    }
    const { snapshot, ref, evidenceCount } = await this.checkedEvidence(runId, findingId, evidenceIndex);
    try {
      const baseFile = snapshot.manifest.base[ref.path], headFile = snapshot.manifest.head[ref.path];
      const before = baseFile?.status === 'text' ? await snapshot.text('base', ref.path) : null;
      const after = headFile?.status === 'text' ? await snapshot.text('head', ref.path) : null;
      const input = { snapshotId: ref.snapshotId, path: ref.path, before, after, baseMode: baseFile?.mode ?? null, headMode: headFile?.mode ?? null };
      if ((baseFile && baseFile.status !== 'text') || (headFile && headFile.status !== 'text')) {
        const side = (file: typeof baseFile | undefined, text: string | null): DiffSideDto => {
          let totalLines = 0;
          if (text !== null) {
            for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) totalLines++;
            if (text && !text.endsWith('\n')) totalLines++;
          }
          return { exists: Boolean(file), contentSha256: text === null ? null : sha256(text), totalLines,
            endsWithNewline: text === null ? null : text.endsWith('\n'), mode: file?.mode ?? null };
        };
        const changeType = !baseFile && headFile ? 'added' : baseFile && !headFile ? 'deleted' :
          baseFile?.hash === headFile?.hash && baseFile?.mode === headFile?.mode ? 'unchanged' : 'modified';
        return { runId, findingId, evidenceIndex, evidenceCount, evidence: evidenceDto(ref), diff: {
          snapshotId: ref.snapshotId, path: ref.path, status: 'unavailable', changeType, base: side(baseFile, before), head: side(headFile, after),
          rows: [], offset: 0, totalRows: 0, nextOffset: null, truncated: false,
          warnings: ['The frozen file has an unsupported revision; a text diff is unavailable.'],
        } };
      }
      return { runId, findingId, evidenceIndex, evidenceCount, evidence: evidenceDto(ref), diff: buildEvidenceDiff(input, query) };
    } catch (error) {
      if (error instanceof WorkbenchError && error.code === 'INVALID_QUERY') throw error;
      throw new WorkbenchError('EVIDENCE_INTEGRITY', 'Frozen evidence failed its source integrity check.', 409);
    }
  }
}
