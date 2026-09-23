import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { loadCatalog } from '../../server/catalog.js';
import { AssistantError, createBriefAssistant } from '../../server/explanations/assistant-brief.js';

const catalog = loadCatalog('data/vendors.csv');

test('assistant HTTP routes preserve explicit AI failures and JSON validation', async t => {
  const server = createServer(createApp(catalog, {
    brief: createBriefAssistant({ config: () => ({}) }),
    compare: async () => { throw new AssistantError(504, 'AI_TIMEOUT', 'AI не ответил вовремя.'); },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: string) => fetch(url + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });

  const invalid = await post('/api/assistant/brief', '{}');
  assert.equal(invalid.status, 422);
  assert.ok((await invalid.json()).error.message);
  const unavailable = await post('/api/assistant/brief', JSON.stringify({ messages: ['Нужен ведущий в Алматы.'] }));
  assert.equal(unavailable.status, 503);
  const failure = await unavailable.json();
  assert.ok(failure.error.code);
  assert.equal(failure.source, undefined);
  assert.equal(failure.query, undefined);
  const unicode = await post('/api/assistant/brief', JSON.stringify({ messages: Array(8).fill('界'.repeat(1000)) }));
  assert.equal(unicode.status, 503, 'valid 8000-character Unicode history must reach assistant config checks');
  const escaped = await post('/api/assistant/brief', '{"messages":["' + '\\u754c'.repeat(2000) + '","' + '\\u754c'.repeat(2000) + '","' + '\\u754c'.repeat(2000) + '","' + '\\u754c'.repeat(2000) + '"]}');
  assert.equal(escaped.status, 503, 'escaped JSON must preserve the same decoded character budget');
  const timeout = await post('/api/assistant/compare', '{}');
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).error.code, 'AI_TIMEOUT');
  const malformed = await post('/api/assistant/brief', '{');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'MALFORMED_JSON');
});

test('assistant cannot run without the authoritative catalog', async t => {
  let called = false;
  const server = createServer(createApp(null, {
    brief: async () => { called = true; throw new Error('must not call'); },
    compare: async () => { called = true; throw new Error('must not call'); },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (const action of ['brief', 'compare']) {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assistant/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'DATASET_UNAVAILABLE');
  }
  assert.equal(called, false);
});
