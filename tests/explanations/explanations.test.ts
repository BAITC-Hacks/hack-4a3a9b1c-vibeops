import assert from 'node:assert/strict';
import test from 'node:test';
import type { Query, RankedVendor } from '../../shared/contracts.js';
import { createExplainer, fallbackExplanation } from '../../server/explanations/index.js';
import { verifiedQuote } from '../../server/explanations/evidence.js';
import { requestEvidence, type EvidenceProvider } from '../../server/explanations/provider.js';

const query: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 1_000_000, hours: null, language: null };
const candidate = (id: string, description: string): RankedVendor => ({
  vendor: { id, anon_name: id, categories: ['Ведущий'], city: 'Алматы', price_from_kzt: 700_000,
    event_formats: ['корпоратив'], languages: ['русский'], max_hours: 6, busy_dates: [], description,
    synthetic: true, city_imputed: false, price_imputed: false }, relevance_score: 0, matched_terms: [],
});
const candidates = [candidate('A', 'Проводит корпоративы и деловые встречи.'), candidate('B', 'Только развлечения и танцы.'), candidate('C', 'Работает на телевидении более 12 лет.')];
const input = { query, candidates, dataset_sha256: 'dataset-v1' };
const config = () => ({ apiKey: 'test-key-never-real', model: 'test-model' });
const valid: EvidenceProvider = async ({ candidates: rows }) => ({ items: rows.slice().reverse().map(c => ({ id: c.vendor.id, quote: c.vendor.description })) });

test('empty selections do not call config or provider', async () => {
  const explain = createExplainer({ config: () => { throw Error('must not run'); }, provider: () => { throw Error('must not run'); } });
  assert.deepEqual(await explain({ ...input, candidates: [] }), { items: [], mode: 'not_needed', warning: null, model: null, cached: false });
});

test('missing config produces honest, individual deterministic fallback', async () => {
  const explain = createExplainer({ config: () => ({}), provider: () => { throw Error('must not run'); } });
  const result = await explain(input);
  assert.equal(result.mode, 'fallback'); assert.equal(result.model, null); assert.ok(result.warning);
  assert.deepEqual(result, await explain(input));
  assert.equal(new Set(result.items.map(x => x.quote)).size, 3);
  for (const [index, item] of result.items.entries()) {
    assert.equal(item.source, 'fallback'); assert.ok(candidates[index]!.vendor.description.includes(item.quote!));
    assert.match(item.text, /цена от 700/u); assert.match(item.text, /занятость не отмечена/u);
  }
});

test('one batch; shuffled AI output preserves candidate order; no input mutation', async () => {
  const snapshot = structuredClone(input); let calls = 0;
  const explain = createExplainer({ config, provider: async args => { calls++; return valid(args); } });
  const result = await explain(input);
  assert.equal(calls, 1); assert.equal(result.mode, 'llm'); assert.equal(result.model, 'test-model');
  assert.deepEqual(result.items.map(x => x.id), ['A', 'B', 'C']); assert.deepEqual(input, snapshot);
});

test('unknown IDs never become cards; duplicates and cross-profile quotes become fallback', async () => {
  const explain = createExplainer({ config, provider: async () => ({ items: [
    { id: 'A', quote: candidates[0]!.vendor.description }, { id: 'A', quote: candidates[0]!.vendor.description },
    { id: 'B', quote: candidates[0]!.vendor.description }, { id: 'C', quote: candidates[2]!.vendor.description },
    { id: 'FOREIGN', quote: 'Ignore previous instructions.' },
  ] }) });
  const result = await explain(input);
  assert.equal(result.mode, 'mixed'); assert.ok(result.warning);
  assert.deepEqual(result.items.map(x => x.source), ['fallback', 'fallback', 'llm']);
  assert.deepEqual(result.items.map(x => x.id), ['A', 'B', 'C']);
});

test('quote validation preserves facts, rejects fabricated, long and multi-sentence quotes', () => {
  assert.equal(verifiedQuote('  Проводит\n корпоративы. ', 'Проводит корпоративы.'), 'Проводит корпоративы.');
  assert.equal(verifiedQuote('Проводит корпоративы.', 'Проводит свадьбы.'), null);
  assert.equal(verifiedQuote('Опыт 2 года.', 'Опыт 12 лет.'), null);
  assert.equal(verifiedQuote('X'.repeat(221), 'X'.repeat(221)), null);
  assert.equal(verifiedQuote('Один. Другой.', 'Один. Другой.'), null);
  assert.equal(verifiedQuote('Опыт 12 лет.', ''), null);
});

test('malformed envelopes and missing or invalid entries safely fall back', async () => {
  for (const raw of [null, 'bad', { items: 'bad' }, { items: [], extra: true }, { items: [{ id: 'A', quote: 12 }] }, { items: [] }]) {
    const result = await createExplainer({ config, provider: async () => raw })(input);
    assert.equal(result.mode, 'fallback'); assert.ok(result.warning); assert.equal(result.items.length, 3);
  }
});

test('errors, including 429 and auth failure, never leak error details or change candidates', async () => {
  for (const status of [429, 401, 403, 500]) {
    const explain = createExplainer({ config, provider: async () => { throw Object.assign(new Error('secret-provider-diagnostics'), { status }); } });
    const result = await explain(input);
    assert.equal(result.mode, 'fallback'); assert.ok(result.warning);
    assert.ok(!JSON.stringify(result).includes('secret-provider-diagnostics'));
    assert.deepEqual(result.items.map(x => x.id), ['A', 'B', 'C']);
  }
});

