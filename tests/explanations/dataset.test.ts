import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../server/catalog.js';
import { fallbackExplanation, createExplainer } from '../../server/explanations/index.js';
import { evidenceOptions, verifiedQuote } from '../../server/explanations/evidence.js';
import { selectVendors } from '../../server/matching.js';
import { demoCases } from './demo-cases.js';

test('all catalog evidence options are short verbatim excerpts of their own source', () => {
  for (const vendor of loadCatalog('data/vendors.csv').vendors) {
    const options = evidenceOptions(vendor.description);
    assert.ok(options.length > 0, `No evidence options for ${vendor.id}`);
    for (const quote of options) assert.equal(verifiedQuote(vendor.description, quote), quote, vendor.id);
  }
});

test('D1-D6 explanation fixtures use eligible source records, not invented profiles', () => {
  for (const { name, input: { query, candidates } } of demoCases) {
    for (const { vendor } of candidates) {
      assert.equal(vendor.city, query.city, name);
      assert.ok(vendor.categories.includes(query.category), name);
      assert.ok(vendor.event_formats.includes(query.event_format), name);
      assert.ok(!vendor.busy_dates.includes(query.date), name);
      assert.ok(vendor.price_from_kzt <= query.budget_kzt, name);
    }
  }
});

test('D1, D2, D3 and D6 fallback retains individual evidence, including venues', () => {
  for (const { name, input } of demoCases.filter(c => c.input.candidates.length)) {
    const results = input.candidates.map(c => fallbackExplanation(input.query, c));
    for (const [index, result] of results.entries()) {
      assert.equal(result.source, 'fallback'); assert.ok(result.quote, `${name}/${result.id} lacks evidence`);
      assert.equal(verifiedQuote(input.candidates[index]!.vendor.description, result.quote), result.quote);
      assert.ok(result.text.includes(input.query.date.split('-').reverse().join('.')));
    }
    assert.equal(new Set(results.map(r => r.quote)).size, results.length, `Interchangeable quotes in ${name}`);
  }
});

test('D4/D5 explanation layer never calls provider for empty selections', async () => {
  const explain = createExplainer({ provider: () => { throw new Error('Must not call'); } });
  for (const demo of demoCases.filter(c => !c.input.candidates.length)) {
    assert.equal((await explain(demo.input)).mode, 'not_needed');
  }
});


test('actual D1-D6 ranking yields sourced, distinct feature-first explanations', async () => {
  const catalog = loadCatalog('data/vendors.csv');
  const explain = createExplainer({ config: () => ({}) });
  for (const { name, input: fixture } of demoCases) {
    const selected = selectVendors(catalog.vendors, fixture.query).ranked.slice(0, 3);
    const result = await explain({ query: fixture.query, candidates: selected, dataset_sha256: catalog.sha256 });
    assert.deepEqual(result.items.map(item => item.id), selected.map(item => item.vendor.id));
    for (const [index, item] of result.items.entries()) {
      assert.ok(item.quote, `${name}/${item.id} has no concrete evidence`);
      assert.equal(verifiedQuote(selected[index]!.vendor.description, item.quote), item.quote);
      assert.ok(item.text.startsWith('В описании:'), `${name}/${item.id}: feature should come first`);
    }
    // Lexical distinctness is a regression check; semantic usefulness still needs human review.
    assert.equal(new Set(result.items.map(item => item.quote)).size, result.items.length, name);
  }
});
