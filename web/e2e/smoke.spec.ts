import { test as base, expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Run unchanged against fixture snapshots in CI and the full artifact before deployment.
// No API, storage, worker, or browser-runtime mocks.
const test = base.extend<{ runtime: { workers: string[] } }>({
  runtime: [async ({ page, context }, use, testInfo) => {
    const errors: string[] = [];
    const workers: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('worker', worker => workers.push(worker.url()));
    context.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await use({ workers });
    await testInfo.attach('browser-diagnostics', { body: JSON.stringify({ errors, workers }, null, 2), contentType: 'application/json' });
    expect(errors, 'uncaught exceptions or failed HTTP responses').toEqual([]);
  }, { auto: true }],
});

type Profile = {
  key: string;
  label: string;
  draft?: boolean;
  modules: { package: string; sections: string[] }[];
};

async function openHome(page: Page) {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Pick a schema to get started' })).toBeVisible();
}

async function downloadBytes(download: Download) {
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  return readFile(path!);
}

test('opens a class from every available schema at the Pages base path', async ({ page, request, baseURL, runtime }) => {
  const response = await request.get(new URL('data/index.json', baseURL!).href);
  expect(response.ok()).toBe(true);
  const index = await response.json() as { format: number; profiles: Profile[] };
  expect(index.format).toBe(1);
  const available = index.profiles.filter(profile => profile.modules.some(module => module.sections.length));
  expect(available.length).toBeGreaterThan(0);
  await openHome(page);
  for (const profile of available) {
    await test.step(profile.key, async () => {
      await page.getByRole('button', { name: `${profile.label}${profile.draft ? ' (draft)' : ''}`, exact: true }).click();
      const module = profile.modules.find(module => module.sections.length)!;
      const root = module.sections[0];
      const card = page.locator('.overview-card').filter({ has: page.getByText(module.package, { exact: true }) });
      await card.getByRole('button', { name: root, exact: true }).click();
      await expect(page.locator('.flow-title').filter({ hasText: new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })).toBeVisible();
      await page.getByRole('button', { name: 'Schema home', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Pick a schema to get started' })).toBeVisible();
    });
  }
  expect(runtime.workers.some(url => url.includes('/assets/worker-'))).toBe(true);
});

test('persists a real Python edit, exports PDF, undoes after reload, and restores backup', async ({ page, runtime }) => {
  await openHome(page);
  await page.getByRole('button', { name: '+ Start from empty canvas', exact: true }).click();
  await page.getByRole('button', { name: '+ Add class', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add class', exact: true });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('SmokeTestClass');
  await form.getByRole('button', { name: 'Add class', exact: true }).click();
  const title = page.locator('.flow-title').filter({ hasText: /^SmokeTestClass$/ });
  await expect(title).toBeVisible();
  expect(runtime.workers.some(url => url.includes('/assets/worker-'))).toBe(true);

  await page.getByRole('button', { name: 'Show edit history', exact: true }).click();
  const backupPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download edits', exact: true }).click();
  const backup = await backupPromise;
  const backupBytes = await downloadBytes(backup);
  const log = JSON.parse(backupBytes.toString());
  expect(log.format).toBe('schema-studio-edits');
  expect(log.edits).toHaveLength(1);
  expect(log.edits[0].op).toBe('add_class');

  await page.getByRole('button', { name: 'Toggle workspace settings', exact: true }).click();
  await page.getByLabel('Import / export', { exact: true }).click();
  const pdfPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const pdf = await downloadBytes(await pdfPromise);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(1000);

  await page.reload();
  await page.getByRole('button', { name: 'Toggle workspace settings', exact: true }).click();
  await page.getByRole('button', { name: 'Build graph', exact: true }).click();
  await expect(title).toBeVisible();
  await page.getByRole('button', { name: 'Show edit history', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(title).toHaveCount(0);
  await expect(page.getByRole('button', { name: '+ Add class', exact: true })).toBeVisible();

  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Backup file', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backupBytes });
  await expect(page.getByText('Restored 1 edit.', { exact: true })).toBeVisible();
  await expect(title).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
});
