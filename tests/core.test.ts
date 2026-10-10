import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from '../src/scheduler.ts';
import { State } from '../src/state.ts';
import { GatewayError } from '../src/errors.ts';
import type { Provider, ProviderEvent, QuotaSnapshot } from '../src/types.ts';
const request={model:'auto',messages:[{role:'user' as const,content:'hello'}],stream:false};
const unknown=():QuotaSnapshot=>({source:'unknown',observedAt:Date.now(),windows:[]});
const quota=(remaining:number,second?:number):QuotaSnapshot=>({source:'official',observedAt:Date.now(),windows:[{unit:'requests',remaining,limit:100,resetAt:Date.now()+60000},...(second===undefined?[]:[{unit:'requests' as const,remaining:second,limit:100,resetAt:Date.now()+60000}])]});
function provider(id:string,q=unknown(),kind?:string):Provider { return {id,models:['default'],enabled:true,priority:0,maxConcurrency:1,capabilities:{system:true,history:true},health:async()=>({available:true}),quota:async()=>q,invoke:async function*(){if(kind)throw new GatewayError(kind as any,kind);yield {type:'text',text:id};yield {type:'done'};}}; }
const collect=async(iter:AsyncIterable<ProviderEvent>)=>{const out=[];for await(const e of iter)out.push(e);return out;};
test('explicit disabled provider reports configuration state before probing quota',async()=>{
  const s=new State(':memory:');const a=provider('a');a.enabled=false;
  a.health=async()=>{assert.fail('disabled provider probed');return {available:false};};
  try{await assert.rejects(collect(new Router([a,provider('b')],s).run({...request,model:'a/default'})),(e:any)=>e.kind==='unsupported'&&e.status===400&&e.message.includes('disabled')&&e.providerId==='a');assert.equal(s.status().leases.length,0);}finally{s.close();}
});
test('known quota chooses the bottleneck across all windows',async()=>{const s=new State(':memory:');try{const r=new Router([provider('a',quota(90,5)),provider('b',quota(30,40))],s);const out=await collect(r.run(request));assert.equal((out[0] as any).providerId,'b');}finally{s.close();}});
test('zero quota excluded while unknown remains eligible',async()=>{const s=new State(':memory:');try{assert.equal((await collect(new Router([provider('a',quota(0)),provider('b')],s).run(request)))[0].type,'text');}finally{s.close();}});
test('quota exhaustion falls back and persists block across restart',async()=>{const file=join(mkdtempSync(join(tmpdir(),'gateway-')),'state.sqlite');let s=new State(file);const a=provider('a',quota(90),'quota_exhausted'), b=provider('b',quota(50));assert.equal((await collect(new Router([a,b],s).run(request)))[0].text,'b');s.close();s=new State(file);assert.equal((await collect(new Router([a,b],s).run(request)))[0].text,'b');assert.equal(s.status().leases.length,0);s.close();});
test('all exhausted returns quota error without upstream invocation',async()=>{const s=new State(':memory:');try{await assert.rejects(collect(new Router([provider('a',quota(0))],s).run(request)),(e:any)=>e.kind==='quota_exhausted');}finally{s.close();}});
test('transient errors get one attempt per provider',async()=>{const s=new State(':memory:');try{let attempts=0;const a=provider('a');a.invoke=async function*(){attempts++;throw new GatewayError('transient','upstream unavailable');};await assert.rejects(collect(new Router([a],s).run(request)));assert.equal(attempts,1);}finally{s.close();}});
test('stream failure after text never mixes a second provider',async()=>{const s=new State(':memory:');try{const a=provider('a',quota(90));a.invoke=async function*(){yield {type:'text',text:'partial'};throw new GatewayError('transient','failed');};const out=[];await assert.rejects((async()=>{for await(const e of new Router([a,provider('b',quota(50))],s).run({...request,stream:true}))out.push(e);})());assert.deepEqual(out.map(e=>(e as any).providerId),['a']);}finally{s.close();}});
test('non-stream failure discards partial answer and falls back',async()=>{const s=new State(':memory:');try{const a=provider('a',quota(90));a.invoke=async function*(){yield {type:'text',text:'partial'};throw new GatewayError('transient','failed');};assert.equal((await collect(new Router([a,provider('b',quota(50))],s).run(request)))[0].text,'b');}finally{s.close();}});
test('concurrent requests reserve provider slots atomically',async()=>{const s=new State(':memory:');try{let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);const a=provider('a',quota(90));a.invoke=async function*(){await gate;yield {type:'text',text:'a'};yield {type:'done'};};const r=new Router([a,provider('b',quota(50))],s);const first=collect(r.run(request));await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await collect(r.run(request)))[0].text,'b');release();await first;assert.equal(s.status().leases.length,0);}finally{s.close();}});
test('cancelled upstream releases lease and never retries',async()=>{const s=new State(':memory:');try{const control=new AbortController();const a=provider('a');a.invoke=async function*(_req,signal){control.abort();signal.throwIfAborted();yield {type:'done'};};await assert.rejects(collect(new Router([a],s).run(request,control.signal)));assert.equal(s.status().leases.length,0);}finally{s.close();}});
test('manual exhausted quota does not become unlimited when remote is unknown',async()=>{const s=new State(':memory:');try{s.saveQuota('a','default',{...quota(0),source:'manual'});await assert.rejects(collect(new Router([provider('a')],s).run(request)),(e:any)=>e.kind==='quota_exhausted');}finally{s.close();}});
test('explicit provider aliases stay pinned on failure',async()=>{const s=new State(':memory:');try{await assert.rejects(collect(new Router([provider('a',quota(0)),provider('b')],s).run({...request,model:'a/default'})));}finally{s.close();}});
test('missing done event is a failed attempt, not silent success',async()=>{const s=new State(':memory:');try{const a=provider('a');a.invoke=async function*(){yield {type:'text',text:'incomplete'};};await assert.rejects(collect(new Router([a],s).run(request)));}finally{s.close();}});

