// lib/peaksync.js against the mock hub: edits / voids made in PEAK flow back into AR and the requests.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
process.env.HUB_MODE = 'mock';
process.env.HUB_MOCK_FILE = path.join(os.tmpdir(), `peaksync-${process.pid}.json`);
fs.writeFileSync(process.env.HUB_MOCK_FILE, '{}');
const hub = require('../lib/hub');
const peak = require('../lib/peak');
const ps = require('../lib/peaksync');
peak.getClassifications = async () => ({ G013: 'G013-00001', G014: 'B2B-S002' });

async function seed() {
  fs.writeFileSync(process.env.HUB_MOCK_FILE, '{}');
  await hub.appendRows('Invoices', [{ ivNo: 'IV-1', issueDate: '01/11/2026', preVat: 10000, creditTermDays: 30, whtRate: '0.03', clientCode: 'C1', docStatus: 'Active', peakIvId: 'i1', ivRequestId: 'R-1', rtNo: 'RT-9' }]);
  await hub.appendRows('InvoiceRequests', [{ ivRequestId: 'R-1', status: 'iv_issued', peakIvNo: 'IV-1', peakIvId: 'i1', amountPreVat: 10000, amountInclVat: 10700 }]);
  await hub.appendRows('ReceiptRequests', [{ rtRequestId: 'RT-REQ-1', status: 'issued', peakRtNo: 'RT-9', peakRtId: 'r9' }]);
}
const ar = async () => (await hub.readTable('Invoices'))[0];
const req = async () => (await hub.readTable('InvoiceRequests'))[0];

test('approved INV edited in PEAK → AR and INV request updated, classification kept', async () => {
  await seed();
  const out = await ps.syncInvoice({ id: 'i1', code: 'IV-1', status: 'Approve', taxStatus: 0, preTaxAmount: 12000, netAmount: 12840, whtAmount: 240, issuedDate: '20261105', dueDate: '20261220', contactCode: 'C1', documentLink: 'https://doc/x' }, { classes: true });
  const a = await ar();
  assert.equal(Number(a.preVat), 12000);
  assert.equal(a.issueDate, '05/11/2026');
  assert.equal(Number(a.creditTermDays), 45);
  assert.equal(Number(a.whtRate), 0.02);
  assert.deepEqual(JSON.parse(a.classPicks), { G013: 'G013-00001', G014: 'B2B-S002' });
  assert.equal(Number((await req()).amountPreVat), 12000);
  assert.ok(out.changes.length >= 4);
  assert.deepEqual((await ps.syncInvoice({ id: 'i1', code: 'IV-1', status: 'Approve', taxStatus: 0, preTaxAmount: 12000, netAmount: 12840, whtAmount: 240, issuedDate: '20261105', dueDate: '20261220', contactCode: 'C1', documentLink: 'https://doc/x' }, { classes: true })).changes, [], 'second run: nothing to change');
});

test('INV voided in PEAK → AR Cancelled, request iv_void', async () => {
  await seed();
  await ps.syncInvoice({ id: 'i1', code: 'IV-1', status: 'Void', isVoid: 1 });
  assert.equal((await ar()).docStatus, 'Cancelled');
  assert.equal((await req()).status, 'iv_void');
});

test('receipt voided in PEAK → RT request rt_void, RT No. cleared on AR', async () => {
  await seed();
  await ps.syncReceipt({ id: 'r9', code: 'RT-9', status: 'Void', isVoid: 1 });
  assert.equal((await ar()).rtNo, '');
  assert.equal((await hub.readTable('ReceiptRequests'))[0].status, 'rt_void');
});

test('imported INV (no PEAK id) found by number', async () => {
  await seed();
  const a0 = await ar(); await hub.updateRow('Invoices', a0._row, { peakIvId: '' });
  const r0 = await req(); await hub.updateRow('InvoiceRequests', r0._row, { peakIvId: '' });
  const out = await ps.syncInvoice({ id: 'i-new', code: 'iv-1', status: 'Approve', preTaxAmount: 10000, issuedDate: '20261101', dueDate: '20261201' });
  assert.ok(out);
  assert.equal((await ar()).peakIvId, 'i-new');
});

