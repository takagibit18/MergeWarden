import { lstat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { DiffQuery, EvidenceDiffResponse, EvidenceResponse, HistoryItem, HistoryQuery, HistoryResponse, ProjectDto, ProjectsResponse, RegisterProjectInput, RegisterWorkspaceInput, ReportResponse, TaskResponse } from '../../packages/contracts/src/types.ts';
import { inside, isolatedState } from '../infrastructure/files.ts';
import { WorkbenchIndex } from '../infrastructure/workbench-db/index.ts';
import type { ProjectRegistration, ProjectionUpdate, WorkbenchHistoryPort } from '../ports/workbench-history.ts';
import { isHistoryId, NativeHistorySource } from '../infrastructure/workbench-db/native-source.ts';
import { NativeHistoryScanner } from '../infrastructure/workbench-db/scanner.ts';
import { fallbackTitle } from '../infrastructure/workbench-db/display-title.ts';
import { repositoryDirectory } from '../infrastructure/workbench-db/registration.ts';
import { WorkbenchError } from '../ports/workbench-errors.ts';

export { WorkbenchError } from '../ports/workbench-errors.ts';

const statuses = ['accepted', 'running', 'completed', 'partial', 'failed', 'cancelled', 'no_changes', 'delivery_failed', 'interrupted'];
const scopes = ['staged', 'worktree', 'commits'];

function invalidated(item: HistoryItem): HistoryItem {
  const { findingCount: _count, ...metadata } = item;
  return { ...metadata, ...fallbackTitle(item), status: null, reportAvailability: 'unavailable', error: {
    code: 'REPORT_INTEGRITY', message: 'The native record could not be verified. No report delivery is confirmed.' } };
}

/** Project-bound read access over explicit host registration and native delivery gates. */
export class WorkbenchService {
  readonly repositoryPath: string;
  readonly stateDir: string;
  readonly defaultProjectId: string;
  private index: WorkbenchHistoryPort;
  private scanners = new Map<string, NativeHistoryScanner>();
  private batchSize: number;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(project: ProjectDto, stateDir: string, index: WorkbenchHistoryPort, batchSize: number) {
    this.repositoryPath = project.repositoryPath; this.defaultProjectId = project.id;
    this.stateDir = stateDir; this.index = index; this.batchSize = batchSize;
  }

  static async create(options: { repositoryPath: string; stateDir: string; syncBatchSize?: number }): Promise<WorkbenchService> {
    const batchSize = options.syncBatchSize ?? 100;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new WorkbenchError('INVALID_QUERY', 'Sync batch size must be between 1 and 1000.', 400);
    let index: WorkbenchIndex | undefined;
    try {
      const directory = await repositoryDirectory(options.repositoryPath);
      const stateDir = await isolatedState(options.stateDir, directory.repositoryPath);
      const path = join(stateDir, 'workbench.sqlite');
      try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid projection file'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      index = new WorkbenchIndex(path, directory.repositoryPath);
      const project = index.registerProject({ ...directory, name: basename(directory.repositoryPath).slice(0, 80).trim() || 'Repository', registeredAt: new Date().toISOString() });
      return new WorkbenchService(project, stateDir, index, batchSize);
    } catch (error) {
      index?.close();
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('STORAGE_UNAVAILABLE', 'Workbench storage could not be opened for this repository.', 503);
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new WorkbenchError('STORAGE_UNAVAILABLE', 'Workbench storage is closed.', 503);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(async () => { this.requireOpen(); return operation(); });
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private project(projectId: string): ProjectDto {
    this.requireOpen();
    try { return this.index.project(projectId); }
    catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The project registry could not be read.', 503);
    }
  }

  async listProjects(): Promise<ProjectsResponse> {
    this.requireOpen();
    try { return { defaultProjectId: this.defaultProjectId, projects: this.index.projects() }; }
    catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The project registry could not be read.', 503);
    }
  }

  private async registration(input: RegisterProjectInput | RegisterWorkspaceInput): Promise<ProjectRegistration> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['repositoryPath', 'name'].includes(key)) ||
      typeof input.repositoryPath !== 'string' || !input.repositoryPath.trim() || input.repositoryPath.length > 4096 || /[\x00-\x1f\x7f]/.test(input.repositoryPath) ||
      !isAbsolute(input.repositoryPath.trim()) || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() ||
        input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)))) {
      throw new WorkbenchError('INVALID_QUERY', 'An absolute repository root and an optional name of at most 80 characters are required.', 400);
    }
    try {
      const directory = await repositoryDirectory(input.repositoryPath.trim());
      if (inside(directory.repositoryPath, this.stateDir) || inside(this.stateDir, directory.repositoryPath)) {
        throw new WorkbenchError('INVALID_QUERY', 'The state directory must be separate from every registered directory.', 400);
      }
      return { ...directory, name: input.name?.trim() ?? (basename(directory.repositoryPath).slice(0, 80).trim() || 'Repository'), registeredAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError('INVALID_QUERY', 'The supplied directory must be an existing Git repository root.', 400);
    }
  }

  async registerProject(input: RegisterProjectInput): Promise<ProjectDto> {
    this.requireOpen();
    return this.enqueue(async () => {
      const registration = await this.registration(input);
      try { return this.index.registerProject(registration); }
      catch (error) {
        if (error instanceof WorkbenchError) throw error;
        throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The project could not be registered.', 503);
      }
    });
  }

  async registerWorkspace(projectId: string, input: RegisterWorkspaceInput): Promise<ProjectDto> {
    this.requireOpen();
    return this.enqueue(async () => {
      this.project(projectId);
      const registration = await this.registration(input);
      let project: ProjectDto;
      try { project = this.index.registerWorkspace(projectId, registration); }
      catch (error) {
        if (error instanceof WorkbenchError) throw error;
        throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The project directory could not be registered.', 503);
      }
      const scanner = this.scanners.get(projectId);
      if (scanner) { await scanner.close(); this.scanners.delete(projectId); }
      return project;
    });
  }

  private query(input: HistoryQuery): HistoryQuery & { limit: number } {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['status', 'scope', 'workspaceId', 'limit', 'cursor'].includes(key)) ||
      (input.status !== undefined && !statuses.includes(input.status)) || (input.scope !== undefined && !scopes.includes(input.scope)) ||
      (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !/^[a-f0-9]{64}$/.test(input.workspaceId))) ||
      (input.cursor !== undefined && typeof input.cursor !== 'string')) throw new WorkbenchError('INVALID_QUERY', 'History filters are invalid.', 400);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new WorkbenchError('INVALID_QUERY', 'History limit must be between 1 and 50.', 400);
    return { ...input, limit };
  }

  private async sync(project: ProjectDto): Promise<HistoryResponse['sync']> {
    let scanner = this.scanners.get(project.id);
    if (!scanner) { scanner = new NativeHistoryScanner(this.stateDir); this.scanners.set(project.id, scanner); }
    const source = new NativeHistorySource(project, this.stateDir);
    try {
      const batch = await scanner.scan(this.batchSize);
      const updates: ProjectionUpdate[] = [];
      let skipped = 0;
      for (const entry of batch.sources) {
        const update: ProjectionUpdate = { kind: entry.kind, sourceId: entry.id, epoch: entry.epoch };
        if (!entry.directory || !isHistoryId(entry.id)) { skipped++; updates.push(update); continue; }
        try {
          const item = entry.kind === 'run' ? await source.runItem(entry.id) : await source.taskItem(entry.id);
          if (item) update.item = item;
          if (item?.reportAvailability === 'unavailable') skipped++;
        } catch (error) {
          if (!(error instanceof WorkbenchError) || !['REPORT_INTEGRITY', 'REPOSITORY_MISMATCH', 'NOT_FOUND'].includes(error.code)) throw error;
          if (error.code === 'REPORT_INTEGRITY') {
            const known = this.index.sourceItem(entry.kind, entry.id, project.id);
            if (known) update.item = invalidated(known);
            skipped++;
          }
        }
        updates.push(update);
      }
      const syncedAt = new Date().toISOString();
      this.index.apply(updates, batch.completed, syncedAt, project.id);
      return { lastSyncedAt: this.index.lastSyncedAt(project.id), scanned: batch.sources.length, skipped, truncated: batch.truncated };
    } catch {
      await scanner.close().catch(() => undefined); this.scanners.delete(project.id);
      throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The native history projection could not be synchronized.', 503);
    }
  }

  async listReviews(input: HistoryQuery = {}, projectId = this.defaultProjectId): Promise<HistoryResponse> {
    this.requireOpen();
    const query = this.query(input);
    return this.enqueue(async () => {
      const project = this.project(projectId);
      if (query.workspaceId !== undefined && !project.workspaces.some(workspace => workspace.id === query.workspaceId)) {
        throw new WorkbenchError('NOT_FOUND', 'Directory was not found in this project.', 404);
      }
      const sync = await this.sync(project);
      try { return { projectId: project.id, repositoryPath: project.repositoryPath, ...this.index.list(query, project.id), sync }; }
      catch (error) {
        if (error instanceof WorkbenchError) throw error;
        throw new WorkbenchError('STORAGE_UNAVAILABLE', 'The history projection could not be read.', 503);
      }
    });
  }

  async task(id: string, projectId = this.defaultProjectId): Promise<TaskResponse> {
    this.requireOpen(); return new NativeHistorySource(this.project(projectId), this.stateDir).task(id);
  }

  async report(runId: string, projectId = this.defaultProjectId): Promise<ReportResponse> {
    this.requireOpen();
    const result = await new NativeHistorySource(this.project(projectId), this.stateDir).verifiedReport(runId);
    return { review: result.item, deliveryVerified: true, report: result.report };
  }

  async evidence(runId: string, findingId: string, evidenceIndex = 0, projectId = this.defaultProjectId): Promise<EvidenceResponse> {
    this.requireOpen(); return new NativeHistorySource(this.project(projectId), this.stateDir).evidence(runId, findingId, evidenceIndex);
  }

  async evidenceDiff(runId: string, findingId: string, evidenceIndex = 0, query: DiffQuery = {}, projectId = this.defaultProjectId): Promise<EvidenceDiffResponse> {
    this.requireOpen(); return new NativeHistorySource(this.project(projectId), this.stateDir).evidenceDiff(runId, findingId, evidenceIndex, query);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try { for (const scanner of this.scanners.values()) await scanner.close(); }
    finally { this.scanners.clear(); this.index.close(); }
  }
}
