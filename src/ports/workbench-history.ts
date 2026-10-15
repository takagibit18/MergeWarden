import type { HistoryItem, HistoryQuery, ProjectDto } from '../../packages/contracts/src/types.ts';

export type HistorySourceKind = 'run' | 'task';
export interface ProjectionUpdate { kind: HistorySourceKind; sourceId: string; epoch: string; item?: HistoryItem }
export interface CompletedHistorySweep { kind: HistorySourceKind; epoch: string; startedAt: string }
export interface ProjectRegistration {
  repositoryPath: string;
  commonGitDirectory: string;
  name: string;
  registeredAt: string;
}

export interface WorkbenchHistoryPort {
  registerProject(input: ProjectRegistration): ProjectDto;
  registerWorkspace(projectId: string, input: ProjectRegistration): ProjectDto;
  project(projectId: string): ProjectDto;
  projects(): ProjectDto[];
  apply(updates: ProjectionUpdate[], completed: CompletedHistorySweep[], syncedAt: string, projectId?: string): void;
  sourceItem(kind: HistorySourceKind, id: string, projectId?: string): HistoryItem | undefined;
  lastSyncedAt(projectId?: string): string | null;
  list(query: HistoryQuery & { limit: number }, projectId?: string): { items: HistoryItem[]; nextCursor: string | null };
  close(): void;
}
