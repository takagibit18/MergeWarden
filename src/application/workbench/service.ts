import { basename, isAbsolute } from 'node:path';
import type { DiffQuery, EvidenceDiffResponse, EvidenceResponse, HistoryQuery, HistoryResponse, ProjectDto, ProjectsResponse, RegisterProjectInput, RegisterWorkspaceInput, ReportResponse, TaskResponse } from '../../../packages/contracts/src/types.ts';
import { REVIEW_SCOPES, REVIEW_STATUSES } from '../../../packages/contracts/src/constants.ts';
import { isSha256 } from '../../domain/validation.ts';
import { inside } from '../../infrastructure/files.ts';
import { WorkbenchError } from '../../ports/workbench.ts';
import type { ProjectRegistration, WorkbenchStorage } from '../../ports/workbench.ts';
import { HistorySync } from './history-sync.ts';
import { VerifiedArtifacts } from './verified-artifacts.ts';

const QUERY_KEYS = ['status', 'scope', 'workspaceId', 'limit', 'cursor'];
const REGISTRATION_KEYS = ['repositoryPath', 'name'];
const hasControl = (value: string) => /[\x00-\x1f\x7f]/.test(value);
const defaultName = (path: string) => basename(path).slice(0, 80).trim() || 'Repository';

/** Translate unexpected storage faults into one public error; domain errors pass through. */
function stored<T>(operation: () => T, message: string): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof WorkbenchError) throw error;
    throw new WorkbenchError('STORAGE_UNAVAILABLE', message, 503);
  }
}

function historyQuery(input: HistoryQuery): HistoryQuery & { limit: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !QUERY_KEYS.includes(key)) ||
    (input.status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(input.status)) ||
    (input.scope !== undefined && !(REVIEW_SCOPES as readonly string[]).includes(input.scope)) ||
    (input.workspaceId !== undefined && !isSha256(input.workspaceId)) ||
    (input.cursor !== undefined && typeof input.cursor !== 'string')) throw new WorkbenchError('INVALID_QUERY', 'History filters are invalid.', 400);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new WorkbenchError('INVALID_QUERY', 'History limit must be between 1 and 50.', 400);
  return { ...input, limit };
}

/** Project-bound read access over explicit host registration and native delivery gates. */
export class WorkbenchService {
  readonly repositoryPath: string;
  readonly defaultProjectId: string;
  private storage: WorkbenchStorage;
  private history: HistorySync;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(storage: WorkbenchStorage, project: ProjectDto, batchSize: number) {
    this.storage = storage;
    this.repositoryPath = project.repositoryPath; this.defaultProjectId = project.id;
    this.history = new HistorySync({ projection: storage.projection, stateDir: storage.stateDir, createScanner: storage.createScanner, batchSize });
  }

