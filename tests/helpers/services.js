export const NOW = Date.parse('2026-10-22T12:00:00Z');

// Controlled provider responses are only used by tests, never by the app.
export async function mockServices(page, options = {}) {
  // Let time advance: Leaflet's pan/zoom lifecycle measures elapsed wall time.
  await page.clock.install({ time: new Date(NOW) });
  await page.addInitScript(({ empty }) => {
    if (!empty) {
      localStorage.setItem('origem', '-23.11, -47.22');
      localStorage.setItem('destino', '-23.21, -47.32');
    }
  }, { empty: options.empty });
  await page.route('https://**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('nominatim.openstreetmap.org')) {
      options.placeCalls = (options.placeCalls ?? 0) + 1;
      if (options.placeFail) return route.fulfill({ status: 503, body: '' });
      return route.fulfill({ json: options.places ?? [
        { lat: '-23.0074', lon: '-47.1345', type: 'aerodrome', display_name: 'Aeroporto Internacional de Viracopos, Rodovia Santos Dumont, Campinas, São Paulo, Brasil' },
        { lat: '-23.011', lon: '-47.14', type: 'hotel', display_name: 'Hotel Viracopos, Campinas, São Paulo, Brasil' },
      ] });
    }
    if (/router.project-osrm.org|routing.openstreetmap.de/.test(url)) {
      options.lastRouteURL = url;
      options.routeCalls = (options.routeCalls ?? 0) + 1;
      if (options.routeFail) return route.fulfill({ status: 503, body: '' });
      return route.fulfill({ json: { code: 'Ok', routes: [{ distance: 15000, duration: options.duration ?? (url.includes('routed-bike') ? 3600 : url.includes('routed-foot') ? 10800 : 1200), geometry: { coordinates: [[-47.22, -23.11], [-47.24, -23.12], [-47.25, -23.16], [-47.29, -23.18], [-47.32, -23.21]] } }] } });
    }
    if (url.includes('api.open-meteo.com')) {
      options.forecastCalls = (options.forecastCalls ?? 0) + 1;
      if (options.delay) await options.delay;
      if (options.forecastFail) return route.fulfill({ status: 503, body: '' });
      const start = NOW - 86400000;
      const times = (count, step) => Array.from({ length: count }, (_, i) => new Date(start + i * step).toISOString().slice(0, 16));
      const precipitation = Array.from({ length: 384 }, (_, i) => {
        if (options.rain === 'changing') return start + i * 900000 < NOW + 45 * 60000 ? 2 : start + i * 900000 < NOW + 90 * 60000 ? .4 : 0;
        return options.rain === 'heavy' ? 2 : options.rain === 'rain' ? .4 : 0;
      });
      const fc = { utc_offset_seconds: 0, hourly: { time: times(96, 3600000), precipitation_probability: Array(96).fill(options.missing ? null : 10), weather_code: Array(96).fill(0) }, minutely_15: { time: times(384, 900000), precipitation } };
      return route.fulfill({ json: Array(11).fill(fc) });
    }
    if (options.assets && /unpkg.com|fonts.googleapis.com|fonts.gstatic.com|tile.openstreetmap.org/.test(url)) {
      try { return await route.fulfill({ response: await route.fetch({ timeout: 8000 }) }); }
      catch { return route.abort(); }
    }
    return route.abort(); // Radar/map/font outage fallback, independent of provider uptime.
  });
}
