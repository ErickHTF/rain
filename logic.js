export const CLASSES = {
  seco: { rank: 0, label: "Sem chuva", color: "#4a5262" },
  chuva: { rank: 1, label: "Chuva", color: "#2a78cc" },
  forte: { rank: 2, label: "Chuva forte", color: "#9b2c8f" },
};

const WEATHER_CODES = {
  0: "Céu limpo", 1: "Quase limpo", 2: "Parcialmente nublado", 3: "Nublado",
  45: "Neblina", 48: "Neblina com geada",
  51: "Garoa fraca", 53: "Garoa", 55: "Garoa forte", 56: "Garoa congelante", 57: "Garoa congelante forte",
  61: "Chuva fraca", 63: "Chuva", 65: "Chuva forte", 66: "Chuva congelante", 67: "Chuva congelante forte",
  71: "Neve fraca", 73: "Neve", 75: "Neve forte", 77: "Grãos de neve",
  80: "Pancadas fracas", 81: "Pancadas de chuva", 82: "Pancadas fortes",
  85: "Pancadas de neve", 86: "Pancadas de neve fortes",
  95: "Trovoada", 96: "Trovoada com granizo", 99: "Trovoada com granizo forte",
};

export function describeWeather(code) {
  return WEATHER_CODES[code] ?? "—";
}

