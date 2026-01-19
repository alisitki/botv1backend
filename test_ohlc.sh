fuser -k 3000/tcp || true
npx tsx src/server.ts > server_tmp.log 2>&1 &
PID=$!
sleep 15
curl -s "http://localhost:3000/v1/ohlc?symbol=BTCUSDT&timeframe=1m&limit=2"
kill $PID
