import db from '../db/index.js';

interface SessionData {
    userId?: string;
    [key: string]: any;
}

export class SQLiteSessionStore {
    get(sessionId: string, callback: (err: any, session?: any) => void) {
        try {
            const row = db.prepare('SELECT data FROM sessions WHERE id = ? AND expires_at > ?').get(sessionId, Math.floor(Date.now() / 1000)) as { data: string } | undefined;
            if (!row) {
                return callback(null, null);
            }
            callback(null, JSON.parse(row.data));
        } catch (err) {
            callback(err);
        }
    }

    set(sessionId: string, session: any, callback: (err?: any) => void) {
        try {
            const expiresAt = Math.floor(new Date(session.cookie.expires).getTime() / 1000);
            const userId = session.userId || null;  // Use null instead of 'anonymous' to avoid FK constraint
            db.prepare(`
                INSERT OR REPLACE INTO sessions (id, user_id, expires_at, data)
                VALUES (?, ?, ?, ?)
            `).run(sessionId, userId, expiresAt, JSON.stringify(session));
            callback();
        } catch (err) {
            callback(err);
        }
    }

    destroy(sessionId: string, callback: (err?: any) => void) {
        try {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
            callback();
        } catch (err) {
            callback(err);
        }
    }
}
