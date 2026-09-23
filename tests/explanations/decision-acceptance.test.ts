import assert from 'node:assert/strict';
import test from 'node:test';
import type { Card, RecommendResponse } from '../../shared/contracts.js';
import { loadCatalog } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import { fallbackExplanation } from '../../server/explanations/index.js';
import { describeAlternative, buildComparison } from '../../server/explanations/decision-support.js';
import { checkDecisionResponse, decisionCases, DecisionSupportMissing } from './decision-acceptance.js';

const catalog = loadCatalog('data/vendors.csv');
// These fixtures test the checker itself; they are never a substitute for HTTP acceptance.
function fixture(name = 'D3'): RecommendResponse {
  const c = decisionCases.find(x => x.name === name)!;
  const selection = selectVendors(catalog.vendors, c.query);
  const cards: Card[] = selection.ranked.slice(0, 3).map(row => {
    const v = row.vendor, e = fallbackExplanation(c.query, row);
    return { id: v.id, name: v.anon_name, category: c.query.category, categories: v.categories,
      city: v.city, price_from_kzt: v.price_from_kzt, languages: v.languages, max_hours: v.max_hours,
      synthetic: v.synthetic, city_imputed: v.city_imputed, price_imputed: v.price_imputed,
      relevance_score: row.relevance_score, matched_terms: row.matched_terms,
      explanation: e.text, evidence_quote: e.quote, explanation_source: e.source };
  });
  return {
    outcome: selection.outcome, query: { ...c.query }, cards,
    summary: { base_count: selection.base_count, eligible_count: selection.eligible_count,
      returned_count: cards.length, rejected_count: selection.rejected.length,
      rejection_counts: selection.rejection_counts, rejected: selection.rejected, message: 'Test fixture.' },
    explanation: { mode: cards.length ? 'fallback' : 'not_needed', warning: cards.length ? 'Без AI.' : null, model: null, cached: false },
    meta: { dataset_sha256: catalog.sha256, ranking_version: 'v1', elapsed_ms: 1 },
    decision_support: { version: 'v1', status: c.status,
      alternatives: c.offers.map(offer => describeAlternative(selection, selectVendors(catalog.vendors,
        { ...c.query, [offer.kind === 'date' ? 'date' : 'budget_kzt']: offer.value }))!),
      comparison: buildComparison(cards), message: c.status === 'no_category' || c.status === 'no_single_change' ? 'Нет подходящего изменения.' : null },
  };
}

test('checker accepts catalog-backed golden fixtures, including no-category/no-single-change and optional constraints', () => {
  for (const c of decisionCases) checkDecisionResponse(fixture(c.name), c.query, catalog);
});

test('missing integration is BLOCKED rather than a false positive', () => {
  const response = fixture(); delete response.decision_support;
  assert.throws(() => checkDecisionResponse(response, response.query, catalog), DecisionSupportMissing);
});

test('checker rejects a second changed condition even if the advertised date is valid', () => {
  const r = fixture(); r.decision_support!.alternatives[0]!.query.budget_kzt++;
  assert.throws(() => checkDecisionResponse(r, r.query, catalog), /only the declared field/u);
});

test('checker rejects nonminimal budgets that still produce a real candidate', () => {
  const r = fixture('D5'); r.decision_support!.alternatives[0]!.query.budget_kzt++;
  assert.throws(() => checkDecisionResponse(r, r.query, catalog), /budget is not minimal/u);
});

test('checker rejects false promised counts and incomplete new-ID lists', () => {
  const r = fixture('D6'); r.decision_support!.alternatives[0]!.eligible_count = 6;
  assert.throws(() => checkDecisionResponse(r, r.query, catalog));
  const truncated = fixture('D6'); truncated.decision_support!.alternatives[0]!.new_vendor_ids.pop();
  assert.throws(() => checkDecisionResponse(truncated, truncated.query, catalog), /all new eligible IDs/u);
});

test('checker rejects fabricated or cross-profile evidence and misleading AI attribution', () => {
  const r = fixture('D1'); r.cards[0]!.evidence_quote = 'Выдуманный опыт на 1000 мероприятиях.';
  assert.throws(() => checkDecisionResponse(r, r.query, catalog), /quote must belong/u);
  const compare = fixture('D1'); compare.decision_support!.comparison[0]!.source = 'llm';
  assert.throws(() => checkDecisionResponse(compare, compare.query, catalog));
  const mode = fixture('D1'); mode.explanation.mode = 'llm';
  assert.throws(() => checkDecisionResponse(mode, mode.query, catalog));
});

test('strict AI acceptance rejects fallback while ordinary acceptance labels it honestly', () => {
  const r = fixture('D1'); checkDecisionResponse(r, r.query, catalog);
  assert.throws(() => checkDecisionResponse(r, r.query, catalog, true), /live AI required/u);
});

test('checker rejects a budget proposal that silently removes requested hours/language', () => {
  const r = fixture('hours-language-preserved');
  r.decision_support!.alternatives[0]!.query.hours = null;
  r.decision_support!.alternatives[0]!.query.language = null;
  assert.throws(() => checkDecisionResponse(r, r.query, catalog), /only the declared field/u);
});
