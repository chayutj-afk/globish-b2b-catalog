#!/bin/bash
# Local stand-in for production: mock Revenue Hub (JSON file) + fake PEAK (fakepeak.cjs), PEAK_MODE=prod.
#   test/e2e/start.sh && node test/e2e/api.cjs && node test/e2e/ui.cjs && node test/e2e/crawl.cjs && node test/e2e/fuzz.cjs
R="$(cd "$(dirname "$0")" && pwd)"; D=/tmp/sales-desk-e2e; mkdir -p $D /tmp/sales-desk-e2e-shots
pkill -f "dev-server.mjs 3950" 2>/dev/null
node "$R/seed.cjs" $D/db.json && cp "$R/peak-seed.json" $D/peak.json
cd "$R/../.."
AUTH_SECRET=qa-secret-qa-secret-qa-secret-qa-secret-1234 HUB_MODE=mock HUB_MOCK_FILE=$D/db.json FAKE_PEAK_FILE=$D/peak.json \
PEAK_MODE=prod PEAK_CONNECT_ID=cid PEAK_PASSWORD=pw PEAK_USER_TOKEN=ut PEAK_WEBHOOK_KEY=hookkey123 OWNER_EMAILS=admin@globish.co.th CRON_SECRET=cron123 \
nohup node --require "$R/fakepeak.cjs" test/dev-server.mjs 3950 > $D/server.log 2>&1 &
for i in $(seq 1 20); do curl -s -o /dev/null localhost:3950/signin.html && break; node -e "setTimeout(()=>{},300)"; done
echo "started on :3950"
