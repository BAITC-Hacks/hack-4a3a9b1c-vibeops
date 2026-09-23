import 'dotenv/config';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/app.js';
import { loadCatalog } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import type { AssistantBrief, AssistantComparison } from '../../shared/assistant.js';
import type { RecommendResponse } from '../../shared/contracts.js';

// Explicit opt-in, excluded from npm test. Logs only safe results, never transport errors or keys.
if (!process.argv.includes('--live') || !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
  console.error('Use --live with server OPENAI_API_KEY and OPENAI_MODEL configured.');
  process.exit(1);
}
const catalog = loadCatalog('data/vendors.csv');
const server = createServer(createApp(catalog));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const error = await response.json() as { error?: { code?: string } };
    throw new Error(`HTTP ${response.status} ${error.error?.code ?? 'REQUEST_ERROR'}`);
  }
  return response.json() as Promise<T>;
}

try {
  const start = performance.now();
  const first = 'Нужен ведущий на корпоратив в Алматы.';
  const partial = await post<AssistantBrief>('/api/assistant/brief', { messages: [first] });
  assert.equal(partial.source, 'llm');
  assert.equal(partial.query, null);
  assert.equal(partial.draft.date, null);
  assert.equal(partial.draft.budget_kzt, null);
  assert.ok(partial.questions.length);
  console.log(JSON.stringify({ case: 'missing_information', source: partial.source, questions: partial.questions, ms: Math.round(performance.now() - start) }));

  const messages = [first, '10 октября 2026 года, бюджет до 500 тысяч тенге за ведущего, на русском языке, на 5 часов. Хочу интерактивы и живую музыку.'];
  const completed = await post<AssistantBrief>('/api/assistant/brief', { messages });
  assert.deepEqual(completed.query, { city: 'Алматы', category: 'Ведущий', event_format: 'корпоратив', date: '2026-10-10', budget_kzt: 500000, language: 'русский', hours: 5 });
  assert.ok(completed.preferences.length);
  console.log(JSON.stringify({ case: 'clarification', source: completed.source, model: completed.model, query: completed.query, preferences: completed.preferences }));

  const recommendation = await post<RecommendResponse>('/api/recommend', completed.query);
  const expected = selectVendors(catalog.vendors, completed.query!).ranked.slice(0, 3).map(item => item.vendor.id);
  assert.deepEqual(recommendation.cards.map(card => card.id), expected);
  assert.ok(expected.length);
  const comparison = await post<AssistantComparison>('/api/assistant/compare', { query: completed.query, preferences: completed.preferences });
  assert.equal(comparison.source, 'llm');
  assert.deepEqual(comparison.items.map(item => item.id), expected);
  for (const item of comparison.items) {
    const vendor = catalog.vendors.find(vendor => vendor.id === item.id)!;
    for (const evidence of item.evidence) {
      assert.ok(vendor.description.includes(evidence.quote));
      assert.ok(completed.preferences.includes(evidence.preference));
    }
    assert.equal(item.evidence.length + item.to_confirm.length, completed.preferences.length);
  }
  console.log(JSON.stringify({ case: 'search_and_preferences', ids: expected, source: comparison.source, items: comparison.items }));

  const nuanced = await post<AssistantBrief>('/api/assistant/brief', { messages: ['Нужен ведущий на корпоратив в Алматы 10 октября 2026 года, бюджет 1 миллион тенге, на русском языке, на 5 часов. Хочу интеллигентный юмор, танцы и программу без долгих речей.'] });
  assert.equal(nuanced.query?.budget_kzt, 1000000);
  const nuancedComparison = await post<AssistantComparison>('/api/assistant/compare', { query: nuanced.query, preferences: nuanced.preferences });
  assert.equal(nuancedComparison.items.length, 3);
  assert.ok(nuancedComparison.items.some(item => item.evidence.length), 'real profiles should provide evidence for at least one of these wishes');
  for (const item of nuancedComparison.items) {
    const vendor = catalog.vendors.find(vendor => vendor.id === item.id)!;
    assert.ok(item.evidence.every(evidence => vendor.description.includes(evidence.quote)));
  }
  console.log(JSON.stringify({ case: 'distinct_preferences', source: nuancedComparison.source, preferences: nuanced.preferences, items: nuancedComparison.items }));

  const correction = await post<AssistantBrief>('/api/assistant/brief', { messages: [...messages, 'Изменение: дата 11 октября 2026, бюджет 700 тысяч тенге. Остальное без изменений.'] });
  assert.equal(correction.query?.date, '2026-10-11');
  assert.equal(correction.query?.budget_kzt, 700000);
  assert.equal(correction.query?.city, 'Алматы');
  console.log(JSON.stringify({ case: 'correction', query: correction.query }));
  console.log('AI_ASSISTANT_LIVE_PASS');
} catch (error) {
  console.error(error instanceof assert.AssertionError ? `CHECK_FAILED: ${error.message}` : error instanceof Error && error.message.startsWith('HTTP ') ? error.message : 'LIVE_CHECK_FAILED');
  process.exitCode = 1;
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
