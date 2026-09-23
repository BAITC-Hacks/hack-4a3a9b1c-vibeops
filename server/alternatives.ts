import type {
  Card,
  Query,
  Selection,
} from '../shared/contracts.js';

import type {
  DecisionAlternative,
  DecisionSupport,
} from '../shared/decision-support.js';

import {
  DATE_MIN,
  DATE_MAX,
  type Catalog,
} from './catalog.js';

import { selectVendors } from './matching.js';

import {
  buildComparison,
  describeAlternative,
} from './explanations/decision-support.js';


const DAY_MS = 86_400_000;


/**
 * Shift YYYY-MM-DD by a number of calendar days using UTC.
 */
function shiftDateUtc(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00Z`);

  return new Date(timestamp + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}


/**
 * Find one useful date alternative.
 *
 * Rules:
 * - only change date
 * - search ±1..±7 days
 * - stay inside DATE_MIN / DATE_MAX
 * - eligible_count must increase
 *
 * Tie breaking:
 * 1. smallest absolute day shift
 * 2. highest eligible_count
 * 3. earlier date
 */
function findDateAlternative(
  catalog: Catalog,
  original: Selection,
): DecisionAlternative | null {
  const candidates: {
    selection: Selection;
    distance: number;
  }[] = [];

  for (let offset = -7; offset <= 7; offset++) {
    if (offset === 0) {
      continue;
    }

    const date = shiftDateUtc(
      original.query.date,
      offset,
    );

    if (date < DATE_MIN || date > DATE_MAX) {
      continue;
    }

    const query: Query = {
      ...original.query,
      date,
    };

    const selection = selectVendors(
      catalog.vendors,
      query,
    );

    if (
      selection.eligible_count <=
      original.eligible_count
    ) {
      continue;
    }

    candidates.push({
      selection,
      distance: Math.abs(offset),
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    // Closest date first.
    if (a.distance !== b.distance) {
      return a.distance - b.distance;
    }

    // If equally close, prefer more eligible vendors.
    if (
      a.selection.eligible_count !==
      b.selection.eligible_count
    ) {
      return (
        b.selection.eligible_count -
        a.selection.eligible_count
      );
    }

    // Final deterministic tie-break:
    // earlier YYYY-MM-DD first.
    return a.selection.query.date.localeCompare(
      b.selection.query.date,
    );
  });

  return describeAlternative(
    original,
    candidates[0].selection,
  );
}


/**
 * Find one useful budget alternative.
 *
 * We do NOT increase budget by arbitrary steps.
 *
 * Instead:
 * - take actual vendor price_from_kzt values
 * - same city
 * - same category
 * - price above current budget
 * - sort ascending
 *
 * For every threshold we run the REAL selectVendors(),
 * therefore busy date / format / language / hours are still
 * respected.
 *
 * First threshold which increases eligible_count wins.
 */
function findBudgetAlternative(
  catalog: Catalog,
  original: Selection,
): DecisionAlternative | null {
  const { query } = original;

  const budgetThresholds = [
    ...new Set(
      catalog.vendors
        .filter((vendor) => {
          return (
            vendor.city === query.city &&
            vendor.categories.includes(
              query.category,
            ) &&
            vendor.price_from_kzt >
              query.budget_kzt
          );
        })
        .map(
          (vendor) =>
            vendor.price_from_kzt,
        ),
    ),
  ].sort((a, b) => a - b);

  for (const budget_kzt of budgetThresholds) {
    const proposedQuery: Query = {
      ...query,
      budget_kzt,
    };

    const selection = selectVendors(
      catalog.vendors,
      proposedQuery,
    );

    if (
      selection.eligible_count <=
      original.eligible_count
    ) {
      continue;
    }

    return describeAlternative(
      original,
      selection,
    );
  }

  return null;
}


/**
 * Build decision support for the current recommendation.
 *
 * Does NOT modify:
 * - original query
 * - original selection
 * - cards
 * - catalog
 *
 * At most:
 * - one date alternative
 * - one budget alternative
 *
 * Order is always:
 * 1. date
 * 2. budget
 */
export function buildDecisionSupport(
  catalog: Catalog,
  original: Selection,
  cards: Card[],
): DecisionSupport {
  /*
   * Category doesn't exist in this city.
   *
   * Changing date/budget cannot create the category,
   * so do not offer alternatives or comparisons.
   */
  if (original.base_count === 0) {
    return {
      version: 'v1',
      status: 'no_category',
      alternatives: [],
      comparison: [],
      message:
        'Изменение даты или бюджета не добавит эту категорию в каталог города.',
    };
  }

  /*
   * Comparison is based ONLY on current cards.
   *
   * buildComparison returns [] automatically when
   * there are fewer than 2 cards.
   */
  const comparison = buildComparison(cards);

  /*
   * Already enough eligible profiles.
   * No alternatives needed.
   */
  if (original.eligible_count >= 3) {
    return {
      version: 'v1',
      status: 'not_needed',
      alternatives: [],
      comparison,
      message: null,
    };
  }

  const alternatives: DecisionAlternative[] = [];

  /*
   * Date MUST come before budget.
   */
  const dateAlternative =
    findDateAlternative(catalog, original);

  if (dateAlternative !== null) {
    alternatives.push(dateAlternative);
  }

  const budgetAlternative =
    findBudgetAlternative(catalog, original);

  if (budgetAlternative !== null) {
    alternatives.push(budgetAlternative);
  }

  /*
   * At least one useful single-field change exists.
   */
  if (alternatives.length > 0) {
    return {
      version: 'v1',
      status: 'available',
      alternatives,
      comparison,
      message: null,
    };
  }

  /*
   * Category exists, fewer than 3 eligible vendors,
   * but neither changing only date nor only budget
   * improves the result.
   */
  return {
    version: 'v1',
    status: 'no_single_change',
    alternatives: [],
    comparison,
    message:
      'Смена только даты в пределах 7 дней или только бюджета не увеличивает число подходящих профилей; остальные условия сохранены.',
  };
}
