const w = require("./weather.js");
let fail = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), x = JSON.stringify(want);
  if (g !== x) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${x}\n     chiqdi:   ${g}`); }
  else console.log(`  ✓ ${what}`);
};

// Chicago atrofida to'rtburchak (lon, lat tartibida — GeoJSON shunday)
// Cook (IL) va Lake (IN) ni qamraydi — Gary ham ichida qoladi.
const chicago = {
  type: "Polygon",
  coordinates: [[[-88.2, 41.4], [-87.2, 41.4], [-87.2, 42.1], [-88.2, 42.1], [-88.2, 41.4]]],
};
const inChi = { unit: "1399", driver: "Lee Marling", lat: 41.85, lon: -87.65 };
const inGary = { unit: "7503", driver: "A", lat: 41.60, lon: -87.34 };
const inTexas = { unit: "0008", driver: "B", lat: 31.9, lon: -102.3 };

console.log("=== 1. Nuqta hudud ichidami");
eq(w.pointInGeometry(inChi.lat, inChi.lon, chicago), true, "Chicago ichida");
eq(w.pointInGeometry(inTexas.lat, inTexas.lon, chicago), false, "Texas tashqarida");
eq(w.pointInGeometry(41.4, -88.2, chicago), true, "chekka nuqta ichida hisoblanadi");

console.log("\n=== 2. Teshikli hudud (ko'l ustidagi joy)");
const withHole = {
  type: "Polygon",
  coordinates: [
    [[-88.2, 41.4], [-87.4, 41.4], [-87.4, 42.1], [-88.2, 42.1], [-88.2, 41.4]],
    [[-87.9, 41.7], [-87.7, 41.7], [-87.7, 41.9], [-87.9, 41.9], [-87.9, 41.7]],
  ],
};
eq(w.pointInGeometry(41.8, -87.8, withHole), false, "teshik ichidagi truck hisobga olinmaydi");
eq(w.pointInGeometry(41.5, -87.5, withHole), true, "teshikdan tashqarida — ichida");

console.log("\n=== 3. Qaysi hodisalar yo'lga taalluqli");
eq(w.isRoadEvent("Winter Storm Warning"), true, "qor bo'roni");
eq(w.isRoadEvent("Ice Storm Warning"), true, "muz");
eq(w.isRoadEvent("Hurricane Warning"), true, "to'fon");
eq(w.isRoadEvent("Excessive Heat Warning"), false, "issiqlik — yo'lga taalluqli emas");
eq(w.isRoadEvent("Air Quality Alert"), false, "havo sifati — emas");

console.log("\n=== 4. Jiddiylik darajasi");
eq(w.isSevere({ severity: "Severe", event: "Winter Storm Warning" }), true, "Severe");
eq(w.isSevere({ severity: "Moderate", event: "Ice Storm Warning" }), true, "Warning so'zi bor");
eq(w.isSevere({ severity: "Minor", event: "Winter Weather Advisory" }), false, "advisory — yubormaydi");

console.log("\n=== 5. Ogohlantirishga tushgan unitlar");
const alerts = [
  {
    id: "urn:oid:1.1",
    geometry: chicago,
    properties: {
      event: "Ice Storm Warning", severity: "Severe",
      areaDesc: "Cook, IL; Lake, IN", headline: "Ice Storm Warning until 6 PM",
      ends: "2026-10-11T18:00:00-05:00",
    },
  },
  {
    id: "urn:oid:2.2",
    geometry: chicago,
    properties: { event: "Excessive Heat Warning", severity: "Severe", areaDesc: "Cook, IL" },
  },
  {
    id: "urn:oid:3.3",
    geometry: null,
    properties: {
      event: "High Wind Warning", severity: "Severe", areaDesc: "Permian Basin",
      affectedZones: ["https://api.weather.gov/zones/forecast/TXZ271"],
    },
  },
];
const zoneGeom = {
  TXZ271: { type: "Polygon", coordinates: [[[-103, 31.5], [-101.5, 31.5], [-101.5, 32.3], [-103, 32.3], [-103, 31.5]]] },
};
const m = w.matchAlerts(alerts, [inChi, inGary, inTexas], zoneGeom);
eq(m.length, 2, "ikkita hodisa (issiqlik chiqarib tashlandi)");
eq(m[0].event, "Ice Storm Warning", "birinchisi — muz");
eq(m[0].units.map((u) => u.unit), ["1399", "7503"], "Chicago'dagi ikki unit");
eq(m[1].units.map((u) => u.unit), ["0008"], "zona orqali topilgan Texas uniti");

console.log("\n=== 6. Hech kim tushmasa");
eq(w.matchAlerts(alerts, [inTexas], {}).length, 0, "zona geometriyasisiz va hududda truck yo'q");
eq(w.matchAlerts([], [inChi], {}).length, 0, "ogohlantirish yo'q");

console.log("\n=== 7. Takrorlangan truck bir marta yoziladi");
// Yuqoridagi tizim bir truckni bir necha marta qaytarsa ham ro'yxat toza qolishi kerak
const dup = w.matchAlerts([alerts[0]], [inChi, inChi, inGary, inChi], {});
eq(dup[0].units.map((u) => u.unit), ["1399", "7503"], "har bir unit bir marta");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
