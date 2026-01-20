import { FastifyInstance, FastifyRequest } from 'fastify';
import db, { Trade } from '../db/index.js';
import { limitQuerySchema, TradeResponse } from '../schemas/index.js';

export default async function tradesRoute(app: FastifyInstance) {
    app.get('/trades', async (request: FastifyRequest): Promise<TradeResponse[]> => {
        const userId = request.session.get('userId')!;
        const { limit } = limitQuerySchema.parse(request.query);

        const trades = db.prepare(`
            SELECT * FROM trades 
            WHERE user_id = ?
            ORDER BY created_at DESC 
            LIMIT ?
        `).all(userId, limit) as Trade[];

        // FAZ 1.1 + FAZ 5: Map to UI contract format
        return trades.map(trade => ({
            id: String(trade.id),
            watch_id: String(trade.watch_id),
            symbol: trade.symbol,
            side: trade.side,
            qty: trade.quantity,
            price: trade.price,
            fee_usdt: trade.fee !== null ? Math.round(trade.fee * 100) / 100 : 0,  // FAZ 5: Read from DB
            pnl_usdt: trade.pnl !== null ? Math.round(trade.pnl * 100) / 100 : 0,
            ts: trade.created_at,
        }));
    });
}

