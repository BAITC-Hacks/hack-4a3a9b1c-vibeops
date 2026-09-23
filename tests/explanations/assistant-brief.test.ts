import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantDraft } from '../../shared/assistant.js';
import type { Catalog } from '../../server/catalog.js';
import { AssistantError, createBriefAssistant, requestBrief, type BriefProvider } from '../../server/explanations/assistant-brief.js';

const catalog: Catalog = {
  sha256: 'test-catalog',
  vendors: [{
    id: 'V1', anon_name: 'Профиль 1', city: 'Алматы', categories: ['Ведущий'],
    event_formats: ['свадьба', 'корпоратив'], languages: ['русский', 'казахский'],
    price_from_kzt: 200_000, max_hours: 6, busy_dates: [], description: 'Ведёт свадьбы.',
    synthetic: true, city_imputed: false, price_imputed: false,
  }],
};
const config = () => ({ apiKey: 'test-key-not-real', model: 'test-model' });
const fullMessage = 'Нужен ведущий в Алматы на свадьбу 10 октября 2026, до 400 тысяч тенге, без пошлых конкурсов.';
const fullDraft: AssistantDraft = {
  city: 'Алматы', date: '2026-10-10', event_format: 'свадьба', category: 'Ведущий', budget_kzt: 400_000, hours: null, language: null,
};
const extraction = (draft: Partial<AssistantDraft> = {}, extras: Record<string, unknown> = {}) => ({
  draft: { ...fullDraft, ...draft }, preferences: ['без пошлых конкурсов'], unsupported_constraints: [], required_languages: [],
  date_source: '10 октября 2026', budget_source: '400 тысяч тенге', ...extras,
});
const run = (raw: unknown, messages = [fullMessage]) => createBriefAssistant({ config, provider: async () => raw })(catalog, { messages });
const isError = (status: number, code?: string) => (error: unknown) => {
  assert.ok(error instanceof AssistantError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.ok(!JSON.stringify(error).includes('provider-secret'));
  assert.ok(!error.message.includes('provider-secret'));
  return true;
};

test('complete brief canonicalizes catalog values and preserves optional nulls', async () => {
  const result = await run(extraction({ city: ' алматы ', category: 'ведущий', event_format: 'СВАДЬБА' }));
  assert.deepEqual(result.query, fullDraft);
  assert.equal(result.source, 'llm');
  assert.equal(result.model, 'test-model');
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.preferences, ['без пошлых конкурсов']);
  assert.match(result.summary, /400\s000/u);
  assert.match(result.warnings[0]!, /не гарантируют/u);
});

test('missing required data produces a reviewable draft and never fills defaults', async () => {
  const result = await run(extraction({ date: null, event_format: null, budget_kzt: null }, { date_source: null, budget_source: null }), ['Нужен ведущий в Алматы.']);
  assert.equal(result.query, null);
  assert.equal(result.draft.date, null);
  assert.equal(result.draft.event_format, null);
  assert.equal(result.draft.budget_kzt, null);
  assert.equal(result.questions.length, 3);
  assert.match(result.questions.join(' '), /годом|формат|бюджет/u);
  assert.doesNotMatch(result.questions.join(' '), /язык|длительность/iu);
  assert.equal(result.source, 'llm');
});

test('all clarification history reaches the model and the corrected values become the query', async () => {
  const messages = [fullMessage, 'Поправка: 11.10.2026 и бюджет до 300 000 тенге, язык русский.'];
  const snapshot = structuredClone(messages);
  const provider: BriefProvider = async input => {
    assert.deepEqual(input.messages, messages);
    assert.deepEqual(input.options.cities, ['Алматы']);
    assert.equal(input.options.date_min, '2026-09-23');
    return extraction({ date: '2026-10-11', budget_kzt: 300_000, language: 'русский' }, {
      date_source: '11.10.2026', budget_source: '300 000 тенге', required_languages: ['русский'],
    });
  };
  const result = await createBriefAssistant({ config, provider })(catalog, { messages });
  assert.equal(result.query?.date, '2026-10-11');
  assert.equal(result.query?.budget_kzt, 300_000);
  assert.equal(result.query?.language, 'русский');
  assert.deepEqual(messages, snapshot);
});

test('Kazakh month dates and thousand units are grounded in the original message', async () => {
  const result = await run(extraction({}, { date_source: '2026 жылғы 10 қазан', budget_source: '400 мың теңге' }), ['Алматыда 2026 жылғы 10 қазан тойға жүргізуші керек, бюджет 400 мың теңге.']);
  assert.deepEqual(result.query, fullDraft);
});

