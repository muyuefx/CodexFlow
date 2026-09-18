import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeMcp} from '../server/mcp.js';
import {Store} from '../server/store.js';
import {seedDemo} from '../server/demo.js';

test('MCP 发现、只读声明、固定 AI 身份和 schema 均通过真实协议验证',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codexflow-mcp-'));const store=new Store(dir);seedDemo(store);
  const server=makeMcp(()=>store);const client=new Client({name:'test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{await server.connect(a);await client.connect(b);
    const tools=await client.listTools();assert.equal(tools.tools.length,17);
    assert.equal(tools.tools.find(t=>t.name==='workflow_context')?.annotations?.readOnlyHint,true);
    assert.equal(tools.tools.find(t=>t.name==='workflow_transition')?.annotations?.readOnlyHint,false);
    const list=await client.callTool({name:'workflow_list',arguments:{}});assert.equal(list.isError,undefined);
    const result=await client.callTool({name:'workflow_instance_create',arguments:{workflowId:'welcome',operationId:randomUUID()}});
    const prepared=JSON.parse((result.content as any[])[0].text);assert.equal(prepared.status,'prepared');
    const oldStart=await client.callTool({name:'workflow_start',arguments:{workflowId:'welcome',operationId:randomUUID()}});assert.equal(oldStart.isError,true);
    const activated=await client.callTool({name:'workflow_start',arguments:{runId:prepared.id,expectedRevision:prepared.revision,operationId:randomUUID()}});
    const run=JSON.parse((activated.content as any[])[0].text);assert.equal(run.status,'active');assert.equal(run.id,prepared.id);assert.equal(store.runs().length,1);
    const denied=await client.callTool({name:'workflow_transition',arguments:{runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action:'complete',nodeKey:'review',actor:'user',evidence:{summary:'试图伪造用户',checks:[],artifacts:[]}}});
    assert.equal(denied.isError,true);assert.notEqual(store.run(run.id).nodes.review.status,'completed');
    const invalid=await client.callTool({name:'workflow_save',arguments:{workflow:{id:'bad'},expectedRevision:0,operationId:randomUUID()}});assert.equal(invalid.isError,true);
    // 管理 API 的存储入口与 MCP 都必须拒绝长说明，且不静默截断或覆盖原版本。
    const workflow=store.workflow('welcome'),revision=workflow.revision;
    const originalMd=fs.readFileSync(workflow.graphs[0].nodes[0].mdPath,'utf8');
    for(const description of ['长'.repeat(61),'第一步\n第二步']){
      workflow.graphs[0].nodes[0].description=description;
      assert.throws(()=>store.saveWorkflow(workflow,revision,randomUUID()),/阶段说明/);
      const deniedSummary=await client.callTool({name:'workflow_save',arguments:{workflow,expectedRevision:revision,operationId:randomUUID()}});
      assert.equal(deniedSummary.isError,true);assert.equal(store.workflow('welcome').revision,revision);
    }
    workflow.graphs[0].nodes[0].description='简'.repeat(60);
    const validSummary=await client.callTool({name:'workflow_save',arguments:{workflow,expectedRevision:revision,operationId:randomUUID()}});
    assert.notEqual(validSummary.isError,true);assert.equal(store.workflow('welcome').graphs[0].nodes[0].description.length,60);
    assert.equal(fs.readFileSync(workflow.graphs[0].nodes[0].mdPath,'utf8'),originalMd);
    const generated=store.workflow('welcome');generated.globalConstraints='选择合适的 SOP 或 VEX 并检查性能';generated.graphs[0].nodes[0].properties=[{id:'count',label:'生成数量',type:'number',integer:true,min:1,defaultValue:3}];generated.graphs[0].nodes[0].inputValues={count:4};
    const withProperties=await client.callTool({name:'workflow_save',arguments:{workflow:generated,expectedRevision:generated.revision,operationId:randomUUID()}});assert.notEqual(withProperties.isError,true);
    const paramRun=await client.callTool({name:'workflow_instance_create',arguments:{workflowId:'welcome',operationId:randomUUID()}});const paramData=JSON.parse((paramRun.content as any[])[0].text);
    const context=await client.callTool({name:'workflow_context',arguments:{runId:paramData.id}});const contextData=JSON.parse((context.content as any[])[0].text);assert.equal(contextData.nodeInputs.brief.values.count,4);assert.equal(contextData.globalConstraints,generated.globalConstraints);assert.match(contextData.constraintInstruction,/全局约束/);
    const fetched=await client.callTool({name:'workflow_get',arguments:{workflowId:'welcome'}});assert.equal(JSON.parse((fetched.content as any[])[0].text).globalConstraints,generated.globalConstraints);
    const entry=await client.callTool({name:'workflow_data_write',arguments:{runId:paramData.id,expectedRevision:paramData.revision,operationId:randomUUID(),kind:'note',title:'任务编号',content:'task-1',actor:'user'}});assert.notEqual(entry.isError,true);assert.equal(JSON.parse((entry.content as any[])[0].text).dataEntries[0].actor,'ai');
    const instances=await client.callTool({name:'workflow_instances',arguments:{workflowId:'welcome'}});assert.ok(JSON.parse((instances.content as any[])[0].text).some((r:any)=>r.id===paramData.id&&r.dataCount===1));
    const oldContext=await client.callTool({name:'workflow_context',arguments:{runId:run.id}});assert.equal(JSON.parse((oldContext.content as any[])[0].text).globalConstraints,'');
    // Exercise the public MCP output path, including an actual immutable image asset, rather than reaching into Store.
    const pixel=path.join(dir,'pixel.png');fs.writeFileSync(pixel,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=','base64'));
    const outputFlow=store.workflow('welcome');outputFlow.graphs[0].nodes.find(n=>n.id==='brief')!.outputProperties=[{id:'image',label:'成果图',type:'image',required:true}];
    const outputSave=await client.callTool({name:'workflow_save',arguments:{workflow:outputFlow,expectedRevision:outputFlow.revision,operationId:randomUUID()}});assert.notEqual(outputSave.isError,true);
    const imageResult=await client.callTool({name:'workflow_image_import',arguments:{path:pixel,operationId:randomUUID()}});const image=JSON.parse((imageResult.content as any[])[0].text);
    const outputPrepared=await client.callTool({name:'workflow_instance_create',arguments:{workflowId:'welcome',operationId:randomUUID()}});const outputRun=JSON.parse((outputPrepared.content as any[])[0].text);
    const outputStarted=await client.callTool({name:'workflow_start',arguments:{runId:outputRun.id,expectedRevision:outputRun.revision,operationId:randomUUID()}});let outputState=JSON.parse((outputStarted.content as any[])[0].text);
    const entered=await client.callTool({name:'workflow_transition',arguments:{runId:outputState.id,expectedRevision:outputState.revision,operationId:randomUUID(),action:'enter',nodeKey:'brief'}});outputState=JSON.parse((entered.content as any[])[0].text);
    const written=await client.callTool({name:'workflow_output_write',arguments:{runId:outputState.id,nodeKey:'brief',values:{image:[image.id]},expectedRevision:outputState.revision,operationId:randomUUID()}});assert.notEqual(written.isError,true);assert.deepEqual(JSON.parse((written.content as any[])[0].text).nodes.brief.outputs.image,[image.id]);
  }finally{await client.close();await server.close();store.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('codexflow-mcp-'));fs.rmSync(dir,{recursive:true,force:true});}
});
