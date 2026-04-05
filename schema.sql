-- D-Wolf PSLE Database Schema
-- Run: wrangler d1 execute dwolf-psle --file=schema.sql

CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  pin_hash    TEXT NOT NULL,
  avatar      TEXT DEFAULT 'wolf',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login  DATETIME
);

CREATE TABLE IF NOT EXISTS progress (
  student_id    INTEGER PRIMARY KEY REFERENCES students(id),
  xp            INTEGER DEFAULT 0,
  coins         INTEGER DEFAULT 0,
  pts           INTEGER DEFAULT 0,
  streak_days   INTEGER DEFAULT 0,
  last_active   DATE,
  level         TEXT DEFAULT 'easy',
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mission_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER REFERENCES students(id),
  mission_code  TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  stars         INTEGER DEFAULT 0,
  score         INTEGER DEFAULT 0,
  xp_earned     INTEGER DEFAULT 0,
  attempts      INTEGER DEFAULT 1,
  completed_at  DATETIME,
  UNIQUE(student_id, mission_code)
);

CREATE TABLE IF NOT EXISTS quiz_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER REFERENCES students(id),
  quiz_code     TEXT NOT NULL,
  score         INTEGER DEFAULT 0,
  correct       INTEGER DEFAULT 0,
  total         INTEGER DEFAULT 0,
  stars         INTEGER DEFAULT 0,
  completed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER REFERENCES students(id),
  question_text TEXT,
  grade         TEXT,
  score_pct     INTEGER,
  errors_count  INTEGER DEFAULT 0,
  xp_earned     INTEGER DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id            TEXT PRIMARY KEY,
  student_id    INTEGER REFERENCES students(id),
  status        TEXT DEFAULT 'pending',
  mode          TEXT DEFAULT 'background',
  messages      TEXT,
  result        TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at  DATETIME
);

CREATE INDEX IF NOT EXISTS idx_missions_student ON mission_results(student_id);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_student ON scan_jobs(student_id);
CREATE INDEX IF NOT EXISTS idx_quiz_student ON quiz_results(student_id);
CREATE INDEX IF NOT EXISTS idx_scan_student ON scan_results(student_id);
