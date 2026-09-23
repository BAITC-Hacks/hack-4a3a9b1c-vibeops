import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalog } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import { requestBrief } from '../../server/explanations/assistant-brief.js';
import { requestComparison } from '../../server/explanations/assistant-compare.js';
import { requestEvidence } from '../../server/explanations/provider.js';
import type { Query } from '../../shared/contracts.js';
import { catalogOptions } from '../../server/catalog.js';

test('all AI adapters use low reasoning on Astra and preserve legacy request compatibility', async t => {
  const catalog = loadCatalog('data/vendors.csv');
  const query: Query = { city: 'Алматы', category: 'Ведущий', event_format: 'корпоратив', date: '2026-10-10', budget_kzt: 1000000, hours: null, language: null };
  const candidates = selectVendors(catalog.vendors, query).ranked.slice(0, 3);
  const bodies: Record<string, any>[] = [];
  t.mock.method(globalThis, 'fetch', async (_request: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}', annotations: [] }] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const models = ['gpt-6-astra', 'gpt-4.1-mini', 'gpt-6-sol'];
  for (const model of models) {
    const connection = { model, apiKey: 'test-not-real', signal: new AbortController().signal };
    await requestBrief({ ...connection, messages: ['Нужен ведущий'], options: catalogOptions(catalog) });
    await requestEvidence({ ...connection, query, candidates });
    await requestComparison({ ...connection, query, candidates, preferences: ['интерактивы'] });
  }
  assert.equal(bodies.length, 9);
  for (const [index, body] of bodies.entries()) {
    assert.equal(body.model, models[Math.floor(index / 3)]);
    assert.deepEqual(body.reasoning, index < 3 ? { effort: 'low' } : undefined);
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_p, undefined);
  }
  assert.deepEqual(bodies.map(body => body.max_output_tokens), models.flatMap(() => [2200, 1200, 4000]));
});
