import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assert} from './engine.js';
import type {InstanceFile} from '../shared/types.js';

export const instanceFileLimit=256*1024*1024;
export function archiveFile(root:string,source:string):InstanceFile {
  if(/^https?:\/\//i.test(source))return {name:source,originalPath:source,status:'link'};
  if(!path.isAbsolute(source)||!fs.existsSync(source))return {name:path.basename(source),originalPath:source,status:'missing'};
  const stat=fs.statSync(source);if(!stat.isFile())return {name:path.basename(source),originalPath:source,status:'missing'};
  if(stat.size>instanceFileLimit)return {name:path.basename(source),originalPath:source,size:stat.size,status:'too_large'};
  // Copy first, then hash the copy so the hash always describes the archived bytes.
  const dir=path.join(root,'instance-files');fs.mkdirSync(dir,{recursive:true});const temp=path.join(dir,randomUUID()+'.tmp');
  try {fs.copyFileSync(source,temp);return archiveBytes(root,path.basename(source),fs.readFileSync(temp),source);}
  finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
export function archiveBytes(root:string,name:string,bytes:Buffer,originalPath?:string):InstanceFile {
  assert(bytes.length<=instanceFileLimit,'实例文件超过 256MB');
  const hash=createHash('sha256').update(bytes).digest('hex'),dir=path.join(root,'instance-files'),dest=path.join(dir,hash);
  fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(dest)){const temp=dest+'.'+randomUUID()+'.tmp';try{fs.writeFileSync(temp,bytes);fs.renameSync(temp,dest);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
  return {name:path.basename(name),originalPath,archivePath:dest,hash,size:bytes.length,status:'stored'};
}
export function readInstanceFile(root:string,file:InstanceFile){
  assert(file.status==='stored'&&file.hash&&/^[a-f0-9]{64}$/.test(file.hash),'文件没有归档副本',404);
  const p=path.join(root,'instance-files',file.hash);assert(fs.existsSync(p),'归档文件缺失',404);
  const bytes=fs.readFileSync(p);assert(createHash('sha256').update(bytes).digest('hex')===file.hash,'归档文件校验失败');return bytes;
}