test('screenshot correction keeps the explicit date even when the model truncates its source quote', async () => {
  const messages = [
    'Нужен ведущий на корпоратив в Алматы 10 октября 2026 года, бюджет до 1 миллиона тенге.',
    'Нет, поменяй на 11 октября 2026, бюджет 700 тысяч. Остальное оставь',
  ];
  for (const date_source of ['11 октября 2026', '11 октября']) {
    const result = await run(extraction({ date: '2026-10-11', event_format: 'корпоратив', budget_kzt: 700000 }, {
      date_source, budget_source: '700 тысяч', preferences: [],
    }), messages);
    assert.deepEqual(result.query, { ...fullDraft, date: '2026-10-11', event_format: 'корпоратив', budget_kzt: 700000 });
    assert.deepEqual(result.questions, []);
  }
});

test('a date without a year uses the server calendar instead of borrowing an unrelated year', async () => {
  for (const messages of [
    [fullMessage, 'Нет, поменяй на 11 октября, бюджет до 400 тысяч тенге.'],
    ['11 октября, бюджет до 400 тысяч тенге. В 2025 мы уже проводили мероприятие.'],
  ]) {
    const result = await runGrounded(extraction({ date: '2025-10-11' }, { date_source: '11 октября' }), messages);
    assert.equal(result.query?.date, '2026-10-11');
    assert.match(result.warnings.join(' '), /Asia\/Almaty/u);
  }
});

test('mixed full and yearless date alternatives require a choice despite a truncated model quote', async () => {
  for (const messages of [
    ['11 октября 2026 или 11 октября 2027, бюджет до 400 тысяч тенге.'],
    ['11 октября. Альтернатива: 12 октября 2026, бюджет до 400 тысяч тенге.'],
    ['11 октября или 12 октября 2026, бюджет до 400 тысяч тенге.'],
  ]) {
    const result = await runGrounded(extraction({ date: '2026-10-11' }, { date_source: '11 октября' }), messages);
    assert.equal(result.query, null);
    assert.equal(result.draft.date, null);
  }
});

test('invented dates, years and budgets never become an executable query', async () => {
  for (const [draft, extras, messages] of [
    [{ date: '2026-10-11' }, { date_source: '10 октября 2026' }, [fullMessage]],
    [{}, { date_source: 'в октябре' }, ['Нужен ведущий в Алматы на свадьбу в октябре, до 400 тысяч тенге.']],
    [{ budget_kzt: 500_000 }, {}, [fullMessage]],
    [{}, { date_source: null, budget_source: null }, [fullMessage]],
  ] as [Partial<AssistantDraft>, Record<string, unknown>, string[]][]) {
    const result = await run(extraction(draft, extras), messages);
    assert.equal(result.query, null);
    assert.ok(result.questions.length > 0);
    assert.ok(result.warnings.some(warning => /не подтвержден/u.test(warning)));
  }
});

test('mandatory multiple languages are visible and cannot silently reduce to one filter', async () => {
  const result = await run(extraction({ language: 'русский' }, { required_languages: ['русский', 'казахский'] }));
  assert.equal(result.query, null);
  assert.equal(result.draft.language, null);
  assert.match(result.warnings.join(' '), /русский, казахский/u);
  assert.match(result.questions.join(' '), /один язык/u);
});

test('other unrepresentable hard conditions block search until clarified', async () => {
  const result = await run(extraction({}, { unsupported_constraints: ['Нужны ведущий и фотограф в рамках общего бюджета.'] }));
  assert.equal(result.query, null);
  assert.match(result.warnings.join(' '), /ведущий и фотограф/u);
  assert.match(result.questions.join(' '), /одного поиска/u);
});

test('one mandatory language cannot disappear even when the model leaves the draft empty', async () => {
  const result = await run(extraction({}, { required_languages: ['КАЗАХСКИЙ'] }));
  assert.equal(result.query?.language, 'казахский');
});

test('unknown category remains available for the existing honest no-category result', async () => {
  const result = await run(extraction({ category: 'Фокусник' }));
  assert.equal(result.query?.category, 'Фокусник');
  assert.equal(result.draft.category, 'Фокусник');
});

