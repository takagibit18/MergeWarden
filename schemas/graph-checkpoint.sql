-- Resumable extraction state. This database is staging only and must never answer queries.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS graph_builds (
  cache_identity TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
  resolver_version TEXT NOT NULL, parser_version TEXT NOT NULL, policy_version TEXT NOT NULL,
  budget TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','resolving','publishing','complete','error')),
  attempts INTEGER NOT NULL DEFAULT 0, failure_kind TEXT, failure_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS file_checkpoints (
  cache_identity TEXT NOT NULL REFERENCES graph_builds(cache_identity), path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','incomplete','unsupported','failed')),
  fact_count INTEGER NOT NULL, facts TEXT, diagnostics TEXT NOT NULL, failure_kind TEXT, failure_reason TEXT,
  committed_at TEXT NOT NULL, PRIMARY KEY(cache_identity,path)
);
CREATE INDEX IF NOT EXISTS checkpoint_status ON file_checkpoints(cache_identity,status,path);
CREATE TABLE IF NOT EXISTS resolution_checkpoints (
  cache_identity TEXT NOT NULL REFERENCES graph_builds(cache_identity), path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL, resolver_version TEXT NOT NULL,
  site_count INTEGER NOT NULL, relation_count INTEGER NOT NULL,
  sites TEXT NOT NULL, relations TEXT NOT NULL, call_counts TEXT NOT NULL,
  committed_at TEXT NOT NULL, PRIMARY KEY(cache_identity,path)
);
CREATE INDEX IF NOT EXISTS resolution_checkpoint_path ON resolution_checkpoints(cache_identity,path);
