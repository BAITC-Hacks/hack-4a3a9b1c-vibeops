import assert from 'node:assert/strict';

const base = {city:'Алматы',date:'2026-10-10',event_format:'корпоратив',category:'Ведущий',budget_kzt:1000000,hours:null,language:null};
// Allowed eligible IDs, NOT a replacement ranking implementation.
export const cases = [
  {id:'D1',query:{...base},base:10,eligible:4,ids:['HK-88430','HK-77838','HK-27222','HK-29829'],busy:'HK-44733'},
  {id:'D2',query:{...base,date:'2026-10-11'},base:10,eligible:4,ids:['HK-44733','HK-44923','HK-77838','HK-27222'],busy:'HK-88430'},
  {id:'D3',query:{...base,category:'Флорист',event_format:'свадьба',budget_kzt:500000},base:2,eligible:1,ids:['HK-39372'],busy:'HK-90001'},
  {id:'D4',query:{...base,city:'Астана',category:'Декоратор',event_format:'свадьба',budget_kzt:500000},base:0,eligible:0,ids:[]},
  {id:'D5',query:{...base,budget_kzt:1},base:10,eligible:0,ids:[]},
  {id:'D6',query:{...base,category:'Банкетный зал',event_format:'свадьба',budget_kzt:5000000,date:'2026-11-14'},base:7,eligible:2,ids:['HK-64395','HK-90011']},
];

export function checkResponse(testCase, result) {
  const {query,base,eligible,ids,busy}=testCase;
  assert.equal(result.outcome,base===0?'no_category_in_city':eligible===0?'no_matches':'matched','outcome');
  assert.deepEqual(result.query,query,'canonical query, including null optional values');
  assert.ok(Array.isArray(result.cards),'cards array');
  assert.equal(result.cards.length,Math.min(3,eligible),'returned cards');
  assert.equal(new Set(result.cards.map(c=>c.id)).size,result.cards.length,'unique cards');
  assert.equal(result.summary.base_count,base,'base_count');
  assert.equal(result.summary.eligible_count,eligible,'eligible_count');
  assert.equal(result.summary.returned_count,result.cards.length,'returned_count');
  assert.equal(result.summary.rejected_count,base-eligible,'rejected_count');
  assert.ok(typeof result.summary.message==='string' && result.summary.message.trim(),'human-readable summary');
  assert.ok(Array.isArray(result.summary.rejected),'rejected array');
  assert.equal(new Set(result.summary.rejected.map(r=>r.id)).size,base-eligible,'unique rejected profiles');
  if(busy) assert.ok(result.summary.rejected.some(r=>r.id===busy && r.reasons.includes('busy_date')),'date-specific busy reason');
  if(testCase.id==='D5') assert.equal(result.summary.rejection_counts.over_budget,10,'all ten exceed budget');
  assert.ok(['llm','fallback','mixed','not_needed'].includes(result.explanation.mode),'explanation mode');
  const sources=[];
  for(const card of result.cards){
    assert.ok(ids.includes(card.id),`ineligible card ${card.id}`);
    assert.equal(card.city,query.city); assert.equal(card.category,query.category);
    assert.ok(Number.isFinite(card.price_from_kzt) && card.price_from_kzt>=0 && card.price_from_kzt<=query.budget_kzt,'starting price within budget');
    assert.ok(typeof card.name==='string' && card.name.trim(),'name');
    assert.ok(typeof card.explanation==='string' && card.explanation.trim(),'nonempty explanation');
    assert.ok(!/отличный выбор для вашего мероприятия/iu.test(card.explanation),'generic advertising explanation');
    assert.ok(['llm','fallback'].includes(card.explanation_source),'card source');
    sources.push(card.explanation_source);
    for(const key of ['synthetic','city_imputed','price_imputed']) assert.equal(typeof card[key],'boolean',key);
  }
  const mode=!sources.length?'not_needed':sources.every(s=>s==='llm')?'llm':sources.every(s=>s==='fallback')?'fallback':'mixed';
  assert.equal(result.explanation.mode,mode,'mode agrees with card sources');
  if(mode==='fallback'||mode==='mixed') assert.ok(typeof result.explanation.warning==='string' && result.explanation.warning.trim(),'visible fallback warning');
  assert.equal(result.meta.ranking_version,'v1');
  assert.match(result.meta.dataset_sha256,/^[a-f0-9]{64}$/i,'dataset SHA256');
  return result.cards.map(c=>c.id);
}
