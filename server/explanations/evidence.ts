import type { Explanation, Query, RankedVendor } from '../../shared/contracts.js';

export const normalize = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const markers: Record<string, RegExp[]> = {
  корпоратив: [/корпоратив/iu, /делов|бизнес/iu, /компан|бренд/iu],
  конференция: [/конференц/iu, /форум/iu, /делов|бизнес/iu],
  свадьба: [/свад/iu, /невест|жених|молодож/iu, /церемон/iu],
  той: [/той|тоя|тоев/iu, /традиц|национальн/iu, /семейн/iu],
  юбилей: [/юбиле/iu, /семейн/iu, /праздн/iu],
  'день рождения': [/день рождения|дня рождения/iu, /именин/iu, /детск|взросл/iu],
};

/** Whitespace/NFC may differ; casing, words, numbers and punctuation may not. */
export function verifiedQuote(description: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const quote = normalize(raw);
  if (!quote || [...quote].length > 220 || /[.!?…]\s+\S/u.test(quote)) return null;
  return normalize(description).includes(quote) ? quote : null;
}

export function evidenceOptions(description: string): string[] {
  const phrases = normalize(description).match(/[^.!?…]+[.!?…]?/gu) ?? [];
  const options = phrases.flatMap((sentence) => {
    if ([...sentence.trim()].length <= 220) return [sentence.trim()];
    // Long sentences can still contain a complete, continuous clause.
    return sentence.split(/[,;:•]\s*/u).map(s => s.trim());
  }).flatMap(fragment => {
    // Some organizer descriptions are long unpunctuated lists. Keep continuous
    // word-aligned excerpts instead of dropping the entire source or inventing text.
    const chunks: string[] = [];
    let rest = fragment.trim();
    while ([...rest].length > 220) {
      const prefix = [...rest].slice(0, 220).join('');
      const boundary = prefix.lastIndexOf(' ');
      if (boundary < 0) {
        const nextSpace = rest.indexOf(' ');
        rest = nextSpace < 0 ? '' : rest.slice(nextSpace + 1).trim();
        continue;
      }
      chunks.push(rest.slice(0, boundary));
      rest = rest.slice(boundary + 1).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }).filter(s => s.length >= 18 && [...s].length <= 220);
  return [...new Set(options)].slice(0, 60);
}

/** A conservative lexical quality check, not a claim of semantic understanding. */
export function usefulEvidenceOptions(query: Query, description: string): string[] {
  const options = evidenceOptions(description);
  const scored = options.map((quote, index) => {
    const t = quote.toLowerCase().replace(/ё/gu, 'е');
    const format = (markers[query.event_format] ?? []).filter(r => r.test(t)).length;
    const concrete = /двуязыч|телевид|телеканал|радиостанц|акт[её]р|танц|развлеч|флорист|декор|букет|банкет|вместим|оборудован|фотограф|съем|монтаж|репертуар|инструмент|мастер-класс|импровизац|юмор|сценари|интерактив|панорам|террас|вид на|ресторан|кейтеринг|парковк|цветоч|скрипк|саксофон|вокал|печать|печат|светов|пиксель|фотозон|сувенир|мерч|кухн|\d+\s*(?:лет|год|года|гостей|человек|мест)/iu.test(t);
    const language = query.language !== null && t.includes(query.language.toLowerCase());
    const promotional = /лучш|идеальн|безупреч|востребован|профессиональн|ответственн|отличный выбор|незабываем|вау-эффект/iu.test(t);
    // A format name inside generic praise is not an individual reason to choose.
    if (promotional && !concrete) return { quote, index, score: 0 };
    return { quote, index, score: format * 10 + Number(language) * 4 + Number(concrete) * 3 - Number(promotional) * 2 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(item => item.quote);
}

export function buildExplanation(query: Query, candidate: RankedVendor, quote: string | null, source: Explanation['source']): Explanation {
  const vendor = candidate.vendor;
  const amount = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(vendor.price_from_kzt);
  const budget = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(query.budget_kzt);
  const date = query.date.split('-').reverse().join('.');
  const facts = [`формат «${query.event_format}»`, `цена от ${amount} ₸ при бюджете ${budget} ₸`];
  if (query.language) facts.push(`язык — ${query.language}`);
  if (query.hours !== null) facts.push(vendor.max_hours === null
    ? 'часы присутствия не ограничивают подбор'
    : `${query.hours} ч при максимуме ${vendor.max_hours} ч`);
  facts.push(`на ${date} занятость не отмечена`);
  const conditions = `По каталогу подходит под условия: ${facts.join('; ')}.`;
  // Lead with a sourced individual feature; keep operational facts together.
  // The stored quote stays verbatim, including its original punctuation.
  const evidence = quote ? `В описании: «${quote}»${/[.!?…]$/u.test(quote) ? '' : '.'}` : null;
  const text = evidence ? `${evidence} ${conditions}` :
    `${conditions} Конкретная особенность в описании не выделена; основание подбора — перечисленные условия.`;
  return { id: vendor.id, text, quote, source };
}

export function fallbackExplanation(query: Query, candidate: RankedVendor): Explanation {
  return buildExplanation(query, candidate, usefulEvidenceOptions(query, candidate.vendor.description)[0] ?? null, 'fallback');
}
