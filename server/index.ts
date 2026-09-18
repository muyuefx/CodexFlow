import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { watch } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { Store, atomicWrite } from './store.js';
import { assert } from './engine.js';
import { makeMcp } from './mcp.js';
import { seedDemo } from './demo.js';
import type { ServerResponse } from 'node:http';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const settingsDir=process.env.CODEX_FLOW_SETTINGS || path.join(process.env.LOCALAPPDATA || os.homedir(),'CodexFlow');
fs.mkdirSync(settingsDir,{recursive:true});
const settingsFile=path.join(settingsDir,'settings.json');
const lockFile=path.join(settingsDir,'server.lock');
if (fs.existsSync(lockFile)) {
  const pid=Number(fs.readFileSync(lockFile,'utf8'));
  let alive=false; try { process.kill(pid,0); alive=true; } catch {}
  if (alive) throw new Error('Codex Flow 已经在运行');
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile,String(process.pid),{flag:'wx'});
process.on('exit',()=>{ try { if (fs.readFileSync(lockFile,'utf8')===String(process.pid)) fs.unlinkSync(lockFile); } catch {} });
let settings=fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile,'utf8')) : {root:process.env.CODEX_FLOW_HOME || path.join(os.homedir(),'CodexWorkflows'),onboarded:false};
if (process.env.CODEX_FLOW_HOME) settings.root=process.env.CODEX_FLOW_HOME;
let store=new Store(settings.root,{maintenanceRestart:process.argv.includes('--maintenance-restart')}); seedDemo(store);
const port=Number(process.env.PORT || 43127);
const app=Fastify({logger:true,bodyLimit:16*1024*1024});
const clients=new Set<ServerResponse>();
const watcher=watch([],{ignoreInitial:true,awaitWriteFinish:{stabilityThreshold:120,pollInterval:40}});
let watched=new Set<string>();
let sequence=0;
function broadcast(data:unknown) { const frame=`id: ${++sequence}\ndata: ${JSON.stringify(data)}\n\n`; for (const client of clients) client.write(frame); }
function watchDocuments() {
  const next=new Set(store.workflows().flatMap(d=>d.graphs.flatMap(g=>g.nodes.flatMap(n=>[n.mdPath,...n.references].filter(Boolean).map(p=>path.normalize(p))))));
  for (const p of next) if (!watched.has(p)) watcher.add(p);
  for (const p of watched) if (!next.has(p)) void watcher.unwatch(p);
  watched=next;
}
function connectStore() { store.on('change',data=>{broadcast(data); if(data.type==='workflow') watchDocuments();}); watchDocuments(); }
connectStore();
watcher.on('all',(kind,file)=>{ if (['change','add','unlink'].includes(kind)) { if (kind!=='unlink') { try { const doc=store.readDocument(file);store.rememberDocument(doc,'external-observed'); } catch {} } broadcast({type:'document',path:file,kind}); } });
app.addHook('onRequest',async(request,reply)=>{
  const host=request.headers.host?.split(':')[0];
  if (!host || !['127.0.0.1','localhost'].includes(host)) return reply.code(403).send({error:'仅允许本机访问'});
  const origin=request.headers.origin;
  if (origin && ![`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(process.env.NODE_ENV==='development'?['http://127.0.0.1:5173']:[])].includes(origin)) return reply.code(403).send({error:'来源不被允许'});
});
app.setErrorHandler((err,request,reply)=>{
  const e=err as any;
  reply.code(e.statusCode || (e instanceof ZodError ? 400 : 500)).send({error:e.message,details:e.details});
});
app.get('/api/health',async()=>({app:'codex-flow',version:'1.0.0'}));
app.get('/api/meta',async()=>({root:store.root,onboarded:settings.onboarded,mcpUrl:`http://127.0.0.1:${port}/mcp`,defaultBrowse:os.homedir()}));
app.post('/api/setup',async request=>{
  const body=request.body as {root:string}; assert(path.isAbsolute(body.root),'请选择绝对目录');
  const root=path.resolve(body.root);
  if (root!==path.resolve(store.root)) {
    assert(!store.runs().some(r=>!['completed','cancelled'].includes(r.status)),'请先结束当前库的运行，再切换流程库');
    const next=new Store(root); seedDemo(next); store.removeAllListeners(); store.close(); store=next;connectStore();
  }
  settings={root,onboarded:true};atomicWrite(settingsFile,JSON.stringify(settings,null,2));broadcast({type:'library'});return settings;
});
app.get('/api/workflows',async()=>store.workflows());
app.post('/api/workflows',async request=>{const a=request.body as any;return store.saveWorkflow(a.workflow,a.expectedRevision,a.operationId);});
app.get('/api/workflows/:id',async request=>store.workflow((request.params as any).id));
app.get('/api/workflows/:id/export',async(request,reply)=>reply.header('Content-Disposition',`attachment; filename="${store.workflow((request.params as any).id).id}.json"`).send(store.workflow((request.params as any).id)));
app.get('/api/runs',async request=>store.runs((request.query as any).workflowId));
app.post('/api/runs',async request=>{const a=request.body as any;return store.createInstance(a.workflowId,a.operationId,a.threadId,{name:a.name,expectedWorkflowRevision:a.expectedWorkflowRevision,inputs:a.inputs});});
app.get('/api/runs/:id',async request=>store.run((request.params as any).id));
app.post('/api/runs/:id/data',async request=>{const a=request.body as any;return store.addData({...a,runId:(request.params as any).id},'user',a.uploads||[]);});
app.post('/api/runs/:id/outputs',async request=>store.writeOutputs({...request.body as any,runId:(request.params as any).id},'user'));
app.get('/api/runs/:id/export',async(request,reply)=>{const r=store.run((request.params as any).id);return reply.header('Content-Disposition',`attachment; filename="instance-${r.id}.json"`).send(r);});
app.get('/api/runs/:id/files/:entry/:index',async(request,reply)=>{const p=request.params as any,{file,bytes}=store.instanceFile(p.id,p.entry,Number(p.index));return reply.header('Content-Type','application/octet-stream').header('X-Content-Type-Options','nosniff').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`).send(bytes);});
app.get('/api/runs/:id/impact',async request=>store.impact((request.params as any).id,(request.query as any).nodeKey));
app.post('/api/commands',async request=>store.command(request.body,'user'));
app.get('/api/documents',async request=>store.readDocument((request.query as any).path));
app.post('/api/documents',async request=>{const a=request.body as any;return store.saveDocument(a.path,a.content,a.expectedHash,a.operationId);});
app.get('/api/documents/history',async request=>store.documentHistory((request.query as any).path));
app.get('/api/browse',async request=>store.browse((request.query as any).path || os.homedir()));
app.post('/api/images',async request=>{const a=request.body as any;return store.library.upload(a.name,a.base64,a.operationId);});
app.get('/api/images/:id',async(request,reply)=>{const {asset,bytes}=store.library.read((request.params as any).id);return reply.header('Content-Type',asset.mime).header('X-Content-Type-Options','nosniff').header('Cache-Control','private, max-age=31536000, immutable').send(bytes);});
app.get('/api/resources',async()=>store.library.list());
app.post('/api/resources',async request=>{const a=request.body as any;return store.library.save(a.resource,a.expectedRevision,a.operationId);});
app.get('/api/events',(request,reply)=>{
  reply.hijack(); const raw=reply.raw;
  raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  raw.write(`data: ${JSON.stringify({type:'connected'})}\n\n`); clients.add(raw);
  const timer=setInterval(()=>raw.write(': keepalive\n\n'),15000);
  raw.on('close',()=>{clearInterval(timer);clients.delete(raw);});
});
app.all('/mcp',async(request,reply)=>{
  const mcp=makeMcp(()=>store);
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  await mcp.connect(transport); reply.hijack();
  reply.raw.on('close',()=>{void transport.close();void mcp.close();});
  try { await transport.handleRequest(request.raw,reply.raw,request.body); }
  catch(e:any) { if (!reply.raw.headersSent) reply.raw.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message})); }
});
await app.register(staticPlugin,{root:path.join(appRoot,'dist'),prefix:'/'});
app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api') ? reply.code(404).send({error:'接口不存在'}) : reply.sendFile('index.html'));
const shutdown=async()=>{for(const c of clients)c.end();await watcher.close();await app.close();store.close();process.exit(0);};
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
await app.listen({host:'127.0.0.1',port});
