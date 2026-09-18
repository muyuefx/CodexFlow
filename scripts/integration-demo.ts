import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type {WorkflowDefinition,WorkflowRun,NodeDefinition} from '../shared/types.js';

const base='http://127.0.0.1:43127';
const statePath=path.resolve('logs/integration-state.json');
const mode=process.argv[2]||'prepare';
const client=new Client({name:'codex-flow-acceptance',version:'1.0.0'});
await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
async function call(name:string,args:Record<string,unknown>={}) {
  const result=await client.callTool({name,arguments:args});
  const text=(result.content as any[]).find(c=>c.type==='text')?.text;const value=JSON.parse(text);
  if(result.isError)throw new Error(value.error);return value;
}
let run:WorkflowRun;
async function current(){run=(await call('workflow_context',{runId:run.id})).run;return run;}
async function command(action:string,nodeKey?:string,extra:Record<string,unknown>={}){
  await current();run=await call('workflow_transition',{runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action,nodeKey,...extra});return run;
}
async function done(key:string){const n=run.nodes[key];const spec=run.definition.graphs.find(g=>g.id===n.graphId)!.nodes.find(x=>x.id===n.nodeId)!;return command('complete',key,{evidence:{summary:'已核对演示要求及实际输出',checks:spec.criteria.map(criterion=>({criterion,passed:true,note:'通过当前 MCP 返回状态与文档内容检查'})),artifacts:[spec.mdPath]}});}
const saveState=(extra={})=>{fs.mkdirSync(path.dirname(statePath),{recursive:true});fs.writeFileSync(statePath,JSON.stringify({runId:run.id,workflowId:run.workflowId,...extra},null,2));};
try {
  if(mode==='prepare'){
    const tools=await client.listTools();assert.equal(tools.tools.length,17);
    const meta=await(await fetch(base+'/api/meta')).json();
    const id='integration-'+Date.now(),folder=path.join(meta.root,'documents',id);
    const node=async(id:string,title:string,x:number,extra:Partial<NodeDefinition>={}):Promise<NodeDefinition>=>{
      const mdPath=path.join(folder,id+'.md');
      await call('workflow_document_write',{path:mdPath,content:`# ${title}\n\n本文件仅用于 Codex Flow 联动验收。\n\n检查节点要求和实际状态，完成后记录结果。\n\n## 完成条件\n\n- 演示检查通过\n`,expectedHash:null,operationId:randomUUID()});
      return{id,title,kind:'task',description:'联动验收示例',mdPath,references:[],criteria:['演示检查通过'],completion:'ai_or_user',position:{x,y:100},...extra};
    };
    const edge=(source:string,target:string)=>({id:source+'_'+target,source,target});
    const definition:WorkflowDefinition={schemaVersion:1,id,title:'联动验收 · 三级子流程',description:'真实 MCP 请求驱动，包含人工门禁、暂停改版与完成记录。',category:'联动演示',archived:false,revision:0,updatedAt:'',rootGraphId:'main',graphs:[
      {id:'main',title:'联动验收',nodes:[await node('brief','读取需求',40),await node('work','制作与验证',370,{kind:'subflow',subflowId:'work'}),await node('review','人工验收',700,{completion:'user_only'})],edges:[edge('brief','work'),edge('work','review')]},
      {id:'work',title:'制作与验证',nodes:[await node('build','生成产物',40),await node('quality','检查结果',370,{kind:'subflow',subflowId:'quality'})],edges:[edge('build','quality')]},
      {id:'quality',title:'检查结果',nodes:[await node('check','核对文档和状态',40)],edges:[]}
    ]};
    await call('workflow_save',{workflow:definition,expectedRevision:0,operationId:randomUUID()});
    run=await call('workflow_instance_create',{workflowId:id,operationId:randomUUID(),threadId:'codex-flow-integration-demo'});
    run=await call('workflow_start',{runId:run.id,expectedRevision:run.revision,operationId:randomUUID()});
    await command('enter','brief');await done('brief');
    await command('pause');assert.equal(run.status,'paused');
    const d=await call('workflow_get',{workflowId:id});d.graphs[1].nodes[0].description+='；补充一项暂停改版说明';
    await call('workflow_save',{workflow:d,expectedRevision:d.revision,operationId:randomUUID()});
    const impact=await call('workflow_impact',{runId:run.id});assert.ok(!impact.affected.includes('brief'));
    await command('apply',undefined,{targetWorkflowRevision:impact.targetWorkflowRevision,impactToken:impact.impactToken});assert.equal(run.nodes.brief.status,'completed');
    await command('resume');await command('enter','work');await command('enter','work/build');
    saveState({stage:'running',toolCount:tools.tools.length,checks:['MCP 工具发现','流程生成与 MD 写入','冻结快照','暂停与版本应用','父子流程执行']});
    console.log(JSON.stringify({runId:run.id,workflowId:id,status:run.status,active:'work/build'},null,2));
  }else{
    const state=JSON.parse(fs.readFileSync(statePath,'utf8'));run={id:state.runId} as WorkflowRun;await current();
    if(mode==='advance'){
      await done('work/build');await command('enter','work/quality');await command('enter','work/quality/check');await done('work/quality/check');await done('work/quality');await done('work');await command('enter','review');
      await assert.rejects(()=>done('review'),/必须由用户/);await current();saveState({...state,stage:'waiting-for-test-user'});
      console.log('人工验收节点已等待；MCP 的 AI 完成请求被正确拒绝。');
    }else if(mode==='finalize'){
      assert.equal(run.nodes.review.status,'completed','先通过浏览器测试人工完成');
      await command('finish',undefined,{reason:'联动验收通过：MCP 生成与执行、三级子流程、暂停改版、人工门禁和最终完成均已验证。人工节点由浏览器测试操作验证，不代表用户对真实项目的验收。'});
      saveState({...state,stage:'completed',completedAt:new Date().toISOString(),revision:run.revision,eventCount:run.events.length});console.log(JSON.stringify({status:run.status,revision:run.revision,eventCount:run.events.length},null,2));
    }else throw new Error('Unknown mode');
  }
}finally{await client.close();}
