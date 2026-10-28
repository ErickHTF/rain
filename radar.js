import { fetchJson } from "./api.js";

const API = "https://api.rainviewer.com/public/weather-maps.json";
const Z = 7;
const SIZE = 256;
const WORLD = SIZE * 2 ** Z;
const PAD = 100;
const MAX_SHIFT = 20;
export const HORIZON_MIN = 50;

export function toPx(lat, lon) {
  const r = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * WORLD,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * WORLD,
  };
}

export function pixelLevel(r, g, b, a) {
  if (a < 200) return 0;
  if (b > r + 40) return 1;
  return 2;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => {
      img.onload = img.onerror = null;
      img.src = "";
      reject(new Error("tempo esgotado ao carregar o radar"));
    }, 12000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("tile do radar não carregou")); };
    img.src = url;
  });
}

async function loadGrid(host, path, tiles, box) {
  const canvas = document.createElement("canvas");
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imgs = await Promise.all(tiles.map((t) => loadImage(`${host}${path}/${SIZE}/${Z}/${t.x}/${t.y}/2/0_0.png`)));
  imgs.forEach((img, i) => ctx.drawImage(img, tiles[i].x * SIZE - box.x0, tiles[i].y * SIZE - box.y0));
  const { data } = ctx.getImageData(0, 0, box.w, box.h);
  const grid = new Uint8Array(box.w * box.h);
  for (let i = 0; i < grid.length; i++) grid[i] = pixelLevel(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
  return grid;
}

export function estimateMotion(prev, cur, w, h, dtMin) {
  let rain = [];
  for (let i = 0; i < cur.length; i++) if (cur[i]) rain.push(i);
  let prevCount = 0;
  for (let i = 0; i < prev.length; i++) if (prev[i]) prevCount++;
  if (rain.length < 25 || prevCount < 25) return { vx: 0, vy: 0, ok: false };
  if (rain.length > 4000) {
    const step = Math.ceil(rain.length / 4000);
    rain = rain.filter((_, i) => i % step === 0);
    prevCount = Math.round(prevCount / step);
  }
  let best = { score: -Infinity, dx: 0, dy: 0 };
  for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
    for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
      let hit = 0;
      for (const i of rain) {
        const x = (i % w) - dx;
        const y = ((i / w) | 0) - dy;
        if (x >= 0 && y >= 0 && x < w && y < h && prev[y * w + x]) hit++;
      }
      const score = hit / (rain.length + prevCount - hit) - 0.0004 * (dx * dx + dy * dy);
      if (score > best.score) best = { score, dx, dy };
    }
  }
  if (best.score < 0.1) return { vx: 0, vy: 0, ok: false };
  return { vx: best.dx / dtMin, vy: best.dy / dtMin, ok: true };
}

function maxAround(radar, grid, x, y, r) {
  const { w, h } = radar.box;
  if (x - r < 0 || y - r < 0 || x + r >= w || y + r >= h) return null;
  let m = 0;
  let steady = false;
  const r2 = r * r;
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const px = Math.round(x + dx);
      const py = Math.round(y + dy);
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const i = py * w + px;
      if (radar.steady[i]) steady = true;
      else if (grid[i] > m) m = grid[i];
    }
  }
  return steady ? null : m;
}

function steadyMask(frames, size) {
  const mask = new Uint8Array(size);
  if (frames.length < 10) return mask;
  const count = new Uint8Array(size);
  for (const f of frames) for (let i = 0; i < size; i++) if (f.grid[i]) count[i]++;
  const min = Math.ceil(frames.length * 0.9);
  for (let i = 0; i < size; i++) if (count[i] >= min) mask[i] = 1;
  return mask;
}

function without(grid, mask) {
  const out = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) out[i] = mask[i] ? 0 : grid[i];
  return out;
}

export async function loadRadar(coords) {
  const res = await fetchJson(API);
  const past = (res.radar?.past ?? []).slice(-13);
  if (!past.length) throw new Error("sem imagens de radar");

  const pts = coords.map(([lon, lat]) => toPx(lat, lon));
  const x0 = Math.floor(Math.min(...pts.map((p) => p.x)) - PAD);
  const y0 = Math.floor(Math.min(...pts.map((p) => p.y)) - PAD);
  const x1 = Math.ceil(Math.max(...pts.map((p) => p.x)) + PAD);
  const y1 = Math.ceil(Math.max(...pts.map((p) => p.y)) + PAD);
  const box = { x0, y0, w: x1 - x0, h: y1 - y0 };
  if (box.w * box.h > 1000000) throw new Error("rota extensa demais para análise local do radar");
  const tiles = [];
  for (let ty = Math.floor(y0 / SIZE); ty <= Math.floor((y1 - 1) / SIZE); ty++) {
    for (let tx = Math.floor(x0 / SIZE); tx <= Math.floor((x1 - 1) / SIZE); tx++) tiles.push({ x: tx, y: ty });
  }

  const settled = await Promise.allSettled(past.map(async (f) => ({ time: f.time * 1000, path: f.path, grid: await loadGrid(res.host, f.path, tiles, box) })));
  const frames = settled.filter((s) => s.status === "fulfilled").map((s) => s.value).sort((a, b) => a.time - b.time);
  if (!frames.length) throw new Error("as imagens do radar não carregaram");

  const latest = frames[frames.length - 1];
  const prev = frames.reduce((a, f) => (Math.abs(f.time - (latest.time - 30 * 60000)) < Math.abs(a.time - (latest.time - 30 * 60000)) ? f : a), frames[0]);
  const dtMin = (latest.time - prev.time) / 60000;
  const steady = steadyMask(frames, box.w * box.h);
  const motion = dtMin >= 10 ? estimateMotion(without(prev.grid, steady), without(latest.grid, steady), box.w, box.h, dtMin) : { vx: 0, vy: 0, ok: false };

  return { host: res.host, box, frames, latest, motion, steady };
}

export function radarAt(radar, lat, lon, epoch) {
  const { latest, frames, box, motion } = radar;
  const p = toPx(lat, lon);
  const x = p.x - box.x0;
  const y = p.y - box.y0;
  if (epoch <= latest.time + 5 * 60000) {
    const f = frames.reduce((a, c) => (Math.abs(c.time - epoch) < Math.abs(a.time - epoch) ? c : a), frames[0]);
    if (Math.abs(f.time - epoch) > 7 * 60000) return null;
    const level = maxAround(radar, f.grid, x, y, 1.5);
    return level == null ? null : { level, src: "observado" };
  }
  const lead = (epoch - latest.time) / 60000;
  if (lead > HORIZON_MIN) return null;
  const r = Math.min(5, 2 + lead / 20 + (motion.ok ? 0 : 1));
  const level = maxAround(radar, latest.grid, x - motion.vx * lead, y - motion.vy * lead, r);
  return level == null ? null : { level, src: "radar" };
}

export function radarTileUrl(radar) {
  return `${radar.host}${radar.latest.path}/${SIZE}/{z}/{x}/{y}/2/1_1.png`;
}
