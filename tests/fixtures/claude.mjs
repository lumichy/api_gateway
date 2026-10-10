import fs from 'node:fs';
let body='';for await(const chunk of process.stdin)body+=chunk;
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('2.1.296 (Claude Code)');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:process.env.GATEWAY_FIXTURE_AUTH==='api'?'apiKey':'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'}));process.exit(0);}
if(!args.includes('--tools')||args[args.indexOf('--tools')+1]!==''||!args.includes('--safe-mode')||args.includes('--bare')||!args.includes('--strict-mcp-config')||process.env.ANTHROPIC_API_KEY)process.exit(2);
if(body==='SYSTEM_REPORT')body=args[args.indexOf('--system-prompt')+1];
if(['QUOTA','AUTH','RATE'].includes(body)){console.log(JSON.stringify({type:'system',subtype:'init',tools:[],apiKeySource:'none'}));console.log(JSON.stringify({type:'result',subtype:'error',is_error:true,result:body==='QUOTA'?'usage limit exhausted':body==='AUTH'?'not logged in':'rate limit exceeded'}));process.exit(0);}
if(body==='TOOL'){console.log(JSON.stringify({type:'system',tools:['Read']}));process.exit(0);}
if(body==='NO_RESULT'){console.log(JSON.stringify({type:'system',tools:[],apiKeySource:'none'}));process.exit(0);}
if(body==='WAIT'){console.log(JSON.stringify({type:'system',tools:[],apiKeySource:'none'}));if(process.env.GATEWAY_FIXTURE_READY)fs.writeFileSync(process.env.GATEWAY_FIXTURE_READY,JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{},1000);}
else {console.log(JSON.stringify({type:'system',tools:[],...(body==='INIT_NO_AUTH'?{}:{apiKeySource:body==='INIT_EMPTY_AUTH'?'':body==='INIT_PAID_AUTH'?'environment':'none'})}));
console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:body}}}));
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:body==='DIVERGE'?'different':body,usage:{input_tokens:1,output_tokens:2}}));if(body==='TRAILING')console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'after'}]}}));if(body==='FAIL_AFTER_RESULT')process.exit(3);}
