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
- Layout, so the document is easy to read (plain text, real line breaks, never one long paragraph):
  line 1: one opening sentence naming the course, its duration and "ต่อผู้เรียน 1 ท่าน ประกอบด้วย" (or the wording BASE uses) — no list marker.
  then one line per component of the package, each starting with "- " (hyphen, space): what it is, minutes per session, number of sessions. One component per line; do not join components with commas or "และ".
  If FREEBIE is given: one empty line, then a line "ของแถม:" (English documents: "Complimentary:"), then one line per freebie, each starting with "- ", with every count and name exactly as given.
  Anything from NOTE that is not a component (a condition, a date, a name list) goes on its own line after the components, before the freebies.
  No other headings, numbering, bold, bullets other than "- ", or trailing spaces. Keep each line short enough to read at a glance.
  Example of the shape (content is only an illustration):
  หลักสูตร Build Up ระยะเวลาเรียน 6 เดือน ต่อผู้เรียน 1 ท่าน ประกอบด้วย
  - คลาสเรียนตัวต่อตัว 1:1 (Private Development Class) ครั้งละ 25 นาที จำนวน 36 ครั้ง
  - คลาสกลุ่ม (Discussion Class) 4-5 ท่าน ครั้งละ 55 นาที จำนวน 4 ครั้ง
  - Master Class ใช้งานได้ตลอดระยะเวลาแพ็กเกจ

  ของแถม:
  - Speedy 6 เดือน ครั้งละ 30 นาที จำนวน 30 ครั้ง/เดือน (สูงสุด 180 ครั้ง)
  - E-learning 6 เดือน
- Write in the document language, plain and natural, the way a careful person writes a business document. No marketing words, no emoji, no markdown, no em dashes.
- If NOTE contradicts BASE (different hours, price, duration, product), or reads like an internal remark that must not be shown to the customer (commission, internal names, "อย่าบอกลูกค้า", approvals, cost), do not write a description.
Reply with JSON only, one of:
{"ok":true,"description":"..."}
{"ok":false,"reason":"<short reason in Thai for the salesperson>"}`;

// One call. Returns the parsed reply, or null when the model's text holds no complete JSON object
// (cut off at the token limit, or prose instead of JSON); the caller asks once more.
async function ask(user, maxTokens) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
  } finally { clearTimeout(t); }
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  let out = null;
  if (m) { try { out = JSON.parse(m[0]); } catch { out = null; } }
  // The reply itself is the only clue to why it could not be read: keep its start and why the model stopped.
  if (!out) console.warn('describe: unreadable reply', JSON.stringify({ stop: j.stop_reason, types: (j.content || []).map((c) => c.type), text: text.slice(0, 300) }));
  return { out, stop: j.stop_reason };
}

async function describeLine({ base, note, freebie, lang }) {
  const user = [`DOCUMENT LANGUAGE: ${/en/i.test(lang || '') ? 'English' : 'Thai'}`, `BASE:\n${base || ''}`, note ? `NOTE:\n${note}` : '', freebie ? `FREEBIE:\n${freebie}` : ''].filter(Boolean).join('\n\n');
  // Thai costs several tokens per character: a long package + note can pass a small limit and arrive cut in half.
  let a = await ask(user, 4000);
  if (!a.out) a = await ask(user, 8000);
  if (!a.out) throw new Error(`Claude API: ตอบกลับไม่ใช่ JSON${a.stop === 'max_tokens' ? ' (คำตอบยาวเกินจนถูกตัด)' : a.stop === 'refusal' ? ' (โมเดลไม่ตอบ)' : ''}`);
  const out = a.out;
  if (out.ok && String(out.description || '').trim()) return { ok: true, description: String(out.description).trim() };
  return { ok: false, reason: String(out.reason || 'คำอธิบายเพิ่มเติมขัดกับแพ็กเกจ').slice(0, 300) };
}

module.exports = { enabled, describeLine, SYSTEM };
