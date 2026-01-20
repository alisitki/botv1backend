import Database from 'better-sqlite3';
import dotenv from 'dotenv';
dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/trading.db';
const db = new Database(DB_PATH);

try {
    db.pragma('foreign_keys = ON');
    // We delete from dependent tables first if they don't have ON DELETE CASCADE
    // Based on migration, user_settings and user_secrets HAVE it. 
    // watches, trades, events, equity_curve, idempotency_keys, audit_log DO NOT.
    
    console.log('Cleaning up user-related data...');
    db.prepare('DELETE FROM watches').run();
    db.prepare('DELETE FROM trades').run();
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM equity_curve WHERE user_id IS NOT NULL').run();
    db.prepare('DELETE FROM idempotency_keys').run();
    db.prepare('DELETE FROM audit_log WHERE user_id IS NOT NULL').run();
    
    const result = db.prepare('DELETE FROM users').run();
    console.log(`Successfully deleted ${result.changes} users.`);
} catch (error) {
    console.error('Error deleting users:', error);
} finally {
    db.close();
}
