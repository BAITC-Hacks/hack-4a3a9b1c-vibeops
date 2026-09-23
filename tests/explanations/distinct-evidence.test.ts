import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCatalog, catalogOptions } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import { createExplainer } from '../../server/explanations/index.js';
import { buildExplanationSet, contextualEvidenceOptions, usefulEvidenceOptions, verifiedQuote, evidenceKey } from '../../server/explanations/evidence.js';
import type { Query, RankedVendor } from '../../shared/contracts.js';

const catalog = loadCatalog('data/vendors.csv');
const query: Query = { city: 'Алматы', category: 'Лайв-бэнд', event_format: 'свадьба', date: '2026-09-23', budget_kzt: 6000000, hours: null, language: null };
const bands = selectVendors(catalog.vendors, query).ranked.slice(0, 3);
const row = (id: string, description: string): RankedVendor => ({ ...bands[0]!, vendor: { ...bands[0]!.vendor, id, anon_name: id, description } });
const config = () => ({ apiKey: 'fake-test-key', model: 'test-model' });

test('Nurbol live-band regression: actual selection explains different musical lineups, not identical repertoire', async () => {
  const result = await createExplainer({ config: () => ({}) })({ query, candidates: bands, dataset_sha256: catalog.sha256 });
  const thunder = result.items.find(i => i.id === 'HK-23752')!;
  const eva = result.items.find(i => i.id === 'HK-83709')!;
  assert.match(thunder.quote!, /два вокалиста/u);
  assert.match(eva.quote!, /4 вокалиста, струнный квартет/u);
  assert.notEqual(thunder.text, eva.text);
  assert.equal(new Set(result.items.map(i => evidenceKey(i.quote!, bands))).size, result.items.length);
  for (const item of result.items) assert.equal(verifiedQuote(bands.find(c => c.vendor.id === item.id)!.vendor.description, item.quote), item.quote);
});

test('duplicate but valid model quotes are replaced from the same profiles and attributed as fallback', async () => {
  const repeated = 'В репертуаре группы большой выбор казахских песен, ретро-шлягеров, хитов 80-х, 90-х, 2000-х, а так же, современные хиты.';
  const candidates = bands.filter(c => ['HK-23752', 'HK-83709'].includes(c.vendor.id));
  const result = await createExplainer({ config, provider: async () => ({ items: candidates.map(c => ({ id: c.vendor.id, quote: repeated })) }) })({ query, candidates, dataset_sha256: catalog.sha256 });
  assert.equal(result.mode, 'fallback'); assert.ok(result.warning);
  assert.equal(new Set(result.items.map(i => i.quote)).size, 2);
  for (const item of result.items) assert.equal(item.source, 'fallback');
  const choices = contextualEvidenceOptions(query, candidates);
  for (const c of candidates) assert.ok(!choices.get(c.vendor.id)!.options.includes(repeated), 'shared repertoire excluded from model choices when distinctive lineups exist');
});

test('unavailable distinctions are disclosed, not manufactured with names or arbitrary wording', async () => {
  const candidates = [row('Первый', 'Проводим командные игры и интерактивы.'), row('Второй', 'Проводим командные игры и интерактивы.')];
  const result = await createExplainer({ config, provider: async () => ({ items: candidates.map(c => ({ id: c.vendor.id, quote: c.vendor.description })) }) })({ query, candidates, dataset_sha256: 'same-descriptions' });
  assert.match(result.warning!, /не найдено отдельных отличительных сведений/u);
  for (const item of result.items) {
    assert.match(item.text, /отдельное отличие от других карточек в описании не найдено/u);
    assert.doesNotMatch(item.text, /Первый|Второй/u);
    assert.equal(item.quote, 'Проводим командные игры и интерактивы.');
  }
});

test('context choice preserves the sole fact of one profile instead of reusing it in a richer peer', () => {
  const candidates = [row('A', 'Проводим командные игры и интерактивы. Выступаем струнным квартетом.'), row('B', 'Проводим командные игры и интерактивы.')];
  const result = buildExplanationSet(query, candidates);
  assert.equal(result.items[0]!.quote, 'Выступаем струнным квартетом.');
  assert.equal(result.items[1]!.quote, 'Проводим командные игры и интерактивы.');
});

test('comparison keys ignore names, punctuation and letter case without modifying the source quotes', () => {
  const candidates = [row('Анна', 'Анна проводит командные игры.'), row('Ирина', 'Ирина проводит командные игры!')];
  assert.equal(evidenceKey(candidates[0]!.vendor.description, candidates), evidenceKey(candidates[1]!.vendor.description, candidates));
  assert.equal(buildExplanationSet(query, candidates).sharedEvidence, true);
});

test('gifts, ensembles, ceremonies and video retain specific facts across supported formats', () => {
  const examples: [string, RegExp][] = [
    ['HK-90005', /именные открытки/u], ['HK-36965', /казахскую песню/u],
    ['HK-39301', /перед главой государства/u], ['HK-90007', /регистрац|церемони/u],
    ['HK-74914', /видеограф/u], ['HK-10990', /VIDEOGRAPHER|colorist/u],
  ];
  for (const [id, fact] of examples) {
    const v = catalog.vendors.find(v => v.id === id)!;
    for (const event_format of v.event_formats) {
      const options = usefulEvidenceOptions({ ...query, category: v.categories[0]!, event_format }, v.description);
      assert.ok(options.some(q => fact.test(q)), `${id}/${event_format} loses its specific fact`);
    }
  }
  // No hand-maintained service word is needed to preserve an otherwise informative sentence.
  assert.ok(usefulEvidenceOptions(query, 'Выдаём гостям керамические медальоны с рельефными инициалами.').length);
});

test('all 17 categories are covered; only two reviewed thin descriptions may have no useful quote', () => {
  assert.equal(catalogOptions(catalog).categories.length, 17);
  const thin = new Set(['HK-25279', 'HK-92824']);
  for (const v of catalog.vendors) {
    for (const category of v.categories) for (const event_format of v.event_formats) {
      const options = usefulEvidenceOptions({ ...query, category, event_format }, v.description);
      if (!thin.has(v.id)) assert.ok(options.length, `${v.id}/${category}/${event_format}`);
      for (const quote of options) assert.equal(verifiedQuote(v.description, quote), quote);
    }
  }
});


test('impressions are not printing services; brand-only promotional differences cannot enter model choices', () => {
  const praise = '«Thunder Breath Band» band – это парад незабываемых впечатлений и отличного настроения.';
  assert.deepEqual(usefulEvidenceOptions(query, praise), []);
  const choices = contextualEvidenceOptions(query, bands);
  for (const c of bands) assert.ok(choices.get(c.vendor.id)!.options.every(q => !q.includes('парад незабываемых впечатлений')));
  const profile = 'Гоку — ведущий, который держит зал, уважает культуру и превращает событие в тёплую, лёгкую и динамичную историю. Работает на телевидении более 12 лет.';
  assert.deepEqual(usefulEvidenceOptions(query, profile), ['Работает на телевидении более 12 лет.']);
});


test('long brand lists do not crowd out shorter factual evidence when both exist', () => {
  const v = catalog.vendors.find(v => v.id === 'HK-27222')!;
  const options = usefulEvidenceOptions({ ...query, event_format: 'корпоратив' }, v.description);
  assert.ok(options.length);
  assert.ok(options.every(q => !q.startsWith('С Гоку сотрудничали')));
  assert.ok(options.some(q => /телевидении|12 лет|радиостанциях/u.test(q)));
});
