import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {validateDefinition} from '../server/engine.js';

// Definition/document publication only: no instance creation, execution or HDA writes.
const base='http://127.0.0.1:43127';
const bundlePath=path.resolve('.validation/art-upgrade-verified.json');
const journalPath=path.resolve('.validation/art-upgrade-publication.json');
const bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));
const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const journal=fs.existsSync(journalPath)?JSON.parse(fs.readFileSync(journalPath,'utf8')):{bundleHash:digest(bundle),saveOperationId:randomUUID(),documents:{}};
assert.equal(journal.bundleHash,digest(bundle),'Publication bundle changed; inspect before starting another publication');
const persist=()=>fs.writeFileSync(journalPath,JSON.stringify(journal,null,2));
persist();
const client=new Client({name:'codex-flow-art-upgrade',version:'1.0.0'});
async function call(name:string,args:Record<string,unknown>={}){
 const response=await client.callTool({name,arguments:args});
 const value=JSON.parse((response.content as any[]).find(c=>c.type==='text')?.text||'null');
 if(response.isError)throw Error(name+': '+JSON.stringify(value));return value;
}
try{
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
 const tools=await client.listTools();assert.ok(tools.tools.some(t=>t.name==='workflow_output_write'),'Server still uses the previous build; restart manager before publishing');
 const schema=JSON.stringify(tools.tools.find(t=>t.name==='workflow_save')?.inputSchema);assert.ok(schema.includes('outputProperties')&&schema.includes('inputBindings')&&schema.includes('resources'));
 const original=await call('workflow_get',{workflowId:bundle.workflow.id});
 if(original.revision!==bundle.originalRevision){
  const {revision,updatedAt,...actual}=original;const {revision:_,updatedAt:__,...expected}=validateDefinition(bundle.workflow);
  assert.deepEqual(actual,expected,'Workflow changed since planning; do not overwrite');
  assert.equal(original.revision,bundle.originalRevision+1);assert.ok(journal.savedRevision,'Unexpected matching version without local publication receipt');
  console.log('Already published and verified v'+original.revision);process.exitCode=0;
 }else{
  validateDefinition(bundle.workflow);assert.equal(original.globalConstraints,bundle.workflow.globalConstraints);
  const beforeRuns=await(await fetch(base+'/api/runs')).json();journal.beforeRunsHash=digest(beforeRuns);persist();
  for(const d of bundle.documents){
   let current:any=null;try{current=await call('workflow_document_read',{path:d.path});}catch(e){if(d.expectedHash!==null)throw e;}
   const prior=journal.documents[d.path];
   if(current?.hash!==d.expectedHash&&!(current===null&&d.expectedHash===null))assert.ok(prior&&current?.content===d.content,'Document changed since read: '+d.path);
  }
  for(const d of bundle.documents){
   journal.documents[d.path]??={operationId:randomUUID()};persist();
   const saved=await call('workflow_document_write',{...d,operationId:journal.documents[d.path].operationId});
   journal.documents[d.path].hash=saved.hash;persist();
  }
  const saved=await call('workflow_save',{workflow:bundle.workflow,expectedRevision:bundle.originalRevision,operationId:journal.saveOperationId});journal.savedRevision=saved.revision;persist();
  const readback=await call('workflow_get',{workflowId:bundle.workflow.id});assert.deepEqual(readback,saved);
  const {revision,updatedAt,...actual}=readback;const {revision:_,updatedAt:__,...expected}=validateDefinition(bundle.workflow);assert.deepEqual(actual,expected);
  for(const d of bundle.documents){const current=await call('workflow_document_read',{path:d.path});assert.equal(current.content,d.content);}
  const afterRuns=await(await fetch(base+'/api/runs')).json();assert.deepEqual(afterRuns,beforeRuns,'Existing instances changed during publication');
  journal.verifiedAt=new Date().toISOString();journal.afterRunsHash=digest(afterRuns);persist();
  console.log(JSON.stringify({workflowId:saved.id,revision:saved.revision,documents:bundle.documents.length,existingInstancesUnchanged:beforeRuns.length,verifiedAt:journal.verifiedAt}));
 }
}finally{await client.close();}
