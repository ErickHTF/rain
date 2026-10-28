import { test, expect } from '@playwright/test';
import { mockServices } from './helpers/services.js';

async function consult(page) {
  await page.goto('/');
  await page.locator('#go').click();
}

test('forecast, keyboard selection, mobile layout, theme and swap work without radar', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockServices(page);
  await consult(page);
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#verdict-title')).toHaveText('Sem chuva prevista');
  await expect(page.locator('#go')).toBeEnabled();
  await expect(page.locator('#go')).toBeFocused();
  await expect(page.locator('#map')).toContainText('O mapa não carregou');
  await expect(page.locator('#data-note')).toContainText('Radar indisponível');
  await expect(page.locator('#departure-time')).toHaveText('09:00');
  await expect(page.locator('#arrival-time')).toHaveText('09:20');
  await expect(page.locator('#trip-duration')).toHaveText('20 min');
  const bar = page.locator('.bar').nth(2);
  await bar.focus(); await page.keyboard.press('Enter');
  await expect(bar).toBeFocused();
  await expect(bar).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#departure-time')).toHaveText('10:00');
  await expect(page.locator('.bar')).toHaveCount(7);
  await expect(page.locator('#comparison-note')).toContainText('30 min');
  await expect(page.locator('.bar[aria-pressed="true"]')).toHaveCount(1);
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /light|dark/);
  for (const width of [320, 390, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await bar.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
    }
  }
  await page.locator('summary').click();
  await expect(page.locator('#rows tr')).toHaveCount(11);
  await page.locator('#swap').click();
  await expect(page.locator('#origem')).toHaveValue('-23.21, -47.32');
  await expect(page.locator('#result')).toBeHidden(); // Old weather must not describe the edited route.
  expect(errors).toEqual([]);
});

test('missing weather shows an actionable error and allows retry', async ({ page }) => {
  const options = { missing: true };
  await mockServices(page, options);
  await consult(page);
  await expect(page.locator('#error')).toContainText('indisponível');
  await expect(page.locator('#result')).toBeHidden();
  await expect(page.locator('#go')).toBeEnabled();
  options.missing = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#go')).toBeFocused();
  expect(options.forecastCalls).toBe(2);
});

