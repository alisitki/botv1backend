import dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import db, { getMeta, setMeta } from './db/index.js';
import { sendNotification } from './notify/telegram.js';

// Configuration
const ENGINE_INTERVAL_MS = 500;  // Trailing engine tick
const RECONNECT_DELAY_MS = 5000;
const SUBSCRIPTION_CHECK_INTERVAL_MS = 5000;  // Check for new symbols

// State
let ws: WebSocket | null = null;
let currentSymbols: Set<string> = new Set();
let prices: Map<string, { price: number; latency: number; connected: boolean }> = new Map();
let lastTpNotifyTime: Map<number, number> = new Map(); // Debounce for TP notifications

console.log('');
console.log('🔄 Trading Bot Worker (FAZ 3 - Multi-Symbol)');
console.log(`⏱️  Engine interval: ${ENGINE_INTERVAL_MS}ms`);
console.log('');

// ============================================
// Database Helpers
// ============================================

function getActiveSymbol(): string {
    return getMeta('active_symbol') || getMeta('symbol') || 'BTCUSDT';
}

function getRequiredSymbols(): Set<string> {
    // Active symbol from settings
    const activeSymbol = getActiveSymbol();

    // Symbols from WATCHING watches
    const watchSymbols = db.prepare(`
        SELECT DISTINCT symbol FROM watches WHERE status = 'ACTIVE'
    `).all() as { symbol: string }[];

    const symbols = new Set<string>();
    symbols.add(activeSymbol.toUpperCase());

    for (const row of watchSymbols) {
        symbols.add(row.symbol.toUpperCase());
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

    // Fallback to old single dev_price_override
    const fallback = db.prepare('SELECT value FROM meta WHERE key = ?').get('dev_price_override') as { value: string } | undefined;
    return fallback ? parseFloat(fallback.value) : null;
}

// ============================================
// Binance WebSocket (Combined Streams)
// ============================================

function buildStreamUrl(symbols: Set<string>): string {
    if (symbols.size === 0) {
        return '';
    }

    const streams = Array.from(symbols).map(s => `${s.toLowerCase()}@trade`).join('/');
    return `wss://stream.binance.com:9443/stream?streams=${streams}`;
}

function connectWebSocket(symbols: Set<string>): void {
    if (symbols.size === 0) {
        console.log('⚠️  No symbols to subscribe to');
        return;
    }

    const url = buildStreamUrl(symbols);
    console.log(`🔌 Connecting to Binance (${symbols.size} symbols): ${Array.from(symbols).join(', ')}`);

    ws = new WebSocket(url);

    ws.on('open', () => {
        console.log('🟢 Binance WebSocket connected');

        // Mark all symbols as connected
        for (const symbol of symbols) {
            const existing = prices.get(symbol);
            prices.set(symbol, {
                price: existing?.price || 0,
                latency: 0,
                connected: true,
            });
            upsertWorkerPrice(symbol, existing?.price || 0, 0, true);
        }

        logEvent('WS_CONNECTED', { symbols: Array.from(symbols) });
    });

    ws.on('message', (data: WebSocket.RawData) => {
        try {
            const msg = JSON.parse(data.toString());

            // Combined stream format: { stream: "btcusdt@trade", data: { e: "trade", ... } }
            if (msg.stream && msg.data && msg.data.e === 'trade') {
                const symbol = msg.data.s.toUpperCase();  // e.g., "BTCUSDT"
                const tradePrice = parseFloat(msg.data.p);
                const eventTime = msg.data.E;  // Binance timestamp in ms

                // Calculate latency
                let latencyMs = Date.now() - eventTime;
                if (latencyMs < 0) latencyMs = 0;
                if (latencyMs > 1000) latencyMs = 999;

                // Check for dev override
                const devPrice = getDevPriceOverride(symbol);
                const finalPrice = devPrice !== null ? devPrice : tradePrice;

                // Update in-memory state
                prices.set(symbol, {
                    price: finalPrice,
                    latency: latencyMs,
                    connected: true,
                });

                // Update DB
                upsertWorkerPrice(symbol, finalPrice, latencyMs, true);
            }
        } catch (err) {
            console.error('Error parsing WS message:', err);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔴 Binance WebSocket closed: ${code} ${reason.toString()}`);

        // Mark all as disconnected
        for (const symbol of currentSymbols) {
            const existing = prices.get(symbol);
            prices.set(symbol, {
                price: existing?.price || 0,
                latency: 0,
                connected: false,
            });
            upsertWorkerPrice(symbol, existing?.price || 0, 0, false);
        }

        logEvent('WS_DISCONNECTED', { code, reason: reason.toString() });

        // Reconnect with current symbols
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

// ============================================
// Subscription Manager
// ============================================

function checkSubscriptions(): void {
    const requiredSymbols = getRequiredSymbols();

    // Check if symbols changed
    const currentArr = Array.from(currentSymbols).sort();
    const requiredArr = Array.from(requiredSymbols).sort();

    if (JSON.stringify(currentArr) !== JSON.stringify(requiredArr)) {
        console.log(`📊 Subscription change: [${currentArr.join(',')}] → [${requiredArr.join(',')}]`);

        // Close existing connection and reconnect
        if (ws) {
            ws.close();
        }

        currentSymbols = requiredSymbols;
        connectWebSocket(requiredSymbols);
    }
}

// ============================================
// Event Logger
// ============================================

function logEvent(type: string, payload: Record<string, unknown>, watchId?: number): void {
    const ts = Math.floor(Date.now() / 1000);
    db.prepare(`
        INSERT INTO events (watch_id, type, payload, created_at)
        VALUES (?, ?, ?, ?)
    `).run(watchId || null, type, JSON.stringify(payload), ts);
}

// ============================================
// Trailing Engine
// ============================================

interface WatchRow {
    id: number;
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

    // Get all WATCHING watches
    const watches = db.prepare(`
        SELECT * FROM watches WHERE status = 'ACTIVE'
    `).all() as WatchRow[];

    for (const watch of watches) {
        // Get price for this symbol
        const devPrice = getDevPriceOverride(watch.symbol);
        let priceData = prices.get(watch.symbol);

        // Also check DB if not in memory
        if (!priceData) {
            const dbPrice = getWorkerPrice(watch.symbol);
            if (dbPrice) {
                priceData = {
                    price: dbPrice.price,
                    latency: dbPrice.latency_ms,
                    connected: dbPrice.connected,
                };
            }
        }

        // Skip if no price available
        const price = devPrice !== null ? devPrice : (priceData?.price || 0);
        if (price === 0) continue;

        let peakPrice = watch.trailing_high || watch.entry_price;
        let currentTpPrice = peakPrice * (1 - watch.tp_percent);

        // 1. Update peak if price > peak
        if (price > peakPrice) {
            peakPrice = price;
        }

        // 2. Calculate candidate TP
        const candidateTp = peakPrice * (1 - watch.tp_percent);

        // 3. Check step-up condition
        const stepPercent = watch.trailing_step_percent || 0.005;
        const stepThreshold = currentTpPrice * (1 + stepPercent);

        let tpMoved = false;
        const oldTp = currentTpPrice;

        if (candidateTp >= stepThreshold) {
            currentTpPrice = candidateTp;
            tpMoved = true;
        }

        // 4. Calculate unrealized PnL
        const priceDiff = price - watch.entry_price;
        const unrealizedPnl = (priceDiff / watch.entry_price) * watch.amount_usdt;

        // 5. Update watch in DB
        db.prepare(`
            UPDATE watches 
            SET current_price = ?, trailing_high = ?, unrealized_pnl = ?, updated_at = ?
            WHERE id = ?
        `).run(price, peakPrice, unrealizedPnl, now, watch.id);

        // 6. Log TP_MOVED event
        if (tpMoved) {
            logEvent('TP_MOVED', {
                symbol: watch.symbol,
                from: Math.round(oldTp * 100) / 100,
                to: Math.round(currentTpPrice * 100) / 100,
                peak_price: Math.round(peakPrice * 100) / 100,
                price: Math.round(price * 100) / 100,
            }, watch.id);

            console.log(`📈 TP_MOVED [${watch.symbol}] watch=${watch.id}: ${oldTp.toFixed(2)} → ${currentTpPrice.toFixed(2)}`);

            // FAZ 8: Notify (Debounce 30s)
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

        // 7. Check TP hit
        if (price <= currentTpPrice) {
            console.log(`🎯 TP HIT [${watch.symbol}] watch=${watch.id}: price=${price.toFixed(2)} <= tp=${currentTpPrice.toFixed(2)}`);
            executeAutoSell(watch, price, currentTpPrice, now);
        }
    }

    // Update worker_status for backward compat (active symbol)
    const activeSymbol = getActiveSymbol();
    const activePrice = prices.get(activeSymbol);
    if (activePrice) {
        db.prepare(`
            UPDATE worker_status 
            SET connected = ?, latency_ms = ?, symbol = ?, price = ?, updated_at = ?
            WHERE id = 1
        `).run(activePrice.connected ? 1 : 0, activePrice.latency, activeSymbol, activePrice.price, now);
    }
}

// ============================================
// Auto Sell
// ============================================

function executeAutoSell(watch: WatchRow, sellPrice: number, tpPrice: number, now: number): void {
    const priceDiff = sellPrice - watch.entry_price;
    const pnl = (priceDiff / watch.entry_price) * watch.amount_usdt;
    const sellAmount = watch.amount_usdt + pnl;

    // Update watch
    db.prepare(`
        UPDATE watches 
        SET status = 'SOLD', sell_price = ?, realized_pnl = ?, sold_at = ?, updated_at = ?, unrealized_pnl = 0
        WHERE id = ?
    `).run(sellPrice, pnl, now, now, watch.id);

    // Create SELL trade
    db.prepare(`
        INSERT INTO trades (watch_id, symbol, side, price, quantity, amount_usdt, pnl, mode, created_at)
        VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?, ?)
    `).run(watch.id, watch.symbol, sellPrice, watch.quantity, sellAmount, pnl, watch.mode, now);

    // Create event
    logEvent('SELL_TRIGGERED', {
        symbol: watch.symbol,
        sell_price: Math.round(sellPrice * 100) / 100,
        entry_price: watch.entry_price,
        pnl: Math.round(pnl * 100) / 100,
        trigger: 'TP_HIT',
        tp_price: Math.round(tpPrice * 100) / 100,
    }, watch.id);

    // Update realized PnL
    const currentRealized = parseFloat(getMeta('pnl_realized') || '0');
    setMeta('pnl_realized', (currentRealized + pnl).toString());

    // Add equity curve point
    const equity = parseFloat(getMeta('paper_equity_usdt') || getMeta('equity') || '17000');
    db.prepare('INSERT INTO equity_curve (ts, equity) VALUES (?, ?)').run(now, equity + currentRealized + pnl);

    // FAZ 8: Notify
    sendNotification('SELL_TRIGGERED', {
        symbol: watch.symbol,
        price: Math.round(sellPrice * 100) / 100,
        pnl_usdt: Math.round(pnl * 100) / 100,
        trigger: 'TP_HIT'
    });

    console.log(`💰 AUTO SELL [${watch.symbol}] watch=${watch.id}: pnl=${pnl.toFixed(2)} USDT`);
}

// ============================================
// Main
// ============================================

console.log('🟢 Worker starting...');

// Initial subscription
currentSymbols = getRequiredSymbols();
console.log(`📊 Initial symbols: ${Array.from(currentSymbols).join(', ')}`);
connectWebSocket(currentSymbols);

// Start trailing engine
const engineInterval = setInterval(runTrailingEngine, ENGINE_INTERVAL_MS);

// Check for subscription changes periodically
setInterval(checkSubscriptions, SUBSCRIPTION_CHECK_INTERVAL_MS);

// Log status periodically
let lastLogTime = 0;
setInterval(() => {
    const now = Date.now();
    if (now - lastLogTime >= 10000) {
        const activeCount = (db.prepare("SELECT COUNT(*) as c FROM watches WHERE status = 'ACTIVE'").get() as { c: number }).c;
        const symbolList = Array.from(currentSymbols).map(s => {
            const p = prices.get(s);
            return `${s}:$${(p?.price || 0).toFixed(2)}`;
        }).join(' | ');
        console.log(`💰 ${symbolList} | Active: ${activeCount}`);
        lastLogTime = now;
    }
}, 1000);

// Shutdown
function shutdown(): void {
    console.log('');
    console.log('🔴 Worker shutting down...');

    clearInterval(engineInterval);

    if (ws) {
        ws.close();
    }

    // Mark all as disconnected
    for (const symbol of currentSymbols) {
        upsertWorkerPrice(symbol, prices.get(symbol)?.price || 0, 0, false);
    }

    console.log('✅ Worker stopped');
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
