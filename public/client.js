/* D&D Lobbies — client.js (GM override + resilient start sync)
   - Robust GM detection (case/space/@ safe)
   - Optimistic Start + LOCAL OVERRIDE so server can't immediately flip it back
   - Listens for multiple server events: campaign_started, campaign_begin, settings_updated
   - Adds a GM-only "Unlock Choices (override)" toggle in the Campaign area
   Requires: <script src="/socket.io/socket.io.js"></script> BEFORE this file.
*/

const socket = io();

/* ---------------- Global state ---------------- */
let CURRENT_USER = null; // set on 'identified'
let IS_GM = false;       // updated from server
let LOCAL_OVERRIDE_STARTED = false; // if true (GM), ignore false coming from server
let CAMPAIGN = {
  started: false,
  currentSceneId: null,
  pendingChoice: null,
  gm: ''
};

/* ---------------- DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const bySel = (sel, root=document) => root.querySelector(sel);
const bySelAll = (sel, root=document) => [...root.querySelectorAll(sel)];

const log = (html, cls='') => {
  const el = document.createElement('div');
  el.className = cls; el.innerHTML = html;
  const logEl = $('log'); if (!logEl) return;
  logEl.appendChild(el); logEl.scrollTop = logEl.scrollHeight;
};

const switchTab = (id) => {
  bySelAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===id));
  bySelAll('.panel-body').forEach(p => p.classList.toggle('active', p.id===id));
};
bySelAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

const escapeHtml = (s)=> String(s)
  .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
  .replaceAll('"','&quot;').replaceAll("'",'&#039;');
const linkify = (s)=> s.replace(/https?:\/\/\S+/g,(url)=>`<a href="${url}" target="_blank" rel="noopener">${url}</a>`);

/* ---------------- Utils ---------------- */
const norm = (name) => (name||'').toString().trim().replace(/^@/,'').toLowerCase();
function updateIsGM(gmName){
  const gm = norm(gmName || CAMPAIGN.gm || bySel('#gmBadge')?.textContent?.replace(/^GM:\s*/, '') || '');
  IS_GM = !!CURRENT_USER && norm(CURRENT_USER) === gm && !!gm;
}

/* ---------------- Campaign Picker (GM only UI) ---------------- */
async function injectCampaignPicker() {
  const tab = $('campTab'); if (!tab) return;
  if (bySel('[data-campaign-picker]', tab)) return; // Only one

  const wrap = document.createElement('div');
  wrap.dataset.campaignPicker = '1';
  wrap.className = 'card';
  wrap.style.margin = '8px 0';

  wrap.innerHTML = `
    <div class="hstack wrap gap-8">
      <strong>Load Campaign</strong>
      <select id="campaignSelect" class="w-30"><option>Loading…</option></select>
      <button id="campaignLoadBtn" class="btn">Load</button>
      <label class="toggle" style="margin-left:auto">
        <input type="checkbox" id="unlockChoicesChk">
        <span class="small">Unlock Choices (GM override)</span>
      </label>
    </div>
    <div id="campaignPreview" class="small muted" style="margin-top:6px;"></div>
  `;
  tab.prepend(wrap);

  // fetch list
  try {
    const res = await fetch('/campaigns', { headers:{ 'accept':'application/json' } });
    const list = await res.json();
    const sel = $('campaignSelect');
    sel.innerHTML = list.map(c => `<option value="${c.key}">${escapeHtml(c.title)}</option>`).join('') || '<option>(none found)</option>';

    const preview = $('campaignPreview');
    const renderPrev = () => {
      const cur = list.find(x => x.key === sel.value);
      preview.textContent = cur ? cur.summary : '';
    };
    sel.addEventListener('change', renderPrev);
    renderPrev();

    $('campaignLoadBtn').addEventListener('click', ()=>{
      log('GM: loading campaign…', 'sys');
      socket.emit('campaign_load', { key: sel.value });
    });
  } catch (e) {
    console.error(e);
  }

  // GM override checkbox
  const chk = $('unlockChoicesChk');
  chk.checked = LOCAL_OVERRIDE_STARTED || CAMPAIGN.started;
  chk.addEventListener('change', ()=>{
    if (!IS_GM) { chk.checked = false; return; }
    LOCAL_OVERRIDE_STARTED = chk.checked;
    if (chk.checked) {
      CAMPAIGN.started = true;
      log('GM override: choices unlocked locally.', 'sys');
    } else {
      // Only re-lock if server also says not started
      if (!CAMPAIGN._serverStarted) CAMPAIGN.started = false;
      log('GM override disabled.', 'sys');
    }
    renderCampaignState(CAMPAIGN);
    gmControlsBar();
  });
}

