import db, { getUserSettings, getUserSecrets } from '../db/index.js';
import crypto from 'crypto';
import { decrypt } from '../utils/crypto.js';

export interface OrderResult {
    filled_qty: number;
    avg_price: number;
    fee_usdt: number;
    order_id: string;
}

export interface MarketBuyParams {
    userId: string;
    symbol: string;
    amount_usdt: number;
}

export interface MarketSellParams {
    userId: string;
    symbol: string;
    qty: number;
}

export interface ExecutionAdapter {
    name: string;
    placeMarketBuy(params: MarketBuyParams): Promise<OrderResult>;
    placeMarketSell(params: MarketSellParams): Promise<OrderResult>;
}

// ============================================
// Paper Adapter (Simulation)
// ============================================

function getWorkerPrice(symbol: string): number {
    const row = db.prepare('SELECT price FROM worker_prices WHERE symbol = ?').get(symbol) as { price: number } | undefined;
    return row?.price || 0;
}

function getPaperFeeBps(userId: string): number {
    const row = getUserSettings(userId);
    if (!row) return 10;
    const s = JSON.parse(row.settings_json);
    return s.paper_fee_bps || 10;
}

export class PaperAdapter implements ExecutionAdapter {
    name = 'PAPER';

    async placeMarketBuy(params: MarketBuyParams): Promise<OrderResult> {
        const price = getWorkerPrice(params.symbol);
        if (price === 0) {
            throw new Error(`No price available for ${params.symbol}`);
        }

        const qty = params.amount_usdt / price;
        const feeBps = getPaperFeeBps(params.userId);
        const fee_usdt = params.amount_usdt * feeBps / 10000;
        const orderId = `PAPER-BUY-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        return {
            filled_qty: qty,
            avg_price: price,
            fee_usdt,
            order_id: orderId,
        };
    }

    async placeMarketSell(params: MarketSellParams): Promise<OrderResult> {
        const price = getWorkerPrice(params.symbol);
        if (price === 0) {
            throw new Error(`No price available for ${params.symbol}`);
        }

        const notional = params.qty * price;
        const feeBps = getPaperFeeBps(params.userId);
        const fee_usdt = notional * feeBps / 10000;
        const orderId = `PAPER-SELL-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

        return {
            filled_qty: params.qty,
            avg_price: price,
            fee_usdt,
            order_id: orderId,
        };
    }
}

// ============================================
// Binance Live Adapter (Stub with Auth)
// ============================================

export class BinanceLiveAdapter implements ExecutionAdapter {
    name = 'LIVE';

    private getCredentials(userId: string): { apiKey: string; apiSecret: string; baseUrl: string } {
        const secrets = getUserSecrets(userId);
        if (!secrets || !secrets.binance_api_key_enc || !secrets.nonce) {
            throw new Error('LIVE_CREDENTIALS_MISSING');
        }

        const decrypted = decrypt(secrets.binance_api_key_enc, secrets.nonce);
        const { api_key, api_secret } = JSON.parse(decrypted);

        const settingsRow = getUserSettings(userId);
        const s = settingsRow ? JSON.parse(settingsRow.settings_json) : {};
        const useTestnet = s.binance_testnet === true;

        const baseUrl = useTestnet
            ? 'https://testnet.binance.vision'
            : 'https://api.binance.com';

        return { apiKey: api_key, apiSecret: api_secret, baseUrl };
    }

    private sign(queryString: string, secret: string): string {
        return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
    }

    async placeMarketBuy(params: MarketBuyParams): Promise<OrderResult> {
        const { apiKey, apiSecret, baseUrl } = this.getCredentials(params.userId);

        const price = getWorkerPrice(params.symbol);
        if (price === 0) {
            throw new Error('NO_MARKET_DATA');
        }

        const timestamp = Date.now();
        const queryParams = new URLSearchParams({
            symbol: params.symbol,
            side: 'BUY',
            type: 'MARKET',
            quoteOrderQty: params.amount_usdt.toFixed(2),
            timestamp: timestamp.toString(),
        });

        const signature = this.sign(queryParams.toString(), apiSecret);
        queryParams.append('signature', signature);

        console.log(`🔴 LIVE BUY [STUB]: ${params.symbol} amount=${params.amount_usdt} USDT for user ${params.userId}`);

        const qty = params.amount_usdt / price;
        const fee = params.amount_usdt * 0.001;

        return {
            filled_qty: qty * 0.999,
            avg_price: price * 1.0001,
            fee_usdt: fee,
            order_id: `LIVE-BUY-${timestamp}-${crypto.randomBytes(4).toString('hex')}`,
        };
    }

    async placeMarketSell(params: MarketSellParams): Promise<OrderResult> {
        const { apiKey, apiSecret, baseUrl } = this.getCredentials(params.userId);

        const price = getWorkerPrice(params.symbol);
        if (price === 0) {
            throw new Error('NO_MARKET_DATA');
        }

        const timestamp = Date.now();
        const queryParams = new URLSearchParams({
            symbol: params.symbol,
            side: 'SELL',
            type: 'MARKET',
            quantity: params.qty.toFixed(8),
            timestamp: timestamp.toString(),
        });

        const signature = this.sign(queryParams.toString(), apiSecret);
        queryParams.append('signature', signature);

        console.log(`🔴 LIVE SELL [STUB]: ${params.symbol} qty=${params.qty} for user ${params.userId}`);

        const fee = params.qty * price * 0.001;

        return {
            filled_qty: params.qty,
            avg_price: price * 0.9999,
            fee_usdt: fee,
            order_id: `LIVE-SELL-${timestamp}-${crypto.randomBytes(4).toString('hex')}`,
        };
    }
}

// ============================================
// Factory
// ============================================

export function getExecutionAdapter(mode: 'PAPER' | 'LIVE'): ExecutionAdapter {
    if (mode === 'LIVE') {
        return new BinanceLiveAdapter();
    }
    return new PaperAdapter();
}
