export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  arms TEXT NOT NULL,               -- JSON array of arm codes, e.g. ["A","B"]
  block_size INTEGER NOT NULL,
  seed TEXT NOT NULL,               -- randomization seed, hidden from operators
  created_at TEXT NOT NULL
);

CREATE TABLE protocol_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  version TEXT NOT NULL,
  effective_from TEXT NOT NULL,     -- ISO instant; rules apply from this time
  visit_windows TEXT NOT NULL,      -- JSON: [{name, target_day, minus_days, plus_days}]
  created_at TEXT NOT NULL,
  UNIQUE (trial_id, version)
);

CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,           -- IANA tz, e.g. "Asia/Shanghai"
  UNIQUE (trial_id, code)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('operator','blinded','unblinded','admin'))
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  anon_code TEXT NOT NULL UNIQUE,   -- anonymous identifier only; no PII stored
  stratum TEXT NOT NULL,            -- JSON of stratification factors
  status TEXT NOT NULL CHECK (status IN
    ('screening','eligible','assigned','withdrawn','screen_failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE screenings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  criteria TEXT NOT NULL,           -- JSON of inclusion/exclusion answers
  eligible INTEGER NOT NULL,        -- 0/1
  recorded_at TEXT NOT NULL
);

CREATE TABLE consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  consent_version TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  withdrawn_at TEXT
);

CREATE TABLE random_sequences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trial_id INTEGER NOT NULL REFERENCES trials(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  stratum_key TEXT NOT NULL,
  seq_no INTEGER NOT NULL,
  block_no INTEGER NOT NULL,
  arm TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','consumed')) DEFAULT 'available',
  consumed_by INTEGER REFERENCES subjects(id),
  consumed_at TEXT,
  UNIQUE (trial_id, site_id, stratum_key, seq_no)
);

CREATE TABLE assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) UNIQUE,
  sequence_id INTEGER NOT NULL REFERENCES random_sequences(id) UNIQUE,
  arm TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

CREATE TABLE visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  visit_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL,        -- ISO instant of the visit
  protocol_version TEXT NOT NULL,   -- version effective at occurred_at
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  in_window INTEGER NOT NULL,       -- immutable judgement at record time
  created_at TEXT NOT NULL,
  UNIQUE (subject_id, visit_name)
);

CREATE TABLE deviations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  protocol_version TEXT NOT NULL,   -- version used for judgement
  is_deviation INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE unblindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  emergency INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL,              -- 'main' | 'withdrawal' | 'misrandomization' | 'unblinding'
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL,             -- JSON
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_chain ON audit_log(chain, id);
`,
  },
];
