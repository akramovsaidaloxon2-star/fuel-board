const P = require("./toll-parse.js");
const M = require("./toll-match.js");

let fail = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), x = JSON.stringify(want);
  if (g !== x) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${x}\n     chiqdi:   ${g}`); }
  else console.log(`  ✓ ${what}`);
};
const near = (got, want, tol, what) => {
  if (!(Math.abs(got - want) <= tol)) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${want} ±${tol}\n     chiqdi:   ${got}`); }
  else console.log(`  ✓ ${what}`);
};

// PrePass hisobotining ustunlari — ekrandagi tartibda
const HDR = ["Post Date", "Invoice Date", "Source", "Read Type", "PP Device ID",
  "Toll Device ID or Plate", "Truck ID", "Agency", "Entry Plaza", "Entry Date",
  "Entry Time", "Exit Plaza", "Exit Date", "Exit Time", "Cl", "Mi", "Toll"];
const row = (a) => ["10/13/2026", "10/12/2026", "EZPass", "Transponder", "785028622",
  "01606710921", "N/A", a.agency, a.entry || a.exit, a.eDate || a.date, a.eTime || "",
  a.exit, a.date, a.time, "9", a.mi == null ? "" : a.mi, a.toll == null ? "" : a.toll];

console.log("=== 1. Ustunlarni topish");
const col = P.findColumns(HDR);
eq(col.device, 4, "PP Device ID");
eq(col.unit, 6, "Truck ID");
eq(col.agency, 7, "Agency");
eq(col.exitPlaza, 11, "Exit Plaza");
eq(col.exitDate, 12, "Exit Date");
eq(col.exitTime, 13, "Exit Time");
eq(col.miles, 15, "Mi");
eq(col.toll, 16, "Toll");
// "Entry Date" "Exit Date" dan oldin keladi — bir-birini yeb ketmasligi kerak
eq(col.entryDate, 9, "Entry Date alohida ustun");

console.log("\n=== 2. Sana va vaqt");
eq(P.wallDate("10/11/2026"), "2026-10-11", "10/11/2026");
eq(P.wallDate("2026-10-11"), "2026-10-11", "ISO");
eq(P.wallDate("10/11/26"), "2026-10-11", "ikki raqamli yil");
eq(P.wallDate(46306), "2026-10-11", "Excel raqami");
eq(P.wallTime("14:32"), "14:32:00", "24 soat");
eq(P.wallTime("2:32 PM"), "14:32:00", "PM");
eq(P.wallTime("12:05 AM"), "00:05:00", "yarim kecha");
eq(P.wallTime("12:05 PM"), "12:05:00", "tush");
eq(P.wallTime("14:32:07"), "14:32:07", "sekundlar");
eq(P.wallTime(""), null, "bo'sh");

console.log("\n=== 3. Mahalliy soat → haqiqiy vaqt");
eq(P.zonedToISO("2026-10-11T13:05:00", "America/Chicago"), "2026-10-11T18:05:00.000Z", "Illinois, yozgi vaqt");
eq(P.zonedToISO("2026-01-15T13:05:00", "America/Chicago"), "2026-01-15T19:05:00.000Z", "Illinois, qishda");
eq(P.zonedToISO("2026-10-11T18:30:00", "America/Indiana/Indianapolis"), "2026-10-11T22:30:00.000Z", "Indiana");
eq(P.zonedToISO("2026-10-11T18:30:00", "America/New_York"), "2026-10-11T22:30:00.000Z", "Ohio/Pennsylvania");

console.log("\n=== 4. Agentlik qaysi shtatda");
eq(P.agencyInfo("ILTOLL").states, ["IL"], "ILTOLL");
eq(P.agencyInfo("Chicago Skyway").states, ["IL"], "Chicago Skyway");
eq(P.agencyInfo("ITRCC").states, ["IN"], "ITRCC");
eq(P.agencyInfo("OTC").states, ["OH"], "OTC — Ohio");
eq(P.agencyInfo("PTC").states, ["PA"], "PTC — Pennsylvania");
eq(P.agencyInfo("Ohio Turnpike").states, ["OH"], "to'liq yozilgan nom");
eq(P.agencyInfo("ZZZ"), null, "tanimagan agentlik");