test('server validation retains invalid draft values and asks about invalid or out-of-range fields', async () => {
  const cases: [Partial<AssistantDraft>, Record<string, unknown>, string[], RegExp][] = [
    [{ city: 'Несуществующий город' }, {}, [fullMessage], /Город/u],
    [{ event_format: 'несуществующий формат' }, {}, [fullMessage], /Формат/u],
    [{ hours: 0 }, {}, [fullMessage], /Длительность/u],
    [{ language: 'несуществующий язык' }, {}, [fullMessage], /Язык/u],
    [{ date: '2026-02-31' }, { date_source: '31.02.2026' }, [fullMessage, 'Дата 31.02.2026.'], /существующую дату/u],
    [{ date: '2027-01-01' }, { date_source: '01.01.2027' }, [fullMessage, 'Дата 01.01.2027.'], /2026-12-31/u],
    [{ budget_kzt: -1 }, { budget_source: '-1 тенге' }, [fullMessage, 'Бюджет -1 тенге.'], /не меньше нуля/u],
    [{ budget_kzt: 10.5 }, { budget_source: '10,5 тенге' }, [fullMessage, 'Бюджет 10,5 тенге.'], /целое число/u],
  ];
  for (const [draft, extras, messages, expected] of cases) {
    const result = await run(extraction(draft, extras), messages);
    assert.equal(result.query, null);
    for (const [key, value] of Object.entries(draft)) assert.equal(result.draft[key as keyof AssistantDraft], value);
    assert.match(result.questions.join(' '), expected);
  }
});

test('bounded malformed input is rejected before configuration or provider access', async () => {
  const prepare = createBriefAssistant({ config: () => { throw Error('must not call'); }, provider: async () => { throw Error('must not call'); } });
  for (const input of [null, [], {}, { messages: [] }, { messages: ['  '] }, { messages: [42] }, { messages: ['x'.repeat(2001)] },
    { messages: Array(9).fill('message') }, { messages: Array(5).fill('x'.repeat(2000)) }, { messages: ['valid'], role: 'system' }]) {
    await assert.rejects(prepare(catalog, input), isError(422, 'VALIDATION_ERROR'));
  }
});

test('malformed structured output and forged source quotes return 502, never llm success', async () => {
  for (const raw of [null, 'text', {}, { ...extraction(), extra: true }, extraction({ budget_kzt: '400000' as unknown as number }),
    extraction({}, { preferences: [42] }), extraction({}, { required_languages: 'русский' }),
    extraction({}, { date_source: 'provider-secret fabricated quotation' }), extraction({}, { unsupported_constraints: ['x'.repeat(241)] })]) {
    await assert.rejects(run(raw), isError(502, 'AI_INVALID_RESPONSE'));
  }
});

test('brief preference limits match the comparison endpoint contract', async () => {
  const preferences = ['один', 'два', 'три', 'четыре', 'я'.repeat(200)];
  assert.deepEqual((await run(extraction({}, { preferences }))).preferences, preferences);
  await assert.rejects(run(extraction({}, { preferences: [...preferences, 'шесть'] })), isError(502));
  await assert.rejects(run(extraction({}, { preferences: ['я'.repeat(201)] })), isError(502));
});

test('more than five wishes remain visible as a priority clarification instead of an executable partial brief', async () => {
  const preferences = ['интерактивы', 'живая музыка', 'без пошлых конкурсов', 'свой звук', 'сценарий заранее'];
  const result = await run(extraction({}, {
    preferences,
    unsupported_constraints: ['Также запрошена работа с детьми: всего шесть пожеланий. Выберите до пяти приоритетов для сравнения.'],
  }));
  assert.equal(result.query, null);
  assert.deepEqual(result.preferences, preferences);
  assert.match(result.warnings.join(' '), /работа с детьми/u);
  assert.match(result.questions.join(' '), /Выберите до пяти приоритетов/u);
});

test('missing configuration and provider failures return safe errors without successful fallback', async () => {
  await assert.rejects(createBriefAssistant({ config: () => ({}) })(catalog, { messages: [fullMessage] }), isError(503, 'AI_NOT_CONFIGURED'));
  for (const status of [401, 403, 429, 500]) {
    const prepare = createBriefAssistant({ config, provider: async () => { throw Object.assign(new Error('provider-secret'), { status }); } });
    await assert.rejects(prepare(catalog, { messages: [fullMessage] }), isError(503, 'AI_UNAVAILABLE'));
  }
});

