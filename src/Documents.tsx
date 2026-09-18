import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { diffLines } from 'diff';
import { FileText, Folder, ArrowUp, Save, History, X, AlertTriangle } from 'lucide-react';
import { api, uuid, time } from './api';
import type { DocumentSnapshot } from '../shared/types';
export function Modal({title,children,onClose,wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}) {
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className={`modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={18}/></button></header>{children}</section></div>;
}
export function Diff({before,after}:{before:string;after:string}) {
  return <pre className="diff">{diffLines(before,after).map((part,i)=><span key={i} className={part.added?'added':part.removed?'removed':''}>{part.value}</span>)}</pre>;
}
export function RunDocument({snapshot,onError,onSaved}:{snapshot:DocumentSnapshot;onError:(s:string)=>void;onSaved:()=>void}) {
  const [source,setSource]=useState(false);
  return <><div className="snapshot-banner"><span>{source?'正在编辑磁盘文件，运行仍使用快照':'本次执行的冻结 MD 快照'}</span><button className="text-button" onClick={()=>setSource(!source)}>{source?'返回快照':'编辑原文件'}</button></div>{source?<DocumentEditor path={snapshot.path} onError={onError} onSaved={onSaved}/>:<div className="document-editor"><div className="document-path" title={snapshot.path}><FileText size={14}/><span>{snapshot.path}</span></div><CodeMirror value={snapshot.content} height="100%" theme="dark" extensions={[markdown()]} editable={false} basicSetup={{lineNumbers:true,foldGutter:false}}/></div>}</>;
}
export function FileBrowser({onClose,onChoose,initial}:{onClose:()=>void;onChoose:(p:string)=>void;initial:string}) {
  const [directory,setDirectory]=useState(initial);const [listing,setListing]=useState<any>();const [error,setError]=useState('');
  async function browse(p:string) {try {const value=await api('/browse?path='+encodeURIComponent(p));setListing(value);setDirectory(value.directory);setError('');}catch(e:any){setError(e.message);}}
  useEffect(()=>{void browse(initial);},[]);
  return <Modal title="选择 Markdown 文件" onClose={onClose}><form className="path-bar" onSubmit={e=>{e.preventDefault();void browse(directory);}}><input aria-label="目录路径" value={directory} onChange={e=>setDirectory(e.target.value)}/><button type="submit">打开</button></form><p className="hint">可以打开任何本地目录。仅列出文件夹和 Markdown。</p>{error&&<p className="error">{error}</p>}<div className="file-list">{listing&&<button onClick={()=>void browse(listing.parent)}><ArrowUp size={16}/>上一级</button>}{listing?.entries.map((e:any)=><button key={e.path} onClick={()=>e.directory?void browse(e.path):(onChoose(e.path),onClose())}>{e.directory?<Folder size={16}/>:<FileText size={16}/>}<span>{e.name}</span></button>)}</div></Modal>;
}
export function DocumentEditor({path,onError,onSaved}:{path:string;onError:(s:string)=>void;onSaved:()=>void}) {
  const [doc,setDoc]=useState<DocumentSnapshot>();const [content,setContent]=useState('');const [view,setView]=useState<'edit'|'preview'>('edit');
  const [dialog,setDialog]=useState<'save'|'history'|'conflict'|null>(null);const [history,setHistory]=useState<any[]>([]);const [external,setExternal]=useState<DocumentSnapshot|null>();
  const [loading,setLoading]=useState(false);const [missing,setMissing]=useState(false);const [saving,setSaving]=useState(false);
  const [externalNotice,setExternalNotice]=useState(false);
  const latest=useRef({doc,content});latest.current={doc,content};
  const cacheKey='codexflow-draft:'+path;
  function keepDraft(value:string,base=latest.current.doc){sessionStorage.setItem(cacheKey,JSON.stringify({format:1,content:value,base:base??null}));}
  useEffect(()=>{
    let alive=true;setLoading(true);setDoc(undefined);setMissing(false);
    const restore=(disk?:DocumentSnapshot)=>{
      const saved=sessionStorage.getItem(cacheKey);let draft:any;
      try{draft=saved?JSON.parse(saved):null;}catch{draft=null;}
      if(draft?.format===1){setDoc(draft.base??undefined);setContent(draft.content);setExternalNotice(draft.base?.hash!==disk?.hash);}
      else{setDoc(disk);setContent(saved??disk?.content??'');setExternalNotice(false);}
    };
    api<DocumentSnapshot>('/documents?path='+encodeURIComponent(path)).then(d=>{if(alive)restore(d);}).catch(e=>{if(alive){setMissing(e.status===404);restore();onError(e.message);}}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[path]);
  useEffect(()=>{
    const listener=(event:Event)=>{
      const changed=(event as CustomEvent).detail.path as string;
      if(changed.replaceAll('\\','/').toLowerCase()!==path.replaceAll('\\','/').toLowerCase())return;
      api<DocumentSnapshot>('/documents?path='+encodeURIComponent(path)).then(next=>{
        const current=latest.current;
        if(current.content===(current.doc?.content??'')){setDoc(next);setContent(next.content);setMissing(false);setExternalNotice(false);}
        else if(next.hash!==current.doc?.hash)setExternalNotice(true);
      }).catch(()=>{setMissing(true);setExternalNotice(true);});
    };
    window.addEventListener('codexflow-document',listener);return()=>window.removeEventListener('codexflow-document',listener);
  },[path]);
  async function save() {
    setSaving(true);
    try {const value=await api<DocumentSnapshot>('/documents',{path,content,expectedHash:doc?.hash??null,operationId:uuid()});setDoc(value);sessionStorage.removeItem(cacheKey);setDialog(null);setMissing(false);setExternalNotice(false);onSaved();}
    catch(e:any) {onError(e.message);if(e.status===409){setExternal(e.details?.current??null);setDialog('conflict');}}
    finally{setSaving(false);}
  }
  async function openHistory(){try{setHistory(await api('/documents/history?path='+encodeURIComponent(path)));setDialog('history');}catch(e:any){onError(e.message);}}
  if(!path)return <div className="empty-detail"><FileText size={28}/><h3>给阶段一份说明</h3><p>在“节点”中关联或新建 MD，AI 会在执行时读取它。</p></div>;
  return <div className="document-editor"><div className="document-path" title={path}><FileText size={14}/><span>{path}</span></div><div className="document-toolbar"><div className="segmented"><button className={view==='edit'?'selected':''} onClick={()=>setView('edit')}>编辑</button><button className={view==='preview'?'selected':''} onClick={()=>setView('preview')}>预览</button></div><button className="icon-button" title="历史版本" onClick={()=>void openHistory()}><History size={16}/></button><button className="small primary" disabled={loading||content===doc?.content} onClick={()=>setDialog('save')}><Save size={13}/>保存</button></div>
    {missing&&<p className="hint warning">文件尚不存在，保存将创建它。</p>}{externalNotice&&<p className="hint warning">磁盘文件已更新。当前草稿保留，保存时将对比版本。</p>}{content!==doc?.content&&!loading&&<p className="draft-label">草稿已保留在当前浏览器会话</p>}
    {loading?<p className="hint">正在读取…</p>:view==='edit'?<CodeMirror value={content} height="100%" theme="dark" extensions={[markdown()]} onChange={v=>{setContent(v);keepDraft(v);}} basicSetup={{lineNumbers:true,foldGutter:false}}/>:<div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:({alt})=><span>[图片：{alt}]</span>}}>{content}</ReactMarkdown></div>}
    {dialog==='save'&&<Modal title="保存到原文件" wide onClose={()=>setDialog(null)}><p className="path-label">{path}</p><p className="hint">下方显示本次修改。已有版本会保存在历史中；正在运行的流程仍使用原快照。</p><Diff before={doc?.content||''} after={content}/><footer><button onClick={()=>setDialog(null)}>返回编辑</button><button className="primary" disabled={saving} onClick={()=>void save()}>{saving?'保存中…':'保存修改'}</button></footer></Modal>}
    {dialog==='conflict'&&<Modal title="文件在外部发生了变化" wide onClose={()=>setDialog(null)}><p className="hint"><AlertTriangle size={16}/> 两份内容已保存到历史。以下对比磁盘版本与当前草稿。</p><Diff before={external?.content||''} after={content}/><footer><button onClick={()=>{setDoc(external||undefined);setContent(external?.content||'');sessionStorage.removeItem(cacheKey);setExternalNotice(false);setDialog(null);}}>使用磁盘版本</button><button className="primary" onClick={()=>{setDoc(external||undefined);keepDraft(content,external||undefined);setDialog('save');}}>保留草稿并重新确认</button></footer></Modal>}
    {dialog==='history'&&<Modal title="文档历史" onClose={()=>setDialog(null)}><p className="hint">选择历史内容放入编辑器，查看差异后才能写回。</p><div className="file-list">{history.length?history.map(h=><button key={h.id} onClick={()=>{setContent(h.content);keepDraft(h.content);setDialog(null);}}><History size={15}/><span>{time(h.time)} <small>{h.source}</small></span></button>):<p className="hint">尚无保存历史</p>}</div></Modal>}
  </div>;
}
