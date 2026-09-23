// Explicit real HTTP acceptance; this file is not run by npm test.
import assert from 'node:assert/strict';
import { loadCatalog } from '../../server/catalog.js';
import type { Query, RecommendResponse } from '../../shared/contracts.js';
import { checkActualResult, checkDecisionResponse, decisionCases, DecisionSupportMissing } from './decision-acceptance.js';

const args = process.argv.slice(2);
if (!args.includes('--run')) {
  console.error('Usage: node --import tsx tests/explanations/decision-live.ts --run [--require-ai] [http://127.0.0.1:3000]');
  console.error('Sends real requests; configured server may consume API credits. --require-ai rejects fallback/mixed.');
  process.exitCode = 2;
} else {
  const unknown = args.filter(a => a.startsWith('--') && !['--run', '--require-ai'].includes(a));
  assert.equal(unknown.length, 0, 'unknown arguments');
  const urls = args.filter(a => !a.startsWith('--'));
  assert.ok(urls.length <= 1, 'at most one server URL');
  const base = new URL(urls[0] ?? 'http://127.0.0.1:3000');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && ['http:', 'https:'].includes(base.protocol) && !base.username && !base.password, 'use a local test server');
  const requireAI = args.includes('--require-ai');
  const catalog = loadCatalog(process.env.DATASET_PATH || 'data/vendors.csv');
  assert.equal(catalog.sha256, '6a724b6b7dfb5973343e68ba18dadb60fc807d87e3d78f03ee86fb26cb089f7d', 'golden scenarios require unchanged organizer CSV');
  const modes = new Set<string>();
  let requests = 0;
  async function request(query: Query): Promise<RecommendResponse> {
    const start = performance.now();
    const response = await fetch(new URL('/api/recommend', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, `HTTP ${response.status}`);
    const body = await response.json() as RecommendResponse;
    assert.ok(performance.now() - start <= 10000, 'DoD response target exceeded');
    modes.add(body.explanation.mode); requests++;
    return body;
  }
  try {
    for (const testCase of decisionCases) {
      const result = await request(testCase.query);
      const support = checkDecisionResponse(result, testCase.query, catalog, requireAI);
      assert.equal(support.status, testCase.status, testCase.name);
      assert.deepEqual(support.alternatives.map(a => ({ kind: a.kind, value: a.kind === 'date' ? a.query.date : a.query.budget_kzt, count: a.eligible_count, ids: a.new_vendor_ids })), testCase.offers, 'golden catalog alternatives');
      const repeat = await request(testCase.query);
      const repeated = checkDecisionResponse(repeat, testCase.query, catalog, requireAI);
      assert.deepEqual(repeated.alternatives, support.alternatives, 'alternative order/content must be stable');
      assert.deepEqual(repeat.cards.map(c => c.id), result.cards.map(c => c.id), 'card order must be stable');
      for (const offer of support.alternatives) {
        const applied = await request(offer.query);
        checkActualResult(applied, offer.query, catalog, requireAI);
        assert.equal(applied.summary.eligible_count, offer.eligible_count, 'applied count must match promised count');
        assert.ok(applied.cards.every(card => !applied.summary.rejected.some(r => r.id === card.id)), 'applied card is rejected');
      }
      console.log(`${testCase.name}: PASS status=${support.status} offers=${support.alternatives.length}`);
    }
    console.log(`PASS: ${requests} real HTTP requests; modes=${[...modes].sort().join(',')}; requireAI=${requireAI}.`);
    console.log('Browser button behavior and cold restart still need separate verification. A fallback pass is not proof of live AI.');
  } catch (error) {
    if (error instanceof DecisionSupportMissing) {
      console.error(`BLOCKED: ${error.message}`); process.exitCode = 2;
    } else {
      console.error(`FAIL: ${error instanceof Error ? error.message : 'unknown response error'}`); process.exitCode = 1;
    }
  }
}