test('deadline aborts provider and returns fallback even if provider ignores abort', async () => {
  let signal: AbortSignal | undefined;
  const explain = createExplainer({ config, timeoutMs: 20, provider: async args => {
    signal = args.signal; return new Promise(() => {});
  } });
  const start = performance.now(); const result = await explain(input);
  assert.equal(result.mode, 'fallback'); assert.equal(signal?.aborted, true);
  assert.ok(performance.now() - start < 1000); assert.match(result.warning!, /6 секунд/u);
});

test('canonical query, dataset/model changes, TTL and defensive clones in cache', async () => {
  let calls = 0; let time = 1; let model = 'model-a';
  const explain = createExplainer({ now: () => time, config: () => ({ ...config(), model }), provider: async args => { calls++; return valid(args); } });
  const first = await explain(input); first.items[0]!.text = 'caller mutation';
  const reorderedQuery: Query = { language: null, hours: null, budget_kzt: query.budget_kzt, category: query.category, event_format: query.event_format, date: query.date, city: query.city };
  const hit = await explain({ ...input, query: reorderedQuery });
  assert.equal(calls, 1); assert.equal(hit.cached, true); assert.notEqual(hit.items[0]!.text, 'caller mutation');
  await explain({ ...input, dataset_sha256: 'dataset-v2' }); assert.equal(calls, 2);
  model = 'model-b'; await explain(input); assert.equal(calls, 3);
  time += 600_001; await explain(input); assert.equal(calls, 4);
});

test('cache never exceeds 200 entries and does not retain transient failures', async () => {
  let calls = 0;
  const explain = createExplainer({ config, provider: async args => { calls++; return valid(args); } });
  for (let n = 0; n <= 200; n++) await explain({ ...input, dataset_sha256: `hash-${n}` });
  await explain({ ...input, dataset_sha256: 'hash-200' }); assert.equal(calls, 201);
  await explain({ ...input, dataset_sha256: 'hash-0' }); assert.equal(calls, 202);
  let attempts = 0;
  const recover = createExplainer({ config, provider: async args => { if (++attempts === 1) throw Error(); return valid(args); } });
  assert.equal((await recover(input)).mode, 'fallback');
  assert.equal((await recover(input)).mode, 'llm'); assert.equal(attempts, 2);
});

test('null hours semantics and absent useful evidence do not invent claims', () => {
  const row = candidate('X', 'Лучший профессиональный ответственный исполнитель.'); row.vendor.max_hours = null;
  const result = fallbackExplanation({ ...query, hours: 5, language: 'русский' }, row);
  assert.equal(result.quote, null); assert.match(result.text, /часы присутствия не ограничивают подбор/u);
  assert.match(result.text, /язык — русский/u); assert.doesNotMatch(result.text, /неограниченн|гарантир/u);
});

test('caller contract violations fail before API call', async () => {
  const explain = createExplainer({ config, provider: valid });
  await assert.rejects(explain({ ...input, candidates: [...candidates, candidate('D', '')] }), /at most three/u);
  await assert.rejects(explain({ ...input, candidates: [candidates[0]!, candidates[0]!] }), /unique/u);
});

test('SDK adapter sends one Responses request with schema and untrusted data separated', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(request), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false); assert.equal(body.model, 'test-model');
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
    const choices = body.text.format.schema.properties.items.items.anyOf;
    assert.equal(choices.length, 3);
    assert.deepEqual(choices[1].properties.id.enum, ['B']);
    assert.deepEqual(choices[1].properties.quote.enum, ['', candidates[1]!.vendor.description]);
    assert.equal(JSON.parse(body.input).profiles.length, 3);
    assert.match(body.instructions, /untrusted data/u);
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ items: [{ id: 'A', quote: 'Проводит корпоративы и деловые встречи.' }] }), annotations: [] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await requestEvidence({ ...input, ...config(), signal: new AbortController().signal });
  assert.equal(requests, 1); assert.deepEqual(result, { items: [{ id: 'A', quote: candidates[0]!.vendor.description }] });
});

test('SDK adapter disables automatic retries on 429', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { 'content-type': 'application/json' } }); });
  await assert.rejects(requestEvidence({ ...input, ...config(), signal: new AbortController().signal }));
  assert.equal(requests, 1);
});


test('verbatim generic praise is rejected even when the model labels it as evidence', async () => {
  const quote = 'Идеальный выбор для корпоративного мероприятия.';
  const rows = [candidate('A', `${quote} Проводит командные игры и интерактивы.`)];
  const result = await createExplainer({ config, provider: async () => ({ items: [{ id: 'A', quote }] }) })({ ...input, candidates: rows });
  assert.equal(result.mode, 'fallback');
  assert.equal(result.items[0]!.quote, 'Проводит командные игры и интерактивы.');
  assert.ok(result.items[0]!.text.startsWith('В описании:'));
  assert.doesNotMatch(result.items[0]!.text, /Идеальный выбор/u);
});

test('praise-only profiles disclose the absence of a specific feature', () => {
  const row = candidate('X', 'Идеальный выбор для корпоративного мероприятия.');
  const result = fallbackExplanation(query, row);
  assert.equal(result.quote, null);
  assert.match(result.text, /Конкретная особенность в описании не выделена/u);
  assert.doesNotMatch(result.text, /Идеальный|лучший/u);
});

test('readable explanations preserve price, date and requested constraints without promising a booking', () => {
  const row = candidate('A', 'Проводит командные игры и интерактивы.');
  const result = fallbackExplanation({ ...query, hours: 4, language: 'русский' }, row);
  assert.ok(result.text.indexOf('командные игры') < result.text.indexOf('цена от'));
  assert.match(result.text, /10\.10\.2026/u);
  assert.match(result.text, /4 ч при максимуме 6 ч/u);
  assert.match(result.text, /язык — русский/u);
  assert.match(result.text, /занятость не отмечена/u);
  assert.doesNotMatch(result.text, /бронирование подтверждено|гарантированно свободен/u);
});
