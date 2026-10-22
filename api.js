import { parseCoords } from "./logic.js";

export class StageError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}

const VIEWBOX = "-47.45,-22.98,-47.10,-23.30";
const memCache = new Map();
let lastNominatim = 0;
let extraHeaders = {};

export function setHeaders(h) {
  extraHeaders = h;
}

function storageGet(key) {
  try {
    const v = globalThis.localStorage?.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {}
}

async function throttleNominatim() {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
}

export async function geocode(text, label) {
  const q = String(text).trim();
  if (!q) throw new StageError("endereço", `Preencha o campo ${label}.`);
  const direct = parseCoords(q);
  if (direct) return { ...direct, name: `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}` };

  const key = "geo:" + q.toLowerCase();
  const cached = memCache.get(key) ?? storageGet(key);
  if (cached) return cached;

  await throttleNominatim();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&accept-language=pt-BR&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`;
  let data;
  try {
    const res = await fetch(url, { headers: extraHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    throw new StageError("endereço", `Não consegui consultar o endereço de ${label} (${e.message}).`);
  }
  if (!data.length) throw new StageError("endereço", `Endereço de ${label} não encontrado: "${q}". Tente ser mais específico ou cole as coordenadas do Google Maps.`);
  const r = { lat: Number(data[0].lat), lon: Number(data[0].lon), name: data[0].display_name };
  memCache.set(key, r);
  storageSet(key, r);
  return r;
}

export async function route(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  let data;
  try {
    const res = await fetch(url, { headers: extraHeaders });
    data = await res.json();
  } catch (e) {
    throw new StageError("rota", `Não consegui traçar a rota (${e.message}).`);
  }
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new StageError("rota", `O serviço de rotas não encontrou caminho entre os pontos (${data.code ?? "erro"}${data.message ? ": " + data.message : ""}).`);
  }
  const r = data.routes[0];
  return { coords: r.geometry.coordinates, distance: r.distance, duration: r.duration };
}

export function forecastUrl(points) {
  const lat = points.map((p) => p.lat.toFixed(4)).join(",");
  const lon = points.map((p) => p.lon.toFixed(4)).join(",");
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation_probability,precipitation,weather_code&minutely_15=precipitation&timezone=America%2FSao_Paulo&past_days=2&forecast_days=3`;
}

export async function forecast(points) {
  let data;
  try {
    const res = await fetch(forecastUrl(points), { headers: extraHeaders });
    data = await res.json();
    if (!res.ok) throw new Error(data?.reason ?? `HTTP ${res.status}`);
  } catch (e) {
    throw new StageError("previsão", `Não consegui buscar a previsão do tempo (${e.message}).`);
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length || !list[0].hourly || !list[0].minutely_15) {
    throw new StageError("previsão", "A previsão veio incompleta. Tente de novo em instantes.");
  }
  return list;
}
