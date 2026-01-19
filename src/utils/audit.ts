// FAZ 4: Audit Logging Helper

import db from '../db/index.js';
import crypto from 'crypto';

export type AuditScope = 'API' | 'WORKER' | 'SYSTEM';

export type AuditAction =
    | 'WATCH_CREATE_REQUEST'
    | 'WATCH_CREATE_SUCCESS'
    | 'WATCH_CREATE_IDEMPOTENT'
    | 'ORDER_PLACED'
    | 'ORDER_FAILED'
    | 'MANUAL_SELL'
    | 'AUTO_SELL'
    | 'TP_MOVED'
    | 'SETTINGS_UPDATE'
    | 'LIVE_GUARD_FAILED'
    | 'TELEGRAM_SEND_FAILED'
    | 'TELEGRAM_SENT'
    | 'WATCH_CREATED'      // Also need this for consistency if used in telegram sender
    | 'SELL_TRIGGERED';    // And this

export interface AuditLogEntry {
    id: string;
    ts: number;
    scope: AuditScope;
    action: AuditAction;
    payload: Record<string, unknown>;
}

export function logAudit(scope: AuditScope, action: AuditAction, payload: Record<string, unknown>): void {
    const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const ts = Math.floor(Date.now() / 1000);

    db.prepare(`
        INSERT INTO audit_log (id, ts, scope, action, payload_json)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, ts, scope, action, JSON.stringify(payload));
}

export function getAuditLogs(limit: number = 50): AuditLogEntry[] {
    const rows = db.prepare(`
        SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?
    `).all(limit) as Array<{
        id: string;
        ts: number;
        scope: string;
        action: string;
        payload_json: string;
    }>;

    return rows.map(row => ({
        id: row.id,
        ts: row.ts,
        scope: row.scope as AuditScope,
        action: row.action as AuditAction,
        payload: JSON.parse(row.payload_json),
    }));
}

// Helper to mask sensitive data
export function maskSecret(value: string | undefined | null): string {
    if (!value || value.length < 8) {
        return value ? '****' : '';
    }
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
}
