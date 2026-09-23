import type { Query, Vendor, Selection, Reason } from '../shared/contracts.js';

export const REASON_LABELS: Record<Reason, string> = {
  busy_date: 'занятость на дату', over_budget: 'стартовая цена выше бюджета',
  unsupported_format: 'неподходящий формат', unsupported_language: 'неподходящий язык', insufficient_hours: 'недостаточная длительность',
};
const markers: Record<string, RegExp[]> = {
  корпоратив: [/корпоратив/u, /делов|бизнес/u, /компан|бренд/u],
  конференция: [/конференц/u, /форум/u, /делов|бизнес/u],
  свадьба: [/свад/u, /невест|жених|молодож/u, /церемон/u],
  той: [/той|тоя|тоев/u, /традиц|национальн/u, /семейн/u],
  юбилей: [/юбиле/u, /семейн/u, /праздн/u],
  'день рождения': [/день рождения|дня рождения/u, /именин/u, /детск|взросл/u],
};

/** Normalized Query in, all eligible vendors in stable ranking-v1 order out. */
export function selectVendors(vendors: Vendor[], query: Query): Selection {
  const base = vendors.filter(v => v.city === query.city && v.categories.includes(query.category));
  const counts: Record<Reason, number> = { busy_date: 0, over_budget: 0, unsupported_format: 0, unsupported_language: 0, insufficient_hours: 0 };
  const rejected: Selection['rejected'] = [];
  const ranked: Selection['ranked'] = [];
  for (const vendor of base) {
    const reasons: Reason[] = [];
    if (vendor.busy_dates.includes(query.date)) reasons.push('busy_date');
    if (vendor.price_from_kzt > query.budget_kzt) reasons.push('over_budget');
    if (!vendor.event_formats.includes(query.event_format)) reasons.push('unsupported_format');
    if (query.language !== null && !vendor.languages.includes(query.language)) reasons.push('unsupported_language');
    if (query.hours !== null && vendor.max_hours !== null && vendor.max_hours < query.hours) reasons.push('insufficient_hours');
    if (reasons.length) {
      rejected.push({ id: vendor.id, anon_name: vendor.anon_name, reasons });
      for (const reason of reasons) counts[reason]++;
    } else {
      const text = vendor.description.toLowerCase().replace(/ё/gu, 'е');
      const terms = (markers[query.event_format] ?? []).map(pattern => text.match(pattern)?.[0]).filter((value): value is string => Boolean(value));
      ranked.push({ vendor, relevance_score: terms.length, matched_terms: terms });
    }
  }
  ranked.sort((a, b) => b.relevance_score - a.relevance_score || a.vendor.price_from_kzt - b.vendor.price_from_kzt || (a.vendor.id < b.vendor.id ? -1 : a.vendor.id > b.vendor.id ? 1 : 0));
  rejected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { outcome: !base.length ? 'no_category_in_city' : ranked.length ? 'matched' : 'no_matches', query,
    base_count: base.length, eligible_count: ranked.length, ranked, rejected, rejection_counts: counts };
}
