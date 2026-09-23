import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantDraft } from '../../shared/assistant.js';
import type { Catalog } from '../../server/catalog.js';
import { createBriefAssistant } from '../../server/explanations/assistant-brief.js';
import { moneyMentions } from '../../server/explanations/brief-grounding.js';

// All providers and exchange rates below are fixtures: these tests never call a paid API.
const catalog: Catalog = {
  sha256: 'budget-words-test',
  vendors: [{
    id: 'V1', anon_name: 'Профиль 1', city: 'Алматы', categories: ['Ведущий'],
    event_formats: ['корпоратив'], languages: ['русский'],
    price_from_kzt: 100_000, max_hours: 6, busy_dates: [], description: 'Ведёт корпоративы.',
    synthetic: true, city_imputed: false, price_imputed: false,
  }],
};
const draft: AssistantDraft = {
  city: 'Алматы', category: 'Ведущий', event_format: 'корпоратив', date: '2026-10-11',
  budget_kzt: null, hours: 5, language: 'русский',
};
const intro = 'Нужен ведущий на корпоратив в Алматы 11 октября 2026, на русском, на 5 часов.';
const run = (messages: string[], budgetSource: string | null, budget: number | null = null) => createBriefAssistant({
  config: () => ({ apiKey: 'test-key-not-real', model: 'test-model' }),
  now: () => new Date('2026-09-23T12:00:00Z'),
  provider: async () => ({
    draft: { ...draft, budget_kzt: budget }, preferences: [], unsupported_constraints: [],
    required_languages: ['русский'], date_source: '11 октября 2026', budget_source: budgetSource,
  }),
  exchangeRate: async currency => ({ currency, kzt_per_unit: 500, date: '2026-09-23', source_url: 'https://nationalbank.kz/fixture' }),
})(catalog, { messages });

test('Russian word amounts retain exact arithmetic and do not inflate a plain hundred', () => {
  for (const [text, amount] of [
    ['бюджет сто тысяч', 100_000],
    ['пятьсот тысяч', 500_000],
    ['полмиллиона', 500_000],
    ['один миллион двести тысяч', 1_200_000],
    ['бюджет сто', 100],
  ] as const) {
    const mentions = moneyMentions(text);
    assert.equal(mentions.length, 1, text);
    assert.equal(mentions[0]!.amount, amount, text);
    assert.equal(mentions[0]!.currency, 'KZT', text);
    assert.equal(mentions[0]!.notTotal, false, text);
  }
});

test('word amounts preserve foreign denomination, including the reported Cyrillic k shorthand', () => {
  for (const text of ['тридцать тысяч долларов', '30к долларов', '30k долларов']) {
    const mentions = moneyMentions(text);
    assert.equal(mentions.length, 1, text);
    assert.equal(mentions[0]!.amount, 30_000, text);
    assert.equal(mentions[0]!.currency, 'USD', text);
    assert.equal(mentions[0]!.notTotal, false, text);
  }
});

test('word guest counts hours minimums and ranges cannot become a single total maximum', () => {
  for (const text of [
    'сто гостей', 'пять часов', 'бюджет сто гостей',
    'бюджет от ста тысяч', 'бюджет от сто тысяч',
    'бюджет сто–пятьсот тысяч', 'бюджет сто тысяч или пятьсот тысяч',
    'бюджет сто тысяч тенге в час',
  ]) {
    const mentions = moneyMentions(text);
    assert.ok(mentions.length !== 1 || mentions[0]!.notTotal, text);
  }
});

test('brief fills grounded word budgets even when the model left the amount and quote null', async () => {
  for (const [text, amount] of [
    ['бюджет сто тысяч', 100_000],
    ['пятьсот тысяч', 500_000],
    ['полмиллиона', 500_000],
    ['один миллион двести тысяч', 1_200_000],
    ['бюджет сто', 100],
  ] as const) {
    for (const source of [text, null]) {
      const result = await run([intro, text], source);
      assert.deepEqual(result.query, { ...draft, budget_kzt: amount }, `${text}, source=${source}`);
      assert.deepEqual(result.questions, [], text);
    }
  }
});

test('brief converts complete currency context when the model quote contains only its currency or number', async () => {
  for (const source of ['долларов', '30к', '30к долларов', null]) {
    const result = await run([intro, 'поменяй бюджет на 30к долларов'], source);
    assert.deepEqual(result.query, { ...draft, budget_kzt: 15_000_000 }, `source=${source}`);
    assert.match(result.warnings.join(' '), /30\s000 USD/u);
    assert.match(result.warnings.join(' '), /2026-09-23.*nationalbank\.kz/u);
  }
  const words = await run([intro, 'бюджет тридцать тысяч долларов'], 'тридцать тысяч долларов');
  assert.equal(words.query?.budget_kzt, 15_000_000);
});

test('a later word budget correction wins over a stale quoted numeric budget without losing other fields', async () => {
  const result = await run([`${intro} Бюджет 500000 тенге.`, 'Нет, бюджет сто тысяч. Остальное оставь.'], '500000 тенге', 500_000);
  assert.deepEqual(result.query, { ...draft, budget_kzt: 100_000 });
});

test('word support does not accept invented numeric amounts or guest-count budgets', async () => {
  const invented = await run([`${intro} Бюджет 400000 тенге.`], '400000 тенге', 900_000);
  assert.equal(invented.query, null);
  assert.equal(invented.draft.budget_kzt, null);
  for (const source of ['сто гостей', 'пять часов', 'бюджет сто гостей']) {
    const result = await run([intro, source], source, source.includes('сто') ? 100 : 5);
    assert.equal(result.query, null, source);
    assert.equal(result.draft.budget_kzt, null, source);
  }
});
