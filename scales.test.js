const S = require("./scales.js");
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

// I-80 ustidagi Wyoming scale (Laramie yaqinida) — sharqqa qarab yurilsa
// trucklar g'arbdan keladi.
const scale = { id: "s1", label: "I-80 Laramie WY scale", lat: 41.31, lon: -105.59 };
// G'arbda, 100 mil narida (Rawlins tomoni), sharqqa qarab ketayotgan truck
const west = (mi, bearing) => ({
  unit: "1030", driver: "Timothy Parks",
  lat: 41.31, lon: -105.59 - mi / 51.8,      // bu kenglikda 1° ≈ 51.8 mil
  bearing, speed: 62, location: "I-80, WY",
});

console.log("=== 1. Masofa va yo'nalish");
near(S.haversineMi(41.31, -105.59, 41.31, -107.59), 103.6, 2, "2° uzunlik ≈ 104 mil");
near(S.bearingDeg(41.31, -107.59, 41.31, -105.59), 89, 2, "sharqqa ≈ 90°");
eq(S.angleGap(350, 10), 20, "burchak farqi aylanadan o'tadi");

console.log("\n=== 2. Bitta truck, bitta scale");
eq(S.look(west(200, 90), scale, null, {}).state, "away", "200 mil — uzoq");
eq(S.look(west(120, 90), scale, null, {}).state, "edge", "120 mil — chegarada (100+40 ichida)");
eq(S.look(west(95, 90), scale, null, {}).state, "coming", "95 mil, sharqqa qarab — kelayapti");
eq(S.look(west(95, 270), scale, null, {}).state, "leaving", "orqasiga qarab ketayapti");
eq(S.look({ ...west(95, 90), speed: 0 }, scale, null, {}).state, "parked", "to'xtab turgan truck");
eq(S.look({ unit: "x" }, scale, null, {}).state, "unknown", "koordinatasi yo'q");

console.log("\n=== 3. Yo'nalish ma'lumoti bo'lmasa — masofa yaqinlashsa");
const noB = { unit: "7503", driver: "A", lat: 41.31, lon: -107.0, speed: 60 };
eq(S.look(noB, scale, null, {}).state, "watch", "birinchi ko'rishda hali bilinmaydi");
eq(S.look({ ...noB, lon: -106.5 }, scale, { mi: 72 }, {}).state, "coming", "oldingi o'lchovdan yaqinroq");
eq(S.look({ ...noB, lon: -107.5 }, scale, { mi: 72 }, {}).state, "leaving", "uzoqlashdi");

console.log("\n=== 4. Butun fleet — bir marta xabar");
const fleet = [west(95, 90), { unit: "5478", driver: "B", lat: 41.31, lon: -103.0, bearing: 90, speed: 65 }];
let r = S.sweep(fleet, [scale], {}, {});
eq(r.hits.map((h) => h.unit), ["1030"], "faqat kelayotgani xabarga tushdi");
near(r.hits[0].mi, 95, 3, "masofa");
S.markSent(r.seen, r.hits);
const r2 = S.sweep([west(70, 90), fleet[1]], [scale], r.seen, {});
eq(r2.hits.length, 0, "yaqinlashsa ham takror xabar yo'q");
eq(r2.seen["1030|s1"].mi < 95, true, "lekin masofa yangilanib turadi");

console.log("\n=== 5. O'tib ketgach qaytadan tayyor bo'ladi");
// Scale dan 150 mil sharqqa o'tib ketdi — yozuv o'chadi
const past = { unit: "1030", driver: "Timothy Parks", lat: 41.31, lon: -105.59 + 150 / 51.8, bearing: 90, speed: 62 };
const r3 = S.sweep([past], [scale], r2.seen, {});
eq(r3.seen["1030|s1"], undefined, "halqadan chiqdi — unutildi");
const r4 = S.sweep([west(90, 90)], [scale], r3.seen, {});
eq(r4.hits.length, 1, "keyingi safar kelganda yana xabar beradi");

console.log("\n=== 6. Har bir scale uchun o'z radiusi");
const tight = { id: "s2", label: "Shahar ichidagi scale", lat: 41.31, lon: -105.59, mi: 25 };
eq(S.look(west(60, 90), tight, null, {}).state, "away", "25 millik halqa — 60 mil uzoq");
eq(S.look(west(20, 90), tight, null, {}).state, "coming", "20 mil — ichida");

console.log("\n=== 7. Xabar scale bo'yicha guruhlanadi");
const two = [
  { ...west(95, 90) },
  { unit: "5949", driver: "C", lat: 41.31, lon: -106.8, bearing: 90, speed: 60 },
  { unit: "6391", driver: "D", lat: 44.0, lon: -105.59, bearing: 180, speed: 60 },
];
const scale2 = { id: "s3", label: "I-25 scale", lat: 43.5, lon: -105.59 };
const g = S.group(S.sweep(two, [scale, scale2], {}, {}).hits);
eq(g.length, 2, "ikki scale — ikki xabar");
eq(g[0].units.map((u) => u.unit), ["5949", "1030"], "yaqinroq truck birinchi");
eq(g[1].units.map((u) => u.unit), ["6391"], "ikkinchi scale o'z unitini oldi");

console.log("\n=== 8. Yuborilmagan xabar yo'qolmaydi");
const r5 = S.sweep([west(95, 90)], [scale], {}, {});
// Telegram qabul qilmadi — markSent chaqirilmaydi
const r6 = S.sweep([west(85, 90)], [scale], r5.seen, {});
eq(r6.hits.length, 1, "keyingi aylanishda yana urinadi");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
