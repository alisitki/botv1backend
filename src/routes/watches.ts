import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getMeta, setMeta, Watch } from '../db/index.js';
import { z } from 'zod';
import { WatchResponse, ErrorResponse } from '../schemas/index.js';
import { getExecutionAdapter } from '../adapters/execution.js';
import { logAudit } from '../utils/audit.js';
import { sendNotification } from '../notify/telegram.js';

// FAZ 4: Extended watch create schema with client_order_id
const watchCreateSchema = z.object({
    symbol: z.string().min(1),
    mode: z.enum(['PAPER', 'LIVE']),
    entry_price: z.number().positive().optional(),  // Optional for LIVE
    amount_usdt: z.number().positive(),
    tp_mode: z.enum(['FIXED', 'TRAIL']),
    tp_percent: z.number().positive(),
    trailing_step_percent: z.number().positive().optional(),
    client_order_id: z.string().optional(),  // FAZ 4: Idempotency
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
function checkLiveGuards(symbol: string, amount_usdt: number): { ok: boolean; error?: string; message?: string } {
    const liveEnabled = getMeta('live_enabled') === 'true';
    if (!liveEnabled) {
        return { ok: false, error: 'LIVE_DISABLED', message: 'LIVE mode is disabled. Enable it in settings.' };
    }

    const maxOrder = parseFloat(getMeta('live_max_order_usdt') || '50');
    if (amount_usdt > maxOrder) {
        return { ok: false, error: 'RISK_LIMIT', message: `Order amount ${amount_usdt} exceeds max ${maxOrder} USDT` };
    }

    const allowSymbols = getMeta('live_allow_symbols');
    const allowed: string[] = allowSymbols ? JSON.parse(allowSymbols) : ['BTCUSDT'];
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
function checkIdempotency(clientOrderId: string): number | null {
    const row = db.prepare('SELECT watch_id FROM idempotency_keys WHERE client_order_id = ?').get(clientOrderId) as {
        watch_id: number;
    } | undefined;

    return row?.watch_id || null;
}

// FAZ 4: Store idempotency key
function storeIdempotencyKey(clientOrderId: string, watchId: number): void {
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO idempotency_keys (client_order_id, watch_id, created_at) VALUES (?, ?, ?)').run(
        clientOrderId,
        watchId,
        now
    );
}

export default async function watchesRoute(app: FastifyInstance) {
    // GET /v1/watches - List all watches
    app.get('/watches', async (): Promise<WatchResponse[]> => {
        const watches = db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as Watch[];
        return watches.map(formatWatch);
    });

    // POST /v1/watches - Create a new watch
    app.post('/watches', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const input = watchCreateSchema.parse(request.body);
        const now = Math.floor(Date.now() / 1000);

        // Audit: Log request
        logAudit('API', 'WATCH_CREATE_REQUEST', {
            symbol: input.symbol,
            mode: input.mode,
            amount_usdt: input.amount_usdt,
            client_order_id: input.client_order_id,
        });

        // FAZ 4: Check idempotency
        if (input.client_order_id) {
            const existingWatchId = checkIdempotency(input.client_order_id);
            if (existingWatchId !== null) {
                const existingWatch = db.prepare('SELECT * FROM watches WHERE id = ?').get(existingWatchId) as Watch;

                logAudit('API', 'WATCH_CREATE_IDEMPOTENT', {
                    client_order_id: input.client_order_id,
                    existing_watch_id: existingWatchId,
                });

                return formatWatch(existingWatch);
            }
        }

        // Get current price for the symbol
        const { price: currentPrice, connected } = getWorkerPrice(input.symbol);

        // FAZ 4: LIVE mode handling
        if (input.mode === 'LIVE') {
            // Risk guards
            const guardResult = checkLiveGuards(input.symbol, input.amount_usdt);
            if (!guardResult.ok) {
                logAudit('API', 'LIVE_GUARD_FAILED', {
                    error: guardResult.error,
                    symbol: input.symbol,
                    amount_usdt: input.amount_usdt,
                });

                return reply.status(400).send({
                    error: guardResult.error!,
                    message: guardResult.message!,
                });
            }

            // Execute via adapter
            const adapter = getExecutionAdapter('LIVE');

            try {
                const orderResult = await adapter.placeMarketBuy({
                    symbol: input.symbol,
                    amount_usdt: input.amount_usdt,
                });

                logAudit('API', 'ORDER_PLACED', {
                    mode: 'LIVE',
                    side: 'BUY',
                    symbol: input.symbol,
                    order_id: orderResult.order_id,
                    filled_qty: orderResult.filled_qty,
                    avg_price: orderResult.avg_price,
                    fee_usdt: orderResult.fee_usdt,
                });

                // Use actual fill price/qty
                const entryPrice = orderResult.avg_price;
                const quantity = orderResult.filled_qty;
                const actualAmount = quantity * entryPrice;

                // Insert watch
                const result = db.prepare(`
                    INSERT INTO watches (
                        symbol, mode, entry_price, current_price, amount_usdt, quantity,
                        tp_mode, tp_percent, trailing_step_percent, trailing_high,
                        status, unrealized_pnl, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)
                `).run(
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

                // Store idempotency key
                if (input.client_order_id) {
                    storeIdempotencyKey(input.client_order_id, watchId);
                }

                // Create BUY trade with fee
                db.prepare(`
                    INSERT INTO trades (watch_id, symbol, side, price, quantity, amount_usdt, pnl, mode, created_at)
                    VALUES (?, ?, 'BUY', ?, ?, ?, 0, ?, ?)
                `).run(watchId, input.symbol, entryPrice, quantity, actualAmount, input.mode, now);

                // Create event
                db.prepare(`
                    INSERT INTO events (watch_id, type, payload, created_at)
                    VALUES (?, 'WATCH_CREATED', ?, ?)
                `).run(watchId, JSON.stringify({
                    symbol: input.symbol,
                    entry_price: entryPrice,
                    amount_usdt: actualAmount,
                    tp_mode: input.tp_mode,
                    tp_percent: input.tp_percent,
                    order_id: orderResult.order_id,
                    mode: 'LIVE',
                }), now);

                logAudit('API', 'WATCH_CREATE_SUCCESS', {
                    watch_id: watchId,
                    mode: 'LIVE',
                    order_id: orderResult.order_id,
                });

                const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId) as Watch;
                return formatWatch(watch);

            } catch (err) {
                const error = err as Error;
                logAudit('API', 'ORDER_FAILED', {
                    mode: 'LIVE',
                    side: 'BUY',
                    symbol: input.symbol,
                    error: error.message,
                });

                return reply.status(500).send({
                    error: 'ORDER_FAILED',
                    message: error.message,
                });
            }
        }

        // PAPER mode: Use provided entry_price or current price
        const entryPrice = input.entry_price || currentPrice || 100000;
        const quantity = input.amount_usdt / entryPrice;

        // Execute via adapter (for consistency)
        const adapter = getExecutionAdapter('PAPER');
        const orderResult = await adapter.placeMarketBuy({
            symbol: input.symbol,
            amount_usdt: input.amount_usdt,
        });

        logAudit('API', 'ORDER_PLACED', {
            mode: 'PAPER',
            side: 'BUY',
            symbol: input.symbol,
            order_id: orderResult.order_id,
            filled_qty: quantity,
            avg_price: entryPrice,
        });

        // Insert watch
        const result = db.prepare(`
            INSERT INTO watches (
                symbol, mode, entry_price, current_price, amount_usdt, quantity,
                tp_mode, tp_percent, trailing_step_percent, trailing_high,
                status, unrealized_pnl, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, ?)
        `).run(
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

        // Store idempotency key
        if (input.client_order_id) {
            storeIdempotencyKey(input.client_order_id, watchId);
        }

        // Create BUY trade with fee
        db.prepare(`
            INSERT INTO trades (watch_id, symbol, side, price, quantity, amount_usdt, fee, pnl, mode, created_at)
            VALUES (?, ?, 'BUY', ?, ?, ?, ?, 0, ?, ?)
        `).run(watchId, input.symbol, entryPrice, quantity, input.amount_usdt, orderResult.fee_usdt, input.mode, now);

        // Create event
        db.prepare(`
            INSERT INTO events (watch_id, type, payload, created_at)
            VALUES (?, 'WATCH_CREATED', ?, ?)
        `).run(watchId, JSON.stringify({
            symbol: input.symbol,
            entry_price: entryPrice,
            amount_usdt: input.amount_usdt,
            tp_mode: input.tp_mode,
            tp_percent: input.tp_percent,
        }), now);

        // FAZ 8: Notify
        sendNotification('WATCH_CREATED', {
            symbol: input.symbol,
            entry_price: entryPrice,
            mode: input.mode
        });

        logAudit('API', 'WATCH_CREATE_SUCCESS', {
            watch_id: watchId,
            mode: 'PAPER',
        });

        const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId) as Watch;
        return formatWatch(watch);
    });

    // POST /v1/watches/:id/pause
    app.post('/watches/:id/pause', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | undefined;

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
        db.prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now, id);

        const updated = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch;
        return formatWatch(updated);
    });

    // POST /v1/watches/:id/resume
    app.post('/watches/:id/resume', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | undefined;

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
        db.prepare('UPDATE watches SET status = ?, updated_at = ? WHERE id = ?').run('ACTIVE', now, id);

        const updated = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch;
        return formatWatch(updated);
    });

    // POST /v1/watches/:id/sell - Manual sell
    app.post('/watches/:id/sell', async (request: FastifyRequest, reply: FastifyReply): Promise<WatchResponse | ErrorResponse> => {
        const { id } = watchIdParamSchema.parse(request.params);

        const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch | undefined;

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
        const { price: currentPrice } = getWorkerPrice(watch.symbol);
        const sellPrice = currentPrice || watch.current_price;

        // FAZ 4: Use adapter for sell
        const adapter = getExecutionAdapter(watch.mode as 'PAPER' | 'LIVE');

        if (watch.mode === 'LIVE') {
            // Risk guards for LIVE sell
            const { connected } = getWorkerPrice(watch.symbol);
            if (!connected) {
                return reply.status(400).send({
                    error: 'NO_MARKET_DATA',
                    message: `No market data connection for ${watch.symbol}`,
                });
            }
        }

        try {
            const orderResult = await adapter.placeMarketSell({
                symbol: watch.symbol,
                qty: watch.quantity,
            });

            logAudit('API', 'ORDER_PLACED', {
                mode: watch.mode,
                side: 'SELL',
                symbol: watch.symbol,
                order_id: orderResult.order_id,
                filled_qty: orderResult.filled_qty,
                avg_price: orderResult.avg_price,
            });

            const actualSellPrice = orderResult.avg_price;
            const priceDiff = actualSellPrice - watch.entry_price;
            const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
            const sellAmount = watch.amount_usdt + pnl - orderResult.fee_usdt;

            // Update watch
            db.prepare(`
                UPDATE watches 
                SET status = 'SOLD', sell_price = ?, realized_pnl = ?, sold_at = ?, updated_at = ?, unrealized_pnl = 0
                WHERE id = ?
            `).run(actualSellPrice, pnl, now, now, id);

            // Create SELL trade with fee
            db.prepare(`
                INSERT INTO trades (watch_id, symbol, side, price, quantity, amount_usdt, fee, pnl, mode, created_at)
                VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?)
            `).run(id, watch.symbol, actualSellPrice, watch.quantity, sellAmount, orderResult.fee_usdt, pnl, watch.mode, now);

            // Create event
            db.prepare(`
                INSERT INTO events (watch_id, type, payload, created_at)
                VALUES (?, 'SELL_TRIGGERED', ?, ?)
            `).run(id, JSON.stringify({
                sell_price: actualSellPrice,
                entry_price: watch.entry_price,
                pnl: Math.round(pnl * 100) / 100,
                trigger: 'MANUAL',
                order_id: orderResult.order_id,
            }), now);

            // Update realized PnL
            const currentRealized = parseFloat(getMeta('pnl_realized') || '0');
            setMeta('pnl_realized', (currentRealized + pnl).toString());

            // Add equity curve point
            const equity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');
            db.prepare('INSERT INTO equity_curve (ts, equity) VALUES (?, ?)').run(now, equity + currentRealized + pnl);

            // FAZ 8: Notify
            sendNotification('SELL_TRIGGERED', {
                symbol: watch.symbol,
                price: Math.round(actualSellPrice * 100) / 100,
                pnl_usdt: Math.round(pnl * 100) / 100,
                pnl_percent: (pnl / watch.entry_price) * 100, // Approximate
                trigger: 'MANUAL'
            });

            logAudit('API', 'MANUAL_SELL', {
                watch_id: id,
                mode: watch.mode,
                pnl: Math.round(pnl * 100) / 100,
                order_id: orderResult.order_id,
            });

            const updated = db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as Watch;
            return formatWatch(updated);

        } catch (err) {
            const error = err as Error;
            logAudit('API', 'ORDER_FAILED', {
                mode: watch.mode,
                side: 'SELL',
                symbol: watch.symbol,
                error: error.message,
            });

            return reply.status(500).send({
                error: 'ORDER_FAILED',
                message: error.message,
            });
        }
    });
}

// FAZ 1.1 + FAZ 2: Format watch to match UI contract
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
