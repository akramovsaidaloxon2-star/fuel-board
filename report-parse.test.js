// Runs the board's own report reader over a real RTS export.
// The fixture is the sheet as SheetJS hands it over in the browser: a 2D array
// of strings, header row included.
const fs = require("fs");
const path = require("path");
const p = require("./report-parse.js");

let fail = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${w}\n     chiqdi:   ${g}`); }
  else console.log(`  ✓ ${what}`);
};

console.log("=== 1. Unit raqamlari");
eq(p.normUnit("0008"), "8", "0008 -> 8");
eq(p.normUnit("010"), "10", "010 -> 10");
eq(p.normUnit("0143"), "143", "0143 -> 143");
eq(p.normUnit("#77"), "77", "#77 -> 77");

console.log("\n=== 2. Sana va vaqt");
eq(p.toISO("2026-08-15", "08:51"), "2026-08-15T08:51:00Z", "ISO ko'rinish");
eq(p.toISO("8/15/2026", "13:05"), "2026-08-15T13:05:00Z", "amerikacha ko'rinish");
eq(p.toISO("2026-08-15", ""), "2026-08-15T12:00:00Z", "vaqtsiz — kun o'rtasi");
eq(p.toISO("salom", "08:51"), null, "sana emas");

console.log("\n=== 3. Yoqilg'i turlari");
eq(p.FUEL_ITEMS.has("ULSD"), true, "ULSD — dizel");
eq(p.FUEL_ITEMS.has("DEFD"), false, "DEFD — alohida bak, hisobga olinmaydi");
eq(p.FUEL_ITEMS.has("SCLE"), false, "SCLE — tarozi, yoqilg'i emas");

const fixture = path.join(__dirname, "test-data", "rts-week.json");
if (!fs.existsSync(fixture)) {
  console.log("\n(haqiqiy fayl namunasi yo'q — o'tkazib yuborildi)");
} else {
  console.log("\n=== 4. Haqiqiy RTS hisoboti");
  const rows = JSON.parse(fs.readFileSync(fixture, "utf8"));
  const col = p.findColumns(rows[0]);
  eq(col.unit, 4, "Unit ustuni topildi");
  eq(col.gallons, 14, "Qty ustuni topildi");
  eq(col.item, 11, "Item ustuni topildi");
  eq(col.date, 1, "Tran Date ustuni topildi");
  eq(col.time, 2, "Tran Time ustuni topildi");

  const r = p.parseSheet(rows);
  console.log(`  ${rows.length - 1} qatordan ${r.txns.length} yoqilg'i xaridi, ${r.skipped} o'tkazildi`);
  eq(r.txns.length, 406, "406 ta dizel xaridi o'qildi");
  eq(r.txns.length + r.skipped, rows.length - 1, "hech bir qator yo'qolmadi");

  // Each line is rounded to a tenth, so 406 of them drift a couple of gallons
  // away from the file's raw total (41027). Worth pinning down: a real parsing
  // fault would move this by hundreds, not by two.
  const gal = Math.round(r.txns.reduce((a, t) => a + t.gallons, 0));
  eq(Math.abs(gal - 41027) <= 5, true, `jami gallon fayl bilan mos (${gal} ≈ 41027)`);

  const badDate = r.txns.filter((t) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t.at));
  eq(badDate.length, 0, "hamma sana o'girildi");
  const padded = r.txns.filter((t) => /^0/.test(t.unit));
  eq(padded.length, 0, "unit raqamlarida boshida nol qolmadi");

  const units = new Set(r.txns.map((t) => t.unit));
  console.log(`  ${units.size} unit · namuna: ${[...units].slice(0, 6).join(", ")}`);
  console.log(`  birinchi qator: ${JSON.stringify(r.txns[0])}`);
}

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
