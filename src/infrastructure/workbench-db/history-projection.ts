import type { SQLInputValue } from 'node:sqlite';
import type { HistoryItem, HistoryQuery, ProjectDto } from '../../../packages/contracts/src/types.ts';
import { isUuid } from '../../domain/validation.ts';
import { sha256 } from '../files.ts';
import { WorkbenchError } from '../../ports/workbench.ts';
import type { CompletedHistorySweep, HistoryProjectionPort, HistorySourceKind, ProjectionUpdate } from '../../ports/workbench.ts';
import type { WorkbenchDatabase } from './database.ts';

interface Cursor { version: 2; query: string; at: string; id: string }
interface ItemRow { repository_id: string; item_json: string; item_sha256: string }
/** Rows written before titles moved to the browser may still carry a generated fallback title. */
type StoredItem = HistoryItem & { titleSource?: string };

/** Rebuildable history metadata. Native artifacts stay the source of truth; rows may be dropped at any time. */
export class HistoryProjection implements HistoryProjectionPort {
  private database: WorkbenchDatabase;

  constructor(database: WorkbenchDatabase) { this.database = database; }

  private get sql() { return this.database.connection; }

  adopt(project: ProjectDto): void {
    this.database.transaction(() => {
      const update = this.sql.prepare('UPDATE history_entries SET project_id=? WHERE repository_id=? AND project_id IS NULL');
      for (const workspace of project.workspaces) update.run(project.id, workspace.id);
    });
  }

  apply(project: ProjectDto, updates: ProjectionUpdate[], completed: CompletedHistorySweep[], syncedAt: string): void {
    const allowed = new Map(project.workspaces.map(workspace => [workspace.path, workspace.id]));
    this.database.transaction(() => {
      const insert = this.sql.prepare(`INSERT INTO history_entries(repository_id,source_kind,source_id,history_id,created_at,status,scope,delivery_verified,item_json,item_sha256,seen_epoch,seen_at,project_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repository_id,source_kind,source_id) DO UPDATE SET
        history_id=excluded.history_id,created_at=excluded.created_at,status=excluded.status,scope=excluded.scope,
        delivery_verified=excluded.delivery_verified,item_json=excluded.item_json,item_sha256=excluded.item_sha256,
        seen_epoch=excluded.seen_epoch,seen_at=excluded.seen_at,project_id=excluded.project_id`);
      const remove = this.sql.prepare('DELETE FROM history_entries WHERE project_id=? AND source_kind=? AND source_id=?');
      for (const update of updates) {
        if (!update.item) { remove.run(project.id, update.kind, update.sourceId); continue; }
        const repositoryId = allowed.get(update.item.repositoryPath);
        if (!repositoryId || (update.item.projectId !== undefined && update.item.projectId !== project.id) ||
          (update.item.workspaceId !== undefined && update.item.workspaceId !== repositoryId)) throw new Error('Projection project membership mismatch');
        const item = { ...update.item, projectId: project.id, workspaceId: repositoryId };
        const json = JSON.stringify(item);
        insert.run(repositoryId, update.kind, update.sourceId, item.id, item.createdAt, item.status,
          item.scope, item.reportAvailability === 'verified' ? 1 : 0, json, sha256(json), update.epoch, syncedAt, project.id);
      }
      // An observation by another process after this sweep started must survive.
      const sweep = this.sql.prepare('DELETE FROM history_entries WHERE project_id=? AND source_kind=? AND seen_at<?');
      for (const { kind, startedAt } of completed) sweep.run(project.id, kind, startedAt);
      const synced = this.sql.prepare('INSERT INTO projection_sync(repository_id,last_synced_at) VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET last_synced_at=excluded.last_synced_at');
      for (const workspace of project.workspaces) synced.run(workspace.id, syncedAt);
    });
  }

