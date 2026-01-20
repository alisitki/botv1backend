-- Migration 3.0: Multi-user portfolio sync

-- Add account_type to user_secrets
ALTER TABLE user_secrets ADD COLUMN account_type TEXT DEFAULT 'SPOT' CHECK (account_type IN ('SPOT', 'FUTURES'));

-- Portfolio state table (user bazlı equity/balance cache)
CREATE TABLE IF NOT EXISTS portfolio_state (
    user_id TEXT PRIMARY KEY,
    equity_usdt REAL NOT NULL DEFAULT 0,
    balance_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portfolio_state_user ON portfolio_state(user_id);