test('initial state makes no weather requests and validates empty fields', async ({ page }) => {
  const options = { empty: true };
  await mockServices(page, options);
  await page.goto('/');
  await expect(page.locator('#initial')).toBeVisible();
  await expect(page.locator('#result')).toBeHidden();
  expect(options.routeCalls ?? 0).toBe(0);
  await page.locator('#go').click();
  await expect(page.locator('#origem')).toBeFocused();
  await expect(page.locator('#origem')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#origem').fill('-23.11, -47.22');
  await page.locator('#go').click();
  await expect(page.locator('#destino')).toBeFocused();
  await expect(page.locator('#error')).toContainText('destino');
  expect(options.routeCalls ?? 0).toBe(0);
});

test('dry, rainy and heavy options are labeled and the better departure is actionable', async ({ page }) => {
  const options = { rain: 'changing' };
  await mockServices(page, options);
  await consult(page);
  await expect(page.locator('#verdict-title')).toHaveText('Chuva forte prevista');
  await expect(page.locator('.bar.forte').first()).toContainText('Chuva forte');
  await expect(page.locator('.bar.chuva').first()).toContainText('Chuva');
  await expect(page.locator('.bar.seco').first()).toContainText('Sem chuva');
  await page.locator('#choose-better').click();
  await expect(page.locator('#verdict-title')).toHaveText('Sem chuva prevista');
  await expect(page.locator('#departure-time')).toHaveText('10:30');
  await expect(page.locator('.bar[aria-pressed="true"]')).toBeFocused();
  await page.locator('.bar.chuva').first().click();
  await expect(page.locator('#verdict-title')).toHaveText('Chuva no caminho');
  await expect(page.locator('#journey-points')).toContainText('Chuva');
  expect(options.routeCalls).toBe(1);
  expect(options.forecastCalls).toBe(1);
  await page.locator('#later').click();
  expect(await page.locator('#bars').evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
});

test('loading prevents duplicate requests, preserves focus, and recovers from a route error', async ({ page }) => {
  let release;
  const options = { delay: new Promise(resolve => { release = resolve; }) };
  await mockServices(page, options);
  await consult(page);
  await expect(page.locator('#status')).toContainText('Buscando');
  await expect(page.locator('#form')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#go')).toBeDisabled();
  await expect(page.locator('#initial')).toBeHidden();
  release();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#go')).toBeFocused();
  expect(options.forecastCalls).toBe(1);
  options.routeFail = true;
  await page.locator('#origem').fill('-23.12, -47.22');
  await page.locator('#go').click();
  await expect(page.locator('#error')).toContainText('traçar a rota');
  options.routeFail = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.locator('#result')).toBeVisible();
});

test('departure editing, coverage errors and now reuse valid cached data', async ({ page }) => {
  const options = {};
  await mockServices(page, options);
  await consult(page);
  await page.locator('#saida').fill('2026-10-22T10:00');
  await expect(page.locator('#agora')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#go').click();
  await expect(page.locator('#departure-time')).toHaveText('10:00');
  expect(options.forecastCalls).toBe(1);
  await page.locator('#saida').fill('2026-11-30T10:00');
  await page.locator('#go').click();
  await expect(page.locator('#error')).toContainText('Fora disso não há previsão');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#agora').click();
  await expect(page.locator('#agora')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#go').click();
  await expect(page.locator('#departure-time')).toHaveText('09:00');
  expect(options.forecastCalls).toBe(1);
});

test('geolocation fills origin and a denied permission has a useful recovery', async ({ page, context }) => {
  await mockServices(page, { empty: true });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: -23.1, longitude: -47.2 });
  await page.goto('/');
  await page.locator('#locate').click();
  await expect(page.locator('#origem')).toHaveValue('-23.10000, -47.20000');
  await expect(page.locator('#destino')).toBeFocused();
  await expect(page.locator('#result')).toBeHidden();
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (_, failure) => failure({ code: 1 });
  });
  await page.locator('#locate').click();
  await expect(page.locator('#error')).toContainText('Permissão de localização negada');
  await expect(page.locator('#error')).toContainText('Digite seu endereço');
  await expect(page.locator('#go')).toBeEnabled();
});

test('forecast failure can retry and cross-midnight trips show the arrival day', async ({ page }) => {
  const options = { forecastFail: true };
  await mockServices(page, options);
  await consult(page);
  await expect(page.locator('#error')).toContainText('previsão está indisponível');
  options.forecastFail = false;
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.locator('#result')).toBeVisible();
  await page.locator('#saida').fill('2026-10-22T23:50');
  await page.locator('#go').click();
  await expect(page.locator('#arrival-time')).toContainText('00:10');
  await expect(page.locator('#arrival-time')).toContainText('amanhã');
  await expect(page.locator('.bar').nth(1)).toContainText('amanhã');
});

test('system theme, stored preference and reduced motion are respected', async ({ page }) => {
  await mockServices(page);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#theme')).toHaveAccessibleName('Ativar tema claro');
  expect(await page.locator('#status').evaluate(el => getComputedStyle(el, '::before').animationName)).toBe('none');
  await page.locator('#theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#theme')).toHaveAccessibleName('Ativar tema escuro');
});


