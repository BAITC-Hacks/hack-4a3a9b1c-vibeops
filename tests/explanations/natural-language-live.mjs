// Explicit live acceptance for the current Kazakhstan date within the organizer calendar.
import assert from 'node:assert/strict';
const args=process.argv.slice(2);
if (!args.includes('--live')) { console.error('Use --live and optional local server URL; this calls real AI and consumes credits.'); process.exit(2); }
const urls=args.filter(a=>!a.startsWith('--'));
assert.ok(urls.length<=1 && args.every(a=>a==='--live'||!a.startsWith('--')), 'Unexpected arguments');
const target=new URL(urls[0]??'http://127.0.0.1:3000');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname)&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password,'Use a local test server');
const base=target.origin;
const {getExchangeRate}=await import('../../server/explanations/exchange-rates.ts');
const health=await fetch(base+'/api/health');
assert.equal(health.status,200);
assert.equal((await health.json()).ai_configured,true,'Start the server with real AI configuration');
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const next=d=>{const x=new Date(today+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+d);return x.toISOString().slice(0,10)};
const report=[];let failed=0;
const day=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7;
const fridayThisWeek=next(4-day), fridayNextWeek=next(11-day);
const shortDate=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'UTC'}).format(new Date(next(2)+'T12:00:00Z'));
async function check(name,messages,expect) {
 const start=performance.now();
 try {const r=await fetch(base+'/api/assistant/brief',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({messages})}); const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));await expect(b);report.push({name,pass:true,ms:Math.round(performance.now()-start),query:b.query,draft:b.draft,warnings:b.warnings,questions:b.questions});}
 catch(e){failed++;report.push({name,pass:false,ms:Math.round(performance.now()-start),error:e.message});}
 console.log(JSON.stringify(report.at(-1)));
}
try {
 const rate=await getExchangeRate('USD');assert.ok(rate);
 await check('relative USD',['Нужен ведущий на свадьбу в Алматы послезавтра, бюджет 500 долларов.'],b=>{assert.ok(b.query);assert.equal(b.query.date,next(2));assert.equal(b.query.budget_kzt,Math.floor(500*rate.kzt_per_unit));assert.match(b.warnings.join(' '),/USD/);});
 await check('guest count is not money',['Нужен ведущий на свадьбу в Алматы послезавтра, будет 100 гостей.'],b=>{assert.equal(b.query,null);assert.equal(b.draft.budget_kzt,null);assert.equal(b.draft.date,next(2));});
 await check('guest count with valid budget',['Нужен ведущий на свадьбу в Алматы послезавтра, 100 гостей, бюджет 500 тысяч тенге.'],b=>{assert.ok(b.query);assert.equal(b.query.budget_kzt,500000);});
 await check('relative three days',['Нужен фотограф в Астане на свадьбу через 3 дня, бюджет 150 тысяч тенге.'],b=>{assert.ok(b.query);assert.equal(b.query.date,next(3));assert.equal(b.query.budget_kzt,150000);});
 await check('USD then KZT correction',['Нужен ведущий на свадьбу в Алматы послезавтра, бюджет 500 долларов.','Теперь бюджет 300 тысяч тенге, остальные условия без изменений.'],b=>{assert.ok(b.query);assert.equal(b.query.budget_kzt,300000);assert.equal(b.query.date,next(2));});
 await check('unsupported currency',['Нужен ведущий на свадьбу в Алматы 10 октября 2026, бюджет 500 фунтов стерлингов.'],b=>{assert.equal(b.query,null);assert.equal(b.draft.budget_kzt,null);});
 await check('multiple mandatory languages',['Нужен ведущий на свадьбу в Алматы 10 октября 2026, бюджет 500 тысяч тенге. Обязательно владеющий и русским, и казахским.'],b=>{assert.equal(b.query,null);assert.ok(b.questions.length);});
 await check('missing category',['Нужна свадьба в Алматы послезавтра, бюджет 500 долларов.'],b=>{assert.equal(b.draft.date,next(2));assert.equal(b.query,null);assert.ok(b.questions.length);});
 await check('weekday this Friday',['Нужен ведущий на свадьбу в Алматы в эту пятницу, бюджет 500 тысяч тенге.'],b=>{if(day>4){assert.equal(b.query,null);}else{assert.ok(b.query);assert.equal(b.query.date,fridayThisWeek);}});
 await check('weekday next Friday',['Нужен ведущий на свадьбу в Алматы в следующую пятницу, бюджет 500 тысяч тенге.'],b=>{assert.ok(b.query);assert.equal(b.query.date,fridayNextWeek);});
 await check('day and month without year',[`Нужен ведущий на свадьбу в Алматы ${shortDate}, бюджет 500 тысяч тенге.`],b=>{assert.ok(b.query);assert.equal(b.query.date,next(2));});
 await check('negative date correction',['Нужен ведущий на свадьбу в Алматы не завтра, а послезавтра, бюджет 500 тысяч тенге.'],b=>{assert.ok(b.query);assert.equal(b.query.date,next(2));});
 await check('two weeks',['Нужен ведущий на свадьбу в Алматы через две недели, бюджет 500 тысяч тенге.'],b=>{assert.ok(b.query);assert.equal(b.query.date,next(14));});
 await check('alternative dates need clarification',['Нужен ведущий на свадьбу в Алматы в пятницу или субботу, бюджет 500 тысяч тенге.'],b=>{assert.equal(b.query,null);assert.equal(b.draft.date,null);});
 await check('explicit screenshot correction',['Нужен ведущий на корпоратив в Алматы 10 октября 2026 года, бюджет до 1 миллиона тенге.','Нет, поменяй на 11 октября 2026, бюджет 700 тысяч. Остальное оставь'],b=>{assert.ok(b.query);assert.equal(b.query.date,'2026-10-11');assert.equal(b.query.budget_kzt,700000);});
 await check('explicit year outside catalog',['Нужен ведущий на свадьбу в Алматы 11 октября 2027, бюджет 500 тысяч тенге.'],b=>{assert.equal(b.query,null);assert.equal(b.draft.date,'2027-10-11');assert.ok(b.questions.length);});

 if(failed)process.exitCode=1;
 console.log(JSON.stringify({total:report.length,failed}));
} finally { /* The caller owns the running server. */ }
