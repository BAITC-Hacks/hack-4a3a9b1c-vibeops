import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import type { Vendor } from '../shared/contracts.js';

export type Catalog = { vendors: Vendor[]; sha256: string };
export const DATE_MIN = '2026-09-23';
export const DATE_MAX = '2026-12-31';
const list = (value: string): string[] => value ? value.split('|').map(s => s.trim()).filter(Boolean) : [];

export function loadCatalog(csvPath: string): Catalog {
  const raw = readFileSync(csvPath);
  const records = parse(raw, { columns: true, bom: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  const ids = new Set<string>();
  const required = ['id', 'anon_name', 'categories', 'city', 'price_from_kzt', 'event_formats', 'languages', 'max_hours', 'busy_dates', 'description', 'synthetic', 'city_imputed', 'price_imputed'];
  function flag(value: string): boolean {
    if (!/^(true|false)$/i.test(value)) throw new Error('Invalid dataset flag');
    return value.toLowerCase() === 'true';
  }
  const vendors = records.map((r): Vendor => {
    if (required.some(key => typeof r[key] !== 'string') || !r.id || !r.anon_name || !r.city || !r.description || ids.has(r.id)) throw new Error('Invalid dataset row');
    ids.add(r.id);
    const price = Number(r.price_from_kzt);
    const hours = r.max_hours === '' ? null : Number(r.max_hours);
    const categories = list(r.categories!); const formats = list(r.event_formats!); const languages = list(r.languages!); const dates = list(r.busy_dates!);
    if (!r.price_from_kzt || !Number.isSafeInteger(price) || price < 0 || (hours !== null && (!Number.isFinite(hours) || hours <= 0)) || !categories.length || !formats.length || !languages.length) throw new Error('Invalid dataset values');
    if (dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < DATE_MIN || date > DATE_MAX || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Invalid dataset calendar');
    return { id: r.id, anon_name: r.anon_name, city: r.city, categories,
      price_from_kzt: price, max_hours: hours, event_formats: formats, languages, busy_dates: dates,
      description: r.description, synthetic: flag(r.synthetic!), city_imputed: flag(r.city_imputed!), price_imputed: flag(r.price_imputed!),
    };
  });
  if (!vendors.length) throw new Error('Empty dataset');
  return { vendors, sha256: createHash('sha256').update(raw).digest('hex') };
}

export function catalogOptions(catalog: Catalog) {
  const unique = (values: string[]) => [...new Set(values)].sort();
  return {
    cities: unique(catalog.vendors.map(v => v.city)),
    categories: unique(catalog.vendors.flatMap(v => v.categories)),
    event_formats: unique(catalog.vendors.flatMap(v => v.event_formats)),
    languages: unique(catalog.vendors.flatMap(v => v.languages)),
    date_min: DATE_MIN, date_max: DATE_MAX, currency: 'KZT' as const,
  };
}
