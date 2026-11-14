process.env.HUB_MODE = 'mock'; process.env.HUB_MOCK_FILE = process.argv[2];
const fs = require('fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ Components: [["Private Class","count","B2B-PVT"],["Discussion Class","count","B2B-DSC"],["GB+: AI","TRUE/0","B2B-GBAI"],["Workshop","count","B2B-WS"],["Master Class","count","B2B-MSTC"],["Coach surcharge","surcharge","B2B-SC-COACH"],["Travel surcharge","surcharge","B2B-SC-TRVL"]], SalesPerf: [['B2B-S001','Siraprapa (Bee)'],['B2B-S002','Kawinthida (Kookkai)'],['B2C-S003','Chattraya (Benz)']] }));
const hub = require('../../lib/hub');
(async () => {
  await hub.appendRows('Users', [
    { email: 'bee@globish.co.th', name: 'Siraprapa (Bee)', role: 'sales', team: 'b2b', salesPerf: 'B2B-S001' },
    { email: 'kook@globish.co.th', name: 'Kawinthida (Kookkai)', role: 'sales', team: 'b2b', salesPerf: 'B2B-S002' },
    { email: 'benz@globish.co.th', name: 'Chattraya (Benz)', role: 'sales', team: 'b2c', salesPerf: 'B2C-S003' },
    { email: 'lead@globish.co.th', name: 'Lead B2B', role: 'lead', team: 'b2b' },
    { email: 'acct@globish.co.th', name: 'Acct', role: 'op', team: 'both' },
    { email: 'col@globish.co.th', name: 'Collector', role: 'collector', team: 'both' },
    { email: 'oper@globish.co.th', name: 'Operation', role: 'operation', team: 'both' },
    { email: 'admin@globish.co.th', name: 'Admin', role: 'admin', team: 'both' }]);
  await hub.appendRows('WHPackages', [{ id: '5136', name: 'Private 1:1 30 hrs', updatedAt: '10/11/2026 10:00' }]).catch((e) => console.log('wh', e.message));
  // imported (legacy) rows like the real backfill
  await hub.appendRows('Requests', [
    { requestId: 'LEGACY-QO-20261100020', createdAt: '11/11/2026 00:00', requestedBy: 'kook@globish.co.th', salesName: 'Kawinthida (Kookkai)', segment: 'B2B', company: 'ซิสเม็กซ์', taxId: '0105540000011', branch: '00000', docLang: 'TH', status: 'qt_approved', peakQtNo: 'QO-20261100020', peakQtId: 'legacy:QO-20261100020', totalPreVat: '100000', vatMode: 'excl', totalInclVat: '107000', whtRate: '3', clientCode: 'CB00017', opportunityId: 'CRM-OPP-2026-00020' },
    { requestId: 'LEGACY-QO-20261100013', createdAt: '06/11/2026 00:00', requestedBy: '', salesName: '', segment: 'B2B', company: 'ไทยฟู้ดส์', taxId: '0105540000022', branch: '00000', docLang: 'TH', status: 'qt_approved', peakQtNo: 'QO-20261100013', peakQtId: 'legacy:QO-20261100013', totalPreVat: '50000', vatMode: 'excl', totalInclVat: '53500' }]);
  await hub.appendRows('InvoiceRequests', [
    { ivRequestId: 'LEGACY-IV-20261100001', createdAt: '02/11/2026 00:00', requestedBy: 'bee@globish.co.th', salesName: 'Siraprapa (Bee)', requestId: '', qtNo: 'QO-20261000008', company: 'พูแรค', taxId: '0105540000033', wantedIssueDate: '02/11/2026', billing: 'Full', amountPreVat: '40000', amountInclVat: '42800', students: '10', creditTermDays: '30', status: 'iv_issued', peakIvNo: 'IV-20261100001', branch: '00000', whtRate: '3' },
    { ivRequestId: 'LEGACY-IV-20261000030', createdAt: '20/10/2026 00:00', requestedBy: 'ลาออก', salesName: 'ลาออก', requestId: '', qtNo: 'QO-20260900049', company: 'ไดอิจิ', taxId: '0105540000044', wantedIssueDate: '20/10/2026', billing: 'Full', amountPreVat: '20000', amountInclVat: '21400', students: '5', creditTermDays: '30', status: 'iv_issued', peakIvNo: 'IV-20261000030', branch: '00000', whtRate: '0' }]);
  const A = (no, issue, extra = {}) => ({ ivNo: no, issueDate: issue, segment: 'B2B', salesEmail: 'bee@globish.co.th', salesName: 'Siraprapa (Bee)', company: `ลูกค้า ${no}`, taxId: '0105540000033', preVat: '40000', creditTermDays: '30', whtRate: '0.03', docStatus: 'Active', source: 'legacy', ...extra });
  await hub.appendRows('Invoices', [
    A('IV-20261100001', '02/11/2026', { ivRequestId: 'LEGACY-IV-20261100001', qtNo: 'QO-20261000008' }),
    A('IV-20261000030', '20/10/2026', { salesEmail: 'ลาออก', salesName: 'ลาออก', preVat: '20000', ivRequestId: 'LEGACY-IV-20261000030', company: 'ไดอิจิ' }),
    A('IV-20250500001', '01/05/2025', { salesEmail: '', salesName: '', preVat: '15000', followStatus: 'ตรวจสถานะกับ PEAK (ข้อมูลเก่า)', company: 'เก่า 2025' }),
    A('IV-20260900005', '05/09/2026', { salesEmail: 'kook@globish.co.th', salesName: 'Kawinthida (Kookkai)', preVat: '60000', paidDate: '01/10/2026', paidAmount: '62400', paymentMethod: 'Bank Transfer', company: 'จ่ายแล้ว' }),
    A('IV-20260800009', '09/08/2026', { salesEmail: 'benz@globish.co.th', salesName: 'Chattraya (Benz)', segment: 'B2C', preVat: '14859.81', company: 'B2C ค้าง' })]);
  console.log('seeded');
})().catch((e) => { console.error(e); process.exit(1); });
