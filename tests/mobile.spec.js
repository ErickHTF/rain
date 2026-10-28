import { test, expect } from '@playwright/test';
import { mockServices } from './helpers/services.js';

async function noOverflowOrSmallText(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const small = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
    if (!el.getClientRects().length || el.closest('.sr-only, .svg-defs, .credits, .leaflet-control-attribution')) return false;
    return [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()) && parseFloat(getComputedStyle(el).fontSize) < 14;
  }).map(el => el.outerHTML));
  expect(small).toEqual([]);
  const undersized = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, summary')].flatMap(el => {
    const target = el.matches('input[type="radio"]') ? el.closest('label') : el;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    return rect.width < 44 || rect.height < 44 ? [target.outerHTML] : [];
  }));
  expect(undersized).toEqual([]);
}

test('mobile result reveals the verdict, supports editing and keeps the selected trip in its summary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const options = { rain: 'changing' };
  await mockServices(page, options);
  await page.goto('/');
  await page.locator('#go').click();
  const summary = page.locator('#trip-summary');
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#form')).toBeHidden();
  await expect(summary).toContainText('09:00 · Carro');
  const verdict = await page.locator('#verdict').boundingBox();
  expect(verdict.y).toBeGreaterThanOrEqual(0);
  expect(verdict.y + verdict.height).toBeLessThan(844);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(2957 * .7);
  await page.locator('#choose-better').click();
  await expect(summary).toContainText('10:30');
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toHaveAccessibleName(/Fechar edição/);
  await expect(page.locator('#form')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Carro', exact: true })).toBeFocused();
  await page.locator('#destino').fill('-23.22, -47.33');
  await expect(page.locator('#result')).toBeHidden();
  await expect(summary).toBeHidden();
  await page.locator('#go').click();
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAccessibleName(/-47.33/);
  expect(options.routeCalls).toBe(2);
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(summary).toBeHidden();
  await expect(page.locator('#form')).toBeVisible();
  await expect(page.locator('#go')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(summary).toBeFocused();
  await expect(page.locator('#form')).toBeHidden();
});

test('both themes keep readable type and fit every supported viewport in initial, result and expanded states', async ({ page }) => {
  await mockServices(page, { rain: 'changing' });
  await page.goto('/');
  for (const width of [320, 390, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 844 });
    await noOverflowOrSmallText(page);
  }
  await page.locator('#go').click();
  await expect(page.locator('#result')).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1280, 1920]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(t => document.documentElement.dataset.theme = t, theme);
      await noOverflowOrSmallText(page);
      await page.locator('.details summary').click();
      await noOverflowOrSmallText(page);
      await page.locator('.details summary').click();
      if (width < 1024) {
        await page.locator('#trip-summary').click();
        await noOverflowOrSmallText(page);
        await page.locator('#trip-summary').click();
      }
    }
    if (width < 768) {
      const points = await page.locator('.journey-points li').evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
      expect(points[1]).toBeGreaterThan(points[0]);
      expect(points[2]).toBeGreaterThan(points[1]);
    }
  }
});

test('text and control palette meets AA in both themes', async ({ page }) => {
  await mockServices(page);
  await page.goto('/');
  for (const theme of ['light', 'dark']) {
    const ratios = await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      const style = getComputedStyle(document.documentElement);
      const luminance = name => {
        let hex = style.getPropertyValue(name).trim().slice(1);
        if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
        const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const pairs = ['--bg', '--surface', '--soft', '--dry-bg', '--rain-bg', '--heavy-bg'].flatMap(bg => ['--text', '--muted'].map(fg => [fg, bg]));
      for (const [tone, bg] of [['--seco', '--dry-bg'], ['--chuva', '--rain-bg'], ['--forte', '--heavy-bg']]) {
        for (const background of [bg, '--surface', '--soft']) pairs.push([tone, background]);
      }
      pairs.push(['--accent-ink', '--accent'], ['--accent', '--surface'], ['--accent', '--soft'], ['--err-text', '--err-bg']);
      pairs.push(['--control-line', '--input'], ['--control-line', '--surface']);
      return pairs.map(([a, b]) => {
        const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
        return { pair: `${a}/${b}`, ratio: (values[1] + .05) / (values[0] + .05), min: a === '--control-line' ? 3 : 4.5 };
      });
    }, theme);
    for (const { pair, ratio, min } of ratios) expect(ratio, `${theme}: ${pair}`).toBeGreaterThanOrEqual(min);
  }
});
