const a = require("./fuel-audit.js");
let fail = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${w}\n     chiqdi:   ${g}`); }
  else console.log(`  ✓ ${what}`);
};

const day = (n, h) => `2026-08-${String(n).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const fill = (n, h, from, to) => ({ at: day(n, h), endAt: day(n, h), from, to, lat: 41.6, lon: -87.1 });
const txn = (unit, n, h, gallons, station) => ({ unit, at: day(n, h), gallons, station });

console.log("=== 1. Bir foizga necha gallon");
eq(Math.round(a.impliedCapacity(100, 80)), 125, "80% ga 100 gal -> 125 gallonli bak");
eq(Math.round(a.impliedCapacity(150, 65)), 231, "65% ga 150 gal -> 231 gallonli bak");
eq(a.impliedCapacity(100, 0), null, "ko'tarilish nolga teng — hisoblanmaydi");

console.log("\n=== 2. Sizning misolingiz: 20->100 da 100 gal, keyin 35->100 da 150 gal");
// Uchta normal quyish o'lchov bo'ladi, to'rtinchisi firibgarlik.
const fills = [
  fill(3, 8, 20, 100),    // 80% -> 100 gal
  fill(6, 9, 30, 100),    // 70% -> 87 gal
  fill(10, 8, 25, 100),   // 75% -> 94 gal
  fill(14, 9, 35, 100),   // 65% -> lekin 150 gal to'langan
];
const txns = [
  txn("1399", 3, 8, 100, "Pilot #442"),
  txn("1399", 6, 9, 87, "Loves #201"),
  txn("1399", 10, 8, 94, "Pilot #77"),
  txn("1399", 14, 9, 150, "TA Gary"),
];
const r = a.auditReport(txns, { 1399: fills });
for (const row of r.rows) {
  console.log(`  ${row.at.slice(5, 10)}  ${String(row.gallons).padStart(4)} gal  bak +${row.rise}%  ` +
              `bak≈${row.impliedGal}gal  [${row.verdict}] ${row.reason}`);
}
eq(r.rows.map((x) => x.verdict), ["ok", "ok", "ok", "suspicious"], "faqat oxirgisi shubhali");
eq(r.rows[3].missingGal, 69, "69 gallon bakka tushmagan");
eq(r.summary.missingGal, 69, "jami yo'qolgan gallon");

console.log("\n=== 3. Umuman bakka tushmagan xarid");
const r2 = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 6, 9, 87), txn("1399", 20, 12, 120, "Shubhali")],
  { 1399: [fill(3, 8, 20, 100), fill(6, 9, 30, 100)] });
eq(r2.rows[2].verdict, "suspicious", "quyish qayd etilmagan — shubhali");
eq(r2.rows[2].missingGal, 120, "butun miqdor hisobga tushmagan");

console.log("\n=== 4. Kvitansiyasiz quyish");
// Hisobot qamragan kunlar ichidagi quyish — ko'rsatiladi
const r3 = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 6, 9, 87)],
  { 1399: [fill(3, 8, 20, 100), fill(6, 9, 30, 100), fill(6, 20, 40, 95)] });
eq(r3.rows[2].verdict, "unpaid", "bak ko'tarilgan, lekin hisobotda xarid yo'q");

// Hisobotdan tashqaridagi kun — ko'rsatilmaydi. Kunlik fayl yuklaganda
// oylab to'plangan quyishlar ro'yxatni bosib ketmasligi uchun.
const outside = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 3, 20, 87)],
  { 1399: [fill(3, 8, 20, 100), fill(3, 20, 30, 100), fill(9, 7, 40, 95)] });
eq(outside.summary.unpaid, 0, "boshqa kundagi quyish ro'yxatga tushmaydi");

console.log("\n=== 5. Xato ayblov chiqmasligi kerak");
// Sensor sal xato: bir xil bak, kichik farqlar — hammasi normal deb qolishi kerak.
const noisy = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 6, 9, 84), txn("1399", 10, 8, 97), txn("1399", 14, 9, 91)],
  { 1399: [fill(3, 8, 20, 100), fill(6, 9, 32, 100), fill(10, 8, 24, 99), fill(14, 9, 28, 98)] });
eq(noisy.summary.suspicious, 0, "sensordagi kichik farqlar ayblanmaydi");

// Kichik quyish — arifmetika ishonchsiz, ayblamaydi lekin belgilaydi
const small = a.auditReport([txn("1399", 3, 8, 12)], { 1399: [fill(3, 8, 90, 95)] });
eq(small.rows[0].verdict, "check", "5% ko'tarilish — o'lchov ishonchsiz deb belgilanadi");

// Tarix yo'q — xulosa chiqarmaydi
const cold = a.auditReport([txn("2000", 3, 8, 100)], { 2000: [fill(3, 8, 20, 100)] });
eq(cold.rows[0].verdict, "unknown", "tarixsiz unit uchun xulosa chiqarilmaydi");

console.log("\n=== 6. Vaqt mosligi");
// Kvitansiya 21:00, bak 22:30 da ko'tarilgan — bu bitta hodisa
const late = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 6, 9, 87), txn("1399", 10, 21, 94)],
  { 1399: [fill(3, 8, 20, 100), fill(6, 9, 30, 100), fill(10, 22, 25, 100)] });
