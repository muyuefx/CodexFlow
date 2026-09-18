import {z} from 'zod';

export const PropertyValueSchema=z.union([z.string().max(20000),z.number().finite(),z.boolean(),z.array(z.string().max(200)).max(20),z.null()]);
export type PropertyValue=z.infer<typeof PropertyValueSchema>;
export const PropertySchema=z.object({
  id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  label:z.string().min(1).max(60),
  type:z.enum(['text','textarea','number','boolean','select','image','resource','resources']),
  help:z.string().max(160).optional(),required:z.boolean().optional(),
  defaultValue:PropertyValueSchema.optional(),
  min:z.number().finite().optional(),max:z.number().finite().optional(),integer:z.boolean().optional(),
  options:z.array(z.object({value:z.string().min(1).max(100),label:z.string().min(1).max(100)})).max(100).optional(),
  resourceCategory:z.string().max(80).optional()
});
export type PropertyDefinition=z.infer<typeof PropertySchema>;
export const RepeatSchema=z.object({propertyId:z.string(),mode:z.enum(['parallel','sequential'])});
export type InputNode={properties?:PropertyDefinition[];inputValues?:Record<string,PropertyValue>;inputBindings?:Record<string,{nodeKey:string;outputId:string}>;repeat?:z.infer<typeof RepeatSchema>};
export const propertyTypeLabels:Record<PropertyDefinition['type'],string>={text:'短文字',textarea:'长文字',number:'数字',boolean:'开关',select:'选项',image:'图片',resource:'资源选择',resources:'多资源选择'};
export function inputValue(n:InputNode,p:PropertyDefinition):PropertyValue|undefined{
  return Object.hasOwn(n.inputValues||{},p.id)?n.inputValues![p.id]:p.defaultValue;
}
export function resolvedInputs(n:InputNode):Record<string,PropertyValue>{
  return Object.fromEntries((n.properties||[]).map(p=>[p.id,n.inputBindings?.[p.id]?null:inputValue(n,p)??null]));
}
export const isEmpty=(v:PropertyValue|undefined)=>v===undefined||v===null||(typeof v==='string'&&!v.trim())||(Array.isArray(v)&&!v.length);
export function valueError(p:PropertyDefinition,v:PropertyValue|undefined,requireFilled=false):string|undefined{
  if(isEmpty(v))return requireFilled&&p.required?`请填写「${p.label}」`:undefined;
  if(['text','textarea'].includes(p.type))return typeof v==='string'?undefined:'必须填写文字';
  if(p.type==='number')return typeof v!=='number'||!Number.isFinite(v)?'必须填写数字':p.integer&&!Number.isInteger(v)?'必须是整数':p.min!==undefined&&v<p.min?`不能小于 ${p.min}`:p.max!==undefined&&v>p.max?`不能大于 ${p.max}`:undefined;
  if(p.type==='boolean')return typeof v==='boolean'?undefined:'必须是开关值';
  if(p.type==='select')return typeof v==='string'&&p.options?.some(o=>o.value===v)?undefined:'请选择有效选项';
  if(p.type==='image')return Array.isArray(v)&&v.length<=20&&new Set(v).size===v.length&&v.every(id=>/^[a-f0-9]{64}$/.test(id))?undefined:'请选择最多 20 张不重复的已上传图片';
  if(p.type==='resources')return Array.isArray(v)&&v.length<=20&&new Set(v).size===v.length&&v.every(id=>/^[a-zA-Z0-9_-]{1,80}$/.test(id))?undefined:'请选择最多 20 个不重复的资源';
  return typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v)?undefined:'请选择资源库中的条目';
}
export function propertyErrors(n:InputNode,requireFilled=false):string[]{
  const errors:string[]=[],fields=n.properties||[],ids=new Set(fields.map(p=>p.id));
  if(ids.size!==fields.length)errors.push('属性标识不能重复');
  for(const key of Object.keys(n.inputValues||{}))if(!ids.has(key))errors.push('填写值引用了不存在的属性：'+key);
  for(const p of fields){
    if(['__proto__','constructor','prototype'].includes(p.id))errors.push('属性标识不可使用保留名称');
    if(p.min!==undefined&&p.max!==undefined&&p.min>p.max)errors.push(p.label+'：最小值不能大于最大值');
    if(p.type==='select'&&(!p.options?.length||new Set(p.options.map(o=>o.value)).size!==p.options.length))errors.push(p.label+'：需要不重复的选项');
    for(const [label,value] of [['默认值',p.defaultValue],['填写值',inputValue(n,p)]] as const){const e=valueError(p,value,label==='填写值'&&requireFilled&&!n.inputBindings?.[p.id]);if(e)errors.push(`${p.label} ${label}：${e}`);}
  }
  if(n.repeat){const p=fields.find(p=>p.id===n.repeat!.propertyId),v=p&&inputValue(n,p);if(!p||p.type!=='number'||p.integer!==true)errors.push('批量子流程需要绑定整数属性');
    if(n.inputBindings?.[n.repeat.propertyId])errors.push('实例数量不能绑定运行后产生的输出');
    if(!isEmpty(v)&&(typeof v!=='number'||!Number.isInteger(v)||v<1||v>100))errors.push('子流程实例数量必须是 1–100 的整数');
    if(requireFilled&&isEmpty(v))errors.push('请填写子流程实例数量');
  }
  return errors;
}
export function repeatCount(n:InputNode){if(!n.repeat)return 1;const p=n.properties?.find(p=>p.id===n.repeat!.propertyId);const v=p&&inputValue(n,p);return typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=100?v:1;}

export const ResourceSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),title:z.string().min(1).max(160),category:z.string().max(80),description:z.string().max(4000),imageIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),mdPath:z.string().optional(),metadata:z.record(z.string().max(20000)).optional(),revision:z.number().int().nonnegative(),archived:z.boolean()});
export type LibraryResource=z.infer<typeof ResourceSchema>;
export interface ImageAsset{id:string;name:string;mime:string;path:string;size:number}
export interface InputSnapshots{assets:Record<string,ImageAsset>;resources:Record<string,LibraryResource>;documents?:Record<string,{path:string;hash:string;content:string}>}
