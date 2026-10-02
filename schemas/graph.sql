-- v4 immutable entity-graph generation. Extraction checkpoints are separate.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;

CREATE TABLE graph_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version = 4),
  resolver_version TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  graph_scope TEXT NOT NULL CHECK(graph_scope IN ('core','all')),
  revision TEXT NOT NULL CHECK(revision = 'head'),
  state TEXT NOT NULL CHECK(state IN ('ready','partial')),
  cache_identity TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  coverage TEXT NOT NULL,
  warnings TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  entity_count INTEGER NOT NULL,
  site_count INTEGER NOT NULL,
  relation_count INTEGER NOT NULL,
  relation_site_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE files (
  snapshot_id TEXT NOT NULL REFERENCES graph_snapshots(snapshot_id),
  path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('production','test','example','benchmark','generated','vendor')),
  layer TEXT NOT NULL CHECK(layer IN ('changed','production','supplemental')),
  included INTEGER NOT NULL CHECK(included IN (0,1)),
  parse_status TEXT NOT NULL CHECK(parse_status IN ('complete','incomplete','unsupported','omitted','failed','excluded')),
  line_count INTEGER CHECK(line_count IS NULL OR line_count >= 0),
  PRIMARY KEY(snapshot_id,path)
);

CREATE TABLE entities (
  snapshot_id TEXT NOT NULL REFERENCES graph_snapshots(snapshot_id),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('directory','file','class','function')),
  function_kind TEXT CHECK(function_kind IS NULL OR function_kind IN ('function','method')),
  path TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  parent_entity_id TEXT,
  CHECK(start_line >= 0 AND end_line >= start_line AND start_column >= 0 AND end_column >= 0),
  PRIMARY KEY(snapshot_id,entity_id),
  FOREIGN KEY(snapshot_id,parent_entity_id) REFERENCES entities(snapshot_id,entity_id) DEFERRABLE INITIALLY DEFERRED
);

-- Candidate/unresolved information is diagnostic site data, never a traversable edge.
CREATE TABLE dependency_sites (
  snapshot_id TEXT NOT NULL REFERENCES graph_snapshots(snapshot_id),
  site_id TEXT NOT NULL,
  site_kind TEXT NOT NULL CHECK(site_kind IN ('call','inherit','import')),
  owner_entity_id TEXT NOT NULL,
  path TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  expression TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved_scoped','resolved_import_alias','candidate','unresolved')),
  candidate_target_ids TEXT NOT NULL,
  rule_source TEXT,
  declaration_order INTEGER,
  CHECK(start_line >= 1 AND end_line >= start_line AND start_column >= 0 AND end_column >= 0),
  PRIMARY KEY(snapshot_id,site_id),
  FOREIGN KEY(snapshot_id,owner_entity_id) REFERENCES entities(snapshot_id,entity_id),
  FOREIGN KEY(snapshot_id,path) REFERENCES files(snapshot_id,path)
);

-- One row per semantic (source,target,kind,resolution) relation.
CREATE TABLE relations (
  snapshot_id TEXT NOT NULL REFERENCES graph_snapshots(snapshot_id),
  relation_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CONTAINS','IMPORTS','CALLS','INHERITS')),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved_scoped','resolved_import_alias')),
  resolver_version TEXT NOT NULL,
  site_count INTEGER NOT NULL CHECK(site_count > 0),
  PRIMARY KEY(snapshot_id,relation_id),
  FOREIGN KEY(snapshot_id,source_entity_id) REFERENCES entities(snapshot_id,entity_id),
  FOREIGN KEY(snapshot_id,target_entity_id) REFERENCES entities(snapshot_id,entity_id)
);

-- Compact per-site attribution for an aggregated relation; no repeated edge payload.
CREATE TABLE relation_sites (
  snapshot_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  declaration_order INTEGER,
  CHECK(start_line >= 0 AND end_line >= start_line AND start_column >= 0 AND end_column >= 0),
  PRIMARY KEY(snapshot_id,relation_id,site_id),
  FOREIGN KEY(snapshot_id,relation_id) REFERENCES relations(snapshot_id,relation_id)
);

CREATE INDEX incoming_relations ON relations(snapshot_id,target_entity_id,kind,relation_id);
CREATE INDEX outgoing_relations ON relations(snapshot_id,source_entity_id,kind,relation_id);
CREATE INDEX entity_names ON entities(snapshot_id,name,qualified_name,entity_id);
CREATE INDEX relation_site_order ON relation_sites(snapshot_id,relation_id,site_id);
CREATE INDEX dependency_site_owner ON dependency_sites(snapshot_id,owner_entity_id,site_kind,site_id);
