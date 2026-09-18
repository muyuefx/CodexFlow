import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const c=new Client({name:'property-acceptance',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:43127/mcp')));
async function call(name:string,args:any={}){const r=await c.callTool({name,arguments:args});if(r.isError)throw Error(JSON.stringify(r.content));return JSON.parse((r.content as any[]).find(x=>x.type==='text').text);}
try{
 const list=await call('workflow_list');const match=list.runs.find((r:any)=>r.workflowId==='node-inputs-demo'&&['active','prepared'].includes(r.status));assert(match,'先在 UI 创建验收运行');let run=(await call('workflow_context',{runId:match.id})).run;
 if(run.status==='prepared')run=await call('workflow_start',{runId:run.id,expectedRevision:run.revision,operationId:randomUUID()});
 assert.equal(run.nodes.batch.inputs.count,4);assert.match(run.nodes.batch.inputs.goal,/^界面验收/);
 const folder=path.join(path.dirname(run.definition.graphs[0].nodes[0].mdPath),'acceptance',run.id);
 async function command(action:string,nodeKey?:string,extra:any={}){run=(await call('workflow_context',{runId:run.id})).run;run=await call('workflow_transition',{runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action,nodeKey,...extra});}
 async function write(name:string,content:string){const file=path.join(folder,name+'.md');if(!fs.existsSync(file))await call('workflow_document_write',{path:file,content,expectedHash:null,operationId:randomUUID()});const saved=await call('workflow_document_read',{path:file});assert.equal(saved.content,content);return file;}
 async function complete(key:string,artifact:string){await command('complete',key,{evidence:{summary:'已读取冻结输入并写出、回读本实例的独立摘要。此为软件功能验收，不是场景制作。',checks:[{criterion:'输入与结果已核对',passed:true,note:'目标、数量、图片 ID 和基准资源均来自冻结快照，实际摘要文件已回读一致。'}],artifacts:[artifact]}});}
 async function doItem(i:number){const key=`batch/${i}/work`;if(run.nodes[key].status==='completed')return;if(run.nodes[key].status==='ready')await command('enter',key);const file=await write('item-'+i,`# 第 ${i} 份输入摘要\n\n本文件仅为 Codex Flow 属性验收。\n\n${JSON.stringify({iteration:i,inputs:run.nodes.batch.inputs,resources:run.inputSnapshots.resources},null,2)}\n`);await complete(key,file);}
 if(process.argv[2]==='prepare'){
  const tools=await c.listTools();assert.equal(tools.tools.length,16);
  const imageId=run.nodes.batch.inputs.pictures[0],image=await c.callTool({name:'workflow_image_read',arguments:{id:imageId}});assert.ok((image.content as any[]).some(x=>x.type==='image'&&x.data));
  if(run.nodes.batch.status==='ready')await command('enter','batch');await doItem(1);await command('enter','batch/2/work');
  assert.equal(run.nodes['batch/3/work'].status,'pending');assert.equal(run.nodes.join,undefined);
  console.log(JSON.stringify({runId:run.id,first:run.nodes['batch/1/work'].status,second:run.nodes['batch/2/work'].status,third:run.nodes['batch/3/work'].status,inputs:run.nodes.batch.inputs}));
 }else{
  for(let i=1;i<=4;i++)await doItem(i);
  const summary=await write('summary','# 属性验收汇总\n\n四份独立输入摘要均已写出、回读检查；数量来自用户填写的 4，默认值仍为 3。图片和基准选择已冻结。\n');
  await complete('batch',summary);await command('enter','summary');await complete('summary',summary);await command('finish',undefined,{reason:'通用节点输入验收完成：自定义字段、图片上传、资源选择、数量 3→4、独立实例执行与汇合均验证。未执行实际场景生产。'});
  fs.writeFileSync('logs/property-acceptance.json',JSON.stringify({runId:run.id,status:run.status,count:run.nodes.batch.inputs.count,instances:run.nodes.batch.children,summary},null,2));
  console.log(JSON.stringify({runId:run.id,status:run.status,instances:run.nodes.batch.children.length,summary}));
 }
}finally{await c.close();}
