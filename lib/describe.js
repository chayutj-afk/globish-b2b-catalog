// Writes a QT line description from the package text + the sales note / freebie, through the Claude API,
// the moment accounting approves (same rules the scheduled sync uses, so both give the same result).
//
// Needs ANTHROPIC_API_KEY on the server. Without it (or if the API is down) the caller leaves the
// request for the scheduled sync, as before.

const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You write one line description for a sales quotation (QT) of Globish, an English-learning company in Thailand.
Input: the package description (BASE), an optional note from the salesperson (NOTE) and optional freebies (FREEBIE), plus the document language.
Rules:
- Keep BASE's structure and every fact in it. Work NOTE in where it fits naturally. Add no fact, number, name or promise that is not in the input.
- If FREEBIE is given, end with one line "ของแถม: …" (English documents: "Complimentary: …") with every count and name exactly as given.
- Write in the document language, plain and natural, the way a careful person writes a business document. No marketing words, no emoji, no markdown, no em dashes.
- If NOTE contradicts BASE (different hours, price, duration, product), or reads like an internal remark that must not be shown to the customer (commission, internal names, "อย่าบอกลูกค้า", approvals, cost), do not write a description.
Reply with JSON only, one of:
{"ok":true,"description":"..."}
{"ok":false,"reason":"<short reason in Thai for the salesperson>"}`;

async function describeLine({ base, note, freebie, lang }) {
  const user = [`DOCUMENT LANGUAGE: ${/en/i.test(lang || '') ? 'English' : 'Thai'}`, `BASE:\n${base || ''}`, note ? `NOTE:\n${note}` : '', freebie ? `FREEBIE:\n${freebie}` : ''].filter(Boolean).join('\n\n');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 1500, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude API: ตอบกลับไม่ใช่ JSON');
  const out = JSON.parse(m[0]);
  if (out.ok && String(out.description || '').trim()) return { ok: true, description: String(out.description).trim() };
  return { ok: false, reason: String(out.reason || 'คำอธิบายเพิ่มเติมขัดกับแพ็กเกจ').slice(0, 300) };
}

module.exports = { enabled, describeLine, SYSTEM };
