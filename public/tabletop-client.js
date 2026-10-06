(() => {
  const el=id=>document.getElementById(id);
  let current=null;
  const node=(tag,text,className)=>{const element=document.createElement(tag);if(text!=null)element.textContent=text;if(className)element.className=className;return element;};
  function select(id,entries){
    const control=el(id),previous=control.value;
    control.replaceChildren();for(const [value,text] of entries){const option=node('option',text);option.value=value;control.append(option);}
    if(entries.some(([value])=>value===previous))control.value=previous;
  }
  function render(state){
    current=state;
    const table=state.tabletop || {},characters=Object.values(state.characters || {}),npcs=Object.values(table.npcs || {}),all=[...characters,...npcs];
    const editable=all.filter(c=>IS_GM || c.name===CURRENT_USER);
    document.querySelectorAll('[data-gm-only]').forEach(element=>element.hidden=!IS_GM);
    if(!IS_GM){el('privateNotes').value='';if(el('gmDeskTab').classList.contains('active'))switchTab('partyTab');}
    el('sessionPlayers').textContent=state.users.length;
    el('sessionRound').textContent=state.encounter?.active?state.encounter.round || 1:'—';
    el('sessionScene').textContent=state.campaign?.scenes?.find(s=>s.id===state.campaign.currentSceneId)?.title || '—';
    select('inventoryOwner',editable.map(c=>[c.name,c.name]));
    select('attackActor',editable.map(c=>[c.name,c.name]));
    select('attackTarget',all.filter(c=>IS_GM || c.npc).map(c=>[c.name,c.name]));
    el('partyCards').replaceChildren();
    for(const c of characters){
      const card=node('article',null,'party-card');
      const heading=node('div',null,'section-heading');heading.append(node('h3',c.name),node('span',(c.class || c.archetype || 'Adventurer')+' · L'+c.level,'chip'));card.append(heading);
      const hp=node('div',null,'hp-track');const bar=node('div',null,'hp-fill');bar.style.width=Math.max(0,Math.min(100,c.hp/c.maxHp*100))+'%';hp.append(bar);card.append(hp,node('p',`HP ${c.hp} / ${c.maxHp} · AC ${c.ac} · Speed ${c.speed}`,'muted'));
      const actions=node('div',null,'hstack gap-8');
      for(const [text,delta] of [['−5 HP',-5],['+5 HP',5],['Full rest',c.maxHp-c.hp]]){const button=node('button',text,'btn ghost');button.disabled=!IS_GM && c.name!==CURRENT_USER;button.onclick=()=>socket.emit('tabletop_hp',{name:c.name,delta});actions.append(button);}card.append(actions);
      const conditions=node('div',null,'condition-list');
      for(const condition of table.conditions?.[c.name] || []){const button=node('button',condition.name+(condition.remaining?' · '+condition.remaining+'r':''),'condition-chip');button.disabled=!IS_GM && c.name!==CURRENT_USER;button.onclick=()=>socket.emit('condition_toggle',{name:c.name,condition:condition.name});conditions.append(button);}card.append(conditions);
      if(IS_GM || c.name===CURRENT_USER){const line=node('div',null,'hstack gap-8');const chooser=node('select');for(const name of table.conditionList || []){const option=node('option',name);option.value=name;chooser.append(option);}const duration=node('input');duration.type='number';duration.min='1';duration.max='100';duration.placeholder='Rounds (optional)';duration.setAttribute('aria-label','Condition duration');const add=node('button','Toggle condition','btn');add.onclick=()=>socket.emit('condition_toggle',{name:c.name,condition:chooser.value,duration:duration.value});line.append(chooser,duration,add);card.append(line);}
      const items=table.inventories?.[c.name] || [];card.append(node('h4','Inventory · '+items.reduce((sum,item)=>sum+item.quantity*item.weight,0)+' total weight'));
      for(const item of items){const line=node('div',null,'inventory-item');const text=node('div');text.append(node('strong',item.name+' ×'+item.quantity),node('small',item.notes || 'Weight: '+item.weight));line.append(text);if(IS_GM || c.name===CURRENT_USER){const remove=node('button','Remove','btn ghost');remove.onclick=()=>socket.emit('inventory_remove',{name:c.name,id:item.id});line.append(remove);}card.append(line);}
      if(!items.length)card.append(node('p','An empty pack, ready for adventure.','muted'));
      el('partyCards').append(card);
    }
    if(!characters.length)el('partyCards').append(node('p','Create your character in the Characters tab to join the party.','muted'));
    el('sessionJournal').replaceChildren();
    for(const entry of (table.journal || []).slice().reverse()){const card=node('article',null,'journal-entry');card.append(node('h3',entry.author),node('small',new Date(entry.time).toLocaleString()),node('p',entry.text));el('sessionJournal').append(card);}
    if(!table.journal?.length)el('sessionJournal').append(node('p','Your story is waiting to be written.','muted'));
    el('npcList').replaceChildren();
    for(const npc of npcs){const card=node('div',null,'npc-entry');card.append(node('strong',npc.name),node('small',`HP ${npc.hp}/${npc.maxHp} · AC ${npc.ac} · ${npc.damage}`));const controls=node('div',null,'hstack gap-8');for(const [name,delta] of [['−5 HP',-5],['+5 HP',5]]){const button=node('button',name,'btn ghost');button.onclick=()=>socket.emit('tabletop_hp',{name:npc.name,delta});controls.append(button);}const remove=node('button','Remove','btn danger');remove.onclick=()=>socket.emit('npc_remove',{name:npc.name});controls.append(remove);card.append(controls);el('npcList').append(card);}
    el('combatHistory').replaceChildren();
    for(const entry of (table.combatLog || []).slice(-20).reverse()){const row=node('p',`${entry.actor} → ${entry.target}: ${entry.critical?'CRITICAL · ':''}d20 ${entry.roll} + ${entry.bonus} = ${entry.total} · ${entry.hit?entry.damage+' damage':'miss'} · target HP ${entry.hp}`);el('combatHistory').append(row);}
    const actor=state.encounter?.order?.[state.encounter.turnIndex]?.name;
    el('endMyTurn').disabled=!state.encounter?.active || !IS_GM && actor!==CURRENT_USER;
    el('attackForm').querySelector('button').disabled=!state.encounter?.active;
  }
  socket.on('state',render);
  socket.on('gm_private',data=>{if(IS_GM && document.activeElement!==el('privateNotes'))el('privateNotes').value=data.notes;});
  socket.on('gm_notes_saved',()=>{el('privateNoteStatus').textContent='Private notes saved.';});
  socket.on('left_lobby',()=>{current=null;el('partyCards').replaceChildren();el('privateNotes').value='';});
  el('inventoryForm').onsubmit=event=>{event.preventDefault();socket.emit('inventory_add',{name:el('inventoryOwner').value,item:{name:el('itemName').value,quantity:Number(el('itemQuantity').value),weight:Number(el('itemWeight').value),notes:el('itemNotes').value}});el('itemName').value='';el('itemNotes').value='';};
  el('journalForm').onsubmit=event=>{event.preventDefault();socket.emit('journal_add',{text:el('journalEntry').value});el('journalEntry').value='';};
  el('npcForm').onsubmit=event=>{event.preventDefault();socket.emit('npc_add',{preset:el('npcPreset').value,name:el('npcName').value});el('npcName').value='';};
  el('savePrivateNotes').onclick=()=>socket.emit('gm_notes',{text:el('privateNotes').value});
  el('autoEncounter').onclick=()=>socket.emit('encounter_auto');
  el('endMyTurn').onclick=()=>socket.emit('encounter_advance');
  el('generateMap').onclick=()=>{if(confirm('Replace the map and remove its tokens?'))socket.emit('map_generate',{kind:el('mapTemplate').value,w:Number(el('mapW').value),h:Number(el('mapH').value)});};
  el('attackForm').onsubmit=event=>{event.preventDefault();socket.emit('combat_attack',{actor:el('attackActor').value,target:el('attackTarget').value,ability:el('attackAbility').value,expression:el('attackDamage').value});};
  for(const expression of ['d4','d6','d8','d10','d12','d20','adv','dis']){const button=node('button',expression,'btn dice-button');button.onclick=()=>{el('expr').value=expression;socket.emit('roll',{expression});};el('quickDice').append(button);}
  function rollEntry(data){const entry=node('div',null,'dice-result');entry.append(node('strong',String(data.total)),node('span',data.user+' · '+data.expression),node('small','Rolls: '+data.rolls.join(', ')));el('diceResults').prepend(entry);while(el('diceResults').children.length>50)el('diceResults').lastChild.remove();}
  socket.on('roll',rollEntry);socket.on('joined',data=>{el('diceResults').replaceChildren();for(const roll of data.history?.rolls || [])rollEntry(roll);});
})();
(() => {
  try {document.documentElement.dataset.theme=localStorage.getItem('ember-theme') || 'dark';}catch{document.documentElement.dataset.theme='dark';}
  document.getElementById('themeToggle').onclick=()=>{const value=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=value;try{localStorage.setItem('ember-theme',value);}catch{}};
})();
