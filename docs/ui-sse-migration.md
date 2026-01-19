# UI SSE Migration Plan

Bu doküman, frontend (UI) uygulamasının polling (periyodik istek) yerine `/v1/stream` (SSE) endpoint'ine geçiş planını açıklar.

## 1. Planlanan Geçiş Sırası

1.  **Polling'i Devre Dışı Bırakma**:
    - `fetchState` polling (~1s) durdurulur.
    - `fetchWatches` polling (~2s) durdurulur.
2.  **SSE Bağlantısı Kurma**:
    - Uygulama yüklendiğinde `/v1/stream` bağlantısı açılır.
3.  **Local State Güncelleme**:
    - Gelen `state` ve `watches` event'leri ile uygulamanın global store'u (React context, Redux vb.) güncellenir.
4.  **Incremental Refresh (Events)**:
    - Yeni bir trade veya watch değişikliği olduğunda gelen `events` push'u üzerine `trades` ve `portfolio` verileri için bir kez manuel `fetch` tetiklenir (veya stream'deki veriye göre incremental update yapılır).

## 2. Örnek Event Parsing (JavaScript)

```javascript
const eventSource = new EventSource('http://localhost:3000/v1/stream');

// Reconnect stratejisi (Browser otomatik yapar ama izlemek iyidir)
eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    // 2s sonra browser otomatik dener (retry header sayesinde)
};

// 1. State Güncelleme (Her 1s)
eventSource.addEventListener('state', (e) => {
    const state = JSON.parse(e.data);
    updateStore({ currentPrice: state.price, equity: state.equity_usdt });
});

// 2. Watches Güncelleme (Her 2s)
eventSource.addEventListener('watches', (e) => {
    const list = JSON.parse(e.data);
    updateStore({ watches: list });
});

// 3. Events Push (Yeni event oluşunca)
eventSource.addEventListener('events', (e) => {
    const newEvents = JSON.parse(e.data);
    console.log('New events received:', newEvents);
    
    // Önemli: Yeni bir SELL veya BUY event'i varsa diğer dataları tazele
    const hasCriticalEvent = newEvents.some(ev => 
        ev.type === 'SELL_TRIGGERED' || ev.type === 'WATCH_CREATED'
    );
    
    if (hasCriticalEvent) {
        // Portfolio ve Trades polling yapılmadığı için manuel yenile
        refreshPortfolio();
        refreshTrades();
    }
});
```

## 3. İlk Yükleme (Snapshot)

SSE bağlantısı kurulduğunda `/v1/stream` endpoint'i **ilk mesaj olarak** mevcut `state` ve `watches` verisini gönderir. Bu sayede UI açılır açılmaz boş kalmaz.

## 4. Reconnect & Resilience

- SSE, HTTP 200 dönerse ve bağlantı koparsa browser otomatik olarak tekrar bağlanmaya çalışır (`retry: 2000` header'ı ile 2 saniye bekler).
- Load balancer (Nginx vb.) arkasındaysanız `proxy_set_header Connection "";` ve `proxy_buffering off;` ayarları kritiktir.
