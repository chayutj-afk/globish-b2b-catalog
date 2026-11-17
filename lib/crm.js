// Phase 1: no live link to the B2B CRM (ERPNext). Requests carry the CRM Opportunity ID
// so the Revenue Hub, PEAK and the CRM can be matched to each other later. A QT can be asked for before the lead
// is converted, so the same field also takes the CRM Lead ID (CRM-LEAD-YYYY-NNNNN).
const OPP_RE = /^CRM-(?:OPP|LEAD)-\d{4}-\d{5}$/;

// Accepts "crm-opp-2026-00123", spaces, or a pasted CRM URL ending in the ID.
function normaliseOppId(v) {
  const s = String(v ?? '').trim().toUpperCase();
  const m = /CRM-(?:OPP|LEAD)-\d{4}-\d{5}/.exec(s);
  return m ? m[0] : s.replace(/\s+/g, '');
}

// An INV needs the Opportunity: the lead has to be converted first.
const OPP_ONLY_RE = /^CRM-OPP-\d{4}-\d{5}$/;

module.exports = { OPP_RE, OPP_ONLY_RE, normaliseOppId };
