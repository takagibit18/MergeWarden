import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import type { HistoryItem, HistoryQuery, ProjectDto, WorkspaceDto } from '../../../packages/contracts/src/types.ts';
import { sha256 } from '../files.ts';
import { WorkbenchError } from '../../ports/workbench-errors.ts';
import { migrateWorkbenchDatabase } from './migrations.ts';
import { fallbackTitle } from './display-title.ts';
import type { CompletedHistorySweep, HistorySourceKind, ProjectRegistration, ProjectionUpdate, WorkbenchHistoryPort } from '../../ports/workbench-history.ts';

interface Cursor { version: 2; query: string; at: string; id: string }
interface ItemRow { repository_id: string; item_json: string; item_sha256: string }
interface ProjectRow { project_id: string; name: string; repository_path: string; common_git_directory: string; created_at: string }
interface WorkspaceRow { workspace_id: string; name: string; repository_path: string; kind: WorkspaceDto['kind']; registered_at: string }
const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const isName = (name: unknown): name is string => typeof name === 'string' && name === name.trim() && name.length > 0 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
const isTime = (time: unknown): time is string => typeof time === 'string' && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;

/** The registry is durable; history rows remain a rebuildable metadata projection. */
export class WorkbenchIndex implements WorkbenchHistoryPort {
  private database: DatabaseSync;
  private repositoryPath: string;

