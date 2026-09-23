import assert from 'node:assert/strict';
import test from 'node:test';
import { createExchangeRateLoader, parseExchangeRates, RATE_SOURCE } from '../../server/explanations/exchange-rates.js';

const now = new Date('2026-09-23T10:00:00Z');
const item = (currency = 'USD', value = '447.85', quant = '1', date = '23.09.2026') => `<item><title>${currency}</title><pubDate>${date}</pubDate><description>${value}</description><quant>${quant}</quant></item>`;

test('official feed units, comma decimals and source/date are preserved', () => {
  assert.deepEqual(parseExchangeRates(`<rss>${item()}${item('RUB', '53,10', '10')}</rss>`, now), [
    { currency: 'USD', kzt_per_unit: 447.85, date: '2026-09-23', source_url: RATE_SOURCE },
    { currency: 'RUB', kzt_per_unit: 5.31, date: '2026-09-23', source_url: RATE_SOURCE },
  ]);
});

test('future, expired, impossible, malformed, duplicated and entity-bearing rates are rejected', () => {
  for (const xml of [item('USD', '447', '0'), item('USD', '-447'), item('USD', '447', '1', '24.09.2026'), item('USD', '447', '1', '15.09.2026'), item('USD', '447', '1', '31.02.2026'), item()+item(), '<!DOCTYPE rss>'+item()]) {
    assert.deepEqual(parseExchangeRates(xml, now), []);
  }
});

test('freshness uses Kazakhstan date, including a UTC midnight boundary', () => {
  assert.equal(parseExchangeRates(item('USD', '447', '1', '24.09.2026'), new Date('2026-09-23T20:00:00Z')).length, 1);
});

test('requests share a fetch, cache defensively, and expire old references', async () => {
  let calls = 0;
  const loader = createExchangeRateLoader({ snapshot: [], fetch: async () => { calls++; return new Response(item()+item('EUR', '513.46')); } });
  const [usd, eur] = await Promise.all([loader('USD', now), loader('EUR', now)]);
  assert.equal(calls, 1); assert.equal(usd!.kzt_per_unit, 447.85); assert.equal(eur!.currency, 'EUR');
  usd!.kzt_per_unit = 1;
  assert.equal((await loader('USD', now))!.kzt_per_unit, 447.85);
  assert.equal(await loader('USD', new Date('2026-10-01T10:00:00Z')), null);
});

test('network failure uses a dated short-lived snapshot and never invents missing rates', async () => {
  let calls = 0;
  const failing: typeof fetch = async () => { calls++; throw new Error('network down'); };
  const loader = createExchangeRateLoader({ fetch: failing });
  assert.equal((await loader('USD', now))!.kzt_per_unit, 447.85);
  assert.equal((await loader('EUR', now))!.date, '2026-09-23');
  assert.equal(calls, 1);
  assert.equal(await loader('USD', new Date('2026-10-01T10:00:00Z')), null);
  assert.equal(await createExchangeRateLoader({ fetch: failing, snapshot: [] })('USD', now), null);
});
