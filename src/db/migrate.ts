import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || './data/trading.db';
const INITIAL_EQUITY = parseFloat(process.env.INITIAL_EQUITY || '17000');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

console.log('🗄️  Starting database migration...');
console.log(`📁 Database path: ${DB_PATH}`);

// Create database connection
const db = new Database(DB_PATH);

// Enable WAL mode
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('✅ WAL mode enabled');

// Read and execute schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf-8');

// Execute the entire schema (better-sqlite3 supports multiple statements)
try {
    db.exec(schema);
} catch (err) {
    // Ignore "already exists" errors for idempotency
    const error = err as Error;
    if (!error.message.includes('already exists')) {
        throw err;
    }
}

console.log('✅ Schema created/verified');

// Run Migration 2.0
const migrate2Path = path.join(__dirname, 'migrate_2_0.sql');
if (fs.existsSync(migrate2Path)) {
    console.log('🔄 Running Migration 2.0...');
    const migrate2 = fs.readFileSync(migrate2Path, 'utf-8');
    try {
        db.exec(migrate2);
        console.log('✅ Migration 2.0 complete');
    } catch (err) {
        const error = err as Error;
        if (!error.message.includes('duplicate column name')) {
            console.error('❌ Migration 2.0 failed:', error.message);
            // We ignore duplicate column errors to allow re-running
        } else {
            console.log('✅ Migration 2.0 already applied (columns exist)');
        }
    }
}

// Run Migration 3.0 (Multi-user portfolio)
const migrate3Path = path.join(__dirname, 'migrate_3_0.sql');
if (fs.existsSync(migrate3Path)) {
    console.log('🔄 Running Migration 3.0...');
    const migrate3 = fs.readFileSync(migrate3Path, 'utf-8');
    try {
        db.exec(migrate3);
        console.log('✅ Migration 3.0 complete');
    } catch (err) {
        const error = err as Error;
        if (!error.message.includes('duplicate column name') && !error.message.includes('already exists')) {
            console.error('❌ Migration 3.0 failed:', error.message);
        } else {
            console.log('✅ Migration 3.0 already applied');
        }
    }
}

// Seed meta defaults (FAZ 3: added active_symbol, paper_equity_usdt)
const metaDefaults: Record<string, string> = {
    mode: process.env.MODE || 'PAPER',
    active_symbol: process.env.SYMBOL || 'BTCUSDT',  // FAZ 3: renamed from symbol
    symbol: process.env.SYMBOL || 'BTCUSDT',         // Keep for backward compat
    timeframe: process.env.TIMEFRAME || '15m',
    paper_equity_usdt: INITIAL_EQUITY.toString(),    // FAZ 3: renamed from equity
    equity: INITIAL_EQUITY.toString(),               // Keep for backward compat
    pnl_realized: '0',
    pnl_unrealized: '0',
};

const insertMeta = db.prepare(`
    INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)
`);

for (const [key, value] of Object.entries(metaDefaults)) {
    insertMeta.run(key, value);
}

console.log('✅ Meta defaults seeded');

// Initialize worker_status singleton
const workerInit = db.prepare(`
    INSERT OR IGNORE INTO worker_status (id, connected, latency_ms, symbol, price, updated_at)
    VALUES (1, 0, 0, ?, 100000, ?)
`);

workerInit.run(
    process.env.SYMBOL || 'BTCUSDT',
    Math.floor(Date.now() / 1000)
);

console.log('✅ Worker status initialized');

// Add initial equity curve point
const equityCheck = db.prepare('SELECT COUNT(*) as count FROM equity_curve').get() as { count: number };
if (equityCheck.count === 0) {
    const insertEquity = db.prepare('INSERT INTO equity_curve (ts, equity) VALUES (?, ?)');
    insertEquity.run(Math.floor(Date.now() / 1000), INITIAL_EQUITY);
    console.log('✅ Initial equity curve point added');
}

db.close();

console.log('');
console.log('🎉 Migration complete!');
console.log('');
