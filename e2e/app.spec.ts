import { expect, test } from '@playwright/test';

test('landing page explains the product and links to the demo', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Keep your health private');
  await expect(page.getByRole('note')).toContainText('not medical advice');
  await page.getByRole('link', { name: 'Try the demo patient' }).click();
  await expect(page.getByRole('status')).toContainText('simulated');
});

test('demo dashboard shows glucose metrics, chart and data table', async ({ page }) => {
  await page.goto('/#/demo');
  await expect(page.getByText('Time in range', { exact: true })).toBeVisible();
  await expect(page.getByText('GMI', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /Time in ranges/ })).toBeVisible();
  await page.getByText('View data table').click();
  await expect(page.getByRole('table')).toBeVisible();
});

test('theme toggles with keyboard and no horizontal overflow at 360px', async ({ page }) => {
  await page.goto('/#/demo');
  const before = await page.locator('html').getAttribute('data-theme');
  await page.keyboard.press('t');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
