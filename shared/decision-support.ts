import type { Query } from './contracts.js';

/** Additive API extension. No existing query/card/outcome fields change. */
export type DecisionAlternative = {
  kind: 'date' | 'budget';
  query: Query;
  eligible_count: number;
  new_vendor_ids: string[]; // all newly eligible IDs, not just top-3; sorted ASCII
  title: string;
  explanation: string;
  source: 'catalog'; // counterfactual counts are computed, never invented by LLM
};
export type ComparisonItem = {
  vendor_id: string;
  feature: string;
  evidence_quote: string | null;
  source: 'llm' | 'fallback' | 'catalog';
};
export type DecisionSupport = {
  version: 'v1';
  status: 'available' | 'not_needed' | 'no_category' | 'no_single_change';
  alternatives: DecisionAlternative[]; // at most one date, then at most one budget
  comparison: ComparisonItem[]; // current cards only, same order; empty for <2 cards
  message: string | null;
};