test('null usedPercent scores as requests, not percent', async()=>{const {quotaScore}=await import('../src/quota.ts');assert.equal(quotaScore({source:'official',observedAt:Date.now(),windows:[{unit:'requests',remaining:5,limit:1000,usedPercent:null,resetAt:null}]}),0.005);});
test('synchronous invoke throws still release lease',async()=>{const s=new State(':memory:');try{const a=provider('a');a.invoke=()=>{throw Error('sync');};await assert.rejects(collect(new Router([a],s).run(request)));assert.equal(s.status().leases.length,0);}finally{s.close();}});
test('shared model pools account consumption together',()=>{const s=new State(':memory:');try{const q={...quota(2),pool:'shared'};s.saveQuota('a','m1',q);s.saveQuota('a','m2',q);s.consume('a','m1');assert.equal(s.getQuota('a','m2')!.windows[0].remaining,1);}finally{s.close();}});
test('local estimates preserve original official observation',()=>{const s=new State(':memory:');try{s.saveQuota('a','default',quota(3));s.consume('a','default');const q=s.getQuota('a','default') as any;assert.equal(q.windows[0].remaining,2);assert.equal(q.reported.source,'official');assert.equal(q.reported.windows[0].remaining,3);}finally{s.close();}});
test('token reservations cannot overcommit a shared model pool',()=>{const s=new State(':memory:');try{const q:QuotaSnapshot={source:'official',observedAt:Date.now(),pool:'shared',windows:[{unit:'tokens',remaining:100,limit:100,resetAt:null}]};s.saveQuota('a','m1',q);s.saveQuota('a','m2',q);assert.ok(s.reserve('a','m1',10,Date.now()+10000,{requests:1,tokens:80}));assert.equal(s.reserve('a','m2',10,Date.now()+10000,{requests:1,tokens:80}),undefined);}finally{s.close();}});
test('cancelled submitted request retains possible consumption',async()=>{const s=new State(':memory:');try{const c=new AbortController();const a=provider('a',quota(3));a.invoke=async function*(){c.abort();throw c.signal.reason;};await assert.rejects(collect(new Router([a],s).run(request,c.signal)));assert.equal(s.getQuota('a','default')!.windows[0].remaining,2);}finally{s.close();}});
test('computed exhaustion cooldown is included in final error',async()=>{const s=new State(':memory:');try{await assert.rejects(collect(new Router([provider('a',unknown(),'quota_exhausted')],s).run(request)),(e:any)=>e.retryAt>Date.now());}finally{s.close();}});
test('expired block permits only one concurrent recovery probe',()=>{const s=new State(':memory:');try{s.block('a','default','quota_exhausted',Date.now()-1);assert.ok(s.reserve('a','default',5,Date.now()+10000));assert.equal(s.reserve('a','default',5,Date.now()+10000),undefined);}finally{s.close();}});

