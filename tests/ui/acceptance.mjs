// Real HTTP only: no fixtures and no local selection. Run against your own local server.
import assert from 'node:assert/strict';
import {cases,checkResponse} from './acceptance-checks.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname) || !['http:','https:'].includes(base.protocol)) throw new Error('Use a local server URL; this runner does not test third-party services.');
let failures=0;
const orders=new Map();
let datasetHash;
for(const testCase of cases){
  try{
    let previous;
    for(let repeat=0;repeat<3;repeat++){
      const started=performance.now();
      const response=await fetch(new URL('/api/recommend',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(testCase.query),signal:AbortSignal.timeout(15000)});
      const body=await response.json();
      const elapsed=Math.round(performance.now()-started);
      if(response.status===501 && body?.error?.code==='NOT_IMPLEMENTED'){
        console.error('BLOCKED: /api/recommend returned the 501 scaffold. Acceptance is incomplete, not passed.');process.exitCode=2;break;
      }
      assert.equal(response.status,200,`HTTP ${response.status}`);
      const ids=checkResponse(testCase,body);
      if(previous) assert.deepEqual(ids,previous,'same query must keep the same order');
      previous=ids;
      if(datasetHash) assert.equal(body.meta.dataset_sha256,datasetHash,'dataset changed during acceptance run');
      datasetHash=body.meta.dataset_sha256;
      console.log(`${testCase.id} repeat=${repeat+1} outcome=${body.outcome} ids=${ids.join(',')||'-'} mode=${body.explanation.mode} elapsed=${elapsed}ms`);
      assert.ok(elapsed<=10000,'Exceeded the DoD target of 10 seconds; investigate before demo');
    }
    if(process.exitCode===2) break;
    orders.set(testCase.id,previous);
  }catch(error){failures++;console.error(`FAIL ${testCase.id}: ${error instanceof Error?error.message:'request failed'}`);}
}
if(process.exitCode!==2){
  if(orders.has('D1')&&orders.has('D2')){
    try{assert.notDeepEqual(orders.get('D1'),orders.get('D2'),'D1/D2 must demonstrate a changed selection');}catch(error){failures++;console.error(error.message);}
  }
  process.exitCode=failures?1:0;
  console.log(failures?`FAILED: ${failures} checks. See diagnostics above.`:'PASS: six real API scenarios, three repeats each, eligibility/counts/busy reasons and elapsed time.');
  console.log('Still manual: explanation quality without names, UI rendering, restart determinism, live AI and jury access. A fallback pass is NOT proof of live AI.');
}
