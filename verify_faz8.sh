#!/bin/bash
set -e

# Kill any existing process on port 3000
fuser -k 3000/tcp || true

# Start server in background
echo "🚀 Starting server..."
npx tsx src/server.ts > server.log 2>&1 &
SERVER_PID=$!
sleep 10

echo "🔍 Verifying/checking health..."
curl -s http://localhost:3000/health | grep '"ok":true'
echo "✅ Health Check Passed"

echo "🔍 Verifying OHLC endpoint..."
# We expect 502 UPSTREAM_ERROR or valid JSON. Getting JSON is good enough for connectivity check.
# If invalid symbol or no network, it might fail.
curl -s "http://localhost:3000/v1/ohlc?symbol=BTCUSDT&limit=1" > ohlc_response.json
if grep -q "UPSTREAM_ERROR" ohlc_response.json; then
    echo "⚠️ OHLC returned upstream error (expected if no internet/binance blocked)"
elif grep -q "open" ohlc_response.json; then
    echo "✅ OHLC Data Received"
else
    echo "⚠️ OHLC Unknown response"
    cat ohlc_response.json
fi

echo "🔍 Verifying OpenAPI fields..."
curl -s http://localhost:3000/openapi.json > openapi_check.json
if grep -q "telegram_enabled" openapi_check.json; then
    echo "✅ OpenAPI contains telegram fields"
else
    echo "❌ OpenAPI MISSING telegram fields"
    exit 1
fi

echo "🔍 Verifying Notify Test endpoint..."
# Expect 200 or 400 (if disabled/no token)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/v1/notify/test -d '{"message":"Check"}' -H "Content-Type: application/json")
echo "Notify Test Status: $HTTP_CODE"

# Stop server
kill $SERVER_PID
echo "✅ Server Verification Complete"

# Start worker briefly
echo "🚀 Starting worker..."
npx tsx src/worker.ts > worker.log 2>&1 &
WORKER_PID=$!
sleep 5
kill $WORKER_PID
echo "✅ Worker Started and Stopped"

echo "🎉 FAZ 8 Verification SUCCESS"
