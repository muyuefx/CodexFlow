import test from 'node:test';
import assert from 'node:assert/strict';
import {editorShortcut,restoreEditorSnapshot} from '../shared/editor-history.js';
import type {WorkflowDefinition} from '../shared/types.js';

test('画布撤销、重做和删除快捷键不抢占文本输入或输入法',()=>{
 const key=(key:string,extra={})=>({key,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,...extra});
 assert.equal(editorShortcut(key('z',{ctrlKey:true}),false),'undo');
 assert.equal(editorShortcut(key('Z',{metaKey:true,shiftKey:true}),false),'redo');
 assert.equal(editorShortcut(key('y',{ctrlKey:true}),false),'redo');
 assert.equal(editorShortcut(key('Delete'),false),'delete');
 assert.equal(editorShortcut(key('Backspace'),false),'delete');
 assert.equal(editorShortcut(key('z',{ctrlKey:true}),true),undefined);
 assert.equal(editorShortcut(key('Delete'),true),undefined);
 assert.equal(editorShortcut(key('z',{ctrlKey:true,isComposing:true}),false),undefined);
});
test('保存后撤销恢复内容但保留最新 revision，快照互不污染',()=>{
 const old={id:'flow',revision:1,updatedAt:'old',graphs:[{id:'main',nodes:[],edges:[{id:'a_b',source:'a',target:'b'}]}]} as unknown as WorkflowDefinition;
 const current={...structuredClone(old),revision:2,updatedAt:'new',graphs:[{...old.graphs[0],edges:[]}]};
 const restored=restoreEditorSnapshot(current,old);
 assert.equal(restored.revision,2);assert.equal(restored.updatedAt,'new');assert.equal(restored.graphs[0].edges.length,1);
 restored.graphs[0].edges.length=0;assert.equal(old.graphs[0].edges.length,1);
 assert.throws(()=>restoreEditorSnapshot({...current,id:'other'},old),/其他流程/);
});
