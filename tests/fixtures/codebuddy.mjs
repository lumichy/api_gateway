let body='';for await(const chunk of process.stdin)body+=chunk;const args=process.argv.slice(2);
if(args.includes('--version')){console.log('2.33.0');process.exit(0);}
if(!args.includes('--tools')||args[args.indexOf('--tools')+1]!==''||!args.includes('--strict-mcp-config')||!args.includes('--setting-sources')||args[args.indexOf('--setting-sources')+1]!==''||JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks!==true)process.exit(2);
const injected=['SendMessage','MessageColleague','SpeakInChannel','ChannelTasks','CreateColleague','CreateChannel','ListColleagues','ExitPlanMode'];
const agents=args.includes('--agents')?JSON.parse(args[args.indexOf('--agents')+1]):{};
const selected=agents[args[args.indexOf('--agent')+1]];
const denyIndex=args.indexOf('--disallowedTools');const denies=[];
for(let i=denyIndex+1;i<args.length&&!args[i].startsWith('--');i++)denies.push(args[i]);
let tools=selected&&Array.isArray(selected.tools)&&selected.tools.length===0&&Array.isArray(selected.mcpServers)&&selected.mcpServers.length===0?injected:['Read','Write',...injected];
tools=tools.filter(t=>!denies.includes(t));
console.log(JSON.stringify({type:'system',subtype:'init',tools:['Read','Write',...injected].filter(t=>!denies.includes(t))}));
if(body==='UNKNOWN_TOOL')tools.push('FutureTool');
console.log(JSON.stringify({type:'system',tools}));
if(body==='SYSTEM_REPORT')body=selected?.prompt;
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:body,...(body==='INVALID_USAGE'?{usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:-5}}:{})}));