console.log("\n=== 5. Hisobotni o'qish");
const sheet = [
  ["PrePass Toll Report"], [], HDR,
  row({ agency: "ILTOLL", exit: "Elgin", date: "10/11/2026", time: "1:05 PM", mi: 12, toll: "$18.40" }),
  row({ agency: "ILTOLL", exit: "River Road", date: "10/11/2026", time: "2:35 PM", mi: 8, toll: "$9.10" }),
  row({ agency: "CHICAGO SKYWAY", exit: "Skyway Plaza", date: "10/11/2026", time: "4:00 PM", toll: "$7.50" }),
  row({ agency: "ITRCC", exit: "Portage", date: "10/11/2026", time: "6:30 PM", mi: 24, toll: "$11.00" }),
];
const got = P.parseSheet(sheet);
eq(got.reason, "", "ustunlar topildi");
eq(got.tolls.length, 4, "to'rt qator");
eq(got.skipped, 0, "tashlab ketilgani yo'q");
eq(got.tolls[0].unit, "", "Truck ID = N/A → bo'sh");
eq(got.tolls[0].device, "785028622", "transponder raqami");
eq(got.tolls[0].at, "2026-10-11T18:05:00.000Z", "ILTOLL 13:05 → 18:05Z");
eq(got.tolls[3].at, "2026-10-11T22:30:00.000Z", "ITRCC 18:30 → 22:30Z");
eq(got.tolls[0].toll, 18.4, "$18.40");
eq(got.tolls[0].exact, true, "vaqt aniq");
eq(got.devices.length, 1, "bitta transponder");
eq(got.devices[0].rows, 4, "to'rtta o'tish");
eq(got.devices[0].assigned, [], "hech qaysi unitga biriktirilmagan");

console.log("\n=== 6. Vaqtdagi joylashuv");
const pts = [
  { at: "2026-10-11T18:00:00Z", lat: 42.04, lon: -88.30, description: "2 mi W of Elgin, IL" },
  { at: "2026-10-11T20:00:00Z", lat: 41.90, lon: -87.90, description: "Chicago, IL" },
];
const mid = M.posAt(pts, "2026-10-11T19:00:00Z");
near(mid.lat, 41.97, 0.01, "oraliq nuqta — lat");
near(mid.lon, -88.10, 0.01, "oraliq nuqta — lon");
eq(mid.gapMin, 60, "eng yaqin o'lchovgacha 60 daqiqa");
eq(M.posAt(pts, "2026-10-12T06:00:00Z").bracketed, false, "oxirgi nuqtadan keyin — taxmin");
eq(M.posAt([], "2026-10-11T19:00:00Z"), null, "tarix yo'q");
eq(M.stateOf({ description: "7 mi NE of Gary, IN" }), "IN", "tavsifdan shtat");
eq(M.stateOf({ description: "Chicago, IL 60601" }), "IL", "indeks bilan");
eq(M.stateOf({ state: "OH" }), "OH", "to'g'ridan-to'g'ri");
eq(M.stateOf({ description: "unknown" }), "", "shtat yo'q");