test('deadline aborts the external call even when the provider ignores abort', async () => {
  let signal: AbortSignal | undefined;
  const prepare = createBriefAssistant({ config, timeoutMs: 15, provider: async input => { signal = input.signal; return new Promise(() => {}); } });
  const start = performance.now();
  await assert.rejects(prepare(catalog, { messages: [fullMessage] }), isError(504, 'AI_TIMEOUT'));
  assert.equal(signal?.aborted, true);
  assert.ok(performance.now() - start < 1000);
});

test('real SDK adapter separates untrusted conversation and sends strict non-stored Responses request', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    assert.equal(String(request), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.match(body.instructions, /later explicit corrections replace earlier/u);
    assert.match(body.instructions, /untrusted data/u);
    assert.deepEqual(JSON.parse(body.input).messages, [fullMessage]);
    assert.deepEqual(body.text.format.schema.properties.draft.properties.date.type, ['string', 'null']);
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(extraction()), annotations: [] }] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await requestBrief({ messages: [fullMessage], options: { cities: ['Алматы'], categories: ['Ведущий'], event_formats: ['свадьба'], languages: ['русский'], date_min: '2026-09-23', date_max: '2026-12-31', currency: 'KZT' }, ...config(), signal: new AbortController().signal });
  assert.equal(requests, 1);
  assert.deepEqual(result, extraction());
});

test('SDK adapter does not retry a failed API request', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response('{"error":{"message":"provider-secret"}}', { status: 429, headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(createBriefAssistant({ config })(catalog, { messages: [fullMessage] }), isError(503));
  assert.equal(requests, 1);
});

test('SDK malformed JSON, refusal and incomplete output return invalid-response errors', async t => {
  for (const output of [
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{bad json', annotations: [] }] }] },
    { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'No' }] }] },
    { status: 'incomplete', output: [] },
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'stub', object: 'response', ...output }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await assert.rejects(createBriefAssistant({ config })(catalog, { messages: [fullMessage] }), isError(502));
    mock.mock.restore();
  }
});

const referenceNow = () => new Date('2026-09-23T18:30:00Z'); // 23:30, Almaty.
const quoteBrief = (date: string, money: string, draft: Partial<AssistantDraft> = {}) => extraction(draft, { date_source: date, budget_source: money });
const runGrounded = (raw: unknown, messages: string[], overrides: Parameters<typeof createBriefAssistant>[0] = {}) => createBriefAssistant({
  config, provider: async () => raw, now: referenceNow,
  exchangeRate: async currency => ({ currency, kzt_per_unit: currency === 'USD' ? 500 : currency === 'EUR' ? 600 : 6, date: '2026-09-23', source_url: 'https://nationalbank.kz/fixture' }),
  ...overrides,
})(catalog, { messages });

test('server resolves relative Russian and Kazakh dates using Almaty calendar, not model arithmetic', async () => {
  for (const [phrase, expected] of [
    ['сегодня', '2026-09-23'], ['завтра', '2026-09-24'], ['послезавтра', '2026-09-25'],
    ['через 3 дня', '2026-09-26'], ['через два дня', '2026-09-25'], ['через неделю', '2026-09-30'],
    ['бүгін', '2026-09-23'], ['ертең', '2026-09-24'], ['бүрсігүні', '2026-09-25'], ['2 күннен кейін', '2026-09-25'],
  ]) {
    const result = await runGrounded(quoteBrief(phrase!, '400 тысяч тенге', { date: null }), [`Нужен ведущий в Алматы на свадьбу ${phrase}, 400 тысяч тенге.`]);
    assert.equal(result.query?.date, expected, phrase);
    assert.match(result.warnings.join(' '), /Asia\/Almaty/u);
    assert.ok(result.summary.includes(expected!));
  }
  const result = await runGrounded(quoteBrief('завтра', '400 тысяч тенге', { date: '2030-01-01' }), ['Свадьба завтра, 400 тысяч тенге.'], { now: () => new Date('2026-09-23T19:01:00Z') });
  assert.equal(result.query?.date, '2026-09-25'); // Local date already September 24.
});

