import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base='http://127.0.0.1:43127';
const client=new Client({name:'transport-check',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
async function call(name:string,args:Record<string,unknown>={}){const r=await client.callTool({name,arguments:args});const data=JSON.parse((r.content as any[])[0].text);if(r.isError)throw new Error(data.error);return data;}
const abort=new AbortController();
try{
  assert.equal((await fetch(base+'/api/health',{headers:{Origin:'https://untrusted.invalid'}})).status,403);
  const d=await call('workflow_get',{workflowId:'welcome'});d.id='transport-'+Date.now();d.title='传输自检';d.category='系统自检';d.revision=0;
  await call('workflow_save',{workflow:d,expectedRevision:0,operationId:randomUUID()});
  const sse=await fetch(base+'/api/events',{signal:abort.signal});assert.equal(sse.headers.get('content-type'),'text/event-stream');const reader=sse.body!.getReader();await reader.read();
  const began=performance.now();const starting=call('workflow_instance_create',{workflowId:d.id,operationId:randomUUID()});
  const frame=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE timeout')),1500);timer.unref();})]);
  const latencyMs=performance.now()-began;assert.ok(new TextDecoder().decode(frame.value).includes('"type":"run"'));assert.ok(latencyMs<1000);
  let r=await starting;assert.equal(r.status,'prepared');r=await call('workflow_start',{runId:r.id,expectedRevision:r.revision,operationId:randomUUID()});const mutate=async(action:string,extra:Record<string,unknown>={})=>r=await call('workflow_transition',{runId:r.id,expectedRevision:r.revision,operationId:randomUUID(),action,...extra});
  await mutate('pause');const impact=await call('workflow_impact',{runId:r.id});assert.ok(impact.impactToken);await mutate('apply',{targetWorkflowRevision:impact.targetWorkflowRevision,impactToken:impact.impactToken});await mutate('cancel');
  d.revision=1;d.archived=true;await call('workflow_save',{workflow:d,expectedRevision:1,operationId:randomUUID()});
  const report={originProtection:'passed',stream:'SSE',latencyMs:Number(latencyMs.toFixed(2)),mcp:'passed',pausedVersionApply:'passed',testWorkflowArchived:true,time:new Date().toISOString()};
  fs.writeFileSync('logs/transport-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{abort.abort();await client.close();}
