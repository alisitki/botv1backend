// FAZ 5: State with today_pnl_usdt

import { FastifyInstance } from 'fastify';
import db, { getMeta, Watch, Trade } from '../db/index.js';
import type { StateResponse } from '../schemas/index.js';

// Get price from worker_prices table
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

// FAZ 5: Get start of today (local server time)
function getStartOfToday(): number {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(startOfDay.getTime() / 1000);
}

export default async function stateRoute(app: FastifyInstance) {
    app.get('/state', async (): Promise<StateResponse> => {
        const mode = getMeta('mode') || 'PAPER';
        const symbol = getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
        const timeframe = getMeta('timeframe') || '15m';
        const paperEquity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');

        // Get price from worker_prices
        const priceData = getWorkerPrice(symbol);

        // FAZ 5: Calculate realized PnL from SELL trades
        const sellTrades = db.prepare(`
            SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL'
        `).get() as { total: number | null };
        const pnlRealized = sellTrades?.total || 0;

        // Calculate unrealized PnL from active watches
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

        // FAZ 5: Today's PnL from SELL trades
        const startOfToday = getStartOfToday();
        const todaySells = db.prepare(`
            SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL' AND created_at >= ?
        `).get(startOfToday) as { total: number | null };
        const todayPnl = todaySells?.total || 0;

        // Check if worker is connected (updated in last 5 seconds)
        const now = Math.floor(Date.now() / 1000);
        const connected = priceData ? (now - priceData.updated_at) < 5 : false;

        return {
            symbol,
            timeframe,
            price: priceData?.price || 0,
            latency_ms: priceData?.latency_ms || 0,
            connected,
            mode: mode as 'PAPER' | 'LIVE',
            equity_usdt: Math.round(equityUsdt * 100) / 100,
            pnl_total_usdt: Math.round(pnlTotal * 100) / 100,
            pnl_realized_usdt: Math.round(pnlRealized * 100) / 100,
            pnl_unrealized_usdt: Math.round(pnlUnrealized * 100) / 100,
            today_pnl_usdt: Math.round(todayPnl * 100) / 100,
        };
    });
}
