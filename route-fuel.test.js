const R = require("./route-fuel.js");
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

// I-40 sharqqa: Albuquerque → Santa Rosa → Tucumcari → Amarillo.
// Yo'l shaharlardan o'tadi, ya'ni ulardagi stansiyalar yo'l ustida.
const ABQ = [-106.65, 35.08], SR = [-104.68, 34.94], TUC = [-103.72, 35.17], AMA = [-101.83, 35.19];
function line(a, b, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  return out;
}
const coords = [...line(ABQ, SR, 60), ...line(SR, TUC, 30).slice(1), ...line(TUC, AMA, 60).slice(1)];

console.log("=== 1. Yo'l chizig'i");
const route = R.buildRoute(coords);
// Uch to'g'ri bo'lakning yig'indisi — chiziq aynan shulardan qurilgan.
const legs = R.haversineMi(ABQ[1], ABQ[0], SR[1], SR[0]) + R.haversineMi(SR[1], SR[0], TUC[1], TUC[0]) + R.haversineMi(TUC[1], TUC[0], AMA[1], AMA[0]);
near(route.miles, legs, 0.5, `Albuquerque → Amarillo ≈ ${Math.round(legs)} mil`);
eq(route.pts[0].along, 0, "boshi 0 mil");
near(route.pts[route.pts.length - 1].along, route.miles, 0.01, "oxiri — butun yo'l");

console.log("\n=== 2. Nuqta yo'lning qayerida");
const tuc = R.locate(route, 35.17, -103.72);
near(tuc.along, 172, 5, "Tucumcari ≈ 172-milda");
near(tuc.off, 0, 0.2, "Tucumcari yo'l ustida");
const clovis = R.locate(route, 34.40, -103.20);
eq(clovis.off > 30, true, "Clovis yo'ldan 30+ mil chetda");

// Stansiyalar: tayinlangani Tucumcari $5.90
const here = { num: "100", lat: 35.17, lon: -103.72, ppg: 5.90, city: "Tucumcari", st: "NM" };
const stations = [
  here,
  { num: "201", lat: 34.94, lon: -104.68, ppg: 5.60, city: "Santa Rosa", st: "NM" },   // oldin, arzon
  { num: "202", lat: 35.19, lon: -101.83, ppg: 5.40, city: "Amarillo", st: "TX" },     // keyin, eng arzon
  { num: "203", lat: 34.40, lon: -103.20, ppg: 5.00, city: "Clovis", st: "NM" },       // yo'ldan chetda
  { num: "204", lat: 35.10, lon: -105.50, ppg: 5.85, city: "Clines Corners", st: "NM" }, // farq 5¢ — kam
];

console.log("\n=== 3. Yo'ldagi arzonroq stansiyalar");
const r1 = R.cheaperOnRoute(route, stations, here, {});
eq(r1.before && r1.before.num, "201", "oldin: Santa Rosa $5.60");
eq(r1.after && r1.after.num, "202", "keyin: Amarillo $5.40");
eq(r1.offRoute, false, "tayinlangan stop yo'l ustida");
near(r1.here.along, 172, 5, "tayinlangani 172-milda");

console.log("\n=== 4. Bak yetmasa — hisobga olinmaydi");
const r2 = R.cheaperOnRoute(route, stations, here, { range: 200 });
eq(r2.after, null, "Amarillo 282-milda, bak 200 milga yetadi — chiqarildi");
eq(r2.before && r2.before.num, "201", "Santa Rosa yetadigan masofada");

console.log("\n=== 5. Yo'ldan chetdagisi va farqi kichigi kirmaydi");
const nums = [r1.before, r1.after].filter(Boolean).map((x) => x.num);
eq(nums.includes("203"), false, "Clovis ($5.00) yo'lda emas — kirmadi");
eq(nums.includes("204"), false, "5¢ farq — e'tiborga arzimaydi");

console.log("\n=== 6. Truck yo'ldan chetga yuborilgan bo'lsa");
const offStop = { num: "300", lat: 34.40, lon: -103.20, ppg: 6.10, city: "Clovis", st: "NM" };
const r3 = R.cheaperOnRoute(route, [...stations, offStop], offStop, {});
eq(r3.offRoute, true, "tayinlangan stop yo'ldan chetda deb belgilandi");

console.log("\n=== 7. ZIP");
eq(R.ZIP_RE.test("79101"), true, "79101");
eq(R.ZIP_RE.test("7910"), false, "4 raqam — yo'q");
eq(R.ZIP_RE.test("79101-1234"), false, "ZIP+4 — faqat 5 raqam");
eq(R.cheaperOnRoute(null, stations, here, {}), null, "yo'l yo'q — javob yo'q");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
