import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getUserSettings, getUserSecrets, setMeta, getMeta, Watch } from '../db/index.js';
import { z } from 'zod';
import { WatchResponse, ErrorResponse } from '../schemas/index.js';
import { getExecutionAdapter } from '../adapters/execution.js';
import { logAudit } from '../utils/audit.js';
import { sendNotification } from '../notify/telegram.js';

// FAZ 4: Extended watch create schema with client_order_id
const watchCreateSchema = z.object({
    symbol: z.string().min(1),
    mode: z.enum(['PAPER', 'LIVE']),
    entry_price: z.number().positive().optional(),
    amount_usdt: z.number().positive(),
    tp_mode: z.enum(['FIXED', 'TRAIL']),
    tp_percent: z.number().positive(),
    trailing_step_percent: z.number().positive().optional(),
    client_order_id: z.string().optional(),
});

const watchIdParamSchema = z.object({
    id: z.string().transform(v => parseInt(v, 10)),
});

// Helper: Get price from worker_prices
function getWorkerPrice(symbol: string): { price: number; connected: boolean } {
    const row = db.prepare('SELECT price, connected FROM worker_prices WHERE symbol = ?').get(symbol) as {
        price: number;
        connected: number;
    } | undefined;

    return {
        price: row?.price || 0,
        connected: (row?.connected || 0) === 1,
    };
}

// FAZ 4: Risk guard checks for LIVE mode
function checkLiveGuards(userId: string, symbol: string, amount_usdt: number): { ok: boolean; error?: string; message?: string } {
    const row = getUserSettings(userId);
    const s = row ? JSON.parse(row.settings_json) : {};

    const liveEnabled = s.live_enabled === true;
    if (!liveEnabled) {
        return { ok: false, error: 'LIVE_DISABLED', message: 'LIVE mode is disabled. Enable it in settings.' };
    }

    const maxOrder = s.live_max_order_usdt || 50;
    if (amount_usdt > maxOrder) {
        return { ok: false, error: 'RISK_LIMIT', message: `Order amount ${amount_usdt} exceeds max ${maxOrder} USDT` };
    }

    const allowed: string[] = s.live_allow_symbols || ['BTCUSDT'];
    if (!allowed.includes(symbol.toUpperCase())) {
        return { ok: false, error: 'SYMBOL_NOT_ALLOWED', message: `Symbol ${symbol} not in allowlist: ${allowed.join(', ')}` };
    }

    const { connected } = getWorkerPrice(symbol);
    if (!connected) {
        return { ok: false, error: 'NO_MARKET_DATA', message: `No market data connection for ${symbol}` };
    }

    return { ok: true };
}

// FAZ 4: Check idempotency
function checkIdempotency(userId: string, clientOrderId: string): number | null {
    const row = db.prepare('SELECT watch_id FROM idempotency_keys WHERE client_order_id = ? AND user_id = ?').get(clientOrderId, userId) as {
        watch_id: number;
    } | undefined;

    return row?.watch_id || null;
}

