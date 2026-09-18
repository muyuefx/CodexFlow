import {Modal} from './Documents';

export const performanceExample = '使用 Houdini PCG 时，应考虑节点图的计算性能、内存占用和维护成本。根据实际任务选择实现方式：原生 SOP 更快或更合适时优先使用原生 SOP；VEX 更快、更方便时使用 VEX，不固定偏向某一种。避免无必要的重复计算和过大的中间几何；关键耗时步骤结合实际数据检查，不凭猜测声称已优化。';

export function GlobalConstraints({value,revision,readOnly,busy,onChange,onSave,onClose}:{
  value:string;revision:number;readOnly:boolean;busy:boolean;onChange:(value:string)=>void;onSave:()=>void;onClose:()=>void;
}) {
  return <Modal title={readOnly?'本次运行 · 全局约束':'工作流 · 全局约束'} wide onClose={onClose}>
    <p className="hint">约束所有阶段，包括嵌套子流程和批量任务。AI 每阶段读取执行上下文时都会收到这些要求。</p>
    {readOnly?<p className="hint">当前显示运行冻结的 v{revision}。修改请返回流程设计；已有运行需暂停并应用新版后生效。</p>:<p className="hint">填写做事原则，例如性能、质量、工具选择或文件范围。保存会一并保存当前流程草稿；已有运行继续使用旧约束，暂停应用新版将使所有阶段重新验证。</p>}
    <label>全局约束<textarea className="constraints-text" aria-label="全局约束内容" rows={10} maxLength={20000} readOnly={readOnly} disabled={busy} value={value} onChange={e=>onChange(e.target.value)} placeholder="写下 AI 在整个工作流中都应遵守的要求，可每行一条。"/></label>
    <div className="constraints-meta"><small>{value.length} / 20000</small>{!readOnly&&<button disabled={busy||value.length+performanceExample.length+2>20000} onClick={()=>onChange([value,performanceExample].filter(Boolean).join('\n\n'))}>填入 SOP / VEX 性能示例</button>}</div>
    <footer><button onClick={onClose}>{readOnly?'关闭':'返回'}</button>{!readOnly&&<button className="primary" disabled={busy} onClick={onSave}>保存全局约束</button>}</footer>
  </Modal>;
}
