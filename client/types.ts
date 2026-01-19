// FAZ 7: Typed Client Types (Copy-pasteable to UI repo)

export type TradingMode = 'PAPER' | 'LIVE';
export type WatchStatus = 'WATCHING' | 'PAUSED' | 'SOLD' | 'STOPPED';

export interface StateResponse {
    symbol: string;
    timeframe: string;
    price: number;
    latency_ms: number;
    connected: boolean;
    mode: TradingMode;
    equity_usdt: number;
    pnl_total_usdt: number;
    pnl_realized_usdt: number;
    pnl_unrealized_usdt: number;
    today_pnl_usdt: number;
}

export interface WatchResponse {
    id: string;
    symbol: string;
    mode: TradingMode;
    status: WatchStatus;
    entry_price: number;
    amount_usdt: number;
    qty: number;
    tp_mode: 'FIXED' | 'TRAIL';
    tp_percent: number;
    trailing_step_percent: number | null;
    peak_price: number | null;
    current_tp_price: number | null;
    current_price: number;
    unrealized_pnl_usdt: number;
    created_at: number;
    updated_at: number;
}

export interface TradeResponse {
    id: string;
    watch_id: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    fee_usdt: number;
    pnl_usdt: number;
    ts: number;
}

export interface PortfolioResponse {
    equity_usdt: number;
    pnl_total_usdt: number;
    pnl_realized_usdt: number;
    pnl_unrealized_usdt: number;
    win_rate: number;
    max_drawdown: number;
    profit_factor: number;
    equity_curve: { ts: number; equity: number }[];
}

export interface EventResponse {
    id: string;
    watch_id: string | null;
    type: string;
    payload: Record<string, any>;
    ts: number;
}

export interface SettingsResponse {
    mode: TradingMode;
    active_symbol: string;
    timeframe: string;
    paper_equity_usdt: number;
    paper_fee_bps: number;
    binance_api_key: string;
    binance_testnet: boolean;
    live_enabled: boolean;
    live_max_order_usdt: number;
    live_allow_symbols: string[];
}

export interface ErrorResponse {
    error: string;
    message: string;
    details?: any;
}