/* ---------------- Tiny UI Kit: modal ---------------- */
function ensureLayer() {
  let layer = $('modal-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'modal-layer';
    layer.style.position = 'fixed';
    layer.style.inset = '0';
    layer.style.display = 'none';
    layer.style.alignItems = 'center';
    layer.style.justifyContent = 'center';
    layer.style.background = 'rgba(0,0,0,0.4)';
    layer.style.zIndex = '9999';
    document.body.appendChild(layer);
    layer.addEventListener('click', (e)=> { if (e.target === layer) hideModal(); });
  }
  return layer;
}
function showModal(contentEl) {
  const layer = ensureLayer();
  layer.innerHTML = '';
  layer.appendChild(contentEl);
  layer.style.display = 'flex';
}
function hideModal() {
  const layer = $('modal-layer');
  if (layer) { layer.style.display = 'none'; layer.innerHTML = ''; }
}
function makeCard(titleHTML, bodyEl, actions=[]) {
  const card = document.createElement('div');
  card.style.background = 'var(--surface, #fff)';
  card.style.minWidth = 'min(92vw, 720px)';
  card.style.maxWidth = 'min(92vw, 720px)';
  card.style.borderRadius = '16px';
  card.style.boxShadow = '0 10px 30px rgba(0,0,0,.2)';
  card.style.padding = '16px';
  card.innerHTML = `<h3 style="margin:0 0 8px 0">${titleHTML}</h3>`;
  card.appendChild(bodyEl);
  const bar = document.createElement('div');
  bar.style.display = 'flex'; bar.style.gap = '8px'; bar.style.justifyContent='flex-end'; bar.style.marginTop='12px';
  actions.forEach(a => bar.appendChild(a));
  card.appendChild(bar);
  return card;
}
function makeBtn(text, opts={}) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'btn';
  if (opts.primary) b.classList.add('primary');
  if (opts.ghost) b.classList.add('ghost');
  if (opts.danger) b.classList.add('danger');
  return b;
}

/* ---------------- Lobby actions ---------------- */
$('joinBtn')?.addEventListener('click', ()=>{
  const name = $('name')?.value.trim() || 'Anon';
  const lobby = $('lobby')?.value.trim() || 'tavern';
  const password = $('password')?.value.trim() || '';
  socket.emit('identify', { name });
  socket.emit('join_lobby', { lobby, password });
});

$('listBtn')?.addEventListener('click', async ()=>{
  try {
    const res = await fetch('/lobbies', { headers:{'accept':'application/json'} });
    if (!res.ok) throw new Error('HTTP '+res.status);
    const list = await res.json();
    const ul = $('lobbies'); if (!ul) return;
    ul.innerHTML = '';
    (list||[]).forEach(l => {
      const li = document.createElement('li');
      li.textContent = l;
      li.style.cursor='pointer';
      li.onclick = ()=>{ const lobby = $('lobby'); if (lobby) lobby.value = l; };
      ul.appendChild(li);
    });
  } catch (e) {
    log(`Error loading lobbies: ${escapeHtml(String(e.message||e))}`, 'sys');
  }
});

/* ---------------- Chat / Dice ---------------- */
$('sendBtn')?.addEventListener('click', ()=>{
  const msg = $('msg')?.value.trim(); if (!msg) return;
  socket.emit('chat', { text: msg });
  $('msg').value='';
});
$('msg')?.addEventListener('keydown', (e)=> { if (e.key==='Enter') $('sendBtn')?.click(); });

$('rollBtn')?.addEventListener('click', ()=>{
  const expression = $('expr')?.value.trim() || 'd20';
  socket.emit('roll', { expression });
});

