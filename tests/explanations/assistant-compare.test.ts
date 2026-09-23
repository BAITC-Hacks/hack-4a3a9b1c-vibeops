import assert from 'node:assert/strict';
import test from 'node:test';
import type { Query, Vendor } from '../../shared/contracts.js';
import type { Catalog } from '../../server/catalog.js';
import { loadCatalog } from '../../server/catalog.js';
import { AssistantError } from '../../server/explanations/assistant-brief.js';
import { createComparisonAssistant, requestComparison, type ComparisonProvider } from '../../server/explanations/assistant-compare.js';
import { selectVendors } from '../../server/matching.js';

const query: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 500_000, hours: 4, language: null };
const vendor = (id: string, description: string, price: number): Vendor => ({
  id, anon_name: `Исполнитель ${id}`, categories: ['Ведущий'], city: 'Алматы', price_from_kzt: price,
  event_formats: ['корпоратив'], languages: ['русский'], max_hours: 6, busy_dates: [], description,
  synthetic: true, city_imputed: false, price_imputed: false,
});
const a = vendor('A', 'Проводит интерактивные командные игры.', 100_000);
const b = vendor('B', 'Импровизирует и играет на саксофоне.', 200_000);
const c = vendor('C', 'Ведёт церемонии в спокойном разговорном стиле.', 300_000);
const d = vendor('D', 'Предлагает детскую программу с аниматорами.', 400_000);
const catalog: Catalog = { vendors: [d, c, a, b], sha256: 'comparison-test' };
const preferences = ['Командные игры', 'Без пошлых конкурсов'];
const input = { query, preferences };
const config = () => ({ apiKey: 'test-key-never-real', model: 'test-model' });
const valid: ComparisonProvider = async ({ candidates }) => ({ items: candidates.slice().reverse().map(({ vendor }) => ({
  id: vendor.id,
  evidence: vendor.id === 'A' ? [{ preference: preferences[0], quote: a.description }] : [],
})) });
const rejects = (status: number, code?: string) => (error: unknown): boolean => {
  assert.ok(error instanceof AssistantError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(error), /test-key-never-real|secret-provider-diagnostics/u);
  return true;
};
const emptyRows = () => ({ items: [a, b, c].map(v => ({ id: v.id, evidence: [] as { preference: string; quote: string }[] })) });

test('one model batch compares server-selected top three, retaining canonical order and names', async () => {
  let calls = 0;
  const snapshot = structuredClone({ catalog, input });
  const compare = createComparisonAssistant({ config, provider: async args => {
    calls++;
    assert.deepEqual(args.candidates.map(c => c.vendor.id), ['A', 'B', 'C']);
    assert.deepEqual(args.preferences, preferences);
    return valid(args);
  } });
  const result = await compare(catalog, input);
  assert.equal(calls, 1);
  assert.equal(result.source, 'llm');
  assert.equal(result.model, 'test-model');
  assert.deepEqual(result.items.map(item => [item.id, item.name]), [a, b, c].map(v => [v.id, v.anon_name]));
  assert.deepEqual(result.items[0].evidence, [{ preference: preferences[0], quote: a.description }]);
  assert.deepEqual(result.items[0].to_confirm, [preferences[1]]);
  assert.deepEqual(result.items[1].to_confirm, preferences);
  assert.deepEqual({ catalog, input }, snapshot);
});

test('zero preferences and no matching candidates avoid config and model entirely', async () => {
  const compare = createComparisonAssistant({ config: () => { throw Error('must not run'); }, provider: async () => { throw Error('must not run'); } });
  const empty = await compare(catalog, { query, preferences: [] });
  assert.equal(empty.source, 'not_needed');
  assert.equal(empty.model, null);
  assert.deepEqual(empty.items.map(item => item.id), ['A', 'B', 'C']);
  assert.ok(empty.items.every(item => item.evidence.length === 0 && item.to_confirm.length === 0));
  assert.deepEqual(await compare(catalog, { ...input, query: { ...query, budget_kzt: 0 } }), { items: [], source: 'not_needed', model: null });
});

test('invalid inputs and query fields fail before configuration or provider', async () => {
  const compare = createComparisonAssistant({ config: () => { throw Error('must not run'); } });
  for (const raw of [null, [], {}, { query }, { ...input, ids: ['D'] }, { ...input, preferences: 'games' },
    { ...input, preferences: [null] }, { ...input, preferences: [' '] }, { ...input, preferences: ['x'.repeat(201)] },
    { ...input, preferences: Array(6).fill('wish') }, { ...input, query: { ...query, budget_kzt: -1 } },
    { ...input, query: { ...query, date: '2026-02-30' } }, { ...input, query: { ...query, language: 'invented' } }]) {
    await assert.rejects(compare(catalog, raw), rejects(422));
  }
});

