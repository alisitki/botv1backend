import dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import crypto from 'crypto';
import db, { getMeta, setMeta } from './db/index.js';
import { decrypt } from './utils/crypto.js';
import { sendNotification } from './notify/telegram.js';

// Configuration
const ENGINE_INTERVAL_MS = 500;  // Trailing engine tick
const RECONNECT_DELAY_MS = 5000;
const SUBSCRIPTION_CHECK_INTERVAL_MS = 5000;
const ACCOUNT_SYNC_INTERVAL_MS = 15000;  // Per-user REST sync interval
const STAGGER_DELAY_MS = 1500;  // Delay between user syncs

// State
let ws: WebSocket | null = null;
let currentSymbols: Set<string> = new Set();
let prices: Map<string, { price: number; latency: number; connected: boolean }> = new Map();
let lastTpNotifyTime: Map<number, number> = new Map();
let userLastSyncTime: Map<string, number> = new Map();

// User with secrets interface
interface UserWithSecrets {
    id: string;
    email: string;
    binance_api_key_enc: string;
    nonce: string;
    account_type: 'SPOT' | 'FUTURES';
}

console.log('');
console.log('🔄 Trading Bot Worker (Multi-User Mode)');
console.log(`⏱️  Engine interval: ${ENGINE_INTERVAL_MS}ms`);
console.log(`🔄 Account sync interval: ${ACCOUNT_SYNC_INTERVAL_MS}ms`);
console.log('');

// ============================================
// Database Helpers
// ============================================

function getUsersWithSecrets(): UserWithSecrets[] {
    return db.prepare(`
        SELECT u.id, u.email, s.binance_api_key_enc, s.nonce, s.account_type
        FROM users u
        JOIN user_secrets s ON u.id = s.user_id
        WHERE s.binance_api_key_enc IS NOT NULL AND s.nonce IS NOT NULL
    `).all() as UserWithSecrets[];
}

function getUserSettings(userId: string): { active_symbol: string; mode: string; timeframe: string } {
    const row = db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(userId) as { settings_json: string } | undefined;
    if (row) {
        const settings = JSON.parse(row.settings_json);
        return {
            active_symbol: settings.active_symbol || 'BTCUSDT',
            mode: settings.mode || 'PAPER',
            timeframe: settings.timeframe || '15m',
        };
    }
    return { active_symbol: 'BTCUSDT', mode: 'PAPER', timeframe: '15m' };
}

function getRequiredSymbols(): Set<string> {
    const users = getUsersWithSecrets();
    const symbols = new Set<string>();

    for (const user of users) {
        const settings = getUserSettings(user.id);
        symbols.add(settings.active_symbol.toUpperCase());

        // Add symbols from active watches
        const watches = db.prepare(`
            SELECT DISTINCT symbol FROM watches WHERE status = 'ACTIVE' AND user_id = ?
        `).all(user.id) as { symbol: string }[];

        for (const watch of watches) {
            symbols.add(watch.symbol.toUpperCase());
        }
    }

    return symbols;
}

function upsertWorkerPrice(symbol: string, price: number, latencyMs: number, connected: boolean): void {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
        INSERT INTO worker_prices (symbol, price, latency_ms, connected, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
            price = excluded.price,
            latency_ms = excluded.latency_ms,
            connected = excluded.connected,
            updated_at = excluded.updated_at
    `).run(symbol, price, latencyMs, connected ? 1 : 0, now);
}

function upsertPortfolioState(userId: string, equityUsdt: number, balanceJson: string): void {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
        INSERT INTO portfolio_state (user_id, equity_usdt, balance_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
            equity_usdt = excluded.equity_usdt,
            balance_json = excluded.balance_json,
            updated_at = excluded.updated_at
    `).run(userId, equityUsdt, balanceJson, now);
}

function getWorkerPrice(symbol: string): { price: number; latency_ms: number; connected: boolean } | null {
    const row = db.prepare('SELECT * FROM worker_prices WHERE symbol = ?').get(symbol) as {
        price: number;
        latency_ms: number;
        connected: number;
    } | undefined;

    if (!row) return null;
    return {
        price: row.price,
        latency_ms: row.latency_ms,
        connected: row.connected === 1,
    };
}

function getDevPriceOverride(symbol: string): number | null {
    const key = `dev_price_override_${symbol}`;
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return parseFloat(row.value);
    return null;
}

// ============================================
// Binance REST API (Signed)
// ============================================

interface BinanceBalance {
    asset: string;
    free: string;
    locked: string;
}

interface BinanceAccountResponse {
    balances: BinanceBalance[];
}

