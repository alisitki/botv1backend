import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getUserSettings, getMeta } from '../db/index.js';
import { z } from 'zod';

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
        const userId = request.session.get('userId')!;
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (nodeEnv === 'production') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev endpoints are disabled in production',
            });
        }

        const settingsRow = getUserSettings(userId);
        const s = settingsRow ? JSON.parse(settingsRow.settings_json) : {};
        const mode = s.mode || 'PAPER';

        if (mode !== 'PAPER') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev price override only available in PAPER mode',
            });
        }

        const input = devPriceSchema.parse(request.body);
        const activeSymbol = s.active_symbol || 'BTCUSDT';
        const symbol = (input.symbol || activeSymbol).toUpperCase();

        // Store per-symbol dev price override (Global for now, as worker is global)
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

        return {
            success: true,
            symbol,
            price: input.price,
            message: `Price override for ${symbol} set to ${input.price}.`,
        };
    });

    // DELETE /v1/dev/price - Clear dev price override
    app.delete('/dev/price', async (request: FastifyRequest, reply: FastifyReply) => {
        const userId = request.session.get('userId')!;
        const nodeEnv = process.env.NODE_ENV || 'development';
        if (nodeEnv === 'production') {
            return reply.status(403).send({
                error: 'FORBIDDEN',
                message: 'Dev endpoints are disabled in production',
            });
        }

        const query = devPriceQuerySchema.parse(request.query);
        const settingsRow = getUserSettings(userId);
        const s = settingsRow ? JSON.parse(settingsRow.settings_json) : {};
        const activeSymbol = s.active_symbol || 'BTCUSDT';
        const symbol = (query.symbol || activeSymbol).toUpperCase();

        db.prepare(`DELETE FROM meta WHERE key = ?`).run(`dev_price_override_${symbol}`);

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