test('successful demo calls consume finite manual quota rather than resetting it',async()=>{const s=new State(':memory:');try{const a=provider('a',{...quota(2),source:'manual'});const r=new Router([a],s);await collect(r.run(request));await collect(r.run(request));await assert.rejects(collect(r.run(request)),(e:any)=>e.kind==='quota_exhausted');}finally{s.close();}});
test('cancel during quota refresh accounts a submitted request only once',async()=>{const s=new State(':memory:');try{const c=new AbortController();let reads=0;const a=provider('a',quota(3));a.quota=async()=>{reads++;if(reads>1){c.abort();throw c.signal.reason;}return quota(3);};await assert.rejects(collect(new Router([a],s).run(request,c.signal)));assert.equal(s.getQuota('a','default')!.windows[0].remaining,2);}finally{s.close();}});
test('stale official zero without reset permits one reserved recovery probe',()=>{const s=new State(':memory:');try{s.saveQuota('a','default',{source:'official',observedAt:Date.now()-120000,windows:[{unit:'requests',remaining:0,limit:100,resetAt:null}]});s.block('a','default','quota_exhausted',Date.now()-1);assert.ok(s.reserve('a','default',3,Date.now()+10000));assert.equal(s.reserve('a','default',3,Date.now()+10000),undefined);}finally{s.close();}});

test('returning a partial stream accounts consumption and cancels upstream',async()=>{const s=new State(':memory:');try{const a=provider('a',quota(3));let stopped=false;a.invoke=async function*(_r,signal){signal.addEventListener('abort',()=>stopped=true);yield {type:'text',text:'partial'};yield {type:'done'};};const iter=new Router([a],s).run({...request,stream:true});await iter.next();await iter.return();assert.equal(s.getQuota('a','default')!.windows[0].remaining,2);assert.equal(s.status().leases.length,0);assert.ok(stopped);}finally{s.close();}});

test('single-turn provider accepts an optional leading system message',async()=>{const s=new State(':memory:');try{const a=provider('a');a.capabilities.history=false;assert.equal((await collect(new Router([a],s).run({...request,messages:[{role:'system',content:'be concise'},...request.messages]})))[0].text,'a');}finally{s.close();}});
test('pure provider preflight filters unsupported roles before dispatch',async()=>{const s=new State(':memory:');try{let calls=0;const a=provider('a',quota(90));a.validate=()=>{throw new GatewayError('unsupported','role cannot be represented');};a.invoke=async function*(){calls++;assert.fail('unsupported provider invoked');yield {type:'done'};};assert.equal((await collect(new Router([a,provider('b',quota(50))],s).run(request)))[0].text,'b');assert.equal(calls,0);}finally{s.close();}});

