import type { Query } from '../shared/contracts.js';
import { catalogOptions, DATE_MIN, DATE_MAX, type Catalog } from './catalog.js';

export class QueryValidationError extends Error {
  constructor(public code: string, message: string, public fields: Record<string, string>) { super(message); }
}

export function validateQuery(raw: unknown, catalog: Catalog): Query {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QueryValidationError('VALIDATION_ERROR', 'Ожидается объект с параметрами заказа.', { body: 'Передайте JSON-объект.' });
  const body = raw as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const options = catalogOptions(catalog);
  const text = (key: string) => {
    const v = body[key];
    if (typeof v !== 'string' || !v.trim() || v.length > 100) { fields[key] = 'Нужна непустая строка до 100 символов.'; return ''; }
    return v.trim().replace(/\s+/gu, ' ');
  };
  const canonical = (key: string, values: string[], allowUnknown = false) => {
    const value = text(key);
    const found = values.find(v => v.toLowerCase() === value.toLowerCase());
    if (!found && !allowUnknown && !fields[key]) fields[key] = 'Выберите значение из каталога.';
    return found ?? value;
  };
  const city = canonical('city', options.cities);
  const category = canonical('category', options.categories, true);
  const event_format = canonical('event_format', options.event_formats);
  const date = text('date');
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fields.date = 'Укажите существующую дату YYYY-MM-DD.';
  const budget = body.budget_kzt;
  if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 0) fields.budget_kzt = 'Бюджет — целое число тенге не меньше нуля.';
  const hours = body.hours ?? null;
  if (hours !== null && (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)) fields.hours = 'Длительность должна быть положительным числом.';
  const language = body.language == null ? null : canonical('language', options.languages);
  if ('duration_hours' in body) fields.hours = 'Используйте поле hours вместо duration_hours.';
  if (Object.keys(fields).length) throw new QueryValidationError('VALIDATION_ERROR', 'Проверьте параметры заказа.', fields);
  if (date < DATE_MIN || date > DATE_MAX) throw new QueryValidationError('DATE_OUT_OF_RANGE', 'Дата вне известного календаря: 23.09–31.12.2026.', { date: 'Вне этого периода доступность неизвестна.' });
  return { city, category, event_format, date, budget_kzt: budget as number, hours: hours as number | null, language };
}
