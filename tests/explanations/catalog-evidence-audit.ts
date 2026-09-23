// Full-catalog fallback audit; explicit opt-in, no API calls. Not a semantic quality score.
import { loadCatalog, catalogOptions } from '../../server/catalog.js';
import { selectVendors } from '../../server/matching.js';
import { buildExplanationSet, verifiedQuote } from '../../server/explanations/evidence.js';
import type { Query } from '../../shared/contracts.js';

if (!process.argv.includes('--run')) {
  console.error('Usage: node --import tsx tests/explanations/catalog-evidence-audit.ts --run');
  process.exitCode = 2;
} else {
  const catalog = loadCatalog(process.env.DATASET_PATH || 'data/vendors.csv');
  const options = catalogOptions(catalog);
  let nonempty = 0, duplicateTexts = 0, duplicateQuotes = 0, invalidQuotes = 0, sharedDisclosures = 0;
  const missing = new Set<string>();
  for (const city of options.cities) for (const category of options.categories) {
    if (!catalog.vendors.some(v => v.city === city && v.categories.includes(category))) continue;
    for (const event_format of options.event_formats) for (let day = 0; day < 100; day++) {
      const date = new Date(Date.parse('2026-09-23T00:00:00Z') + day * 86400000).toISOString().slice(0, 10);
      const query: Query = { city, category, event_format, date, budget_kzt: 6000000, language: null, hours: null };
      const candidates = selectVendors(catalog.vendors, query).ranked.slice(0, 3);
      if (!candidates.length) continue;
      nonempty++;
      const result = buildExplanationSet(query, candidates);
      if (result.sharedEvidence) sharedDisclosures++;
      if (new Set(result.items.map(i => i.text)).size < result.items.length) duplicateTexts++;
      const quotes = result.items.map(i => i.quote).filter(Boolean);
      if (new Set(quotes).size < quotes.length) duplicateQuotes++;
      for (const item of result.items) {
        if (!item.quote) missing.add(item.id);
        else if (verifiedQuote(candidates.find(c => c.vendor.id === item.id)!.vendor.description, item.quote) !== item.quote) invalidQuotes++;
      }
    }
  }
  console.log(JSON.stringify({ scope: 'fallback only; all catalog cities/categories/formats, 100 dates; budget 6000000, no language/hours filters; not a semantic quality guarantee', dataset_sha256: catalog.sha256,
    nonempty, duplicateTexts, duplicateQuotes, invalidQuotes, sharedDisclosures, missingProfiles: [...missing].sort() }, null, 2));
  if (invalidQuotes || duplicateTexts || duplicateQuotes) process.exitCode = 1;
}
