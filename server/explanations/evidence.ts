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
    const concrete = /двуязыч|телевид|телеканал|радиостанц|акт[её]р|танц|развлеч|флорист|декор|букет|банкет|вместим|оборудован|фотограф|съем|монтаж|репертуар|инструмент|мастер-класс|импровизац|юмор|сценари|интерактив|панорам|террас|вид на|ресторан|кейтеринг|парковк|цветоч|скрипк|саксофон|вокал|(?:^|[^\p{L}])печат|фотопечат|светов|пиксель|фотозон|сувенир|мерч|кухн|открытк|рассадк|welcome[- ]?(?:бокс|box)|сладост|леденц|логотип|персонализ|именные|подароч|струнн|квартет|перкусси|клавиш|барабан|гитар|тромбон|видеограф|videograph|colorist|видеосъем|фотожурнал|документальн|церемони|регистрац|бракосочет|казахскую песню|казахских песен|выступивш|\d+\s*(?:лет|год|года|гостей|человек|мест)/iu.test(t);
    const language = query.language !== null && t.includes(query.language.toLowerCase());
    const promotional = /сверка|атмосфер|энерги|незабываем|украсит|красот|эмоци|впечатлен|уникальн|лучш|идеальн|безупреч|востребован|профессиональн|ответственн|отличный выбор|незабываем|вау-эффект/iu.test(t);
    // A format name inside generic praise is not an individual reason to choose.
    if (promotional && !concrete) return { quote, index, score: 0 };
    // The vocabulary ranks useful clues; it must not be the only route into the model.
    // Preserve otherwise substantive sentences/clauses, but not greetings, slogans or list headings.
    const introduction = /^(?:всем привет|привет|меня зовут|мы —|мы -)/iu.test(t);
    const heading = /^(?:расширенный|большой|основной)?\s*(?:музыкальный\s+)?состав(?:\s|:|$)/iu.test(t) && !concrete;
    const words = t.match(/[\p{L}\p{N}]+/gu) ?? [];
    const descriptive = !promotional && !introduction && !heading && words.length >= 6;
    if (heading) return { quote, index, score: 0 };
    return { quote, index, score: format * 10 + Number(language) * 4 + Number(concrete) * 3 + Number(descriptive) - Number(promotional) * 2 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  // Unknown but descriptive facts remain usable when the profile has no recognized specifics.
  // When specifics exist, do not offer vague filler alongside them to the model.
  const specific = scored.filter(item => item.score >= 3);
  const ranked = specific.length ? specific : scored;
  const readable = ranked.filter(({ quote }) => !(
    [...quote].length > 160 && (quote.match(/,/gu)?.length ?? 0) >= 5 &&
    (quote.match(/[a-z]{3,}/giu)?.length ?? 0) >= 6
  ));
  // Keep a long client list only if it is the profile's sole available evidence.
  return (readable.length ? readable : ranked).map(item => item.quote);
}

export function buildExplanation(query: Query, candidate: RankedVendor, quote: string | null, source: Explanation['source'], sharedEvidence = false): Explanation {
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
  const conditions = `По каталогу подходит под условия: ${facts.join('; ')}${sharedEvidence ? '; отдельное отличие от других карточек в описании не найдено' : ''}.`;
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


/** Compare substance, not casing, punctuation or the anonymized person's name. */
export function evidenceKey(text: string, candidates: RankedVendor[]): string {
  const clean = (value: string) => normalize(value).toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let key = ` ${clean(text)} `;
  for (const candidate of candidates) {
    const name = clean(candidate.vendor.anon_name);
    if (name) key = key.split(` ${name} `).join(' ');
  }
  return key.trim().replace(/\s+/gu, ' ');
}

/** Prefer evidence absent from peer descriptions; all excerpts still come from the owning profile. */
export function contextualEvidenceOptions(query: Query, candidates: RankedVendor[]): Map<string, { options: string[]; distinctive: boolean }> {
  const descriptions = candidates.map(c => evidenceKey(c.vendor.description, candidates));
  return new Map(candidates.map((candidate, index) => {
    const all = usefulEvidenceOptions(query, candidate.vendor.description);
    const unique = all.filter(quote => {
      const key = evidenceKey(quote, candidates);
      return key && descriptions.every((description, peer) => peer === index || !(` ${description} `).includes(` ${key} `));
    });
    return [candidate.vendor.id, { options: unique.length ? unique : all, distinctive: unique.length > 0 }];
  }));
}

/** Select the set jointly. Maximum matching avoids a greedy choice stealing the only quote of a peer.
 * If the catalog cannot distinguish profiles, preserve the shared fact and disclose the limitation.
 */
export function buildExplanationSet(query: Query, candidates: RankedVendor[], preferred = new Map<string, string>()): { items: Explanation[]; sharedEvidence: boolean } {
  const context = contextualEvidenceOptions(query, candidates);
  const options = candidates.map(c => {
    const allowed = context.get(c.vendor.id)!.options;
    const first = preferred.get(c.vendor.id);
    return first && allowed.includes(first) ? [first, ...allowed.filter(q => q !== first)] : allowed;
  });
  const owners = new Map<string, number>();
  const chosen = new Map<number, string>();
  const assign = (index: number, seen: Set<string>): boolean => {
    for (const quote of options[index]!) {
      const key = evidenceKey(quote, candidates);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const previous = owners.get(key);
      if (previous === undefined || assign(previous, seen)) {
        owners.set(key, index); chosen.set(index, quote); return true;
      }
    }
    return false;
  };
  candidates.forEach((_, index) => assign(index, new Set()));
  let sharedEvidence = false;
  const items = candidates.map((candidate, index) => {
    const choice = context.get(candidate.vendor.id)!;
    const quote = chosen.get(index) ?? options[index]![0] ?? null;
    const shared = candidates.length > 1 && !choice.distinctive;
    sharedEvidence ||= shared;
    const source = quote && quote === preferred.get(candidate.vendor.id) ? 'llm' : 'fallback';
    return buildExplanation(query, candidate, quote, source, shared);
  });
  return { items, sharedEvidence };
}
