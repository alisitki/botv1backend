fuser -k 3000/tcp || true
npx tsx src/server.ts > report_server.log 2>&1 &
SERVER_PID=$!
sleep 15
curl -s "http://localhost:3000/v1/ohlc?symbol=BTCUSDT&timeframe=1m&limit=2" > /root/.gemini/antigravity/scratch/trading-bot/ohlc_sample.json
kill $SERVER_PID