test('relative dates outside the fixed catalog window remain invalid and ambiguity asks for one date', async () => {
  const result = await runGrounded(quoteBrief('послезавтра', '400 тысяч тенге', { date: null }), ['Свадьба послезавтра, 400 тысяч тенге.'], { now: () => new Date('2026-12-30T12:00:00Z') });
  assert.equal(result.draft.date, '2027-01-01');
  assert.equal(result.query, null);
  assert.match(result.questions.join(' '), /2026-12-31/u);
  const ambiguous = await runGrounded(quoteBrief('завтра или послезавтра', '400 тысяч тенге', { date: null }), ['Свадьба завтра или послезавтра, 400 тысяч тенге.']);
  assert.equal(ambiguous.query, null);
  assert.equal(ambiguous.draft.date, null);
});

test('date context is sent to the provider and later relative corrections retain the other fields', async () => {
  const messages = [fullMessage, 'Переносим на послезавтра.'];
  const result = await runGrounded(extraction(), messages, { provider: async input => {
    assert.equal(input.today, '2026-09-23');
    assert.equal(input.time_zone, 'Asia/Almaty');
    return extraction(); // Deliberately stale model source.
  } });
  assert.deepEqual(result.query, { ...fullDraft, date: '2026-09-25' });
  const explicitCorrection = await runGrounded(extraction(), [fullMessage, 'Поправка: дата 11.10.2026.']);
  assert.equal(explicitCorrection.query?.date, '2026-10-11');
});

test('USD EUR RUB budgets are calculated by the server and clearly disclosed before confirmation', async () => {
  for (const [phrase, expected] of [['500 долларов', 250000], ['500USD', 250000], ['$500', 250000], ['500 евро', 300000], ['500 EUR', 300000], ['500 рублей', 3000], ['500₽', 3000], ['1,5 тысячи долларов', 750000]]) {
    const result = await runGrounded(quoteBrief('10 октября 2026', phrase as string, { budget_kzt: null }), [`Ведущий Алматы свадьба 10 октября 2026, бюджет ${phrase}.`]);
    assert.equal(result.query?.budget_kzt, expected, phrase as string);
    assert.match(result.summary, /приблизительно/u);
    assert.match(result.warnings.join(' '), /курс на 2026-09-23.*nationalbank\.kz.*Подтвердите/u);
  }
});

test('a foreign amount can never be treated as the same numeric amount of tenge', async () => {
  const result = await runGrounded(quoteBrief('10 октября 2026', '500', { budget_kzt: 500 }), ['Ведущий Алматы свадьба 10 октября 2026, бюджет 500 долларов.']);
  assert.equal(result.query?.budget_kzt, 250000);
  const unavailable = await runGrounded(quoteBrief('10 октября 2026', '500 долларов', { budget_kzt: 500 }), ['Ведущий Алматы свадьба 10 октября 2026, бюджет 500 долларов.'], { exchangeRate: async () => null });
  assert.equal(unavailable.query, null);
  assert.equal(unavailable.draft.budget_kzt, null);
  assert.match(unavailable.warnings.join(' '), /500 USD/u);
  assert.match(unavailable.questions.join(' '), /бюджет в тенге/u);
});

test('guest counts hours calendar numbers and hourly prices are not total budgets', async () => {
  for (const [source, amount] of [['100 гостей', 100], ['5 часов', 5], ['10 октября 2026', 10], ['500 тенге в час', 500], ['бюджет на 100 гостей', 100]]) {
    const result = await runGrounded(quoteBrief('10 октября 2026', source as string, { budget_kzt: amount as number }), [`Свадьба 10 октября 2026, ${source}.`]);
    assert.equal(result.query, null, source as string);
    assert.equal(result.draft.budget_kzt, null, source as string);
  }
});

test('plain explicit tenge budgets work and latest explicit correction overrides stale model amounts', async () => {
  for (const [source, amount] of [['бюджет 500000', 500000], ['400 тысяч тенге', 400000], ['бюджет 1,5 млн', 1500000]]) {
    const result = await runGrounded(quoteBrief('10 октября 2026', source as string, { budget_kzt: amount as number }), [`Свадьба 10 октября 2026, ${source}.`]);
    assert.equal(result.query?.budget_kzt, amount, source as string);
  }
  const corrected = await runGrounded(extraction(), [fullMessage, 'Нет, бюджет 300000 тенге.']);
  assert.equal(corrected.query?.budget_kzt, 300000);
  assert.equal(corrected.query?.date, fullDraft.date);
});

test('multiple alternative monetary amounts cannot be silently reduced to one budget', async () => {
  const result = await runGrounded(quoteBrief('10 октября 2026', '500 долларов', { budget_kzt: 500 }), ['Свадьба 10 октября 2026, бюджет 500 долларов или 300000 тенге.']);
  assert.equal(result.query, null);
  assert.equal(result.draft.budget_kzt, null);
});

