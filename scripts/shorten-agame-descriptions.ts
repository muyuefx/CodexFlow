import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {agameSummaries} from './agame-summaries.js';
const hash=(p:string)=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const c=new Client({name:'codex-summary-editor',version:'1'});
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:43127/mcp')));
async function call(name:string,args:any={}){const r=await c.callTool({name,arguments:args});const v=JSON.parse((r.content as any[])[0].text);if(r.isError)throw Error(JSON.stringify(v));return v;}
try{
 const w=await call('workflow_get',{workflowId:'agame-scene-assets-baseline'}),original=structuredClone(w);
 const hashes:Record<string,string>={};let count=0;
 for(const g of w.graphs)for(const n of g.nodes){
  assert(agameSummaries[n.id],n.id);const md=fs.readFileSync(n.mdPath,'utf8');
  // 完整要求已在主要 MD，不能为了缩短界面文字丢掉执行要求。
  assert(md.includes(n.description)||n.description===agameSummaries[n.id],'阶段要求未保存在 MD：'+n.id);
  hashes[n.mdPath]=hash(n.mdPath);n.description=agameSummaries[n.id];count++;
 }
 const saved=await call('workflow_save',{workflow:w,expectedRevision:w.revision,operationId:randomUUID()});
 const reloaded=await call('workflow_get',{workflowId:w.id});assert.deepEqual(reloaded,saved);
 for(const [p,h] of Object.entries(hashes))assert.equal(hash(p),h);
 for(let i=0;i<w.graphs.length;i++)for(let j=0;j<w.graphs[i].nodes.length;j++){
  const changed={...reloaded.graphs[i].nodes[j],description:original.graphs[i].nodes[j].description};
  assert.deepEqual(changed,original.graphs[i].nodes[j]);
 }
 const previous=JSON.parse(fs.readFileSync('logs/agame-template-created.json','utf8'));
 for(const [p,h] of Object.entries(previous.sourceHashes))assert.equal(hash(p),h,'原 Skill 必须保持不变');
 console.log(JSON.stringify({updated:count,revision:saved.revision,maxLength:Math.max(...Object.values(agameSummaries).map(s=>s.length)),mdUnchanged:true,originalSkillUnchanged:true}));
}finally{await c.close();}
