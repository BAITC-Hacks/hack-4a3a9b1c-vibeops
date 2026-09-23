import type { ApiError, Query, RecommendResponse } from '../../shared/contracts';
import type { AssistantBrief, AssistantComparison, AssistantDraft } from '../../shared/assistant';

export interface CatalogOptions {
  cities: string[];
  categories: string[];
  event_formats: string[];
  languages: string[];
  date_min: string;
  date_max: string;
  currency: 'KZT';
}

export class RequestError extends Error {
  constructor(message: string, public fields: Record<string, string> = {}, public code = 'REQUEST_ERROR') {
    super(message);
    this.name = 'RequestError';
  }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const validDate = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const reasons = ['busy_date', 'over_budget', 'unsupported_format', 'unsupported_language', 'insufficient_hours'];
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new RequestError('Не удалось связаться с сервером. Проверьте соединение и повторите запрос.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RequestError('Сервер вернул ответ в неожиданном формате. Попробуйте ещё раз.');
  }
  if (!response.ok) {
    const failure = body as Partial<ApiError> | null;
    const details = failure?.error;
    throw new RequestError(
      typeof details?.message === 'string' ? details.message : 'Не удалось выполнить запрос. Попробуйте ещё раз.',
      record(details?.fields) ? Object.fromEntries(Object.entries(details.fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
      typeof details?.code === 'string' ? details.code : 'REQUEST_ERROR',
    );
  }
  return body as T;
}

export async function getOptions(signal: AbortSignal): Promise<CatalogOptions> {
  const options = await request<CatalogOptions>('/api/options', { signal });
  if (!options || !['cities', 'categories', 'event_formats', 'languages'].every(
    key => strings(options[key as keyof CatalogOptions]),
  ) || !validDate(options.date_min) || !validDate(options.date_max) || options.date_min > options.date_max || options.currency !== 'KZT') {
    throw new RequestError('Не удалось загрузить параметры каталога: неверный ответ сервера.');
  }
  return options;
}

export async function recommend(query: Query, signal: AbortSignal): Promise<RecommendResponse> {
  const result = await request<RecommendResponse>('/api/recommend', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query), signal,
  });
  if (!result || !['matched', 'no_category_in_city', 'no_matches'].includes(result.outcome) ||
      !Array.isArray(result.cards) || result.cards.length > 3 || !result.query || !result.summary ||
      !Array.isArray(result.summary.rejected) || !result.summary.rejection_counts ||
      !result.explanation || !result.meta || (result.outcome === 'matched' ? result.cards.length === 0 : result.cards.length !== 0) ||
      !validDate(result.query.date) || !['city', 'category', 'event_format'].every(key => typeof result.query[key as keyof Query] === 'string') ||
      !count(result.query.budget_kzt) || !(result.query.language === null || typeof result.query.language === 'string') ||
      !(result.query.hours === null || (typeof result.query.hours === 'number' && Number.isFinite(result.query.hours) && result.query.hours > 0)) ||
      !['base_count', 'eligible_count', 'returned_count', 'rejected_count'].every(key => count(result.summary[key as keyof typeof result.summary])) ||
      typeof result.summary.message !== 'string' || result.summary.returned_count !== result.cards.length ||
      !reasons.every(reason => count(result.summary.rejection_counts[reason as keyof typeof result.summary.rejection_counts])) ||
      !result.summary.rejected.every(item => record(item) && typeof item.id === 'string' && typeof item.anon_name === 'string' && strings(item.reasons) && item.reasons.every(reason => reasons.includes(reason))) ||
      !['llm', 'fallback', 'mixed', 'not_needed'].includes(result.explanation.mode) ||
      !(result.explanation.warning === null || typeof result.explanation.warning === 'string') ||
      !(result.explanation.model === null || typeof result.explanation.model === 'string') || typeof result.explanation.cached !== 'boolean' ||
      typeof result.meta.elapsed_ms !== 'number' || !Number.isFinite(result.meta.elapsed_ms) || typeof result.meta.dataset_sha256 !== 'string' ||
      !result.cards.every(card => record(card) && (['id', 'name', 'category', 'city', 'explanation'] as const).every(key => typeof card[key] === 'string') &&
        strings(card.languages) && strings(card.categories) && count(card.price_from_kzt) &&
        (card.max_hours === null || (typeof card.max_hours === 'number' && Number.isFinite(card.max_hours) && card.max_hours > 0)) &&
        (['synthetic', 'city_imputed', 'price_imputed'] as const).every(key => typeof card[key] === 'boolean') &&
        (card.evidence_quote === null || typeof card.evidence_quote === 'string') && ['llm', 'fallback'].includes(card.explanation_source as string))) {
    throw new RequestError('Не удалось прочитать результат подбора. Повторите запрос.');
  }
  return result;
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const draftKeys = ['city', 'date', 'event_format', 'category', 'budget_kzt', 'hours', 'language'] as const;
const validDraft = (value: unknown): value is AssistantDraft => record(value) &&
  ['city', 'date', 'event_format', 'category', 'language'].every(key => value[key] === null || (text(value[key]) && value[key].length <= 100)) &&
  ['budget_kzt', 'hours'].every(key => value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key])));
const validQuery = (value: unknown): value is Query => validDraft(value) &&
  ['city', 'date', 'event_format', 'category', 'budget_kzt'].every(key => value[key as keyof Query] !== null) &&
  validDate(value.date) && count(value.budget_kzt) && (value.hours === null || value.hours > 0);

export async function prepareBrief(messages: string[], signal: AbortSignal): Promise<AssistantBrief> {
  const result = await request<unknown>('/api/assistant/brief', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }), signal,
  });
  if (!record(result) || !validDraft(result.draft) || !text(result.summary) ||
      !strings(result.questions) || !strings(result.preferences) || !strings(result.warnings) ||
      result.source !== 'llm' || !text(result.model) ||
      !(result.query === null || (validQuery(result.query) && draftKeys.every(key => (result.query as Query)[key] === (result.draft as AssistantDraft)[key])))) {
    throw new RequestError('Не удалось прочитать ответ AI. Попробуйте уточнить запрос и отправить его снова.');
  }
  return result as AssistantBrief;
}

export async function comparePreferences(query: Query, preferences: string[], signal: AbortSignal): Promise<AssistantComparison> {
  const result = await request<unknown>('/api/assistant/compare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, preferences }), signal,
  });
  if (!record(result) || !Array.isArray(result.items) || result.items.length > 3 ||
      !(result.source === 'llm' ? text(result.model) : result.source === 'not_needed' && result.model === null) ||
      !result.items.every(item => {
        if (!record(item) || !text(item.id) || !text(item.name) || !Array.isArray(item.evidence) || !strings(item.to_confirm)) return false;
        const evidence = item.evidence;
        const toConfirm = item.to_confirm;
        if (!evidence.every(match => record(match) && text(match.preference) && preferences.includes(match.preference) && text(match.quote)) ||
            !toConfirm.every(preference => preferences.includes(preference))) return false;
        const covered = [...evidence.map(match => match.preference as string), ...toConfirm];
        return new Set(covered).size === covered.length && preferences.every(preference => covered.includes(preference));
      }) ||
      new Set(result.items.map(item => item.id)).size !== result.items.length) {
    throw new RequestError('Не удалось прочитать AI-сравнение. Подбор по условиям доступен ниже.');
  }
  return result as AssistantComparison;
}
