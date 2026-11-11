// Google Chat notifications to the accounting space (incoming webhook).
// Off until GCHAT_WEBHOOK_URL is set in Vercel; failures never break a request.
// configured() → 'missing' | 'invalid' | 'ok'
function configured() {
  const url = String(process.env.GCHAT_WEBHOOK_URL || '').trim();
  if (!url) return 'missing';
  return /^https:\/\/chat\.googleapis\.com\/v1\/spaces\/[^/]+\/messages\?/.test(url) ? 'ok' : 'invalid';
}
async function send(text) {
  const state = configured();
  if (state !== 'ok') return { ok: false, state };
  try {
    const res = await fetch(String(process.env.GCHAT_WEBHOOK_URL).trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: String(text).slice(0, 3500) }),
    });
    if (!res.ok) console.error('Google Chat notify failed', res.status, (await res.text()).slice(0, 300));
    return { ok: res.ok, state, status: res.status };
  } catch (e) {
    console.error('Google Chat notify failed', e);
    return { ok: false, state, error: e.message };
  }
}
async function chat(text) { return (await send(text)).ok; }

module.exports = { chat, send, configured };
