// Exercises the fill recorder inside server.js without starting the server.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const dir = "/workspace/fuel-board";
process.chdir(dir);
for (const f of ["fuel_events.json"]) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
fs.writeFileSync(path.join(dir, "fuel_series.json"), "{}");

const src = fs.readFileSync(path.join(dir, "server.js"), "utf8")
  .replace(/const server = http\.createServer[\s\S]*$/, "module.exports = { recordFuelPoint };");
const mod = new Module(path.join(dir, "server.js"));
mod.filename = path.join(dir, "server.js");
mod.paths = Module._nodeModulePaths(dir);
mod._compile(src, mod.filename);
const { recordFuelPoint } = mod.exports;

const T = Date.parse("2026-08-20T10:00:00Z");
const at = (min) => new Date(T + min * 60000).toISOString();
const gary = { lat: 41.6022, lon: -87.1459 };
const ohio = { lat: 39.9321, lon: -83.6025 };

// Haqiqiy ma'lumotdan olingan chayqalish: darajа pastga-tepaga o'ynaydi
recordFuelPoint("5478", 36, at(0), gary);
recordFuelPoint("5478", 39.2, at(4), gary);
recordFuelPoint("5478", 34.8, at(8), gary);
recordFuelPoint("5478", 39.2, at(12), gary);   // hech qanday quyish yo'q
recordFuelPoint("5478", 35.5, at(20), gary);

recordFuelPoint("1399", 64, at(0), gary);      // yurish
recordFuelPoint("1399", 61, at(30), gary);     // asta kamayadi
recordFuelPoint("1399", 70, at(60), gary);     // quyish boshlandi
recordFuelPoint("1399", 84, at(63), gary);     // o'sha quyish davomi
recordFuelPoint("1399", 95, at(66), gary);     // o'sha quyish tugadi
recordFuelPoint("1399", 92, at(180), gary);    // yana yurish
recordFuelPoint("1399", 40, at(900), ohio);    // ertasi kuni
recordFuelPoint("1399", 88, at(960), ohio);    // boshqa joyda quyish

setTimeout(() => {
  const all = JSON.parse(fs.readFileSync(path.join(dir, "fuel_events.json"), "utf8"));
  const slosh = all["5478"] || [];
  console.log("  chayqalish yozuvlari:", slosh.length, "(kutilgan 0)");
  const ev = all["1399"] || [];
  console.log("  hodisalar:", ev.length, "(kutilgan 2 — bitta quyish bitta yozuv)");
  for (const e of ev) {
    console.log(`  ${e.at.slice(5, 16)} → ${e.endAt.slice(11, 16)}  ${e.from}% → ${e.to}%  (+${e.pct}%)  ${e.lat}, ${e.lon}`);
  }
  const ok = slosh.length === 0 && ev.length === 2 && ev[0].to === 95 && ev[1].to === 88
    && ev[0].from === 61 && ev[1].from === 40;
  console.log(ok ? "  ✓ to'g'ri" : "  ✗ noto'g'ri");
  fs.writeFileSync(path.join(dir, "fuel_series.json"), "{}");
  try { fs.unlinkSync(path.join(dir, "fuel_events.json")); } catch {}
  process.exit(ok ? 0 : 1);
}, 3600);