test('query normalizes away client facts; preferences are trimmed and deduplicated', async () => {
  const compare = createComparisonAssistant({ config, provider: async args => {
    assert.deepEqual(args.query, query);
    assert.deepEqual(args.preferences, [preferences[0]]);
    return emptyRows();
  } });
  const result = await compare(catalog, { query: { ...query, city: '  алматы ', ids: ['D'], description: 'Fake facts' }, preferences: [` ${preferences[0]} `, preferences[0]] });
  assert.deepEqual(result.items[0].to_confirm, [preferences[0]]);
});

test('missing key or model produces an explicit configuration error', async () => {
  for (const value of [{}, { apiKey: 'key' }, { model: 'model' }, { apiKey: ' ', model: 'model' }]) {
    await assert.rejects(createComparisonAssistant({ config: () => value, provider: valid })(catalog, input), rejects(503, 'AI_NOT_CONFIGURED'));
  }
});

test('missing, foreign, duplicate, extra IDs and malformed envelopes are rejected', async () => {
  const samples: unknown[] = [null, 'bad', { items: 'bad' }, { items: [] }, { ...emptyRows(), extra: true },
    { items: emptyRows().items.slice(1) }, { items: [...emptyRows().items, { id: 'D', evidence: [] }] },
    { items: [{ id: 'FOREIGN', evidence: [] }, ...emptyRows().items.slice(1)] },
    { items: [{ id: 'A', evidence: [] }, { id: 'A', evidence: [] }, { id: 'C', evidence: [] }] },
    { items: [{ id: 'A', evidence: [], name: 'Injected name' }, ...emptyRows().items.slice(1)] },
    { items: [{ id: 'A', evidence: null }, ...emptyRows().items.slice(1)] }];
  for (const raw of samples) await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })(catalog, input), rejects(502, 'AI_INVALID_RESPONSE'));
});

test('invented, cross-profile, rewritten, blank and oversized quotes are rejected', async () => {
  for (const quote of ['Опыт 20 лет.', b.description, a.description.toUpperCase(), 'Проводит  интерактивные командные игры.', '', '  ', 'x'.repeat(221)]) {
    const raw = emptyRows();
    raw.items[0].evidence = [{ preference: preferences[0], quote }];
    await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })(catalog, input), rejects(502));
  }
  const longVendor = { ...a, description: 'x'.repeat(221) };
  const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: longVendor.description }] }] };
  await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })({ vendors: [longVendor], sha256: 'long' }, input), rejects(502));
});

test('unknown, duplicate and malformed preference evidence is rejected', async () => {
  for (const evidence of [
    [{ preference: 'Неизвестное пожелание', quote: a.description }],
    [{ preference: preferences[0], quote: a.description }, { preference: preferences[0], quote: a.description }],
    [{ preference: preferences[0], quote: a.description, satisfied: true }],
    [{ preference: preferences[0], quote: 42 }],
  ]) {
    const raw = { items: [{ id: 'A', evidence }, ...emptyRows().items.slice(1)] };
    await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })(catalog, input), rejects(502));
  }
});

test('permitted complete sentences retain preference order owned by the server', async () => {
  const orderedPreferences = ['Командные игры', 'Интерактивная программа'];
  const raw = emptyRows();
  raw.items[0].evidence = [
    { preference: orderedPreferences[1], quote: a.description },
    { preference: orderedPreferences[0], quote: a.description },
  ];
  const result = await createComparisonAssistant({ config, provider: async () => raw })(catalog, { query, preferences: orderedPreferences });
  assert.deepEqual(result.items[0].evidence.map(item => item.preference), orderedPreferences);
  assert.deepEqual(result.items[0].to_confirm, []);
  // The model's semantic interpretation is exposed as evidence, never as a
  // server-certified satisfied flag or a revised ranking.
  assert.equal('satisfied' in result.items[0], false);
});

test('runtime rejects excerpts that discard a negation or qualification', async () => {
  for (const [description, quote] of [
    ['Не проводит командные игры.', 'командные игры'],
    ['Проводит командные игры, но только по отдельному запросу.', 'Проводит командные игры'],
    ['Не проводит:\nкомандные игры и караоке.', 'командные игры и караоке.'],
    [`Не предлагает ${'дополнительные услуги, '.repeat(12)}командные игры.`, 'командные игры.'],
  ]) {
    const row = { ...a, description };
    const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote }] }] };
    await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'context' }, input), rejects(502));
  }
  const row = { ...a, description: 'Проводит командные игры, но только по отдельному запросу.' };
  const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: row.description }] }] };
  const result = await createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'qualification' }, input);
  assert.equal(result.items[0].evidence[0].quote, row.description);
});

