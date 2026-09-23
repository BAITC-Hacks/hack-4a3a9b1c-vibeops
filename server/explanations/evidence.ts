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

function extractQuote(query: Query, description: string): string | null {
  const options = evidenceOptions(description);
  const scored = options.map((quote, index) => {
    const t = quote.toLowerCase().replace(/ё/gu, 'е');
    const format = (markers[query.event_format] ?? []).filter(r => r.test(t)).length;
    const concrete = /двуязыч|телевид|телеканал|радиостанц|акт[её]р|танц|развлеч|флорист|декор|букет|банкет|вместим|оборудован|фотограф|съем|монтаж|репертуар|инструмент|мастер-класс|импровизац|юмор|сценари|интерактив|панорам|террас|вид на|ресторан|кейтеринг|парковк|цветоч|\d/iu.test(t);
    const language = query.language !== null && t.includes(query.language.toLowerCase());
    const promotional = /лучши|идеальн|безупреч|востребован|профессиональн|ответственн/iu.test(t);
    return { quote, index, score: format * 10 + Number(language) * 4 + Number(concrete) * 3 - Number(promotional) * 2 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0]?.quote ?? null;
}

export function buildExplanation(query: Query, candidate: RankedVendor, quote: string | null, source: Explanation['source']): Explanation {
  const vendor = candidate.vendor;
  const amount = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(vendor.price_from_kzt);
  const budget = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(query.budget_kzt);
  const facts = [`формат «${query.event_format}» указан в каталоге`, `на ${query.date} занятость не отмечена`, `стартовая цена от ${amount} ₸ не превышает бюджет ${budget} ₸`];
  if (query.language) facts.push(`язык по каталогу — ${query.language}`);
  if (query.hours !== null) facts.push(vendor.max_hours === null
    ? 'ограничение часов присутствия не применимо'
    : `запрошено ${query.hours} ч при максимуме ${vendor.max_hours} ч`);
  const first = facts.join('; ');
  const text = first[0]!.toUpperCase() + first.slice(1) + '.' + (quote ? ` В описании указано: «${quote}»` + (/[.!?…]$/u.test(quote) ? '' : '.') : '');
  return { id: vendor.id, text, quote, source };
}

export function fallbackExplanation(query: Query, candidate: RankedVendor): Explanation {
  return buildExplanation(query, candidate, extractQuote(query, candidate.vendor.description), 'fallback');
}
