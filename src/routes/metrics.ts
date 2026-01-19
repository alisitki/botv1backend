// FAZ 5: Metrics Debug Endpoint (non-production only)

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getMeta } from '../db/index.js';

interface MetricsDebugResponse {
    realized_pnl_usdt: number;
    unrealized_pnl_usdt: number;
    pnl_total_usdt: number;
    gross_profit: number;
    gross_loss: number;
    profit_factor: number;
    win_rate: number;
    total_closed_trades: number;
    winning_trades: number;
    losing_trades: number;
    today_start_ts: number;
    today_pnl_usdt: number;
    max_drawdown: number;
    paper_equity_usdt: number;
    equity_usdt: number;
    total_fees_usdt: number;
    equity_curve_points: number;
}

interface TradeRow {
    id: number;
    watch_id: number;
    symbol: string;
    side: string;
    price: number;
    quantity: number;
    amount_usdt: number;
    pnl: number | null;
    fee: number | null;
    created_at: number;
}

interface EquityCurveRow {
    ts: number;
    equity: number;
}

// Get start of today (local server time)
function getStartOfToday(): number {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor(startOfDay.getTime() / 1000);
}

// Calculate max drawdown from equity curve
function calculateMaxDrawdown(equityCurve: EquityCurveRow[]): number {
    if (equityCurve.length === 0) return 0;

    let peak = equityCurve[0].equity;
    let maxDrawdown = 0;

    for (const point of equityCurve) {
        if (point.equity > peak) {
            peak = point.equity;
        }
        const drawdown = (peak - point.equity) / peak;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }

    return Math.round(maxDrawdown * 10000) / 10000;  // 4 decimal places
}

export default async function metricsRoute(app: FastifyInstance) {
    // GET /v1/metrics/debug - Debug metrics (non-production only)
    app.get('/metrics/debug', async (request: FastifyRequest, reply: FastifyReply): Promise<MetricsDebugResponse> => {
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (nodeEnv === 'production') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Debug endpoints are disabled in production',
            });
        }

        // Get all SELL trades for realized PnL
        const sellTrades = db.prepare(`
            SELECT * FROM trades WHERE side = 'SELL' ORDER BY created_at DESC
        `).all() as TradeRow[];

        // Calculate realized PnL, gross profit/loss
        let realized = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let winningTrades = 0;
        let losingTrades = 0;
        let totalFees = 0;

        for (const trade of sellTrades) {
            const pnl = trade.pnl || 0;
            realized += pnl;

            if (pnl > 0) {
                grossProfit += pnl;
                winningTrades++;
            } else if (pnl < 0) {
                grossLoss += Math.abs(pnl);
                losingTrades++;
            }
        }

        // Get all trades for total fees
        const allTrades = db.prepare('SELECT * FROM trades').all() as TradeRow[];
        for (const trade of allTrades) {
            totalFees += trade.fee || 0;
        }

        // Calculate unrealized PnL from WATCHING watches
        const activeWatches = db.prepare(`
            SELECT * FROM watches WHERE status = 'ACTIVE'
        `).all() as Array<{
            id: number;
            symbol: string;
            entry_price: number;
            current_price: number;
            quantity: number;
            amount_usdt: number;
            unrealized_pnl: number;
        }>;

        let unrealized = 0;
        for (const watch of activeWatches) {
            unrealized += watch.unrealized_pnl || 0;
        }

        // Today's PnL
        const startOfToday = getStartOfToday();
        const todaySells = db.prepare(`
            SELECT SUM(pnl) as total FROM trades WHERE side = 'SELL' AND created_at >= ?
        `).get(startOfToday) as { total: number | null };
        const todayPnl = todaySells?.total || 0;

        // Equity curve and max drawdown
        const equityCurve = db.prepare(`
            SELECT ts, equity FROM equity_curve ORDER BY ts ASC
        `).all() as EquityCurveRow[];

        const maxDrawdown = calculateMaxDrawdown(equityCurve);

        // Portfolio values
        const paperEquity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');
        const equity = paperEquity + realized + unrealized;

        // Calculations
        const totalClosed = sellTrades.length;
        const winRate = totalClosed > 0 ? winningTrades / totalClosed : 0;
        const profitFactor = grossLoss === 0 ? 0 : grossProfit / grossLoss;

        return {
            realized_pnl_usdt: Math.round(realized * 100) / 100,
            unrealized_pnl_usdt: Math.round(unrealized * 100) / 100,
            pnl_total_usdt: Math.round((realized + unrealized) * 100) / 100,
            gross_profit: Math.round(grossProfit * 100) / 100,
            gross_loss: Math.round(grossLoss * 100) / 100,
            profit_factor: Math.round(profitFactor * 100) / 100,
            win_rate: Math.round(winRate * 10000) / 10000,
            total_closed_trades: totalClosed,
            winning_trades: winningTrades,
            losing_trades: losingTrades,
            today_start_ts: startOfToday,
            today_pnl_usdt: Math.round(todayPnl * 100) / 100,
            max_drawdown: maxDrawdown,
            paper_equity_usdt: paperEquity,
            equity_usdt: Math.round(equity * 100) / 100,
            total_fees_usdt: Math.round(totalFees * 100) / 100,
            equity_curve_points: equityCurve.length,
        };
    });
}

// Export helper functions for use in other routes
export { getStartOfToday, calculateMaxDrawdown };
