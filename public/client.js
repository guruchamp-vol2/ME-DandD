/* Full client.js for D&D Lobbies: chat, dice, character customization, mini-map, and encounter tracker */
const socket = io();

// ---------------- DOM helpers ----------------
const $ = (id) => document.getElementById(id);
const log = (html, cls='') => {
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html;
  $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight;
};
const switchTab = (id) => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===id));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id===id));
};
document.querySelectorAll('.tab-btn').forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));

function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function linkify(s){ return s.replace(/https?:\/\/\S+/g,(url)=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`); }

// ---------------- Lobby actions ----------------
$('joinBtn').onclick = () => {
  const name = $('name').value.trim() || 'Anon';
  const lobby = $('lobby').value.trim() || 'tavern';
  const password = $('password').value.trim();
  socket.emit('identify', { name });
  socket.emit('join_lobby', { lobby, password });
};
$('listBtn').onclick = async () => {
  const res = await fetch('/lobbies'); const list = await res.json();
  const ul = $('lobbies'); ul.innerHTML = '';
  list.forEach(l => { const li = document.createElement('li'); li.textContent = l; li.style.cursor='pointer'; li.onclick=()=>{ $('lobby').value=l; }; ul.appendChild(li); });
};

// ---------------- Chat / Dice ----------------
$('sendBtn').onclick = () => { const text = $('msg').value.trim(); if (!text) return; socket.emit('chat', { text }); $('msg').value=''; };
$('msg').addEventListener('keydown', (e)=> { if (e.key==='Enter') $('sendBtn').click(); });
$('rollBtn').onclick = () => { const expression = $('expr').value.trim() || 'd20'; socket.emit('roll', { expression }); };

// Render chat & roll messages
function renderChat({ user, text, ts }) {
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  log(`<span class="chat"><strong>${escapeHtml(user)}:</strong> ${linkify(escapeHtml(text))} <small>${when}</small></span>`);
}
function renderRoll({ user, expression, rolls, used, modifier, total, ts }) {
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  const modStr = modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : '';
  log(`<div class="roll"><strong>${escapeHtml(user)}</strong> rolled <code>${escapeHtml(expression)}</code> → <strong>${total}</strong> <small>${when}</small><br/>Rolls: [${(rolls||[]).join(', ')}] • Used: [${(used||[]).join(', ')}] ${modStr}</div>`, 'roll');
}

// ---------------- Character Customization ----------------
const PRESETS = {
  Warrior: { STR:15, DEX:10, CON:14, INT:8, WIS:10, CHA:10, traits:'Martial prowess, Second Wind' },
  Rogue:   { STR:8,  DEX:15, CON:12, INT:10, WIS:10, CHA:12, traits:'Sneak Attack, Cunning Action' },
  Wizard:  { STR:8,  DEX:12, CON:12, INT:15, WIS:12, CHA:8, traits:'Spellbook, Arcane Recovery' },
  Cleric:  { STR:10, DEX:10, CON:14, INT:8, WIS:15, CHA:10, traits:'Channel Divinity, Divine Domain' },
};
const RACE_MODS = {
  Human:   { STR:1, DEX:1, CON:1, INT:1, WIS:1, CHA:1, speed:30, note:'Versatile' },
  Elf:     { DEX:2, INT:1, speed:30, note:'Darkvision, Keen Senses' },
  Dwarf:   { CON:2, WIS:1, speed:25, note:'Dwarven Resilience' },
  Halfling:{ DEX:2, CHA:1, speed:25, note:'Lucky, Brave' },
};

const AB_IDS = ['STR','DEX','CON','INT','WIS','CHA'];
const cost = (score) => {
  if (score < 8) return 0;
  if (score <= 13) return score - 8;
  if (score === 14) return 7 + 2;   // +2 for 13→14
  if (score === 15) return 9 + 2;   // +2 for 14→15
  return 999; // invalid
};
const totalCost = () => AB_IDS.reduce((sum,id)=> sum + cost(parseInt($('ab_'+id).value||8,10)), 0);
const updatePoints = () => {
  const spent = totalCost();
  const left = 27 - spent;
  $('pointsLeft').textContent = `Points left: ${left}`;
  $('pointsLeft').style.background = left < 0 ? '#ffe6e6' : '';
};
AB_IDS.forEach(id => $('ab_'+id).addEventListener('input', ()=> updatePoints()));
$('c_archetype').addEventListener('change', ()=>{
  const a = $('c_archetype').value;
  if (!a || !PRESETS[a]) return;
  AB_IDS.forEach(id => $('ab_'+id).value = PRESETS[a][id]);
  $('c_traits').value = (PRESETS[a].traits || '');
  updatePoints();
});
$('c_race').addEventListener('change', ()=>{
  const r = $('c_race').value;
  const mod = RACE_MODS[r] || {};
  $('c_speed').value = mod.speed || 30;
  const tips = mod.note ? `; ${mod.note}` : '';
  if (mod.note && !$('c_traits').value.includes(mod.note)) $('c_traits').value = ( $('c_traits').value || '' ) + tips;
});

// Save/Delete
$('saveChar').onclick = () => {
  const abilities = Object.fromEntries(AB_IDS.map(id => [id, parseInt($('ab_'+id).value||8,10)]));
  const sheet = {
    name: $('c_name').value.trim(),
    class: $('c_class').value.trim(),
    archetype: $('c_archetype').value || '',
    race: $('c_race').value || 'Human',
    level: Number($('c_level').value||1),
    ac: Number($('c_ac').value||10),
    hp: Number($('c_hp').value||10),
    maxHp: Number($('c_maxHp').value||10),
    abilities,
    speed: Number($('c_speed').value||30),
    profs: $('c_profs').value,
    traits: $('c_traits').value,
    notes: $('c_notes').value
  };
  socket.emit('character_upsert', sheet);
};
$('deleteChar').onclick = () => {
  socket.emit('character_delete', { name: $('c_name').value.trim() });
};

// Render character table
function renderChars(charsObj){
  const tbody = $('charsTable'); tbody.innerHTML='';
  Object.values(charsObj||{}).forEach(c=>{
    const ab = c.abilities || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(c.name||'')}</td>
      <td>${escapeHtml(c.race||'')}</td>
      <td>${escapeHtml(c.archetype||c.class||'')}</td>
      <td>${Number(c.level)||1}</td>
      <td>${Number(c.ac)||10}</td>
      <td>${Number(c.hp)||0}/${Number(c.maxHp)||0}</td>
      <td class="small">STR ${ab.STR||8}, DEX ${ab.DEX||8}, CON ${ab.CON||8}, INT ${ab.INT||8}, WIS ${ab.WIS||8}, CHA ${ab.CHA||8}</td>
    `;
    tr.style.cursor='pointer';
    tr.onclick = ()=>{
      $('c_name').value = c.name || '';
      $('c_class').value = c.class || '';
      $('c_archetype').value = c.archetype || '';
      $('c_race').value = c.race || 'Human';
      $('c_level').value = c.level || 1;
      $('c_ac').value = c.ac || 10;
      $('c_hp').value = c.hp || 10;
      $('c_maxHp').value = c.maxHp || 10;
      AB_IDS.forEach(id => $('ab_'+id).value = (c.abilities?.[id] ?? 8));
      $('c_speed').value = c.speed || 30;
      $('c_profs').value = c.profs || '';
      $('c_traits').value = c.traits || '';
      $('c_notes').value = c.notes || '';
      updatePoints();
    };
    tbody.appendChild(tr);
  });
}