test('pure praise cannot serve as service evidence; unsupported wishes remain to_confirm', async () => {
  const row = { ...a, description: 'Создаёт незабываемую атмосферу и яркие эмоции.' };
  const raw = { items: [{ id: 'A', evidence: [{ preference: 'Живая музыка', quote: row.description }] }] };
  const customInput = { query, preferences: ['Живая музыка', 'Без пошлых конкурсов'] };
  const customCatalog = { vendors: [row], sha256: 'praise' };
  await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })(customCatalog, customInput), rejects(502));
  const result = await createComparisonAssistant({ config, provider: async () => ({ items: [{ id: 'A', evidence: [] }] }) })(customCatalog, customInput);
  assert.deepEqual(result.items[0].evidence, []);
  assert.deepEqual(result.items[0].to_confirm, customInput.preferences);
});

test('concrete facts from gifts, ensembles, ceremonies and video survive unfamiliar vocabulary', async () => {
  for (const [preference, description] of [
    ['Персональные подарки', 'Создаёт яркие именные открытки, карточки рассадки и welcome-боксы.'],
    ['Струнный квартет', 'В составе струнный квартет и четыре вокалиста.'],
    ['Выездная церемония', 'Проводит выездную регистрацию брака с индивидуальным сценарием.'],
    ['Аэросъёмка', 'Снимает репортаж и короткие фильмы с аэросъёмкой.'],
    ['Цианотипии', 'Изготавливает цианотипии на хлопковой бумаге.'],
  ]) {
    const row = { ...a, description };
    const raw = { items: [{ id: 'A', evidence: [{ preference, quote: description }] }] };
    const result = await createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'facts' }, { query, preferences: [preference] });
    assert.equal(result.items[0].evidence[0].quote, description);
  }
});

test('configuration failure returns a sanitized availability error', async () => {
  await assert.rejects(createComparisonAssistant({ config: () => { throw new Error('secret-provider-diagnostics'); } })(catalog, input), rejects(503, 'AI_UNAVAILABLE'));
});

test('operational claims and language claims contradicted by structured fields are excluded', async () => {
  for (const description of ['Стоимость программы 50 000 тенге.', 'Свободен на любую дату.', 'Ведёт программу 12 часов.',
    'Работает на английском языке.', 'Двуязычный ведущий с командными играми.', 'Работает на русском и казахском языках.']) {
    const row = { ...a, description };
    const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: description }] }] };
    await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'contradiction' }, input), rejects(502));
  }
  const row = { ...a, description: 'Проводит командные игры на английском языке.' };
  const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: 'командные игры' }] }] };
  await assert.rejects(createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'partial' }, input), rejects(502));
});

test('supported bilingual evidence remains usable', async () => {
  const row = { ...a, languages: ['русский', 'казахский'], description: 'Двуязычный ведущий с командными играми.' };
  const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: row.description }] }] };
  const result = await createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'bilingual' }, input);
  assert.equal(result.items[0].evidence[0].quote, row.description);
});

test('scenario and stage descriptions do not accidentally match the price guard', async () => {
  for (const description of ['Разрабатывает сценарий с интерактивами.', 'Сцена оформлена для музыкальных выступлений.']) {
    const row = { ...a, description };
    const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote: description }] }] };
    const result = await createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'scenario' }, input);
    assert.equal(result.items[0].evidence[0].quote, description);
  }
});

test('an operational claim in a separate sentence does not discard valid service evidence', async () => {
  const quote = 'Разрабатывает сценарий с интерактивами.';
  const row = { ...a, description: `${quote} Стоимость уточняется отдельно.` };
  const raw = { items: [{ id: 'A', evidence: [{ preference: preferences[0], quote }] }] };
  const result = await createComparisonAssistant({ config, provider: async () => raw })({ vendors: [row], sha256: 'separate-sentences' }, input);
  assert.equal(result.items[0].evidence[0].quote, quote);
});

test('provider failures return explicit sanitized errors without fake AI success', async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(createComparisonAssistant({ config, provider: async () => {
      throw Object.assign(new Error('secret-provider-diagnostics'), { status });
    } })(catalog, input), rejects(503, 'AI_UNAVAILABLE'));
  }
});