test('unsupported currencies minimum budgets and ranges never silently become a tenge maximum', async () => {
  for (const [phrase, amount] of [['бюджет 500 GBP', 500], ['бюджет 500 фунтов', 500], ['от 500 долларов', 500], ['100–500 долларов', 500]]) {
    const result = await runGrounded(quoteBrief('10 октября 2026', phrase as string, { budget_kzt: amount as number }), [`Свадьба 10 октября 2026, ${phrase}.`]);
    assert.equal(result.query, null, phrase as string);
    assert.equal(result.draft.budget_kzt, null, phrase as string);
  }
});

test('withdrawn dates and foreign budgets do not reappear from older messages', async () => {
  const result = await runGrounded(extraction({ date: null, budget_kzt: null }, { date_source: null, budget_source: null }), ['Свадьба завтра, бюджет 500 долларов.', 'Отменяем эту дату и бюджет. Уточню новые позже.']);
  assert.equal(result.query, null);
  assert.equal(result.draft.date, null);
  assert.equal(result.draft.budget_kzt, null);
});

test('weekdays weeks and dates without a year use a visible deterministic future-date rule', async () => {
  for (const [phrase, expected] of [['в эту пятницу', '2026-09-25'], ['в пятницу', '2026-09-25'], ['в следующую пятницу', '2026-10-02'], ['через 2 недели', '2026-10-07'], ['25 сентября', '2026-09-25'], ['23 сентября', '2026-09-23']]) {
    const result = await runGrounded(quoteBrief(phrase!, '400 тысяч тенге', { date: null }), [`Свадьба ${phrase}, бюджет 400 тысяч тенге.`]);
    assert.equal(result.query?.date, expected, phrase);
    assert.match(result.warnings.join(' '), /ближайшее наступление/u);
  }
  const pastMonth = await runGrounded(quoteBrief('20 сентября', '400 тысяч тенге', { date: null }), ['Свадьба 20 сентября, бюджет 400 тысяч тенге.']);
  assert.equal(pastMonth.draft.date, '2027-09-20');
  assert.equal(pastMonth.query, null);
  const impossible = await runGrounded(quoteBrief('31 ноября', '400 тысяч тенге', { date: null }), ['Свадьба 31 ноября, бюджет 400 тысяч тенге.']);
  assert.equal(impossible.query, null);
  assert.match(impossible.questions.join(' '), /существующую дату/u);
});

test('negated natural dates are ignored and weekday alternatives require clarification even if the model picks one', async () => {
  const corrected = await runGrounded(quoteBrief('завтра', '400 тысяч тенге', { date: '2026-09-24' }), ['Свадьба не завтра, а послезавтра, бюджет 400 тысяч тенге.']);
  assert.equal(corrected.query?.date, '2026-09-25');
  const rejected = await runGrounded(quoteBrief('завтра', '400 тысяч тенге', { date: '2026-09-24' }), ['Свадьба не завтра, бюджет 400 тысяч тенге.']);
  assert.equal(rejected.query, null);
  assert.equal(rejected.draft.date, null);
  const alternatives = await runGrounded(quoteBrief('пятницу', '400 тысяч тенге', { date: '2026-09-25' }), ['Свадьба в пятницу или субботу, бюджет 400 тысяч тенге.']);
  assert.equal(alternatives.query, null);
  assert.equal(alternatives.draft.date, null);
});

test('verified FX conversion removes only a redundant currency conversion question, not other hard constraints', async () => {
  const messages = ['Свадьба 10 октября 2026, бюджет 500 долларов.'];
  const redundant = 'Бюджет указан в иностранной валюте: 500 долларов. Пожалуйста, уточните бюджет в тенге.';
  const draft = { budget_kzt: null };
  const raw = extraction(draft, { budget_source: '500 долларов', unsupported_constraints: [redundant] });
  const result = await runGrounded(raw, messages);
  assert.equal(result.query?.budget_kzt, 250000);
  assert.deepEqual(result.questions, []);
  const shared = await runGrounded(extraction(draft, { budget_source: '500 долларов', unsupported_constraints: [redundant, 'Бюджет общий на ведущего и фотографа.'] }), messages);
  assert.equal(shared.query, null);
  assert.match(shared.questions.join(' '), /ведущего и фотографа/u);
  const missingRate = await runGrounded(raw, messages, { exchangeRate: async () => null });
  assert.equal(missingRate.query, null);
});

