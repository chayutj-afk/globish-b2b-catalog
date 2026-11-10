// Thai 13-digit tax ID / national ID: the last digit is a mod-11 check digit.
function validTaxId(s) {
  const d = String(s || '');
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}

// Branch code as PEAK keeps it: 5 digits, 00000 = head office.
function normBranch(s) {
  const t = String(s ?? '').trim();
  if (t === '' || /สำนักงานใหญ่|head ?office/i.test(t)) return '00000';
  return /^\d{1,5}$/.test(t) ? t.padStart(5, '0') : null;
}

module.exports = { validTaxId, normBranch };
