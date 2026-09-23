import assert from 'node:assert/strict';
import type { Query, RecommendResponse, Vendor } from '../../shared/contracts.js';
import type { DecisionSupport } from '../../shared/decision-support.js';
import type { Catalog } from '../../server/catalog.js';
import { DATE_MIN, DATE_MAX } from '../../server/catalog.js';
import { verifiedQuote } from '../../server/explanations/evidence.js';

export class DecisionSupportMissing extends Error {
  constructor() { super('decision_support is absent: alternatives are not integrated yet'); }
}

// Independent eligibility check: does not call the production selection/alternative builder.
export function eligibleIds(vendors: Vendor[], q: Query): string[] {
  return vendors.filter(v => v.city === q.city && v.categories.includes(q.category) &&
    !v.busy_dates.includes(q.date) && v.price_from_kzt <= q.budget_kzt &&
    v.event_formats.includes(q.event_format) &&
    (q.language === null || v.languages.includes(q.language)) &&
    (q.hours === null || v.max_hours === null || v.max_hours >= q.hours))
    .map(v => v.id).sort();
}

export function checkActualResult(result: RecommendResponse, q: Query, catalog: Catalog, requireAI = false) {
  assert.deepEqual(result.query, q, 'canonical query must stay unchanged');
  assert.equal(result.meta.dataset_sha256, catalog.sha256, 'runner and server must use the same CSV');
  const eligible = eligibleIds(catalog.vendors, q);
  const base = catalog.vendors.filter(v => v.city === q.city && v.categories.includes(q.category));
  assert.equal(result.summary.base_count, base.length);
  assert.equal(result.summary.eligible_count, eligible.length);
  assert.equal(result.outcome, !base.length ? 'no_category_in_city' : !eligible.length ? 'no_matches' : 'matched');
  assert.equal(result.cards.length, Math.min(3, eligible.length));
  assert.equal(new Set(result.cards.map(c => c.id)).size, result.cards.length);
  for (const card of result.cards) {
    assert.ok(eligible.includes(card.id), `ineligible returned card ${card.id}`);
    const vendor = catalog.vendors.find(v => v.id === card.id)!;
    assert.equal(card.price_from_kzt, vendor.price_from_kzt);
    if (card.evidence_quote !== null) assert.equal(verifiedQuote(vendor.description, card.evidence_quote), card.evidence_quote, 'quote must belong to its profile');
    assert.ok(['llm', 'fallback'].includes(card.explanation_source));
    if (card.explanation_source === 'llm') assert.ok(card.evidence_quote, 'LLM evidence must exist');
  }
  const sources = result.cards.map(c => c.explanation_source);
  const mode = !sources.length ? 'not_needed' : sources.every(s => s === 'llm') ? 'llm' : sources.every(s => s === 'fallback') ? 'fallback' : 'mixed';
  assert.equal(result.explanation.mode, mode);
  if (mode === 'fallback' || mode === 'mixed') assert.ok(result.explanation.warning?.trim(), 'fallback warning');
  if (requireAI && sources.length) assert.equal(mode, 'llm', 'live AI required; fallback is not proof');
  return eligible;
}

