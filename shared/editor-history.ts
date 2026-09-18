import type {WorkflowDefinition} from './types.js';

export function restoreEditorSnapshot(current:WorkflowDefinition,snapshot:WorkflowDefinition):WorkflowDefinition{
 if(current.id!==snapshot.id)throw Error('不能撤销其他流程的操作');
 // Content history must not roll back the server concurrency token after Save.
 return {...structuredClone(snapshot),revision:current.revision,updatedAt:current.updatedAt};
}
export function editorShortcut(event:{key:string;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;altKey:boolean;isComposing?:boolean},editingText:boolean):'undo'|'redo'|'delete'|undefined{
 if(editingText||event.isComposing||event.altKey)return;
 const key=event.key.toLowerCase(),command=event.ctrlKey||event.metaKey;
 if(command&&key==='z')return event.shiftKey?'redo':'undo';
 if(command&&key==='y')return 'redo';
 if(!command&&!event.shiftKey&&(key==='delete'||key==='backspace'))return 'delete';
}