async function fetchBinanceAccount(
    apiKey: string,
    apiSecret: string,
    accountType: 'SPOT' | 'FUTURES'
): Promise<{ equity: number; balances: Record<string, { free: number; locked: number }> } | null> {
    const baseUrl = accountType === 'FUTURES'
        ? 'https://fapi.binance.com'
        : 'https://api.binance.com';

    const endpoint = accountType === 'FUTURES'
        ? '/fapi/v2/balance'
        : '/api/v3/account';

    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    try {
        const response = await fetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': apiKey }
        });

        if (response.status !== 200) {
            const errText = await response.text();
            console.error(`❌ Binance API error (${response.status}):`, errText.substring(0, 100));
            return null;
        }

        const data = await response.json();
        const balances: Record<string, { free: number; locked: number }> = {};
        let equity = 0;

        if (accountType === 'SPOT') {
            const account = data as BinanceAccountResponse;
            for (const bal of account.balances) {
                const free = parseFloat(bal.free);
                const locked = parseFloat(bal.locked);
                if (free > 0 || locked > 0) {
                    balances[bal.asset] = { free, locked };

                    // For USDT, add directly to equity
                    if (bal.asset === 'USDT') {
                        equity += free + locked;
                    } else {
                        // For other assets, convert to USDT using current price
                        const symbol = `${bal.asset}USDT`;
                        const priceData = prices.get(symbol);
                        if (priceData && priceData.price > 0) {
                            equity += (free + locked) * priceData.price;
                        }
                    }
                }
            }
        } else {
            // FUTURES response is different (array of balances)
            const futuresBalances = data as Array<{ asset: string; balance: string; availableBalance: string }>;
            for (const bal of futuresBalances) {
                const balance = parseFloat(bal.balance);
                const available = parseFloat(bal.availableBalance);
                if (balance > 0) {
                    balances[bal.asset] = { free: available, locked: balance - available };
                    if (bal.asset === 'USDT') {
                        equity += balance;
                    }
                }
            }
        }

        return { equity, balances };
    } catch (err) {
        console.error('❌ Binance fetch error:', (err as Error).message);
        return null;
    }
}

// ============================================
// Binance WebSocket (Combined Streams)
// ============================================

function buildStreamUrl(symbols: Set<string>): string {
    if (symbols.size === 0) return '';
    const streams = Array.from(symbols).map(s => `${s.toLowerCase()}@trade`).join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

function connectWebSocket(symbols: Set<string>): void {
    if (symbols.size === 0) {
        console.log('⚠️  No symbols to subscribe to');
        return;
    }

    const url = buildStreamUrl(symbols);
    console.log(`🔌 Connecting to Binance WS (${symbols.size} symbols): ${Array.from(symbols).slice(0, 5).join(', ')}${symbols.size > 5 ? '...' : ''}`);

    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('🟢 Binance WebSocket connected');
        for (const symbol of symbols) {
            const existing = prices.get(symbol);
            prices.set(symbol, { price: existing?.price || 0, latency: 0, connected: true });
            upsertWorkerPrice(symbol, existing?.price || 0, 0, true);
        }
        logEvent('WS_CONNECTED', { symbols: Array.from(symbols) });
    });

    ws.on('message', (data: WebSocket.RawData) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.stream && msg.data && msg.data.e === 'trade') {
                const symbol = msg.data.s.toUpperCase();
                const tradePrice = parseFloat(msg.data.p);
                const eventTime = msg.data.E;
                let latencyMs = Date.now() - eventTime;
                if (latencyMs < 0) latencyMs = 0;
                if (latencyMs > 1000) latencyMs = 999;

                const devPrice = getDevPriceOverride(symbol);
                const finalPrice = devPrice !== null ? devPrice : tradePrice;

                prices.set(symbol, { price: finalPrice, latency: latencyMs, connected: true });
                upsertWorkerPrice(symbol, finalPrice, latencyMs, true);
            }
        } catch (err) {
            console.error('Error parsing WS message:', err);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔴 Binance WebSocket closed: ${code} ${reason.toString()}`);
        for (const symbol of currentSymbols) {
            const existing = prices.get(symbol);
            prices.set(symbol, { price: existing?.price || 0, latency: 0, connected: false });
            upsertWorkerPrice(symbol, existing?.price || 0, 0, false);
        }
        logEvent('WS_DISCONNECTED', { code, reason: reason.toString() });

        console.log(`⏳ Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
        setTimeout(() => {
            const symbols = getRequiredSymbols();
            currentSymbols = symbols;
            connectWebSocket(symbols);
        }, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
        console.error('❌ Binance WebSocket error:', err.message);
    });
}

function checkSubscriptions(): void {
    const requiredSymbols = getRequiredSymbols();
    const currentArr = Array.from(currentSymbols).sort();
    const requiredArr = Array.from(requiredSymbols).sort();

    if (JSON.stringify(currentArr) !== JSON.stringify(requiredArr)) {
        console.log(`📊 Subscription change: [${currentArr.join(',')}] → [${requiredArr.join(',')}]`);
        if (ws) ws.close();
        currentSymbols = requiredSymbols;
        connectWebSocket(requiredSymbols);
    }
}

