// Phase 1: no live link to the B2B CRM (ERPNext). Requests carry the CRM Opportunity ID
// so the Revenue Hub, PEAK and the CRM can be matched to each other later.
const OPP_RE = /^CRM-OPP-\d{4}-\d{5}$/;

// Accepts "crm-opp-2026-00123", spaces, or a pasted CRM URL ending in the ID.
function normaliseOppId(v) {
  const s = String(v ?? '').trim().toUpperCase();
  const m = /CRM-OPP-\d{4}-\d{5}/.exec(s);
  return m ? m[0] : s.replace(/\s+/g, '');
}

module.exports = { OPP_RE, normaliseOppId };
