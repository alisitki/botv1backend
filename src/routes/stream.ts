// FAZ 6: SSE Stream Endpoint

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getMeta, Watch, Trade } from '../db/index.js';

// Helpers from other routes (duplicated for simplicity)
function getWorkerPrice(symbol: string): { price: number; latency_ms: number; connected: boolean; updated_at: number } | null {
    const row = db.prepare('SELECT * FROM worker_prices WHERE symbol = ?').get(symbol) as {
        price: number;
        latency_ms: number;
        connected: number;
        updated_at: number;
    } | undefined;

    if (!row) return null;
    return {
        price: row.price,
        latency_ms: row.latency_ms,
        connected: row.connected === 1,
        updated_at: row.updated_at,
    };
}

function getStartOfToday(): number {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(startOfDay.getTime() / 1000);
}

function getState() {
    const mode = getMeta('mode') || 'PAPER';
    const symbol = getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
    const timeframe = getMeta('timeframe') || '15m';
    const paperEquity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');

    const priceData = getWorkerPrice(symbol);

    const sellTrades = db.prepare(`
        SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL'
    `).get() as { total: number | null };
    const pnlRealized = sellTrades?.total || 0;

    const activeWatches = db.prepare(`
        SELECT * FROM watches WHERE status = 'ACTIVE'
    `).all() as Watch[];

    let pnlUnrealized = 0;
    for (const watch of activeWatches) {
        const watchPriceData = getWorkerPrice(watch.symbol);
        const watchPrice = watchPriceData?.price || 0;
        if (watchPrice > 0) {
            const priceDiff = watchPrice - watch.entry_price;
            const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
            pnlUnrealized += pnl;
        }
    }

    const pnlTotal = pnlRealized + pnlUnrealized;
    const equityUsdt = paperEquity + pnlTotal;

    const startOfToday = getStartOfToday();
    const todaySells = db.prepare(`
        SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL' AND created_at >= ?
    `).get(startOfToday) as { total: number | null };
    const todayPnl = todaySells?.total || 0;

    const now = Math.floor(Date.now() / 1000);
    const connected = priceData ? (now - priceData.updated_at) < 5 : false;

    return {
        symbol,
        timeframe,
        price: priceData?.price || 0,
        latency_ms: priceData?.latency_ms || 0,
        connected,
        mode,
        equity_usdt: Math.round(equityUsdt * 100) / 100,
        pnl_total_usdt: Math.round(pnlTotal * 100) / 100,
        pnl_realized_usdt: Math.round(pnlRealized * 100) / 100,
        pnl_unrealized_usdt: Math.round(pnlUnrealized * 100) / 100,
        today_pnl_usdt: Math.round(todayPnl * 100) / 100,
    };
}

function getWatches() {
    const watches = db.prepare('SELECT * FROM watches ORDER BY created_at DESC').all() as Watch[];
    return watches.map(watch => {
        const statusMap: Record<string, string> = {
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
    });
}

function getRecentEvents(limit: number = 10) {
    const events = db.prepare(`
        SELECT * FROM events ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{
        id: number;
        watch_id: number | null;
        type: string;
        payload: string;
        created_at: number;
    }>;

    return events.map(event => ({
        id: String(event.id),
        watch_id: event.watch_id ? String(event.watch_id) : null,
        type: event.type,
        payload: JSON.parse(event.payload),
        ts: event.created_at,
    }));
}

function getLastEventId(): number {
    const row = db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    return row?.id || 0;
}

// SSE format helper
function formatSSE(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// FAZ 9.5: OP Standard SSE Metrics
let activeConnections = 0;
let eventsDelivered = 0;
let heartbeatsSent = 0;

export default async function streamRoute(app: FastifyInstance) {
    // GET /v1/stream - SSE endpoint
    app.get('/stream', async (request: FastifyRequest, reply: FastifyReply) => {
        activeConnections++;

        const hbSeconds = parseInt(process.env.SSE_HEARTBEAT_SECONDS || '15', 10);
        const retryMs = parseInt(process.env.SSE_RETRY_MS || '2000', 10);

        // Set SSE headers
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',  // Disable nginx buffering
            'Access-Control-Allow-Origin': 'https://kaptanbotui.vercel.app',
            'Vary': 'Origin',
        });

        // Send retry and initial heartbeat/ping
        reply.raw.write(`retry: ${retryMs}\n`);
        reply.raw.write(': connected\n\n'); // Immediate comment to flush

        // Initial push
        reply.raw.write(formatSSE('state', getState()));
        reply.raw.write(formatSSE('watches', getWatches()));
        reply.raw.write(formatSSE('events', getRecentEvents(10)));
        eventsDelivered += 3;

        let lastEventId = getLastEventId();
        let stateCounter = 0;
        let watchesCounter = 0;
        let lastOutputTime = Date.now();

        // Single loop for efficiency
        const interval = setInterval(() => {
            try {
                const now = Date.now();
                let eventSent = false;

                // 1. State every 1s
                stateCounter++;
                if (stateCounter >= 1) {
                    reply.raw.write(formatSSE('state', getState()));
                    stateCounter = 0;
                    eventSent = true;
                }

                // 2. Watches every 2s
                watchesCounter++;
                if (watchesCounter >= 2) {
                    reply.raw.write(formatSSE('watches', getWatches()));
                    watchesCounter = 0;
                    eventSent = true;
                }

                // 3. Check for new database events
                const currentEventId = getLastEventId();
                if (currentEventId > lastEventId) {
                    reply.raw.write(formatSSE('events', getRecentEvents(10)));
                    lastEventId = currentEventId;
                    eventSent = true;
                }

                if (eventSent) {
                    eventsDelivered++;
                    lastOutputTime = now;
                } else {
                    // 4. Idle Heartbeat (ping)
                    if (now - lastOutputTime >= hbSeconds * 1000) {
                        reply.raw.write(': ping\n\n');
                        heartbeatsSent++;
                        lastOutputTime = now;
                    }
                }
            } catch (err) {
                console.error('SSE push error:', err);
                clearInterval(interval);
            }
        }, 1000);

        // Cleanup on disconnect
        request.raw.on('close', () => {
            activeConnections--;
            clearInterval(interval);
        });

        // Keep connection open
        reply.hijack();
    });

    // Optional: Metrics endpoint update or internal access
    app.get('/stream/metrics', async () => {
        return {
            active_connections: activeConnections,
            total_events: eventsDelivered,
            total_heartbeats: heartbeatsSent
        };
    });
}

