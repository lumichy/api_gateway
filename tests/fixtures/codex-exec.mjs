import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli 0.157.1');process.exit(0);}
if(args.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let body='';for await(const c of process.stdin)body+=c;
if(!args.includes('exec')||!args.includes('--ignore-user-config')||!args.includes('--ignore-rules')||!args.includes('--ephemeral')||!args.includes('--json')||process.env.OPENAI_API_KEY)process.exit(2);
const get=(key)=>args.find(a=>a.startsWith(key+'='));
if(get('features.shell_tool')!=='features.shell_tool=false'||get('features.code_mode_host')!=='features.code_mode_host=false'||get('tools.update_plan.enabled')!=='tools.update_plan.enabled=false')process.exit(2);
if(body==='SYSTEM_REPORT')body=await readFile(JSON.parse(get('model_instructions_file').split('=').slice(1).join('=')),'utf8');
const emit=e=>console.log(JSON.stringify(e));
emit({type:'thread.started',thread_id:'test'});
if(body==='ISOLATION_NOTICE')emit({type:'item.completed',item:{id:'notice',type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}});
emit({type:'turn.started'});
if(body==='WAIT'){if(process.env.GATEWAY_FIXTURE_READY)await writeFile(process.env.GATEWAY_FIXTURE_READY,JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{},1000);}
else if(['QUOTA','AUTH','RATE'].includes(body))emit({type:'turn.failed',error:{message:body==='QUOTA'?'usage limit exhausted':body==='AUTH'?'not logged in':'rate limit exceeded'}});
else if(body==='TOOL')emit({type:'item.started',item:{id:'t',type:'command_execution',command:'should never execute'}});
else if(body!=='NO_RESULT'){
 emit({type:'item.completed',item:{id:'a',type:'agent_message',text:body}});
 if(body==='DIVERGE')emit({type:'item.completed',item:{id:'b',type:'agent_message',text:'different'}});
 emit({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:2}});
 if(body==='TRAILING')emit({type:'turn.started'});
 if(body==='FAIL_AFTER_RESULT')process.exit(3);
}
