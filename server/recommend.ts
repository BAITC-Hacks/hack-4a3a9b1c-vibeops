import type { RecommendResponse, Reason } from '../shared/contracts.js';
import { selectVendors, REASON_LABELS } from './matching.js';
import { validateQuery } from './validation.js';
import {
  explainSelection,
  fallbackExplanation,
} from './explanations/index.js';
import { buildDecisionSupport } from './alternatives.js';

export async function recommend(
  catalog: Catalog,
  input: unknown
): Promise<RecommendResponse> {
  const start = performance.now();

  const query = validateQuery(input, catalog);
  const selection = selectVendors(catalog.vendors, query);

  const selected = selection.ranked.slice(0, 3);

  const explanation = await explainSelection({
    query,
    candidates: selected,
    dataset_sha256: catalog.sha256,
  });

  const byId = new Map(
    explanation.items.map(item => [item.id, item])
  );

  const cards = selected.map(candidate => {
    const vendor = candidate.vendor;

    const evidence =
      byId.get(vendor.id) ??
      fallbackExplanation(query, candidate);

    return {
      id: vendor.id,
      name: vendor.anon_name,
      category: query.category,
      categories: vendor.categories,
      city: vendor.city,
      price_from_kzt: vendor.price_from_kzt,
      languages: vendor.languages,
      max_hours: vendor.max_hours,

      synthetic: vendor.synthetic,
      city_imputed: vendor.city_imputed,
      price_imputed: vendor.price_imputed,

      relevance_score: candidate.relevance_score,
      matched_terms: candidate.matched_terms,

      explanation: evidence.text,
      evidence_quote: evidence.quote,
      explanation_source: evidence.source,
    };
  });

  const llmCount = cards.filter(
    c => c.explanation_source === 'llm'
  ).length;

  const mode =
    !cards.length
      ? 'not_needed'
      : llmCount === cards.length
        ? 'llm'
        : llmCount
          ? 'mixed'
          : 'fallback';

  const causes = (
    Object.entries(selection.rejection_counts) as [Reason, number][]
  )
    .filter(([, n]) => n)
    .map(
      ([reason, n]) =>
        `${REASON_LABELS[reason]} — ${n}`
    )
    .join('; ');

  const message =
    selection.outcome === 'no_category_in_city'
      ? `В городе ${query.city} в каталоге нет категории «${query.category}».`
      : `В городе в этой категории ${selection.base_count} профилей; подходят ${selection.eligible_count}, показаны ${cards.length}.` +
        (
          selection.rejected.length
            ? ` Исключены ${selection.rejected.length}: ${causes}; причины могут пересекаться.`
            : selection.eligible_count > cards.length
              ? ' Показаны первые три по устойчивому порядку.'
              : ' Показаны все доступные в каталоге профили этой категории.'
        );

  return {
    outcome: selection.outcome,

    query,

    cards,

    summary: {
      base_count: selection.base_count,
      eligible_count: selection.eligible_count,
      returned_count: cards.length,
      rejected_count: selection.rejected.length,
      rejection_counts: selection.rejection_counts,
      message,
      rejected: selection.rejected,
    },

    explanation: {
      mode,
      model: llmCount ? explanation.model : null,
      cached: explanation.cached,
      warning:
        mode !== explanation.mode
          ? 'Некоторые объяснения восстановлены из каталога без AI.'
          : explanation.warning,
    },

    meta: {
      dataset_sha256: catalog.sha256,
      ranking_version: 'v1',
      elapsed_ms: Math.round(performance.now() - start),
    },
  };
}
