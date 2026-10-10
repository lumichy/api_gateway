import { loadConfig } from '../src/config.ts';
import { createProvider } from '../src/adapters/index.ts';
import { abortable } from '../src/errors.ts';
const i=process.argv.indexOf('--config');const file=i<0?'config.local.json':process.argv[i+1];
try{
 if(!file)throw new Error('--config requires a path');const config=await loadConfig(file);
 const providers=await Promise.all(config.providers.map(async entry=>{
  const provider=createProvider(entry);let health:{available:boolean;detail?:string}={available:false,detail:'Disabled'};
  if(provider.enabled){const signal=AbortSignal.timeout(5000);try{health=await abortable(provider.health(signal),signal);}catch{health={available:false,detail:'Health check failed or timed out'};}}
  return {id:entry.id,type:entry.type,models:entry.models,enabled:provider.enabled,billingVerified:entry.billingVerified,available:health.available,detail:health.detail,liveVerified:false,quotaTelemetry:entry.type==='codex'&&entry.mode!=='responses'?'app-server-only':entry.type==='demo'?'manual-demo':'unknown',capabilities:provider.capabilities};
 }));
 console.log(JSON.stringify({node:process.versions.node,host:config.host,port:config.port,demo:config.demoMode,credentials:{gatewayEnvironment:config.gatewayKeyEnv,adminEnvironment:config.adminKeyEnv},providers},null,2));
}catch(error){console.error(error instanceof Error?error.message:'Diagnostic failed');process.exitCode=1;}
