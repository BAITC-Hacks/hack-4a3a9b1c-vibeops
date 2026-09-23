import { createHash } from 'node:crypto';
import type { ExplainResult, Query, RankedVendor } from '../../shared/contracts.js';
import { buildExplanationSet, verifiedQuote, usefulEvidenceOptions } from './evidence.js';
import { PROMPT_VERSION, requestEvidence, type EvidenceProvider } from './provider.js';
export { fallbackExplanation } from './evidence.js';

export type ExplainInput = { query: Query; candidates: RankedVendor[]; dataset_sha256: string };
type Config = { apiKey?: string; model?: string };
type Dependencies = { provider?: EvidenceProvider; config?: () => Config; timeoutMs?: number; now?: () => number };
const MAX_CACHE = 200;
const CACHE_TTL_MS = 10 * 60_000;
const object = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Separate instances allow isolated provider tests, without changing the production exports. */
export function createExplainer(deps: Dependencies = {}): (input: ExplainInput) => Promise<ExplainResult> {
  const provider = deps.provider ?? requestEvidence;
  const config = deps.config ?? (() => ({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }));
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { result: ExplainResult; expires: number }>();
  const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? 6_000, 6_000));

  return async (input) => {
    const { query, candidates, dataset_sha256 } = input;
    if (candidates.length > 3 || new Set(candidates.map(c => c.vendor.id)).size !== candidates.length) {
      throw new Error('explainSelection expects at most three unique, already selected candidates');
    }
    if (!candidates.length) return { items: [], mode: 'not_needed', warning: null, model: null, cached: false };
    const { apiKey, model } = config();
    const fallback = (warning: string): ExplainResult => ({
      items: buildExplanationSet(query, candidates).items, mode: 'fallback', warning, model: null, cached: false,
    });
    if (!apiKey?.trim() || !model?.trim()) return fallback('AI не настроен: объяснения собраны из полей и описаний каталога без LLM.');
    const canonicalQuery = [query.city, query.date, query.event_format, query.category, query.budget_kzt, query.hours ?? null, query.language ?? null];
    // Include candidate order/content defensively; the caller owns selection and ranking.
    const key = createHash('sha256').update(JSON.stringify([canonicalQuery, dataset_sha256, model, PROMPT_VERSION, candidates])).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.expires > now()) {
      cache.delete(key); cache.set(key, hit);
      return { ...structuredClone(hit.result), cached: true };
    }
    if (hit) cache.delete(key);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('AI_TIMEOUT')); }, timeoutMs);
      });
      const raw = await Promise.race([provider({ query, candidates, apiKey, model, signal: controller.signal }), timeout]);
      if (!object(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.items) || raw.items.length > 20) {
        return fallback('AI вернул неверный формат: использованы описания каталога без LLM.');
      }
      const ids = new Set(candidates.map(c => c.vendor.id));
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      const quotes = new Map<string, unknown>();
      let extraInvalid = false;
      for (const row of raw.items) {
        if (!object(row) || typeof row.id !== 'string' || !ids.has(row.id)) {
          extraInvalid = true; continue;
        }
        if (seen.has(row.id)) duplicates.add(row.id);
        seen.add(row.id);
        if (typeof row.quote !== 'string' || Object.keys(row).sort().join(',') !== 'id,quote') {
          extraInvalid = true; continue;
        }
        quotes.set(row.id, row.quote);
      }
      const preferred = new Map<string, string>();
      for (const candidate of candidates) {
        const quote = duplicates.has(candidate.vendor.id) ? null : verifiedQuote(candidate.vendor.description, quotes.get(candidate.vendor.id));
        if (quote && usefulEvidenceOptions(query, candidate.vendor.description).includes(quote)) preferred.set(candidate.vendor.id, quote);
      }
      const { items, sharedEvidence } = buildExplanationSet(query, candidates, preferred);
      const llmCount = items.filter(i => i.source === 'llm').length;
      const mode = llmCount === items.length ? 'llm' : llmCount === 0 ? 'fallback' : 'mixed';
      const sourceWarning = mode !== 'llm' ? 'Для части или всех карточек AI не дал проверяемого конкретного основания; использовано извлечение из каталога без LLM.'
        : extraInvalid ? 'Некорректные дополнительные элементы ответа AI отброшены.' : null;
      const warning = [sourceWarning, sharedEvidence ? 'Для части карточек в описаниях не найдено отдельных отличительных сведений; различия не выдумываются.' : null].filter(Boolean).join(' ') || null;
      const result: ExplainResult = { items, mode, warning, model: llmCount ? model : null, cached: false };
      // Transient failures/mixed results never persist in cache.
      if (mode === 'llm' && !extraInvalid) {
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(key, { result: structuredClone(result), expires: now() + CACHE_TTL_MS });
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) return fallback('AI не ответил за 6 секунд: объяснения собраны из каталога без LLM.');
      const status = object(error) ? error.status : undefined;
      if (status === 429) return fallback('Достигнут лимит AI: объяснения собраны из каталога без LLM.');
      if (status === 401 || status === 403) return fallback('Нет доступа к AI: объяснения собраны из каталога без LLM.');
      return fallback('AI недоступен или вернул некорректный ответ: объяснения собраны из каталога без LLM.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export const explainSelection = createExplainer();
