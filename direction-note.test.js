const d = require("./direction-note.js");
let fail = 0;
const eq = (got, want, what) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { fail++; console.log(`  ✗ ${what}\n     kutilgan: ${w}\n     chiqdi:   ${g}`); }
  else console.log(`  ✓ ${what}`);
};

console.log("=== 1. Linkdan nuqtalar");
eq(d.parseMapsPoints("https://www.google.com/maps/dir/43.6591,-70.2568/35.4676,-97.5164/@40.1,-85.2,5z/data=!4m2!4m1"),
   [{lat:43.6591,lon:-70.2568},{lat:35.4676,lon:-97.5164}], "/dir/ koordinatalar (@ va data= tashlanadi)");
eq(d.parseMapsPoints("https://www.google.com/maps/dir/21+Rigby+Road,+Scarborough,+ME+04074/Oklahoma+City,+OK"),
   [{place:"21 Rigby Road, Scarborough, ME 04074"},{place:"Oklahoma City, OK"}], "/dir/ manzil nomlari");
eq(d.parseMapsPoints("https://www.google.com/maps/dir/?api=1&origin=43.65,-70.25&destination=Dallas,TX&waypoints=39.9,-83.6|41.1,-85.2"),
   [{lat:43.65,lon:-70.25},{lat:39.9,lon:-83.6},{lat:41.1,lon:-85.2},{place:"Dallas,TX"}], "?api=1 origin/waypoints/destination");
eq(d.parseMapsPoints("https://www.google.com/maps/place/Loves+Travel+Stop/@35.4676,-97.5164,15z"),
   [{place:"Loves Travel Stop"}], "/place/ bitta nuqta");
eq(d.parseMapsPoints("shu link emas"), [], "noto'g'ri link — bo'sh");

console.log("\n=== 2. Belgidagi yo'nalishni o'qish");
eq(d.cardinalFromSign("I 81 South, Wilkes-Barre"), "South", "to'liq so'z: South");
eq(d.cardinalFromSign("I-84 E; Hartford"), "East", "qisqa harf: E");
eq(d.cardinalFromSign("Wilkes-Barre"), "", "faqat shahar nomi — yo'nalish yo'q");
eq(d.cardinalFromSign(""), "", "bo'sh");

console.log("\n=== 3. Yo'nalish qatorlari");
// lon/lat juftlari: yo'l bo'ylab haqiqiy harakat yo'nalishini beradi
const P = (lon, lat) => [lon, lat];
const S = (ref, brg, type, exits, dest, loc) =>
  ({ ref, name: ref, exits, destinations: dest, maneuver: { type, bearing_after: brg, location: loc } });

const steps = [
  S("I 95", 180, "depart", null, null, P(-70.25, 43.65)),
  S("", 175, "off ramp", "89", null, P(-71.0, 42.4)),
  S("I 495", 180, "merge", null, null, P(-71.05, 42.35)),   // janubga tushadi
  S("", 200, "off ramp", "65B", null, P(-71.1, 41.6)),
  S("I 290", 270, "merge", null, null, P(-71.15, 41.58)),   // g'arbga buriladi
  S("", 265, "off ramp", "12A", null, P(-71.85, 41.55)),
  S("I 90", 270, "merge", null, null, P(-71.9, 41.55)),
  S("I 90", 270, "arrive", null, null, P(-73.5, 41.5)),
];
eq(d.directionLines(steps),
   ["I 95 South > Exit 89 > I 495 South",
    "I 495 South > Exit 65B > I 290 West",
    "I 290 West > Exit 12A > I 90 West"], "exit raqamli interchange'lar");

console.log("\n=== 4. Xato holat: I-81 South, estakada g'arbga buriladi");
// Google: "Use the left 2 lanes to merge onto I-81 S toward Wilkes-Barre"
// Estakadaning burchagi ~260° (g'arb), lekin belgida South yozilgan.
const wilkes = [
  S("I 84", 250, "depart", null, null, P(-74.5, 41.4)),
  S("", 260, "off ramp", null, "I 81 South, Wilkes-Barre", P(-75.6, 41.35)),
  S("I 81", 262, "merge", null, null, P(-75.65, 41.34)),
  // I-81 janubga tushadi: keyingi nuqta ancha pastda
  S("I 81", 190, "arrive", null, null, P(-76.0, 40.6)),
];
eq(d.directionLines(wilkes), ["I 84 West > I 81 South"], "belgidagi South burchakdan ustun turadi");

