import assert from 'node:assert/strict';
import test from 'node:test';
import type { Query, Vendor } from '../../shared/contracts.js';
import type { Catalog } from '../../server/catalog.js';
import { DATE_MAX, DATE_MIN, loadCatalog } from '../../server/catalog.js';
import { buildDecisionSupport } from '../../server/alternatives.js';
import { selectVendors } from '../../server/matching.js';
import { recommend } from '../../server/recommend.js';
import { checkDecisionResponse, decisionCases } from '../explanations/decision-acceptance.js';

const query: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 100, hours: 4, language: 'русский' };
const vendor = (id: string, extra: Partial<Vendor> = {}): Vendor => ({
  id, anon_name: `Исполнитель ${id}`, categories: ['Ведущий'], city: 'Алматы', price_from_kzt: 100,
  event_formats: ['корпоратив'], languages: ['русский'], max_hours: 4, busy_dates: [], description: 'Проводит командные игры.',
  synthetic: true, city_imputed: false, price_imputed: false, ...extra,
});
function support(vendors: Vendor[], q = query) {
  const catalog: Catalog = { vendors, sha256: 'unit-alternatives' };
  return buildDecisionSupport(catalog, selectVendors(vendors, q), []);
}

test('date alternatives prefer distance, then count, then earlier date', () => {
  const original = vendor('A');
  const newlyFree = vendor('B', { busy_dates: ['2026-10-10', '2026-10-09'] });
  const distant = vendor('C', { busy_dates: ['2026-10-10', '2026-10-09', '2026-10-11'] });
  const closest = support([original, newlyFree, distant]).alternatives[0];
  assert.equal(closest.kind, 'date');
  assert.equal(closest.query.date, '2026-10-11');
  assert.equal(closest.eligible_count, 2, 'a larger result two days away must not beat a one-day shift');
  const bothSides = vendor('D', { busy_dates: ['2026-10-10'] });
  const more = support([original, newlyFree, bothSides]).alternatives[0];
  assert.equal(more.query.date, '2026-10-11');
  assert.equal(more.eligible_count, 3);
  assert.equal(support([original, bothSides]).alternatives[0].query.date, '2026-10-09');
});

test('date search stays in the known calendar at both boundaries', () => {
  for (const [date, expected] of [[DATE_MIN, '2026-09-24'], [DATE_MAX, '2026-12-30']]) {
    const result = support([vendor('A', { busy_dates: [date] })], { ...query, date });
    assert.equal(result.alternatives[0].query.date, expected);
    assert.equal(result.alternatives[0].eligible_count, 1);
  }
});

test('budget uses the cheapest useful actual price while keeping every other filter', () => {
  const q = { ...query, budget_kzt: 0 };
  const vendors = [
    vendor('BUSY', { price_from_kzt: 10, busy_dates: [q.date] }),
    vendor('LANGUAGE', { price_from_kzt: 20, languages: ['казахский'] }),
    vendor('HOURS', { price_from_kzt: 30, max_hours: 3 }),
    vendor('FORMAT', { price_from_kzt: 40, event_formats: ['свадьба'] }),
    vendor('CITY', { price_from_kzt: 50, city: 'Астана' }),
    vendor('CATEGORY', { price_from_kzt: 60, categories: ['Фотограф'] }),
    vendor('FIRST', { price_from_kzt: 80 }),
    vendor('SECOND', { price_from_kzt: 100 }),
  ];
  const result = support(vendors, q);
  assert.equal(result.alternatives.length, 1);
  const alt = result.alternatives[0];
  assert.equal(alt.kind, 'budget');
  assert.deepEqual(alt.query, { ...q, budget_kzt: 80 });
  assert.equal(alt.eligible_count, 1);
  assert.deepEqual(alt.new_vendor_ids, ['FIRST']);
});

test('all newly eligible IDs are returned; catalog order and inputs remain unchanged', () => {
  const vendors = ['E', 'C', 'A', 'D', 'B'].map(id => vendor(id));
  const q = { ...query, budget_kzt: 99 };
  const snapshot = structuredClone({ vendors, q });
  const result = support(vendors, q);
  assert.deepEqual(result.alternatives[0].new_vendor_ids, ['A', 'B', 'C', 'D', 'E']);
  assert.equal(result.alternatives[0].eligible_count, 5);
  assert.deepEqual(support([...vendors].reverse(), q), result);
  assert.deepEqual({ vendors, q }, snapshot);
});

test('catalog recommendation exposes the existing decision contract for all acceptance scenarios', async t => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const catalog = loadCatalog('data/vendors.csv');
  for (const scenario of decisionCases) {
    const result = await recommend(catalog, scenario.query);
    const decision = checkDecisionResponse(result, scenario.query, catalog);
    assert.equal(decision.status, scenario.status, scenario.name);
    assert.deepEqual(decision.alternatives.map(alt => ({ kind: alt.kind, value: alt.kind === 'date' ? alt.query.date : alt.query.budget_kzt, count: alt.eligible_count, ids: alt.new_vendor_ids })), scenario.offers);
  }
});
