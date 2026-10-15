import type { HistoryItem, HistoryQuery, ProjectDto } from '../../packages/contracts/src/types.ts';

export class WorkbenchError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type HistorySourceKind = 'run' | 'task';
export interface ProjectionUpdate { kind: HistorySourceKind; sourceId: string; epoch: string; item?: HistoryItem }
export interface CompletedHistorySweep { kind: HistorySourceKind; epoch: string; startedAt: string }
export interface ScannedSource { kind: HistorySourceKind; id: string; directory: boolean; epoch: string }
export interface ScanBatch { sources: ScannedSource[]; completed: CompletedHistorySweep[]; truncated: boolean }

export interface RepositoryDirectory {
  repositoryPath: string;
  commonGitDirectory: string;
}
export interface ProjectRegistration extends RepositoryDirectory {
  name: string;
  registeredAt: string;
}

/** Durable registry of explicitly registered projects. It cannot be rebuilt from native artifacts. */
export interface ProjectRegistryPort {
  registerProject(input: ProjectRegistration): ProjectDto;
  registerWorkspace(projectId: string, input: ProjectRegistration): ProjectDto;
  project(projectId: string): ProjectDto;
  projects(): ProjectDto[];
}

/** Rebuildable history metadata. Every call is scoped to a project resolved by the registry. */
export interface HistoryProjectionPort {
  /** Attach rows projected before the project existed to its registered directories. */
  adopt(project: ProjectDto): void;
  apply(project: ProjectDto, updates: ProjectionUpdate[], completed: CompletedHistorySweep[], syncedAt: string): void;
  sourceItem(project: ProjectDto, kind: HistorySourceKind, id: string): HistoryItem | undefined;
  lastSyncedAt(project: ProjectDto): string | null;
  list(project: ProjectDto, query: HistoryQuery & { limit: number }): { items: HistoryItem[]; nextCursor: string | null };
}

/** Bounded, resumable walk over native run and task directories. */
export interface HistoryScanner {
  scan(limit: number): Promise<ScanBatch>;
  close(): Promise<void>;
}

/** Everything the workbench service needs from its host; wired by a composition root. */
export interface WorkbenchStorage {
  stateDir: string;
  /** The repository the host launched with; it becomes the default project. */
  launchRepository: RepositoryDirectory;
  registry: ProjectRegistryPort;
  projection: HistoryProjectionPort;
  createScanner(): HistoryScanner;
  resolveRepository(path: string): Promise<RepositoryDirectory>;
  close(): void;
}
