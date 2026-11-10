# 2026 B2B Standard Catalog

คำนวณราคาแพ็กเกจ B2B, ขอใบเสนอราคา และจัดการแพ็กเกจ (Key H.S.) สำหรับทีม Sales และ Operation

## การเข้าใช้งาน

ทุกหน้าต้องเข้าสู่ระบบด้วย Google บัญชี @globish.co.th (`middleware.js` + `/api/auth/*`) สิทธิ์ Operation (แก้และ Publish แพ็กเกจ) ให้ตามอีเมลใน `OWNER_EMAILS` / `OPS_EMAILS` แทนรหัสผ่านกลางแบบเดิม

## Flow ขอใบเสนอราคา

1. Sales คำนวณราคาในแท็บ 🧮 แล้วกด "เพิ่มเข้าคำขอใบเสนอราคา" (ใส่ได้หลายแพ็กเกจ)
2. แท็บ 📝 กรอกข้อมูลลูกค้าแล้วส่ง → `POST /api/requests`
3. ราคาแคตตาล็อกเป็นค่าอ้างอิง Sales แก้ราคาต่อหน่วยและใส่ส่วนลด (บาท หรือ %) ได้ ระบบเก็บราคาแคตตาล็อกไว้เทียบ
   และบันทึกรายการที่ต่ำกว่าราคา Tier ต่ำสุดไว้ในคอลัมน์ "Below catalog floor" (ไม่บล็อก) แล้วแตก Key H.S. เป็นบรรทัด:
   บรรทัด hero มีราคา ส่วนเสริมแต่ละตัวเป็นบรรทัดราคา 0 และ surcharge (โค้ชต่างชาติ/นอก กทม.) เป็นบรรทัดแยก
4. เขียนลงแท็บ `Requests`, `RequestLines`, `SyncLog` ใน Revenue Hub
5. ถ้า `PEAK_MODE` = `uat`/`prod` และทุกบรรทัดมีรหัสบริการ PEAK (แท็บ `Products` คอลัมน์ P, แท็บ `Components` คอลัมน์ D)
   จะสร้างใบเสนอราคา **Draft** ใน PEAK ให้บัญชีตรวจและอนุมัติ ถ้ายังไม่ครบ คำขอจะรอสถานะ `new`

## Flow ขอออก INV

1. Sales เลือกคำขอ QT ในระบบ (หรือกรอกเลข QT นอกระบบ) แล้วแนบหลักฐานที่ลูกค้ายอมรับ:
   QT ที่เซ็นแล้ว, PO, อีเมลยืนยัน หรืออื่นๆ เป็นไฟล์ (PDF/JPG/PNG ไม่เกิน 3 MB) หรือลิงก์ Google Drive
2. ระบุวันที่ออก INV, เต็มจำนวนหรือแบ่งงวด (งวด + ยอดก่อน VAT), เลข PO, ผู้ติดต่อการเงิน, ที่อยู่ส่งตัวจริง
3. `POST /api/invoice-requests` เขียนแท็บ `InvoiceRequests` และเปลี่ยนสถานะคำขอ QT เป็น `iv_requested`
4. อัปโหลดไฟล์ได้เมื่อตั้ง `DOCS_FOLDER_ID` เป็นโฟลเดอร์ใน **Shared Drive** ที่ service account เป็น Content manager
   (service account ไม่มีพื้นที่ใน My Drive) ถ้ายังไม่ตั้ง ฟอร์มจะรับเฉพาะลิงก์

## Environment variables

ดู `.env.example` ค่าลับทั้งหมดอยู่ใน Vercel เท่านั้น

- Google OAuth client ต้องมี redirect URI `https://<domain>/api/auth/callback`
- แชร์ Revenue Hub ให้ `GOOGLE_SERVICE_ACCOUNT_EMAIL` เป็น Editor
- `AUTH_SECRET` ใช้เซ็น cookie เปลี่ยนค่าแล้วทุกคนต้องเข้าสู่ระบบใหม่
- `OPERATION_PASSWORD` ไม่ใช้แล้ว ลบออกจาก Vercel ได้

## ทดสอบในเครื่อง

```
npm install
npm test
AUTH_SECRET=$(openssl rand -hex 32) HUB_MODE=mock node test/dev-server.mjs 3939
```
