import { randomUUID } from 'node:crypto';
import {propertyErrors,resolvedInputs,repeatCount,valueError,type InputSnapshots} from '../shared/properties.js';
import {bindingErrors} from '../shared/output-bindings.js';
import { WorkflowSchema, type WorkflowDefinition, type WorkflowRun, type NodeRun, type NodeDefinition, type DocumentSnapshot, type RunCommand, type Actor } from '../shared/types.js';

export class DomainError extends Error {
  constructor(message: string, public statusCode = 400, public details?: unknown) { super(message); }
}
export function assert(value: unknown, message: string, status = 400): asserts value { if (!value) throw new DomainError(message, status); }
const now = () => new Date().toISOString();
export function validateDefinition(input: unknown): WorkflowDefinition {
  const parsed = WorkflowSchema.safeParse(input);
  if (!parsed.success) {
    const summaryError=parsed.error.issues.find(i=>i.path[0]==='globalConstraints'||(i.path[0]==='graphs' && i.path.at(-1)==='description'));
    throw new DomainError(summaryError?.message || '流程格式不正确', 400, parsed.error.flatten());
  }
  const def = parsed.data;
  const graphs = new Map(def.graphs.map(g => [g.id, g]));
  assert(graphs.size === def.graphs.length, '子流程 ID 重复');
  assert(graphs.has(def.rootGraphId), '根流程不存在');
  for (const graph of def.graphs) {
    const ids = new Set(graph.nodes.map(n => n.id));
    assert(ids.size === graph.nodes.length, '节点 ID 重复：' + graph.title);
    assert(new Set(graph.edges.map(e => e.id)).size === graph.edges.length, '连线 ID 重复');
    assert(new Set(graph.edges.map(e => e.source + '>' + e.target)).size === graph.edges.length, '存在重复连线');
    for (const edge of graph.edges) assert(ids.has(edge.source) && ids.has(edge.target), '连线指向不存在的节点');
    const visited = new Set<string>(); const visiting = new Set<string>();
    function walk(id: string) {
      assert(!visiting.has(id), '流程存在依赖环：' + graph.title);
      if (visited.has(id)) return;
      visiting.add(id);
      graph.edges.filter(e => e.source === id).forEach(e => walk(e.target));
      visiting.delete(id); visited.add(id);
    }
    graph.nodes.forEach(n => {
      walk(n.id);
      const errors=propertyErrors(n);assert(!errors.length,n.title+'：'+errors.join('；'));
      const outputErrors=propertyErrors({properties:n.outputProperties});assert(!outputErrors.length,n.title+' 输出：'+outputErrors.join('；'));
      assert(!n.repeat || n.kind==='subflow','只有子流程节点可以绑定实例数量');
      if (n.kind === 'subflow') assert(n.subflowId && graphs.has(n.subflowId), '子流程引用无效：' + n.title);
    });
  }
  function descend(id: string, path: string[]) {
    assert(!path.includes(id), '存在递归子流程引用');
    assert(path.length < 32, '子流程嵌套超过 32 层');
    graphs.get(id)!.nodes.filter(n => n.kind === 'subflow').forEach(n => descend(n.subflowId!, [...path, id]));
  }
  def.graphs.forEach(g => descend(g.id, []));
  const errors=bindingErrors(def);assert(!errors.length,errors.join('；'));
  return def;
}
export function expand(def: WorkflowDefinition): Record<string, NodeRun> {
  const nodes: Record<string, NodeRun> = {};
  function mount(graphId: string, parentKey?: string,instancePrefix?:string,iteration?:number,previous:string[]=[]) {
    const g = def.graphs.find(g => g.id === graphId)!;
    const prefix = instancePrefix ?? (parentKey ? parentKey + '/' : '');
    const mounted:string[]=[];
    for (const n of g.nodes) {
      const key = prefix + n.id;
      assert(Object.keys(nodes).length < 3000, '展开后的节点超过 3000 个');
      const deps=g.edges.filter(e => e.target === n.id).map(e => prefix + e.source);
      nodes[key] = { key, nodeId:n.id, graphId, parentKey, dependencies:deps.length?deps:previous, children:[], status:'pending', attempt:1,inputs:resolvedInputs(n),...(iteration?{iteration}:{}) };
      mounted.push(key);
      if (parentKey) nodes[parentKey].children.push(key);
      if (n.kind === 'subflow') {
        let prior:string[]=[];
        for(let i=1;i<=repeatCount(n);i++)prior=mount(n.subflowId!,key,n.repeat?key+'/'+i+'/':undefined,n.repeat?i:undefined,n.repeat?.mode==='sequential'?prior:[]);
      }
    }
    return mounted;
  }
  mount(def.rootGraphId); return nodes;
}
export function definitionOf(run: WorkflowRun, key: string): NodeDefinition {
  const n = run.nodes[key]; assert(n, '节点不存在：' + key, 404);
  return run.definition.graphs.find(g => g.id === n.graphId)!.nodes.find(x => x.id === n.nodeId)!;
}
export function resolveBoundInputs(run:WorkflowRun,key:string){
  const spec=definitionOf(run,key),node=run.nodes[key];
  const values={...node.inputs},sources:NonNullable<NodeRun['inputSources']>={},snapshots:InputSnapshots={assets:{},resources:{}};
  for(const [id,b] of Object.entries(spec.inputBindings||{})){
    const source=run.nodes[b.nodeKey],p=spec.properties!.find(p=>p.id===id)!;
    assert(source?.status==='completed','输入来源尚未完成：'+b.nodeKey);
    const value=source.outputs?.[b.outputId];assert(value!==undefined,'上游输出缺失：'+b.nodeKey+'/'+b.outputId);
    const error=valueError(p,value,true);assert(!error,p.label+'：'+error);
    values[id]=structuredClone(value);
    sources[id]={nodeKey:b.nodeKey,outputId:b.outputId,attempt:source.attempt,workflowRevision:source.outputRevision??run.definition.revision};
    Object.assign(snapshots.assets,source.outputSnapshots?.assets);Object.assign(snapshots.resources,source.outputSnapshots?.resources);
    snapshots.documents={...snapshots.documents,...source.outputSnapshots?.documents};
  }
  return {values,sources,snapshots};
}
export function refresh(run: WorkflowRun) {
  for (const n of Object.values(run.nodes)) {
    if (!['pending','ready'].includes(n.status)) continue;
    const enabled = !n.parentKey || run.nodes[n.parentKey].status === 'running';
    const depsReady = n.dependencies.every(k => run.nodes[k]?.status === 'completed');
    n.status = enabled && depsReady ? 'ready' : 'pending';
  }
}
export function event(run: WorkflowRun, actor: Actor, action: string, nodeKey?: string, detail?: unknown) {
  run.events.push({id:randomUUID(), time:now(), actor, action, nodeKey, detail});
  run.updatedAt = now();
}
export function createRun(def: WorkflowDefinition, documents: Record<string, DocumentSnapshot>, threadId?: string): WorkflowRun {
  const nodes = expand(def);
  assert(Object.keys(nodes).length > 0, '流程没有节点');
  for (const n of Object.values(nodes)) {
    const spec = def.graphs.find(g => g.id === n.graphId)!.nodes.find(x => x.id === n.nodeId)!;
    assert(spec.kind !== 'task' || spec.mdPath.trim(), '普通节点必须关联 MD：' + spec.title);
    assert(spec.kind !== 'subflow' || n.children.length, '子流程不能为空：' + spec.title);
    assert(spec.criteria.length > 0, '请设置完成条件：' + spec.title);
    const errors=propertyErrors(spec,true);assert(!errors.length,spec.title+'：'+errors.join('；'));
  }
  const run: WorkflowRun = { id:randomUUID(), workflowId:def.id, title:def.title, revision:1, status:'prepared', createdAt:now(), updatedAt:now(), definition:structuredClone(def), documents, nodes, events:[], threadId };
  refresh(run); event(run,'system','create'); return run;
}
// Invalidate descendants and consumers, but preserve independent siblings inside a parent.
export function affectedKeys(nodes: Record<string, NodeRun>, initial: string[], descendSeeds=true): string[] {
  const set = new Set<string>(); const queue = initial.map(k => ({k, descend:descendSeeds}));
  const descended = new Set<string>();
  while (queue.length) {
    const {k,descend} = queue.shift()!; const n = nodes[k]; if (!n) continue;
    if (descend && !descended.has(k)) { descended.add(k); n.children.forEach(c => queue.push({k:c,descend:true})); }
    if (set.has(k)) continue;
    set.add(k);
    if (n.parentKey) queue.push({k:n.parentKey,descend:false});
    Object.values(nodes).filter(x => x.dependencies.includes(k)).forEach(x => queue.push({k:x.key,descend:true}));
  }
  return [...set];
}
function resetNode(n: NodeRun, reason: string): NodeRun {
  const inputs={...n.inputs};for(const id of Object.keys(n.inputSources||{}))inputs[id]=null;
  return { key:n.key, nodeId:n.nodeId, graphId:n.graphId, parentKey:n.parentKey, dependencies:n.dependencies, children:n.children,inputs,iteration:n.iteration, status:'pending', attempt:n.attempt+1, reason };
}
export function changeImpact(run: WorkflowRun, def: WorkflowDefinition, documents: Record<string, DocumentSnapshot>,inputSnapshots?:InputSnapshots) {
  const candidate = expand(def);
  const signature = (d: WorkflowDefinition, n: NodeRun, docs: Record<string, DocumentSnapshot>,snap?:InputSnapshots) => {
    const spec = d.graphs.find(g => g.id === n.graphId)!.nodes.find(x => x.id === n.nodeId)!;
    return JSON.stringify({globalConstraints:d.globalConstraints||'',kind:spec.kind, description:spec.description, criteria:spec.criteria, completion:spec.completion, mdPath:spec.mdPath,
      references:spec.references, hashes:[spec.mdPath,...spec.references].filter(Boolean).map(p => docs[p]?.hash),
      dependencies:[...n.dependencies].sort(), parent:n.parentKey,inputBindings:spec.inputBindings,outputProperties:spec.outputProperties?.map(({label,help,...p})=>p)});
  };
  const added = Object.keys(candidate).filter(k => !run.nodes[k]);
  const removed = Object.keys(run.nodes).filter(k => !candidate[k]);
    const inputsSignature=(d:WorkflowDefinition,n:NodeRun,docs:Record<string,DocumentSnapshot>,s?:InputSnapshots)=>{const spec=d.graphs.find(g=>g.id===n.graphId)!.nodes.find(x=>x.id===n.nodeId)!;return JSON.stringify({values:resolvedInputs(spec),fields:(spec.properties||[]).map(p=>({id:p.id,type:p.type,required:!!p.required,min:p.min,max:p.max,integer:p.integer,options:p.options,resourceCategory:p.resourceCategory})),repeat:spec.repeat,resources:(spec.properties||[]).filter(p=>p.type==='resource'||p.type==='resources').flatMap(p=>{const v=resolvedInputs(spec)[p.id];return (Array.isArray(v)?v:[v]).map(id=>{const r=s?.resources[String(id)];return {resource:r,documentHash:r?.mdPath?docs[r.mdPath]?.hash:undefined};});})});};
  const changed = Object.keys(candidate).filter(k => run.nodes[k] && (signature(def,candidate[k],documents) !== signature(run.definition,run.nodes[k],run.documents)||inputsSignature(def,candidate[k],documents,inputSnapshots)!==inputsSignature(run.definition,run.nodes[k],run.documents,run.inputSnapshots)));
  const structural=Object.keys(candidate).filter(k=>run.nodes[k] && JSON.stringify([...candidate[k].children].sort())!==JSON.stringify([...run.nodes[k].children].sort()));
  const affected = new Set([...affectedKeys(run.nodes,[...changed,...removed]), ...affectedKeys(candidate,[...changed,...added]),...affectedKeys(run.nodes,structural,false),...affectedKeys(candidate,structural,false)]);
  return {added,removed,changed:[...new Set([...changed,...structural])],affected:[...affected], candidate};
}
export function transition(run: WorkflowRun, cmd: RunCommand, actor: Actor, target?: {def: WorkflowDefinition; documents: Record<string, DocumentSnapshot>;inputSnapshots?:InputSnapshots}) {
  assert(run.revision === cmd.expectedRevision, '状态已变化，请刷新后再操作', 409);
  assert(!['cancelled','completed'].includes(run.status), '此运行已结束');
  const n = cmd.nodeKey ? run.nodes[cmd.nodeKey] : undefined;
  const nodeActions = ['enter','complete','block','fail','wait','retry'];
  if (nodeActions.includes(cmd.action)) assert(n, '请选择节点');
  if (['enter','complete','block','fail','wait'].includes(cmd.action)) assert(['active','pause_requested'].includes(run.status), '运行已暂停或待恢复');
  switch (cmd.action) {
    case 'activate': {
      assert(actor==='ai','等待 Codex 接手后开始执行',403);
      assert(run.status==='prepared','只能开始待执行的实例，其他状态请读取上下文后继续或恢复');
      run.status='active';break;
    }
    case 'enter': {
      assert(run.status === 'active', '暂停请求已发出，请先确认暂停');
      assert(n!.status === 'ready', '节点尚不可执行');
      const spec = definitionOf(run,n!.key);
      if(Object.keys(spec.inputBindings||{}).length){const resolved=resolveBoundInputs(run,n!.key);n!.inputs=resolved.values;n!.inputSources=resolved.sources;n!.inputSnapshots=resolved.snapshots;}
      n!.status = spec.kind === 'task' && spec.completion === 'user_only' ? 'waiting' : 'running';
      n!.startedAt = now(); delete n!.reason; break;
    }
    case 'complete': {
      assert(['ready','running','waiting','blocked'].includes(n!.status), '当前节点不能完成');
      const spec = definitionOf(run,n!.key);
      assert(actor === 'user' || spec.completion !== 'user_only', '此节点必须由用户验收', 403);
      if(Object.keys(spec.inputBindings||{}).length){assert(n!.inputSources,'绑定输入必须先进入节点并冻结');resolveBoundInputs(run,n!.key);}
      for(const p of spec.outputProperties||[]){const error=valueError(p,n!.outputs?.[p.id],true);assert(!error,'输出 '+p.label+'：'+error);}
      assert(n!.children.every(k => run.nodes[k].status === 'completed'), '子流程尚未全部完成');
      assert(n!.dependencies.every(k => run.nodes[k].status === 'completed'), '前置节点尚未完成');
      assert(cmd.evidence?.summary.trim(), '请填写完成说明');
      if (actor === 'ai') {
        for (const c of spec.criteria) assert(cmd.evidence!.checks.some(x => x.criterion === c && x.passed && x.note.trim()), '缺少通过的完成检查：' + c);
      }
      n!.status='completed'; n!.evidence=cmd.evidence; n!.completedBy=actor; n!.completedAt=now(); delete n!.reason; break;
    }
    case 'block': case 'fail': case 'wait': {
      assert(['running','ready','waiting','blocked','failed'].includes(n!.status), '当前节点不能更新');
      assert(cmd.reason?.trim(), '请填写原因');
      n!.status = cmd.action === 'block' ? 'blocked' : cmd.action === 'fail' ? 'failed' : 'waiting';
      n!.reason=cmd.reason; break;
    }
    case 'retry': {
      assert(['active','paused'].includes(run.status), '请先恢复或确认暂停');
      const keys = affectedKeys(run.nodes,[n!.key]);
      assert(!keys.some(k => run.nodes[k].status === 'running') || (run.status === 'paused'), '受影响节点仍在执行，请先暂停');
      event(run,actor,'invalidate',n!.key,keys.map(k => structuredClone(run.nodes[k])));
      for (const k of keys) run.nodes[k]=resetNode(run.nodes[k],'重做后重新验证');
      break;
    }
    case 'pause': {
      assert(run.status === 'active', '当前运行无法请求暂停');
      run.status=Object.values(run.nodes).some(x => x.status === 'running') ? 'pause_requested' : 'paused'; break;
    }
    case 'ack_pause': {
      assert(['pause_requested','recovery'].includes(run.status), '没有待确认的暂停');
      assert(actor === 'ai' || cmd.confirmedStopped, '请确认相关执行已经停止');
      for (const x of Object.values(run.nodes)) if (x.status === 'running' && !x.children.length) { x.status='recovery'; x.reason='执行已停止，恢复后需重新进入节点'; }
      run.status='paused'; break;
    }
    case 'resume': {
      assert(['paused','recovery'].includes(run.status), '当前运行无法恢复');
      for (const x of Object.values(run.nodes)) if (x.status === 'recovery') x.status='pending';
      run.status='active'; break;
    }
    case 'cancel': run.status='cancelled'; break;
    case 'finish': {
      assert(actor === 'ai', '请让 Codex 汇总结果并结束流程');
      assert(run.status === 'active', '请先恢复流程');
      assert(Object.values(run.nodes).every(x => x.status === 'completed'), '还有未完成节点');
      assert(cmd.reason?.trim(), '请提交整体完成总结');
      run.summary=cmd.reason; run.status='completed'; break;
    }
    case 'apply': {
      assert(run.status === 'paused', '仅可在确认暂停后应用新版本');
      assert(target, '缺少新版本');
      assert(target.def.revision === cmd.targetWorkflowRevision, '流程版本已变化，请重新查看差异', 409);
      // Reuse startup validation for document/criteria/empty-subflow requirements.
      createRun(target.def,target.documents);
      const impact = changeImpact(run,target.def,target.documents,target.inputSnapshots);
      event(run,actor,'previous_version',undefined,{definition:run.definition,documents:run.documents,nodes:run.nodes,inputSnapshots:run.inputSnapshots});
      for (const [key, fresh] of Object.entries(impact.candidate)) {
        const old = run.nodes[key];
        impact.candidate[key] = old && !impact.affected.includes(key) ? {...old,...fresh,inputs:old.inputs,status:old.status,attempt:old.attempt,reason:old.reason,evidence:old.evidence,completedBy:old.completedBy,startedAt:old.startedAt,completedAt:old.completedAt} : old ? resetNode({...old,...fresh,attempt:old.attempt},'流程内容已更新') : fresh;
      }
      run.nodes=impact.candidate; run.definition=structuredClone(target.def); run.documents=target.documents; run.inputSnapshots=target.inputSnapshots;run.title=target.def.title; break;
    }
  }
  refresh(run); run.revision++;
  event(run,actor,cmd.action,cmd.nodeKey,{reason:cmd.reason,evidence:cmd.evidence});
  return run;
}