test('negative reported token usage never increases available quota',()=>{const s=new State(':memory:');try{s.saveQuota('a','default',{source:'manual',observedAt:Date.now(),windows:[{unit:'tokens',remaining:100,limit:100,resetAt:null}]});s.consume('a','default',{total_tokens:-5},{requests:1,tokens:4});assert.equal(s.getQuota('a','default')!.windows[0].remaining,96);}finally{s.close();}});
test('many tiny nonstream deltas are aggregated into bounded routed events',async()=>{const s=new State(':memory:');try{const a=provider('a');a.invoke=async function*(){for(let i=0;i<5000;i++)yield {type:'text',text:'x'};yield {type:'done'};};const out=await collect(new Router([a],s).run(request));assert.equal(out.filter(e=>e.type==='text').map((e:any)=>e.text).join('').length,5000);assert.ok(out.length<20);}finally{s.close();}});
test('hung health candidate cannot block a healthy provider',async()=>{const s=new State(':memory:');try{const a=provider('a');a.health=()=>new Promise(()=>{});const start=Date.now();const out=await collect(new Router([a,provider('b')],s,{timeoutMs:200,probeTimeoutMs:30}).run(request));assert.equal(out[0].text,'b');assert.ok(Date.now()-start<150);}finally{s.close();}});

test('quota CLI receives a separate deadline from the short health probe', async () => {
  const s=new State(':memory:');
  try {
    const a=provider('a');
    a.quota=async(signalModel,signal)=>{
      await new Promise(resolve=>setTimeout(resolve,60));
      signal.throwIfAborted();return quota(80);
    };
    const out=await collect(new Router([a],s,{timeoutMs:500,probeTimeoutMs:20,quotaProbeTimeoutMs:150}).run(request));
    assert.equal(out[0].text,'a');
  }finally{s.close();}
});

test('passive official quota observations do not overwrite a manual override after completion', async () => {
  const s=new State(':memory:');
  try {
    s.saveQuota('a','default',{...quota(10),source:'manual'});
    const a=provider('a');a.quota=async()=>({source:'official',observedAt:Date.now(),windows:[{unit:'requests',remaining:80,limit:100,resetAt:null}]});
    await collect(new Router([a],s).run(request));
    assert.equal(s.getQuota('a','default')?.reported?.source ?? s.getQuota('a','default')?.source,'manual');
  }finally{s.close();}
});

test('failed optional quota query does not disable a healthy pinned provider', async () => {
  const s=new State(':memory:');
  try {
    const a=provider('a');a.quota=()=>new Promise(()=>{});
    const out=await collect(new Router([a],s,{timeoutMs:300,probeTimeoutMs:10,quotaProbeTimeoutMs:20})
      .run({...request,model:'a/default'}));
    assert.equal(out[0].text,'a');assert.equal(s.getQuota('a','default')?.source,'unknown');
  }finally{s.close();}
});

test('manual override arriving during quota query remains authoritative', async () => {
  const s=new State(':memory:');
  try {
    const a=provider('a');let queries=0;
    a.quota=async()=>{
      if (++queries===1) s.saveQuota('a','default',{...quota(10),source:'manual'});
      return {...quota(80),observedAt:Date.now()+1};
    };
    await collect(new Router([a],s).run(request));
    assert.equal(s.getQuota('a','default')?.reported?.source ?? s.getQuota('a','default')?.source,'manual');
  }finally{s.close();}
});

test('official sibling model cannot overwrite its destination manual shared pool', () => {
  const s=new State(':memory:');
  try {
    s.saveQuota('a','m1',{...quota(0),source:'manual',pool:'shared'});
    s.saveQuota('a','m2',{...quota(80),observedAt:Date.now()+10,pool:'shared'});
    assert.equal(s.getQuota('a','m1')?.source,'manual');
    assert.equal(s.getQuota('a','m2')?.windows[0].remaining,0);
  }finally{s.close();}
});

test('changed official data at the same millisecond updates while duplicates preserve local reservations', () => {
  const s=new State(':memory:');
  try {
    const q=quota(80);s.saveQuota('a','default',q);
    s.consume('a','default',undefined,{requests:1,tokens:1});
    s.saveQuota('a','default',q);assert.equal(s.getQuota('a','default')?.windows[0].remaining,79);
    s.saveQuota('a','default',{...q,windows:[{...q.windows[0],remaining:0}]});
    assert.equal(s.getQuota('a','default')?.windows[0].remaining,0);
  }finally{s.close();}
});
