// FAZ 8: Telegram Notification Module
import { getMeta } from '../db/index.js';
import { logAudit } from '../utils/audit.js';

let lastSentTime = 0;
const MIN_INTERVAL_MS = 1000; // 1 message per second rate limit

// Queue to handle rate limiting
let queue: Array<() => Promise<void>> = [];
let processing = false;

async function processQueue() {
    if (processing || queue.length === 0) return;
    processing = true;

    while (queue.length > 0) {
        const now = Date.now();
        const timeSinceLast = now - lastSentTime;

        if (timeSinceLast < MIN_INTERVAL_MS) {
            await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - timeSinceLast));
        }

        const task = queue.shift();
        if (task) {
            try {
                await task();
            } catch (err) {
                console.error('Error processing telegram task:', err);
            }
            lastSentTime = Date.now();
        }
    }

    processing = false;
}

export async function sendTelegramMessage(text: string): Promise<boolean> {
    const enabled = getMeta('telegram_enabled') === 'true';
    const token = getMeta('telegram_bot_token');
    const chatId = getMeta('telegram_chat_id');

    if (!enabled || !token || !chatId) {
        return false;
    }

    return new Promise((resolve) => {
        const task = async () => {
            try {
                const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        text: text,
                        parse_mode: 'HTML',
                    }),
                });

                if (!response.ok) {
                    const errorBody = await response.text();
                    console.warn(`Telegram API error: ${response.status} ${errorBody}`);
                    logAudit('SYSTEM', 'TELEGRAM_SEND_FAILED', { error: errorBody, status: response.status });
                    resolve(false);
                } else {
                    resolve(true);
                }
            } catch (error) {
                console.warn('Telegram network error:', error);
                logAudit('SYSTEM', 'TELEGRAM_SEND_FAILED', { error: (error as Error).message });
                resolve(false);
            }
        };

        queue.push(task);
        processQueue();
    });
}

// Helper to format notification based on type
export async function sendNotification(type: string, payload: any) {
    const notifyOnStr = getMeta('telegram_notify_on');
    const notifyOn: string[] = notifyOnStr
        ? JSON.parse(notifyOnStr)
        : ['SELL_TRIGGERED', 'WATCH_CREATED', 'TP_MOVED'];

    if (!notifyOn.includes(type)) {
        return;
    }

    let message = '';
    const emoji = getEmojiForType(type);

    switch (type) {
        case 'SELL_TRIGGERED':
            const pnl = payload.pnl_usdt !== undefined ? payload.pnl_usdt.toFixed(2) : '?';
            const percent = payload.pnl_percent !== undefined ? (payload.pnl_percent * 100).toFixed(2) : '?';
            message = `${emoji} <b>SELL TRIGGERED</b>\n\n` +
                `Symbol: <b>${payload.symbol}</b>\n` +
                `Price: ${payload.price}\n` +
                `PnL: $${pnl} (${percent}%)\n` +
                `Reason: ${payload.trigger}`;
            break;

        case 'WATCH_CREATED':
            message = `${emoji} <b>NEW WATCH</b>\n\n` +
                `Symbol: <b>${payload.symbol}</b>\n` +
                `Entry: ${payload.entry_price}`;
            break;

        case 'TP_MOVED':
            message = `${emoji} <b>TP MOVED</b>\n\n` +
                `Symbol: <b>${payload.symbol}</b>\n` +
                `New TP: ${payload.new_tp}\n` +
                `Step: ${payload.step || 'Dynamic'}`;
            break;

        default:
            message = `${emoji} <b>${type}</b>\n\n` + JSON.stringify(payload);
    }

    if (message) {
        const sent = await sendTelegramMessage(message);
        if (sent) {
            // Optional: Log success or just rely on lack of failure
            // logAudit('SYSTEM', 'TELEGRAM_SENT', { type }); 
        }
    }
}

function getEmojiForType(type: string): string {
    switch (type) {
        case 'SELL_TRIGGERED': return '💰';
        case 'WATCH_CREATED': return '👀';
        case 'TP_MOVED': return '📈';
        default: return '📢';
    }
}
