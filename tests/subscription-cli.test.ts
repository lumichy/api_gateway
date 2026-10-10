import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {mkdtemp,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { createProvider } from '../src/adapters/index.ts';
import { Router } from '../src/scheduler.ts';
import { State } from '../src/state.ts';
const signal = () => new AbortController().signal;
const make = (type: 'codex' | 'claude') => createProvider({
  id: type, type, ...(type === 'codex' ? {mode: 'exec' as any} : {}), models:['m'],
  enabled:true, billingVerified:true, command:process.execPath,
  args:[fileURLToPath(new URL(`./fixtures/${type === 'codex' ? 'codex-exec' : 'claude'}.mjs`,import.meta.url))],
});
const req = (text:string, system?:string) => ({model:'m',stream:true,messages:[...(system === undefined ? [] : [{role:'system',content:system}]),{role:'user',content:text}]});
const events = (p:any, text:string, system?:string, s=signal()) => Array.fromAsync(p.invoke(req(text,system),s));
for(const text of ['INIT_NO_AUTH','INIT_EMPTY_AUTH','INIT_PAID_AUTH'])test(`Claude rejects ${text} authentication metadata`,async()=>{
  await assert.rejects(()=>events(make('claude'),text),{kind:'auth_required'});
});
test('Claude account status refuses API credentials despite loggedIn true',async()=>{
  process.env.GATEWAY_FIXTURE_AUTH='api';try{assert.equal((await make('claude').health()).available,false);await assert.rejects(()=>events(make('claude'),'hi'),{kind:'auth_required'});}finally{delete process.env.GATEWAY_FIXTURE_AUTH;}
});
test('Codex accepts only its exact verified disabled-host startup notice',async()=>{
  const e:any[]=await events(make('codex'),'ISOLATION_NOTICE');assert.equal(e.at(-1).type,'done');
});
test('Claude refuses managed policy before invoking hooks or helpers',async()=>{
  const mod=await import('../src/adapters/claude-policy.ts');
  const cwd=await mkdtemp(join(tmpdir(),'gateway-policy-test-'));const file=join(cwd,'managed-settings.json');
  try {await mod.verifyClaudePolicy(signal(),[file],async()=>false);await writeFile(file,'{"hooks":{"SessionStart":[]}}');
    await assert.rejects(()=>mod.verifyClaudePolicy(signal(),[file],async()=>false),{kind:'unsupported'});
    await assert.rejects(()=>mod.verifyClaudePolicy(signal(),[],async()=>true),{kind:'unsupported'});
  }finally{await rm(cwd,{recursive:true,force:true});}
});
for(const type of ['codex','claude'] as const){
  test(`${type} quota failure falls back through the router and releases leases`,async()=>{
    const p=make(type);p.priority=0;
    p.quota=async()=>({source:'unknown',observedAt:Date.now(),windows:[]});
    const backup=createProvider({id:'backup',type:'demo',models:['m'],priority:1000,demo:{text:'OK'}});
    const state=new State(':memory:');
    try {
      const router=new Router([p,backup],state,{probeTimeoutMs:10000});
      const result:any[]=await Array.fromAsync(router.run({...req('QUOTA'),model:'auto'} as any));
      assert.equal(result.filter(e=>e.type==='text').map(e=>e.text).join(''),'OK');
      assert.ok(result.some(e=>e.providerId==='backup'));
      assert.equal(state.getBlock(p.id,'m')?.kind,'quota_exhausted');
      assert.equal(state.status().leases.length,0);
    }finally{state.close();}
  });
  test(`${type} subscription path preserves literal system input and removes API credentials`,async()=>{
    const p=make(type); const key=type==='claude'?'ANTHROPIC_API_KEY':'OPENAI_API_KEY';
    const before=process.env[key];process.env[key]='fixture-paid-api-key';
    try {const e:any[]=await events(p,'SYSTEM_REPORT','Literal $(unsafe) "quoted"\nnext');
      assert.equal(e.filter(x=>x.type==='text').map(x=>x.text).join(''),'Literal $(unsafe) "quoted"\nnext');
      assert.equal(e.at(-1).type,'done');assert.equal((await p.health()).available,true);
    }finally{if(before===undefined)delete process.env[key];else process.env[key]=before;}
  });
  for(const [input,kind] of [['TOOL','unsupported'],['QUOTA','quota_exhausted'],['AUTH','auth_required'],['RATE','rate_limited'],['NO_RESULT','transient'],['TRAILING','transient'],['DIVERGE','transient'],['FAIL_AFTER_RESULT','transient']] as const){
    test(`${type} rejects ${input} without successful completion`,async()=>{
      const seen:any[]=[];await assert.rejects(async()=>{for await(const e of make(type).invoke(req(input) as any,signal()))seen.push(e);},{kind});
      assert.ok(seen.every(e=>e.type!=='done'));
    });
  }
  test(`${type} rejects history before process creation`,()=>{
    assert.throws(()=>make(type).validate({model:'m',stream:true,messages:[{role:'assistant',content:'old'},{role:'user',content:'hi'}]}),{kind:'unsupported'});
  });
  test(`${type} cancellation terminates the child`,async()=>{
    const c=new AbortController();const dir=await mkdtemp(join(tmpdir(),'gateway-cli-ready-'));const file=join(dir,'ready.json');process.env.GATEWAY_FIXTURE_READY=file;
    const pending=events(make(type),'WAIT',undefined,c.signal);pending.catch(()=>{});
    try {let ready:any;const until=Date.now()+10000;
      while(Date.now()<until){try{ready=JSON.parse(await readFile(file,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,20));}}
      assert.ok(ready,'inference subprocess must be running before cancellation');c.abort();await assert.rejects(()=>pending,{kind:'cancelled'});
      assert.throws(()=>process.kill(ready.pid,0),{code:'ESRCH'});await assert.rejects(()=>stat(ready.cwd),{code:'ENOENT'});
    }finally{c.abort();await pending.catch(()=>{});delete process.env.GATEWAY_FIXTURE_READY;await rm(dir,{recursive:true,force:true});}
  });
}
