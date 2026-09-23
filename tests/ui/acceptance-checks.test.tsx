import { describe, expect, it } from 'vitest';
import { DEMOS } from '../../client/src/demo';
import { cases, checkResponse } from './acceptance-checks.mjs';
import { response, card } from './fixtures';

function fixture(id='D3') {
  const testCase=cases.find(item=>item.id===id)!;
  const cards=testCase.ids.slice(0,Math.min(3,testCase.eligible)).map(id=>({...card(id),city:testCase.query.city,category:testCase.query.category}));
  const result=response({query:testCase.query,cards,outcome:testCase.base===0?'no_category_in_city':testCase.eligible===0?'no_matches':'matched'});
  Object.assign(result.summary,{base_count:testCase.base,eligible_count:testCase.eligible,returned_count:cards.length,rejected_count:testCase.base-testCase.eligible,rejected:Array.from({length:testCase.base-testCase.eligible},(_,i)=>({id:i===0&&testCase.busy?testCase.busy:`excluded-${i}`,anon_name:'Test rejected',reasons:['busy_date']}))});
  result.explanation.mode=cards.length?'llm':'not_needed';
  result.meta.dataset_sha256='a'.repeat(64);
  if(id==='D5')result.summary.rejection_counts.over_budget=10;
  return {testCase,result};
}
describe('Acceptance checker self-tests (fixtures, not real API acceptance)',()=>{
  it('matches the exact UI demo requests',()=>expect(cases.map(c=>c.query)).toEqual(DEMOS.map(d=>d.query)));
  it.each(['D1','D2','D3','D4','D5','D6'])('accepts a contract-valid %s fixture',id=>{
    const {testCase,result}=fixture(id);expect(()=>checkResponse(testCase,result)).not.toThrow();
  });
  it('rejects a busy/noneligible profile',()=>{const {testCase,result}=fixture();result.cards[0].id='HK-90001';expect(()=>checkResponse(testCase,result)).toThrow(/ineligible/);});
  it('rejects missing date diagnostics',()=>{const {testCase,result}=fixture();result.summary.rejected[0].reasons=[];expect(()=>checkResponse(testCase,result)).toThrow(/busy/);});
  it('rejects misleading AI attribution',()=>{const {testCase,result}=fixture();result.explanation.mode='fallback';expect(()=>checkResponse(testCase,result)).toThrow(/sources/);});
  it('rejects the wrong canonical query',()=>{const {testCase,result}=fixture();result.query={...result.query,language:'русский'};expect(()=>checkResponse(testCase,result)).toThrow(/canonical/);});
});
