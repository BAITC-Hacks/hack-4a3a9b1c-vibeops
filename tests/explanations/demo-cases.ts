import { loadCatalog } from '../../server/catalog.js';
import type { Query, RankedVendor } from '../../shared/contracts.js';

const catalog = loadCatalog(process.env.DATASET_PATH || 'data/vendors.csv');
const query: Query = { city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив', category: 'Ведущий', budget_kzt: 1_000_000, hours: null, language: null };

// Preset eligible profiles from the organizer's CSV; this tests explanations, NOT ranking/API.
const definitions = [
  { name: 'D1', query, ids: ['HK-88430', 'HK-27222', 'HK-29829'] },
  { name: 'D2', query: { ...query, date: '2026-10-11' }, ids: ['HK-44733', 'HK-44923', 'HK-27222'] },
  { name: 'D3', query: { ...query, category: 'Флорист', event_format: 'свадьба', budget_kzt: 500_000 }, ids: ['HK-39372'] },
  { name: 'D4', query: { ...query, city: 'Астана', category: 'Декоратор', event_format: 'свадьба', budget_kzt: 500_000 }, ids: [] },
  { name: 'D5', query: { ...query, budget_kzt: 1 }, ids: [] },
  { name: 'D6', query: { ...query, category: 'Банкетный зал', date: '2026-11-14', event_format: 'свадьба', budget_kzt: 5_000_000 }, ids: ['HK-64395', 'HK-90011'] },
];

export const demoCases = definitions.map(({ name, query, ids }) => ({
  name, input: { query, dataset_sha256: catalog.sha256, candidates: ids.map((id): RankedVendor => {
    const vendor = catalog.vendors.find(v => v.id === id);
    if (!vendor) throw new Error(`Demo profile missing: ${id}`);
    return { vendor, relevance_score: 0, matched_terms: [] };
  }) },
}));
