import type { DatabaseSync } from 'node:sqlite';

export const WORKBENCH_SCHEMA_VERSION = 4;

const migrations = [
  `CREATE TABLE repositories (
    repository_id TEXT PRIMARY KEY,
    repository_path TEXT NOT NULL UNIQUE,
    CHECK(length(repository_id) = 64)
  ) STRICT;
  CREATE TABLE history_entries (
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('run', 'task')),
    source_id TEXT NOT NULL,
    history_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT CHECK(status IS NULL OR status IN ('accepted','running','completed','partial','failed','cancelled','no_changes','delivery_failed','interrupted')),
    scope TEXT CHECK(scope IS NULL OR scope IN ('staged','worktree','commits')),
    delivery_verified INTEGER NOT NULL CHECK(delivery_verified IN (0,1)),
    item_json TEXT NOT NULL,
    item_sha256 TEXT NOT NULL CHECK(length(item_sha256) = 64),
    seen_epoch TEXT NOT NULL,
    PRIMARY KEY(repository_id, source_kind, source_id)
  ) STRICT;`,
  `CREATE TABLE projection_sync (
    repository_id TEXT PRIMARY KEY REFERENCES repositories(repository_id) ON DELETE CASCADE,
    last_synced_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX history_order ON history_entries(repository_id, created_at DESC, history_id DESC);
  CREATE INDEX history_status ON history_entries(repository_id, status, created_at DESC, history_id DESC);
  CREATE INDEX history_scope ON history_entries(repository_id, scope, created_at DESC, history_id DESC);
  CREATE INDEX history_status_scope ON history_entries(repository_id, status, scope, created_at DESC, history_id DESC);
  CREATE INDEX history_preferred ON history_entries(repository_id, history_id, delivery_verified DESC, source_kind DESC, source_id DESC);
  CREATE INDEX history_sources ON history_entries(repository_id, source_kind, seen_epoch);`,
  `ALTER TABLE history_entries ADD COLUMN seen_at TEXT NOT NULL DEFAULT '';
  DROP INDEX history_sources;
  CREATE INDEX history_observed ON history_entries(repository_id,source_kind,seen_at);`,
  `CREATE TABLE projects (
    project_id TEXT PRIMARY KEY CHECK(length(project_id)=36),
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    primary_repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    common_git_directory TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE project_workspaces (
    workspace_id TEXT PRIMARY KEY REFERENCES repositories(repository_id),
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
    kind TEXT NOT NULL CHECK(kind IN ('primary','worktree')),
    registered_at TEXT NOT NULL
  ) STRICT;
  CREATE UNIQUE INDEX project_primary_workspace ON project_workspaces(project_id) WHERE kind='primary';
  CREATE INDEX project_workspace_membership ON project_workspaces(project_id,workspace_id);
  ALTER TABLE history_entries ADD COLUMN project_id TEXT REFERENCES projects(project_id);
  DROP INDEX history_order;
  DROP INDEX history_status;
  DROP INDEX history_scope;
  DROP INDEX history_status_scope;
  DROP INDEX history_preferred;
  DROP INDEX history_observed;
  CREATE INDEX history_order ON history_entries(project_id,created_at DESC,history_id DESC);
  CREATE INDEX history_status ON history_entries(project_id,status,created_at DESC,history_id DESC);
  CREATE INDEX history_scope ON history_entries(project_id,scope,created_at DESC,history_id DESC);
  CREATE INDEX history_status_scope ON history_entries(project_id,status,scope,created_at DESC,history_id DESC);
  CREATE INDEX history_preferred ON history_entries(project_id,history_id,delivery_verified DESC,source_kind DESC,source_id DESC);
  CREATE INDEX history_observed ON history_entries(project_id,source_kind,seen_at);
  CREATE INDEX history_workspace_order ON history_entries(project_id,repository_id,created_at DESC,history_id DESC);
  CREATE INDEX history_workspace_status ON history_entries(project_id,repository_id,status,created_at DESC,history_id DESC);
  CREATE INDEX history_workspace_scope ON history_entries(project_id,repository_id,scope,created_at DESC,history_id DESC);
  CREATE INDEX history_workspace_status_scope ON history_entries(project_id,repository_id,status,scope,created_at DESC,history_id DESC);`,
] as const;

export function migrateWorkbenchDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  let version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (!Number.isSafeInteger(version) || version < 0 || version > WORKBENCH_SCHEMA_VERSION) throw new Error('Unsupported workbench database version');
  while (version < WORKBENCH_SCHEMA_VERSION) {
    database.exec('BEGIN IMMEDIATE');
    try {
      // A different connection may have migrated while this one waited for
      // the write lock. Read the version again before applying a migration.
      version = Number((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (!Number.isSafeInteger(version) || version < 0 || version > WORKBENCH_SCHEMA_VERSION) throw new Error('Unsupported workbench database version');
      if (version < WORKBENCH_SCHEMA_VERSION) {
        database.exec(migrations[version]!);
        database.exec(`PRAGMA user_version=${++version}`);
      }
      database.exec('COMMIT');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* Preserve the migration failure. */ }
      throw error;
    }
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length ||
    (database.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') {
    throw new Error('Workbench database integrity check failed');
  }
}
