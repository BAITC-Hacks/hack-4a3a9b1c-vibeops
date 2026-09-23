import type { Catalog } from './catalog.js';
import type { Vendor } from '../shared/contracts.js';

export type Recommendation = {
  id: string;
  name: string;
  category: string;
  city: string;
  price_from_kzt: number;
  explanation: string;
};

export type RecommendResult = {
  status: 'matched' | 'category_not_found' | 'no_match';
  recommendations: Recommendation[];
  message?: string;
};
export function recommend(
  catalog: Catalog,
  input: RecommendRequest
): RecommendResult {
  // 1. First: does this category exist in this city at all?
  const baseCandidates = catalog.vendors.filter(v =>
    v.city === input.city &&
    v.categories.includes(input.category)
  );

  if (baseCandidates.length === 0) {
    return {
      status: 'category_not_found',
      recommendations: [],
      message: `В городе ${input.city} нет подрядчиков категории «${input.category}».`,
    };
  }

  // 2. Apply hard requirements
  const candidates = baseCandidates.filter(v =>
    !v.busy_dates.includes(input.date) &&
    v.event_formats.includes(input.event_format) &&
    v.price_from_kzt <= input.budget_kzt &&
    (
      input.duration_hours === undefined ||
      v.max_hours === null ||
      v.max_hours >= input.duration_hours
    ) &&
    (
      input.language === undefined ||
      v.languages.includes(input.language)
    )
  );

  // 3. Category exists, but nobody satisfies conditions
  if (candidates.length === 0) {
    return {
      status: 'no_match',
      recommendations: [],
      message: 'Подрядчики есть, но никто не проходит по заданным условиям.',
    };
  }

  // 4. Deterministic order
  candidates.sort((a, b) => {
    if (a.price_from_kzt !== b.price_from_kzt) {
      return a.price_from_kzt - b.price_from_kzt;
    }

    return a.id.localeCompare(b.id);
  });

  // 5. Top 3 + explanations
  const recommendations = candidates.slice(0, 3).map(v => {
    const reasons: string[] = [];

    reasons.push(
      `Цена от ${v.price_from_kzt.toLocaleString('ru-RU')} ₸ укладывается в бюджет ${input.budget_kzt.toLocaleString('ru-RU')} ₸.`
    );

    if (input.language) {
      reasons.push(`Работает на языке: ${input.language}.`);
    } else if (v.languages.length > 1) {
      reasons.push(`Работает на языках: ${v.languages.join(', ')}.`);
    }

    if (
      input.duration_hours !== undefined &&
      v.max_hours !== null
    ) {
      reasons.push(
        `Может работать до ${v.max_hours} ч., что подходит под длительность ${input.duration_hours} ч.`
      );
    }

    return {
      id: v.id,
      name: v.anon_name,
      category: input.category,
      city: v.city,
      price_from_kzt: v.price_from_kzt,
      explanation: reasons.slice(0, 2).join(' '),
    };
  });

  return {
    status: 'matched',
    recommendations,
  };
}
