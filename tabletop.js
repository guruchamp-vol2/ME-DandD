import crypto from 'node:crypto';
export const CONDITIONS=['Blinded','Charmed','Deafened','Frightened','Grappled','Incapacitated','Invisible','Paralyzed','Petrified','Poisoned','Prone','Restrained','Stunned','Unconscious'];
export const NPC_PRESETS={
  Goblin:{name:'Goblin',hp:7,maxHp:7,ac:15,attack:4,damage:'1d6+2',init:2},
  Wolf:{name:'Wolf',hp:11,maxHp:11,ac:13,attack:4,damage:'2d4+2',init:2},
  Ogre:{name:'Ogre',hp:59,maxHp:59,ac:11,attack:6,damage:'2d8+4',init:-1},
  Bandit:{name:'Bandit',hp:11,maxHp:11,ac:12,attack:3,damage:'1d6+1',init:1}
};
export function integer(value,min,max,fallback=0){return Number.isFinite(Number(value))?Math.max(min,Math.min(max,Math.trunc(Number(value)))):fallback;}
export function ensureTabletop(lobby){
  lobby.tabletop ??= {npcs:new Map(),inventories:new Map(),conditions:new Map(),journal:[],gmNotes:'',combatLog:[]};
  const state=lobby.tabletop;
  for(const key of ['npcs','inventories','conditions'])if(!(state[key] instanceof Map))state[key]=new Map();
  for(const key of ['journal','combatLog'])if(!Array.isArray(state[key]))state[key]=[];
  return state;
}
export function publicTabletop(lobby){
  const state=ensureTabletop(lobby);
  return {npcs:Object.fromEntries(state.npcs),inventories:Object.fromEntries(state.inventories),conditions:Object.fromEntries(state.conditions),journal:state.journal.slice(-100),combatLog:state.combatLog.slice(-100),conditionList:CONDITIONS};
}
export function character(lobby,name){return lobby.characters.get(name) || ensureTabletop(lobby).npcs.get(name);}
export function canEdit(lobby,user,name,isGM){return isGM || user===name && lobby.characters.has(name);}
export function adjustHP(lobby,user,name,delta,isGM){
  const target=character(lobby,name);
  if(!target || !canEdit(lobby,user,name,isGM))throw Error('Only the owner or GM can change HP.');
  if(!Number.isInteger(delta) || Math.abs(delta)>1000)throw Error('Use a whole-number HP adjustment.');
  target.hp=Math.max(0,Math.min(target.maxHp,target.hp+delta));return target.hp;
}
export function inventoryAdd(lobby,user,name,item,isGM){
  if(!character(lobby,name) || !canEdit(lobby,user,name,isGM))throw Error('Only the owner or GM can change inventory.');
  if(!item || typeof item.name!=='string' || !item.name.trim())throw Error('Give the item a name.');
  const state=ensureTabletop(lobby),items=state.inventories.get(name) || [];
  if(items.length>=50)throw Error('Inventory is full (50 entries).');
  const entry={id:crypto.randomUUID(),name:item.name.trim().slice(0,80),quantity:integer(item.quantity,1,999,1),weight:integer(item.weight,0,999,0),notes:typeof item.notes==='string'?item.notes.slice(0,300):''};
  items.push(entry);state.inventories.set(name,items);return entry;
}
export function inventoryRemove(lobby,user,name,id,isGM){
  if(!canEdit(lobby,user,name,isGM))throw Error('Only the owner or GM can change inventory.');
  const state=ensureTabletop(lobby);const items=state.inventories.get(name) || [];
  if(!items.some(item=>item.id===id))throw Error('Item not found.');
  state.inventories.set(name,items.filter(item=>item.id!==id));
}
export function setCondition(lobby,user,name,condition,duration,isGM){
  if(!character(lobby,name) || !canEdit(lobby,user,name,isGM))throw Error('Only the owner or GM can change conditions.');
  if(!CONDITIONS.includes(condition))throw Error('Unknown condition.');
  const state=ensureTabletop(lobby),conditions=state.conditions.get(name) || [];
  const existing=conditions.find(c=>c.name===condition);
  if(existing)state.conditions.set(name,conditions.filter(c=>c.name!==condition));
  else {conditions.push({name:condition,remaining:duration==null || duration===''?null:integer(duration,1,100,1)});state.conditions.set(name,conditions);}
}
export function addNPC(lobby,preset,customName){
  const state=ensureTabletop(lobby);const template=NPC_PRESETS[preset];
  if(!template)throw Error('Unknown NPC preset.');if(state.npcs.size>=30)throw Error('NPC limit reached.');
  const base=typeof customName==='string' && customName.trim()?customName.trim().slice(0,24):template.name;
  let name=base,index=2;while(character(lobby,name))name=base.slice(0,18)+' '+index++;
  const npc={...template,name,npc:true};state.npcs.set(name,npc);return npc;
}
export function startEncounter(lobby,random=()=>crypto.randomInt(1,21)){
  const state=ensureTabletop(lobby);
  const combatants=[...lobby.characters.values(),...state.npcs.values()].filter(c=>c.hp>0);
  if(!combatants.length)throw Error('Add a character or NPC before starting an encounter.');
  const order=combatants.map(c=>({name:c.name,init:random()+(c.npc?c.init:Math.floor(((c.abilities?.DEX || 10)-10)/2))})).sort((a,b)=>b.init-a.init || a.name.localeCompare(b.name));
  lobby.encounter={active:true,order,turnIndex:0,round:1,turnSerial:1,acted:false};return lobby.encounter;
}
export function advanceEncounter(lobby,user,isGM){
  const encounter=lobby.encounter;
  if(!encounter.active || !encounter.order.length)throw Error('No active encounter.');
  const current=encounter.order[encounter.turnIndex].name;
  if(!isGM && (current!==user || !lobby.characters.has(user)))throw Error('Only the current player or GM can advance the turn.');
  if(!encounter.order.some(entry=>(character(lobby,entry.name)?.hp || 0)>0)){encounter.active=false;return encounter;}
  let wrapped=false;
  for(let steps=0;steps<encounter.order.length;steps++){
    encounter.turnIndex=(encounter.turnIndex+1)%encounter.order.length;
    if(!encounter.turnIndex)wrapped=true;
    if((character(lobby,encounter.order[encounter.turnIndex].name)?.hp || 0)>0)break;
  }
  encounter.acted=false;encounter.turnSerial=(encounter.turnSerial || 0)+1;
  if(wrapped){
    encounter.round=(encounter.round || 1)+1;
    const state=ensureTabletop(lobby);
    for(const [name,conditions] of state.conditions)state.conditions.set(name,conditions.map(c=>({...c,remaining:c.remaining==null?null:c.remaining-1})).filter(c=>c.remaining==null || c.remaining>0));
  }
  return encounter;
}
export function resolveAttack(lobby,user,actorName,targetName,ability,damage,isGM,random=()=>crypto.randomInt(1,21),criticalDice=0){
  const actor=character(lobby,actorName),target=character(lobby,targetName);
  if(!actor || !target)throw Error('Select an attacker and target.');
  if(target.hp<=0)throw Error('That target is already down.');
  if(!canEdit(lobby,user,actorName,isGM))throw Error('You cannot control that attacker.');
  if(!isGM && !target.npc)throw Error('Players can attack NPCs; the GM controls attacks against party members.');
  const encounter=lobby.encounter;
  if(!encounter.active || encounter.order[encounter.turnIndex]?.name!==actorName)throw Error('Wait for this attacker’s turn.');
  if(encounter.acted)throw Error('This turn’s attack has already been used.');
  if(actor.hp<=0 || (ensureTabletop(lobby).conditions.get(actorName) || []).some(c=>['Incapacitated','Paralyzed','Petrified','Stunned','Unconscious'].includes(c.name)))throw Error('An incapacitated combatant cannot attack.');
  if(!['STR','DEX'].includes(ability))throw Error('Choose STR or DEX for the attack.');
  if(!Number.isInteger(damage) || damage<0 || damage>200)throw Error('Damage is out of range.');
  const roll=random(),bonus=actor.npc?actor.attack:Math.floor(((actor.abilities?.[ability] || 10)-10)/2)+Math.floor(((actor.level || 1)-1)/4)+2;
  const hit=roll===20 || roll!==1 && roll+bonus>=target.ac;
  const applied=hit?damage+(roll===20?Math.max(0,criticalDice):0):0;target.hp=Math.max(0,target.hp-applied);encounter.acted=true;
  const entry={id:crypto.randomUUID(),actor:actorName,target:targetName,roll,bonus,total:roll+bonus,hit,critical:roll===20,damage:applied,hp:target.hp,round:encounter.round,time:Date.now()};
  const state=ensureTabletop(lobby);state.combatLog.push(entry);if(state.combatLog.length>100)state.combatLog.shift();return entry;
}
export function generateMap(kind,w,h,random=Math.random){
  if(!['forest','dungeon','courtyard'].includes(kind))throw Error('Unknown map template.');
  w=integer(w,5,60,20);h=integer(h,5,60,20);
  const tiles=Array.from({length:h},(_,y)=>Array.from({length:w},(_,x)=>{
    if(kind==='courtyard')return x===0 || y===0 || x===w-1 || y===h-1?1:0;
    if(kind==='dungeon'){if(x===Math.floor(w/2) || y===Math.floor(h/2))return 0;return x===0 || y===0 || x===w-1 || y===h-1 || random()<.17?1:0;}
    return x===Math.floor(w/2) || y===Math.floor(h/2)?0:random()<.12?1:0;
  }));
  return {w,h,tiles,tokens:{}};
}
