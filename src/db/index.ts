import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/trading.db';

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Create singleton database connection
const db: Database.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Export database instance
export default db;

// Helper types
export interface Meta {
    key: string;
    value: string;
}

export interface WorkerStatus {
    id: number;
    connected: number;
    latency_ms: number;
    symbol: string;
    price: number;
    updated_at: number;
}

export interface Watch {
    id: number;
    symbol: string;
    mode: 'PAPER' | 'LIVE';
    entry_price: number;
    current_price: number;
    amount_usdt: number;
    quantity: number;
    tp_mode: 'FIXED' | 'TRAIL';
    tp_percent: number;
    trailing_step_percent: number | null;
    trailing_high: number | null;
    status: 'ACTIVE' | 'PAUSED' | 'SOLD' | 'STOPPED';
    unrealized_pnl: number;
    realized_pnl: number | null;
    sell_price: number | null;
    created_at: number;
    updated_at: number;
    sold_at: number | null;
}

export interface Trade {
    id: number;
    watch_id: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    amount_usdt: number;
    fee: number | null;  // FAZ 5: Trade fee
    pnl: number | null;
    mode: 'PAPER' | 'LIVE';
    created_at: number;
}

export interface Event {
    id: number;
    watch_id: number | null;
    type: string;
    payload: string;
    created_at: number;
}

export interface EquityCurvePoint {
    id: number;
    ts: number;
    equity: number;
}

// Helper functions
export function getMeta(key: string): string | undefined {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Meta | undefined;
    return row?.value;
}

export function setMeta(key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

export function getWorkerStatus(): WorkerStatus | undefined {
    return db.prepare('SELECT * FROM worker_status WHERE id = 1').get() as WorkerStatus | undefined;
}

export function updateWorkerStatus(connected: boolean, latencyMs: number, symbol: string, price: number): void {
    db.prepare(`
        UPDATE worker_status 
        SET connected = ?, latency_ms = ?, symbol = ?, price = ?, updated_at = ?
        WHERE id = 1
    `).run(connected ? 1 : 0, latencyMs, symbol, price, Math.floor(Date.now() / 1000));
}

// Graceful shutdown
process.on('exit', () => {
    db.close();
});
