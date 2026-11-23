// Phase 1: no live link to the B2B CRM (ERPNext). Requests carry the CRM Opportunity ID
// so the Revenue Hub, PEAK and the CRM can be matched to each other later. A QT can be asked for before the lead
// is converted, so the same field also takes the CRM Lead ID (CRM-LEAD-YYYY-NNNNN).
const OPP_RE = /^CRM-(?:OPP|LEAD)-\d{4}-\d{5}$/;

// One document can cover several CRM records (one QT / INV for two opportunities of the same customer):
// the field then holds the IDs as "ID, ID". Accepts any casing, spaces, or pasted CRM URLs ending in an ID.
const MAX_OPP = 5;
function oppList(v) {
  const s = String(v ?? '').trim().toUpperCase();
  const m = s.match(/CRM-(?:OPP|LEAD)-\d{4}-\d{5}/g);
  if (!m) return s ? [s.replace(/\s+/g, '')] : [];
  // A half-typed ID next to good ones must not vanish quietly: keep it so the check on the shape refuses the field.
  const rest = /CRM-[A-Z0-9-]*/.exec(m.reduce((t, x) => t.split(x).join(' '), s));
  return [...new Set(m), ...(rest ? [rest[0]] : [])];
}
const normaliseOppId = (v) => oppList(v).join(', ');
// Every ID in the field has the wanted shape.
const oppAll = (v, re) => oppList(v).every((x) => re.test(x));

// An INV needs the Opportunity: the lead has to be converted first.
const OPP_ONLY_RE = /^CRM-OPP-\d{4}-\d{5}$/;

module.exports = { OPP_RE, OPP_ONLY_RE, MAX_OPP, normaliseOppId, oppList, oppAll };