console.log("\n=== 7. Bitta o'tish — kim yaqin");
// 1030: I-90 bo'ylab Elgin → Chicago → Skyway → Portage
const tracks = {
  1030: {
    driver: "Olim Karimov",
    points: [
      { at: "2026-10-11T18:00:00Z", lat: 42.04, lon: -88.30, description: "2 mi W of Elgin, IL" },
      { at: "2026-10-11T19:30:00Z", lat: 41.90, lon: -87.90, description: "Chicago, IL" },
      { at: "2026-10-11T21:00:00Z", lat: 41.72, lon: -87.55, description: "Chicago, IL" },
      { at: "2026-10-11T22:30:00Z", lat: 41.58, lon: -87.18, description: "Portage, IN" },
    ],
  },
  // 1399 bir marta Illinoysda bo'lgan, keyin Viskonsinga ketgan — bitta
  // o'tishda tushib qoladi, qolganida yo'q.
  1399: {
    driver: "Lee Marling",
    points: [
      { at: "2026-10-11T18:00:00Z", lat: 41.95, lon: -88.00, description: "Aurora, IL" },
      { at: "2026-10-11T21:00:00Z", lat: 43.00, lon: -89.40, description: "Madison, WI" },
      { at: "2026-10-11T23:00:00Z", lat: 43.05, lon: -89.50, description: "Madison, WI" },
    ],
  },
  7503: {
    driver: "B Driver",
    points: [
      { at: "2026-10-11T18:00:00Z", lat: 31.90, lon: -102.30, description: "Midland, TX" },
      { at: "2026-10-11T23:00:00Z", lat: 32.40, lon: -101.40, description: "Big Spring, TX" },
    ],
  },
};
const plazas = { "ILTOLL|ELGIN": { lat: 42.04, lon: -88.30 }, "ITRCC|PORTAGE": { lat: 41.58, lon: -87.18 } };

const r1 = M.matchRow(got.tolls[0], tracks, plazas);
eq(r1.unit, "1030", "Elgin plaza — 1030 eng yaqin");
eq(r1.plazaKnown, true, "plaza koordinatasi bor");
eq(r1.candidates.map((c) => c.unit), ["1030", "1399"], "Texasdagi truck ro'yxatda yo'q");
// 13:05 — ikki o'lchov orasida, shuning uchun nuqta plazadan bir chaqirim
// nariga suriladi; shu ham mos deb hisoblanishi kerak.
near(r1.candidates[0].mi, 0, 2, "plazadan masofa");

const r4 = M.matchRow(got.tolls[3], tracks, plazas);
eq(r4.unit, "1030", "Portage — 1030");
eq(r4.decided, true, "boshqa da'vogar yo'q");
eq(r4.candidates.length, 1, "bitta nomzod");

// Plaza koordinatasi bo'lmasa — shtat bo'yicha
const noPlaza = M.matchRow(got.tolls[2], tracks, {});
eq(noPlaza.candidates.map((c) => c.unit), ["1030"], "Skyway vaqtida Illinoysda faqat 1030 bor");

console.log("\n=== 8. Butun hisobot — qaysi truckda transponder");
const all = M.matchDevices(got.tolls, tracks, {});
eq(all.devices.length, 1, "bitta qurilma");
const d = all.devices[0];
eq(d.unit, "1030", "transponder 1030 da");
eq(d.driver, "Olim Karimov", "driver");
eq(d.verdict, "ishonchli", "ishonch darajasi");
eq(d.hit, 4, "to'rt o'tishning to'rttasi mos");
eq(d.rate, 100, "100%");
eq(d.candidates[0].unit, "1030", "birinchi nomzod");
const rival = d.candidates.find((c) => c.unit === "1399");
eq(rival ? rival.hit : 0, 1, "1399 faqat bitta o'tishga tushadi");
eq(rival ? rival.miss : 0, 3, "qolgan uchtasida boshqa joyda bo'lgan");
eq(all.rows.length, 4, "har bir qatorga javob");

console.log("\n=== 9. Dalil yetmasa — javob bermaydi");
const thin = M.matchDevices(got.tolls.slice(0, 2), tracks, {});
eq(thin.devices[0].verdict, "ma'lumot kam", "ikki o'tish — kam");
eq(thin.devices[0].unit, "", "taxmin aytilmaydi");
const blind = M.matchDevices(got.tolls, { 7503: tracks[7503] }, {});
eq(blind.devices[0].verdict, "topilmadi", "hech qaysi truck mos emas");
eq(blind.devices[0].unit, "", "unit yozilmaydi");
// Motive tarixi o'sha kunni qamramasa — o'tish hisobga olinmaydi
const empty = M.matchDevices(got.tolls, { 1030: { driver: "X", points: [] } }, {});
eq(empty.devices[0].usable, 0, "foydali o'tish yo'q");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
