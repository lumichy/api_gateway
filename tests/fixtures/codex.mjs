import readline from 'node:readline';
const lines=readline.createInterface({input:process.stdin});
for await(const line of lines){const r=JSON.parse(line);
if(r.method==='initialize')console.log(JSON.stringify({id:r.id,result:{}}));
if(r.method==='account/rateLimits/read')console.log(JSON.stringify({id:r.id,result:{rateLimits:{limitId:'codex',primary:{usedPercent:25,resetsAt:2000000000},secondary:null}}}));
}
