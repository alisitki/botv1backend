-- Migration 2.0: Auth & Multi-user support

-- 1. Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 2. User Settings table
CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 3. User Secrets table (Encrypted)
CREATE TABLE IF NOT EXISTS user_secrets (
    user_id TEXT PRIMARY KEY,
    binance_api_key_enc TEXT,
    binance_api_secret_enc TEXT,
    nonce TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Sessions table (Manual store if needed, or for persistence)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,  -- Nullable, no FK to allow anonymous sessions before login
    expires_at INTEGER NOT NULL,
    data TEXT
);

-- 5. Add user_id to existing tables
-- SQLite doesn't support adding a non-null column with a default value that references another table easily without a default user.
-- We will add it as NULLABLE first, or just create a 'system' user.

-- Add user_id columns
ALTER TABLE watches ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE trades ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE events ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE equity_curve ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE idempotency_keys ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE audit_log ADD COLUMN user_id TEXT REFERENCES users(id);

-- Create indexes for user_id
CREATE INDEX IF NOT EXISTS idx_watches_user_id ON watches(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_user_id ON trades(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
