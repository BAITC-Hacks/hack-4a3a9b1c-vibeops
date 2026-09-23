// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../client/src/App';
import { DEMOS } from '../../client/src/demo';
import { getOptions, recommend } from '../../client/src/api';
import { card, options, query, response } from './fixtures';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}}));
let api: ReturnType<typeof vi.fn>;
beforeEach(() => { api = vi.fn((url: string) => json(url === '/api/options' ? options : response())); vi.stubGlobal('fetch', api); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function ready() { render(<App />); await waitFor(() => expect((screen.getByRole('button', {name:/Подобрать подрядчиков/}) as HTMLButtonElement).disabled).toBe(false)); }
const submit = () => fireEvent.click(screen.getByRole('button', {name:/Подобрать подрядчиков/}));

describe('Firebird UI contract', () => {
  it('sends all required fields and null optional values; displays fewer than three and busy reasons', async () => {
    await ready(); submit();
    await screen.findByRole('heading', {name:'Ваша подборка'});
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual(query);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText(/Найден один подходящий/)).toBeTruthy();
    expect(screen.getByText(/Занятый профиль\./)).toBeTruthy();
    expect(screen.getByText('Стартовая цена не превышает указанный бюджет.', {exact:false})).toBeTruthy();
  });

  it.each(DEMOS)('$id submits its exact demo query, never precomputed cards', async demo => {
    await ready(); fireEvent.click(screen.getByRole('button', {name:new RegExp(`^${demo.id} `)}));
    await screen.findByRole('heading', {name:'Ваша подборка'});
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual(demo.query);
  });

  it.each([
    ['no_category_in_city', 'В этом городе такой категории нет'],
    ['no_matches', 'Никто не проходит по условиям'],
  ] as const)('distinguishes %s from network failures', async (outcome, heading) => {
    const result = response(); result.outcome = outcome; result.cards = []; result.summary.returned_count = 0;
    result.summary.eligible_count = 0; result.explanation.mode = 'not_needed';
    if (outcome === 'no_category_in_city') { result.summary.base_count = 0; result.summary.rejected_count = 0; result.summary.rejected = []; }
    api.mockImplementation((url: string) => json(url === '/api/options' ? options : result));
    await ready(); submit(); await screen.findByRole('heading', {name:heading});
    expect(screen.queryAllByRole('article')).toHaveLength(0); expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['fallback', 'mixed'] as const)('visibly discloses %s and data provenance', async mode => {
    const result = response(); result.explanation.mode = mode; result.explanation.warning = 'Тестовое предупреждение';
    Object.assign(result.cards[0], {synthetic:true,city_imputed:true,price_imputed:true,max_hours:null,explanation_source:'fallback'});
    api.mockImplementation((url: string) => json(url === '/api/options' ? options : result));
    await ready(); submit(); await screen.findByRole('heading', {name:'Ваша подборка'});
    expect(screen.getByText(/объяснений подготовлена без AI|Объяснения подготовлены без AI/)).toBeTruthy();
    for (const text of ['Синтетический профиль','Цена проставлена в датасете','Город проставлен в датасете','Присутствие по часам не применимо']) expect(screen.getByText(text)).toBeTruthy();
  });

  it('preserves API order and escapes explanation HTML', async () => {
    const cards = [card('z'),card('a'),card('m')]; cards[0].explanation = '<img src=x onerror=alert(1)>';
    const result = response({cards}); result.summary.returned_count = 3; result.summary.eligible_count = 3;
    api.mockImplementation((url: string) => json(url === '/api/options' ? options : result));
    await ready(); submit(); await screen.findByRole('heading', {name:'Ваша подборка'});
    expect(screen.getAllByRole('article').map(item => item.querySelector('h3')?.textContent)).toEqual(cards.map(item => item.name));
    expect(screen.getByText(cards[0].explanation)).toBeTruthy(); expect(document.querySelector('img')).toBeNull();
  });

  it('keeps categories global when city changes and sends selected optional fields', async () => {
    await ready(); fireEvent.change(screen.getByLabelText('Город'), {target:{value:'Астана'}});
    expect(screen.getByRole('option', {name:'Декоратор'})).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Язык'), {target:{value:'казахский'}});
    fireEvent.change(screen.getByLabelText('Длительность, ч'), {target:{value:'2.5'}});
    fireEvent.change(screen.getByLabelText('Бюджет, ₸'), {target:{value:'0'}});
    submit(); await screen.findByRole('heading', {name:'Ваша подборка'});
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({...query,city:'Астана',language:'казахский',hours:2.5,budget_kzt:0});
  });

  it.each([['Бюджет, ₸','-1'], ['Бюджет, ₸','1.5'], ['Дата','2027-01-01'], ['Длительность, ч','0']])('validates %s=%s without requesting recommendations', async (label, value) => {
    await ready(); fireEvent.change(screen.getByLabelText(label), {target:{value}}); submit();
    expect(await screen.findByRole('alert')).toBeTruthy(); expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
  });

  it('handles server validation errors separately and ties fields to messages', async () => {
    api.mockImplementation((url: string) => url === '/api/options' ? json(options) : json({error:{code:'VALIDATION_ERROR',message:'Проверьте дату на сервере',fields:{date:'Дата вне диапазона'}}},422));
    await ready(); submit(); await screen.findByRole('alert');
    expect(screen.getByText('Дата вне диапазона')).toBeTruthy(); expect(screen.getByLabelText('Дата').getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByRole('heading', {name:'Никто не проходит по условиям'})).toBeNull();
  });

  it('shows network failure and allows another request', async () => {
    await ready(); api.mockRejectedValueOnce(new TypeError('offline')); submit();
    expect((await screen.findByRole('alert')).textContent).toContain('Не удалось связаться с сервером');
    submit(); await screen.findByRole('heading', {name:'Ваша подборка'});
  });

  it('retries failed options without inventing a local catalog', async () => {
    api.mockRejectedValueOnce(new TypeError('offline')); render(<App />);
    fireEvent.click(await screen.findByRole('button', {name:'Загрузить каталог снова'}));
    await waitFor(() => expect((screen.getByLabelText('Город') as HTMLSelectElement).value).toBe('Алматы'));
    expect(api).toHaveBeenCalledTimes(2);
  });

  it('disables duplicate submit and ignores old results even if aborted fetch resolves later', async () => {
    await ready(); let resolveOld!: (value: Response) => void;
    api.mockImplementationOnce(() => new Promise<Response>(resolve => {resolveOld = resolve;}));
    submit(); expect((screen.getByRole('button', {name:/Подбираем…/}) as HTMLButtonElement).disabled).toBe(true);
    const signal = api.mock.calls[1][1].signal as AbortSignal;
    const latest = response(); latest.cards[0].name = 'Новый результат';
    api.mockImplementationOnce(() => json(latest));
    fireEvent.click(screen.getByRole('button', {name:/^D2 /}));
    await screen.findByRole('heading', {name:'Новый результат'}); expect(signal.aborted).toBe(true);
    await act(async () => {resolveOld(await json(response()));});
    expect(screen.getByRole('heading', {name:'Новый результат'})).toBeTruthy();
    expect(screen.queryByRole('heading', {name:'Тестовый подрядчик fixture-1'})).toBeNull();
  });

  it('clears a result when editing the form so it cannot look current', async () => {
    await ready(); submit(); await screen.findByRole('heading', {name:'Ваша подборка'});
    fireEvent.change(screen.getByLabelText('Дата'), {target:{value:'2026-10-11'}});
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });

  it('terminates a hung request with an explicit timeout, not an empty match', async () => {
    await ready(); vi.useFakeTimers();
    api.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')))));
    submit(); await act(async () => {await vi.advanceTimersByTimeAsync(15000);});
    expect(screen.getByRole('alert').textContent).toContain('Сервер не ответил за 15 секунд');
  });

  it('rejects malformed options and malformed cards gracefully', async () => {
    api.mockResolvedValueOnce(await json({...options,date_min:'2026-02-30'}));
    await expect(getOptions(new AbortController().signal)).rejects.toThrow('неверный ответ сервера');
    const invalid = response(); (invalid.cards[0] as unknown as {languages:null}).languages = null;
    api.mockResolvedValueOnce(await json(invalid));
    await expect(recommend(query,new AbortController().signal)).rejects.toThrow('Не удалось прочитать результат');
  });
});
