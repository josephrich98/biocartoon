import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const assets = [
  { id: 'BA1', title: 'Pyramidal neuron', source: 'bioart', license: 'PD', credit: 'NIH BioArt, public domain', url: 'https://assets.biocartoon.com/neuron.png', svg_url: 'https://assets.biocartoon.com/neuron.svg' },
  { id: 'BA2', title: 'Stem cell', source: 'user', license: 'CC0-1.0', credit: 'BioCartoon, CC0', url: 'https://assets.biocartoon.com/cell.png' },
  { id: 'BA3', title: 'Heart', source: 'servier', license: 'CC-BY-4.0', credit: 'Servier Medical Art, CC BY 4.0', url: 'https://assets.biocartoon.com/heart.png' },
];
let server, browser, address;
before(async () => {
  const html = await readFile(new URL('../dist/gallery.html', import.meta.url));
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/gallery' ? html : '<!doctype html><iframe title="BioCartoon" src="/gallery" style="border:0;width:100%;height:1400px"></iframe>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width ?? 900, height: 1100 } });
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.route('https://assets.biocartoon.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="35" fill="#a8c9c0" stroke="#285b45" stroke-width="2"/><circle cx="55" cy="45" r="12" fill="#d7b3ca"/></svg>' }));
  await page.addInitScript(({ assets, initial, denyClipboard }) => {
    if (window !== window.top) {
      if (denyClipboard) Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) } });
      return;
    }
    window.calls = []; window.nextAssets = assets; window.failSearch = false;
    window.addEventListener('message', event => {
      const m = event.data; if (!m || m.jsonrpc !== '2.0') return;
      window.calls.push(m);
      const reply = result => event.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, event.origin);
      if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1.0' }, hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: {} }, hostContext: { theme: 'light' } });
      else if (m.method === 'ui/notifications/initialized') {
        event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { ids: initial.map(a => a.id) } } }, event.origin);
        event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(initial) }], structuredContent: { assets: initial }, isError: false } }, event.origin);
      } else if (m.method === 'tools/call') reply(window.failSearch ? { content: [{ type: 'text', text: 'Catalog temporarily unavailable' }], isError: true } : { content: [], structuredContent: { assets: window.nextAssets }, isError: false });
      else if (m.id !== undefined) reply({});
    });
  }, { assets, initial: options.assets ?? assets, denyClipboard: options.denyClipboard ?? false });
  await page.goto(address);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#search-button')).toBeEnabled();
  await expect(frame.locator('#status')).toContainText('Selected illustrations');
  return { page, frame, pageErrors };
}

test('host handshake, selection, downloads, variants, and clipboard fallback', async () => {
  const { page, frame, pageErrors } = await open({ denyClipboard: true });
  try {
    await expect(frame.locator('.card')).toHaveCount(3);
    await frame.getByRole('button', { name: 'Select Pyramidal neuron' }).click();
    await expect(frame.locator('#selection')).toContainText('NIH BioArt, public domain');
    await expect.poll(() => page.evaluate(() => window.calls.find(c => c.method === 'ui/update-model-context')?.params.structuredContent.selectedAsset.id)).toBe('BA1');
    await frame.locator('#selection').getByRole('link', { name: 'SVG' }).click();
    await expect.poll(() => page.evaluate(() => window.calls.find(c => c.method === 'ui/open-link')?.params.url)).toBe(assets[0].svg_url);
    await frame.locator('.card').first().getByText('Credit & license').click();
    await frame.locator('.card').first().getByRole('button', { name: 'Copy credit' }).click();
    await expect(frame.locator('.card').first()).toContainText('Select the credit text to copy');
    await frame.getByRole('button', { name: 'Other colours & styles' }).click();
    await expect.poll(() => page.evaluate(() => {
      const p = window.calls.find(c => c.method === 'tools/call')?.params;
      return p && { name: p.name, arguments: p.arguments };
    })).toEqual({ name: 'asset_variants', arguments: { id: 'BA1' } });
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});

test('filtered search, empty results, and recoverable server errors', async () => {
  const { page, frame } = await open();
  try {
    await frame.getByRole('searchbox', { name: 'Search illustrations', exact: true }).fill('heart');
    await frame.getByLabel('Collection').selectOption('servier');
    await page.evaluate(() => { window.nextAssets = []; });
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.locator('.empty')).toContainText('No illustrations found');
    assert.deepEqual(await page.evaluate(() => window.calls.find(c => c.method === 'tools/call').params.arguments), { query: 'heart', sources: ['servier'], limit: 12 });
    await page.evaluate(() => { window.failSearch = true; });
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.getByRole('alert')).toContainText('Catalog temporarily unavailable');
    await expect(frame.locator('#search-button')).toBeEnabled();
    await page.evaluate(assets => { window.failSearch = false; window.nextAssets = assets; }, assets);
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.locator('.card')).toHaveCount(3);
    await expect(frame.getByRole('alert')).toBeHidden();
  } finally { await page.close(); }
});

test('untrusted text and URLs, host theme changes, and mobile layout', async () => {
  const unsafe = { ...assets[0], title: '<img src=x onerror="alert(1)">', url: 'javascript:alert(1)', svg_url: 'https://evil.example/a.svg', thumb_url: 'https://assets.biocartoon.com.evil.example/a.png' };
  const { page, frame, pageErrors } = await open({ assets: [unsafe, assets[1]], width: 375 });
  try {
    await expect(frame.locator('.card').first().locator('h2')).toHaveText(unsafe.title);
    await expect(frame.locator('.card').first().locator('img,a')).toHaveCount(0);
    await page.evaluate(() => document.querySelector('iframe').contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'dark' } }, location.origin));
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
    const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});