function renderChat({ user, text, ts }) {
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  log(`<span class="chat"><strong>${escapeHtml(user)}:</strong> ${linkify(escapeHtml(text))} <small>${when}</small></span>`);
}
function renderRoll({ user, expression, rolls, used, modifier, total, ts }) {
  const when = ts ? new Date(ts).toLocaleTimeString() : '';
  const modStr = modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : '';
  log(`<div class="roll"><strong>${escapeHtml(user)}</strong> rolled <code>${escapeHtml(expression)}</code> → <strong>${total}</strong> <small>${when}</small><br/>Rolls: [${(rolls||[]).join(', ')}] • Used: [${(used||[]).join(', ')}] ${modStr}</div>`, 'roll');
}

/* ---------------- Characters (point buy + table) ---------------- */
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
  if (score === 14) return 9;
  if (score === 15) return 11;
  return 999;
};
const totalCost = () => AB_IDS.reduce((sum,id)=> sum + cost(parseInt($('ab_'+id)?.value||8,10)), 0);
const updatePoints = () => {
  const left = 27 - totalCost();
  const chip = $('pointsLeft'); if (!chip) return;
  chip.textContent = `Points left: ${left}`;
  chip.style.background = left < 0 ? '#ffe6e6' : '';
};

AB_IDS.forEach(id => $('ab_'+id)?.addEventListener('input', updatePoints));
$('c_archetype')?.addEventListener('change', ()=>{
  const a = $('c_archetype').value;
  if (!a || !PRESETS[a]) return;
  AB_IDS.forEach(id => { const el = $('ab_'+id); if (el) el.value = PRESETS[a][id]; });
  if ($('c_traits') && PRESETS[a].traits) $('c_traits').value = PRESETS[a].traits;
  updatePoints();
});
$('c_race')?.addEventListener('change', ()=>{
  const r = $('c_race').value;
  const mod = RACE_MODS[r] || {};
  if ($('c_speed')) $('c_speed').value = mod.speed || 30;
  if (mod.note && $('c_traits') && !$('c_traits').value.includes(mod.note)) {
    $('c_traits').value = (($('c_traits').value || '') + '; ' + mod.note).trim();
  }
});

$('saveChar')?.addEventListener('click', ()=>{
  const abilities = Object.fromEntries(AB_IDS.map(id => [id, parseInt($('ab_'+id)?.value||8,10)]));
  const sheet = {
    name: $('c_name')?.value.trim(),
    class: $('c_class')?.value.trim(),
    archetype: $('c_archetype')?.value || '',
    race: $('c_race')?.value || 'Human',
    level: Number($('c_level')?.value||1),
    ac: Number($('c_ac')?.value||10),
    hp: Number($('c_hp')?.value||10),
    maxHp: Number($('c_maxHp')?.value||10),
    abilities,
    speed: Number($('c_speed')?.value||30),
    profs: $('c_profs')?.value || '',
    traits: $('c_traits')?.value || '',
    notes: $('c_notes')?.value || ''
  };
  socket.emit('character_upsert', sheet);
});
$('deleteChar')?.addEventListener('click', ()=>{
  socket.emit('character_delete', { name: $('c_name')?.value.trim() });
});

function renderChars(charsObj){
  const tbody = $('charsTable'); if (!tbody) return;
  tbody.innerHTML='';
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
      if ($('c_name')) $('c_name').value = c.name || '';
      if ($('c_class')) $('c_class').value = c.class || '';
      if ($('c_archetype')) $('c_archetype').value = c.archetype || '';
      if ($('c_race')) $('c_race').value = c.race || 'Human';
      if ($('c_level')) $('c_level').value = c.level || 1;
      if ($('c_ac')) $('c_ac').value = c.ac || 10;
      if ($('c_hp')) $('c_hp').value = c.hp || 10;
      if ($('c_maxHp')) $('c_maxHp').value = c.maxHp || 10;
      AB_IDS.forEach(id => { const el = $('ab_'+id); if (el) el.value = (c.abilities?.[id] ?? 8); });
      if ($('c_speed')) $('c_speed').value = c.speed || 30;
      if ($('c_profs')) $('c_profs').value = c.profs || '';
      if ($('c_traits')) $('c_traits').value = c.traits || '';
      if ($('c_notes')) $('c_notes').value = c.notes || '';
      updatePoints();
    };
    tbody.appendChild(tr);
  });
}

