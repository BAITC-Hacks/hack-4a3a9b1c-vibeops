import type { Card, Query, RecommendResponse } from '../../shared/contracts';

// UI test doubles only. These are not the real catalog or evidence of backend correctness.
export const options = {
  cities: ['Алматы', 'Астана'], categories: ['Ведущий', 'Флорист', 'Декоратор', 'Банкетный зал'],
  event_formats: ['корпоратив', 'свадьба'], languages: ['русский', 'казахский'],
  date_min: '2026-09-23', date_max: '2026-12-31', currency: 'KZT',
};
export const query: Query = {city:'Алматы',date:'2026-10-10',event_format:'корпоратив',category:'Ведущий',budget_kzt:1000000,hours:null,language:null};
export function card(id = 'fixture-1'): Card {
  return {id,name:`Тестовый подрядчик ${id}`,category:'Ведущий',categories:['Ведущий'],city:'Алматы',price_from_kzt:250000,languages:['русский'],max_hours:4,synthetic:false,city_imputed:false,price_imputed:false,relevance_score:1,matched_terms:['корпоратив'],explanation:'Проводит корпоративы с интерактивной программой.',evidence_quote:'интерактивной программой',explanation_source:'llm'};
}
export function response(overrides: Partial<RecommendResponse> = {}): RecommendResponse {
  return {outcome:'matched',query:{...query},cards:[card()],summary:{base_count:2,eligible_count:1,returned_count:1,rejected_count:1,rejection_counts:{busy_date:1,over_budget:0,unsupported_format:0,unsupported_language:0,insufficient_hours:0},message:'Найден один подходящий подрядчик. Другой занят на эту дату.',rejected:[{id:'fixture-busy',anon_name:'Занятый профиль',reasons:['busy_date']}]},explanation:{mode:'llm',model:'test-model',cached:false,warning:null},meta:{dataset_sha256:'test-fixture-not-real-data',ranking_version:'v1',elapsed_ms:24},...overrides};
}
