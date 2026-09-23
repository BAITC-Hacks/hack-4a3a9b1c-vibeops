// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../client/src/App';
import { comparePreferences, prepareBrief } from '../../client/src/api';
import type { AssistantBrief, AssistantComparison } from '../../shared/assistant';
import { card, options, query, response } from './fixtures';

// These fixtures verify UI behavior only; live model quality is checked separately.
const preferences = ['интерактивы', 'живая музыка'];
const complete = (overrides: Partial<AssistantBrief> = {}): AssistantBrief => ({
  draft: { ...query }, query: { ...query }, summary: 'Ведущий для корпоратива в Алматы',
  questions: [], preferences, warnings: [], source: 'llm', model: 'test-model', ...overrides,
});
const incomplete = (): AssistantBrief => complete({
  draft: { city: null, category: 'Ведущий', event_format: null, date: null, budget_kzt: null, language: null, hours: null },
  query: null, summary: 'Ищем ведущего с интерактивами',
  questions: ['В каком городе, на какую дату и с каким бюджетом планируется мероприятие?'],
});
const comparison = (): AssistantComparison => ({
  items: [{ id: card().id, name: card().name, evidence: [{ preference: 'интерактивы', quote: 'интерактивной программой' }], to_confirm: ['живая музыка'] }],
  source: 'llm', model: 'test-model',
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
let api: ReturnType<typeof vi.fn>;
beforeEach(() => {
  api = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/options') return json(options);
    if (url === '/api/assistant/brief') return json(complete());
    if (url === '/api/assistant/compare') return json(comparison());
    return json(response({ query: JSON.parse(String(init?.body)) }));
  });
  vi.stubGlobal('fetch', api);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const calls = (url: string) => api.mock.calls.filter(call => call[0] === url);
const input = () => screen.getByRole('textbox', { name: /Какое событие планируете|Уточните или измените условия/ });
const send = (message: string) => {
  fireEvent.change(input(), { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: /Собрать условия с AI|Отправить уточнение/ }));
};
const confirm = () => fireEvent.click(screen.getByRole('button', { name: /Подобрать по этим условиям/ }));
async function ready() {
  render(<App />);
  await waitFor(() => expect((screen.getByRole('button', { name: /Подобрать подрядчиков/ }) as HTMLButtonElement).disabled).toBe(false));
}
async function prepared() {
  await ready(); send('Ведущий на корпоратив в Алматы 10 октября 2026, бюджет миллион. Хочу интерактивы и живую музыку.');
  await screen.findByText('Можно подбирать');
}

describe('AI assistant: user-reviewed brief and preference comparison', () => {
  it('asks for missing conditions, sends only user messages, and searches only after explicit confirmation', async () => {
    let briefCalls = 0;
    const original = api.getMockImplementation()!;
    api.mockImplementation((url: string, init?: RequestInit) => url === '/api/assistant/brief' ? json(++briefCalls === 1 ? incomplete() : complete()) : original(url, init));
    await ready();
    send('Нужен ведущий с интерактивами и живой музыкой.');
    await screen.findByText(incomplete().questions[0]);
    expect(screen.getAllByText('Нужно уточнить')).toHaveLength(4);
    expect((screen.getByRole('button', { name: /Подобрать по этим условиям/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(calls('/api/assistant/brief')[0][1].body)).toEqual({ messages: ['Нужен ведущий с интерактивами и живой музыкой.'] });
    expect(calls('/api/recommend')).toHaveLength(0);

    send('Корпоратив в Алматы 10 октября 2026, до миллиона тенге.');
    await screen.findByText('Можно подбирать');
    expect(JSON.parse(calls('/api/assistant/brief')[1][1].body)).toEqual({ messages: ['Нужен ведущий с интерактивами и живой музыкой.', 'Корпоратив в Алматы 10 октября 2026, до миллиона тенге.'] });
    expect(calls('/api/recommend')).toHaveLength(0);
    confirm();
    await screen.findByRole('heading', { name: 'Ваша подборка' });
    expect(JSON.parse(calls('/api/recommend')[0][1].body)).toEqual(query);
    expect(JSON.parse(calls('/api/assistant/compare')[0][1].body)).toEqual({ query, preferences });
    expect((screen.getByLabelText('Бюджет, ₸') as HTMLInputElement).value).toBe('1000000');
    const vendor = screen.getByRole('article');
    await within(vendor).findByRole('heading', { name: 'Под ваши пожелания' });
    expect(within(vendor).getByText('«интерактивной программой»')).toBeTruthy();
    expect(within(vendor).getByRole('heading', { name: 'Нужно уточнить у подрядчика' })).toBeTruthy();
    expect(within(vendor).getByText('живая музыка')).toBeTruthy();
    expect(screen.getByText(/Это сведения из профилей, а не гарантия/)).toBeTruthy();
  });

  it('keeps a failed brief available to retry without duplicating the user message', async () => {
    await ready();
    api.mockResolvedValueOnce(await json({ error: { code: 'AI_UNAVAILABLE', message: 'AI временно недоступен.' } }, 503));
    send('Ведущий для корпоратива в Алматы.');
    expect((await screen.findByRole('alert')).textContent).toContain('AI временно недоступен.');
    expect((input() as HTMLTextAreaElement).value).toBe('Ведущий для корпоратива в Алматы.');
    expect(calls('/api/recommend')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Собрать условия с AI/ }));
    await screen.findByText('Можно подбирать');
    expect(JSON.parse(calls('/api/assistant/brief')[1][1].body)).toEqual({ messages: ['Ведущий для корпоратива в Алматы.'] });
  });

  it('shows the regular search result if comparison fails and can retry comparison alone', async () => {
    await prepared();
    const original = api.getMockImplementation()!;
    let compareCalls = 0;
    api.mockImplementation((url: string, init?: RequestInit) => url === '/api/assistant/compare' && ++compareCalls === 1 ? json({ error: { code: 'AI_UNAVAILABLE', message: 'Сервис сравнения недоступен.' } }, 503) : original(url, init));
    confirm();
    await screen.findByRole('heading', { name: 'Ваша подборка' });
    expect((await screen.findByRole('alert')).textContent).toContain('Сервис сравнения недоступен.');
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Повторить AI-сравнение' }));
    await screen.findByRole('heading', { name: 'Под ваши пожелания' });
    expect(calls('/api/recommend')).toHaveLength(1);
    expect(calls('/api/assistant/compare')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a comparison resolving after a manual edit and preserves wishes when resubmitting the edited conditions', async () => {
    await prepared();
    let resolveOld!: (value: Response) => void;
    const original = api.getMockImplementation()!;
    let compareCalls = 0;
    api.mockImplementation((url: string, init?: RequestInit) => url === '/api/assistant/compare' && ++compareCalls === 1 ? new Promise<Response>(resolve => { resolveOld = resolve; }) : original(url, init));
    confirm(); await screen.findByRole('heading', { name: 'Ваша подборка' });
    await waitFor(() => expect(calls('/api/assistant/compare')).toHaveLength(1));
    const signal = calls('/api/assistant/compare')[0][1].signal as AbortSignal;
    fireEvent.change(screen.getByLabelText('Бюджет, ₸'), { target: { value: '800000' } });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(await json(comparison())));
    expect(screen.queryByRole('heading', { name: 'Под ваши пожелания' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ваша подборка' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Подобрать подрядчиков/ }));
    await screen.findByRole('heading', { name: 'Под ваши пожелания' });
    expect(JSON.parse(calls('/api/assistant/compare')[1][1].body)).toEqual({ query: { ...query, budget_kzt: 800000 }, preferences });
  });

  it('ignores a brief resolving after the user has replaced the pending message', async () => {
    await ready();
    let resolveOld!: (value: Response) => void;
    api.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }));
    send('Ищу ведущего в Алматы.');
    const signal = calls('/api/assistant/brief')[0][1].signal as AbortSignal;
    fireEvent.change(input(), { target: { value: 'Лучше в Астане.' } });
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(await json(complete())));
    expect(screen.queryByText('Можно подбирать')).toBeNull();
    expect((input() as HTMLTextAreaElement).value).toBe('Лучше в Астане.');
    expect(calls('/api/recommend')).toHaveLength(0);
  });

  it('preserves the confirmed result and comparison while editing, clearing or resetting the dialogue', async () => {
    await prepared(); confirm(); await screen.findByRole('heading', { name: 'Под ваши пожелания' });
    fireEvent.change(input(), { target: { value: 'Изменим дату.' } });
    expect(screen.getByRole('heading', { name: 'Под ваши пожелания' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ваша подборка' })).toBeTruthy();
    expect(screen.getByText(/Показан результат последнего подтверждённого поиска/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Подобрать по этим условиям/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input(), { target: { value: '' } });
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    expect(calls('/api/recommend')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Новый запрос' }));
    expect(screen.queryByText('Можно подбирать')).toBeNull();
    expect((input() as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    send('Новое событие.'); await screen.findByText('Можно подбирать');
    expect(JSON.parse(calls('/api/assistant/brief')[1][1].body)).toEqual({ messages: ['Новое событие.'] });
  });

  it('shows an AI category absent from catalog options as the actual selected form value', async () => {
    await ready();
    const unusualQuery = { ...query, category: 'Фокусник' };
    api.mockResolvedValueOnce(await json(complete({ draft: unusualQuery, query: unusualQuery, preferences: [] })));
    send('Нужен фокусник на корпоратив.'); await screen.findByText('Можно подбирать'); confirm();
    await screen.findByRole('heading', { name: 'Ваша подборка' });
    expect((screen.getByLabelText('Что нужно для мероприятия?') as HTMLSelectElement).value).toBe('Фокусник');
    expect(screen.getByRole('option', { name: /Фокусник/ })).toBeTruthy();
    expect(JSON.parse(calls('/api/recommend')[0][1].body).category).toBe('Фокусник');
  });

  it('keeps the manual result during a pending or failed brief and focuses the manual form without a new search', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Подобрать подрядчиков/ }));
    await screen.findByRole('heading', { name: card().name });
    let resolveBrief!: (value: Response) => void;
    const original = api.getMockImplementation()!;
    api.mockImplementation((url: string, init?: RequestInit) => url === '/api/assistant/brief'
      ? new Promise<Response>(resolve => { resolveBrief = resolve; }) : original(url, init));
    send('Уточню пожелания.');
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    expect(screen.getByText(/Показан результат последнего подтверждённого поиска/)).toBeTruthy();
    await act(async () => resolveBrief(await json({ error: { code: 'AI_UNAVAILABLE', message: 'AI недоступен.' } }, 503)));
    fireEvent.click(await screen.findByRole('button', { name: 'Перейти к ручному подбору' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Ваше мероприятие' }));
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    expect(calls('/api/recommend')).toHaveLength(1);
  });

  it('applies corrected conditions only after confirmation and ignores the previous comparison arriving late', async () => {
    await prepared();
    let resolveOld!: (value: Response) => void;
    let compareCalls = 0;
    const original = api.getMockImplementation()!;
    const corrected = { ...query, date: '2026-10-11', budget_kzt: 700000 };
    api.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/assistant/brief') return json(complete({ draft: corrected, query: corrected, summary: 'Обновлённые условия' }));
      if (url === '/api/assistant/compare' && ++compareCalls === 1) return new Promise<Response>(resolve => { resolveOld = resolve; });
      return original(url, init);
    });
    confirm(); await screen.findByRole('heading', { name: card().name });
    await waitFor(() => expect(calls('/api/assistant/compare')).toHaveLength(1));
    const oldSignal = calls('/api/assistant/compare')[0][1].signal as AbortSignal;
    send('Дата 11 октября 2026, бюджет 700 тысяч.');
    await screen.findByText('Обновлённые условия');
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    expect((screen.getByLabelText('Бюджет, ₸') as HTMLInputElement).value).toBe('1000000');
    expect(calls('/api/recommend')).toHaveLength(1);
    confirm();
    await waitFor(() => expect(calls('/api/recommend')).toHaveLength(2));
    expect(JSON.parse(calls('/api/recommend')[1][1].body)).toEqual(corrected);
    expect(oldSignal.aborted).toBe(true);
    await screen.findByRole('heading', { name: 'Под ваши пожелания' });
    const stale = comparison(); stale.items[0].evidence[0].quote = 'УСТАРЕВШИЙ ОТВЕТ';
    await act(async () => resolveOld(await json(stale)));
    expect(screen.queryByText(/УСТАРЕВШИЙ ОТВЕТ/)).toBeNull();
    expect(screen.queryByText(/Показан результат последнего подтверждённого поиска/)).toBeNull();
    expect((screen.getByLabelText('Бюджет, ₸') as HTMLInputElement).value).toBe('700000');
  });

  it('keeps an in-flight confirmed search valid when only the assistant draft changes', async () => {
    await ready();
    let resolveSearch!: (value: Response) => void;
    api.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSearch = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: /Подобрать подрядчиков/ }));
    fireEvent.change(input(), { target: { value: 'Неподтверждённое пожелание' } });
    await act(async () => resolveSearch(await json(response())));
    expect(screen.getByRole('heading', { name: card().name })).toBeTruthy();
    expect(screen.getByText(/Показан результат последнего подтверждённого поиска/)).toBeTruthy();
    expect(calls('/api/recommend')).toHaveLength(1);
    expect(calls('/api/assistant/brief')).toHaveLength(0);
  });

  it('displays an impossible date as a draft needing clarification without crashing or searching', async () => {
    await ready();
    api.mockResolvedValueOnce(await json(complete({
      draft: { ...query, date: '2026-10-32' }, query: null,
      questions: ['В октябре нет 32-го числа. Какую дату вы имели в виду?'],
    })));
    send('Ведущий 32 октября.');
    await screen.findByText('В октябре нет 32-го числа. Какую дату вы имели в виду?');
    expect(screen.getByText('2026-10-32')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Подобрать по этим условиям/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls('/api/recommend')).toHaveLength(0);
  });

  it('rejects malformed brief and comparison payloads instead of displaying misleading conditions or evidence', async () => {
    api.mockResolvedValueOnce(await json(complete({ query: { ...query, budget_kzt: 1 } })));
    await expect(prepareBrief(['test'], new AbortController().signal)).rejects.toThrow('Не удалось прочитать ответ AI');
    const invalid = comparison(); invalid.items[0].evidence[0].preference = 'Несуществующее пожелание';
    api.mockResolvedValueOnce(await json(invalid));
    await expect(comparePreferences(query, preferences, new AbortController().signal)).rejects.toThrow('Не удалось прочитать AI-сравнение');
    const duplicated = comparison(); duplicated.items.push({ ...duplicated.items[0] });
    api.mockResolvedValueOnce(await json(duplicated));
    await expect(comparePreferences(query, preferences, new AbortController().signal)).rejects.toThrow('Не удалось прочитать AI-сравнение');
  });
});
