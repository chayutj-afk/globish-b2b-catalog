const test = require('node:test');
const assert = require('node:assert');
const ar = require('../lib/ar');

const d = (s) => ar.parseDate(s);
const we = (s) => ar.fmt(ar.weekEnd(d(s)));

test('cash week: Friday to Thursday, cut at the month end (Debt sheet Week Mapping)', () => {
  assert.equal(we('13/11/2026'), '19/11/2026'); // Friday starts a week
  assert.equal(we('16/11/2026'), '19/11/2026');
  assert.equal(we('19/11/2026'), '19/11/2026'); // Thursday ends it
  assert.equal(we('20/11/2026'), '26/11/2026');
  assert.equal(we('27/11/2026'), '30/11/2026'); // 27–30 Nov: short week 48.1
  assert.equal(we('30/11/2026'), '30/11/2026');
  assert.equal(we('01/12/2026'), '03/12/2026'); // 1–3 Dec
  assert.equal(we('31/07/2026'), '31/07/2026'); // one-day week 31.1
  assert.equal(we('30/07/2026'), '30/07/2026');
  assert.equal(we('31/12/2026'), '31/12/2026');
  assert.equal(we('01/01/2027'), '07/01/2027');
});

test('week start is the day after the previous week end', () => {
  const ws = (s) => ar.fmt(ar.weekStart(d(s)));
  assert.equal(ws('19/11/2026'), '13/11/2026');
  assert.equal(ws('30/11/2026'), '27/11/2026');
  assert.equal(ws('03/12/2026'), '01/12/2026');
  assert.equal(ws('31/07/2026'), '31/07/2026');
});

test('forecast uses the commit date, the due date while there is none; passed dates need a new commit', () => {
  const today = d('16/11/2026');
  const base = { issueDate: '01/10/2026', creditTermDays: 30, preVat: 1000, whtRate: 0.03, docStatus: 'Active' };
  let e = ar.enrich({ ...base, commitDate: '27/11/2026' }, today);
  assert.equal(e.forecastWeek, '30/11/2026'); assert.equal(e.needCommit, false); assert.equal(e.noCommit, false);
  e = ar.enrich({ ...base, commitDate: '' }, today);
  assert.equal(e.forecastWeek, '31/10/2026'); assert.equal(e.noCommit, true); assert.equal(e.needCommit, true);
  e = ar.enrich({ ...base, commitDate: '10/11/2026' }, today);
  assert.equal(e.needCommit, true);
});

test('payment moves the commit date to the paid date and keeps the promised date', () => {
  const row = { issueDate: '01/10/2026', creditTermDays: 30, preVat: 1000, docStatus: 'Active', commitDate: '20/11/2026' };
  const f = ar.onPaid(row, '16/11/2026');
  assert.deepEqual(f, { commitDate: '16/11/2026', commitAtPaid: '20/11/2026' });
  const e = ar.enrich({ ...row, ...f, paidDate: '16/11/2026' }, d('16/11/2026'));
  assert.equal(e.paidWeek, '19/11/2026'); assert.equal(e.promisedDate, '20/11/2026'); assert.equal(e.paidVsCommit, -4);
  // correcting the paid date later keeps the original promise
  assert.equal(ar.onPaid({ ...row, ...f, paidDate: '16/11/2026' }, '17/11/2026').commitAtPaid, '20/11/2026');
  // rows paid before this rule (commit date still the promise)
  assert.equal(ar.enrich({ ...row, paidDate: '25/11/2026' }, d('30/11/2026')).paidVsCommit, 5);
});

test('a new INV starts with commit date = due date', () => {
  assert.equal(ar.dueOf('16/11/2026', 30), '16/12/2026');
});

test('AR group follows the selling team: a company customer sold by the B2C team is B2C', () => {
  const iv = { requestedBy: 'benz@globish.co.th', company: 'X', taxId: '1', qtNo: 'QO-1', requestId: 'R1', amountPreVat: 1000, creditTermDays: 30, whtRate: 3 };
  const users = [{ email: 'benz@globish.co.th', name: 'Benz', team: 'b2c' }, { email: 'bee@globish.co.th', name: 'Bee', team: 'b2b' }];
  const row = (by, segment) => ar.rowFromRequest({ ...iv, requestedBy: by }, { request: { segment }, lines: [], users, issueDate: '16/11/2026', ivNo: 'IV-1' }).segment;
  assert.equal(row('benz@globish.co.th', 'B2B'), 'B2C');
  assert.equal(row('bee@globish.co.th', 'B2B'), 'B2B');
  assert.equal(row('benz@globish.co.th', 'B2E'), 'B2E');
});
