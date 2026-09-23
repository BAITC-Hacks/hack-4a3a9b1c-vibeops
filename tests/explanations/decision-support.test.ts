import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card, Query, Vendor } from '../../shared/contracts.js';
import { selectVendors } from '../../server/matching.js';
import { describeAlternative, buildComparison } from '../../server/explanations/decision-support.js';

const q: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 100, hours: null, language: null };
const vendor = (id: string, price: number, busy_dates: string[] = []): Vendor => ({
  id, anon_name: id, city: q.city, categories: [q.category], event_formats: [q.event_format],
  price_from_kzt: price, max_hours: 5, languages: ['русский'], busy_dates,
  description: 'Проводит командные игры.', synthetic: true, city_imputed: false, price_imputed: false,
});
const rows = [vendor('A', 100), vendor('B', 200), vendor('C', 100, [q.date])];
const choose = (query = q) => selectVendors(rows, query);

test('date explanation describes real gain without changing other constraints or promising a booking', () => {
  const initial = choose(); const next = choose({ ...q, date: '2026-10-11' });
  const before = structuredClone([initial, next]);
  const value = describeAlternative(initial, next)!;
  assert.equal(value.kind, 'date'); assert.equal(value.source, 'catalog');
  assert.deepEqual(value.new_vendor_ids, ['C']); assert.equal(value.eligible_count, 2);
  assert.match(value.explanation, /с 1 до 2/u); assert.match(value.explanation, /бронирование не подтверждено/u);
  assert.deepEqual([initial, next], before);
  value.query.date = '2026-12-01'; assert.equal(next.query.date, '2026-10-11');
});

test('budget explanation gives the exact increment and keeps date, language and hours', () => {
  const original = choose({ ...q, hours: 4, language: 'русский' });
  const proposed = choose({ ...original.query, budget_kzt: 200 });
  const value = describeAlternative(original, proposed)!;
  assert.equal(value.kind, 'budget'); assert.deepEqual(value.new_vendor_ids, ['B']);
  assert.equal(value.query.date, q.date); assert.equal(value.query.hours, 4); assert.equal(value.query.language, 'русский');
  assert.match(value.explanation, /увеличить бюджет на 100 ₸, до 200 ₸/u);
  assert.match(value.explanation, /цены «от»/u);
});

test('multiple changes, unsupported changes, equal counts, out-of-range dates and already full results produce no offer', () => {
  assert.equal(describeAlternative(choose(), choose({ ...q, date: '2026-10-11', budget_kzt: 200 })), null);
  assert.equal(describeAlternative(choose(), choose({ ...q, hours: 1 })), null);
  assert.equal(describeAlternative(choose(), choose()), null);
  assert.equal(describeAlternative(choose(), choose({ ...q, date: '2026-10-18' })), null);
  const boundaryRows = [vendor('A', 100), vendor('B', 100, ['2026-12-31'])];
  const nearEnd = selectVendors(boundaryRows, { ...q, date: '2026-12-31' });
  const outside = selectVendors(boundaryRows, { ...q, date: '2027-01-01' });
  assert.equal(outside.eligible_count, 2);
  assert.equal(nearEnd.eligible_count, 1);
  assert.equal(describeAlternative(nearEnd, outside), null);
  const full = choose({ ...q, date: '2026-10-11', budget_kzt: 200 });
  assert.equal(describeAlternative(full, { ...full, query: { ...full.query, budget_kzt: 300 } }), null);
});

test('new IDs refer to all eligible records and account for replacement on another date', () => {
  const catalog = [vendor('A', 100, ['2026-10-11']), vendor('B', 100, [q.date]), vendor('C', 100, [q.date])];
  const value = describeAlternative(selectVendors(catalog, q), selectVendors(catalog, { ...q, date: '2026-10-11' }))!;
  assert.equal(value.eligible_count, 2); assert.deepEqual(value.new_vendor_ids, ['B', 'C']);
  assert.match(value.explanation, /с 1 до 2; новых относительно исходного запроса — 2/u);
});

function card(id: string, quote: string | null, source: Card['explanation_source']): Card {
  return { id, name: id, category: q.category, categories: [q.category], city: q.city,
    price_from_kzt: 100, languages: ['русский'], max_hours: null, synthetic: true,
    city_imputed: false, price_imputed: false, relevance_score: 0, matched_terms: [],
    explanation: 'Проверенные условия.', evidence_quote: quote, explanation_source: source };
}

test('comparison preserves card order, exact evidence and its attribution; never invents a feature', () => {
  const cards = [card('B', 'Только развлечения и танцы.', 'llm'), card('A', 'Проводит командные игры.', 'fallback'), card('C', null, 'fallback')];
  const before = structuredClone(cards); const result = buildComparison(cards);
  assert.deepEqual(result.map(x => x.vendor_id), ['B', 'A', 'C']);
  assert.deepEqual(result.map(x => x.source), ['llm', 'fallback', 'catalog']);
  assert.equal(result[0]!.evidence_quote, cards[0]!.evidence_quote);
  assert.match(result[2]!.feature, /Индивидуальная особенность в описании не выделена/u);
  assert.deepEqual(cards, before);
  assert.deepEqual(buildComparison([]), []); assert.deepEqual(buildComparison(cards.slice(0, 1)), []);
});
