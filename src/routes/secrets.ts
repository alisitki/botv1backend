import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import db, { saveUserSecrets, getUserSettings } from '../db/index.js';
import { encrypt } from '../utils/crypto.js';
import crypto from 'crypto';

const binanceSecretsSchema = z.object({
    api_key: z.string().min(1),
    api_secret: z.string().min(1),
    account_type: z.enum(['SPOT', 'FUTURES']).default('SPOT'),
});

async function verifyBinanceKeys(
    apiKey: string,
    apiSecret: string,
    accountType: 'SPOT' | 'FUTURES',
    useTestnet: boolean
): Promise<boolean> {
    let baseUrl: string;
    let endpoint: string;

    if (accountType === 'FUTURES') {
        baseUrl = useTestnet
            ? 'https://testnet.binancefuture.com'
            : 'https://fapi.binance.com';
        endpoint = '/fapi/v2/balance';
    } else {
        baseUrl = useTestnet
            ? 'https://testnet.binance.vision'
            : 'https://api.binance.com';
        endpoint = '/api/v3/account';
    }

    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
        const response = await fetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: {
                'X-MBX-APIKEY': apiKey
            }
        });

        if (response.status === 200) {
            return true;
        }

        const errText = await response.text();
        console.error(`Binance verification failed (${accountType}):`, response.status, errText);
        return false;
    } catch (err) {
        console.error("Binance verification error:", err);
        return false;
    }
}

export default async function secretsRoutes(app: FastifyInstance) {
    app.post('/secrets/binance', async (request, reply) => {
        const userId = request.session.get('userId');
        if (!userId) {
            return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Not logged in' });
        }

        const { api_key, api_secret, account_type } = binanceSecretsSchema.parse(request.body);

        // Check if user is on testnet
        const settingsRow = getUserSettings(userId);
        const s = settingsRow ? JSON.parse(settingsRow.settings_json) : {};
        const useTestnet = s.binance_testnet === true;

        // Verify keys
        const verified = await verifyBinanceKeys(api_key, api_secret, account_type, useTestnet);
        if (!verified) {
            return reply.status(400).send({ error: 'INVALID_BINANCE_KEYS' });
        }

        // Encrypt secrets
        const combined = JSON.stringify({ api_key, api_secret });
        const { encrypted, nonce } = encrypt(combined);

        // Save with account_type
        db.prepare(`
            INSERT OR REPLACE INTO user_secrets 
            (user_id, binance_api_key_enc, binance_api_secret_enc, nonce, account_type, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?)
        `).run(userId, encrypted, nonce, account_type, Math.floor(Date.now() / 1000));

        return { ok: true, verified: true, account_type };
    });
}