/* ---------------- Map ---------------- */
let MAP = { w:20, h:20, tiles:[], tokens:{} };
const mapCanvas = $('mapCanvas');
const miniCanvas = $('miniCanvas');
const ctx = mapCanvas?.getContext('2d');
const mctx = miniCanvas?.getContext('2d');

let cellW = 24, cellH = 24;
function resizeCells(){
  if (!mapCanvas) return;
  cellW = Math.max(1, Math.floor(mapCanvas.width / (MAP.w || 1)));
  cellH = Math.max(1, Math.floor(mapCanvas.height / (MAP.h || 1)));
}
function drawMap(){
  if (!mapCanvas || !ctx || !mctx) return;
  ctx.clearRect(0,0,mapCanvas.width,mapCanvas.height);

  // Guard tiles
  if (!Array.isArray(MAP.tiles) || MAP.tiles.length !== (MAP.h||0)) {
    if (mctx) mctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    return;
  }

  for (let y=0;y<MAP.h;y++){
    for (let x=0;x<MAP.w;x++){
      const isWall = ((MAP.tiles[y] || [])[x] === 1);
      ctx.fillStyle = isWall ? '#2b303b' : '#f9fafb';
      ctx.fillRect(x*cellW, y*cellH, cellW, cellH);
      ctx.strokeStyle = '#e5e7eb';
      ctx.strokeRect(x*cellW, y*cellH, cellW, cellH);
    }
  }

  // Tokens
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

  // Mini-map
  if (mctx) {
    mctx.clearRect(0,0,miniCanvas.width,miniCanvas.height);
    const sx = miniCanvas.width / (MAP.w || 1), sy = miniCanvas.height / (MAP.h || 1);
    for (let y=0;y<MAP.h;y++){
      for (let x=0;x<MAP.w;x++){
        const isWall = ((MAP.tiles[y] || [])[x] === 1);
        mctx.fillStyle = isWall ? '#2b303b' : '#f9fafb';
        mctx.fillRect(x*sx, y*sy, sx, sy);
      }
    }
    Object.values(MAP.tokens||{}).forEach(t=>{
      mctx.fillStyle = t.color || '#222';
      mctx.fillRect(t.x*sx, t.y*sy, sx, sy);
    });
  }
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
mapCanvas?.addEventListener('mousedown', (e)=>{
  const {x,y} = tileFromMouse(e);
  if ($('drawWalls')?.checked){
    const val = $('eraseWalls')?.checked ? 0 : 1;
    socket.emit('map_set', { x, y, val });
    dragging = true;
  } else {
    const id = pickTokenAt(e.offsetX, e.offsetY);
    selectedTokenId = id;
    dragging = !!id;
  }
});
mapCanvas?.addEventListener('mousemove', (e)=>{
  if (!dragging) return;
  const {x,y} = tileFromMouse(e);
  if ($('drawWalls')?.checked){
    const val = $('eraseWalls')?.checked ? 0 : 1;
    socket.emit('map_set', { x, y, val });
  } else if (selectedTokenId){
    socket.emit('token_move', { id: selectedTokenId, x, y });
  }
});
window.addEventListener('mouseup', ()=> { dragging = false; });

$('gmSetMap')?.addEventListener('click', ()=> socket.emit('map_init', { w: Number($('mapW')?.value||20), h: Number($('mapH')?.value||20) }));
$('gmClear')?.addEventListener('click', ()=> socket.emit('map_clear'));
$('addToken')?.addEventListener('click', ()=> socket.emit('token_add', { name: $('tokenName')?.value.trim() || $('name')?.value.trim() || 'Anon', color: $('tokenColor')?.value || '#222' }));
$('removeToken')?.addEventListener('click', ()=> { if (selectedTokenId) socket.emit('token_remove', { id: selectedTokenId }); });
$('pingBtn')?.addEventListener('click', ()=>{
  const x = Math.floor((MAP.w||1)/2), y = Math.floor((MAP.h||1)/2);
  socket.emit('ping', { x, y });
});

let pings = [];
function renderPings(){
  const now = Date.now();
  pings = pings.filter(p => now - p.ts < 1200);
  pings.forEach(p=>{
    const t = (now - p.ts)/1200;
    const r = Math.min(cellW,cellH) * (0.2 + t*0.8);
    const cx = p.x*cellW + cellW/2, cy = p.y*cellH + cellH/2;
    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle = `rgba(220,38,38,${1-t})`;
    ctx.lineWidth = 3; ctx.stroke();
  });
  if (pings.length) requestAnimationFrame(()=>{ drawMap(); renderPings(); });
}

/* ---------------- Encounter ---------------- */
$('encStart')?.addEventListener('click', ()=> socket.emit('chat', { text: '/startencounter' }));
$('encNext')?.addEventListener('click',  ()=> socket.emit('chat', { text: '/next' }));
$('encEnd')?.addEventListener('click',   ()=> socket.emit('chat', { text: '/endencounter' }));
$('setInit')?.addEventListener('click',  ()=>{
  const name = $('initName')?.value.trim();
  const val  = Number($('initVal')?.value||0);
  if (!name) return;
  socket.emit('chat', { text: `/setinit ${name} ${val}` });
});
function renderEncounter(enc){
  const tbody = $('initTable'); if (!tbody) return;
  tbody.innerHTML='';
  (enc.order||[]).forEach((o,idx)=>{
    const tr = document.createElement('tr');
    const isTurn = enc.active && idx === (enc.turnIndex||0);
    tr.innerHTML = `<td>${idx+1}${isTurn?' ▶':''}</td><td>${escapeHtml(o.name)}</td><td>${o.init}</td>`;
    if (isTurn) tr.style.background='#fff8dc';
    tbody.appendChild(tr);
  });
}

/* ---------------- Campaign UI helpers ---------------- */
function gmControlsBar() {
  const tab = $('campTab'); if (!tab) return;
  let bar = bySel('[data-gmbar]', tab);
  if (!bar) {
    bar = document.createElement('div');
    bar.dataset.gmbar = '1';
    bar.className = 'hstack wrap gap-8';
    bar.style.margin = '8px 0';
    tab.prepend(bar);
  }
  bar.innerHTML = '';

  if (IS_GM && !CAMPAIGN.started) {
    const b = makeBtn('Start Campaign', { primary:true });
    b.addEventListener('click', ()=> {
      log('GM: starting campaign…', 'sys');
      LOCAL_OVERRIDE_STARTED = true;
      CAMPAIGN.started = true;
      renderCampaignState(CAMPAIGN); // enable choice buttons for GM immediately
      gmControlsBar();
      socket.emit('campaign_start');
      // Also emit a settings hint used by some servers
      socket.emit('settings_update', { campaignStarted: true });
      // Flip the override checkbox if present
      const chk = $('unlockChoicesChk'); if (chk) chk.checked = true;
    });
    bar.appendChild(b);
  }
  if (IS_GM && CAMPAIGN.pendingChoice) {
    const f = makeBtn('Force Proceed (GM)', { danger:true });
    f.addEventListener('click', ()=> {
      log('GM: force proceed…', 'sys');
      socket.emit('campaign_choice_force');
    });
    bar.appendChild(f);
  }
}

function renderCampaignState(c){
  // Keep a copy of what server last said about started-ness
  if (typeof c?.started === 'boolean') CAMPAIGN._serverStarted = c.started;

  // Merge campaign data
  CAMPAIGN = { ...CAMPAIGN, ...c };

  // Apply local override if GM wants it
  if (LOCAL_OVERRIDE_STARTED && IS_GM) CAMPAIGN.started = true;

  const meta = $('campMeta'), sceneEl = $('campScene'), choicesWrap = $('campChoices');
  if (!meta || !sceneEl || !choicesWrap) return;

  meta.innerHTML = `<h3>${escapeHtml(c.title || 'Untitled Campaign')}</h3><p class="small">${escapeHtml(c.summary || '')}</p>`;

  const current = (c.scenes || []).find(s => s.id === c.currentSceneId);
  sceneEl.innerHTML = current
    ? `<h4>${escapeHtml(current.title)}</h4><p>${escapeHtml(current.content || '')}</p>
       <div class="small">Scene ID: <code>${escapeHtml(current.id)}</code></div>`
    : `<em>No scene selected</em>`;

  // Choices
  choicesWrap.innerHTML = '';
  gmControlsBar();

  (current?.choices || []).forEach(ch=>{
    const btn = makeBtn(ch.text);
    if (IS_GM && CAMPAIGN.started) {
      btn.addEventListener('click', ()=> socket.emit('campaign_choice_request', { choiceId: ch.id }));
      btn.disabled = false;
      btn.title = '';
      btn.style.cursor = 'pointer';
      btn.style.pointerEvents = 'auto';
    } else {
      btn.disabled = true;
      btn.title = CAMPAIGN.started ? 'Only the GM can choose' : 'Campaign not started yet';
      btn.style.cursor = 'not-allowed';
      btn.style.pointerEvents = 'none';
    }
    choicesWrap.appendChild(btn);
  });

  // Lists
  const handouts = $('handouts'), quests = $('quests'), notes = $('notes');
  if (handouts) handouts.innerHTML = (c.handouts||[]).map(h => `<li><strong>${escapeHtml(h.title)}</strong>: ${escapeHtml(h.content)}</li>`).join('');
  if (quests) quests.innerHTML = (c.quests||[]).map(q => `<li>${q.done ? '✅' : '⬜️'} ${escapeHtml(q.title)} <small><code>${escapeHtml(q.id)}</code></small></li>`).join('');
  if (notes) notes.innerHTML = (c.notes||[]).map(n => `<div class="small"><strong>${escapeHtml(n.by)}</strong>: ${escapeHtml(n.text)} <em>${new Date(n.ts).toLocaleTimeString()}</em></div>`).join('');

  // GM-only picker after we know GM status
  if (IS_GM) injectCampaignPicker();
}

function wireCampaignInputs(){
  $('addNote')?.addEventListener('click', ()=>{
    const t = $('noteText')?.value.trim(); if (!t) return;
    socket.emit('campaign_note_add', { text: t });
    $('noteText').value='';
  });
  $('saveCampMeta')?.addEventListener('click', ()=>{
    const title = $('campTitle')?.value.trim(); if (!title) return;
    socket.emit('campaign_update_meta', { title });
  });
  $('saveCampSummary')?.addEventListener('click', ()=>{
    socket.emit('campaign_update_meta', { summary: $('campSummary')?.value || '' });
  });
  $('addScene')?.addEventListener('click', ()=>{
    socket.emit('campaign_scene_add', { title: $('sceneTitle')?.value || 'New Scene', content: $('sceneContent')?.value || '' });
  });
  $('setScene')?.addEventListener('click', ()=>{
    const id = $('sceneIdSet')?.value.trim(); if (!id) return;
    socket.emit('campaign_scene_set', { sceneId: id });
  });
  $('addChoice')?.addEventListener('click', ()=>{
    socket.emit('campaign_choice_add', { sceneId: $('choiceSceneId')?.value.trim(), text: $('choiceText')?.value || 'Choice', to: $('choiceTo')?.value.trim() });
  });
  $('addHandout')?.addEventListener('click', ()=>{
    socket.emit('campaign_handout_add', { title: $('handoutTitle')?.value || 'Handout', content: $('handoutContent')?.value || '' });
  });
  $('addQuest')?.addEventListener('click', ()=>{
    const t = $('questTitle')?.value.trim(); if (!t) return;
    socket.emit('campaign_quest_add', { title: t });
  });
}

/* ---------------- Character Creator Popup ---------------- */
function openCharacterPopup(prefillName=''){
  const body = document.createElement('div');
  body.innerHTML = `
  <div class="grid cols-1 gap-8">
    <label class="field"><span>Name</span><input id="pc_name" placeholder="Your hero" value="${escapeHtml(prefillName)}"/></label>
    <div class="grid-3 gap-8">
      <label class="field"><span>Archetype</span>
        <select id="pc_arch"><option value="">(Preset)</option><option>Warrior</option><option>Rogue</option><option>Wizard</option><option>Cleric</option></select>
      </label>
      <label class="field"><span>Race</span>
        <select id="pc_race"><option>Human</option><option>Elf</option><option>Dwarf</option><option>Halfling</option></select>
      </label>
      <label class="field"><span>Class</span><input id="pc_class" placeholder="e.g. Fighter"/></label>
    </div>
    <div class="grid-6 sm-grid-3 gap-8">
      ${AB_IDS.map(id=>`<label class="ability small"><span>${id}</span><input id="pc_${id}" type="number" min="8" max="15" value="8"></label>`).join('')}
    </div>
    <div class="small muted" id="pc_points">Points left: 27</div>
  </div>`;
  const pcPoints = body.querySelector('#pc_points');
  const pcCost = () => AB_IDS.reduce((sum,id)=> sum + cost(parseInt(body.querySelector('#pc_'+id)?.value||8,10)), 0);
  const pcUpdate = ()=>{
    const left = 27 - pcCost();
    pcPoints.textContent = `Points left: ${left}`;
    pcPoints.style.color = left < 0 ? '#b91c1c' : '';
  };
  AB_IDS.forEach(id=> body.querySelector('#pc_'+id).addEventListener('input', pcUpdate));
  body.querySelector('#pc_arch').addEventListener('change', (e)=>{
    const a = e.target.value;
    if (a && PRESETS[a]) {
      AB_IDS.forEach(id => { body.querySelector('#pc_'+id).value = PRESETS[a][id]; });
      pcUpdate();
    }
  });
  pcUpdate();

  const cancel = makeBtn('Later', { ghost:true });
  cancel.addEventListener('click', hideModal);

  const save = makeBtn('Save Character', { primary:true });
  save.addEventListener('click', ()=>{
    const abilities = Object.fromEntries(AB_IDS.map(id => [id, parseInt(body.querySelector('#pc_'+id)?.value||8,10)]));
    const sheet = {
      name: body.querySelector('#pc_name')?.value.trim() || $('name')?.value.trim() || 'Hero',
      class: body.querySelector('#pc_class')?.value.trim() || '',
      archetype: body.querySelector('#pc_arch')?.value || '',
      race: body.querySelector('#pc_race')?.value || 'Human',
      level: 1, ac: 10, hp: 10, maxHp: 10,
      abilities, speed: 30, profs: '', traits: '', notes: ''
    };
    socket.emit('character_upsert', sheet);
    hideModal();
  });

  showModal(makeCard('Create Your Character', body, [cancel, save]));
}

/* ---------------- Consent Modal ---------------- */
function openConsentModal({ text, requestedBy }){
  const body = document.createElement('div');
  body.innerHTML = `<p>${escapeHtml(requestedBy || 'GM')} proposes: <strong>${escapeHtml(text)}</strong></p>
  <p class="small muted">Everyone must accept (or the GM can force after ~30s).</p>`;
  const cancel = makeBtn('Not Yet', { ghost:true });
  cancel.addEventListener('click', hideModal);
  const ok = makeBtn("I'm OK with this", { primary:true });
  ok.addEventListener('click', ()=>{
    socket.emit('campaign_choice_ack');
    hideModal();
  });
  showModal(makeCard('Proceed?', body, [cancel, ok]));
}

/* ---------------- Socket events ---------------- */
socket.on('connect_error', (err)=>{
  log(`Socket error: ${escapeHtml(err?.message || String(err))}`, 'sys');
});

socket.on('identified', ({ username })=> {
  CURRENT_USER = username;
  updateIsGM(); // may resolve once gmBadge exists too
  log(`You are <strong>${escapeHtml(username)}</strong>.`, 'sys');
});

socket.on('joined', ({ lobby, history, gm, settings })=>{
  if ($('log')) $('log').innerHTML = '';
  log(`Joined lobby <strong>${escapeHtml(lobby)}</strong>.`, 'sys');
  (history?.messages||[]).forEach(m=>renderChat(m));
  (history?.rolls||[]).forEach(r=>renderRoll(r));
  if ($('gmBadge')) $('gmBadge').textContent = `GM: ${gm || '—'}`;

  // Respect current started state from server
  CAMPAIGN._serverStarted = !!(settings && settings.campaignStarted);
  CAMPAIGN.started = (LOCAL_OVERRIDE_STARTED && IS_GM) ? true : CAMPAIGN._serverStarted;

  CAMPAIGN.gm = gm || CAMPAIGN.gm;
  updateIsGM(gm);

  socket.emit('map_request');
  socket.emit('campaign_get');
  wireCampaignInputs();

  if (IS_GM) injectCampaignPicker();
});

socket.on('system', (t)=> log(escapeHtml(t), 'sys'));
socket.on('chat', (m)=> renderChat(m));
socket.on('roll', (r)=> renderRoll(r));
socket.on('error_message', (msg)=> log(`Error: ${escapeHtml(msg)}`, 'sys'));

socket.on('characters', renderChars);

socket.on('state', (state)=>{
  if ($('gmBadge')) $('gmBadge').textContent = `GM: ${state.gm || '—'}`;
  if ($('users')) $('users').innerHTML = (state.users||[]).map(u=>`<span class="pill">@${escapeHtml(u)}</span>`).join(' ');
  renderChars(state.characters || {});
  renderEncounter(state.encounter || {active:false, order:[], turnIndex:0});

  // Sync started flag from server, but honor local override if GM
  if (state.settings && typeof state.settings.campaignStarted === 'boolean') {
    CAMPAIGN._serverStarted = state.settings.campaignStarted;
  }
  if (!LOCAL_OVERRIDE_STARTED || !IS_GM) {
    CAMPAIGN.started = !!CAMPAIGN._serverStarted;
  } else {
    CAMPAIGN.started = true;
  }

  if (state.gm) CAMPAIGN.gm = state.gm;
  updateIsGM(state.gm);

  if (state.campaign) {
    renderCampaignState(state.campaign);
  } else {
    gmControlsBar();
  }
});

socket.on('map_state', (map)=>{ MAP = map || MAP; resizeCells(); drawMap(); });
socket.on('map_ping', ({x,y})=>{
  pings.push({ x,y, ts: Date.now() });
  drawMap(); renderPings();
});

/* Campaign events + flows */
function handleStarted(){
  CAMPAIGN._serverStarted = true;
  CAMPAIGN.started = true;
  const chk = $('unlockChoicesChk'); if (chk) chk.checked = true;
  log('Campaign started!', 'sys');
  socket.emit('campaign_get'); // refresh full state
}
socket.on('campaign_state', (c)=> {
  if (typeof c?.gm === 'string') CAMPAIGN.gm = c.gm;
  updateIsGM(c?.gm);
  // some servers include started here
  if (typeof c?.started === 'boolean') {
    CAMPAIGN._serverStarted = c.started;
    if (!LOCAL_OVERRIDE_STARTED || !IS_GM) CAMPAIGN.started = c.started;
  }
  renderCampaignState(c);
});
socket.on('campaign_started', ({ sceneId })=> handleStarted());
socket.on('campaign_begin', ({ sceneId })=> handleStarted());
socket.on('settings_updated', (settings)=>{
  if (typeof settings?.campaignStarted === 'boolean') {
    CAMPAIGN._serverStarted = settings.campaignStarted;
    if (!LOCAL_OVERRIDE_STARTED || !IS_GM) CAMPAIGN.started = settings.campaignStarted;
    renderCampaignState(CAMPAIGN);
    gmControlsBar();
  }
});
socket.on('character_required', ({ reason })=>{
  openCharacterPopup($('name')?.value.trim() || 'Hero');
});
socket.on('campaign_choice_requested', (payload)=>{
  CAMPAIGN.pendingChoice = payload?.choiceId || true;
  openConsentModal(payload);
  gmControlsBar();
});

/* ------- Theme toggle (CSP-safe) ------- */
(()=>{
  const root = document.documentElement;
  const saved = localStorage.getItem('theme');
  if (saved) root.dataset.theme = saved;
  const btn = $('themeToggle');
  btn?.addEventListener('click', ()=>{
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', root.dataset.theme);
  });
})();

/* ------- Init draw + resize ------- */
resizeCells(); drawMap();
window.addEventListener('resize', ()=>{ resizeCells(); drawMap(); });
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===id));
    document.querySelectorAll('.panel-body').forEach(p => p.classList.toggle('active', p.id===id));
  }));
});