import type { Catalog } from './catalog.js';

export type RecommendRequest = {
  city: string;
  date: string;
  event_format: string;
  category: string;
  budget_kzt: number;
  duration_hours?: number;
  language?: string;
};

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
  // Все подрядчики этой категории в городе.
  const baseCandidates = catalog.vendors.filter(v =>
    v.city === input.city &&
    v.categories.includes(input.category)
  );

  if (baseCandidates.length === 0) {
    return {
      status: 'category_not_found',
      recommendations: [],
      message:
        `В городе ${input.city} нет подрядчиков категории «${input.category}».`,
    };
  }

  // Причины отказа.
  let busyCount = 0;
  let budgetCount = 0;
  let formatCount = 0;
  let durationCount = 0;
  let languageCount = 0;

  const candidates = baseCandidates.filter(v => {
    let accepted = true;

    if (v.busy_dates.includes(input.date)) {
      busyCount++;
      accepted = false;
    }

    if (!v.event_formats.includes(input.event_format)) {
      formatCount++;
      accepted = false;
    }

    if (v.price_from_kzt > input.budget_kzt) {
      budgetCount++;
      accepted = false;
    }

    if (
      input.duration_hours !== undefined &&
      v.max_hours !== null &&
      v.max_hours < input.duration_hours
    ) {
      durationCount++;
      accepted = false;
    }

    if (
      input.language !== undefined &&
      !v.languages.includes(input.language)
    ) {
      languageCount++;
      accepted = false;
    }

    return accepted;
  });

  if (candidates.length === 0) {
    const reasons: string[] = [];

    if (busyCount)
      reasons.push(`заняты на дату — ${busyCount}`);

    if (budgetCount)
      reasons.push(`выше бюджета — ${budgetCount}`);

    if (formatCount)
      reasons.push(`не работают с форматом — ${formatCount}`);

    if (durationCount)
      reasons.push(`не подходят по длительности — ${durationCount}`);

    if (languageCount)
      reasons.push(`не подходят по языку — ${languageCount}`);

    return {
      status: 'no_match',
      recommendations: [],
      message:
        `В категории найдено ${baseCandidates.length} профилей, но подходящих нет. ` +
        reasons.join('; ') +
        '.',
    };
  }

  // Детерминированная сортировка.
  candidates.sort((a, b) => {
    if (a.price_from_kzt !== b.price_from_kzt) {
      return a.price_from_kzt - b.price_from_kzt;
    }

    return a.id.localeCompare(b.id);
  });

  const recommendations = candidates
    .slice(0, 3)
    .map(v => {
      const reasons: string[] = [];

      reasons.push(
        `Цена от ${v.price_from_kzt.toLocaleString('ru-RU')} ₸ укладывается в бюджет ${input.budget_kzt.toLocaleString('ru-RU')} ₸.`
      );

      if (input.language) {
        reasons.push(`Работает на языке: ${input.language}.`);
      } else if (v.languages.length > 1) {
        reasons.push(
          `Работает на языках: ${v.languages.join(', ')}.`
        );
      }

      if (
        input.duration_hours !== undefined &&
        v.max_hours !== null
      ) {
        reasons.push(
          `Может работать до ${v.max_hours} ч., запрос рассчитан на ${input.duration_hours} ч.`
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

  let message =
    `Подходят ${candidates.length} из ${baseCandidates.length} профилей. ` +
    `Показаны ${recommendations.length}.`;

  if (baseCandidates.length > candidates.length) {
    const rejectedReasons: string[] = [];

    if (busyCount)
      rejectedReasons.push(`заняты — ${busyCount}`);

    if (budgetCount)
      rejectedReasons.push(`выше бюджета — ${budgetCount}`);

    if (formatCount)
      rejectedReasons.push(`не берут формат — ${formatCount}`);

    if (durationCount)
      rejectedReasons.push(`не подходят по длительности — ${durationCount}`);

    if (languageCount)
      rejectedReasons.push(`не подходят по языку — ${languageCount}`);

    message += ` Исключены: ${rejectedReasons.join('; ')}.`;
  }

  return {
    status: 'matched',
    recommendations,
    message,
  };
}
