export type Query = {
  city: string; date: string; event_format: string; category: string;
  budget_kzt: number; hours: number | null; language: string | null;
};
export type Vendor = {
  id: string; anon_name: string; categories: string[]; city: string;
  price_from_kzt: number; event_formats: string[]; languages: string[];
  max_hours: number | null; busy_dates: string[]; description: string;
  synthetic: boolean; city_imputed: boolean; price_imputed: boolean;
};
export type Reason = 'busy_date'|'over_budget'|'unsupported_format'|
              'unsupported_language'|'insufficient_hours';
export type RankedVendor = {vendor: Vendor; relevance_score: number; matched_terms: string[]};
export type Rejected = {id: string; anon_name: string; reasons: Reason[]};
export type Selection = {
  outcome: 'matched'|'no_category_in_city'|'no_matches';
  query: Query; base_count: number; eligible_count: number;
  ranked: RankedVendor[]; // все подходящие, в стабильном порядке
  rejected: Rejected[];
  rejection_counts: Record<Reason, number>; // пересекающиеся причины
};
export type Explanation = {id: string; text: string; quote: string | null;
                    source: 'llm'|'fallback'};
export type ExplainResult = {items: Explanation[]; warning: string | null;
  mode: 'llm'|'fallback'|'mixed'|'not_needed'; model: string|null; cached: boolean};
export type Card = {
  id: string; name: string; category: string; categories: string[]; city: string;
  price_from_kzt: number; languages: string[]; max_hours: number|null;
  synthetic: boolean; city_imputed: boolean; price_imputed: boolean;
  relevance_score: number; matched_terms: string[];
  explanation: string; evidence_quote: string|null;
  explanation_source: 'llm'|'fallback';
};
export type RecommendResponse = {
  decision_support?: import('./decision-support.js').DecisionSupport; // optional during rollout
  outcome: Selection['outcome']; query: Query; cards: Card[];
  summary: {base_count: number; eligible_count: number; returned_count: number;
    rejected_count: number; rejection_counts: Record<Reason,number>;
    message: string; rejected: Rejected[]};
  explanation: {mode:'llm'|'fallback'|'mixed'|'not_needed';
    model: string|null; cached: boolean; warning: string|null};
  meta: {dataset_sha256: string; ranking_version: 'v1'; elapsed_ms: number};
};
export type ApiError = {error:{code:string;message:string;fields:Record<string,string>}};
