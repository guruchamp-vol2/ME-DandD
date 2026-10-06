import fs from 'node:fs/promises';
import path from 'node:path';

const replacer = (_key,value) => value instanceof Map ? {kind:'Map',entries:[...value]} : value instanceof Set ? {kind:'Set',entries:[...value]} : value;
const reviver = (_key,value) => value?.kind==='Map' && Array.isArray(value.entries) ? new Map(value.entries) : value?.kind==='Set' && Array.isArray(value.entries) ? new Set(value.entries) : value;
export async function readState(file) {
  try {
    const state=JSON.parse(await fs.readFile(file,'utf8'),reviver);
    if (!(state.lobbies instanceof Map) || !(state.sessions instanceof Map)) throw new Error('Invalid lobby snapshot.');
    for(const lobby of state.lobbies.values()) lobby.users=new Map();
    return state;
  } catch(error) { if(error.code==='ENOENT')return null;throw error; }
}
export async function writeState(file,state) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file+'.tmp',JSON.stringify(state,replacer),{mode:0o600});
  await fs.rename(file+'.tmp',file);
}
export function validateCampaign(value) {
  if (!value || typeof value!=='object' || !Array.isArray(value.scenes) || !value.scenes.length || value.scenes.length>100) throw new Error('Campaign needs 1–100 scenes.');
  const text=(v,max) => typeof v==='string'?v.trim().slice(0,max):'';
  const ids=new Set();
  const scenes=value.scenes.map(s=>{
    const id=text(s.id,120);
    if(!id || ids.has(id))throw new Error('Scene IDs must be unique and nonempty.');ids.add(id);
    if(!Array.isArray(s.choices) || s.choices.length>30)throw new Error('Each scene needs a choices array (at most 30).');
    const choiceIds=new Set();
    return {id,title:text(s.title,120),content:text(s.content,4000),choices:s.choices.map(c=>{
      const id=text(c.id,120);if(!id || choiceIds.has(id))throw new Error('Choice IDs must be unique within each scene.');choiceIds.add(id);
      return {id,text:text(c.text,200),to:text(c.to,120)};
    })};
  });
  for(const s of scenes)for(const c of s.choices)if(!ids.has(c.to))throw new Error('Every choice must lead to an existing scene.');
  const currentSceneId=text(value.currentSceneId,120) || scenes[0].id;
  if(!ids.has(currentSceneId))throw new Error('Current scene does not exist.');
  return {title:text(value.title,120)||'Imported campaign',summary:text(value.summary,2000),scenes,currentSceneId,
    handouts:(Array.isArray(value.handouts)?value.handouts:[]).slice(0,100).map((h,i)=>({id:'h_'+i,title:text(h.title,120),content:text(h.content,4000)})),
    quests:(Array.isArray(value.quests)?value.quests:[]).slice(0,100).map((q,i)=>({id:'q_'+i,title:text(q.title,200),done:!!q.done})),notes:[],started:false};
}
