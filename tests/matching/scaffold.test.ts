import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadCatalog, catalogOptions } from '../../server/catalog.js';
import { createApp } from '../../server/app.js';

test('organizer CSV preserves 66 IDs, flags, multiple categories and null hours', () => {
  const catalog = loadCatalog('data/vendors.csv');
  assert.equal(catalog.vendors.length, 66);
  assert.equal(new Set(catalog.vendors.map(v => v.id)).size, 66);
  assert.equal(catalog.vendors.filter(v => v.synthetic).length, 13);
  assert.equal(catalog.vendors.filter(v => v.max_hours === null).length, 9);
  assert.equal(catalog.vendors.filter(v => v.city_imputed).length, 8);
  assert.equal(catalog.vendors.filter(v => v.price_imputed).length, 18);
  assert.ok(catalog.vendors.some(v => v.categories.length > 1));
  assert.equal(catalogOptions(catalog).categories.length, 17);
  assert.match(catalog.sha256, /^[0-9a-f]{64}$/);
});

async function serve(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('scaffold serves real health/options and explicitly marks unfinished matching', async t => {
  const server = createServer(createApp(loadCatalog('data/vendors.csv')));
  const url = await serve(server); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.dataset_count, 66); assert.equal(health.status, 'ok');
  const options = await (await fetch(`${url}/api/options`)).json();
  assert.deepEqual(options.cities, ['Алматы', 'Астана', 'Зарубежье']);
  assert.equal(options.date_min, '2026-09-23'); assert.equal(options.categories.length, 17);
  const result = await fetch(`${url}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 501); assert.equal((await result.json()).error.code, 'NOT_IMPLEMENTED');
  const malformed = await fetch(`${url}/api/recommend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'MALFORMED_JSON');
});

test('missing dataset is an explicit 503, not a successful empty catalog', async t => {
  const server = createServer(createApp(null)); const url = await serve(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (const path of ['/api/health', '/api/options']) {
    const response = await fetch(url + path); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DATASET_UNAVAILABLE');
  }
});