  private item(row: ItemRow, project: ProjectDto): HistoryItem {
    if (sha256(row.item_json) !== row.item_sha256) throw new Error('Projection item integrity mismatch');
    const item = JSON.parse(row.item_json) as StoredItem;
    const workspace = project.workspaces.find(workspace => workspace.id === row.repository_id);
    if (!workspace || item.repositoryPath !== workspace.path || (item.projectId !== undefined && item.projectId !== project.id) ||
      (item.workspaceId !== undefined && item.workspaceId !== workspace.id)) throw new Error('Projection project membership mismatch');
    const summaryTitle = item.titleSource !== 'fallback' && typeof item.title === 'string' && item.title.length > 0 &&
      item.title.length <= 160 && !/[\x00-\x1f\x7f]/.test(item.title);
    return { id: item.id, projectId: project.id, workspaceId: workspace.id, repositoryPath: workspace.path,
      ...(summaryTitle ? { title: item.title } : {}), createdAt: item.createdAt, status: item.status, scope: item.scope,
      reportAvailability: item.reportAvailability, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.runId ? { runId: item.runId } : {}),
      ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}), ...(item.snapshotId ? { snapshotId: item.snapshotId } : {}),
      ...(item.model ? { model: { provider: item.model.provider, modelId: item.model.modelId } } : {}),
      ...(item.findingCount === undefined ? {} : { findingCount: item.findingCount }),
      ...(item.knownAcceptedCount === undefined ? {} : { knownAcceptedCount: item.knownAcceptedCount }), ...(item.liveness ? { liveness: item.liveness } : {}),
      ...(item.error ? { error: { code: item.error.code, message: item.error.message } } : {}) };
  }

  sourceItem(project: ProjectDto, kind: HistorySourceKind, id: string): HistoryItem | undefined {
    const row = this.sql.prepare('SELECT repository_id,item_json,item_sha256 FROM history_entries WHERE project_id=? AND source_kind=? AND source_id=?')
      .get(project.id, kind, id) as ItemRow | undefined;
    return row ? this.item(row, project) : undefined;
  }

  lastSyncedAt(project: ProjectDto): string | null {
    const ids = project.workspaces.map(workspace => workspace.id);
    const row = this.sql.prepare(`SELECT MAX(last_synced_at) AS last_synced_at FROM projection_sync
      WHERE repository_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { last_synced_at: string | null };
    return row.last_synced_at;
  }

  list(project: ProjectDto, query: HistoryQuery & { limit: number }): { items: HistoryItem[]; nextCursor: string | null } {
    const fingerprint = sha256(JSON.stringify([project.id, project.workspaces.map(workspace => workspace.id).sort(), query.workspaceId ?? null, query.status ?? null, query.scope ?? null]));
    let cursor: Cursor | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Cursor;
        if (parsed.version !== 2 || parsed.query !== fingerprint || typeof parsed.at !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || !isUuid(parsed.id)) throw new Error();
        cursor = parsed;
      } catch { throw new WorkbenchError('INVALID_QUERY', 'Cursor does not belong to this project, registered directories and filter.', 400); }
    }
    const filters = ['e.project_id=?', `NOT EXISTS (
      SELECT 1 FROM history_entries preferred WHERE preferred.project_id=e.project_id AND preferred.history_id=e.history_id
      AND (preferred.delivery_verified,preferred.source_kind,preferred.source_id)>(e.delivery_verified,e.source_kind,e.source_id)
    )`];
    const values: SQLInputValue[] = [project.id];
    if (query.workspaceId !== undefined) { filters.push('e.repository_id=?'); values.push(query.workspaceId); }
    if (query.status !== undefined) { filters.push('e.status=?'); values.push(query.status); }
    if (query.scope !== undefined) { filters.push('e.scope=?'); values.push(query.scope); }
    if (cursor) { filters.push('(e.created_at,e.history_id)<(?,?)'); values.push(cursor.at, cursor.id); }
    values.push(query.limit + 1);
    const rows = this.sql.prepare(`SELECT e.item_json,e.item_sha256,e.repository_id FROM history_entries e
      WHERE ${filters.join(' AND ')} ORDER BY e.created_at DESC,e.history_id DESC LIMIT ?`).all(...values) as unknown as ItemRow[];
    const items = rows.slice(0, query.limit).map(row => this.item(row, project));
    const last = items.at(-1);
    const nextCursor = rows.length > items.length && last ? Buffer.from(JSON.stringify({ version: 2, query: fingerprint, at: last.createdAt, id: last.id })).toString('base64url') : null;
    return { items, nextCursor };
  }
}
