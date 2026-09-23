import type { Card, Query, Selection } from '../../shared/contracts.js';
import type { ComparisonItem, DecisionAlternative } from '../../shared/decision-support.js';
import { DATE_MIN, DATE_MAX } from '../catalog.js';

const money = (n: number) => new Intl.NumberFormat('ru-RU').format(n);
const day = (date: string) => date.split('-').reverse().join('.');
const dayNumber = (date: string) => {
  const value = Date.parse(`${date}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(value) &&
    new Date(value).toISOString().slice(0, 10) === date ? value / 86_400_000 : NaN;
};

/** Format two real selectVendors results. Null means this is not an admissible improvement.
 * Does not search, call LLM, mutate inputs or select a globally optimal proposal.
 */
export function describeAlternative(original: Selection, proposed: Selection): DecisionAlternative | null {
  const changed = (Object.keys(original.query) as (keyof Query)[])
    .filter(key => original.query[key] !== proposed.query[key]);
  if (changed.length !== 1 || !original.base_count || original.eligible_count >= 3 ||
      proposed.eligible_count <= original.eligible_count ||
      proposed.eligible_count !== proposed.ranked.length) return null;
  const field = changed[0];
  const kind = field === 'date' ? 'date' : field === 'budget_kzt' ? 'budget' : null;
  if (!kind) return null;
  const delta = proposed.query.budget_kzt - original.query.budget_kzt;
  if (kind === 'budget' && (!Number.isSafeInteger(proposed.query.budget_kzt) || delta <= 0)) return null;
  const days = Math.abs(dayNumber(proposed.query.date) - dayNumber(original.query.date));
  if (kind === 'date' && (!Number.isFinite(days) || days < 1 || days > 7 ||
      proposed.query.date < DATE_MIN || proposed.query.date > DATE_MAX)) return null;
  const originalIds = new Set(original.ranked.map(row => row.vendor.id));
  const newIds = [...new Set(proposed.ranked.map(row => row.vendor.id).filter(id => !originalIds.has(id)))].sort();
  if (!newIds.length) return null;
  const title = kind === 'date' ? `Дата ${day(proposed.query.date)}` : `Бюджет ${money(proposed.query.budget_kzt)} ₸`;
  const change = kind === 'date'
    ? `Если выбрать ${day(proposed.query.date)} при прежнем бюджете`
    : `Если увеличить бюджет на ${money(delta)} ₸, до ${money(proposed.query.budget_kzt)} ₸, при прежней дате`;
  const limit = kind === 'date'
    ? 'Остальные условия сохранены; занятость проверена по каталогу, бронирование не подтверждено.'
    : 'Остальные условия сохранены; сравниваются цены «от», окончательную стоимость нужно уточнить.';
  return {
    kind, query: { ...proposed.query }, eligible_count: proposed.eligible_count,
    new_vendor_ids: newIds, title, source: 'catalog',
    explanation: `${change}, число подходящих профилей вырастет с ${original.eligible_count} до ${proposed.eligible_count}; новых относительно исходного запроса — ${newIds.length}. ${limit}`,
  };
}

/** Compare only current cards, reusing their already verified evidence and attribution. */
export function buildComparison(cards: Card[]): ComparisonItem[] {
  if (cards.length < 2) return [];
  return cards.slice(0, 3).map(card => {
    if (card.evidence_quote?.trim()) return {
      vendor_id: card.id, feature: `В описании: «${card.evidence_quote}»`,
      evidence_quote: card.evidence_quote, source: card.explanation_source,
    };
    return {
      vendor_id: card.id,
      feature: `Цена от ${money(card.price_from_kzt)} ₸; языки: ${card.languages.join(', ')}; ${card.max_hours === null ? 'часы присутствия не применимы' : `до ${card.max_hours} ч на площадке`}. Индивидуальная особенность в описании не выделена.`,
      evidence_quote: null, source: 'catalog',
    };
  });
}
