// SQLite data layer (node:sqlite, no native deps).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sahaay.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  elder_name TEXT NOT NULL,
  passcode_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('elder','caretaker','family')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dosage TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  times TEXT NOT NULL,            -- JSON array of "HH:MM"
  start_date TEXT NOT NULL,       -- YYYY-MM-DD
  end_date TEXT DEFAULT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS dose_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  scheduled_date TEXT NOT NULL,   -- YYYY-MM-DD
  scheduled_time TEXT NOT NULL,   -- HH:MM
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','taken','skipped','missed')),
  taken_at TEXT DEFAULT NULL,
  taken_by TEXT DEFAULT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  missed_sent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (medication_id, scheduled_date, scheduled_time)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  doctor TEXT DEFAULT '',
  location TEXT DEFAULT '',
  appt_at TEXT NOT NULL,          -- ISO local "YYYY-MM-DDTHH:MM"
  notes TEXT DEFAULT '',
  remind_24_sent INTEGER NOT NULL DEFAULT 0,
  remind_1h_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dose_log_med ON dose_log(medication_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_members_profile ON members(profile_id);
`);

module.exports = db;
