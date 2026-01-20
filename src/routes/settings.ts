import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getUserSettings, updateUserSettings, getUserSecrets } from '../db/index.js';
import { z } from 'zod';
import { maskSecret } from '../utils/audit.js';

const settingsUpdateSchema = z.object({
    mode: z.enum(['PAPER', 'LIVE']).optional(),
    active_symbol: z.string().min(1).optional(),
    timeframe: z.string().min(1).optional(),
    paper_equity_usdt: z.number().positive().optional(),
    paper_fee_bps: z.number().min(0).max(1000).optional(),
    binance_testnet: z.boolean().optional(),
    live_enabled: z.boolean().optional(),
    live_max_order_usdt: z.number().positive().optional(),
    live_allow_symbols: z.array(z.string()).optional(),
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
    has_binance_keys: boolean;
    binance_testnet: boolean;
    live_enabled: boolean;
    live_max_order_usdt: number;
    live_allow_symbols: string[];
    telegram_enabled: boolean;
    telegram_bot_token: string;
    telegram_chat_id: string;
    telegram_notify_on: string[];
}

function getSettingsForUser(userId: string): SettingsResponse {
    const row = getUserSettings(userId);
    const s = row ? JSON.parse(row.settings_json) : {};
    const secrets = getUserSecrets(userId);

    return {
        mode: s.mode || 'PAPER',
        active_symbol: s.active_symbol || 'BTCUSDT',
        timeframe: s.timeframe || '15m',
        paper_equity_usdt: s.paper_equity_usdt || 17000,
        paper_fee_bps: s.paper_fee_bps || 10,
        has_binance_keys: !!(secrets?.binance_api_key_enc),
        binance_testnet: s.binance_testnet || false,
        live_enabled: s.live_enabled || false,
        live_max_order_usdt: s.live_max_order_usdt || 50,
        live_allow_symbols: s.live_allow_symbols || ['BTCUSDT'],
        telegram_enabled: s.telegram_enabled || false,
        telegram_bot_token: maskSecret(s.telegram_bot_token || ''),
        telegram_chat_id: maskSecret(s.telegram_chat_id || ''),
        telegram_notify_on: s.telegram_notify_on || ['SELL_TRIGGERED', 'WATCH_CREATED', 'TP_MOVED'],
    };
}

export default async function settingsRoute(app: FastifyInstance) {
    app.get('/settings', async (request: FastifyRequest): Promise<SettingsResponse> => {
        const userId = request.session.get('userId')!;
        return getSettingsForUser(userId);
    });

    app.post('/settings', async (request: FastifyRequest, reply: FastifyReply): Promise<SettingsResponse> => {
        const userId = request.session.get('userId')!;
        const input = settingsUpdateSchema.parse(request.body);

        const currentSettings = getSettingsForUser(userId);

        // Validate LIVE mode
        if (input.mode === 'LIVE' && !currentSettings.live_enabled && !input.live_enabled) {
            return reply.status(400).send({
                error: 'LIVE_DISABLED',
                message: 'Cannot set mode to LIVE when live_enabled is false',
            });
        }

        updateUserSettings(userId, input);

        return getSettingsForUser(userId);
    });
}
