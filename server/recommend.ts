import type { Catalog } from './catalog.js';
import type { Vendor } from '../shared/contracts.js';

export type RecommendRequest = {
  city: string;
  date: string;
  event_format: string;
  category: string;
  budget_kzt: number;
  duration_hours?: number;
  language?: string;
};

export function recommend(catalog: Catalog, input: RecommendRequest) {
  const candidates = catalog.vendors.filter(v =>
    v.city === input.city &&
    v.categories.includes(input.category)
  );

  console.log('Candidates:', candidates.length);

  return candidates;
}