test('this weekday already in the past asks for a date instead of silently choosing next week', async () => {
  const result = await runGrounded(quoteBrief('пятницу', '400 тысяч тенге', { date: null }), ['Свадьба в эту пятницу, бюджет 400 тысяч тенге.'], { now: () => new Date('2026-09-26T12:00:00Z') });
  assert.equal(result.query, null);
  assert.equal(result.draft.date, null);
  assert.match(result.warnings.join(' '), /уже прошёл/u);
});


test('a short model quote retains next-week and day-after-tomorrow qualifiers from its message', async () => {
  const weekday = await runGrounded(quoteBrief('пятницу', '400 тысяч тенге', { date: null }), ['Свадьба в следующую пятницу, бюджет 400 тысяч тенге.']);
  assert.equal(weekday.query?.date, '2026-10-02');
  const relative = await runGrounded(quoteBrief('завтра', '400 тысяч тенге', { date: null }), ['Свадьба послезавтра, бюджет 400 тысяч тенге.']);
  assert.equal(relative.query?.date, '2026-09-25');
});

test('SDK quote schema permits only exact bounded source fragments, retaining long messages and corrections', async t => {
  const first = `Подробности: ${'а'.repeat(280)} свадьба послезавтра в Алматы, бюджет 500 долларов. ${'б'.repeat(340)} Категория ведущий.`;
  const correction = 'Теперь бюджет 300 тысяч тенге, остальные условия без изменений.';
  const messages = [first, correction];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_request: RequestInfo | URL, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    const properties = body.text.format.schema.properties;
    for (const field of ['date_source', 'budget_source']) {
      const choices = properties[field].enum as (string | null)[];
      assert.ok(choices.includes(null));
      assert.ok(choices.length <= 129);
      assert.ok(choices.includes(correction));
      assert.ok(choices.some(value => value?.includes('свадьба послезавтра')));
      assert.ok(choices.some(value => value?.includes('500 долларов')));
      assert.ok(choices.includes('300 тысяч тенге'));
      assert.ok(!choices.includes('300000 тенге'));
      assert.ok(choices.every(value => value === null || (value.length <= 300 && messages.some(message => message.includes(value)))));
    }
    assert.deepEqual(JSON.parse(body.input).messages, messages);
    return new Response(JSON.stringify({ id: 'stub', object: 'response', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(extraction()), annotations: [] }] },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await requestBrief({ messages, options: { cities: ['Алматы'], categories: ['Ведущий'], event_formats: ['свадьба'], languages: ['русский'], date_min: '2026-09-23', date_max: '2026-12-31', currency: 'KZT' }, ...config(), signal: new AbortController().signal });
  assert.equal(requests, 1);
});

test('screenshot date and budget correction keeps latest conditions with full truncated or stale sources', async () => {
  const messages = [
    'Нужен ведущий на корпоратив в Алматы 10 октября 2026 года, бюджет до 1 миллиона тенге.',
    'Нет, поменяй на 11 октября 2026, бюджет 700 тысяч. Остальное оставь',
  ];
  for (const date_source of ['11 октября 2026', '11 октября', '10 октября 2026']) {
    const result = await runGrounded(extraction({ date: '2026-10-11', event_format: 'корпоратив', budget_kzt: 700000 }, {
      date_source, budget_source: '700 тысяч', preferences: [],
    }), messages);
    assert.deepEqual(result.query, { ...fullDraft, date: '2026-10-11', event_format: 'корпоратив', budget_kzt: 700000 });
    assert.deepEqual(result.questions, []);
  }
});

test('a truncated date quote cannot erase an explicit out-of-range year or alternative years', async () => {
  const explicit = await runGrounded(extraction({ date: '2027-10-11' }, { date_source: '11 октября', budget_source: '400 тысяч тенге' }), ['Свадьба 11 октября 2027, бюджет 400 тысяч тенге.']);
  assert.equal(explicit.query, null);
  assert.equal(explicit.draft.date, '2027-10-11');
  const ambiguous = await runGrounded(extraction({ date: '2026-10-11' }, { date_source: '11 октября', budget_source: '400 тысяч тенге' }), ['Свадьба 11 октября 2026 или 11 октября 2027, бюджет 400 тысяч тенге.']);
  assert.equal(ambiguous.query, null);
  assert.equal(ambiguous.draft.date, null);
});
