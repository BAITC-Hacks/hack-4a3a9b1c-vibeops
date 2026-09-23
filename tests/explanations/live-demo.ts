import 'dotenv/config';
import { explainSelection, createExplainer } from '../../server/explanations/index.js';
import { demoCases } from './demo-cases.js';

// Opt-in only: not matched by npm test. No keys, raw exceptions or transport headers are logged.
const live = process.argv.includes('--live');
if (live && (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)) {
  console.error('Live check needs server OPENAI_API_KEY and OPENAI_MODEL.'); process.exit(1);
}
const explain = live ? explainSelection : createExplainer({ config: () => ({}) });
for (const demo of demoCases) {
  const start = performance.now();
  const cold = await explain(demo.input);
  const coldMs = Math.round(performance.now() - start);
  const warmStart = performance.now();
  const warm = await explain(demo.input);
  console.log(JSON.stringify({ case: demo.name, scope: 'explanation module only; preset eligible IDs, not API/ranking',
    requested_live: live, cold_ms: coldMs, warm_ms: Math.round(performance.now() - warmStart),
    mode: cold.mode, model: cold.model, warning: cold.warning, warm_cached: warm.cached,
    items: cold.items.map(item => ({ id: item.id, source: item.source, quote: item.quote, text: item.text })),
  }));
}