export function checkDecisionResponse(result: RecommendResponse, q: Query, catalog: Catalog, requireAI = false) {
  const originalIds = checkActualResult(result, q, catalog, requireAI);
  const support = result.decision_support;
  if (support === undefined) throw new DecisionSupportMissing();
  assert.equal(support.version, 'v1');
  assert.ok(['available', 'not_needed', 'no_category', 'no_single_change'].includes(support.status));
  assert.ok(Array.isArray(support.alternatives) && support.alternatives.length <= 2);
  const kinds = support.alternatives.map(a => a.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === 'date' ? 0 : 1) - (b === 'date' ? 0 : 1)), 'date before budget');
  if (!result.summary.base_count) assert.equal(support.status, 'no_category');
  else if (originalIds.length >= 3) assert.equal(support.status, 'not_needed');
  else assert.equal(support.status, support.alternatives.length ? 'available' : 'no_single_change');
  if (support.status !== 'available') assert.equal(support.alternatives.length, 0);
  if (support.status === 'no_category' || support.status === 'no_single_change') assert.ok(support.message?.trim(), 'explain why there are no alternatives');
  else assert.equal(support.message, null);
  for (const alt of support.alternatives) {
    assert.ok(alt.kind === 'date' || alt.kind === 'budget');
    assert.equal(alt.source, 'catalog');
    assert.ok(alt.title.trim() && alt.explanation.trim());
    const field = alt.kind === 'date' ? 'date' : 'budget_kzt';
    assert.deepEqual({ ...alt.query, [field]: q[field] }, q, 'only the declared field may change');
    if (alt.kind === 'date') {
      assert.match(alt.query.date, /^\d{4}-\d{2}-\d{2}$/);
      const millis = Date.parse(alt.query.date + 'T00:00:00Z');
      assert.equal(new Date(millis).toISOString().slice(0, 10), alt.query.date);
      const days = Math.abs(millis - Date.parse(q.date + 'T00:00:00Z')) / 86400000;
      assert.ok(days >= 1 && days <= 7 && alt.query.date >= DATE_MIN && alt.query.date <= DATE_MAX, 'date search bounds');
    } else {
      assert.ok(Number.isSafeInteger(alt.query.budget_kzt) && alt.query.budget_kzt > q.budget_kzt);
      // For integer KZT, a cheaper budget by 1 must no longer improve the baseline.
      assert.equal(eligibleIds(catalog.vendors, { ...alt.query, budget_kzt: alt.query.budget_kzt - 1 }).length, originalIds.length, 'budget is not minimal');
    }
    const nextIds = eligibleIds(catalog.vendors, alt.query);
    assert.equal(alt.eligible_count, nextIds.length);
    assert.ok(nextIds.length > originalIds.length, 'alternative must improve the count');
    assert.deepEqual(alt.new_vendor_ids, nextIds.filter(id => !originalIds.includes(id)), 'all new eligible IDs, not only displayed cards');
  }
  assert.ok(Array.isArray(support.comparison));
  assert.deepEqual(support.comparison.map(c => c.vendor_id), result.cards.length >= 2 ? result.cards.map(c => c.id) : []);
  for (const item of support.comparison) {
    const card = result.cards.find(c => c.id === item.vendor_id)!;
    assert.ok(item.feature.trim());
    assert.equal(item.evidence_quote, card.evidence_quote);
    assert.equal(item.source, card.evidence_quote ? card.explanation_source : 'catalog');
    if (item.evidence_quote) assert.ok(item.feature.includes(item.evidence_quote), 'comparison must preserve the verified quote');
  }
  return support;
}

const base: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 1000000, hours: null, language: null };
export const decisionCases: { name: string; query: Query; status: DecisionSupport['status']; offers: { kind: 'date'|'budget'; value: string|number; count: number; ids: string[] }[] }[] = [
  { name: 'D1', query: base, status: 'not_needed', offers: [] },
  { name: 'D3', query: { ...base, category: 'Флорист', event_format: 'свадьба', budget_kzt: 500000 }, status: 'available', offers: [{ kind: 'date', value: '2026-10-09', count: 2, ids: ['HK-90001'] }] },
  { name: 'D4', query: { ...base, city: 'Астана', category: 'Декоратор', event_format: 'свадьба', budget_kzt: 500000 }, status: 'no_category', offers: [] },
  { name: 'D5', query: { ...base, budget_kzt: 1 }, status: 'available', offers: [{ kind: 'budget', value: 500000, count: 1, ids: ['HK-88430'] }] },
  { name: 'D6', query: { ...base, category: 'Банкетный зал', event_format: 'свадьба', date: '2026-11-14', budget_kzt: 5000000 }, status: 'available', offers: [{ kind: 'date', value: '2026-11-13', count: 5, ids: ['HK-50695','HK-58236','HK-69010'] }] },
  { name: 'hours-language-preserved', query: { ...base, budget_kzt: 1, hours: 4, language: 'русский' }, status: 'available', offers: [{ kind: 'budget', value: 500000, count: 1, ids: ['HK-88430'] }] },
  { name: 'no-single-change', query: { ...base, hours: 100 }, status: 'no_single_change', offers: [] },
];