// ============================================
// Event Logger
// ============================================

function logEvent(type: string, payload: Record<string, unknown>, watchId?: number, userId?: string): void {
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(`
        INSERT INTO events (watch_id, user_id, type, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(watchId || null, userId || null, type, JSON.stringify(payload), ts);
}

// ============================================
// Account Sync Loop
// ============================================

async function syncUserAccounts(): Promise<void> {
    const users = getUsersWithSecrets();
    const now = Date.now();

    for (const user of users) {
        const lastSync = userLastSyncTime.get(user.id) || 0;

        if (now - lastSync < ACCOUNT_SYNC_INTERVAL_MS) {
            continue;  // Not time to sync yet
        }

        try {
            // Decrypt secrets
            const decrypted = decrypt(user.binance_api_key_enc, user.nonce);
            const { api_key, api_secret } = JSON.parse(decrypted);

            // Fetch account
            const result = await fetchBinanceAccount(api_key, api_secret, user.account_type || 'SPOT');

            if (result) {
                upsertPortfolioState(user.id, result.equity, JSON.stringify(result.balances));
                console.log(`✅ Account sync ok ${user.email} equity=$${result.equity.toFixed(2)}`);
            }

            userLastSyncTime.set(user.id, now);
        } catch (err) {
            console.error(`❌ Account sync failed ${user.email}:`, (err as Error).message);
        }

        // Stagger between users
        await new Promise(resolve => setTimeout(resolve, STAGGER_DELAY_MS));
    }
}

// ============================================
// Trailing Engine
// ============================================

interface WatchRow {
    id: number;
    user_id: string;
    symbol: string;
    mode: string;
    entry_price: number;
    current_price: number;
    amount_usdt: number;
    quantity: number;
    tp_mode: string;
    tp_percent: number;
    trailing_step_percent: number | null;
    trailing_high: number | null;
    status: string;
    unrealized_pnl: number;
}

function runTrailingEngine(): void {
    const now = Math.floor(Date.now() / 1000);
    const users = getUsersWithSecrets();

    for (const user of users) {
        const watches = db.prepare(`
            SELECT * FROM watches WHERE status = 'ACTIVE' AND user_id = ?
        `).all(user.id) as WatchRow[];

        for (const watch of watches) {
            const devPrice = getDevPriceOverride(watch.symbol);
            let priceData = prices.get(watch.symbol);

            if (!priceData) {
                const dbPrice = getWorkerPrice(watch.symbol);
                if (dbPrice) {
                    priceData = { price: dbPrice.price, latency: dbPrice.latency_ms, connected: dbPrice.connected };
                }
            }

            const price = devPrice !== null ? devPrice : (priceData?.price || 0);
            if (price === 0) continue;

            let peakPrice = watch.trailing_high || watch.entry_price;
            let currentTpPrice = peakPrice * (1 - watch.tp_percent);

            if (price > peakPrice) peakPrice = price;

            const candidateTp = peakPrice * (1 - watch.tp_percent);
            const stepPercent = watch.trailing_step_percent || 0.005;
            const stepThreshold = currentTpPrice * (1 + stepPercent);

            let tpMoved = false;
            const oldTp = currentTpPrice;

            if (candidateTp >= stepThreshold) {
                currentTpPrice = candidateTp;
                tpMoved = true;
            }

            const priceDiff = price - watch.entry_price;
            const unrealizedPnl = (priceDiff / watch.entry_price) * watch.amount_usdt;

            db.prepare(`
                UPDATE watches 
                SET current_price = ?, trailing_high = ?, unrealized_pnl = ?, updated_at = ?
                WHERE id = ?
            `).run(price, peakPrice, unrealizedPnl, now, watch.id);

            if (tpMoved) {
                logEvent('TP_MOVED', {
                    symbol: watch.symbol,
                    from: Math.round(oldTp * 100) / 100,
                    to: Math.round(currentTpPrice * 100) / 100,
                    peak_price: Math.round(peakPrice * 100) / 100,
                    price: Math.round(price * 100) / 100,
                }, watch.id, user.id);

                console.log(`📈 TP_MOVED [${watch.symbol}] watch=${watch.id}: ${oldTp.toFixed(2)} → ${currentTpPrice.toFixed(2)}`);

                const lastNotify = lastTpNotifyTime.get(watch.id) || 0;
                if (now - lastNotify > 30) {
                    sendNotification('TP_MOVED', {
                        symbol: watch.symbol,
                        new_tp: Math.round(currentTpPrice * 100) / 100,
                        step: watch.trailing_step_percent,
                        trigger: 'TRAILING'
                    });
                    lastTpNotifyTime.set(watch.id, now);
                }
            }

            // TP hit check (PAPER mode - no real order)
            if (price <= currentTpPrice && watch.mode === 'PAPER') {
                console.log(`🎯 TP HIT [${watch.symbol}] watch=${watch.id}: price=${price.toFixed(2)} <= tp=${currentTpPrice.toFixed(2)}`);
                executePaperSell(watch, price, currentTpPrice, now, user.id);
            }
        }
    }

    // Update worker_status for backward compat
    const users0 = getUsersWithSecrets();
    if (users0.length > 0) {
        const settings = getUserSettings(users0[0].id);
        const activeSymbol = settings.active_symbol;
        const activePrice = prices.get(activeSymbol);
        if (activePrice) {
            db.prepare(`
                UPDATE worker_status 
                SET connected = ?, latency_ms = ?, symbol = ?, price = ?, updated_at = ?
                WHERE id = 1
            `).run(activePrice.connected ? 1 : 0, activePrice.latency, activeSymbol, activePrice.price, now);
        }
    }
}

function executePaperSell(watch: WatchRow, sellPrice: number, tpPrice: number, now: number, userId: string): void {
    const priceDiff = sellPrice - watch.entry_price;
    const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
    const sellAmount = watch.amount_usdt + pnl;

    db.prepare(`
        UPDATE watches 
        SET status = 'SOLD', sell_price = ?, realized_pnl = ?, sold_at = ?, updated_at = ?, unrealized_pnl = 0
        WHERE id = ?
    `).run(sellPrice, pnl, now, now, watch.id);

    db.prepare(`
        INSERT INTO trades (watch_id, user_id, symbol, side, price, quantity, amount_usdt, pnl, mode, created_at)
        VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?)
    `).run(watch.id, userId, watch.symbol, sellPrice, watch.quantity, sellAmount, pnl, watch.mode, now);

    logEvent('SELL_TRIGGERED', {
        symbol: watch.symbol,
        sell_price: Math.round(sellPrice * 100) / 100,
        entry_price: watch.entry_price,
        pnl: Math.round(pnl * 100) / 100,
        trigger: 'TP_HIT',
        tp_price: Math.round(tpPrice * 100) / 100,
    }, watch.id, userId);

    sendNotification('SELL_TRIGGERED', {
        symbol: watch.symbol,
        price: Math.round(sellPrice * 100) / 100,
        pnl_usdt: Math.round(pnl * 100) / 100,
        trigger: 'TP_HIT'
    });

    console.log(`💰 PAPER SELL [${watch.symbol}] watch=${watch.id}: pnl=${pnl.toFixed(2)} USDT`);
}

// ============================================
// Main
// ============================================

console.log('🟢 Worker starting...');

const users = getUsersWithSecrets();
console.log(`👥 Users with Binance keys: ${users.length}`);

if (users.length === 0) {
    console.log('⏸️  No users with Binance keys - waiting for registrations...');
}

// Initial subscription
currentSymbols = getRequiredSymbols();
console.log(`📊 Initial symbols: ${Array.from(currentSymbols).join(', ') || '(none)'}`);
connectWebSocket(currentSymbols);

// Start trailing engine
const engineInterval = setInterval(runTrailingEngine, ENGINE_INTERVAL_MS);

// Check for subscription changes periodically
setInterval(checkSubscriptions, SUBSCRIPTION_CHECK_INTERVAL_MS);

// Account sync loop
setInterval(syncUserAccounts, 2000);  // Check every 2s, actual sync is rate-limited per user

// Log status periodically
let lastLogTime = 0;
setInterval(() => {
    const now = Date.now();
    if (now - lastLogTime >= 10000) {
        const users = getUsersWithSecrets();
        const totalActive = (db.prepare("SELECT COUNT(*) as c FROM watches WHERE status = 'ACTIVE'").get() as { c: number }).c;
        const symbolList = Array.from(currentSymbols).slice(0, 3).map(s => {
            const p = prices.get(s);
            return `${s}:$${(p?.price || 0).toFixed(0)}`;
        }).join(' | ');
        console.log(`🔄 Users: ${users.length} | Symbols: ${currentSymbols.size} | Active watches: ${totalActive} | ${symbolList}`);
        lastLogTime = now;
    }
}, 1000);

// Shutdown
function shutdown(): void {
    console.log('');
    console.log('🔴 Worker shutting down...');
    clearInterval(engineInterval);
    if (ws) ws.close();
    for (const symbol of currentSymbols) {
        upsertWorkerPrice(symbol, prices.get(symbol)?.price || 0, 0, false);
    }
    console.log('✅ Worker stopped');
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
