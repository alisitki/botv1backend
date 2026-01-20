// Multi-user portfolio with real balances from portfolio_state

import { FastifyInstance, FastifyRequest } from 'fastify';
import db, { getUserSettings, Watch, Trade, EquityCurvePoint } from '../db/index.js';

interface BalanceItem {
    asset: string;
    free: number;
    locked: number;
    value_usdt?: number;
}

interface PortfolioResponse {
    equity_usdt: number;
    balances: BalanceItem[];
    pnl_total_usdt: number;
    pnl_realized_usdt: number;
    pnl_unrealized_usdt: number;
    win_rate: number;
    max_drawdown: number;
    profit_factor: number;
    equity_curve: { ts: number; equity: number }[];
    last_sync_at: number | null;
    account_type: string;
}

// Get worker price for a symbol
function getWorkerPrice(symbol: string): number {
    const row = db.prepare('SELECT price FROM worker_prices WHERE symbol = ?').get(symbol) as { price: number } | undefined;
    return row?.price || 0;
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

// Get user account type
function getUserAccountType(userId: string): string {
    const row = db.prepare('SELECT account_type FROM user_secrets WHERE user_id = ?').get(userId) as { account_type: string } | undefined;
    return row?.account_type || 'SPOT';
}

export default async function portfolioRoute(app: FastifyInstance) {
    app.get('/portfolio', async (request: FastifyRequest): Promise<PortfolioResponse> => {
        const userId = request.session.get('userId')!;

        // Get portfolio state (real data from Binance)
        const portfolioState = getPortfolioState(userId);
        const equityUsdt = portfolioState?.equity_usdt || 0;
        const lastSyncAt = portfolioState?.updated_at || null;

        // Parse balances
        let balances: BalanceItem[] = [];
        if (portfolioState?.balance_json) {
            try {
                const balanceMap = JSON.parse(portfolioState.balance_json) as Record<string, { free: number; locked: number }>;
                for (const [asset, bal] of Object.entries(balanceMap)) {
                    const item: BalanceItem = {
                        asset,
                        free: bal.free,
                        locked: bal.locked,
                    };
                    // Add USDT value for non-USDT assets
                    if (asset !== 'USDT') {
                        const price = getWorkerPrice(`${asset}USDT`);
                        if (price > 0) {
                            item.value_usdt = Math.round((bal.free + bal.locked) * price * 100) / 100;
                        }
                    }
                    balances.push(item);
                }
            } catch (e) {
                // Ignore parse errors
            }
        }

        // Calculate realized PnL from SELL trades
        const sellTrades = db.prepare(`
            SELECT * FROM trades WHERE side = 'SELL' AND user_id = ?
        `).all(userId) as Trade[];

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

        // Calculate unrealized PnL from active watches
        const activeWatches = db.prepare(`
            SELECT * FROM watches WHERE status = 'ACTIVE' AND user_id = ?
        `).all(userId) as Watch[];

        let pnlUnrealized = 0;
        for (const watch of activeWatches) {
            const price = getWorkerPrice(watch.symbol) || watch.current_price;
            if (price > 0) {
                const priceDiff = price - watch.entry_price;
                const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
                pnlUnrealized += pnl;
            }
        }

        const pnlTotal = pnlRealized + pnlUnrealized;

        // Win rate and profit factor
        const totalTrades = wins + losses;
        const winRate = totalTrades > 0 ? wins / totalTrades : 0;
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

        // Max drawdown from equity curve
        const equityCurve = db.prepare(`
            SELECT ts, equity FROM equity_curve WHERE user_id = ? ORDER BY ts ASC
        `).all(userId) as EquityCurvePoint[];

        let maxDrawdown = 0;
        let peak = equityCurve.length > 0 ? equityCurve[0].equity : equityUsdt;

        for (const point of equityCurve) {
            if (point.equity > peak) peak = point.equity;
            const drawdown = peak > 0 ? (peak - point.equity) / peak : 0;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        const accountType = getUserAccountType(userId);

        return {
            equity_usdt: Math.round(equityUsdt * 100) / 100,
            balances,
            pnl_total_usdt: Math.round(pnlTotal * 100) / 100,
            pnl_realized_usdt: Math.round(pnlRealized * 100) / 100,
            pnl_unrealized_usdt: Math.round(pnlUnrealized * 100) / 100,
            win_rate: Math.round(winRate * 10000) / 10000,
            max_drawdown: Math.round(maxDrawdown * 10000) / 10000,
            profit_factor: Math.round(profitFactor * 100) / 100,
            equity_curve: equityCurve.map(p => ({ ts: p.ts, equity: Math.round(p.equity * 100) / 100 })),
            last_sync_at: lastSyncAt,
            account_type: accountType,
        };
    });
}

