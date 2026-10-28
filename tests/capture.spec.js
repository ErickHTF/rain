import { writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { mockServices } from './helpers/services.js';

// Explicit opt-in: screenshots use controlled weather responses, not live predictions.
test('capture the rendered design for review', async ({ page }) => {
  test.skip(!process.env.UI_SCREENSHOTS, 'Run with UI_SCREENSHOTS=1 to refresh review images.');
  test.setTimeout(60000); // Live asset requests have an 8-second budget per viewport.
  page.setDefaultTimeout(10000);
  const options = { rain: 'changing', assets: !!process.env.UI_LIVE_ASSETS };
  await mockServices(page, options);
  const errors = [];
  const measurements = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  for (const [name, width] of [['desktop', 1440], ['mobile', 390], ['small', 320]]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      await page.screenshot({ path: `artifacts/ui/initial-${name}-${theme}.png`, fullPage: true });
    }
  }
  await page.locator('#go').click();
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
  if (process.env.UI_LIVE_ASSETS) {
    await expect(page.locator('.leaflet-container')).toBeVisible();
    expect(await page.locator('.pin').first().evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
    await page.locator('.pin').first().click();
    await expect(page.locator('.leaflet-popup-content')).toContainText('Saída');
    await page.locator('.leaflet-popup-close-button').click();
    await page.locator('.leaflet-control-zoom-in').click();
    await page.locator('#fit-map').click();
  }
  for (const [name, width] of [['desktop', 1440], ['mobile', 390], ['small', 320]]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      // Allow Leaflet's resize observer and tile requests to settle for a faithful capture.
      if (options.assets) {
        await page.waitForTimeout(300);
        await page.locator('#fit-map').click();
        await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.base-tiles img')].every(img => img.complete)), { timeout: 12000 }).toBe(true);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.locator('#form')).toBeVisible({ visible: width >= 1024 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      measurements.push(await page.evaluate(({ name, theme }) => ({
        viewport: name, theme, width: innerWidth, height: document.documentElement.scrollHeight,
        verdictTop: document.getElementById('verdict').getBoundingClientRect().top,
        verdictBottom: document.getElementById('verdict').getBoundingClientRect().bottom,
      }), { name, theme }));
      if (width === 390) {
        expect(measurements.at(-1).height).toBeLessThanOrEqual(2957 * .7);
        expect(measurements.at(-1).verdictBottom).toBeLessThan(844);
      }
      await page.screenshot({ path: `artifacts/ui/after-${name}-${theme}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#choose-better').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/ui/dry-mobile-dark.png', fullPage: true });
  await page.locator('summary').click();
  await expect(page.locator('#rows tr')).toHaveCount(11);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/ui/details-mobile-dark.png', fullPage: true });
  await page.locator('#trip-summary').click();
  options.missing = true;
  await page.locator('#origem').fill('-23.12, -47.22');
  await page.locator('#go').click();
  await expect(page.locator('#error')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/ui/error-mobile-dark.png', fullPage: true });
  options.missing = false;
  await page.locator('#origem').fill('Viracopos');
  await page.locator('#check-origem').click();
  await expect(page.locator('#place-dialog')).toBeVisible();
  for (const [name, width] of [['desktop', 1440], ['mobile', 390], ['small', 320]]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      await page.screenshot({ path: `artifacts/ui/place-${name}-${theme}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.locator('#place-confirm').click();
  await expect(page.locator('#confirmed-places')).toContainText('Viracopos');
  writeFileSync(`artifacts/ui/measurements-${options.assets ? 'live' : 'offline'}.json`, JSON.stringify(measurements, null, 2) + '\n');
  expect(errors).toEqual([]);
});
