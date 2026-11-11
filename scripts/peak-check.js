#!/usr/bin/env node
// Read-only check of PEAK credentials. Creates nothing in PEAK.
//
//   PEAK_MODE=uat PEAK_CONNECT_ID=… PEAK_PASSWORD=… PEAK_USER_TOKEN=… node scripts/peak-check.js [taxId] [branch]
//   (or: vercel env pull .env.local && set -a && . ./.env.local && set +a && npm run peak-check -- 0105557083391)
//
// 1. Client token with the current signature encoding. If PEAK answers "Invalid TimeSignature",
//    tries the other encoding and says which one to set as PEAK_SIG_ENCODING.
// 2. With a tax ID: one GET /Contacts?taxId=&branchCode= to prove the User Token works
//    (1 call from the monthly API Own-Use quota).

const peak = require('../lib/peak');

const mask = (s) => (s ? String(s).slice(0, 4) + '…' + String(s).slice(-4) : '(not set)');

async function tokenWith(enc) {
  process.env.PEAK_SIG_ENCODING = enc;
  peak._test.reset();
  return peak.getClientToken();
}

(async () => {
  console.log(`PEAK_MODE=${peak.mode()}  connectId=${mask(process.env.PEAK_CONNECT_ID)}  userToken=${mask(process.env.PEAK_USER_TOKEN)}`);
  if (peak.mode() === 'off') { console.log('Set PEAK_MODE=uat (or prod) to run the check.'); process.exit(1); }

  const first = (process.env.PEAK_SIG_ENCODING || 'hex').toLowerCase() === 'base64' ? 'base64' : 'hex';
  const other = first === 'hex' ? 'base64' : 'hex';
  let used;
  try {
    await tokenWith(first); used = first;
  } catch (e) {
    if (!/TimeSignature/i.test(e.message)) throw e;
    console.log(`Client token with ${first}: ${e.message} → trying ${other}`);
    await tokenWith(other); used = other;
  }
  console.log(`✓ Client token OK (signature ${used}).${used !== 'hex' ? ' Set PEAK_SIG_ENCODING=base64 in Vercel.' : ''}`);

  const [taxId, branch] = process.argv.slice(2);
  if (!taxId) { console.log('No tax ID given; skipped the User Token check.'); return; }
  const found = await peak.findContacts(taxId, branch || '00000');
  console.log(`✓ User Token OK. Contacts for ${taxId}/${branch || '00000'}: ${found.length}`);
  found.forEach((c) => console.log(`  ${c.code}  ${c.name}`));
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
