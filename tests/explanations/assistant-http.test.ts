import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { loadCatalog } from '../../server/catalog.js';
import { AssistantError, createBriefAssistant } from '../../server/explanations/assistant-brief.js';
import { createComparisonAssistant } from '../../server/explanations/assistant-compare.js';
import { selectVendors } from '../../server/matching.js';
import type { Query, RecommendResponse } from '../../shared/contracts.js';

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

test('real comparison handler over HTTP preserves selected IDs and isolates model failures from search', async t => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  let failure: 'none' | 'quote' | 'provider' = 'none';
  const compare = createComparisonAssistant({
    config: () => ({ apiKey: 'unit-test-key', model: 'unit-test-model' }),
    provider: async ({ candidates, preferences }) => {
      if (failure === 'provider') throw new Error('private-provider-error');
      return { items: candidates.slice().reverse().map(({ vendor }) => ({
        id: vendor.id,
        evidence: failure === 'quote' ? [{ preference: preferences[0], quote: 'Invented private-provider-error quote.' }] : [],
      })) };
    },
  });
  const server = createServer(createApp(catalog, { brief: createBriefAssistant({ config: () => ({}) }), compare }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const query: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 1_000_000, hours: null, language: null };
  const expected = selectVendors(catalog.vendors, query).ranked.slice(0, 3).map(item => item.vendor.id);
  const preferences = ['Без пошлых конкурсов'];
  const original = await (await post('/api/recommend', query)).json() as RecommendResponse;
  assert.deepEqual(original.cards.map(card => card.id), expected);
  const success = await post('/api/assistant/compare', { query, preferences });
  assert.equal(success.status, 200);
  const comparison = await success.json();
  assert.deepEqual(comparison.items.map((item: { id: string }) => item.id), expected);
  assert.ok(comparison.items.every((item: { evidence: unknown[]; to_confirm: string[] }) => item.evidence.length === 0 && item.to_confirm[0] === preferences[0]));
  for (const [mode, status, code] of [['quote', 502, 'AI_INVALID_RESPONSE'], ['provider', 503, 'AI_UNAVAILABLE']] as const) {
    failure = mode;
    const response = await post('/api/assistant/compare', { query, preferences });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.source, undefined);
    assert.doesNotMatch(JSON.stringify(body), /private-provider-error|unit-test-key/u);
    const search = await post('/api/recommend', query);
    assert.equal(search.status, 200);
    const result = await search.json() as RecommendResponse;
    assert.deepEqual(result.cards, original.cards);
    assert.equal(result.explanation.mode, 'fallback');
  }
});
