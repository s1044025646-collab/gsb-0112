PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rand_secret TEXT NOT NULL,
  current_protocol_version_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS protocol_versions (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  version TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  block_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, version)
);

CREATE TABLE IF NOT EXISTS strata (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  factor_key TEXT NOT NULL,
  factor_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, factor_key, factor_value)
);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, code)
);

CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  anon_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('screened','enrolled','withdrawn','randomized_in_error')),
  stratum_signature TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(trial_id, anon_code)
);

CREATE TABLE IF NOT EXISTS eligibility_results (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id),
  passed INTEGER NOT NULL,
  criteria_json TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_events (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  kind TEXT NOT NULL CHECK (kind IN ('given','withdrawn')),
  signed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allocations (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL UNIQUE REFERENCES subjects(id),
  trial_id TEXT NOT NULL REFERENCES trials(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id),
  stratum_signature TEXT NOT NULL,
  sequence_index INTEGER NOT NULL,
  block_index INTEGER NOT NULL,
  arm TEXT NOT NULL,
  allocated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','consumed_in_error')),
  UNIQUE(trial_id, site_id, stratum_signature, sequence_index)
);

CREATE TABLE IF NOT EXISTS visit_windows (
  id TEXT PRIMARY KEY,
  protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id),
  visit_code TEXT NOT NULL,
  offset_days INTEGER NOT NULL,
  window_low_days INTEGER NOT NULL,
  window_high_days INTEGER NOT NULL,
  UNIQUE(protocol_version_id, visit_code)
);

CREATE TABLE IF NOT EXISTS visit_records (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  visit_code TEXT NOT NULL,
  scheduled_from TEXT NOT NULL,
  scheduled_to TEXT NOT NULL,
  occurred_at TEXT,
  protocol_version_at_schedule TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','done','missed')),
  created_at TEXT NOT NULL,
  UNIQUE(subject_id, visit_code)
);

CREATE TABLE IF NOT EXISTS deviations (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  visit_code TEXT,
  protocol_version_id TEXT NOT NULL REFERENCES protocol_versions(id),
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  event_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('coordinator','unblinded_admin','auditor'))
);

CREATE TABLE IF NOT EXISTS unblinding_events (
  id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES allocations(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  reason TEXT NOT NULL CHECK (reason IN ('emergency','authorized_export')),
  justification TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_prev TEXT,
  chain_hash TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  operator_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_allocations_lookup
  ON allocations(trial_id, site_id, stratum_signature, sequence_index);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_deviations_subject ON deviations(subject_id);
