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
const templates = [{ id: 't1', title: 'Cell signaling', license: 'CC0-1.0', author: 'Ann', thumb_url: 'https://assets.biocartoon.com/templates/t1.png' }];
const figure = {
  title: 'Neuron to heart', layout: 'flow', width: 960, height: 400, credits: ['NIH BioArt, public domain', 'Servier Medical Art, CC BY 4.0'],
  spec: { title: 'Neuron to heart', layout: 'auto', elements: [{ id: 'e1', label: 'Neuron', query: 'neuron', asset_id: 'BA1' }, { id: 'e2', label: 'Heart', query: 'heart', asset_id: 'BA3' }, { id: 'e3', label: 'Zebrafish', query: 'zebrafish', placeholder: true }], connections: [{ from: 'e1', to: 'e2', kind: 'arrow', label: '' }], sources: [] },
  elements: [{ id: 'e1', label: 'Neuron', match: 'chosen', asset: assets[0] }, { id: 'e2', label: 'Heart', match: 'strong', asset: assets[2] }, { id: 'e3', label: 'Zebrafish', match: 'none' }],
  preview_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 400" width="960" height="400" onload="alert(1)"><rect width="100%" height="100%" fill="#fff"/><image x="100" y="100" width="150" height="150" href="https://assets.biocartoon.com/neuron.png"/><image x="400" y="100" width="150" height="150" href="https://evil.example/x.png"/><script>alert(1)</script><foreignObject><div>x</div></foreignObject><path d="M260 175 L390 175" stroke="#3c4850" stroke-width="3"/><text x="175" y="280" font-size="16" text-anchor="middle"><tspan x="175" dy="0">Neuron</tspan></text></svg>',
  open_url: 'https://app.biocartoon.com/#share=AbC-_0123456789abcdefg.key',
};
let server, browser, address;
before(async () => {
  const html = await readFile(new URL('../dist/gallery.html', import.meta.url));
  server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(req.url === '/gallery' ? html : '<!doctype html><body style="margin:0"><iframe title="BioCartoon" src="/gallery" style="border:0;width:100%;height:1500px"></iframe>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  address = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

export async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: options.width ?? 960, height: 1100 }, colorScheme: options.scheme ?? 'light', hasTouch: options.touch ?? false });
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.route('https://assets.biocartoon.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="35" fill="#a8c9c0" stroke="#285b45" stroke-width="2"/><circle cx="55" cy="45" r="12" fill="#d7b3ca"/></svg>' }));
  await page.addInitScript(({ assets, templates, initial, denyClipboard, theme, downloads }) => {
    if (window !== window.top) {
      if (denyClipboard) Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Denied')) } });
      return;
    }
    window.calls = []; window.nextAssets = assets; window.failSearch = false;
    window.addEventListener('message', event => {
      const m = event.data; if (!m || m.jsonrpc !== '2.0') return;
      window.calls.push(m);
      const reply = result => event.source.postMessage({ jsonrpc: '2.0', id: m.id, result }, event.origin);
      if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1.0' }, hostCapabilities: { serverTools: {}, openLinks: {}, updateModelContext: {}, message: {}, ...(downloads ? { downloadFile: {} } : {}) }, hostContext: { theme } });
      else if (m.method === 'ui/notifications/initialized') {
        event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'result' }], structuredContent: initial, isError: false } }, event.origin);
      } else if (m.method === 'tools/call') {
        const { name, arguments: args } = m.params;
        if (window.failSearch && name === 'search_assets') return reply({ content: [{ type: 'text', text: 'Catalog temporarily unavailable' }], isError: true });
        const results = {
          search_assets: { content: [], structuredContent: { assets: window.nextAssets } },
          list_templates: { content: [], structuredContent: { templates } },
          list_sources: { content: [{ type: 'text', text: JSON.stringify([{ source: 'bioart', name: 'NIAID NIH BioArt Source', count: 900, licenses: 'PD' }, { source: 'servier', name: 'Servier', count: 3000, licenses: 'CC-BY-4.0' }]) }] },
          list_categories: { content: [{ type: 'text', text: JSON.stringify([{ name: 'Cells', count: 12 }, { name: 'Organs', count: 4 }]) }] },
          open_in_biocartoon: { content: [], structuredContent: { url: `https://app.biocartoon.com/#share=${args.asset_id ?? args.template_id ?? 'fig'}` } },
          export_figure: { content: [], structuredContent: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 400" width="960" height="400"><rect width="100%" height="100%" fill="#fff"/></svg>', filename: 'x.svg' } },
        };
        reply({ isError: false, ...results[name] });
      }
      else if (m.id !== undefined) reply({});
    });
  }, { assets, templates, initial: options.initial ?? { assets }, denyClipboard: options.denyClipboard ?? false, theme: options.scheme ?? 'light', downloads: options.downloads ?? true });
  await page.goto(address);
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#search-button')).toBeEnabled();
  const calls = (method, name) => page.evaluate(([method, name]) => window.calls.filter(c => c.method === method && (!name || c.params?.name === name)).map(c => c.params), [method, name]);
  return { page, frame, pageErrors, calls };
}