test('named places require confirmation before routing and can be corrected', async ({ page }) => {
  const options = {};
  await mockServices(page, options);
  await page.goto('/');
  await page.locator('#origem').fill('Viracopos');
  await page.locator('#go').click();
  await expect(page.locator('#place-dialog')).toBeVisible();
  await expect(page.locator('#place-name')).toContainText('Aeroporto Internacional');
  await expect(page.locator('#place-address')).toContainText('Campinas');
  await expect(page.locator('#place-external')).toHaveAttribute('href', /query=-23.0074,-47.1345/);
  expect(options.routeCalls ?? 0).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#place-dialog')).not.toBeVisible();
  await expect(page.locator('#origem')).toBeFocused();
  await expect(page.locator('#go')).toBeEnabled();
  expect(options.routeCalls ?? 0).toBe(0);
  await page.locator('#go').click();
  await page.locator('#place-options input').nth(1).check();
  await expect(page.locator('#place-name')).toContainText('Hotel');
  await page.locator('#place-confirm').click();
  await expect(page.locator('#result')).toBeVisible();
  expect(options.lastRouteURL).toContain('-47.14,-23.011');
  await expect(page.locator('#confirmed-places')).toContainText('Hotel Viracopos');
  expect(options.placeCalls).toBe(1);
  await page.locator('#origem').fill('Outro aeroporto');
  await expect(page.locator('#confirmed-places')).toBeHidden();
  await expect(page.locator('#result')).toBeHidden();
});

test('place preview retries search failures and confirms both named endpoints', async ({ page }) => {
  const options = { placeFail: true };
  await mockServices(page, options);
  await page.goto('/');
  await page.locator('#origem').fill('Aeroporto');
  await page.locator('#destino').fill('Hotel');
  await page.locator('#check-origem').click();
  await expect(page.locator('#error')).toContainText('consultar o endereço');
  await expect(page.locator('#go')).toBeEnabled();
  options.placeFail = false;
  await page.locator('#go').click();
  await expect(page.locator('#place-dialog-title')).toContainText('sair');
  await page.locator('#place-confirm').click();
  await expect(page.locator('#place-dialog-title')).toContainText('para cá');
  await page.locator('#place-options input').nth(1).check();
  await page.locator('#place-confirm').click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#confirmed-places')).toContainText('Origem confirmada');
  await expect(page.locator('#confirmed-places')).toContainText('Destino confirmado');
});

test('transport changes use appropriate routing profiles and update arrival estimates', async ({ page }) => {
  const options = {};
  await mockServices(page, options);
  await consult(page);
  await expect(page.locator('#trip-duration')).toHaveText('20 min');
  await page.getByRole('radio', { name: 'Bicicleta', exact: true }).check();
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#go').click();
  await expect(page.locator('#trip-duration')).toHaveText('1 h');
  expect(options.lastRouteURL).toContain('/routed-bike/');
  await expect(page.locator('#duration-mode')).toHaveText('De bicicleta');
  await page.getByRole('radio', { name: 'A pé', exact: true }).check();
  await page.locator('#go').click();
  await expect(page.locator('#trip-duration')).toHaveText('3 h');
  expect(options.lastRouteURL).toContain('/routed-foot/');
  await page.getByRole('radio', { name: 'Moto', exact: true }).check();
  await expect(page.locator('#vehicle-note')).toContainText('aproximação');
  await page.locator('#go').click();
  await expect(page.locator('#duration-mode')).toHaveText('De moto');
  await expect(page.locator('#data-note')).toContainText('aproximação');
  await expect(page.locator('#trip-duration')).toHaveText('20 min');
  expect(options.routeCalls).toBe(4);
});

test('dark theme keeps text and weather labels above 7:1 contrast and borders above 3:1', async ({ page }) => {
  await mockServices(page);
  await page.goto('/');
  const ratios = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    const style = getComputedStyle(document.documentElement);
    const luminance = name => {
      const hex = style.getPropertyValue(name).trim();
      const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    return [['--text', '--surface'], ['--muted', '--surface'], ['--seco', '--dry-bg'], ['--chuva', '--rain-bg'], ['--forte', '--heavy-bg'], ['--line', '--surface']].map(([a, b]) => {
      const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
      return (values[1] + .05) / (values[0] + .05);
    });
  });
  for (const ratio of ratios.slice(0, 5)) expect(ratio).toBeGreaterThanOrEqual(7);
  expect(ratios.at(-1)).toBeGreaterThanOrEqual(3);
});
