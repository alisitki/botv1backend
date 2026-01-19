// FAZ 8: OHLC Candles Endpoint (Binance Proxy + Cache)
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';

const ohlcQuerySchema = z.object({
    symbol: z.string().min(1),
    timeframe: z.string().default('15m'),
    limit: z.coerce.number().int().min(1).max(1000).default(200),
});

// Simple in-memory cache
interface CacheEntry {
    data: any;
    ts: number;
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5000; // 5s cache

export default async function ohlcRoute(app: FastifyInstance) {
    app.get('/ohlc', async (request: FastifyRequest, reply: FastifyReply) => {
        const { symbol, timeframe, limit } = ohlcQuerySchema.parse(request.query);
        const cacheKey = `${symbol}:${timeframe}:${limit}`;
        const now = Date.now();

        // Check cache
        if (cache.has(cacheKey)) {
            const entry = cache.get(cacheKey)!;
            if (now - entry.ts < CACHE_TTL_MS) {
                return entry.data;
            }
        }

        // Fetch from Binance
        try {
            // Binance interval mapping if needed, but standard ones match usually (1m, 5m, 15m, 1h, 4h, 1d)
            const response = await fetch(
                `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${timeframe}&limit=${limit}`
            );

            if (!response.ok) {
                throw new Error(`Binance API error: ${response.status}`);
            }

            const rawData = await response.json();

            // Normalize data: [open_time, open, high, low, close, volume, ...]
            const candles = rawData.map((k: any[]) => ({
                ts: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
            }));

            // Save to cache
            cache.set(cacheKey, { data: candles, ts: now });

            return candles;

        } catch (error) {
            request.log.error(error);
            return reply.status(502).send({
                error: 'UPSTREAM_ERROR',
                message: 'Failed to fetch OHLC data from Binance',
            });
        }
    });
}
