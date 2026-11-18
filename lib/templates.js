// Customer-facing wording for QT / INV lines, per product (from Product's sheet "Product Details for QT / IV").
// The numbers come from the package's Key H.S., never from the text: {n} sessions, {months}, {hours}, {minutes}.
// Defaults live here; the Revenue Hub tab "DescTemplates" (key, name, th, en) overrides them, so Product can
// change the wording without a code change. A missing tab, row or cell falls back to the default.
const DEFAULTS = {
  PVT: {
    name: 'Private Class',
    th: 'คลาสเรียนแบบตัวต่อตัวกับโค้ช จำนวน {n} คลาส (คลาสละ 25 นาที) เน้นการพัฒนาทักษะภาษาอังกฤษด้าน Business English พร้อมคำแนะนำจากโค้ช',
    en: 'One-on-one English coaching with a coach for {n} sessions (25 minutes per session), focusing on Business English. Learners receive personalized guidance and feedback to support their English development.',
  },
  DSC: {
    name: 'Discussion Class',
    th: 'คลาสเรียนภาษาอังกฤษแบบกลุ่มเล็ก ผู้เรียน 4-5 คน จำนวน {n} คลาส (คลาสละ 55 นาที) เน้นการฝึกพูดและแลกเปลี่ยนความคิดเห็นผ่านสถานการณ์ที่เกี่ยวข้องกับการทำงานและชีวิตประจำวัน',
    en: 'Small-group English classes for 4–5 learners, with {n} sessions (55 minutes per session). Classes focus on speaking practice and exchanging ideas through situations related to work and everyday life.',
  },
  SPD: {
    name: 'Speedy Class',
    th: 'คลาสเรียนภาษาอังกฤษแบบกลุ่มใหญ่ ผู้เรียน 5-10 คน จำนวน {n} คลาส (คลาสละ 30 นาที) เน้นเพิ่มความคล่องแคล่วในการสื่อสารและทำกิจกรรมผ่านหัวข้อที่หลากหลาย',
    en: 'Group English classes for 5–10 learners, with {n} sessions (30 minutes per session). Classes focus on improving communication fluency through a variety of topics and interactive activities.',
  },
  GBAI: {
    name: 'Globish Plus (AI E-learning)',
    th: 'คลาสเรียน E-learning โดยมี AI แนะนำบทเรียนให้เหมาะสมกับระดับภาษาและความต้องการของผู้เรียนรายบุคคล เรียนได้ไม่จำกัด',
    en: 'AI-powered English e-learning that recommends lessons based on each learner’s language proficiency level and individual needs. Learners can access the courses without session limits.',
  },
  WS_PUBLIC: {
    name: 'Online Workshop (Public)',
    th: 'คลาสเวิร์กช็อปภาษาอังกฤษออนไลน์ จำนวน {n} คลาส (คลาสละ 1 ชั่วโมง) ให้ผู้เรียนร่วมพูดคุยและทำกิจกรรมตามหัวข้อที่สนใจ ครอบคลุมหัวข้อที่เกี่ยวข้องกับการทำงานและการพัฒนาทักษะภาษาอังกฤษ',
    en: 'Online workshop with {n} sessions (1 hour per session): interactive, activity-based live classes covering workplace-related topics and English language development.',
  },
  // Included in a package: written as a period, not a number of sessions.
  MC: {
    name: 'Online Master Class (included in a package)',
    th: 'คลาสสัมมนาออนไลน์ภาษาอังกฤษหัวข้อต่างๆ โดยโค้ชผู้เชี่ยวชาญ พร้อมเปิดโอกาสให้ผู้เรียนซักถามและแลกเปลี่ยนความคิดเห็นผ่านช่องแชท เข้าร่วมได้ตลอดระยะเวลา {months} เดือน',
    en: 'Live online seminars featuring coach-led knowledge sharing with Q&A sessions, available throughout the {months}-month package.',
  },
  // Sold on its own, per class (60 / 90 / 120 minutes).
  MC_HERO: {
    name: 'Online Master Class (sold per class)',
    th: 'คลาสสัมมนาออนไลน์ภาษาอังกฤษหัวข้อต่างๆ โดยโค้ชผู้เชี่ยวชาญ (คลาสละ {minutes} นาที) พร้อมเปิดโอกาสให้ผู้เรียนซักถามและแลกเปลี่ยนความคิดเห็นผ่านช่องแชท',
    en: 'Live online seminars ({minutes} minutes per session) featuring coach-led knowledge sharing with Q&A sessions.',
  },
  BGC_ONLINE: {
    name: 'Business Group Class – Online',
    th: 'คลาสเรียนภาษาอังกฤษแบบกลุ่มสำหรับพนักงานภายในองค์กร จัดการเรียนผ่านออนไลน์ เน้นการพัฒนาทักษะการสื่อสารภาษาอังกฤษในบริบทการทำงาน สอนโดยโค้ชผู้เชี่ยวชาญ จำนวนผู้เรียน 15 คน/คลาส เรียนทั้งหมด {n} หัวข้อ ({hours} ชั่วโมง)',
    en: 'Group English classes exclusively for employees within the organization, delivered online. Classes focus on developing English communication skills for the workplace and are led by professional coaches. Each class accommodates up to 15 learners and covers {n} topics ({hours} hours in total).',
  },
  BGC_ONSITE: {
    name: 'Business Group Class – Onsite',
    th: 'คลาสเรียนภาษาอังกฤษแบบกลุ่มสำหรับพนักงานภายในองค์กร จัดการเรียนที่บริษัท เน้นการพัฒนาทักษะการสื่อสารภาษาอังกฤษในบริบทการทำงาน สอนโดยโค้ชผู้เชี่ยวชาญ จำนวนผู้เรียน 15 คน/คลาส เรียนทั้งหมด {n} หัวข้อ ({hours} ชั่วโมง)',
    en: 'Group English classes exclusively for employees within the organization, delivered at the company’s premises. Classes focus on developing English communication skills for the workplace and are led by professional coaches. Each class accommodates up to 15 learners and covers {n} topics ({hours} hours in total).',
  },
  BGC_HYBRID: {
    name: 'Business Group Class – Hybrid',
    th: 'คลาสเรียนภาษาอังกฤษแบบกลุ่มสำหรับพนักงานภายในองค์กร รองรับการเรียนทั้งรูปแบบ Online และ Onsite เน้นการพัฒนาทักษะการสื่อสารภาษาอังกฤษในบริบทการทำงาน สอนโดยโค้ชผู้เชี่ยวชาญ จำนวนผู้เรียน 15 คน/คลาส เรียนทั้งหมด {n} หัวข้อ ({hours} ชั่วโมง)',
    en: 'Group English classes exclusively for employees within the organization, delivered through a combination of online and onsite sessions. Classes focus on developing English communication skills for the workplace and are led by professional coaches. Each class accommodates up to 15 learners and covers {n} topics ({hours} hours in total).',
  },
  PWS_ONSITE: {
    name: 'Private Workshop – Onsite',
    th: 'คลาสเวิร์กช็อปสำหรับพนักงานภายในองค์กร จัด ณ สถานที่ขององค์กร เน้นการเรียนรู้ผ่านกิจกรรมและการฝึกปฏิบัติในหัวข้อที่เกี่ยวข้องกับความต้องการขององค์กร โดย HR สามารถเลือกหัวข้อได้ รองรับผู้เข้าร่วมสูงสุด 30 คนต่อครั้ง',
    en: 'Private workshops exclusively for employees within the organization, held at the company’s premises. Workshops focus on learning through interactive activities and practical exercises tailored to the organization’s needs. HR can select the topics. Each session accommodates up to 30 participants.',
  },
  PWS_ONLINE: {
    name: 'Private Workshop – Online',
    th: 'คลาสเวิร์กช็อปสำหรับพนักงานภายในองค์กร จัดในรูปแบบออนไลน์ เน้นการเรียนรู้ผ่านกิจกรรมและการฝึกปฏิบัติในหัวข้อที่เกี่ยวข้องกับความต้องการขององค์กร โดย HR สามารถเลือกหัวข้อได้ รองรับผู้เข้าร่วมสูงสุด 30 คนต่อครั้ง',
    en: 'Private online workshops exclusively for employees within the organization. Workshops focus on learning through interactive activities and practical exercises tailored to the organization’s needs. HR can select the topics. Each session accommodates up to 30 participants.',
  },
  GECB4: {
    name: 'GECB Assessment Adult Learners (4 skills)',
    th: 'แบบทดสอบประเมินระดับความสามารถทางภาษาอังกฤษตามมาตรฐาน CEFR\nระยะเวลาการทำข้อสอบ 1.30 - 2 ชั่วโมง\nภายในข้อสอบประกอบด้วย:\n- Reading Skill (15 Questions)\n- Listening Skill (15 Questions)\n- Speaking Skill (2 Prompts)\n- Writing Skill (2 Prompts)',
    en: 'English proficiency assessment aligned with the CEFR (Common European Framework of Reference for Languages).\nAssessment Duration: 1.5–2 hours\nAssessment Components:\n- Reading Skill (15 Questions)\n- Listening Skill (15 Questions)\n- Speaking Skill (2 Prompts)\n- Writing Skill (2 Prompts)',
  },
};