test('cards: Edit sends a prompt, Download offers SVG/PNG, Open makes an editor link, credit copies', async () => {
  const { page, frame, pageErrors, calls } = await open({ denyClipboard: true });
  try {
    await expect(frame.locator('.card')).toHaveCount(3);
    const first = frame.locator('.card').first();
    await first.hover();
    await expect(first.getByRole('button', { name: 'Edit' })).toBeVisible();
    // Edit: the user writes the change; it goes to the chat as a message, with the asset as context.
    await first.getByRole('button', { name: 'Edit' }).click();
    await first.locator('textarea').fill('make it red');
    await first.getByRole('button', { name: 'Send' }).click();
    await expect.poll(async () => (await calls('ui/message'))[0]?.content[0].text).toBe('Edit BioCartoon illustration BA1 ("Pyramidal neuron"): make it red');
    assert.equal((await calls('ui/update-model-context')).at(-1).structuredContent.selectedAsset.id, 'BA1');
    // Download: SVG and PNG are host downloads of the published files.
    await first.hover();
    await first.getByRole('button', { name: 'Download' }).click();
    await first.getByRole('button', { name: 'SVG', exact: true }).click();
    await expect.poll(async () => (await calls('ui/download-file'))[0]?.contents[0]).toEqual({ type: 'resource_link', uri: assets[0].svg_url, name: 'pyramidal-neuron.svg', mimeType: 'image/svg+xml' });
    // A PNG-only icon has no SVG choice.
    const second = frame.locator('.card').nth(1);
    await second.hover(); await second.getByRole('button', { name: 'Download' }).click();
    await expect(second.getByRole('button', { name: 'SVG', exact: true })).toBeDisabled();
    // Open in BioCartoon asks the server for an editor link, then opens it.
    await first.hover();
    await first.getByRole('button', { name: 'Open in BioCartoon' }).click();
    await expect.poll(async () => (await calls('ui/open-link'))[0]?.url).toBe('https://app.biocartoon.com/#share=BA1');
    assert.deepEqual((await calls('tools/call', 'open_in_biocartoon'))[0].arguments, { asset_id: 'BA1' });
    // Credit & license: a dropdown with a copy button, falling back to selecting the text.
    await first.getByText('Credit & license').click();
    await expect(first.locator('.credit')).toContainText('NIH BioArt, public domain');
    await first.getByRole('button', { name: 'Copy' }).click();
    await expect(first.locator('.credit')).toContainText('Select and copy');
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});

test('search row with sort and filters searches icons and templates', async () => {
  const { page, frame, calls } = await open();
  try {
    await frame.getByRole('searchbox', { name: 'Search illustrations' }).fill('heart');
    // The top row is just the search bar, Filters and Search; sorting is in the filter menu.
    await expect(frame.getByLabel('Sort')).toBeHidden();
    await frame.getByRole('button', { name: 'Filters' }).click();
    await expect(frame.locator('#filters')).toBeVisible();
    await frame.getByLabel('Sort').selectOption('popular');
    await expect(frame.locator('#f-source option')).toHaveCount(3);
    await frame.getByLabel('Database').selectOption('servier');
    await expect(frame.locator('#f-category')).toBeEnabled();
    await frame.getByLabel('Category').selectOption('Organs');
    await frame.getByLabel('License').selectOption('CC-BY-4.0');
    await frame.getByLabel('File type').selectOption('svg');
    await frame.getByLabel('Author').fill('Ann, Bo');
    await frame.getByLabel('Tags').fill('organ, cardio');
    await expect(frame.locator('#filter-count')).toHaveText('6');
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'Template results' })).toBeVisible();
    await expect(frame.getByRole('heading', { name: 'Icon results for “heart”' })).toBeVisible();
    assert.deepEqual((await calls('tools/call', 'search_assets')).at(-1).arguments, { query: 'heart', limit: 24, sort: 'popular', sources: ['servier'], licenses: ['CC-BY-4.0'], author: 'Ann, Bo', category: 'Organs', file_type: 'svg', tags: ['organ', 'cardio'] });
    // Templates open as an editor copy too.
    const t = frame.getByRole('region', { name: 'Template results' }).locator('.card');
    await t.hover(); await t.getByRole('button', { name: 'Open in BioCartoon' }).click();
    await expect.poll(async () => (await calls('ui/open-link')).at(-1)?.url).toBe('https://app.biocartoon.com/#share=t1');
    // Icons only; then a recoverable error.
    await frame.getByLabel('Artwork type').selectOption('icons');
    await page.evaluate(() => { window.failSearch = true; });
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.getByRole('alert')).toContainText('Catalog temporarily unavailable');
    await page.evaluate(() => { window.failSearch = false; window.nextAssets = []; });
    await frame.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(frame.locator('.empty')).toContainText('Nothing found');
    await expect(frame.getByRole('heading', { name: 'Template results' })).toHaveCount(0);
    await frame.getByRole('button', { name: 'Clear filters' }).click();
    await expect(frame.locator('#filter-count')).toBeHidden();
  } finally { await page.close(); }
});