// ---------------- Map ----------------
let MAP = { w:20, h:20, tiles:[], tokens:{} };
const mapCanvas = $('mapCanvas');
const miniCanvas = $('miniCanvas');
const ctx = mapCanvas.getContext('2d');
const mctx = miniCanvas.getContext('2d');

let cellW = 24, cellH = 24;
function resizeCells(){
  cellW = Math.floor(mapCanvas.width / MAP.w);
  cellH = Math.floor(mapCanvas.height / MAP.h);
}
function drawMap(){
  ctx.clearRect(0,0,mapCanvas.width,mapCanvas.height);
  for (let y=0;y<MAP.h;y++){
    for (let x=0;x<MAP.w;x++){
      if ((MAP.tiles[y]||[])[x]===1){
        ctx.fillStyle = '#2b303b';
        ctx.fillRect(x*cellW, y*cellH, cellW, cellH);
      } else {
        ctx.fillStyle = '#f9fafb';
        ctx.fillRect(x*cellW, y*cellH, cellW, cellH);
      }
      ctx.strokeStyle = '#e5e7eb';
      ctx.strokeRect(x*cellW, y*cellH, cellW, cellH);
    }
  }
  Object.values(MAP.tokens||{}).forEach(t=>{
    const cx = t.x*cellW + cellW/2, cy = t.y*cellH + cellH/2;
    ctx.beginPath(); ctx.arc(cx,cy, Math.min(cellW,cellH)*0.35, 0, Math.PI*2);
    ctx.fillStyle = t.color || '#222'; ctx.fill();
    ctx.strokeStyle = '#111'; ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.floor(Math.min(cellW,cellH)*0.4)}px system-ui`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText((t.name||'?')[0]?.toUpperCase() || '?', cx, cy);
  });

  mctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
  const sx = miniCanvas.width / MAP.w, sy = miniCanvas.height / MAP.h;
  for (let y=0;y<MAP.h;y++){
    for (let x=0;x<MAP.w;x++){
      mctx.fillStyle = (MAP.tiles[y][x]===1) ? '#2b303b' : '#f9fafb';
      mctx.fillRect(x*sx, y*sy, sx, sy);
    }
  }
  Object.values(MAP.tokens||{}).forEach(t=>{
    mctx.fillStyle = t.color || '#222';
    mctx.fillRect(t.x*sx, t.y*sy, sx, sy);
  });
}

let selectedTokenId = null;
function pickTokenAt(mx,my){
  const x = Math.floor(mx / cellW), y = Math.floor(my / cellH);
  const hit = Object.values(MAP.tokens||{}).find(t => t.x===x && t.y===y);
  return hit?.id || null;
}
function tileFromMouse(e){
  const rect = mapCanvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (mapCanvas.width/rect.width);
  const my = (e.clientY - rect.top)  * (mapCanvas.height/rect.height);
  return { x: Math.floor(mx / cellW), y: Math.floor(my / cellH), mx, my };
}

let dragging = false;
mapCanvas.addEventListener('mousedown', (e)=>{
  const {x,y} = tileFromMouse(e);
  if ($('drawWalls').checked){
    const val = $('eraseWalls').checked ? 0 : 1;
    socket.emit('map_set', { x, y, val });
    dragging = true;
  } else {
    const id = pickTokenAt(e.offsetX, e.offsetY);
    selectedTokenId = id;
    dragging = !!id;
  }
});
mapCanvas.addEventListener('mousemove', (e)=>{
  if (!dragging) return;
  const {x,y} = tileFromMouse(e);
  if ($('drawWalls').checked){
    const val = $('eraseWalls').checked ? 0 : 1;
    socket.emit('map_set', { x, y, val });
  } else if (selectedTokenId){
    socket.emit('token_move', { id: selectedTokenId, x, y });
  }
});
window.addEventListener('mouseup', ()=> { dragging = false; });

$('gmSetMap').onclick = () => socket.emit('map_init', { w: Number($('mapW').value||20), h: Number($('mapH').value||20) });
$('gmClear').onclick = () => socket.emit('map_clear');
$('addToken').onclick = () => socket.emit('token_add', { name: $('tokenName').value.trim() || $('name').value.trim() || 'Anon', color: $('tokenColor').value });
$('removeToken').onclick = () => { if (selectedTokenId) socket.emit('token_remove', { id: selectedTokenId }); };
$('pingBtn').onclick = ()=> {
  const x = Math.floor(MAP.w/2), y = Math.floor(MAP.h/2);
  socket.emit('ping', { x, y });
};

let pings = [];
function renderPings(){
  const now = Date.now();
  pings = pings.filter(p => now - p.ts < 1200);
  pings.forEach(p=>{
    const t = (now - p.ts)/1200;
    const r = Math.min(cellW,cellH) * (0.2 + t*0.8);
    const cx = p.x*cellW + cellW/2, cy = p.y*cellH + cellH/2;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle = 'rgba(220, 38, 38, ' + (1-t) + ')';
    ctx.lineWidth = 3; ctx.stroke();
  });
  if (pings.length) requestAnimationFrame(()=>{ drawMap(); renderPings(); });
}

// ---------------- Encounter tracker ----------------
$('encStart').onclick = () => socket.emit('chat', { text: '/startencounter' });
$('encNext').onclick  = () => socket.emit('chat', { text: '/next' });
$('encEnd').onclick   = () => socket.emit('chat', { text: '/endencounter' });
$('setInit').onclick  = () => {
  const name = $('initName').value.trim();
  const val  = Number($('initVal').value||0);
  if (!name) return;
  socket.emit('chat', { text: `/setinit ${name} ${val}` });
};
function renderEncounter(enc){
  const tbody = $('initTable'); tbody.innerHTML='';
  (enc.order||[]).forEach((o,idx)=>{
    const tr = document.createElement('tr');
    const isTurn = enc.active && idx === (enc.turnIndex||0);
    tr.innerHTML = `<td>${idx+1}${isTurn?' ▶':''}</td><td>${escapeHtml(o.name)}</td><td>${o.init}</td>`;
    if (isTurn) tr.style.background='#fff8dc';
    tbody.appendChild(tr);
  });
}

// ---------------- Socket events ----------------
socket.on('identified', ({ username })=> log(`You are <strong>${escapeHtml(username)}</strong>.`, 'sys'));
socket.on('joined', ({ lobby, history, gm })=>{
  $('log').innerHTML = '';
  log(`Joined lobby <strong>${escapeHtml(lobby)}</strong>.`, 'sys');
  (history.messages||[]).forEach(m=>renderChat(m));
  (history.rolls||[]).forEach(r=>renderRoll(r));
  $('gmBadge').textContent = `GM: ${gm || '—'}`;
  socket.emit('map_request');
});
socket.on('system', (t)=> log(escapeHtml(t), 'sys'));
socket.on('chat', (m)=> renderChat(m));
socket.on('roll', (r)=> renderRoll(r));
socket.on('error_message', (msg)=> log(`Error: ${escapeHtml(msg)}`, 'sys'));

socket.on('characters', (obj)=> renderChars(obj));
socket.on('state', (state)=>{
  $('gmBadge').textContent = `GM: ${state.gm || '—'}`;
  $('users').innerHTML = (state.users||[]).map(u=>`<span class="pill">@${escapeHtml(u)}</span>`).join(' ');
  renderChars(state.characters || {});
  renderEncounter(state.encounter || {active:false, order:[], turnIndex:0});
});

socket.on('map_state', (map)=>{
  MAP = map; resizeCells(); drawMap();
});
socket.on('map_ping', ({x,y,by})=>{
  pings.push({ x,y, ts: Date.now() });
  drawMap(); renderPings();
});

// Initial draw
resizeCells(); drawMap();
window.addEventListener('resize', ()=>{ resizeCells(); drawMap(); });
/* ---------------- Campaign / Story Mode (add-on) ---------------- */

// If your tabs system exists already, this will enable a new tab button with data-tab="campTab"
// and a panel with id="campTab". It gracefully no-ops if the elements aren't present.
 // no-op if you already have $, safe to re-declare

// UI helpers (re-use your existing ones if present)
function _escape(s){ return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;')
  .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

function ensureCampaignUI() {
  // Bail if the page doesn't have the Campaign panel yet
  if ($('campTab')) return true;
  return false;
}

// Render
function renderCampaignState(c){
  if (!ensureCampaignUI()) return;

  $('campMeta').innerHTML =
    `<h3>${_escape(c.title || 'Untitled Campaign')}</h3><p class="small">${_escape(c.summary || '')}</p>`;

  const current = (c.scenes || []).find(s => s.id === c.currentSceneId);
  $('campScene').innerHTML = current
    ? `<h4>${_escape(current.title)}</h4><p>${_escape(current.content || '')}</p>
       <div class="small">Scene ID: <code>${_escape(current.id)}</code></div>`
    : `<em>No scene selected</em>`;

  const choicesEl = $('campChoices'); choicesEl.innerHTML = '';
  (current?.choices || []).forEach(ch => {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.textContent = ch.text;
    btn.onclick = () => socket.emit('campaign_choice_pick', { choiceId: ch.id });
    choicesEl.appendChild(btn);
  });

  $('handouts').innerHTML = (c.handouts || [])
    .map(h => `<li><strong>${_escape(h.title)}</strong>: ${_escape(h.content)}</li>`).join('');

  $('quests').innerHTML   = (c.quests || [])
    .map(q => `<li>${q.done ? '✅' : '⬜️'} ${_escape(q.title)} <small><code>${_escape(q.id)}</code></small></li>`)
    .join('');

  $('notes').innerHTML    = (c.notes || [])
    .map(n => `<div class="small"><strong>${_escape(n.by)}</strong>: ${_escape(n.text)} <em>${new Date(n.ts).toLocaleTimeString()}</em></div>`)
    .join('');

  // simple GM check: show tools if your GM badge contains your own name
  const myNameGuess = document.querySelector('#users .pill')?.textContent?.replace(/^@/, '') || '';
  const gmText = document.getElementById('gmBadge')?.textContent || '';
  const isGM = gmText.includes(myNameGuess) || gmText.includes('You') || gmText.includes('(you)');
  const tools = $('gmTools'); if (tools) tools.style.display = isGM ? 'block' : 'none';
}

// Socket listeners (non-destructive)
socket.on?.('campaign_state', (c) => renderCampaignState(c));

// Ask for campaign on join (if your existing 'joined' listener exists,
// this adds an extra request; harmless if duplicated)
socket.emit?.('campaign_get');

// Wire GM Tool buttons if present
function wireCampaignButtons(){
  if (!ensureCampaignUI()) return;

  const byId = (i) => document.getElementById(i);

  byId('addNote')?.addEventListener('click', ()=>{
    const t = byId('noteText').value.trim(); if (!t) return;
    socket.emit('campaign_note_add', { text: t });
    byId('noteText').value = '';
  });

  byId('saveCampMeta')?.addEventListener('click', ()=>{
    const title = byId('campTitle').value.trim();
    if (title) socket.emit('campaign_update_meta', { title });
  });

  byId('saveCampSummary')?.addEventListener('click', ()=>{
    socket.emit('campaign_update_meta', { summary: byId('campSummary').value });
  });

  byId('addScene')?.addEventListener('click', ()=>{
    socket.emit('campaign_scene_add', {
      title: byId('sceneTitle').value.trim() || 'New Scene',
      content: byId('sceneContent').value || ''
    });
  });

  byId('setScene')?.addEventListener('click', ()=>{
    const id = byId('sceneIdSet').value.trim();
    if (id) socket.emit('campaign_scene_set', { sceneId: id });
  });

  byId('addChoice')?.addEventListener('click', ()=>{
    socket.emit('campaign_choice_add', {
      sceneId: byId('choiceSceneId').value.trim(),
      text:    byId('choiceText').value.trim() || 'Choice',
      to:      byId('choiceTo').value.trim()
    });
  });

  byId('addHandout')?.addEventListener('click', ()=>{
    socket.emit('campaign_handout_add', {
      title:   byId('handoutTitle').value.trim() || 'Handout',
      content: byId('handoutContent').value || ''
    });
  });

  byId('addQuest')?.addEventListener('click', ()=>{
    const t = byId('questTitle').value.trim(); if (!t) return;
    socket.emit('campaign_quest_add', { title: t });
  });
}

// Try to wire now and also after DOMContentLoaded
wireCampaignButtons();
document.addEventListener('DOMContentLoaded', wireCampaignButtons);

// If your code emits a 'state' event already, append render here too (non-destructive)
socket.on?.('state', (state)=>{
  if (state?.campaign) renderCampaignState(state.campaign);
});
// ------- Theme toggle (moved from inline to satisfy CSP) -------
(() => {
  const root = document.documentElement;
  const saved = localStorage.getItem('theme');
  if (saved) root.dataset.theme = saved;

  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('theme', root.dataset.theme);
    });
  }
})();

// ------- Tab wiring (only if your existing code doesn't already do this) -------
if (typeof document !== 'undefined') {
  const tabs = document.querySelectorAll('.tab-btn');
  if (tabs.length) {
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.panel-body').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const panel = document.getElementById(btn.dataset.tab);
        if (panel) panel.classList.add('active');
      });
    });
  }
}
