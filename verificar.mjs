import { geocode, route, forecast, forecastUrl, setHeaders } from "./api.js";
import { samplePoints, indexForecast, simulateDepartures, analyzeTrip, verdict, fmtTime, fmtKm, CLASSES } from "./logic.js";

setHeaders({ "User-Agent": "ChuvaNoCaminho/1.0 (teste local)" });

const ORIGEM = process.argv[2] ?? "Polo Shopping Indaiatuba, Indaiatuba, SP";
const DESTINO = process.argv[3] ?? "Avenida José Maria Marques de Oliveira, Salto, SP";

const from = await geocode(ORIGEM, "origem");
const to = await geocode(DESTINO, "destino");
console.log("Origem :", from.name, `(${from.lat}, ${from.lon})`);
console.log("Destino:", to.name, `(${to.lat}, ${to.lon})`);

const r = await route(from, to);
console.log(`Rota   : ${(r.distance / 1000).toFixed(1)} km, ${(r.duration / 60).toFixed(1)} min, ${r.coords.length} vértices`);

const { points } = samplePoints(r.coords, 10);
const raw = await forecast(points);
const fcs = raw.map(indexForecast);
console.log("Open-Meteo:", forecastUrl(points));

const now = process.argv[4] ? Date.parse(process.argv[4] + ":00-03:00") : Date.now();
const trip = analyzeTrip({ points, forecasts: fcs, distance: r.distance, duration: r.duration, departure: now });
const v = verdict(trip);
console.log(`\nSaindo ${process.argv[4] ? "em " + process.argv[4] : "agora"} (${fmtTime(now)}): ${v.title.toUpperCase()}\n  ${v.detail}\n`);

const localParts = (epoch) => {
  const s = new Date(epoch).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace(" ", "T");
  return s.slice(0, 16);
};

let mismatches = 0;
console.log("km    hora   chance  mm/15  céu                  classe   | conferência crua");
trip.legs.forEach((l, i) => {
  const R = raw[i];
  const loc = localParts(l.epoch);
  const hourStr = loc.slice(0, 13) + ":00";
  const hi = R.hourly.time.indexOf(hourStr);
  const minutes = Number(loc.slice(14, 16)) + (l.epoch % 60000) / 60000;
  const p0 = R.hourly.precipitation_probability[hi];
  const p1 = R.hourly.precipitation_probability[hi + 1];
  const probCheck = p0 + (p1 - p0) * (minutes / 60);
  const slotMin = String(Math.floor(Number(loc.slice(14, 16)) / 15) * 15).padStart(2, "0");
  const slotStr = loc.slice(0, 14) + slotMin;
  const si = R.minutely_15.time.indexOf(slotStr);
  const mmCheck = R.minutely_15.precipitation[si];
  const ok = Math.abs(probCheck - l.prob) < 0.6 && Math.abs(mmCheck - l.mm) < 1e-9;
  if (!ok) mismatches++;
  console.log(
    `${fmtKm(l.km).padStart(4)}  ${fmtTime(l.epoch)}  ${l.prob.toFixed(0).padStart(4)}%  ${l.mm.toFixed(2).padStart(5)}  ${l.sky.padEnd(20)} ${CLASSES[l.cls].label.padEnd(8)} | ` +
      `${hourStr.slice(11)}=${p0}% ${R.hourly.time[hi + 1]?.slice(11)}=${p1}% → ${probCheck.toFixed(1)}%; slot ${slotStr.slice(11)}=${mmCheck}mm ${ok ? "OK" : "DIVERGE"}`
  );
});
console.log(`\nConferência: ${mismatches === 0 ? "todos os trechos batem com a resposta crua" : mismatches + " trecho(s) divergem"}`);

const sim = simulateDepartures({ points, forecasts: fcs, distance: r.distance, duration: r.duration, now });
console.log("\nSaídas simuladas:");
for (const t of sim.trips) {
  const vv = verdict(t);
  console.log(`  ${fmtTime(t.departure)}  ${CLASSES[t.worst].label.padEnd(11)} score ${t.score.toFixed(2).padStart(6)}  ${vv.title}${t === sim.best ? "  ← melhor" : ""}`);
}
