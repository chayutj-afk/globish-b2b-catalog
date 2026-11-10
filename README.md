# Globish Sales Desk (B2B Catalog + ขอเอกสาร)

ขอเอกสาร QT / INV สำหรับทุกกลุ่มลูกค้า (B2B, B2E, B2S, Others) และ B2B Standard Catalog (คำนวณราคา, Key H.S.)

## หน้า

- `/` เมนูหลังเข้าสู่ระบบ: "ขอเอกสาร" หรือ "B2B Catalog" (ทีมที่ไม่ใช้ Catalog เช่น telesales B2E ไม่ต้องเข้า Catalog)
- `/request` ขอเอกสาร: แท็บ ขอ QT / ขอ INV / คำขอของฉัน
- `/catalog` B2B Standard Catalog: คำนวณราคาแล้ว "เพิ่มเข้าคำขอ" (ตะกร้าเก็บใน browser แชร์กับ `/request`)

ทุกหน้าต้องเข้าสู่ระบบด้วย Google บัญชี @globish.co.th (`middleware.js` + `/api/auth/*`) สิทธิ์ Operation ให้ตามอีเมลใน `OWNER_EMAILS` / `OPS_EMAILS`

## ขอ QT

- กลุ่มลูกค้ากำหนดชนิดรายการที่ใช้ได้:
  - **B2B**: แพ็กเกจจาก Catalog หรือ **Customized Package** ที่ใส่ Key H.S. จากทีม Product เอง
  - **B2E / B2S**: **Package ID ของ Whitehouse** (ตัวเลข; PEAK ใช้เลขเดียวกันเป็นรหัสบริการ) หรือรหัสบริการที่มีใน PEAK แล้ว (เช่น `B2SCAMP001`)
  - **Others**: ได้ทุกแบบ
- ราคา Catalog เป็นค่าอ้างอิง Sales ใส่ราคาจริงและส่วนลด (บาท หรือ %) ระบบบันทึกรายการที่ต่ำกว่า Tier ต่ำสุดไว้ใน "Below catalog floor"
- Key H.S. แตกเป็นบรรทัด: hero มีราคาเต็ม ส่วนเสริมราคา 0 surcharge แยกบรรทัด
- ตรวจเลขผู้เสียภาษี 13 หลักด้วย check digit และเก็บรหัสสาขาแบบ PEAK (5 หลัก, `00000` = สำนักงานใหญ่)
- เขียนแท็บ `Requests`, `RequestLines`, `SyncLog` ถ้า `PEAK_MODE` = `uat`/`prod` และทุกบรรทัดมีรหัสบริการ จะสร้าง QT **Draft** ใน PEAK

## เชื่อมกับ B2B CRM (Phase 1)

ยังไม่เชื่อมระบบกันตรงๆ แต่คำขอเก็บ **CRM Opportunity ID** (`CRM-OPP-YYYY-NNNNN`) ไว้อ้างอิง:
บังคับสำหรับ **B2B และ B2E**, B2S ไม่มี (ซ่อนช่อง), Others ไม่บังคับ วางลิงก์หน้า Opportunity ทั้งลิงก์ได้
คำขอ INV ได้ Opportunity ID ตาม QT ไปเอง Key H.S. ใน RequestLines ตรงกับ `product_code` ของ B2B Package ใน CRM

## ขอ INV (QT 1 ใบ → INV หลายใบ)

1. เลือกคำขอ QT ในระบบ (เห็นยอด QT, ขอ INV ไปแล้ว, คงเหลือ) หรือกรอกเลข QT นอกระบบ
2. แนบหลักฐานที่ลูกค้ายอมรับครั้งเดียวต่อคำขอ: QT ที่เซ็นแล้ว, PO, อีเมลยืนยัน หรืออื่นๆ (ไฟล์หรือลิงก์ Google Drive)
3. เพิ่ม INV ได้หลายใบ แต่ละใบ: ออกในนามลูกค้าตาม QT หรือบริษัทอื่น (บริษัทลูก: ชื่อ, เลขภาษี, สาขา, ความสัมพันธ์),
   ยอดก่อน VAT, ชื่องวด, จำนวนผู้เรียน, วันที่, เครดิตเทอม, PO, ต้องส่งตัวจริงไหม (ไม่ต้อง / ต้องส่ง / ยังไม่ทราบ)
4. ถ้ารวมแล้วเกินยอด QT ต้องใส่เหตุผล ลูกค้าเก็บเครดิตกลับมากด "ขอ INV จาก QT นี้" ได้เรื่อยๆ
5. แต่ละใบเป็น 1 แถวในแท็บ `InvoiceRequests` (`INVREQ-…-1`, `-2`, คอลัมน์ Batch ID รวมคำขอเดียวกัน)
   แท็บ `Requests` คอลัมน์ Z/AA คำนวณยอดที่ขอ INV แล้วและคงเหลือ
6. **ตัวจริง**: ในหน้า "คำขอของฉัน" Sales กด "ลูกค้าขอตัวจริง" (ใส่ผู้รับ/ที่อยู่) หรือ "ไม่ต้องส่ง" ได้ทีหลัง
   ฝ่ายบัญชี (op) กด "ส่งตัวจริงแล้ว" พร้อมเลขพัสดุ → `PATCH /api/invoice-requests`
7. แจ้งเตือน Google Chat (คำขอ INV ใหม่, ลูกค้าขอตัวจริง, ส่งตัวจริงแล้ว) เปิดเมื่อตั้ง `GCHAT_WEBHOOK_URL`
8. อัปโหลดไฟล์ได้เมื่อตั้ง `DOCS_FOLDER_ID` เป็นโฟลเดอร์ใน **Shared Drive** ที่ service account เป็น Content manager

## Environment variables

ดู `.env.example` ค่าลับทั้งหมดอยู่ใน Vercel เท่านั้น

- Google OAuth client ต้องมี redirect URI `https://<domain>/api/auth/callback`
- แชร์ Revenue Hub ให้ `GOOGLE_SERVICE_ACCOUNT_EMAIL` เป็น Editor
- `AUTH_SECRET` ใช้เซ็น cookie เปลี่ยนค่าแล้วทุกคนต้องเข้าสู่ระบบใหม่
- `OPERATION_PASSWORD` ไม่ใช้แล้ว ลบออกจาก Vercel ได้
- `GCHAT_WEBHOOK_URL` (ไม่บังคับ) incoming webhook ของ Space ฝ่ายบัญชีใน Google Chat

## ทดสอบในเครื่อง

```
npm install
npm test
AUTH_SECRET=$(openssl rand -hex 32) HUB_MODE=mock node test/dev-server.mjs 3939
```