test('deadline aborts a non-cooperative provider and returns 504', async () => {
  let signal: AbortSignal | undefined;
  const compare = createComparisonAssistant({ config, timeoutMs: 20, provider: async args => {
    signal = args.signal;
    return new Promise(() => {});
  } });
  const started = performance.now();
  await assert.rejects(compare(catalog, input), rejects(504, 'AI_TIMEOUT'));
  assert.equal(signal?.aborted, true);
  assert.ok(performance.now() - started < 1000);
});

test('Responses adapter uses one strict-schema request with server facts and no storage', async t => {
  let calls = 0;
  const raw = emptyRows();
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(request), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.model, 'test-model');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    const schema = body.text.format.schema.properties.items;
    assert.deepEqual(schema.items.anyOf.map((option: { properties: { id: { enum: string[] } } }) => option.properties.id.enum[0]), ['A', 'B', 'C']);
    assert.deepEqual(schema.items.anyOf[0].properties.evidence.items.properties.preference.enum, preferences);
    assert.deepEqual(schema.items.anyOf[0].properties.evidence.items.properties.quote.enum, [a.description]);
    assert.deepEqual(JSON.parse(body.input).profiles.map((v: { id: string }) => v.id), ['A', 'B', 'C']);
    assert.match(body.instructions, /untrusted data/u);
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }],
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await requestComparison({ ...input, candidates: selectVendors(catalog.vendors, query).ranked.slice(0, 3), ...config(), signal: new AbortController().signal }), raw);
  assert.equal(calls, 1);
});

test('Responses adapter does not retry errors, and rejects malformed or incomplete output', async t => {
  let calls = 0;
  let mode = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 0) return new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: mode === 1 ? 'incomplete' : 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'not JSON', annotations: [] }],
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const args = { ...input, candidates: selectVendors(catalog.vendors, query).ranked.slice(0, 3), ...config(), signal: new AbortController().signal };
  await assert.rejects(requestComparison(args));
  assert.equal(calls, 1);
  mode = 1;
  await assert.rejects(requestComparison(args), rejects(502));
  mode = 2;
  await assert.rejects(requestComparison(args), rejects(502));
  assert.equal(calls, 3);
});

test('reported gift comparison request uses profile-bound quote enums and accepts a conforming SDK response', async t => {
  const actualCatalog = loadCatalog('data/vendors.csv');
  const giftQuery: Query = { city: 'Алматы', date: '2026-09-23', event_format: 'свадьба', category: 'Подарки и сувениры', budget_kzt: 6_000_000, hours: null, language: null };
  const wishes = ['именные открытки', 'сладости с индивидуальным дизайном'];
  const gift = actualCatalog.vendors.find(vendor => vendor.id === 'HK-90005')!;
  const selected = selectVendors(actualCatalog.vendors, giftQuery).ranked.slice(0, 3);
  assert.deepEqual(selected.map(candidate => candidate.vendor.id), ['HK-60927', 'HK-90005']);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    assert.equal(String(request), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    const variants = body.text.format.schema.properties.items.items.anyOf;
    assert.equal(body.text.format.strict, true);
    for (const candidate of selected) {
      const variant = variants.find((variant: { properties: { id: { enum: string[] } } }) => variant.properties.id.enum[0] === candidate.vendor.id);
      const quoteSchema = variant.properties.evidence.items.properties.quote;
      assert.ok(Array.isArray(quoteSchema.enum) && quoteSchema.enum.length > 0, 'quotes must not be unrestricted strings');
      assert.ok(quoteSchema.enum.every((quote: string) => candidate.vendor.description.includes(quote)));
      assert.deepEqual(variant.properties.evidence.items.properties.preference.enum, wishes);
      if (candidate.vendor.id === gift.id) assert.deepEqual(quoteSchema.enum, [gift.description]);
    }
    const raw = { items: selected.map(({ vendor }) => ({ id: vendor.id, evidence: vendor.id === gift.id ? wishes.map(preference => ({ preference, quote: gift.description })) : [] })) };
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(raw), annotations: [] }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await createComparisonAssistant({ config })(actualCatalog, { query: giftQuery, preferences: wishes });
  assert.equal(calls, 1);
  assert.equal(result.source, 'llm');
  assert.deepEqual(result.items.map(item => item.id), selected.map(candidate => candidate.vendor.id));
  const item = result.items.find(item => item.id === gift.id)!;
  assert.deepEqual(item.evidence, wishes.map(preference => ({ preference, quote: gift.description })));
  assert.deepEqual(item.to_confirm, []);
  assert.deepEqual(result.items[0].to_confirm, wishes);
});
