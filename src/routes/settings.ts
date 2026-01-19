import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import db, { getMeta, setMeta } from '../db/index.js';
import { z } from 'zod';
import { logAudit, maskSecret } from '../utils/audit.js';

// FAZ 4 + FAZ 5 + FAZ 8: Extended settings schema
const settingsUpdateSchema = z.object({
    mode: z.enum(['PAPER', 'LIVE']).optional(),
    active_symbol: z.string().min(1).optional(),
    timeframe: z.string().min(1).optional(),
    paper_equity_usdt: z.number().positive().optional(),
    paper_fee_bps: z.number().min(0).max(1000).optional(),
    // FAZ 4: LIVE settings
    binance_api_key: z.string().optional(),
    binance_api_secret: z.string().optional(),
    binance_testnet: z.boolean().optional(),
    live_enabled: z.boolean().optional(),
    live_max_order_usdt: z.number().positive().optional(),
    live_allow_symbols: z.array(z.string()).optional(),
    // FAZ 8: Telegram settings
    telegram_enabled: z.boolean().optional(),
    telegram_bot_token: z.string().optional(),
    telegram_chat_id: z.string().optional(),
    telegram_notify_on: z.array(z.string()).optional(),
});

export interface SettingsResponse {
    mode: 'PAPER' | 'LIVE';
    active_symbol: string;
    timeframe: string;
    paper_equity_usdt: number;
    paper_fee_bps: number;
    // FAZ 4: LIVE settings
    binance_api_key: string;
    binance_api_secret: string;
    binance_testnet: boolean;
    live_enabled: boolean;
    live_max_order_usdt: number;
    live_allow_symbols: string[];
    // FAZ 8: Telegram settings
    telegram_enabled: boolean;
    telegram_bot_token: string;
    telegram_chat_id: string;
    telegram_notify_on: string[];
}

function getSettings(): SettingsResponse {
    const mode = getMeta('mode') || 'PAPER';
    const activeSymbol = getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
    const timeframe = getMeta('timeframe') || '15m';
    const paperEquity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');
    const paperFeeBps = parseInt(getMeta('paper_fee_bps') || '10', 10);

    // FAZ 4: LIVE settings
    const apiKey = getMeta('binance_api_key') || '';
    const apiSecret = getMeta('binance_api_secret') || '';
    const testnet = getMeta('binance_testnet') === 'true';
    const liveEnabled = getMeta('live_enabled') === 'true';
    const liveMaxOrder = parseFloat(getMeta('live_max_order_usdt') || '50');
    const liveAllowSymbols = getMeta('live_allow_symbols');

    // FAZ 8: Telegram settings
    const tgEnabled = getMeta('telegram_enabled') === 'true';
    const tgToken = getMeta('telegram_bot_token') || '';
    const tgChatId = getMeta('telegram_chat_id') || '';
    const tgNotifyOn = getMeta('telegram_notify_on');

    return {
        mode: mode as 'PAPER' | 'LIVE',
        active_symbol: activeSymbol,
        timeframe,
        paper_equity_usdt: paperEquity,
        paper_fee_bps: paperFeeBps,
        // Masked values for GET
        binance_api_key: maskSecret(apiKey),
        binance_api_secret: apiSecret ? '********' : '',
        binance_testnet: testnet,
        live_enabled: liveEnabled,
        live_max_order_usdt: liveMaxOrder,
        live_allow_symbols: liveAllowSymbols ? JSON.parse(liveAllowSymbols) : ['BTCUSDT'],
        telegram_enabled: tgEnabled,
        telegram_bot_token: maskSecret(tgToken),
        telegram_chat_id: maskSecret(tgChatId), // Mask chat ID as requested (optional but good practice)
        telegram_notify_on: tgNotifyOn ? JSON.parse(tgNotifyOn) : ['SELL_TRIGGERED', 'WATCH_CREATED', 'TP_MOVED'],
    };
}

export default async function settingsRoute(app: FastifyInstance) {
    // GET /v1/settings
    app.get('/settings', async (): Promise<SettingsResponse> => {
        return getSettings();
    });

    // POST /v1/settings - Partial update
    app.post('/settings', async (request: FastifyRequest, reply: FastifyReply): Promise<SettingsResponse> => {
        const input = settingsUpdateSchema.parse(request.body);

        // Validate LIVE mode
        if (input.mode === 'LIVE' && getMeta('live_enabled') !== 'true' && !input.live_enabled) {
            return reply.status(400).send({
                error: 'LIVE_DISABLED',
                message: 'Cannot set mode to LIVE when live_enabled is false',
            });
        }

        // Track changes for audit
        const changes: Record<string, unknown> = {};

        // Helper to update meta if defined
        const updateMeta = (key: string, value: string | undefined, auditValue?: unknown) => {
            if (value !== undefined) {
                setMeta(key, value);
                changes[key] = auditValue !== undefined ? auditValue : value;
            }
        };

        if (input.mode !== undefined) updateMeta('mode', input.mode);
        if (input.active_symbol !== undefined) {
            const sym = input.active_symbol.toUpperCase();
            setMeta('active_symbol', sym);
            setMeta('symbol', sym);
            changes.active_symbol = sym;
        }
        if (input.timeframe !== undefined) updateMeta('timeframe', input.timeframe);
        if (input.paper_equity_usdt !== undefined) {
            setMeta('paper_equity_usdt', input.paper_equity_usdt.toString());
            setMeta('equity', input.paper_equity_usdt.toString());
            changes.paper_equity_usdt = input.paper_equity_usdt;
        }
        if (input.paper_fee_bps !== undefined) updateMeta('paper_fee_bps', input.paper_fee_bps.toString(), input.paper_fee_bps);

        if (input.binance_api_key !== undefined) updateMeta('binance_api_key', input.binance_api_key, maskSecret(input.binance_api_key));
        if (input.binance_api_secret !== undefined) updateMeta('binance_api_secret', input.binance_api_secret, '********');
        if (input.binance_testnet !== undefined) updateMeta('binance_testnet', input.binance_testnet.toString(), input.binance_testnet);
        if (input.live_enabled !== undefined) updateMeta('live_enabled', input.live_enabled.toString(), input.live_enabled);
        if (input.live_max_order_usdt !== undefined) updateMeta('live_max_order_usdt', input.live_max_order_usdt.toString(), input.live_max_order_usdt);
        if (input.live_allow_symbols !== undefined) {
            const syms = input.live_allow_symbols.map(s => s.toUpperCase());
            updateMeta('live_allow_symbols', JSON.stringify(syms), syms);
        }

        // FAZ 8: Telegram
        if (input.telegram_enabled !== undefined) updateMeta('telegram_enabled', input.telegram_enabled.toString(), input.telegram_enabled);
        if (input.telegram_bot_token !== undefined) updateMeta('telegram_bot_token', input.telegram_bot_token, maskSecret(input.telegram_bot_token));
        if (input.telegram_chat_id !== undefined) updateMeta('telegram_chat_id', input.telegram_chat_id, maskSecret(input.telegram_chat_id));
        if (input.telegram_notify_on !== undefined) updateMeta('telegram_notify_on', JSON.stringify(input.telegram_notify_on), input.telegram_notify_on);

        // Audit log
        logAudit('API', 'SETTINGS_UPDATE', changes);

        return getSettings();
    });
}
