/** Public reference rates, never a promise of a bank's cash/card conversion price. */
export type Currency = 'USD' | 'EUR' | 'RUB';
export type ExchangeRate = { currency: Currency; kzt_per_unit: number; date: string; source_url: string };
export const RATE_SOURCE = 'https://nationalbank.kz/rss/rates_all.xml';
const MAX_AGE_DAYS = 7;
const CURRENCIES: Currency[] = ['USD', 'EUR', 'RUB'];

// Captured directly from the official NBK feed on 2026-09-23.
// A dated, short-lived offline reference; it expires under the same rule as a fetched rate.
const SNAPSHOT: ExchangeRate[] = [
  { currency: 'USD', kzt_per_unit: 447.85, date: '2026-09-23', source_url: RATE_SOURCE },
  { currency: 'EUR', kzt_per_unit: 513.46, date: '2026-09-23', source_url: RATE_SOURCE },
  { currency: 'RUB', kzt_per_unit: 5.31, date: '2026-09-23', source_url: RATE_SOURCE },
];

function today(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function fresh(rate: ExchangeRate, now: Date): boolean {
  const date = new Date(`${rate.date}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== rate.date) return false;
  const age = (Date.parse(`${today(now)}T00:00:00Z`) - date.getTime()) / 86_400_000;
  return age >= 0 && age <= MAX_AGE_DAYS && Number.isFinite(rate.kzt_per_unit) && rate.kzt_per_unit > 0;
}

/** Parse only the fixed public feed fields. Never execute XML entities or embedded markup. */
export function parseExchangeRates(xml: string, now: Date): ExchangeRate[] {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) return [];
  const rates = new Map<Currency, ExchangeRate>();
  const duplicate = new Set<Currency>();
  for (const block of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)) {
    const field = (name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'iu').exec(block[1]!)?.[1]?.trim();
    const currency = field('title') as Currency;
    if (!CURRENCIES.includes(currency)) continue;
    if (rates.has(currency)) duplicate.add(currency);
    const date = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(field('pubDate') ?? '');
    const value = field('description') ?? '';
    const quant = field('quant') ?? '';
    if (!date || !/^\d+(?:[.,]\d+)?$/u.test(value) || !/^\d+$/u.test(quant) || Number(quant) <= 0) continue;
    const perUnit = Number((Number(value.replace(',', '.')) / Number(quant)).toPrecision(14));
    const rate: ExchangeRate = { currency, kzt_per_unit: perUnit, date: `${date[3]}-${date[2]}-${date[1]}`, source_url: RATE_SOURCE };
    if (fresh(rate, now)) rates.set(currency, rate);
  }
  return [...rates.values()].filter(rate => !duplicate.has(rate.currency));
}

export function createExchangeRateLoader(deps: { fetch?: typeof fetch; snapshot?: ExchangeRate[] } = {}) {
  let cached: ExchangeRate[] = [];
  let retryAfter = 0;
  let pending: Promise<void> | null = null;
  return async (currency: Currency, now = new Date()): Promise<ExchangeRate | null> => {
    if (!CURRENCIES.includes(currency) || !Number.isFinite(now.getTime())) return null;
    if (now.getTime() >= retryAfter) {
      pending ??= (async () => {
        // Negative cache prevents a failing public feed from delaying every request.
        retryAfter = now.getTime() + 60_000;
        try {
          const response = await (deps.fetch ?? globalThis.fetch)(RATE_SOURCE, { signal: AbortSignal.timeout(2500), headers: { accept: 'application/xml, text/xml' } });
          if (!response.ok) return;
          const parsed = parseExchangeRates(await response.text(), now);
          if (parsed.length) {
            cached = parsed;
            retryAfter = now.getTime() + 60 * 60_000;
          }
        } catch { /* A dated snapshot is used only while still valid; no fabricated rate. */ }
      })();
      try { await pending; } finally { pending = null; }
    } else if (pending) {
      await pending;
    }
    const rate = [...cached, ...(deps.snapshot ?? SNAPSHOT)].find(rate => rate.currency === currency && fresh(rate, now));
    return rate ? { ...rate } : null;
  };
}

export const getExchangeRate = createExchangeRateLoader();