// Belgi bo'lmasa — yo'l bo'ylab umumiy harakatga qarab
const noSign = [
  S("I 84", 250, "depart", null, null, P(-74.5, 41.4)),
  S("", 260, "off ramp", null, null, P(-75.6, 41.35)),
  S("I 81", 262, "merge", null, null, P(-75.65, 41.34)),
  S("I 81", 190, "arrive", null, null, P(-76.0, 40.6)),
];
eq(d.directionLines(noSign), ["I 84 West > I 81 South"], "belgisiz — 100 mil janubga yurish South deb o'qiladi");

console.log("\n=== 5. Chekka holatlar");
eq(d.directionLines([S("I 44", 270, "depart", null, null, P(-97, 35)), S("", 265, "fork", null, null, P(-97.5, 35)), S("I 35", 180, "merge", null, null, P(-97.5, 34.9)), S("I 35", 180, "arrive", null, null, P(-97.5, 34))]),
   ["I 44 West > I 35 South"], "raqamsiz ayrilish — ikkala yo'l nomi qoladi");
eq(d.directionLines([S("I 80", 270, "depart", null, null, P(-80, 41)), S("", 265, "off ramp", "3", null, P(-80.5, 41)), S("Main Street", 270, "merge", null, null, P(-80.6, 41))]),
   [], "nomsiz ko'chaga chiqish — yozilmaydi");
eq(d.directionLines([]), [], "bo'sh qadamlar");

console.log("\n=== 6. Tayyor xabar");
const note = d.buildNote({ lines: d.directionLines(steps), dhMiles: 96.71, routeMiles: 3127.4, dispatchedMiles: 3082 });
console.log(note.split("\n").map(l => "   | " + l).join("\n"));
if (!/DH: 96\.71/.test(note) || !/Loaded miles with direction: 3127/.test(note)) { fail++; console.log("  ✗ millar noto'g'ri"); }
else console.log("  ✓ millar joyida");


console.log("\n=== 7. Google matnidan (haqiqiy nusxa)");
const google = `Get on I-90 W from Brookline Ave and Commonwealth Ave
6 min (0.8 mi)


Follow I-90 W and I-84 to I-81 S in Wilkes-Barre Township
4 hr 41 min (303 mi)

Merge onto I-90 W
 Toll road

53.8 mi

Use the right 2 lanes to take exit 78 for I-84 toward Hartford Connecticut/N.Y.City
 Toll road

0.7 mi

Continue onto I-84
 Toll road
 Entering Connecticut

40.9 mi

Keep right to stay on I-84, follow signs for I-91 N/Hartford

1.2 mi

Keep right to stay on I-84

13.8 mi

Keep left to stay on I-84, follow signs for Waterbury

17.1 mi

Keep right to stay on I-84

28.6 mi

Keep right to stay on I-84, follow signs for Newburgh
 Passing through New York
 Entering Pennsylvania

125 mi

Keep right to stay on I-84

0.7 mi

Merge onto I-380 N/I-84

3.3 mi

Use the left 2 lanes to merge onto I-81 S toward Wilkes-Barre

18.5 mi
4 hr 47 min (304 mi)
65 Northampton Ct
Wilkes-Barre Township, PA 18702, USA


Follow I-81 S to State Rd 934 S in Fort Indiantown Gap. Take exit 85 from I-81 S
1 hr 15 min (83.5 mi)


Take PA-934 S, PA-241 S/Mt Wilson Rd, Meadow View Rd and Milton Grove Rd to New Haven St in Mount Joy`;

const g = d.parseGoogleText(google);
console.log(g.lines.map(l => "   | " + l).join("\n"));
console.log("   | jami:", g.miles, "mi");
eq(g.lines, [
  "I 90 West > Exit 78 > I 84",
  "I 84 > I 380 North",
  "I 380 North > I 81 South",
  "I 81 South > Exit 85 > PA 934 South",
], "Google matni aynan o'giriladi");
eq(g.miles, 304, "qadamlardagi millar yig'indisi");

console.log("\n=== 8. Yo'l nomini o'qish");
eq(d.readRoad("I-90 W"), { ref: "I 90", dir: "West" }, "I-90 W");
eq(d.readRoad("PA-934 S"), { ref: "PA 934", dir: "South" }, "PA-934 S");
eq(d.readRoad("I-81 South, Wilkes-Barre"), { ref: "I 81", dir: "South" }, "to'liq so'z bilan");
eq(d.readRoad("State Rd 934 S"), { ref: "SR 934", dir: "South" }, "State Rd -> SR");
eq(d.readRoad("Brookline Ave"), null, "oddiy ko'cha — yo'l emas");

console.log(fail ? `\n${fail} ta xato` : "\nHammasi o'tdi");
process.exit(fail ? 1 : 0);
