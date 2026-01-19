// FAZ 5: Portfolio with accurate metrics calculated from DB

import { FastifyInstance } from 'fastify';
import db, { getMeta, Watch, Trade, EquityCurvePoint } from '../db/index.js';
import type { PortfolioResponse } from '../schemas/index.js';

// Get worker price for a symbol
function getWorkerPrice(symbol: string): number {
    const row = db.prepare('SELECT price FROM worker_prices WHERE symbol = ?').get(symbol) as { price: number } | undefined;
    return row?.price || 0;
}

export default async function portfolioRoute(app: FastifyInstance) {
    app.get('/portfolio', async (): Promise<PortfolioResponse> => {
        // Get base equity
        const paperEquity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');

        // FAZ 5: Calculate realized PnL from SELL trades (net of fees)
        const sellTrades = db.prepare(`
            SELECT * FROM trades WHERE side = 'SELL'
        `).all() as Trade[];

        let pnlRealized = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let wins = 0;
        let losses = 0;

        for (const trade of sellTrades) {
            const pnl = trade.pnl || 0;
            pnlRealized += pnl;

            if (pnl > 0) {
                wins++;
                grossProfit += pnl;
            } else if (pnl < 0) {
                losses++;
                grossLoss += Math.abs(pnl);
            }
        }

        // FAZ 5: Calculate unrealized PnL from WATCHING watches (multi-symbol)
        const activeWatches = db.prepare(`
            SELECT * FROM watches WHERE status = 'ACTIVE'
        `).all() as Watch[];

        let pnlUnrealized = 0;
        for (const watch of activeWatches) {
            // Get price for each watch's symbol
            const price = getWorkerPrice(watch.symbol) || watch.current_price;
            if (price > 0) {
                const priceDiff = price - watch.entry_price;
                const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
                pnlUnrealized += pnl;
            }
        }

        const pnlTotal = pnlRealized + pnlUnrealized;
        const equityUsdt = paperEquity + pnlTotal;

        // Win rate and profit factor
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

        // FAZ 5: Max drawdown from equity curve
        const equityCurve = db.prepare(`
            SELECT ts, equity FROM equity_curve ORDER BY ts ASC
        `).all() as EquityCurvePoint[];

        let maxDrawdown = 0;
        let peak = equityCurve.length > 0 ? equityCurve[0].equity : paperEquity;

        for (const point of equityCurve) {
            if (point.equity > peak) {
                peak = point.equity;
            }
            const drawdown = (peak - point.equity) / peak;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }

        return {
            equity_usdt: Math.round(equityUsdt * 100) / 100,
            pnl_total_usdt: Math.round(pnlTotal * 100) / 100,
            pnl_realized_usdt: Math.round(pnlRealized * 100) / 100,
            pnl_unrealized_usdt: Math.round(pnlUnrealized * 100) / 100,
            win_rate: Math.round(winRate * 10000) / 10000,  // 4 decimal places
            max_drawdown: Math.round(maxDrawdown * 10000) / 10000,
            profit_factor: Math.round(profitFactor * 100) / 100,
            equity_curve: equityCurve.map(p => ({ ts: p.ts, equity: Math.round(p.equity * 100) / 100 })),
        };
    });
}