  constructor(path: string, repositoryPath: string) {
    this.repositoryPath = repositoryPath;
    this.database = new DatabaseSync(path, { enableForeignKeyConstraints: true, allowExtension: false });
    try { migrateWorkbenchDatabase(this.database); }
    catch (error) { this.database.close(); throw error; }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.database.exec('COMMIT'); return result; }
    catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* Preserve the storage failure. */ }
      throw error;
    }
  }

  private defaultProject(): string {
    const row = this.database.prepare(`SELECT w.project_id FROM project_workspaces w JOIN repositories r ON r.repository_id=w.workspace_id
      WHERE r.repository_path=?`).get(this.repositoryPath) as { project_id: string } | undefined;
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Project was not found in the workbench registry.', 404);
    return row.project_id;
  }

  private projectRow(projectId: string): ProjectRow {
    if (!isId(projectId)) throw new WorkbenchError('INVALID_QUERY', 'A valid project UUID is required.', 400);
    const row = this.database.prepare(`SELECT p.project_id,p.name,r.repository_path,p.common_git_directory,p.created_at
      FROM projects p JOIN repositories r ON r.repository_id=p.primary_repository_id WHERE p.project_id=?`).get(projectId) as ProjectRow | undefined;
    if (!row) throw new WorkbenchError('NOT_FOUND', 'Project was not found in the workbench registry.', 404);
    if (!isName(row.name) || !isTime(row.created_at) || !row.repository_path || !row.common_git_directory) throw new Error('Invalid project registry record');
    return row;
  }

  project(projectId: string): ProjectDto {
    const row = this.projectRow(projectId);
    const records = this.database.prepare(`SELECT w.workspace_id,w.name,r.repository_path,w.kind,w.registered_at
      FROM project_workspaces w JOIN repositories r ON r.repository_id=w.workspace_id WHERE w.project_id=?
      ORDER BY w.kind='primary' DESC,w.registered_at,w.workspace_id`).all(projectId) as unknown as WorkspaceRow[];
    if (!records.length || records.length > 50) throw new Error('Invalid project workspace membership');
    const workspaces = records.map(record => {
      if (sha256(record.repository_path) !== record.workspace_id || !isName(record.name) || !isTime(record.registered_at) ||
        !['primary', 'worktree'].includes(record.kind)) throw new Error('Invalid workspace registry record');
      return { id: record.workspace_id, name: record.name, path: record.repository_path, kind: record.kind, registeredAt: record.registered_at };
    });
    if (workspaces.filter(workspace => workspace.kind === 'primary').length !== 1 ||
      workspaces.find(workspace => workspace.kind === 'primary')?.path !== row.repository_path) throw new Error('Invalid primary workspace');
    return { id: row.project_id, name: row.name, repositoryPath: row.repository_path, createdAt: row.created_at, workspaces };
  }

  projects(): ProjectDto[] {
    const rows = this.database.prepare('SELECT project_id FROM projects ORDER BY created_at,project_id').all() as unknown as { project_id: string }[];
    if (rows.length > 50) throw new Error('Invalid project registry size');
    return rows.map(row => this.project(row.project_id));
  }

  private registerRepository(path: string): string {
    const repositoryId = sha256(path);
    this.database.prepare('INSERT INTO repositories(repository_id,repository_path) VALUES(?,?) ON CONFLICT(repository_id) DO NOTHING').run(repositoryId, path);
    const row = this.database.prepare('SELECT repository_path FROM repositories WHERE repository_id=?').get(repositoryId) as { repository_path: string };
    if (row.repository_path !== path) throw new Error('Repository projection identity mismatch');
    return repositoryId;
  }

  registerProject(input: ProjectRegistration): ProjectDto {
    return this.transaction(() => {
      const repositoryId = this.registerRepository(input.repositoryPath);
      const existing = this.database.prepare('SELECT project_id FROM project_workspaces WHERE workspace_id=?').get(repositoryId) as { project_id: string } | undefined;
      if (existing) {
        if (this.projectRow(existing.project_id).common_git_directory !== input.commonGitDirectory) {
          throw new WorkbenchError('REPOSITORY_MISMATCH', 'The registered directory now belongs to a different repository.', 409);
        }
        return this.project(existing.project_id);
      }
      const count = this.database.prepare('SELECT count(*) AS n FROM projects').get() as { n: number };
      if (count.n >= 50) throw new WorkbenchError('REGISTRY_LIMIT', 'The workbench supports at most 50 registered projects.', 409);
      const id = randomUUID();
      this.database.prepare('INSERT INTO projects(project_id,name,primary_repository_id,common_git_directory,created_at) VALUES(?,?,?,?,?)')
        .run(id, input.name, repositoryId, input.commonGitDirectory, input.registeredAt);
      this.database.prepare(`INSERT INTO project_workspaces(workspace_id,project_id,name,kind,registered_at) VALUES(?,?,?,'primary',?)`)
        .run(repositoryId, id, input.name, input.registeredAt);
      this.database.prepare('UPDATE history_entries SET project_id=? WHERE repository_id=? AND project_id IS NULL').run(id, repositoryId);
      return this.project(id);
    });
  }

  registerWorkspace(projectId: string, input: ProjectRegistration): ProjectDto {
    return this.transaction(() => {
      const project = this.projectRow(projectId);
      if (project.common_git_directory !== input.commonGitDirectory) throw new WorkbenchError('REPOSITORY_MISMATCH', 'Only a directory from this project repository can be registered.', 409);
      const repositoryId = this.registerRepository(input.repositoryPath);
      const existing = this.database.prepare('SELECT project_id FROM project_workspaces WHERE workspace_id=?').get(repositoryId) as { project_id: string } | undefined;
      if (existing) {
        if (existing.project_id !== projectId) throw new WorkbenchError('WORKSPACE_CONFLICT', 'This directory is registered to another project.', 409);
        return this.project(projectId);
      }
      const count = this.database.prepare('SELECT count(*) AS n FROM project_workspaces WHERE project_id=?').get(projectId) as { n: number };
      if (count.n >= 50) throw new WorkbenchError('REGISTRY_LIMIT', 'A project supports at most 50 registered directories.', 409);
      this.database.prepare(`INSERT INTO project_workspaces(workspace_id,project_id,name,kind,registered_at) VALUES(?,?,?,'worktree',?)`)
        .run(repositoryId, projectId, input.name, input.registeredAt);
      this.database.prepare('UPDATE history_entries SET project_id=? WHERE repository_id=? AND project_id IS NULL').run(projectId, repositoryId);
      return this.project(projectId);
    });
  }

  apply(updates: ProjectionUpdate[], completed: CompletedHistorySweep[], syncedAt: string, projectId = this.defaultProject()): void {
    const project = this.project(projectId);
    const allowed = new Map(project.workspaces.map(workspace => [workspace.path, workspace.id]));
    this.transaction(() => {
      const insert = this.database.prepare(`INSERT INTO history_entries(repository_id,source_kind,source_id,history_id,created_at,status,scope,delivery_verified,item_json,item_sha256,seen_epoch,seen_at,project_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,source_kind,source_id) DO UPDATE SET
        history_id=excluded.history_id,created_at=excluded.created_at,status=excluded.status,scope=excluded.scope,
        delivery_verified=excluded.delivery_verified,item_json=excluded.item_json,item_sha256=excluded.item_sha256,
        seen_epoch=excluded.seen_epoch,seen_at=excluded.seen_at,project_id=excluded.project_id`);
      const remove = this.database.prepare('DELETE FROM history_entries WHERE project_id=? AND source_kind=? AND source_id=?');
      for (const update of updates) {
        if (!update.item) { remove.run(projectId, update.kind, update.sourceId); continue; }
        const repositoryId = allowed.get(update.item.repositoryPath);
        if (!repositoryId || (update.item.projectId !== undefined && update.item.projectId !== projectId) ||
          (update.item.workspaceId !== undefined && update.item.workspaceId !== repositoryId)) throw new Error('Projection project membership mismatch');
        const item = { ...update.item, projectId, workspaceId: repositoryId };
        const json = JSON.stringify(item);
        insert.run(repositoryId, update.kind, update.sourceId, item.id, item.createdAt, item.status,
          item.scope, item.reportAvailability === 'verified' ? 1 : 0, json, sha256(json), update.epoch, syncedAt, projectId);
      }
      // An observation by another process after this sweep started must survive.
      for (const sweep of completed) this.database.prepare('DELETE FROM history_entries WHERE project_id=? AND source_kind=? AND seen_at<?').run(projectId, sweep.kind, sweep.startedAt);
      const synced = this.database.prepare('INSERT INTO projection_sync(repository_id,last_synced_at) VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET last_synced_at=excluded.last_synced_at');
      for (const workspace of project.workspaces) synced.run(workspace.id, syncedAt);
    });
  }

  private item(row: ItemRow, project: ProjectDto): HistoryItem {
    if (sha256(row.item_json) !== row.item_sha256) throw new Error('Projection item integrity mismatch');
    const item = JSON.parse(row.item_json) as HistoryItem;
    const workspace = project.workspaces.find(workspace => workspace.id === row.repository_id);
    if (!workspace || item.repositoryPath !== workspace.path || (item.projectId !== undefined && item.projectId !== project.id) ||
      (item.workspaceId !== undefined && item.workspaceId !== workspace.id)) throw new Error('Projection project membership mismatch');
    const title = typeof item.title === 'string' && item.title.length > 0 && item.title.length <= 160 && !/[\x00-\x1f\x7f]/.test(item.title) &&
      ['summary', 'fallback'].includes(item.titleSource ?? '') ? { title: item.title, titleSource: item.titleSource } : fallbackTitle(item);
    return { id: item.id, projectId: project.id, workspaceId: workspace.id, repositoryPath: workspace.path, ...title,
      createdAt: item.createdAt, status: item.status, scope: item.scope,
      reportAvailability: item.reportAvailability, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.runId ? { runId: item.runId } : {}),
      ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}), ...(item.snapshotId ? { snapshotId: item.snapshotId } : {}),
      ...(item.model ? { model: { provider: item.model.provider, modelId: item.model.modelId } } : {}),
      ...(item.findingCount === undefined ? {} : { findingCount: item.findingCount }), ...(item.liveness ? { liveness: item.liveness } : {}),
      ...(item.error ? { error: { code: item.error.code, message: item.error.message } } : {}) };
  }

  sourceItem(kind: HistorySourceKind, id: string, projectId = this.defaultProject()): HistoryItem | undefined {
    const project = this.project(projectId);
    const row = this.database.prepare('SELECT repository_id,item_json,item_sha256 FROM history_entries WHERE project_id=? AND source_kind=? AND source_id=?').get(projectId, kind, id) as ItemRow | undefined;
    return row ? this.item(row, project) : undefined;
  }

  lastSyncedAt(projectId = this.defaultProject()): string | null {
    this.project(projectId);
    const row = this.database.prepare(`SELECT MAX(s.last_synced_at) AS last_synced_at FROM projection_sync s
      JOIN project_workspaces w ON w.workspace_id=s.repository_id WHERE w.project_id=?`).get(projectId) as { last_synced_at: string | null };
    return row.last_synced_at;
  }

  list(query: HistoryQuery & { limit: number }, projectId = this.defaultProject()): { items: HistoryItem[]; nextCursor: string | null } {
    const project = this.project(projectId);
    if (query.workspaceId !== undefined && !project.workspaces.some(workspace => workspace.id === query.workspaceId)) {
      throw new WorkbenchError('NOT_FOUND', 'Directory was not found in this project.', 404);
    }
    const fingerprint = sha256(JSON.stringify([projectId, project.workspaces.map(workspace => workspace.id).sort(), query.workspaceId ?? null, query.status ?? null, query.scope ?? null]));
    let cursor: Cursor | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor;
        if (parsed.version !== 2 || parsed.query !== fingerprint || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !isId(parsed.id)) throw new Error();
        cursor = parsed;
      } catch { throw new WorkbenchError('INVALID_QUERY', 'Cursor does not belong to this project, registered directories and filter.', 400); }
    }
    const filters = ['e.project_id=?', `NOT EXISTS (
      SELECT 1 FROM history_entries preferred WHERE preferred.project_id=e.project_id AND preferred.history_id=e.history_id
      AND (preferred.delivery_verified,preferred.source_kind,preferred.source_id)>(e.delivery_verified,e.source_kind,e.source_id)
    )`];
    const values: SQLInputValue[] = [projectId];
    if (query.workspaceId !== undefined) { filters.push('e.repository_id=?'); values.push(query.workspaceId); }
    if (query.status !== undefined) { filters.push('e.status=?'); values.push(query.status); }
    if (query.scope !== undefined) { filters.push('e.scope=?'); values.push(query.scope); }
    if (cursor) { filters.push('(e.created_at,e.history_id)<(?,?)'); values.push(cursor.at, cursor.id); }
    values.push(query.limit + 1);
    const rows = this.database.prepare(`SELECT e.item_json,e.item_sha256,e.repository_id FROM history_entries e
      WHERE ${filters.join(' AND ')} ORDER BY e.created_at DESC,e.history_id DESC LIMIT ?`).all(...values) as unknown as ItemRow[];
    const items = rows.slice(0, query.limit).map(row => this.item(row, project));
    const last = items.at(-1);
    const nextCursor = rows.length > items.length && last ? Buffer.from(JSON.stringify({ version: 2, query: fingerprint, at: last.createdAt, id: last.id })).toString('base64url') : null;
    return { items, nextCursor };
  }

  close(): void { this.database.close(); }
}
