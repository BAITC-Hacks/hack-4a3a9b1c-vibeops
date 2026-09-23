// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DecisionSupport from '../../client/src/DecisionSupport';
import { recommend } from '../../client/src/api';
import type { DecisionSupport as Support } from '../../shared/decision-support';
import { card, query, response } from './fixtures';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const support = (): Support => ({
  version: 'v1', status: 'available', message: null, comparison: [],
  alternatives: [{ kind: 'budget', query: { ...query, budget_kzt: 1200000, hours: 4, language: 'русский' },
    eligible_count: 2, new_vendor_ids: ['new'], title: 'Бюджет 1 200 000 ₸', explanation: 'Увеличить только бюджет; цена от, стоимость нужно уточнить.', source: 'catalog' }],
});

describe('Decision support UI', () => {
  it('offers a budget change only on click and sends all conditions unchanged', () => {
    const apply = vi.fn(); const value = support();
    render(<DecisionSupport support={value} cards={[card()]} onApply={apply} />);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Применить бюджет' }));
    expect(apply).toHaveBeenCalledExactlyOnceWith(value.alternatives[0].query);
  });
  it.each(['not_needed', 'no_category', 'no_single_change'] as const)('never fabricates alternatives for %s', status => {
    render(<DecisionSupport support={{ ...support(), status, alternatives: [], message: 'Изменение одного условия не поможет.' }} cards={[]} onApply={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    if (status === 'no_single_change') expect(screen.getByText('Изменение одного условия не поможет.')).toBeTruthy();
  });
  it('renders current-card comparison using the names of the current results', () => {
    const cards = [card('one'), card('two')];
    render(<DecisionSupport support={{ ...support(), status: 'not_needed', alternatives: [], comparison: cards.map(item => ({ vendor_id: item.id, feature: `Особенность ${item.id}`, evidence_quote: item.evidence_quote, source: 'llm' })) }} cards={cards} onApply={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Чем отличаются кандидаты' })).toBeTruthy();
    expect(screen.getByText(cards[1].name)).toBeTruthy();
    expect(screen.getByText('Особенность two')).toBeTruthy();
  });
  it.each(['multiple-fields', 'foreign-comparison', 'malformed'] as const)('drops an invalid optional extension (%s) while keeping useful cards', async failure => {
    const value: unknown = failure === 'malformed' ? { version: 'v1', alternatives: null } : support();
    if (failure === 'foreign-comparison') {
      const typed = value as Support; typed.alternatives[0].query = { ...query, budget_kzt: 1200000 };
      typed.comparison = [{ vendor_id: 'foreign', feature: 'Wrong profile', evidence_quote: null, source: 'catalog' }];
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response({ decision_support: value as Support })), { status: 200 })));
    const result = await recommend(query, new AbortController().signal);
    expect(result.cards).toHaveLength(1);
    expect(result.decision_support).toBeUndefined();
  });
});
