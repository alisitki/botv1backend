// Multi-user state with real equity from portfolio_state

import { FastifyInstance, FastifyRequest } from 'fastify';
import db, { getUserSettings, Watch } from '../db/index.js';

interface StateResponse {
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
    last_sync_at: number | null;
}

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

// Get portfolio state
function getPortfolioState(userId: string): { equity_usdt: number; balance_json: string; updated_at: number } | null {
    const row = db.prepare('SELECT * FROM portfolio_state WHERE user_id = ?').get(userId) as {
        equity_usdt: number;
        balance_json: string;
        updated_at: number;
    } | undefined;

    return row || null;
}

function getStartOfToday(): number {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(startOfDay.getTime() / 1000);
}

export default async function stateRoute(app: FastifyInstance) {
    app.get('/state', async (request: FastifyRequest): Promise<StateResponse> => {
        const userId = request.session.get('userId')!;

        const userSettingsRow = getUserSettings(userId);
        const s = userSettingsRow ? JSON.parse(userSettingsRow.settings_json) : {};

        const mode = s.mode || 'PAPER';
        const symbol = s.active_symbol || 'BTCUSDT';
        const timeframe = s.timeframe || '15m';

        // Get price from worker_prices
        const priceData = getWorkerPrice(symbol);

        // Get portfolio state (real equity from Binance sync)
        const portfolioState = getPortfolioState(userId);
        const equityUsdt = portfolioState?.equity_usdt || 0;
        const lastSyncAt = portfolioState?.updated_at || null;

        // Calculate realized PnL from SELL trades
        const sellTrades = db.prepare(`
            SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL' AND user_id = ?
        `).get(userId) as { total: number | null };
        const pnlRealized = sellTrades?.total || 0;

        // Calculate unrealized PnL from active watches
        const activeWatches = db.prepare(`
            SELECT * FROM watches WHERE status = 'ACTIVE' AND user_id = ?
        `).all(userId) as Watch[];

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

        // Today's PnL from SELL trades
        const startOfToday = getStartOfToday();
        const todaySells = db.prepare(`
            SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL' AND created_at >= ? AND user_id = ?
        `).get(startOfToday, userId) as { total: number | null };
        const todayPnl = todaySells?.total || 0;

        // Check if connected: WS updated < 5s AND REST sync < 30s
        const now = Math.floor(Date.now() / 1000);
        const wsConnected = priceData ? (now - priceData.updated_at) < 5 : false;
        const syncRecent = lastSyncAt ? (now - lastSyncAt) < 30 : false;
        const connected = wsConnected && syncRecent;

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
            last_sync_at: lastSyncAt,
        };
    });
}

