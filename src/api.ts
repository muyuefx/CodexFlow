export async function api<T=any>(url:string,body?:unknown):Promise<T> {
  const r=await fetch('/api'+url,body===undefined ? undefined : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error||'请求失败'),{status:r.status,details:data.details});
  return data;
}
export const uuid=()=>crypto.randomUUID();
export const time=(value?:string)=>value ? new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
