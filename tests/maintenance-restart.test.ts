import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../server/store.js';
import {seedDemo} from '../server/demo.js';

test('维护重启保留空闲实例原状态；有任务节点执行则拒绝',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'flow-maintenance-'));let store:Store|undefined=new Store(dir);
 try{
  seedDemo(store);let run=store.createInstance('welcome',randomUUID());run=store.command({runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action:'activate'},'ai');
  store.close();store=new Store(dir,{maintenanceRestart:true});assert.deepEqual(store.run(run.id),run);
  const key=Object.values(run.nodes).find(n=>n.status==='ready'&&!n.children.length)!.key;
  run=store.command({runId:run.id,expectedRevision:run.revision,operationId:randomUUID(),action:'enter',nodeKey:key},'ai');store.close();store=undefined;
  assert.throws(()=>new Store(dir,{maintenanceRestart:true}),/任务节点执行/);
  store=new Store(dir);assert.equal(store.run(run.id).status,'recovery');
 }finally{store?.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('flow-maintenance-'));fs.rmSync(dir,{recursive:true,force:true});}
});