  /** Takes ownership of the storage and registers its launch repository as the default project. */
  static async open(storage: WorkbenchStorage, options: { syncBatchSize?: number } = {}): Promise<WorkbenchService> {
    try {
      const batchSize = options.syncBatchSize ?? 100;
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new WorkbenchError('INVALID_QUERY', 'Sync batch size must be between 1 and 1000.', 400);
      const { repositoryPath, commonGitDirectory } = storage.launchRepository;
      const project = stored(() => storage.registry.registerProject({ repositoryPath, commonGitDirectory, name: defaultName(repositoryPath), registeredAt: new Date().toISOString() }),
        'Workbench storage could not be opened for this repository.');
      stored(() => storage.projection.adopt(project), 'Workbench storage could not be opened for this repository.');
      return new WorkbenchService(storage, project, batchSize);
    } catch (error) {
      storage.close();
      throw error;
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
    return stored(() => this.storage.registry.project(projectId), 'The project registry could not be read.');
  }

  private artifacts(projectId: string): VerifiedArtifacts {
    return new VerifiedArtifacts(this.project(projectId), this.storage.stateDir);
  }

  async listProjects(): Promise<ProjectsResponse> {
    this.requireOpen();
    return { defaultProjectId: this.defaultProjectId, projects: stored(() => this.storage.registry.projects(), 'The project registry could not be read.') };
  }

  private async registration(input: RegisterProjectInput | RegisterWorkspaceInput): Promise<ProjectRegistration> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !REGISTRATION_KEYS.includes(key)) ||
      typeof input.repositoryPath !== 'string' || !input.repositoryPath.trim() || input.repositoryPath.length > 4096 || hasControl(input.repositoryPath) ||
      !isAbsolute(input.repositoryPath.trim()) || (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() ||
        input.name.trim().length > 80 || hasControl(input.name)))) {
      throw new WorkbenchError('INVALID_QUERY', 'An absolute repository root and an optional name of at most 80 characters are required.', 400);
    }
    let directory;
    try { directory = await this.storage.resolveRepository(input.repositoryPath.trim()); }
    catch { throw new WorkbenchError('INVALID_QUERY', 'The supplied directory must be an existing Git repository root.', 400); }
    const { stateDir } = this.storage;
    if (inside(directory.repositoryPath, stateDir) || inside(stateDir, directory.repositoryPath)) {
      throw new WorkbenchError('INVALID_QUERY', 'The state directory must be separate from every registered directory.', 400);
    }
    return { ...directory, name: input.name?.trim() ?? defaultName(directory.repositoryPath), registeredAt: new Date().toISOString() };
  }

  async registerProject(input: RegisterProjectInput): Promise<ProjectDto> {
    this.requireOpen();
    return this.enqueue(async () => {
      const registration = await this.registration(input);
      const project = stored(() => this.storage.registry.registerProject(registration), 'The project could not be registered.');
      stored(() => this.storage.projection.adopt(project), 'The project could not be registered.');
      return project;
    });
  }

  async registerWorkspace(projectId: string, input: RegisterWorkspaceInput): Promise<ProjectDto> {
    this.requireOpen();
    return this.enqueue(async () => {
      this.project(projectId);
      const registration = await this.registration(input);
      const project = stored(() => this.storage.registry.registerWorkspace(projectId, registration), 'The project directory could not be registered.');
      stored(() => this.storage.projection.adopt(project), 'The project directory could not be registered.');
      await this.history.forget(projectId);
      return project;
    });
  }

  async listReviews(projectId: string, input: HistoryQuery = {}): Promise<HistoryResponse> {
    this.requireOpen();
    const query = historyQuery(input);
    return this.enqueue(async () => {
      const project = this.project(projectId);
      if (query.workspaceId !== undefined && !project.workspaces.some(workspace => workspace.id === query.workspaceId)) {
        throw new WorkbenchError('NOT_FOUND', 'Directory was not found in this project.', 404);
      }
      const sync = await this.history.sync(project);
      const page = stored(() => this.storage.projection.list(project, query), 'The history projection could not be read.');
      return { projectId: project.id, repositoryPath: project.repositoryPath, ...page, sync };
    });
  }

  async task(projectId: string, id: string): Promise<TaskResponse> {
    return this.artifacts(projectId).task(id);
  }

  async report(projectId: string, runId: string): Promise<ReportResponse> {
    const result = await this.artifacts(projectId).verifiedReport(runId);
    return { review: result.item, deliveryVerified: true, report: result.report };
  }

  async evidence(projectId: string, runId: string, findingId: string, evidenceIndex = 0): Promise<EvidenceResponse> {
    return this.artifacts(projectId).evidence(runId, findingId, evidenceIndex);
  }

  async evidenceDiff(projectId: string, runId: string, findingId: string, evidenceIndex = 0, query: DiffQuery = {}): Promise<EvidenceDiffResponse> {
    return this.artifacts(projectId).evidenceDiff(runId, findingId, evidenceIndex, query);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    try { await this.history.close(); }
    finally { this.storage.close(); }
  }
}
