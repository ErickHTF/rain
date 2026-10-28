import test from 'node:test';
import assert from 'node:assert/strict';
import { indexForecast, readAt, departureWindow, parseCoords, samplePoints, simulateDepartures, comparisonDepartures } from '../logic.js';
import { fetchJson, route, forecast } from '../api.js';
import { radarAt, toPx } from '../radar.js';

function fixture() {
  return { utc_offset_seconds: -10800,
    hourly: { time: ['2026-10-22T12:00', '2026-10-22T13:00'], precipitation_probability: [20, 60], weather_code: [0, 61] },
    minutely_15: { time: ['2026-10-22T12:00', '2026-10-22T12:15', '2026-10-22T12:30', '2026-10-22T12:45', '2026-10-22T13:00'], precipitation: [0, 0.2, 0.4, 0.6, 0.8] },
  };
}
const noon = Date.parse('2026-10-22T15:00:00Z');
test('coordinates are bounded and route sampling preserves endpoints', () => {
  assert.deepEqual(parseCoords('(-23.11, -47.22)'), { lat: -23.11, lon: -47.22 });
  assert.equal(parseCoords('91, 180'), null);
  const { points } = samplePoints([[-47, -23], [-46, -22]], 10);
  assert.equal(points.length, 11);
  assert.equal(points[0].lon, -47);
  assert.equal(points.at(-1).lat, -22);
});
test('forecast interpolation respects provider timezone and 15-minute slots', () => {
  const value = readAt(indexForecast(fixture()), noon + 30 * 60000);
  assert.equal(value.prob, 40);
  assert.equal(value.mm, 0.4);
  assert.equal(readAt(indexForecast(fixture()), noon + 3600000).prob, 60);
});
test('missing values never become a dry forecast', () => {
  const raw = fixture(); raw.minutely_15.precipitation[0] = null;
  assert.throws(() => readAt(indexForecast(raw), noon), /indisponível/);
  raw.hourly.precipitation_probability[0] = null;
  assert.throws(() => readAt(indexForecast(raw), noon), /indisponível/);
});
test('invalid timestamps and incomplete forecast series fail clearly', () => {
  const raw = fixture(); raw.hourly.time[1] = raw.hourly.time[0];
  assert.throws(() => indexForecast(raw), /inválidos/);
  assert.throws(() => indexForecast({}), /incompleta/);
  assert.throws(() => readAt(indexForecast(fixture()), NaN), /fora/);
});
test('precipitation coverage is not silently extended', () => {
  const raw = fixture(); raw.minutely_15.time = raw.minutely_15.time.slice(0, 1); raw.minutely_15.precipitation = [0];
  const fc = indexForecast(raw);
  assert.throws(() => readAt(fc, noon + 15 * 60000), /precipitação/);
  assert.equal(departureWindow([fc], 60, 0).max, noon + 14 * 60000 - 1);
});
test('departure comparison always returns one of its candidates', () => {
  const fc = indexForecast(fixture());
  const sim = simulateDepartures({ points: [{ lat: -23, lon: -47, frac: 0 }], forecasts: [fc], distance: 100, duration: 1, now: noon, steps: 2 });
  assert.equal(sim.trips.length, 3);
  assert.ok(sim.trips.includes(sim.best));
});
test('radar outside its image falls back to forecast', () => {
  const p = toPx(-23, -47);
  const frame = { time: noon, grid: new Uint8Array(100) };
  const radar = { box: { x0: p.x + 20, y0: p.y + 20, w: 10, h: 10 }, latest: frame, frames: [frame], steady: new Uint8Array(100), motion: { vx: 0, vy: 0, ok: false } };
  assert.equal(radarAt(radar, -23, -47, noon), null);
});
test('network errors, timeout, malformed routes and incomplete locations are rejected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(fetchJson('https://example.test'), /HTTP 503/);
  globalThis.fetch = async (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(fetchJson('https://example.test', { timeout: 5 }), /demorou/);
  globalThis.fetch = async () => Response.json({ code: 'Ok', routes: [{ distance: 0, duration: 0, geometry: { coordinates: [] } }] });
  await assert.rejects(route({ lat: 0, lon: 0 }, { lat: 0, lon: 0 }), /pontos são iguais/);
  globalThis.fetch = async () => Response.json([fixture(), {}]);
  await assert.rejects(forecast([{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }]), /incompleta/);
});


test('dry comparisons use 30 minutes but a wet intermediate departure is never hidden', () => {
  const trips = Array.from({ length: 13 }, (_, i) => ({ departure: i * 900000, worst: 'seco' }));
  const sim = { trips, best: trips[0] };
  const dry = comparisonDepartures(sim);
  assert.equal(dry.stepMin, 30);
  assert.equal(dry.trips.length, 7);
  assert.equal(dry.trips.at(-1).departure, 10800000);
  trips[1].worst = 'chuva';
  const wet = comparisonDepartures(sim);
  assert.equal(wet.stepMin, 15);
  assert.equal(wet.trips.length, 13);
  assert.equal(wet.trips[1].worst, 'chuva');
});
