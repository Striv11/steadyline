/**
 * The business, end to end, in real browsers: a patient signs up and books, the
 * nearest nurse is dispatched automatically, the nurse does the visit on their
 * phone and records a dangerous BP, operations resolves the alert, the patient
 * sees the result; then a medicine delivery is handed over with an OTP.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';

const PW = 'changeme123';
const KARVE_NAGAR = { latitude: 18.488, longitude: 73.818 };

async function as(browser: Browser, phone: string, password = PW): Promise<Page> {
  const ctx = await browser.newContext({
    geolocation: KARVE_NAGAR,
    permissions: ['geolocation'],
    timezoneId: 'Asia/Kolkata',
  });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('phone').fill(phone);
  await page.getByTestId('password').fill(password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('logout')).toBeVisible();
  return page;
}

/** Tomorrow's date in IST. */
const tomorrow = () =>
  new Date(Date.now() + 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

async function pickService(page: Page, text: string) {
  const v = await page
    .getByTestId('service')
    .locator('option', { hasText: text })
    .getAttribute('value');
  await page.getByTestId('service').selectOption(v!);
}

test.describe.configure({ mode: 'serial' });

test('home visit: book, auto-dispatch, nurse visit with critical BP, ops resolves, patient sees it', async ({
  browser,
}, info) => {
  const suffix = info.project.name === 'phone' ? '2' : '1';
  const ctx = await browser.newContext({
    geolocation: KARVE_NAGAR,
    permissions: ['geolocation'],
    timezoneId: 'Asia/Kolkata',
  });
  const pt = await ctx.newPage();
  await pt.goto('/');
  await expect(pt.getByRole('heading', { level: 1 })).toContainText('Care at home');
  await pt.getByTestId('auth-switch').click();
  await pt.locator('#name').fill('Asha Verma');
  await pt.getByTestId('phone').fill(`98765${suffix}0000`);
  await pt.getByTestId('password').fill('asha-pass-123');
  await pt.getByTestId('auth-submit').click();
  await expect(pt.getByRole('alert')).toContainText(/consent/i); // consent is required
  await pt.getByTestId('consent').check();
  await pt.getByTestId('auth-submit').click();
  await expect(pt.getByRole('heading', { level: 1 })).toContainText('Hello, Asha');

  await pt.getByTestId('address').fill('Flat 2, Lane 4, Karve Nagar, Pune 411052');
  await pt.getByTestId('use-location').click();
  await expect(pt.getByTestId('loc-note')).toContainText('captured');
  await pt.locator('#allergy').fill('penicillin');
  await pt.getByTestId('save-profile').click();
  await expect(pt.locator('#toast')).toContainText('Profile saved');
  await pickService(pt, 'Nursing visit');
  await pt.getByTestId('when').fill(`${tomorrow()}T${suffix === '1' ? '11:00' : '15:00'}`);
  await pt.getByTestId('book').click();
  await expect(pt.locator('#toast')).toContainText('Anita Kulkarni'); // nearest nurse with the skill
  await expect(pt.getByTestId('bookings')).toContainText('Confirmed');

  const nurse = await as(browser, '9100000001');
  await expect(nurse.getByRole('heading', { level: 1 })).toHaveText('My day');
  await nurse.getByTestId('day').fill(tomorrow());
  await nurse.getByTestId('day').dispatchEvent('change');
  const stop = nurse.getByTestId('route').locator('li', { hasText: 'Asha Verma' }).last();
  await stop.locator('summary').click();
  await expect(stop).toContainText('Allergies: penicillin');
  await stop.getByTestId('act-start').click();
  await expect(stop).toContainText('On the way');
  await expect(nurse.getByTestId('sharing')).toContainText('Sharing your location');
  await pt.reload();
  await expect(pt.getByTestId('eta')).toContainText(/Arriving in about \d+ min/);
  await stop.getByTestId('act-arrive').click();
  await stop.getByTestId('act-begin').click();
  await expect(stop).toContainText('In progress');
  await stop.getByTestId('v-bp').fill('186');
  await stop.getByTestId('v-bp2').fill('112');
  await stop.getByTestId('v-glucose').fill('142');
  await stop.getByTestId('save-vitals').click();
  await expect(stop.getByRole('alert')).toContainText('hypertensive crisis');
  await stop.getByTestId('visit-notes').fill('BP very high; advised urgent doctor review.');
  await stop.getByTestId('payment').selectOption('upi');
  await stop.getByTestId('act-complete').click();
  await expect(stop).toContainText('Completed');

  const ops = await as(browser, '9000000002');
  await expect(ops.getByRole('heading', { level: 1 })).toHaveText('Operations');
  await ops.getByTestId('tab-alerts').click();
  const alert = ops.getByTestId('alerts').locator('li', { hasText: 'Asha Verma' }).first();
  await expect(alert).toContainText('hypertensive crisis');
  await alert.getByTestId('ack-text').fill('Called patient, GP booked today 4pm');
  await alert.getByTestId('ack').click();
  await expect(ops.locator('#toast')).toContainText('Alert resolved');
  await ops.getByTestId('tab-messages').click();
  await expect(ops.getByTestId('log-mode')).toBeVisible();
  await expect(ops.getByTestId('messages')).toContainText('is on the way');
  await expect(ops.getByTestId('messages')).toContainText('CRITICAL');
  await ops.getByTestId('tab-map').click();
  await expect(ops.getByTestId('live-map')).toBeVisible();
  await expect(ops.locator('.leaflet-container')).toBeVisible();

  await pt.reload();
  await expect(pt.getByTestId('bookings')).toContainText('Completed');
  await expect(pt.getByTestId('bookings')).toContainText('advised urgent doctor review');
  await expect(pt.getByTestId('vitals')).toContainText('186/112');
  await pt.screenshot({ path: `test-results/patient-${info.project.name}.png`, fullPage: true });
  await nurse.screenshot({ path: `test-results/nurse-${info.project.name}.png`, fullPage: true });
});

test('medicine delivery with OTP handover', async ({ browser }, info) => {
  const pt = await as(browser, '9300000001'); // seeded patient with address
  await pickService(pt, 'Medicine');
  await pt.getByTestId('items').fill('Metformin 500 mg x2\nGlucometer strips x1');
  await pt
    .getByTestId('when')
    .fill(`${tomorrow()}T${info.project.name === 'phone' ? '16:00' : '12:00'}`);
  await pt.getByTestId('book').click();
  await expect(pt.locator('#toast')).toContainText('will come');
  const code = (await pt.getByTestId('otp').last().locator('strong').textContent())!.trim();
  expect(code).toMatch(/^\d{6}$/);

  const courier = await as(browser, '9200000001');
  await courier.getByTestId('day').fill(tomorrow());
  await courier.getByTestId('day').dispatchEvent('change');
  const stop = courier
    .getByTestId('route')
    .locator('li.stop', { hasText: 'Metformin' })
    .filter({ hasNotText: 'Completed' })
    .first();
  await stop.locator('summary').click();
  await expect(stop).toContainText('2 × Metformin 500 mg');
  await stop.getByTestId('act-start').click();
  await stop.getByTestId('act-arrive').click();
  await stop.getByTestId('otp-input').fill(code === '000000' ? '111111' : '000000');
  await stop.getByTestId('act-complete').click();
  await expect(courier.locator('#toast')).toContainText('does not match');
  await stop.getByTestId('otp-input').fill(code);
  await stop.getByTestId('payment').selectOption('cash');
  await stop.getByTestId('act-complete').click();
  await expect(courier.locator('#toast')).toContainText('Done');
});

test('ops board shows the day', async ({ browser }, info) => {
  const ops = await as(browser, '9000000002');
  await ops.getByTestId('ops-day').fill(tomorrow());
  await ops.getByTestId('ops-day').dispatchEvent('change');
  await expect(ops.getByTestId('schedule')).toContainText('Anita Kulkarni');
  await expect(ops.getByTestId('kpi-queue')).toHaveText(/\d+/);
  await ops.screenshot({ path: `test-results/ops-${info.project.name}.png`, fullPage: true });
});