eq(late.rows[2].verdict, "ok", "1.5 soat farq — bir xil hodisa deb qabul qilinadi");

console.log("\n=== 7. Vaqt mintaqasi o'zi aniqlanadi");
// Kvitansiyalar mahalliy vaqtda (UTC-6), quyishlar UTC da yozilgan.
const shift = (iso, h) => new Date(Date.parse(iso) + h * 3600000).toISOString();
const localTxns = [], utcFills = [];
for (let i = 0; i < 14; i++) {
  const d = 3 + i;
  const local = day(d, 8);
  localTxns.push({ unit: "1399", at: local, gallons: 100, station: "Pilot" });
  utcFills.push({ at: shift(local, 6), endAt: shift(local, 6), from: 20, to: 100, lat: 41.6, lon: -87.1 });
}
const off = a.estimateOffsetMs(localTxns, { 1399: utcFills });
eq(off.hours, 6, "6 soatlik farq topildi");
const tzr = a.auditReport(localTxns, { 1399: utcFills });
eq(tzr.summary.suspicious, 0, "vaqt to'g'rilangach hammasi mos keladi");
eq(tzr.summary.tzHours, 6, "hisobotda ham ko'rsatiladi");

// Farq tuzatilmasa, xaridlar quyishga tushmay qoladi va ayblanadi. Birinchisi
// tarix boshlanishidan oldinga tushib qolgani uchun oqlanadi — qolgan 13 tasi
// esa aynan o'sha noto'g'ri ayblov.
const naive = a.auditReport(localTxns, { 1399: utcFills }, { offsetMs: 0 });
eq(naive.summary.suspicious, 13, "tuzatilmasa — deyarli barchasi noto'g'ri ayblanadi");
eq(tzr.summary.suspicious, 0, "tuzatilgach — bittasi ham ayblanmaydi");

console.log("\n=== 8. Kam ma'lumotda taxmin qilmaydi");
const few = a.estimateOffsetMs(localTxns.slice(0, 5), { 1399: utcFills });
eq(few.hours, 0, "5 ta juftlik — xulosa chiqarilmaydi");

console.log("\n=== 9. Tarix yo'qligi ayblov emas");
// Haqiqiy holat: hisobot bor, quyish yozuvlari umuman yo'q.
const noHistory = a.auditReport(
  [txn("1399", 3, 8, 100), txn("1399", 6, 9, 87), txn("2000", 5, 7, 120)], {});
eq(noHistory.summary.suspicious, 0, "yozuvsiz — hech kim ayblanmaydi");
eq(noHistory.summary.unknown, 3, "hammasi 'ma'lumot yo'q' bo'lib qoladi");
eq(noHistory.summary.missingGal, 0, "yo'qolgan gallon deb hisoblanmaydi");
eq(noHistory.rows[0].reason.includes("yozuvlari yo'q"), true, "sabab tushuntiriladi");

// Tarix boshlangandan oldingi xaridlar ham tekshirilmaydi
const partial = a.auditReport(
  [txn("1399", 1, 8, 100), txn("1399", 12, 8, 95)],
  { 1399: [fill(10, 8, 20, 100), fill(12, 8, 24, 99)] });
eq(partial.rows[0].verdict, "unknown", "tarixdan oldingi sana — xulosa yo'q");
eq(partial.rows[0].reason.includes("oldin"), true, "sababi aytiladi");

// Tarix bor va quyish yo'q bo'lsa — o'shanda ayblanadi
const covered = a.auditReport(
  [txn("1399", 10, 8, 100), txn("1399", 11, 8, 87), txn("1399", 12, 8, 120)],
  { 1399: [fill(10, 8, 20, 100), fill(11, 8, 30, 100)] });
eq(covered.rows[2].verdict, "suspicious", "tarix ichida quyish yo'q — shubhali");

console.log("\n=== 10. Kunlik fayl: o'lchov oldingi kunlardan olinadi");
// Bugungi bitta xarid. O'zicha o'lchov yo'q — lekin oldingi kunlar saqlangan.
const today = [txn("1399", 14, 9, 150, "TA Gary")];
const earlier = [txn("1399", 3, 8, 100), txn("1399", 6, 9, 87), txn("1399", 10, 8, 94)];
const fillsAll = [fill(3, 8, 20, 100), fill(6, 9, 30, 100), fill(10, 8, 25, 100), fill(14, 9, 35, 100)];

const alone = a.auditReport(today, { 1399: fillsAll });
eq(alone.rows[0].verdict, "unknown", "tarixsiz — bitta xariddan xulosa chiqmaydi");

const withPrior = a.auditReport(today, { 1399: fillsAll }, { priorTxns: earlier });
eq(withPrior.rows.length, 1, "faqat bugungi qator qaytariladi");
eq(withPrior.rows[0].verdict, "suspicious", "oldingi kunlar o'lchov berdi — firibgarlik ko'rindi");
eq(withPrior.rows[0].missingGal, 69, "69 gallon hisobga tushmagan");
eq(withPrior.rows[0].baselineGal, 125, "o'lchov oldingi quyishlardan");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
