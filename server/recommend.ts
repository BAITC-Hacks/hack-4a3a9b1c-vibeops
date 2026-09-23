 import type { Catalog } from './catalog.js';
import type { Vendor } from '../shared/contracts.js';

export type RecommendRequest = {
  city: string;
  date: string;
  event_format: string;
  category: string;
  budget_kzt: number;
  hours?: number;
  language?: string;
};

export function recommend(
  catalog: Catalog,
  input: RecommendRequest
): Vendor[] {
  return catalog.vendors
    .filter(v => v.city === input.city)

    .filter(v =>
      v.categories.includes(input.category)
    )

    // занят на эту дату
    .filter(v =>
      !v.busy_dates.includes(input.date)
    )

    // работает с таким типом мероприятия
    .filter(v =>
      v.event_formats.includes(input.event_format)
    )

    // вписывается в бюджет
    .filter(v =>
      v.price_from_kzt <= input.budget_kzt
    )

    // если указана длительность
    .filter(v =>
      input.duration_hours === undefined ||
      v.max_hours === null ||
      v.max_hours >= input.duration_hours
    )

    // если указан язык
    .filter(v =>
      input.language === undefined ||
      v.languages.includes(input.language)
    );
}