test('an empty search with no filters brings back the gallery it opened with', async () => {
  const { page, frame, calls } = await open();
  try {
    await expect(frame.locator('.card')).toHaveCount(3);
    const box = frame.getByRole('searchbox', { name: 'Search illustrations' });
    await page.evaluate(() => { window.nextAssets = [{ id: 'BA9', title: 'Kidney', source: 'servier', license: 'CC-BY-4.0', credit: 'Servier Medical Art, CC BY 4.0', url: 'https://assets.biocartoon.com/kidney.png' }]; });
    await box.fill('kidney'); await box.press('Enter');
    await expect(frame.getByRole('heading', { name: 'Icon results for “kidney”' })).toBeVisible();
    await expect(frame.locator('.card')).toHaveCount(2);
    const searches = (await calls('tools/call', 'search_assets')).length;
    await box.fill(''); await box.press('Enter');
    await expect(frame.getByRole('heading', { name: 'Selected illustrations' })).toBeVisible();
    await expect(frame.locator('.card')).toHaveCount(3);
    assert.equal((await calls('tools/call', 'search_assets')).length, searches);
    // With a filter set, an empty search still searches.
    await frame.getByRole('button', { name: 'Filters' }).click();
    await frame.getByLabel('File type').selectOption('svg');
    await box.press('Enter');
    await expect.poll(async () => (await calls('tools/call', 'search_assets')).length).toBe(searches + 1);
  } finally { await page.close(); }
});

