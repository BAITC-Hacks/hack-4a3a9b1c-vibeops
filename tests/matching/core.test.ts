import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadCatalog } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import { validateQuery } from '../../server/validation.js';
import { createApp } from '../../server/app.js';
import type { Query, RecommendResponse } from '../../shared/contracts.js';

const catalog = loadCatalog('data/vendors.csv');
const base: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 1_000_000, hours: null, language: null };
const cases: { name: string; query: Query; baseCount: number; ids: string[]; outcome: string }[] = [
  { name: 'D1', query: base, baseCount: 10, ids: ['HK-88430', 'HK-77838', 'HK-27222', 'HK-29829'], outcome: 'matched' },
  { name: 'D2', query: { ...base, date: '2026-10-11' }, baseCount: 10, ids: ['HK-44733', 'HK-44923', 'HK-77838', 'HK-27222'], outcome: 'matched' },
  { name: 'D3', query: { ...base, category: 'Флорист', event_format: 'свадьба', budget_kzt: 500_000 }, baseCount: 2, ids: ['HK-39372'], outcome: 'matched' },
  { name: 'D4', query: { ...base, city: 'Астана', category: 'Декоратор', event_format: 'свадьба', budget_kzt: 500_000 }, baseCount: 0, ids: [], outcome: 'no_category_in_city' },
  { name: 'D5', query: { ...base, budget_kzt: 1 }, baseCount: 10, ids: [], outcome: 'no_matches' },
  { name: 'D6', query: { ...base, category: 'Банкетный зал', date: '2026-11-14', event_format: 'свадьба', budget_kzt: 5_000_000 }, baseCount: 7, ids: ['HK-64395', 'HK-90011'], outcome: 'matched' },
];

for (const demo of cases) test(`${demo.name}: actual organizer CSV matches published eligibility`, () => {
  const selection = selectVendors(catalog.vendors, demo.query);
  assert.equal(selection.outcome, demo.outcome); assert.equal(selection.base_count, demo.baseCount);
  assert.deepEqual(selection.ranked.map(c => c.vendor.id).sort(), [...demo.ids].sort());
});

test('stable ranking survives reordered catalog and a fresh load', () => {
  const expected = ['HK-88430', 'HK-27222', 'HK-29829', 'HK-77838'];
  for (const vendors of [catalog.vendors, [...catalog.vendors].reverse(), loadCatalog('data/vendors.csv').vendors]) {
    assert.deepEqual(selectVendors(vendors, base).ranked.map(c => c.vendor.id), expected);
  }
});

test('independent reasons overlap without inflating rejected count; date changes explain exclusion', () => {
  const one = selectVendors(catalog.vendors, base);
  const two = selectVendors(catalog.vendors, { ...base, date: '2026-10-11' });
  assert.equal(one.rejected.length, 6);
  assert.deepEqual(one.rejection_counts, { busy_date: 4, over_budget: 2, unsupported_format: 1, unsupported_language: 0, insufficient_hours: 0 });
  assert.ok(one.rejected.find(v => v.id === 'HK-44733')?.reasons.includes('busy_date'));
  assert.ok(two.rejected.find(v => v.id === 'HK-88430')?.reasons.includes('busy_date'));
});

test('budget/hours boundaries, null duration and multi-category selection', () => {
  const vendor = { ...catalog.vendors.find(v => v.id === 'HK-88430')!, categories: ['Ведущий', 'Ведущий церемонии'], busy_dates: [], max_hours: 4 };
  assert.equal(selectVendors([vendor], { ...base, budget_kzt: vendor.price_from_kzt, hours: 4 }).eligible_count, 1);
  assert.equal(selectVendors([vendor], { ...base, budget_kzt: vendor.price_from_kzt - 1 }).eligible_count, 0);
  assert.equal(selectVendors([vendor], { ...base, hours: 5 }).eligible_count, 0);
  assert.equal(selectVendors([{ ...vendor, max_hours: null }], { ...base, hours: 100 }).eligible_count, 1);
  assert.equal(selectVendors([vendor], { ...base, category: 'Ведущий церемонии' }).eligible_count, 1);
  assert.equal(selectVendors([{ ...vendor, languages: ['русский'] }], { ...base, language: 'английский' }).eligible_count, 0);
  assert.equal(selectVendors([vendor], { ...base, language: null }).eligible_count, 1);
});

test('normalization, unknown category and optional missing/null values follow Query contract', () => {
  const { hours: _hours, language: _language, ...required } = base;
  assert.deepEqual(validateQuery({ ...required, city: '  алматы ', category: 'ведущий' }, catalog), base);
  assert.equal(selectVendors(catalog.vendors, validateQuery({ ...base, category: 'Неизвестная категория' }, catalog)).outcome, 'no_category_in_city');
  for (const value of [null, [], {}, { ...base, date: '2026-02-31' }, { ...base, date: '2027-01-01' }, { ...base, budget_kzt: -1 }, { ...base, hours: 0 }, { ...base, hours: '4' }, { ...base, language: 'несуществующий' }, { ...base, duration_hours: 4 }]) {
    assert.throws(() => validateQuery(value, catalog));
  }
  assert.equal(validateQuery({ ...base, budget_kzt: 0 }, catalog).budget_kzt, 0);
});

test('HTTP D1-D6 return complete UI contract; invalid queries are 422, not empty results', async t => {
  const previous = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const server = createServer(createApp(catalog)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/recommend`;
  const send = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  for (const demo of cases) {
    const response = await send(demo.query); assert.equal(response.status, 200);
    const result = await response.json() as RecommendResponse;
    assert.equal(result.outcome, demo.outcome); assert.equal(result.summary.eligible_count, demo.ids.length);
    assert.equal(result.cards.length, Math.min(3, demo.ids.length)); assert.ok(result.summary.message);
    assert.equal(result.meta.dataset_sha256, catalog.sha256); assert.equal(result.meta.ranking_version, 'v1');
    assert.equal(result.explanation.mode, result.cards.length ? 'fallback' : 'not_needed');
    assert.deepEqual(result.query, demo.query);
    for (const card of result.cards) { assert.ok(card.explanation); assert.equal(card.category, demo.query.category); assert.equal(card.explanation_source, 'fallback'); }
  }
  for (const body of [{}, { ...base, hours: 0 }, { ...base, date: '2026-02-31' }]) assert.equal((await send(body)).status, 422);
  const outOfRange = await send({ ...base, date: '2027-01-01' });
  assert.equal(outOfRange.status, 422); assert.equal((await outOfRange.json()).error.code, 'DATE_OUT_OF_RANGE');
});
