import { z } from 'zod';

// Watch create schema
export const watchCreateSchema = z.object({
    symbol: z.string().min(1).default('BTCUSDT'),
    mode: z.enum(['PAPER', 'LIVE']).default('PAPER'),
    entry_price: z.number().positive(),
    amount_usdt: z.number().positive(),
    tp_mode: z.enum(['FIXED', 'TRAIL']),
    tp_percent: z.number().positive().max(1),
    trailing_step_percent: z.number().positive().max(1).optional(),
});

export type WatchCreateInput = z.infer<typeof watchCreateSchema>;

// Query params schema
export const limitQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(1000).default(200),
});

export const eventsQuerySchema = z.object({
    limit: z.coerce.number().int().positive().max(1000).default(200),
    watch_id: z.coerce.number().int().positive().optional(),
});

// Watch ID param
export const watchIdParamSchema = z.object({
    id: z.coerce.number().int().positive(),
});

// API Response types
export interface StateResponse {
    symbol: string;
    timeframe: string;
    price: number;
    latency_ms: number;
    connected: boolean;
    mode: 'PAPER' | 'LIVE';
    equity_usdt: number;
    pnl_total_usdt: number;
    pnl_realized_usdt: number;
    pnl_unrealized_usdt: number;
    today_pnl_usdt: number;
}

// FAZ 1.1: Updated to match UI contract
export interface WatchResponse {
    id: string;                    // string for UI compat
    symbol: string;
    mode: 'PAPER' | 'LIVE';
    status: 'WATCHING' | 'PAUSED' | 'SOLD' | 'STOPPED';  // ACTIVE → WATCHING
    entry_price: number;
    amount_usdt: number;
    qty: number;                   // quantity → qty
    tp_mode: 'FIXED' | 'TRAIL';
    tp_percent: number;
    trailing_step_percent: number | null;
    peak_price: number | null;     // trailing_high → peak_price
    current_tp_price: number | null;  // new field
    current_price: number;
    unrealized_pnl_usdt: number;   // unrealized_pnl → unrealized_pnl_usdt
    created_at: number;
    updated_at: number;
}

// FAZ 1.1: Updated to match UI contract
export interface TradeResponse {
    id: string;                    // string for UI compat
    watch_id: string;              // string for UI compat
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;                   // quantity → qty
    price: number;
    fee_usdt: number;              // new field (always 0 for PAPER)
    pnl_usdt: number;              // pnl → pnl_usdt, never null
    ts: number;                    // created_at → ts
}

export interface PortfolioResponse {
    equity_usdt: number;
    pnl_total_usdt: number;
    pnl_realized_usdt: number;
    pnl_unrealized_usdt: number;
    win_rate: number;
    max_drawdown: number;
    profit_factor: number;
    equity_curve: { ts: number; equity: number }[];
}

// FAZ 1.1: Updated to match UI contract
export interface EventResponse {
    id: string;                    // string for UI compat
    watch_id: string | null;       // string for UI compat
    type: string;
    payload: Record<string, unknown>;
    ts: number;                    // created_at → ts
}

export interface SignalResponse {
    id: string;
    symbol: string;
    strength: number;
    reasons: string[];
    suggested_entry_range: [number, number];
    suggested_tp_range: [number, number];
    ts: number;
}

export interface ErrorResponse {
    error: string;
    message: string;
    details?: unknown;
}
