import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProvider } from '../src/adapters/index.ts';
import { openAIStream, httpError } from '../src/adapters/http.ts';
import type { ChatRequest, Provider } from '../src/types.ts';
const signal = () => new AbortController().signal;
const request: ChatRequest = {model:'m',messages:[{role:'user',content:'hi'}],stream:true};
async function events(p: Provider,req=request,s=signal()){return await Array.fromAsync(p.invoke(req,s));}
test('demo emits configured text and manually configured quota',async()=>{
const p=createProvider({id:'d',type:'demo',models:['m'],demo:{text:'hello',remaining:4}});
assert.equal(p.enabled,true);
assert.deepEqual(await events(p),[{type:'text',text:'hello'},{type:'done',finishReason:'stop'}]);
assert.equal((await p.quota('m',signal())).windows[0].remaining,4);});
test('real providers require explicit enable and verified billing',async()=>{
for(const type of ['ark','claude','codex','codebuddy','antigravity']){
const p=createProvider({id:type,type,models:['m']});assert.equal(p.enabled,false);
assert.equal((await p.health()).available,false);await assert.rejects(()=>events(p),{kind:'unsupported'});}});
test('Ark refuses generic billed endpoint',()=>assert.throws(()=>createProvider({id:'a',type:'ark',models:['m'],baseUrl:'https://ark.cn-beijing.volces.com/api/v3'}),{kind:'unsupported'}));
test('Claude rejects developer and history before spawning',async()=>{
const p=createProvider({id:'c',type:'claude',models:['m'],enabled:true,billingVerified:true,command:'missing-command'});
await assert.rejects(()=>events(p,{...request,messages:[{role:'developer',content:'rules'},...request.messages]}),{kind:'unsupported'});
await assert.rejects(()=>events(p,{...request,messages:[...request.messages,{role:'assistant',content:'old'},...request.messages]}),{kind:'unsupported'});});
test('aborted demo classifies cancellation',async()=>{const c=new AbortController();c.abort();await assert.rejects(()=>events(createProvider({id:'d',type:'demo',models:['m']}),request,c.signal),{kind:'cancelled'});});
test('SSE preserves byte-fragmented UTF8 CRLF usage and terminal marker',async()=>{
const server=createServer((_q,r)=>{r.writeHead(200,{'content-type':'text/event-stream'});const body=':ping\r\n\r\ndata: {"choices":[{"delta":{"content":"你"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';for(const byte of Buffer.from(body))r.write(Buffer.from([byte]));r.end();});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const a=server.address() as any;assert.deepEqual(await Array.fromAsync(openAIStream(await fetch('http://127.0.0.1:'+a.port),signal())),[{type:'text',text:'你'},{type:'done',finishReason:'stop',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}]);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
test('HTTP auth quota rate limits classified with retry timestamp',async()=>{
assert.equal((await httpError(new Response('bad',{status:401}),'p')).kind,'auth_required');
assert.equal((await httpError(new Response('{"error":{"code":"insufficient_quota"}}',{status:429}),'p')).kind,'quota_exhausted');
const e=await httpError(new Response('limit',{status:429,headers:{'retry-after':'10'}}),'p');assert.equal(e.kind,'rate_limited');assert.ok(e.retryAt>Date.now());});
test('SSE incomplete stream is transient',async()=>{await assert.rejects(()=>Array.fromAsync(openAIStream(new Response('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),signal())),{kind:'transient'});});

import { fileURLToPath } from 'node:url';
const fixture=fileURLToPath(new URL('./fixtures/claude.mjs',import.meta.url));
test('Claude official subprocess flags preserve system separately and stdin user text',async()=>{
const p=createProvider({id:'c',type:'claude',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
assert.equal((await p.health()).available,true);
const e=await events(p,{...request,messages:[{role:'system',content:'rules'}, {role:'user',content:'Hello $(unsafe)'}]});
assert.equal(e[0].text,'Hello $(unsafe)');assert.equal(e.at(-1).usage.total_tokens,3);});
test('subprocess cancellation terminates child and classifies cancelled',async()=>{
const p=createProvider({id:'c',type:'claude',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
const c=new AbortController();const pending=events(p,{...request,messages:[{role:'user',content:'WAIT'}]},c.signal);
setTimeout(()=>c.abort(),150);await assert.rejects(()=>pending,{kind:'cancelled'});});
test('SSE read cancellation releases pending body',async()=>{
const c=new AbortController();const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': waiting\n'));}});
const pending=Array.fromAsync(openAIStream(new Response(stream),c.signal));setTimeout(()=>c.abort(),10);await assert.rejects(()=>pending,{kind:'cancelled'});});

import {responsesBody,responsesStream} from '../src/adapters/responses.ts';
test('SIWC Responses body preserves structured roles and disables storage/tools',()=>{
const req={...request,messages:[{role:'system',content:'rules'},{role:'developer',content:'more'},{role:'user',content:'old'},{role:'assistant',content:'reply'},...request.messages]};
assert.deepEqual(responsesBody(req),{model:'m',instructions:'rules',input:req.messages.slice(1),store:false,stream:true,tools:[],tool_choice:'none'});});
test('SIWC Responses parser emits text and completion with optional usage',async()=>{
const response=new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n');
assert.deepEqual(await Array.fromAsync(responsesStream(response,signal())),[{type:'text',text:'ok'},{type:'done',finishReason:'stop',usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}]);});
test('SIWC missing explicitly authorized access token fails authentication',async()=>{
const p=createProvider({id:'c',type:'codex',mode:'responses',tokenEnv:'GATEWAY_TEST_UNSET_TOKEN',models:['m'],enabled:true,billingVerified:true});
assert.equal(p.capabilities.history,true);await assert.rejects(()=>events(p),{kind:'auth_required'});});

test('Codex app-server reads official percentage quota without inference',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/codex.mjs',import.meta.url));
const p=createProvider({id:'c',type:'codex',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
const q=await p.quota('m',signal());assert.equal(q.source,'official');assert.equal(q.windows[0].usedPercent,25);assert.equal(q.windows[0].remaining,75);assert.equal(q.windows[0].resetAt,2000000000000);
await assert.rejects(()=>events(p),{kind:'unsupported'});});
test('SIWC Responses quota never substitutes app-server bucket',async()=>{
const p=createProvider({id:'c',type:'codex',mode:'responses',models:['m'],enabled:true,billingVerified:true});
assert.equal((await p.quota('m',signal())).source,'unknown');});

test('CLI nonzero exit after result cannot emit successful done',async()=>{
const p=createProvider({id:'c',type:'claude',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
const seen=[];await assert.rejects(async()=>{for await(const e of p.invoke({...request,messages:[{role:'user',content:'FAIL_AFTER_RESULT'}]},signal()))seen.push(e);},{kind:'transient'});assert.ok(seen.every(e=>e.type!=='done'));});
test('Responses repeated and mid-history system roles fail closed',()=>{
assert.throws(()=>responsesBody({...request,messages:[{role:'system',content:'first'},{role:'system',content:'second'},...request.messages]}),{kind:'unsupported'});
assert.throws(()=>responsesBody({...request,messages:[...request.messages,{role:'system',content:'late'}]}),{kind:'unsupported'});});

test('CodeBuddy CLI no-tools request preserves optional system and stdin user',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/codebuddy.mjs',import.meta.url));
const p=createProvider({id:'cb',type:'codebuddy',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
assert.equal(p.capabilities.system,true);assert.equal((await p.health()).available,true);
const e=await events(p,{...request,messages:[{role:'system',content:'rules'},...request.messages]});assert.equal(e[0].text,'hi');assert.equal(e.at(-1).type,'done');});
test('CodeBuddy selected text agent preserves literal system instruction and rejects future tools',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/codebuddy.mjs',import.meta.url));
const p=createProvider({id:'cb',type:'codebuddy',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
const rules='Literal instructions: $(echo unsafe) "quoted"';
const e=await events(p,{...request,messages:[{role:'system',content:rules},{role:'user',content:'SYSTEM_REPORT'}]});assert.equal(e[0].text,rules);
await assert.rejects(()=>events(p,{...request,messages:[{role:'user',content:'UNKNOWN_TOOL'}]}),{kind:'unsupported'});
});
test('CodeBuddy rejects historical role flattening before spawning',async()=>{
const p=createProvider({id:'cb',type:'codebuddy',models:['m'],enabled:true,billingVerified:true});
await assert.rejects(()=>events(p,{...request,messages:[{role:'assistant',content:'old'},...request.messages]}),{kind:'unsupported'});});
test('temporary directory cleanup recovers from a short Windows resource lock',async()=>{
const mod=await import('../src/adapters/subprocess.ts');assert.equal(typeof mod.cleanupTemporaryDirectory,'function');
let attempts=0;await mod.cleanupTemporaryDirectory('fixture',async()=>{if(++attempts<3)throw Object.assign(Error('locked'),{code:'EBUSY'});});assert.equal(attempts,3);
attempts=0;await assert.rejects(()=>mod.cleanupTemporaryDirectory('fixture',async()=>{attempts++;throw Object.assign(Error('denied'),{code:'EACCES'});}),{code:'EACCES'});assert.equal(attempts,1);
});

import {claudeHealth} from '../src/adapters/claude.ts';
import {codebuddyHealth} from '../src/adapters/codebuddy.ts';
const cliHealth:typeof claudeHealth=(config,signal)=>config.type==='codebuddy'?codebuddyHealth(config,signal):claudeHealth(config,signal);
test('Responses in-stream protocol errors classify quota rate limits and authentication',async()=>{
for(const [code,kind] of [['insufficient_quota','quota_exhausted'],['rate_limit_exceeded','rate_limited'],['invalid_api_key','auth_required']]){
for(const envelope of [{type:'error',code},{type:'response.failed',response:{error:{code}}}]){
await assert.rejects(()=>Array.fromAsync(responsesStream(new Response('data: '+JSON.stringify(envelope)+'\n\n'),signal())),{kind});
}}});
test('all CLI health paths reject runtime flags before process creation',async()=>{
for(const type of ['claude','codebuddy']){
await assert.rejects(()=>cliHealth({id:'c',type:type as any,models:['m'],command:'missing',args:['--print','live prompt']},signal()),{kind:'unsupported'});
}});
test('CLI bootstrap args accept only a single absolute JS entrypoint',async()=>{
for(const args of [['query'],[fixture,'query'],['relative.js']]){
await assert.rejects(()=>cliHealth({id:'c',type:'claude',models:['m'],command:process.execPath,args},signal()),{kind:'unsupported'});
}});

import {sse} from '../src/adapters/http.ts';
test('SSE bounds accumulated multiline frame bytes not just remaining line',async()=>{
const c=new AbortController();let cancelled=false;
const stream=new ReadableStream({start(controller){for(let i=0;i<1025;i++)controller.enqueue(new TextEncoder().encode('data: '+ 'x'.repeat(1024)+'\n'));},cancel(){cancelled=true;}});
const pending=Array.fromAsync(sse(new Response(stream),c.signal));setTimeout(()=>c.abort(),100);
await assert.rejects(()=>pending,{kind:'transient'});assert.equal(cancelled,true);});
test('HTTP error reads bounded bytes then cancels oversized body',async()=>{
let read=0;let cancelled=false;
const stream=new ReadableStream({pull(controller){if(read===100){controller.close();return;}read++;controller.enqueue(new Uint8Array(1024).fill(120));},cancel(){cancelled=true;}});
const result=await httpError(new Response(stream,{status:429}),'p');
assert.equal(result.kind,'rate_limited');assert.equal(cancelled,true);assert.ok(read<=10);});

test('provider pure preflight rejects CLI history and SIWC system placement without I/O',()=>{
for(const type of ['claude','codebuddy']){
const p=createProvider({id:'p',type,models:['m'],enabled:true,billingVerified:true,command:'missing'});
assert.equal(typeof p.validate,'function');p.validate(request);
assert.throws(()=>p.validate({...request,messages:[{role:'assistant',content:'old'},...request.messages]}),{kind:'unsupported'});}
const p=createProvider({id:'p',type:'codex',mode:'responses',models:['m'],enabled:true,billingVerified:true});
p.validate({...request,messages:[{role:'system',content:'leading'},...request.messages]});
assert.throws(()=>p.validate({...request,messages:[...request.messages,{role:'system',content:'late'}]}),{kind:'unsupported'});
createProvider({id:'a',type:'ark',models:['m']}).validate({...request,messages:[{role:'system',content:'s'},{role:'developer',content:'d'},...request.messages]});
});

import {processLines} from '../src/adapters/subprocess.ts';
import {tmpdir} from 'node:os';
test('subprocess rejects oversized newline-terminated lines',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/bounds.mjs',import.meta.url));
await assert.rejects(()=>Array.fromAsync(processLines(process.execPath,[fixture],'',tmpdir(),signal())),{kind:'transient'});});
test('CLI health bounds aggregate output across many short lines',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/bounds.mjs',import.meta.url));
const health=await cliHealth({id:'c',type:'claude',models:['m'],command:process.execPath,args:[fixture]},signal());
assert.equal(health.available,false);assert.match(health.detail,/limit/i);});

test('CLI invalid negative cache token counts omit usage',async()=>{
const fixture=fileURLToPath(new URL('./fixtures/codebuddy.mjs',import.meta.url));
const p=createProvider({id:'cb',type:'codebuddy',models:['m'],enabled:true,billingVerified:true,command:process.execPath,args:[fixture]});
const e=await events(p,{...request,messages:[{role:'user',content:'INVALID_USAGE'}]});assert.equal(e.at(-1).usage,undefined);});

import {validateBootstrap} from '../src/adapters/subprocess.ts';
test('CodeBuddy permits official absolute extensionless bin/codebuddy Node entrypoint',()=>{
const args=['C:/lumichy/codex/api_gateway/.tools/codebuddy/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'];
assert.doesNotThrow(()=>validateBootstrap({id:'cb',type:'codebuddy',models:['m'],command:process.execPath,args}));
assert.throws(()=>validateBootstrap({id:'c',type:'claude',models:['m'],command:process.execPath,args}),{kind:'unsupported'});
assert.throws(()=>validateBootstrap({id:'cb',type:'codebuddy',models:['m'],command:'powershell.exe',args}),{kind:'unsupported'});
});