export function parseCoords(text) {
  const m = String(text).trim().match(/^\(?\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

export function haversine(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function alongRoute(coords, fracs) {
  const pts = coords.map(([lon, lat]) => ({ lat, lon }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  let j = 1;
  return fracs.map((frac) => {
    const target = total * frac;
    while (j < pts.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const t = Math.min(1, Math.max(0, (target - cum[j - 1]) / seg));
    return {
      lat: pts[j - 1].lat + (pts[j].lat - pts[j - 1].lat) * t,
      lon: pts[j - 1].lon + (pts[j].lon - pts[j - 1].lon) * t,
      frac,
      pathIndex: j,
    };
  });
}

export function samplePoints(coords, count = 10) {
  return { points: alongRoute(coords, Array.from({ length: count + 1 }, (_, k) => k / count)) };
}

function toEpoch(localIso, offsetSec) {
  return Date.parse(localIso + "Z") - offsetSec * 1000;
}

export function indexForecast(raw) {
  const off = raw.utc_offset_seconds ?? 0;
  return {
    raw,
    hourlyT: raw.hourly.time.map((t) => toEpoch(t, off)),
    m15T: raw.minutely_15.time.map((t) => toEpoch(t, off)),
  };
}

export function readAt(fc, epoch) {
  const h = fc.raw.hourly;
  const ht = fc.hourlyT;
  if (epoch < ht[0] || epoch > ht[ht.length - 1]) throw new Error("horário fora do período da previsão");
  let i = Math.min(ht.length - 2, Math.floor((epoch - ht[0]) / 3600000));
  while (i > 0 && ht[i] > epoch) i--;
  while (i < ht.length - 2 && ht[i + 1] <= epoch) i++;
  const f = (epoch - ht[i]) / (ht[i + 1] - ht[i]);
  const p0 = h.precipitation_probability[i] ?? 0;
  const p1 = h.precipitation_probability[i + 1] ?? p0;
  const prob = p0 + (p1 - p0) * f;
  const code = h.weather_code[f < 0.5 ? i : i + 1];

  const mt = fc.m15T;
  let k = Math.floor((epoch - mt[0]) / 900000);
  k = Math.max(0, Math.min(mt.length - 1, k));
  while (k > 0 && mt[k] > epoch) k--;
  while (k < mt.length - 1 && mt[k + 1] <= epoch) k++;
  const mm = fc.raw.minutely_15.precipitation[k] ?? 0;

  return { prob, mm, code, hourIndex: i, hourFrac: f, slotIndex: k, slotTime: fc.raw.minutely_15.time[k] };
}

export function classify(prob, mm) {
  if (mm >= 1.5) return "forte";
  if (mm >= 0.1 || prob >= 50) return "chuva";
  return "seco";
}

const LEVELS = ["seco", "chuva", "forte"];

export function analyzeTrip({ points, forecasts, distance, duration, departure, radarAt }) {
  const legs = points.map((p, idx) => {
    const epoch = departure + p.frac * duration * 1000;
    const r = readAt(forecasts[idx], epoch);
    const modelCls = classify(r.prob, r.mm);
    const rad = radarAt ? radarAt(p.lat, p.lon, epoch) : null;
    return {
      ...p,
      km: (p.frac * distance) / 1000,
      epoch,
      prob: r.prob,
      mm: r.mm,
      code: r.code,
      sky: describeWeather(r.code),
      modelCls,
      cls: rad ? LEVELS[rad.level] : modelCls,
      src: rad ? rad.src : "modelo",
      debug: r,
    };
  });
  return { departure, legs, ...summarize(legs) };
}

function summarize(legs) {
  const worst = legs.reduce((a, l) => (CLASSES[l.cls].rank > CLASSES[a.cls].rank ? l : a), legs[0]);
  const firstWet = legs.find((l) => l.cls !== "seco");
  const score = legs.reduce((s, l) => s + [0, 4, 10][CLASSES[l.cls].rank] + (l.src === "modelo" ? l.prob / 100 + l.mm * 2 : 0), 0);
  return { worst: worst.cls, firstWet, worstLeg: worst, score };
}

const TZ = "America/Sao_Paulo";

export function fmtTime(epoch) {
  return new Date(epoch).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
}

export function localInputValue(epoch) {
  return new Date(epoch).toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T").slice(0, 16);
}

export function parseLocalInput(value) {
  return Date.parse(value + ":00-03:00");
}

export function fmtWhen(epoch, ref = Date.now()) {
  const day = (e) => new Date(e).toLocaleDateString("sv-SE", { timeZone: TZ });
  const d = day(epoch);
  const prefix =
    d === day(ref) ? "hoje" :
    d === day(ref - 864e5) ? "ontem" :
    d === day(ref + 864e5) ? "amanhã" :
    new Date(epoch).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: TZ });
  return `${prefix}, ${fmtTime(epoch)}`;
}

export function fmtKm(km) {
  return km.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function where(frac) {
  if (frac < 0.15) return "logo na saída";
  if (frac < 0.4) return "no começo do caminho";
  if (frac < 0.7) return "no meio do caminho";
  return "perto da chegada";
}

const SOURCE = { observado: "O radar registrou", radar: "O radar mostra", modelo: "A previsão indica" };

export function verdict(trip) {
  const { worst, firstWet, worstLeg, legs } = trip;
  if (worst === "seco") {
    const srcs = new Set(legs.map((l) => l.src));
    const detail =
      srcs.size === 1 && srcs.has("observado") ? "O radar não registrou chuva no caminho nesse horário." :
      srcs.size === 1 && srcs.has("radar") ? "O radar não mostra chuva vindo para o caminho." :
      srcs.has("modelo") && srcs.size > 1 ? "Radar limpo agora e a previsão não indica chuva no resto do trajeto." :
      srcs.has("modelo") ? "A previsão não indica chuva no caminho." :
      "O radar não mostra chuva no caminho.";
    return { title: "Não", detail, cls: "seco" };
  }
  const heavy = worst === "forte";
  const at = heavy ? worstLeg : firstWet;
  const detail = `${SOURCE[at.src]} chuva${heavy ? " forte" : ""} ${where(at.frac)}, lá pelas ${fmtTime(at.epoch)}.`;
  return { title: heavy ? "Sim, forte" : "Sim", detail, cls: worst };
}

export function simulateDepartures({ points, forecasts, distance, duration, now, radarAt, steps = 12, stepMin = 15 }) {
  const trips = [];
  for (let s = 0; s <= steps; s++) {
    trips.push(analyzeTrip({ points, forecasts, distance, duration, radarAt, departure: now + s * stepMin * 60000 }));
  }
  const minRank = Math.min(...trips.map((t) => CLASSES[t.worst].rank));
  const candidates = trips.filter((t) => CLASSES[t.worst].rank === minRank);
  const peak = (t) => ({ prob: Math.max(...t.legs.map((l) => l.prob)), mm: Math.max(...t.legs.map((l) => l.mm)) });
  const peaks = candidates.map(peak);
  const minProb = Math.min(...peaks.map((p) => p.prob));
  const minMm = Math.min(...peaks.map((p) => p.mm));
  const best = minRank === 0 ? candidates[0] : candidates.find((t, i) => peaks[i].prob <= minProb + 10 && peaks[i].mm <= minMm + 0.2);
  return { trips, best };
}