test('another PEAK document that reuses the number (a voided twin) never touches our row', async () => {
  await seed();
  const out = await ps.syncInvoice({ id: 'i-other', code: 'IV-1', status: 'Void', isVoid: 1 });
  assert.equal(out, null);
  assert.equal((await ar()).docStatus, 'Active');
  assert.equal((await req()).status, 'iv_issued');
  assert.equal(await ps.syncReceipt({ id: 'r-other', code: 'RT-9', status: 'Void', isVoid: 1 }), null);
  assert.equal((await ar()).rtNo, 'RT-9');
});

test('refresh keeps the name the INV was issued under; a later Sales Performance code moves imported INVs', async () => {
  fs.writeFileSync(process.env.HUB_MOCK_FILE, '{}');
  await hub.appendRows('Invoices', [{ ivNo: 'IV-7', issueDate: '01/10/2026', preVat: 10000, creditTermDays: 30, clientCode: 'C1', taxId: '0105542031616', company: 'บริษัท ชื่อเดิม จำกัด', docStatus: 'Active', ivRequestId: 'LEGACY-IV-7', salesEmail: 'old@g.co', salesName: 'Old', classPicks: '{"G014":"B2C-S005"}' }]);
  await hub.appendRows('InvoiceRequests', [{ ivRequestId: 'LEGACY-IV-7', status: 'iv_issued', peakIvNo: 'IV-7', requestedBy: 'old@g.co', salesName: 'Old' }]);
  await hub.appendRows('Users', [{ email: 'emmy@g.co', name: 'Emmy', role: 'sales', salesPerf: 'B2C-S005' }]);
  const keep = [peak.findContacts, peak.getClassifications];
  peak.findContacts = async () => [{ code: 'C1', name: 'ชื่อใหม่', branchCode: '00000' }];
  peak.getClassifications = async () => null;
  const iv = { id: 'i7', code: 'IV-7', status: 'Approve', preTaxAmount: 10000, issuedDate: '20261001', dueDate: '20261031', contactCode: 'C1' };
  await ps.syncInvoice(iv, { classes: true });
  assert.equal((await ar()).company, 'บริษัท ชื่อเดิม จำกัด');
  await ps.syncInvoice({ ...iv, contactCode: 'C2' }, { classes: true });
  assert.equal((await ar()).clientCode, 'C2');
  peak.findContacts = async () => [{ code: 'C2', name: 'ลูกค้าอีกราย', branchCode: '00000' }];
  await hub.updateRow('Invoices', (await ar())._row, { clientCode: 'C1' });
  await ps.syncInvoice({ ...iv, contactCode: 'C2' });
  assert.equal((await ar()).company, 'ลูกค้าอีกราย', 'moved to another contact: name follows');
  assert.deepEqual(await ps.remapSeller('emmy@g.co', 'B2C-S005'), ['IV-7']);
  assert.equal((await ar()).salesEmail, 'emmy@g.co');
  assert.equal((await req()).requestedBy, 'emmy@g.co');
  assert.deepEqual(await ps.remapSeller('emmy@g.co', 'B2C-S005'), []);
  [peak.findContacts, peak.getClassifications] = keep;
});

test('refresh: an imported INV takes its customer group from the PEAK classification', async () => {
  fs.writeFileSync(process.env.HUB_MOCK_FILE, '{}');
  await hub.appendRows('Invoices', [{ ivNo: 'IV-8', issueDate: '01/10/2026', preVat: 10000, creditTermDays: 30, clientCode: 'C1', segment: 'B2C', docStatus: 'Active', ivRequestId: 'LEGACY-IV-8', classPicks: '{"G013":"G013-00004"}' }]);
  const keep = peak.getClassifications;
  peak.getClassifications = async () => ({ G013: 'G013-00001' });
  const out = await ps.syncInvoice({ id: 'i8', code: 'IV-8', status: 'Approve', preTaxAmount: 10000, issuedDate: '20261001', dueDate: '20261031', contactCode: 'C1' }, { classes: true });
  assert.equal((await ar()).segment, 'B2B');
  assert.ok(out.changes.some((x) => x.includes('กลุ่มลูกค้า')));
  peak.getClassifications = keep;
});
