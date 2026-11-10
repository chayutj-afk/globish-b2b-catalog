// Google Chat notifications to the accounting space (incoming webhook).
// Off until GCHAT_WEBHOOK_URL is set in Vercel; failures never break a request.
async function chat(text) {
  const url = process.env.GCHAT_WEBHOOK_URL;
  if (!url || !/^https:\/\/chat\.googleapis\.com\//.test(url)) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: String(text).slice(0, 3500) }),
    });
    return res.ok;
  } catch (e) {
    console.error('Google Chat notify failed', e);
    return false;
  }
}

module.exports = { chat };
