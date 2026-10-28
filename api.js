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
let geocodeQueue = Promise.resolve();
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
  const slot = geocodeQueue.then(async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
  });
  geocodeQueue = slot.catch(() => {});
  await slot;
}

export async function fetchJson(url, { timeout = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { headers: extraHeaders, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (controller.signal.aborted) throw new Error("O serviço demorou demais. Tente novamente.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function searchPlaces(text, label) {
  const q = String(text).trim();
  if (!q) throw new StageError("endereço", `Preencha o campo ${label}.`);
  const direct = parseCoords(q);
  if (direct) return [{ ...direct, name: `${direct.lat.toFixed(5)}, ${direct.lon.toFixed(5)}`, kind: "Coordenadas informadas" }];
  const key = "places:v1:" + q.toLowerCase();
  const cached = memCache.get(key) ?? storageGet(key);
  if (Array.isArray(cached) && cached.length) return cached;
  await throttleNominatim();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&countrycodes=br&accept-language=pt-BR&viewbox=${VIEWBOX}&q=${encodeURIComponent(q)}`;
  let data;
  try { data = await fetchJson(url); }
  catch (e) { throw new StageError("endereço", `Não consegui consultar o endereço de ${label} (${e.message}).`); }
  const places = Array.isArray(data) ? data.filter(p => p.display_name && p.lat != null && p.lon != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lon)) <= 180).map(p => ({
    lat: Number(p.lat), lon: Number(p.lon), name: p.display_name,
    kind: ({ aerodrome: "Aeroporto", mall: "Shopping", hospital: "Hospital", hotel: "Hotel", supermarket: "Supermercado", school: "Escola", restaurant: "Restaurante" })[p.type] ?? "Local encontrado",
  })) : [];
  if (!places.length) throw new StageError("endereço", `Endereço de ${label} não encontrado. Inclua a cidade e o estado ou cole as coordenadas.`);
  memCache.set(key, places);
  storageSet(key, places);
  return places;
}

export async function geocode(text, label) {
  return (await searchPlaces(text, label))[0];
}

export const VEHICLES = {
  car: { label: "De carro", endpoint: "https://router.project-osrm.org", note: "Rota de carro." },
  motorcycle: { label: "De moto", endpoint: "https://router.project-osrm.org", note: "Moto: rota e duração de carro como aproximação. Não considera acessos ou velocidades específicos de motos." },
  bike: { label: "De bicicleta", endpoint: "https://routing.openstreetmap.de/routed-bike", note: "Rota de bicicleta. O tempo varia com o ritmo e as condições do percurso." },
  foot: { label: "A pé", endpoint: "https://routing.openstreetmap.de/routed-foot", note: "Rota a pé. O tempo varia com o ritmo e as condições do percurso." },
};
let routeQueue = Promise.resolve();
let lastRoute = 0;
async function throttleRoute() {
  const slot = routeQueue.then(async () => {
    const wait = lastRoute + 1100 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRoute = Date.now();
  });
  routeQueue = slot.catch(() => {});
  await slot;
}

export async function route(from, to, vehicle = "car") {
  if (!Object.hasOwn(VEHICLES, vehicle)) throw new StageError("rota", "Escolha um meio de transporte válido.");
  await throttleRoute();
  const url = `${VEHICLES[vehicle].endpoint}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  let data;
  try {
    data = await fetchJson(url);
  } catch (e) {
    throw new StageError("rota", `Não consegui traçar a rota (${e.message}).`);
  }
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new StageError("rota", `O serviço de rotas não encontrou caminho entre os pontos (${data.code ?? "erro"}${data.message ? ": " + data.message : ""}).`);
  }
  const r = data.routes[0];
  if (!Array.isArray(r.geometry?.coordinates) || r.geometry.coordinates.length < 2 ||
      !r.geometry.coordinates.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) ||
      !Number.isFinite(r.distance) || r.distance <= 0 || !Number.isFinite(r.duration) || r.duration <= 0) {
    throw new StageError("rota", "A rota veio incompleta ou os pontos são iguais. Escolha endereços diferentes.");
  }
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
    data = await fetchJson(forecastUrl(points));
  } catch (e) {
    throw new StageError("previsão", `Não consegui buscar a previsão do tempo (${e.message}).`);
  }
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length || !list.every((item) => item?.hourly && item?.minutely_15)) {
    throw new StageError("previsão", "A previsão veio incompleta. Tente de novo em instantes.");
  }
  return list;
}
