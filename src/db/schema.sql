-- Enable WAL mode for better concurrency
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Meta table for key-value config
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Worker status (singleton row, id=1)
CREATE TABLE IF NOT EXISTS worker_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    connected INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
    price REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- Watches table
CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
    entry_price REAL NOT NULL,
    current_price REAL NOT NULL,
    amount_usdt REAL NOT NULL,
    quantity REAL NOT NULL,
    tp_mode TEXT NOT NULL CHECK (tp_mode IN ('FIXED', 'TRAIL')),
    tp_percent REAL NOT NULL,
    trailing_step_percent REAL,
    trailing_high REAL,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'SOLD', 'STOPPED')),
    unrealized_pnl REAL NOT NULL DEFAULT 0,
    realized_pnl REAL,
    sell_price REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    sold_at INTEGER
);

-- Trades table
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    amount_usdt REAL NOT NULL,
    pnl REAL,
    mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (watch_id) REFERENCES watches(id)
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    watch_id INTEGER,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (watch_id) REFERENCES watches(id)
);

-- Equity curve table
CREATE TABLE IF NOT EXISTS equity_curve (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    equity REAL NOT NULL
);

-- FAZ 3: Worker prices table for multi-symbol support
CREATE TABLE IF NOT EXISTS worker_prices (
    symbol TEXT PRIMARY KEY,
    price REAL NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    connected INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
);

-- FAZ 4: Idempotency keys for duplicate prevention
CREATE TABLE IF NOT EXISTS idempotency_keys (
    client_order_id TEXT PRIMARY KEY,
    watch_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (watch_id) REFERENCES watches(id)
);

-- FAZ 4: Audit log for critical actions
CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL DEFAULT (unixepoch()),
    scope TEXT NOT NULL CHECK (scope IN ('API', 'WORKER')),
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_watches_status ON watches(status);
CREATE INDEX IF NOT EXISTS idx_watches_status_symbol ON watches(status, symbol);
CREATE INDEX IF NOT EXISTS idx_trades_watch_id ON trades(watch_id);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_events_watch_id ON events(watch_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_equity_curve_ts ON equity_curve(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
