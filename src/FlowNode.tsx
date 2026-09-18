import { Handle, Position, type NodeProps } from '@xyflow/react';
import { FileText, Layers, ArrowUpRight, Check, UserRound, LoaderCircle, Circle, AlertCircle } from 'lucide-react';
import { statusLabels, type NodeDefinition, type NodeRun, type NodeStatus } from '../shared/types';
export function FlowNode({data,selected}:NodeProps) {
  const n=data.definition as NodeDefinition;const r=data.run as NodeRun|undefined;
  const status:NodeStatus=r?.status||'pending';
  const active=!!data.descendantActive || status==='running';
  const done=Number(data.done||0),total=Number(data.total||0);
  return <div className={`flow-node ${selected?'selected':''} ${active?'active':''} status-${status}`}>
    <Handle type="target" position={Position.Left}/>
    <div className="node-top"><span className={`node-icon ${n.kind}`} >{n.kind==='subflow'?<Layers size={18}/>:<FileText size={18}/>}</span><span className="node-type">{n.kind==='subflow'?'子流程':'执行阶段'}</span>{n.completion==='user_only'&&<UserRound size={13} className="muted"/>}<span className="node-index">{String(data.index).padStart(2,'0')}</span></div>
    <div className="node-title">{n.title}</div>
    <div className="node-file">{n.mdPath?n.mdPath.split(/[\\/]/).pop():'待关联 Markdown'}</div>
    {n.kind==='subflow'&&<div className="subflow-hint"><span>{total || Number(data.childCount||0)} 个阶段{r?` · ${done} 已完成`:''}</span><span>双击进入 <ArrowUpRight size={12}/></span></div>}
    <div className="node-bottom"><span className={`node-status ${active?'running':''}`}>{status==='completed'?<Check size={12}/>:active?<LoaderCircle size={12}/>:['failed','blocked','recovery'].includes(status)?<AlertCircle size={12}/>:<Circle size={9}/>} {r ? (active&&status!=='running'?'子阶段执行中':statusLabels[status]):n.completion==='user_only'?'人工验收':'尚未运行'}</span>{n.kind==='subflow'&&<div className="mini-progress"><i style={{width:`${total?done/total*100:0}%`}}/></div>}</div>
    <Handle type="source" position={Position.Right}/>
  </div>;
}