let over = {}, loadedAt = 0;
const TTL = 5 * 60e3;

// Wording for a key in a language, with the numbers filled in. '' when there is no template for the key,
// or when the text needs a number the package does not have (the caller then keeps its own short wording).
function text(key, lang, vals = {}) {
  const L = lang === 'EN' ? 'en' : 'th';
  const d = DEFAULTS[key]; if (!d) return '';
  let t = String((over[key] && over[key][L]) || d[L] || '').trim();
  let missing = false;
  t = t.replace(/\{(n|months|hours|minutes)\}/g, (m, k) => { const v = vals[k]; if (v === undefined || v === null || v === '' || v === 0) { missing = true; return m; } return String(v); });
  return missing ? '' : t;
}

// Reads the DescTemplates tab (cached). Never throws: the defaults always work.
async function load(hub = require('./hub')) {
  if (Date.now() - loadedAt < TTL) return;
  loadedAt = Date.now();
  try {
    const rows = await hub.readTable('DescTemplates', { alone: true });
    const o = {};
    for (const r of rows) { const k = String(r.key || '').trim().toUpperCase(); if (DEFAULTS[k]) o[k] = { th: String(r.th || '').trim(), en: String(r.en || '').trim() }; }
    over = o;
  } catch (e) { /* tab not there yet, or Sheets is busy: keep what we have */ }
}

module.exports = { DEFAULTS, text, load, _set: (o) => { over = o || {}; } };
