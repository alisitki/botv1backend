// FAZ 4: Execution Adapter Interface and Implementations

export interface OrderResult {
    filled_qty: number;
    avg_price: number;
    fee_usdt: number;
    order_id: string;
}

export interface MarketBuyParams {
    symbol: string;
    amount_usdt: number;
}

export interface MarketSellParams {
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

import db, { getMeta } from '../db/index.js';
import crypto from 'crypto';

function getWorkerPrice(symbol: string): number {
    const row = db.prepare('SELECT price FROM worker_prices WHERE symbol = ?').get(symbol) as { price: number } | undefined;
    return row?.price || 0;
}

function getPaperFeeBps(): number {
    return parseInt(getMeta('paper_fee_bps') || '10', 10);  // Default 10 bps = 0.10%
}

export class PaperAdapter implements ExecutionAdapter {
    name = 'PAPER';

    async placeMarketBuy(params: MarketBuyParams): Promise<OrderResult> {
        const price = getWorkerPrice(params.symbol);
        if (price === 0) {
            throw new Error(`No price available for ${params.symbol}`);
        }

        const qty = params.amount_usdt / price;
        const feeBps = getPaperFeeBps();
        const fee_usdt = params.amount_usdt * feeBps / 10000;  // FAZ 5: Calculate fee
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
        const feeBps = getPaperFeeBps();
        const fee_usdt = notional * feeBps / 10000;  // FAZ 5: Calculate fee
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
// Binance Live Adapter (Stub for FAZ4)
// ============================================

// getMeta already imported above

export class BinanceLiveAdapter implements ExecutionAdapter {
    name = 'LIVE';

    private getCredentials(): { apiKey: string; apiSecret: string; baseUrl: string } {
        const apiKey = getMeta('binance_api_key') || '';
        const apiSecret = getMeta('binance_api_secret') || '';
        const useTestnet = getMeta('binance_testnet') === 'true';

        const baseUrl = useTestnet
            ? 'https://testnet.binance.vision'
            : 'https://api.binance.com';

        return { apiKey, apiSecret, baseUrl };
    }

    private sign(queryString: string, secret: string): string {
        return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
    }

    async placeMarketBuy(params: MarketBuyParams): Promise<OrderResult> {
        const { apiKey, apiSecret, baseUrl } = this.getCredentials();

        if (!apiKey || !apiSecret) {
            throw new Error('LIVE_CREDENTIALS_MISSING');
        }

        // Get current price for quoteOrderQty
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

        // FAZ4 Stub: Return simulated result instead of actual API call
        // In production, this would make the actual HTTP request
        console.log(`🔴 LIVE BUY [STUB]: ${params.symbol} amount=${params.amount_usdt} USDT`);
        console.log(`   Would call: POST ${baseUrl}/api/v3/order?${queryParams.toString()}`);

        // Simulated response
        const qty = params.amount_usdt / price;
        const fee = params.amount_usdt * 0.001;  // 0.1% fee

        return {
            filled_qty: qty * 0.999,  // Slight slippage simulation
            avg_price: price * 1.0001,  // Slight price impact
            fee_usdt: fee,
            order_id: `LIVE-BUY-${timestamp}-${crypto.randomBytes(4).toString('hex')}`,
        };
    }

    async placeMarketSell(params: MarketSellParams): Promise<OrderResult> {
        const { apiKey, apiSecret, baseUrl } = this.getCredentials();

        if (!apiKey || !apiSecret) {
            throw new Error('LIVE_CREDENTIALS_MISSING');
        }

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

        // FAZ4 Stub
        console.log(`🔴 LIVE SELL [STUB]: ${params.symbol} qty=${params.qty}`);
        console.log(`   Would call: POST ${baseUrl}/api/v3/order?${queryParams.toString()}`);

        const fee = params.qty * price * 0.001;

        return {
            filled_qty: params.qty,
            avg_price: price * 0.9999,  // Slight price impact
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
