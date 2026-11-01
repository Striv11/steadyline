-- Care operations schema. Times are ISO 8601 UTC strings; money is integer paise.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('patient','caregiver','courier','ops','admin')),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (           -- clinics and depots
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  address TEXT NOT NULL,
  lat     REAL NOT NULL,
  lng     REAL NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('clinic','depot'))
);

CREATE TABLE IF NOT EXISTS patients (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  date_of_birth  TEXT,
  sex            TEXT,
  conditions     TEXT NOT NULL DEFAULT '[]',   -- JSON array of condition codes
  allergies      TEXT NOT NULL DEFAULT '[]',
  address        TEXT NOT NULL DEFAULT '',
  lat            REAL,
  lng            REAL,
  emergency_name TEXT,
  emergency_phone TEXT,
  consent_at     TEXT                           -- data-processing consent timestamp
);

CREATE TABLE IF NOT EXISTS staff (
  user_id   TEXT PRIMARY KEY REFERENCES users(id),
  skills    TEXT NOT NULL DEFAULT '[]',          -- JSON array of skill codes
  license   TEXT,                                -- registration/licence number if clinical
  home_lat  REAL NOT NULL,
  home_lng  REAL NOT NULL,
  site_id   TEXT REFERENCES sites(id),
  max_jobs_per_day INTEGER NOT NULL DEFAULT 8
);

CREATE TABLE IF NOT EXISTS shifts (
  id       TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shifts_staff ON shifts(staff_id, starts_at);

CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('home_visit','clinic_visit','delivery')),
  skill        TEXT NOT NULL,                    -- required staff skill
  duration_min INTEGER NOT NULL,
  price_paise  INTEGER NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL REFERENCES users(id),
  service_id   TEXT NOT NULL REFERENCES services(id),
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  starts_at    TEXT NOT NULL,
  ends_at      TEXT NOT NULL,
  address      TEXT NOT NULL,
  lat          REAL,
  lng          REAL,
  site_id      TEXT REFERENCES sites(id),
  staff_id     TEXT REFERENCES users(id),
  notes        TEXT NOT NULL DEFAULT '',         -- from the patient
  items        TEXT NOT NULL DEFAULT '[]',       -- deliveries: JSON [{name, qty}]
  otp_code     TEXT,                             -- deliveries: shown only to the patient; courier must enter it
  price_paise  INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','waived')),
  payment_method TEXT,
  visit_notes  TEXT,                             -- from staff
  cancel_reason TEXT,
  rating       INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, starts_at);
CREATE INDEX IF NOT EXISTS jobs_staff ON jobs(staff_id, starts_at);
CREATE INDEX IF NOT EXISTS jobs_patient ON jobs(patient_id, starts_at);

CREATE TABLE IF NOT EXISTS job_events (       -- status timeline, with location when reported
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id    TEXT NOT NULL REFERENCES jobs(id),
  status    TEXT NOT NULL,
  by_user   TEXT NOT NULL REFERENCES users(id),
  at        TEXT NOT NULL,
  lat       REAL,
  lng       REAL,
  note      TEXT
);

CREATE TABLE IF NOT EXISTS observations (     -- vitals; FHIR-Observation-shaped with LOINC codes
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES users(id),
  job_id      TEXT REFERENCES jobs(id),
  code        TEXT NOT NULL,                    -- e.g. 'bp', 'glucose', 'spo2'
  loinc       TEXT NOT NULL,
  value       REAL NOT NULL,
  value2      REAL,                              -- diastolic for BP
  unit        TEXT NOT NULL,
  recorded_by TEXT NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS obs_patient ON observations(patient_id, code, recorded_at);

CREATE TABLE IF NOT EXISTS alerts (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES users(id),
  observation_id TEXT REFERENCES observations(id),
  job_id      TEXT REFERENCES jobs(id),
  severity    TEXT NOT NULL CHECK (severity IN ('critical','warning')),
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  acknowledged_by TEXT REFERENCES users(id),
  acknowledged_at TEXT,
  resolution  TEXT
);

CREATE TABLE IF NOT EXISTS audit (            -- append-only record of every mutation
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,
  entity  TEXT NOT NULL,
  entity_id TEXT,
  detail  TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
