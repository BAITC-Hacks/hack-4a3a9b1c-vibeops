import type { Query } from '../../shared/contracts';

// Only request parameters. Results always come from POST /api/recommend.
const base: Query = {
  city: 'Алматы', date: '2026-10-10', event_format: 'корпоратив',
  category: 'Ведущий', budget_kzt: 1_000_000, hours: null, language: null,
};

export const DEMOS: { id: string; label: string; description: string; query: Query }[] = [
  { id: 'D1', label: 'Ведущий · 10 октября', description: 'Плотная категория', query: { ...base } },
  { id: 'D2', label: 'Ведущий · 11 октября', description: 'Изменение занятости', query: { ...base, date: '2026-10-11' } },
  { id: 'D3', label: 'Флорист на свадьбу', description: 'Редкая категория', query: { ...base, category: 'Флорист', event_format: 'свадьба', budget_kzt: 500_000 } },
  { id: 'D4', label: 'Декоратор в Астане', description: 'Категории нет в городе', query: { ...base, city: 'Астана', category: 'Декоратор', event_format: 'свадьба', budget_kzt: 500_000 } },
  { id: 'D5', label: 'Бюджет 1 ₸', description: 'Нет подходящих по условиям', query: { ...base, budget_kzt: 1 } },
  { id: 'D6', label: 'Банкетный зал', description: 'Календарь площадки', query: { ...base, category: 'Банкетный зал', event_format: 'свадьба', budget_kzt: 5_000_000, date: '2026-11-14' } },
];
