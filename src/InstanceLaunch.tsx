import {useState} from 'react';
import {Modal} from './Documents';
import {NodeProperties} from './NodeProperties';
import {api,time,uuid} from './api';
import {statusLabels,type WorkflowDefinition,type WorkflowRun,type InstanceCreateOptions} from '../shared/types';
import type {LibraryResource} from '../shared/properties';

export function CreateInstance({flow,resources,onClose,onCreated,onError}:{flow:WorkflowDefinition;resources:LibraryResource[];onClose:()=>void;onCreated:(run:WorkflowRun)=>void;onError:(message:string)=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(flow)),[name,setName]=useState(flow.title+' · '+new Date().toLocaleDateString('zh-CN')),[busy,setBusy]=useState(false);
 async function create(){setBusy(true);try{const inputs:InstanceCreateOptions['inputs']=Object.fromEntries(draft.graphs.map(g=>[g.id,Object.fromEntries(g.nodes.filter(n=>n.properties?.length).map(n=>[n.id,n.inputValues||{}]))]));
   const r=await api<WorkflowRun>('/runs',{workflowId:flow.id,expectedWorkflowRevision:flow.revision,name,inputs,operationId:uuid()});onCreated(r);
 }catch(e:any){onError(e.message);}finally{setBusy(false);}}
 return <Modal title="建立流程实例" wide onClose={onClose}><p className="hint">基于 {flow.title} · v{flow.revision} 建立独立实例，保存本次输入、文档和全局约束。建立后为“待执行”，不会启动 AI，也不会更改模板。</p><label>实例名称<input aria-label="实例名称" maxLength={160} disabled={busy} value={name} onChange={e=>setName(e.target.value)}/></label><div className="workflow-inputs">{draft.graphs.flatMap(g=>g.nodes.filter(n=>n.properties?.length).map(n=><section key={g.id+'/'+n.id}><h3>{g.title} / {n.title}</h3><NodeProperties node={n} valuesOnly readOnly={busy} resources={resources} onError={onError} onChange={changes=>setDraft(d=>({...d,graphs:d.graphs.map(x=>x.id===g.id?{...x,nodes:x.nodes.map(v=>v.id===n.id?{...v,inputValues:changes.inputValues}:v)}:x)}))}/></section>))}{!draft.graphs.some(g=>g.nodes.some(n=>n.properties?.length))&&<p className="hint">此模板没有可填写属性，将保存当前文档与约束快照。</p>}</div><footer><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy||!name.trim()} onClick={()=>void create()}>建立实例</button></footer></Modal>;
}

export function SelectInstance({runs,workflowId,onClose,onChoose,onCreate}:{runs:WorkflowRun[];workflowId:string;onClose:()=>void;onChoose:(run:WorkflowRun)=>void;onCreate:()=>void}){
 const available=runs.filter(r=>r.workflowId===workflowId&&!['completed','cancelled'].includes(r.status));
 const [id,setId]=useState(available[0]?.id||'');const selected=available.find(r=>r.id===id);
 return <Modal title="开始执行 · 选择已有实例" wide onClose={onClose}><p className="hint">选择已有实例，获取交给 Codex 的执行指令。不会建立新实例，也不会重新读取模板覆盖本次输入。</p><div className="execution-choices">{available.map(r=><label key={r.id}><input type="radio" name="execution-instance" checked={id===r.id} onChange={()=>setId(r.id)}/><span><strong>{r.instanceName||r.title}</strong><small>{statusLabels[r.status]} · {time(r.createdAt)} · 快照 v{r.definition.revision} · {Object.values(r.nodes).filter(n=>n.status==='completed').length}/{Object.keys(r.nodes).length} 已完成</small><code>{r.id}</code></span></label>)}</div>{!available.length&&<p className="hint">还没有可执行实例。先点“建立实例”，填写这次任务的数据。</p>}<footer><button onClick={onClose}>返回</button><button onClick={onCreate}>建立新实例</button><button className="primary" disabled={!selected} onClick={()=>selected&&onChoose(selected)}>使用此实例 · 获取执行指令</button></footer></Modal>;
}
