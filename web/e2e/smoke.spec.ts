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
  // Restoring replaces History; the restored edit is still listed and can be undone.
  await expect(page.getByText('Added class SmokeTestClass', { exact: true })).toHaveCount(0);
  const restored = page.getByTestId('older-saved-edit');
  await expect(restored).toHaveCount(1);
  await expect(restored).toContainText('Older saved edit: add class SmokeTestClass');
  await restored.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(title).toHaveCount(0);
  await expect(restored).toHaveCount(0);
});

test('renamed and added classes remain navigable in the package sidebar', async ({ page, request, baseURL }) => {
  const response = await request.get(new URL('data/index.json', baseURL!).href);
  const index = await response.json() as { profiles: Profile[] };
  const profile = index.profiles.find(p => p.key === 'nomad-simulations')!;
  // ModelMethod in real snapshots; the first fixture module in CI.
  const module = profile.modules.find(m => m.sections.includes('ModelMethod')) ?? profile.modules.find(m => m.sections.length)!;
  const original = module.sections.includes('ModelMethod') ? 'ModelMethod' : module.sections[0];
  await openHome(page);
  await page.getByRole('button', { name: profile.label, exact: true }).click();
  await page.locator('.overview-card').filter({ has: page.getByText(module.package, { exact: true }) }).getByRole('button', { name: original, exact: true }).click();
  const sidebar = page.getByRole('complementary', { name: 'Packages', exact: true });
  await sidebar.getByRole('button', { name: `${module.package},`, exact: false }).click();
  await expect(sidebar.getByRole('button', { name: original, exact: true })).toBeVisible();

  const renamed = 'ReviewRenamedMethod';
  await page.getByRole('button', { name: 'Fit to view', exact: true }).click();
  await page.locator('.flow-class-header').getByRole('button', { name: original, exact: true }).dblclick();
  const input = page.getByRole('textbox', { name: 'Class name', exact: true });
  await input.fill(renamed);
  await input.press('Enter');
  await expect(sidebar.getByRole('button', { name: renamed, exact: true })).toBeVisible({ timeout: 60000 });
  await expect(sidebar.getByRole('button', { name: original, exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: renamed, exact: true }).click();
  await expect(page.locator('.flow-title').filter({ hasText: renamed })).toBeVisible();

  // At the CI viewport, fitting the entire graph can place the class actions
  // behind the selection panel. Focus the card using the normal canvas control.
  await page.getByRole('button', { name: 'Zoom to class', exact: true }).click();
  await page.locator('.flow-class').filter({ has: page.locator('.flow-title').getByText(renamed, { exact: true }) }).getByRole('button', { name: '+ Add subclass', exact: true }).click();
  const form = page.getByRole('form', { name: 'Add subclass', exact: true });
  await form.getByRole('textbox', { name: 'Name', exact: true }).fill('ReviewAddedClass');
  await form.getByRole('button', { name: 'Add subclass', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: 'ReviewAddedClass', exact: true })).toBeVisible({ timeout: 60000 });
  await sidebar.getByRole('button', { name: 'ReviewAddedClass', exact: true }).click();
  await expect(page.locator('.flow-title').filter({ hasText: 'ReviewAddedClass' })).toBeVisible();
  await sidebar.getByRole('button', { name: renamed, exact: true }).click();
  await page.getByRole('button', { name: 'Show edit history', exact: true }).click();
  const backupPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download edits', exact: true }).click();
  const backup = await downloadBytes(await backupPromise);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect(sidebar.getByRole('button', { name: 'ReviewAddedClass', exact: true })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: renamed, exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Backup file', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await expect(page.getByText('Restored 2 edits.', { exact: true })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'ReviewAddedClass', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: profile.label, exact: true }).click();
  await expect(page.locator('.overview-card').filter({ has: page.getByText(module.package, { exact: true }) }).getByRole('button', { name: renamed, exact: true })).toBeVisible();
});