// FAZ 4: Store idempotency key
function storeIdempotencyKey(userId: string, clientOrderId: string, watchId: number): void {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO idempotency_keys (client_order_id, watch_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(
        clientOrderId,
        watchId,
        userId,
        now
    );
}

export default async function watchesRoute(app: FastifyInstance) {
    // GET /v1/watches - List all watches
    app.get('/watches', async (request: FastifyRequest): Promise<WatchResponse[]> => {
        const userId = request.session.get('userId')!;
        const watches = db.prepare('SELECT * FROM watches WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Watch[];
        return watches.map(formatWatch);
    });

    // POST /v1/watches - Create a new watch
    app.post('/watches', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const userId = request.session.get('userId')!;
        const input = watchCreateSchema.parse(request.body);
        const now = Math.floor(Date.now() / 1000);

        logAudit('API', 'WATCH_CREATE_REQUEST', {
            userId,
            symbol: input.symbol,
            mode: input.mode,
            amount_usdt: input.amount_usdt,
            client_order_id: input.client_order_id,
        });

        if (input.client_order_id) {
            const existingWatchId = checkIdempotency(userId, input.client_order_id);
            if (existingWatchId !== null) {
                const existingWatch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(existingWatchId, userId) as Watch;
                return formatWatch(existingWatch);
            }
        }

        const { price: currentPrice } = getWorkerPrice(input.symbol);

        if (input.mode === 'LIVE') {
            const guardResult = checkLiveGuards(userId, input.symbol, input.amount_usdt);
            if (!guardResult.ok) {
                return reply.status(400).send({
                    error: guardResult.error!,
                    message: guardResult.message!,
                });
            }

            const adapter = getExecutionAdapter('LIVE');

            try {
                const orderResult = await adapter.placeMarketBuy({
                    userId,
                    symbol: input.symbol,
                    amount_usdt: input.amount_usdt,
                });

                const entryPrice = orderResult.avg_price;
                const quantity = orderResult.filled_qty;
                const actualAmount = quantity * entryPrice;

                const result = db.prepare(`
                    INSERT INTO watches (
                        user_id, symbol, mode, entry_price, current_price, amount_usdt, quantity,
                        tp_mode, tp_percent, trailing_step_percent, trailing_high,
                        status, unrealized_pnl, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)
                `).run(
                    userId,
                    input.symbol,
                    input.mode,
                    entryPrice,
                    entryPrice,
                    actualAmount,
                    quantity,
                    input.tp_mode,
                    input.tp_percent,
                    input.trailing_step_percent || null,
                    input.tp_mode === 'TRAIL' ? entryPrice : null,
                    now,
                    now
                );

                const watchId = result.lastInsertRowid as number;

                if (input.client_order_id) {
                    storeIdempotencyKey(userId, input.client_order_id, watchId);
                }

                db.prepare(`
                    INSERT INTO trades (user_id, watch_id, symbol, side, price, quantity, amount_usdt, fee, pnl, mode, created_at)
                    VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?, 0, ?, ?)
                `).run(userId, watchId, input.symbol, entryPrice, quantity, actualAmount, orderResult.fee_usdt, input.mode, now);

                db.prepare(`
                    INSERT INTO events (user_id, watch_id, type, payload, created_at)
                    VALUES (?, ?, 'WATCH_CREATED', ?, ?)
                `).run(userId, watchId, JSON.stringify({
                    symbol: input.symbol,
                    entry_price: entryPrice,
                    amount_usdt: actualAmount,
                    tp_mode: input.tp_mode,
                    tp_percent: input.tp_percent,
                    order_id: orderResult.order_id,
                    mode: 'LIVE',
                }), now);

                const watch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(watchId, userId) as Watch;
                return formatWatch(watch);

            } catch (err: any) {
                return reply.status(500).send({
                    error: 'ORDER_FAILED',
                    message: err.message,
                });
            }
        }

        const entryPrice = input.entry_price || currentPrice || 100000;
        const quantity = input.amount_usdt / entryPrice;

        const adapter = getExecutionAdapter('PAPER');
        const orderResult = await adapter.placeMarketBuy({
            userId,
            symbol: input.symbol,
            amount_usdt: input.amount_usdt,
        });

        const result = db.prepare(`
            INSERT INTO watches (
                user_id, symbol, mode, entry_price, current_price, amount_usdt, quantity,
                tp_mode, tp_percent, trailing_step_percent, trailing_high,
                status, unrealized_pnl, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)
        `).run(
            userId,
            input.symbol,
            input.mode,
            entryPrice,
            entryPrice,
            input.amount_usdt,
            quantity,
            input.tp_mode,
            input.tp_percent,
            input.trailing_step_percent || null,
            input.tp_mode === 'TRAIL' ? entryPrice : null,
            now,
            now
        );

        const watchId = result.lastInsertRowid as number;

        if (input.client_order_id) {
            storeIdempotencyKey(userId, input.client_order_id, watchId);
        }

        db.prepare(`
            INSERT INTO trades (user_id, watch_id, symbol, side, price, quantity, amount_usdt, fee, pnl, mode, created_at)
            VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?, 0, ?, ?)
        `).run(userId, watchId, input.symbol, entryPrice, quantity, input.amount_usdt, orderResult.fee_usdt, input.mode, now);

        db.prepare(`
            INSERT INTO events (user_id, watch_id, type, payload, created_at)
            VALUES (?, ?, 'WATCH_CREATED', ?, ?)
        `).run(userId, watchId, JSON.stringify({
            symbol: input.symbol,
            entry_price: entryPrice,
            amount_usdt: input.amount_usdt,
            tp_mode: input.tp_mode,
            tp_percent: input.tp_percent,
        }), now);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(watchId, userId) as Watch;
        return formatWatch(watch);
    });

    app.post('/watches/:id/pause', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const userId = request.session.get('userId')!;
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch | undefined;

        if (!watch) {
            return reply.status(404).send({
                error: 'WATCH_NOT_FOUND',
                message: `Watch with id ${id} not found`,
            });
        }

        if (watch.status !== 'ACTIVE') {
            return reply.status(400).send({
                error: 'INVALID_STATUS',
                message: `Cannot pause watch with status ${watch.status}`,
            });
        }

        const now = Math.floor(Date.now() / 1000);
        db.prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run('PAUSED', now, id, userId);

        const updated = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch;
        return formatWatch(updated);
    });

    app.post('/watches/:id/resume', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const userId = request.session.get('userId')!;
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch | undefined;

        if (!watch) {
            return reply.status(404).send({
                error: 'WATCH_NOT_FOUND',
                message: `Watch with id ${id} not found`,
            });
        }

        if (watch.status !== 'PAUSED') {
            return reply.status(400).send({
                error: 'INVALID_STATUS',
                message: `Cannot resume watch with status ${watch.status}`,
            });
        }

        const now = Math.floor(Date.now() / 1000);
        db.prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run('ACTIVE', now, id, userId);

        const updated = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch;
        return formatWatch(updated);
    });

    app.post('/watches/:id/sell', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const userId = request.session.get('userId')!;
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch | undefined;

        if (!watch) {
            return reply.status(404).send({
                error: 'WATCH_NOT_FOUND',
                message: `Watch with id ${id} not found`,
            });
        }

        if (watch.status === 'SOLD') {
            return reply.status(400).send({
                error: 'ALREADY_SOLD',
                message: 'This watch has already been sold',
            });
        }

        const now = Math.floor(Date.now() / 1000);

        const adapter = getExecutionAdapter(watch.mode as 'PAPER' | 'LIVE');

        try {
            const orderResult = await adapter.placeMarketSell({
                userId,
                symbol: watch.symbol,
                qty: watch.quantity,
            });

            const actualSellPrice = orderResult.avg_price;
            const priceDiff = actualSellPrice - watch.entry_price;
            const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
            const sellAmount = watch.amount_usdt + pnl - orderResult.fee_usdt;

            db.prepare(`
                UPDATE watches 
                SET status = 'SOLD', sell_price = ?, realized_pnl = ?, sold_at = ?, updated_at = ?, unrealized_pnl = 0
                WHERE id = ? AND user_id = ?
            `).run(actualSellPrice, pnl, now, now, id, userId);

            db.prepare(`
                INSERT INTO trades (user_id, watch_id, symbol, side, price, quantity, amount_usdt, fee, pnl, mode, created_at)
                VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, id, watch.symbol, actualSellPrice, watch.quantity, sellAmount, orderResult.fee_usdt, pnl, watch.mode, now);

            db.prepare(`
                INSERT INTO events (user_id, watch_id, type, payload, created_at)
                VALUES (?, ?, 'SELL_TRIGGERED', ?, ?)
            `).run(userId, id, JSON.stringify({
                sell_price: actualSellPrice,
                entry_price: watch.entry_price,
                pnl: Math.round(pnl * 100) / 100,
                trigger: 'MANUAL',
                order_id: orderResult.order_id,
            }), now);

            const updated = db.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').get(id, userId) as Watch;
            return formatWatch(updated);

        } catch (err: any) {
            return reply.status(500).send({
                error: 'ORDER_FAILED',
                message: err.message,
            });
        }
    });
}

function formatWatch(watch: Watch): WatchResponse {
    const statusMap: Record<string, 'WATCHING' | 'PAUSED' | 'SOLD' | 'STOPPED'> = {
        'ACTIVE': 'WATCHING',
        'PAUSED': 'PAUSED',
        'SOLD': 'SOLD',
        'STOPPED': 'STOPPED',
    };

    let currentTpPrice: number | null = null;
    if (watch.tp_mode === 'TRAIL' && watch.trailing_high !== null) {
        currentTpPrice = watch.trailing_high * (1 - watch.tp_percent);
    } else if (watch.tp_mode === 'FIXED') {
        currentTpPrice = watch.entry_price * (1 + watch.tp_percent);
    }

    const unrealizedPnl = watch.status === 'ACTIVE' ? watch.unrealized_pnl : 0;

    return {
        id: String(watch.id),
        symbol: watch.symbol,
        mode: watch.mode,
        status: statusMap[watch.status] || 'WATCHING',
        entry_price: watch.entry_price,
        amount_usdt: watch.amount_usdt,
        qty: watch.quantity,
        tp_mode: watch.tp_mode,
        tp_percent: watch.tp_percent,
        trailing_step_percent: watch.trailing_step_percent,
        peak_price: watch.trailing_high,
        current_tp_price: currentTpPrice !== null ? Math.round(currentTpPrice * 100) / 100 : null,
        current_price: watch.current_price,
        unrealized_pnl_usdt: Math.round(unrealizedPnl * 100) / 100,
        created_at: watch.created_at,
        updated_at: watch.updated_at,
    };
}