test('a composed figure: sanitized preview, Edit with its spec, SVG and PNG downloads, editor link', async () => {
  const { page, frame, pageErrors, calls } = await open({ initial: { figure } });
  try {
    const panel = frame.getByRole('region', { name: 'Figure', exact: true });
    await expect(panel.getByRole('heading', { name: 'Neuron to heart' })).toBeVisible();
    await expect(panel.locator('svg image')).toHaveCount(2);
    await expect(panel.locator('svg image').nth(1)).not.toHaveAttribute('href', /.+/);
    await expect(panel.locator('svg script, svg foreignObject')).toHaveCount(0);
    assert.equal(await panel.locator('.media > svg').getAttribute('onload'), null);
    await expect(panel).toContainText('No library icon fits Zebrafish');
    await expect(frame.getByRole('region', { name: 'Icons in this figure' }).locator('.card')).toHaveCount(2);
    const c = panel.locator('.card');
    await c.hover(); await c.getByRole('button', { name: 'Open in BioCartoon' }).click();
    await expect.poll(async () => (await calls('ui/open-link'))[0]?.url).toBe(figure.open_url);
    await c.hover(); await c.getByRole('button', { name: 'Download' }).click();
    await c.getByRole('button', { name: 'SVG', exact: true }).click();
    await expect.poll(async () => (await calls('ui/download-file'))[0]?.contents[0].resource.uri).toBe('file:///neuron-to-heart.svg');
    assert.deepEqual((await calls('tools/call', 'export_figure'))[0].arguments, { figure: figure.spec });
    await c.getByRole('button', { name: 'PNG', exact: true }).click();
    await expect.poll(async () => (await calls('ui/download-file'))[1]?.contents[0].resource.mimeType).toBe('image/png');
    assert.match((await calls('ui/download-file'))[1].contents[0].resource.blob, /^iVBOR/);
    // The SVG was exported once and reused for the PNG.
    assert.equal((await calls('tools/call', 'export_figure')).length, 1);
    await c.hover(); await c.getByRole('button', { name: 'Edit' }).click();
    await c.locator('textarea').fill('add a lung after the heart');
    await c.locator('textarea').press('Control+Enter');
    await expect.poll(async () => (await calls('ui/message'))[0]?.content[0].text).toBe('Edit the BioCartoon figure "Neuron to heart": add a lung after the heart');
    const context = (await calls('ui/update-model-context')).at(-1);
    assert.match(context.content[0].text, /compose_figure/);
    assert.deepEqual(context.structuredContent.figure.spec, figure.spec);
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});

test('untrusted text and URLs, downloads without host support, dark theme, and phone layout', async () => {
  const unsafe = { ...assets[0], title: '<img src=x onerror="alert(1)">', url: 'javascript:alert(1)', svg_url: 'https://evil.example/a.svg', thumb_url: 'https://assets.biocartoon.com.evil.example/a.png' };
  const { page, frame, pageErrors, calls } = await open({ initial: { assets: [unsafe, assets[1]] }, width: 375, scheme: 'dark', downloads: false, touch: true });
  try {
    await expect(frame.locator('.card').first().locator('h3')).toHaveText(unsafe.title);
    await expect(frame.locator('.card').first().locator('img')).toHaveCount(0);
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
    // On touch screens the actions sit under the picture rather than on hover.
    await expect(frame.locator('.card').nth(1).getByRole('button', { name: 'Edit' })).toBeVisible();
    // Without host downloads, a file opens as a link instead.
    await frame.locator('.card').nth(1).getByRole('button', { name: 'Download' }).click();
    await frame.locator('.card').nth(1).getByRole('button', { name: 'PNG', exact: true }).click();
    await expect.poll(async () => (await calls('ui/open-link'))[0]?.url).toBe(assets[1].url);
    const overflow = await page.frames()[1].evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    assert.deepEqual(pageErrors, []);
  } finally { await page.close(); }
});
