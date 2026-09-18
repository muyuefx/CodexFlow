import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assert,expand} from './engine.js';
import {ResourceSchema,resolvedInputs,isEmpty,valueError,type PropertyDefinition,type PropertyValue,type LibraryResource,type ImageAsset,type InputSnapshots} from '../shared/properties.js';
import type {WorkflowDefinition} from '../shared/types.js';
import type {Store} from './store.js';

const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const MAX_IMAGE_BYTES=10*1024*1024;
function imageType(b:Buffer){
  if(b.length>24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'png',mime:'image/png'};
  if(b.length>4&&b[0]===255&&b[1]===216&&b[2]===255)return {ext:'jpg',mime:'image/jpeg'};
  if(b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return {ext:'webp',mime:'image/webp'};
  if(b.length>10&&['GIF87a','GIF89a'].includes(b.toString('ascii',0,6)))return {ext:'gif',mime:'image/gif'};
  assert(false,'请选择 PNG、JPEG、WebP 或 GIF 图片');
}
export class InputLibrary{
  constructor(private store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS input_assets(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS input_resources(id TEXT PRIMARY KEY,json TEXT NOT NULL);');}
  upload(name:string,base64:string,operationId:string){
    assert(typeof name==='string'&&name.length<=240,'图片名称无效');
    assert(typeof base64==='string'&&base64.length<=Math.ceil(MAX_IMAGE_BYTES/3)*4&&/^[A-Za-z0-9+/]*={0,2}$/.test(base64),'图片超过 10MB 或编码无效');
    const bytes=Buffer.from(base64,'base64');assert(bytes.length>0&&bytes.length<=MAX_IMAGE_BYTES,'图片为空或超过 10MB');
    const type=imageType(bytes),id=digest(bytes);
    return this.store.idempotent('image',operationId,{name,id},()=>{
      const old=this.store.db.prepare('SELECT json FROM input_assets WHERE id=?').get(id) as {json:string}|undefined;
      if(old){this.read(id);return JSON.parse(old.json) as ImageAsset;}
      const directory=path.join(this.store.root,'images');fs.mkdirSync(directory,{recursive:true});
      const file=path.join(directory,id+'.'+type.ext);
      if(fs.existsSync(file))assert(digest(fs.readFileSync(file))===id,'图片存储发生冲突');else fs.writeFileSync(file,bytes,{flag:'wx'});
      const asset:ImageAsset={id,name:path.basename(name),mime:type.mime,path:file,size:bytes.length};
      this.store.db.prepare('INSERT INTO input_assets VALUES (?,?)').run(id,JSON.stringify(asset));return asset;
    });
  }
  importFile(file:string,operationId:string){assert(path.isAbsolute(file)&&fs.existsSync(file),'图片路径不存在');assert(fs.statSync(file).size<=MAX_IMAGE_BYTES,'图片超过 10MB');return this.upload(path.basename(file),fs.readFileSync(file).toString('base64'),operationId);}
  asset(id:string):ImageAsset{assert(/^[a-f0-9]{64}$/.test(id),'图片 ID 无效');const row=this.store.db.prepare('SELECT json FROM input_assets WHERE id=?').get(id) as {json:string}|undefined;assert(row,'图片不存在',404);return JSON.parse(row.json);}
  read(id:string){const asset=this.asset(id);assert(fs.existsSync(asset.path),'图片文件缺失：'+asset.name,404);const bytes=fs.readFileSync(asset.path);assert(digest(bytes)===id,'图片内容已被外部修改：'+asset.name);return {asset,bytes};}
  list():LibraryResource[]{return (this.store.db.prepare('SELECT json FROM input_resources').all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  resource(id:string):LibraryResource{const row=this.store.db.prepare('SELECT json FROM input_resources WHERE id=?').get(id) as {json:string}|undefined;assert(row,'资源不存在：'+id,404);return JSON.parse(row.json);}
  save(input:unknown,revision:number,operationId:string){const resource=ResourceSchema.parse(input);
    const result=this.store.idempotent('resource',operationId,{input,revision},()=>{
      const old=this.list().find(r=>r.id===resource.id);assert((old?.revision||0)===revision,'资源已被修改，请刷新',409);
      for(const id of resource.imageIds)this.read(id);if(resource.mdPath)this.store.readDocument(resource.mdPath);
      resource.revision=revision+1;this.store.db.prepare('INSERT OR REPLACE INTO input_resources VALUES (?,?)').run(resource.id,JSON.stringify(resource));return resource;
    });this.store.emit('change',{type:'resource',id:result.id});return result;
  }
  collect(def:WorkflowDefinition):InputSnapshots{
    const snapshot:InputSnapshots={assets:{},resources:{}};
    const addImage=(id:string)=>{snapshot.assets[id]=this.read(id).asset;};
    for(const instance of Object.values(expand(def))){const n=def.graphs.find(g=>g.id===instance.graphId)!.nodes.find(n=>n.id===instance.nodeId)!;const values=resolvedInputs(n);
      for(const p of n.properties||[]){const v=values[p.id];if(isEmpty(v))continue;
        if(p.type==='image')for(const id of v as string[])addImage(id);
        if(p.type==='resource'||p.type==='resources')for(const id of p.type==='resources'?v as string[]:[String(v)]){const r=this.resource(id);assert(!r.archived,'资源已归档：'+r.title);assert(!p.resourceCategory||p.resourceCategory===r.category,'资源分类不匹配：'+p.label);snapshot.resources[r.id]=r;r.imageIds.forEach(addImage);}
      }
    }
    return snapshot;
  }
  capture(fields:PropertyDefinition[],values:Record<string,PropertyValue>):InputSnapshots{
    const snapshot:InputSnapshots={assets:{},resources:{},documents:{}};
    for(const [id,v] of Object.entries(values)){
      const p=fields.find(p=>p.id===id);assert(p,'未声明的输出：'+id);const error=valueError(p,v,false);assert(!error,p.label+'：'+error);if(isEmpty(v))continue;
      const addImage=(id:string)=>{snapshot.assets[id]=this.read(id).asset;};
      if(p.type==='image')(v as string[]).forEach(addImage);
      if(p.type==='resource'||p.type==='resources')for(const resourceId of p.type==='resources'?v as string[]:[String(v)]){
        const resource=this.resource(resourceId);assert(!resource.archived,'资源已归档：'+resource.title);assert(!p.resourceCategory||resource.category===p.resourceCategory,'资源分类不匹配：'+p.label);
        snapshot.resources[resourceId]=resource;resource.imageIds.forEach(addImage);if(resource.mdPath)snapshot.documents![resource.mdPath]=this.store.readDocument(resource.mdPath);
      }
    }
    return snapshot;
  }
  usedSnapshots(fields:PropertyDefinition[],values:Record<string,PropertyValue>,all:InputSnapshots):InputSnapshots{
    const used:InputSnapshots={assets:{},resources:{},documents:{}};
    const addImage=(id:string)=>{if(all.assets[id])used.assets[id]=all.assets[id];};
    for(const p of fields){const v=values[p.id];if(isEmpty(v))continue;
      if(p.type==='image')(v as string[]).forEach(addImage);
      if(p.type==='resource'||p.type==='resources')for(const id of p.type==='resources'?v as string[]:[String(v)]){
        const r=all.resources[id];if(!r)continue;used.resources[id]=r;r.imageIds.forEach(addImage);
        if(r.mdPath&&all.documents?.[r.mdPath])used.documents![r.mdPath]=all.documents[r.mdPath];
      }
    }
    return used;
  }
}
