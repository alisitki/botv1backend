import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getMeta } from '../db/index.js';
import { z } from 'zod';

// FAZ 3: Dev price override schema with optional symbol
const devPriceSchema = z.object({
    symbol: z.string().min(1).optional(),
    price: z.number().positive(),
});

const devPriceQuerySchema = z.object({
    symbol: z.string().min(1).optional(),
});

export default async function devRoute(app: FastifyInstance) {
    // POST /v1/dev/price - Set dev price override for testing
    app.post('/dev/price', async (request: FastifyRequest, reply: FastifyReply) => {
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (nodeEnv === 'production') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev endpoints are disabled in production',
            });
        }

        const modeRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('mode') as { value: string } | undefined;
        const mode = modeRow?.value || 'PAPER';

        if (mode !== 'PAPER') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev price override only available in PAPER mode',
            });
        }

        const input = devPriceSchema.parse(request.body);

        // FAZ 3: Use symbol from body or default to active_symbol
        const activeSymbol = getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
        const symbol = (input.symbol || activeSymbol).toUpperCase();

        // Store per-symbol dev price override
        db.prepare(`
            INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)
        `).run(`dev_price_override_${symbol}`, input.price.toString());

        // Also update worker_prices directly for immediate effect
        const now = Math.floor(Date.now() / 1000);
        db.prepare(`
            INSERT INTO worker_prices (symbol, price, latency_ms, connected, updated_at)
            VALUES (?, ?, 0, 1, ?)
            ON CONFLICT(symbol) DO UPDATE SET
                price = excluded.price,
                latency_ms = 0,
                connected = 1,
                updated_at = excluded.updated_at
        `).run(symbol, input.price, now);

        console.log(`🔧 DEV: Price override for ${symbol} set to ${input.price}`);

        return {
            success: true,
            symbol,
            price: input.price,
            message: `Price override for ${symbol} set to ${input.price}.`,
        };
    });

    // DELETE /v1/dev/price - Clear dev price override
    app.delete('/dev/price', async (request: FastifyRequest, reply: FastifyReply) => {
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (nodeEnv === 'production') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev endpoints are disabled in production',
            });
        }

        const query = devPriceQuerySchema.parse(request.query);
        const activeSymbol = getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
        const symbol = (query.symbol || activeSymbol).toUpperCase();

        // Remove per-symbol dev price override
        db.prepare(`DELETE FROM meta WHERE key = ?`).run(`dev_price_override_${symbol}`);

        // Also remove legacy single override if clearing default symbol
        if (!query.symbol) {
            db.prepare(`DELETE FROM meta WHERE key = 'dev_price_override'`).run();
        }

        return {
            success: true,
            symbol,
            message: `Price override for ${symbol} cleared.`,
        };
    });
}
