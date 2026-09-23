import type { Query } from './contracts.js';

/** AI prepares a reviewable brief; the existing query validator owns search constraints. */
export type AssistantDraft = { [K in keyof Query]: Query[K] | null };
export type AssistantBriefRequest = { messages: string[] };
export type AssistantBrief = {
  draft: AssistantDraft;
  query: Query | null;
  summary: string;
  questions: string[];
  preferences: string[];
  warnings: string[];
  source: 'llm';
  model: string;
};

export type AssistantCompareRequest = { query: Query; preferences: string[] };
export type AssistantComparison = {
  items: {
    id: string;
    name: string;
    evidence: { preference: string; quote: string }[];
    to_confirm: string[];
  }[];
  source: 'llm' | 'not_needed';
  model: string | null;
};
