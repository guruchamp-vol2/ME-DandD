
// server.js — D&D Lobbies (CSP-safe, start-lock + consent flow, campaign picker ready)

// ===== Imports & Setup =====
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { MongoClient } from 'mongodb';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fsp from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// ===== Campaign registry (for GM picker) =====
const CAMPAIGN_DIR = path.join(__dirname, 'public', 'campaigns');
let CAMPAIGN_REGISTRY = {}; // { key: {title, summary, scenes, handouts, quests, notes, currentSceneId, started:false} }

async function loadCampaignRegistry() {
  CAMPAIGN_REGISTRY = {};
  try {
    if (!fs.existsSync(CAMPAIGN_DIR)) return;
    const files = await fsp.readdir(CAMPAIGN_DIR);
    for (const f of files) {
      if (!/\.json$/i.test(f)) continue;
      const key = f.replace(/\.json$/i, '');
      const raw = await fsp.readFile(path.join(CAMPAIGN_DIR, f), 'utf8');
      const json = JSON.parse(raw);
      if (!Array.isArray(json.scenes)) continue; // minimal validation
      CAMPAIGN_REGISTRY[key] = {
        title: json.title || key,
        summary: json.summary || '',
        scenes: json.scenes || [],
        handouts: json.handouts || [],
        quests: json.quests || [],
        notes: json.notes || [],
        currentSceneId: json.currentSceneId || (json.scenes[0]?.id ?? null),
        started: false,
      };
    }
  } catch (e) {
    console.error('Failed to load campaigns:', e);
  }
}
const cloneCampaign = (obj) => JSON.parse(JSON.stringify(obj));

// ===== Security & middleware =====
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// List campaigns for client picker
app.get('/campaigns', async (req, res) => {
  try {
    if (!Object.keys(CAMPAIGN_REGISTRY).length) await loadCampaignRegistry();
    const list = Object.entries(CAMPAIGN_REGISTRY).map(([key, c]) => ({
      key, title: c.title || key, summary: c.summary || '',
    }));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

// ===== Optional Mongo persistence =====
const useMongo = !!process.env.MONGODB_URI;
let mongoClient = null, db = null;
async function upsertLobbyMeta(name, changes){
  if (useMongo) await db.collection('lobbies').updateOne({name},{ $set:{name, ...changes}}, {upsert:true});
}

// ===== Helpers =====
const nowISO = () => new Date().toISOString();
const safe = (s, max=120) => String(s ?? '').trim().slice(0, max);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const randId = (p='id') => `${p}_${Math.random().toString(36).slice(2,9)}`;

const hashPass = (plain) => {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
};
const verifyPass = (plain, stored) => {
  const [saltHex, hashHex] = (stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const test = crypto.scryptSync(plain, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hashHex, 'hex'), test);
};

// ===== Dice =====
const DICE_ADV = /^(\d*)d(\d+)(k[hl](\d+))?([+\-]\d+)?$/i;
function rollAdvanced(exprRaw) {
  const expr = safe(exprRaw, 40).replace(/\s+/g,'').toLowerCase();
  if (expr === 'adv' || expr === 'd20adv') return rollAdvanced('2d20kh1');
  if (expr === 'dis' || expr === 'd20dis') return rollAdvanced('2d20kl1');
  const m = expr.match(DICE_ADV);
  if (!m) throw new Error('Invalid dice. Try d20, 3d6+2, 4d6kh3, adv/dis.');
  const count = Math.max(1, parseInt(m[1] || '1', 10));
  const sides = parseInt(m[2], 10);
  const keepMode = m[3]?.slice(1,2); const keepN = m[4] ? parseInt(m[4],10) : null;
  const mod = m[5] ? parseInt(m[5], 10) : 0;
  if (count > 100 || sides > 1000) throw new Error('Too big (<=100 dice, <=1000 sides).');
  if (keepN && (keepN < 1 || keepN > count)) throw new Error('Keep out of range.');
  const rolls = Array.from({length:count}, () => 1 + Math.floor(Math.random()*sides));
  let used = [...rolls];
  if (keepMode && keepN) { used.sort((a,b)=> keepMode==='h'? b-a : a-b); used = used.slice(0, keepN); }
  const total = used.reduce((a,b)=>a+b,0) + mod;
  return { expression: exprRaw, rolls, used, modifier: mod, total };
}

// ===== In-memory state & defaults =====
const memory = { lobbies: new Map() };
const defaultMap = () => ({ w: 20, h: 20, tiles: Array.from({length:20}, () => Array(20).fill(0)), tokens: {} });
const defaultCampaign = () => ({
  title: 'Embers of Argeth',
  summary: 'Starter mini-campaign to verify scenes & consent flow.',
  scenes: [
    { id: 's_intro', title: 'Arrival in Graywick', content: 'Foggy mining town; escort job & missing caravans.', choices: [
      { id: 'c_intro_tavern', text: 'Head to the Burnt Anvil tavern', to: 's_tavern' },
      { id: 'c_intro_board',  text: 'Study the notice board',        to: 's_board'  }
    ]},
    { id: 's_tavern', title: 'The Burnt Anvil', content: 'Foreman offers 10 gp each to guard a wagon at dawn.', choices: [
      { id: 'c_tavern_accept', text: 'Accept the job (escort)', to: 's_road' },
      { id: 'c_tavern_market', text: 'Wander the night market', to: 's_market' }
    ]},
    { id: 's_board', title: 'Notice Board', content: 'Late caravans; red-eyed goblins near the Old Road.', choices: [
      { id: 'c_board_investigate', text: 'Investigate the Old Road', to: 's_road' },
      { id: 'c_board_ignore',      text: 'Ask around the market',    to: 's_market' }
    ]},
    { id: 's_market', title: 'Night Market', content: 'Lanterns sway; rumors of a glowing lighthouse.', choices: [
      { id: 'c_market_lighthouse', text: 'Scout the lighthouse', to: 's_lighthouse' },
      { id: 'c_market_sleep',      text: 'Rest then escort',     to: 's_road' }
    ]},
    { id: 's_road', title: 'Ambush on the Old Road', content: 'Goblins attack; tracks lead into woods.', choices: [
      { id: 'c_road_track',  text: 'Follow the tracks', to: 's_cave' },
      { id: 'c_road_help',   text: 'Help wounded, return', to: 's_graywick' }
    ]},
    { id: 's_cave', title: 'Gloomroot Cave', content: 'Glowing mushrooms, captives, a humming idol.', choices: [
      { id: 'c_cave_rescue', text: 'Rescue captives', to: 's_reward' },
      { id: 'c_cave_idol',   text: 'Smash the idol',  to: 's_reward' }
    ]},
    { id: 's_lighthouse', title: 'Ruined Lighthouse', content: 'Sealed hatch; old vault of Argeth.', choices: [
      { id: 'c_lh_descend', text: 'Descend into the vault', to: 's_reward' }
    ]},
    { id: 's_graywick', title: 'Back to Graywick', content: 'Thanks & hints to finish the job.', choices: [
      { id: 'c_graywick_road', text: 'Return to the Old Road', to: 's_road' }
    ]},
    { id: 's_reward', title: 'Aftermath', content: 'Coin; rumors of the Ember Crown.', choices: []}
  ],
  currentSceneId: 's_intro',
  handouts: [{ id: 'h_notice', title: 'Notice Board', content: 'Escort to mill at dawn. Pay: 10 gp each.' }],
  quests: [
    { id: 'q_escort',  title: 'Escort the supply wagon', done: false },
    { id: 'q_goblins', title: 'Find the missing caravans', done: false }
  ],
  notes: []
});
function defaultSettings(){
  return {
    lockedUntilStart: true,
    campaignStarted: false,
    requireCharacter: true,
    consent: { pending: null }, // { choiceId, text, to, approvals:Set<username>, requestedAt }
  };
}
function ensureLobby(name) {
  if (!memory.lobbies.has(name)) {
    memory.lobbies.set(name, {
      createdAt: new Date(),
      gm: null,
      passwordHash: null,
      bans: new Set(),
      users: new Map(),
      macros: new Map(),
      messages: [],
      rolls: [],
      characters: new Map(),
      encounter: { active:false, order:[], turnIndex:0 },
      map: defaultMap(),
      campaign: defaultCampaign(),
      settings: defaultSettings(),
    });
  }
  return memory.lobbies.get(name);
}

// ===== API (before static) =====
app.get('/health', (req,res)=> res.json({ok:true, useMongo}));
app.get('/lobbies', async (req,res)=>{
  if (useMongo) {
    const docs = await db.collection('lobbies').find({}, { projection:{_id:0,name:1}}).toArray();
    return res.json(docs.map(d=>d.name));
  }
  res.json([...memory.lobbies.keys()]);
});

// ===== Static & SPA =====
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 10000;

// ===== Sockets =====
io.on('connection', (socket)=>{
  let username = 'Anon';
  let lobby = null;

  const emitState = () => {
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const users = [...L.users.values()].map(u => u.name);
    io.to(lobby).emit('state', {
      users,
      gm: L.gm,
      characters: Object.fromEntries([...L.characters.entries()]),
      encounter: L.encounter,
      campaign: L.campaign,
      settings: {
        lockedUntilStart: L.settings.lockedUntilStart,
        campaignStarted: L.settings.campaignStarted,
        requireCharacter: L.settings.requireCharacter,
      },
      characterNeeded: Object.fromEntries(users.map(u => [u, !L.characters.has(u)])),
    });
  };
  const emitMap = () => { if (!lobby) return; const L = ensureLobby(lobby); io.to(lobby).emit('map_state', L.map); };
  const joinOk = (L, name) => !L.bans.has((name||'').toLowerCase());
  const uniqueName = (L, base) => {
    let nm = base || 'Anon';
    if (![...L.users.values()].some(u => u.name === nm)) return nm;
    let i=2; while ([...L.users.values()].some(u=>u.name===`${base}${i}`)) i++;
    return `${base}${i}`;
  };

  socket.on('identify', ({name})=>{ username = safe(name || 'Anon', 24); socket.emit('identified', { username }); });

  socket.on('join_lobby', async ({ lobby: lobbyName, password })=>{
    lobbyName = safe(lobbyName || 'tavern', 40) || 'tavern';
    const L = ensureLobby(lobbyName);
    if (!joinOk(L, username)) { socket.emit('error_message','You are banned from this lobby.'); return; }
    if (L.passwordHash) {
      if (!password || !verifyPass(password, L.passwordHash)) { socket.emit('error_message','Lobby is locked (wrong password).'); return; }
    } else if (password) {
      L.passwordHash = hashPass(password);
      if (!L.gm) L.gm = username;
      await upsertLobbyMeta(lobbyName, { password:true, gm:L.gm });
    } else if (!L.gm) {
      L.gm = username; // first-join GM
    }
    if (lobby) socket.leave(lobby);
    lobby = lobbyName;
    username = uniqueName(L, username);
    L.users.set(socket.id, { name: username });
    socket.join(lobby);

    const history = { messages: L.messages.slice(-40), rolls: L.rolls.slice(-40) };
    socket.emit('joined', { lobby, history, gm: L.gm, settings: L.settings });
    io.to(lobby).emit('system', `${username} joined ${lobby}`);

    if (L.settings.requireCharacter && !L.characters.has(username)) {
      io.to(socket.id).emit('character_required', { reason: 'GM requires a character before playing.' });
    }

    emitState(); emitMap();
  });

  const isLockedForPlayers = (L) => L.settings.lockedUntilStart && !L.settings.campaignStarted;
  const isGM = (L) => L.gm === username;

  // ===== Chat & Roll =====
  socket.on('chat', async ({text})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const msg = safe(text, 500);
    if (!msg) return;
    if (msg.startsWith('/')) { await handleCommand(L, msg); return; }
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const payload = { user: username, text: msg, ts: nowISO() };
    io.to(lobby).emit('chat', payload);
    L.messages.push(payload);
  });

  socket.on('roll', async ({expression})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    try{
      const res = rollAdvanced(expression || 'd20');
      const payload = { user: username, ...res, ts: nowISO(), lobby };
      io.to(lobby).emit('roll', payload);
      L.rolls.push(payload);
    }catch(e){ socket.emit('error_message', e.message || 'Bad dice expression.'); }
  });

  // ===== Characters =====
  socket.on('character_upsert', (sheet)=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const gm = isGM(L);
    const target = safe(sheet?.name || username, 24);
    if (!gm && target !== username) { socket.emit('error_message','You can only edit your own sheet.'); return; }

    const ab = sheet?.abilities || {};
    const abilities = {
      STR: clamp(parseInt(ab.STR || 8,10) || 8, 1, 30),
      DEX: clamp(parseInt(ab.DEX || 8,10) || 8, 1, 30),
      CON: clamp(parseInt(ab.CON || 8,10) || 8, 1, 30),
      INT: clamp(parseInt(ab.INT || 8,10) || 8, 1, 30),
      WIS: clamp(parseInt(ab.WIS || 8,10) || 8, 1, 30),
      CHA: clamp(parseInt(ab.CHA || 8,10) || 8, 1, 30),
    };
    const sanitized = {
      name: target,
      archetype: safe(sheet.archetype, 20),
      race: safe(sheet.race, 20),
      speed: clamp(parseInt(sheet.speed || 30,10) || 30, 0, 120),
      profs: safe(sheet.profs, 200),
      traits: safe(sheet.traits, 800),
      class: safe(sheet.class, 24),
      level: clamp(parseInt(sheet.level || 1,10)||1, 1, 20),
      ac: clamp(parseInt(sheet.ac || 10,10)||10, 1, 30),
      hp: clamp(parseInt(sheet.hp || 10,10)||10, 0, 1000),
      maxHp: clamp(parseInt(sheet.maxHp || 10,10)||10, 1, 1000),
      notes: safe(sheet.notes, 2000),
      abilities,
      updatedAt: nowISO(),
    };
    L.characters.set(target, sanitized);
    io.to(lobby).emit('system', `${username} updated ${target}'s sheet`);
    io.to(lobby).emit('characters', Object.fromEntries([...L.characters.entries()]));
    emitState();
  });

  socket.on('character_delete', ({name})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const target = safe(name || username, 24);
    const gm = isGM(L);
    if (!gm && target !== username) { socket.emit('error_message','You can only remove your own sheet.'); return; }
    L.characters.delete(target);
    io.to(lobby).emit('system', `${username} removed ${target}'s sheet`);
    io.to(lobby).emit('characters', Object.fromEntries([...L.characters.entries()]));
    emitState();
  });

  // ===== Map =====
  socket.on('map_request', ()=> { if (lobby) emitMap(); });

  socket.on('map_init', ({w,h})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    w = clamp(parseInt(w||20,10)||20, 5, 60);
    h = clamp(parseInt(h||20,10)||20, 5, 60);
    L.map = { w, h, tiles: Array.from({length:h},()=>Array(w).fill(0)), tokens: {} };
    io.to(lobby).emit('system', `Map set to ${w}×${h}`);
    emitMap();
  });

  socket.on('map_set', ({x,y,val})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const {w,h} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    if (!Array.isArray(L.map.tiles[y])) return;
    L.map.tiles[y][x] = val ? 1 : 0;
    emitMap();
  });

  socket.on('token_add', ({id,name,color})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const {w,h} = L.map;
    const tid = safe(id||`t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, 40);
    const nm = safe(name || username, 24);
    let x=0,y=0;
    outer: for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) {
      if ((L.map.tiles[yy]?.[xx] ?? 0)===0 && !Object.values(L.map.tokens).some(t=>t.x===xx&&t.y===yy)) { x=xx; y=yy; break outer; }
    }
    L.map.tokens[tid] = { id:tid, name:nm, x, y, color: safe(color||'#222', 16), owner: username };
    emitMap();
  });

  socket.on('token_move', ({id,x,y})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const tok = L.map.tokens?.[id];
    if (!tok) return;
    if (!isGM(L) && tok.owner !== username) { socket.emit('error_message','Only owner or GM can move this token.'); return; }
    const {w,h,tiles} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    if ((tiles?.[y]?.[x] ?? 0)===1) return; // wall
    tok.x = x; tok.y = y;
    emitMap();
  });

  socket.on('token_remove', ({id})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const tok = L.map.tokens?.[id];
    if (!tok) return;
    if (!isGM(L) && tok.owner !== username) return;
    delete L.map.tokens[id];
    emitMap();
  });

  socket.on('map_clear', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const {w,h} = L.map;
    L.map.tiles = Array.from({length:h},()=>Array(w).fill(0));
    emitMap();
  });

  socket.on('ping', ({x,y})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const {w,h} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    io.to(lobby).emit('map_ping', { x, y, by: username, ts: nowISO() });
  });

  // ===== Campaign: load / start / consent =====
  socket.on('campaign_load', async ({ key }) => {
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (!Object.keys(CAMPAIGN_REGISTRY).length) await loadCampaignRegistry();
    const picked = CAMPAIGN_REGISTRY[key];
    if (!picked) { socket.emit('error_message','Campaign not found.'); return; }
    L.campaign = cloneCampaign(picked);
    if (L.settings) {
      L.settings.campaignStarted = false;
      L.settings.consent.pending = null;
    }
    io.to(lobby).emit('system', `GM loaded campaign: ${L.campaign.title}`);
    io.to(lobby).emit('campaign_state', L.campaign);
    emitState();
  });

  socket.on('campaign_get', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    socket.emit('campaign_state', L.campaign);
  });

  socket.on('campaign_start', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (L.settings.campaignStarted) { socket.emit('error_message','Campaign already started.'); return; }
    L.settings.campaignStarted = true;
    io.to(lobby).emit('system', 'GM started the campaign!');
    io.to(lobby).emit('campaign_started', { sceneId: L.campaign.currentSceneId });
    for (const [sid, u] of L.users.entries()){
      if (!L.characters.has(u.name)) io.to(sid).emit('character_required', { reason: 'campaign_started' });
    }
    emitState();
  });

  socket.on('campaign_update_meta', ({title, summary})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (title) L.campaign.title = safe(title, 120);
    if (summary != null) L.campaign.summary = safe(summary, 2000);
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_scene_add', ({title, content})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const scene = { id: randId('scn'), title: safe(title||'New Scene',120), content: safe(content||'', 4000), choices: [] };
    L.campaign.scenes.push(scene);
    if (!L.campaign.currentSceneId) L.campaign.currentSceneId = scene.id;
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_scene_set', ({sceneId})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (L.campaign.scenes.some(s=>s.id===sceneId)){
      L.campaign.currentSceneId = sceneId;
      io.to(lobby).emit('system', `Scene changed to: ${sceneId}`);
      io.to(lobby).emit('campaign_state', L.campaign);
    }
  });

  socket.on('campaign_choice_add', ({sceneId, text, to})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const scene = L.campaign.scenes.find(s=>s.id===sceneId);
    if (!scene) return;
    scene.choices.push({ id: randId('ch'), text: safe(text||'Choice', 200), to: safe(to||'', 120) });
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_handout_add', ({title, content})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    L.campaign.handouts.push({ id: randId('hd'), title: safe(title||'Handout',120), content: safe(content||'', 4000) });
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_quest_add', ({title})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    L.campaign.quests.push({ id: randId('q'), title: safe(title||'Quest', 200), done: false });
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_quest_toggle', ({id})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const q = L.campaign.quests.find(q=>q.id===id);
    if (!q) return;
    q.done = !q.done;
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  socket.on('campaign_note_add', ({text})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const t = safe(text, 1000);
    if (!t) return;
    L.campaign.notes.push({ by: username, text: t, ts: nowISO() });
    io.to(lobby).emit('campaign_state', L.campaign);
  });

  // ===== Slash-commands =====
  async function handleCommand(L, line){
    const [cmd, ...rest] = line.slice(1).split(' ');
    const argStr = rest.join(' ').trim();
    const gm = isGM(L);
    const send = (t)=> io.to(lobby).emit('system', t);

    switch ((cmd||'').toLowerCase()){
      case 'help':
        socket.emit('system',
          'Commands: /help, /me <action>, /w @name <msg>, /roll <expr>, ' +
          '/macro add name=expr | del name | list, ' +
          '/setpass <pass> (GM on first set), /kick <name> (GM), /ban <name> (GM), /unban <name> (GM), ' +
          '/startencounter (GM), /setinit <name> <n> (GM), /next (GM), /endencounter (GM), ' +
          'Campaign: /camp title <t> (GM), /camp summary <text> (GM), ' +
          '/scene add <title>|<content> (GM), /scene set <sceneId> (GM), ' +
          '/start (GM start campaign), /consent force (GM)'
        );
        break;

      case 'start': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        if (L.settings.campaignStarted) { socket.emit('error_message','Already started.'); break; }
        L.settings.campaignStarted = true;
        send('GM started the campaign!');
        io.to(lobby).emit('campaign_started', { sceneId: L.campaign.currentSceneId });
        for (const [sid, u] of L.users.entries()){
          if (!L.characters.has(u.name)) io.to(sid).emit('character_required', { reason: 'campaign_started' });
        }
        emitState();
        break;
      }

      case 'me': {
        const text = argStr || 'does something dramatic';
        io.to(lobby).emit('chat', { user: username, text: `*${text}*`, ts: nowISO() });
        break;
      }

      case 'w': {
        const m = argStr.match(/^@?(\S+)\s+([\s\S]+)$/);
        if (!m) { socket.emit('error_message','Usage: /w @name message'); break; }
        const target = m[1], message = m[2];
        const entry = [...L.users.entries()].find(([,u])=>u.name===target);
        if (!entry) { socket.emit('error_message','User not found'); break; }
        const [targetId] = entry;
        io.to(targetId).emit('chat', { user:`(whisper) ${username}`, text:message, ts:nowISO() });
        socket.emit('chat', { user:`(to @${target})`, text:message, ts:nowISO() });
        break;
      }

      case 'roll': {
        if (isLockedForPlayers(L) && !gm) { socket.emit('error_message','Campaign not started by GM yet.'); break; }
        try {
          const res = rollAdvanced(argStr || 'd20');
          const payload = { user: username, ...res, ts: nowISO(), lobby };
          io.to(lobby).emit('roll', payload);
          L.rolls.push(payload);
        } catch(e){ socket.emit('error_message', e.message || 'Bad dice'); }
        break;
      }

      case 'macro': {
        const [sub, ...rest2] = argStr.split(' ');
        const restJoin = rest2.join(' ').trim();
        const map = L.macros.get(username) || new Map();
        if (sub === 'add') {
          const m = restJoin.match(/^(\w+)\s*=\s*([\s\S]+)$/);
          if (!m) { socket.emit('error_message','Use: /macro add name=expr'); break; }
          map.set(m[1], m[2]); L.macros.set(username, map);
          socket.emit('system', `Macro added: ${m[1]} = ${m[2]}`);
        } else if (sub === 'del') {
          map.delete(rest2[0]); L.macros.set(username, map);
          socket.emit('system', `Macro deleted: ${rest2[0]}`);
        } else if (sub === 'list') {
          socket.emit('system', `Your macros: ${JSON.stringify(Object.fromEntries(map.entries()))}`);
        } else socket.emit('error_message','Subcommands: add, del, list');
        break;
      }

      case 'setpass': {
        if (L.passwordHash && !gm) { socket.emit('error_message','Only GM can change password.'); break; }
        if (!argStr) { socket.emit('error_message','Usage: /setpass <password>'); break; }
        L.passwordHash = hashPass(argStr);
        if (!L.gm) L.gm = username;
        await upsertLobbyMeta?.(lobby, { password:true, gm:L.gm, updatedAt: nowISO() });
        send('Lobby password set/updated.');
        emitState();
        break;
      }

      case 'kick': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        const target = safe(argStr,24);
        const entry = [...L.users.entries()].find(([,u])=>u.name===target);
        if (!entry) { socket.emit('error_message','User not found'); break; }
        const [targetId] = entry;
        io.to(targetId).emit('error_message','You were kicked by the GM.');
        io.sockets.sockets.get(targetId)?.leave(lobby);
        L.users.delete(targetId);
        send(`${target} was kicked by the GM.`);
        emitState();
        break;
      }

      case 'ban':   { if (!gm) { socket.emit('error_message','GM only.'); break; } L.bans.add(safe(argStr,24).toLowerCase()); send(`${argStr} is banned.`); emitState(); break; }
      case 'unban': { if (!gm) { socket.emit('error_message','GM only.'); break; } L.bans.delete(safe(argStr,24).toLowerCase()); send(`${argStr} is unbanned.`); emitState(); break; }

      // Encounter
      case 'startencounter': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        L.encounter={active:true,order:[],turnIndex:0};
        send('Encounter started. Use /setinit <name> <n>.'); emitState(); break;
      }
      case 'setinit': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        const m = argStr.match(/^(\S+)\s+(-?\d+)$/);
        if (!m) { socket.emit('error_message','Usage: /setinit <name> <number>'); break; }
        const name = m[1], init = Number(m[2]);
        const i = L.encounter.order.findIndex(o=>o.name===name);
        if (i>=0) L.encounter.order[i].init = init; else L.encounter.order.push({name,init});
        L.encounter.order.sort((a,b)=>b.init-a.init);
        send(`Initiative set: ${name} → ${init}`); emitState(); break;
      }
      case 'next': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        if (!L.encounter.active || L.encounter.order.length===0) { socket.emit('error_message','No active encounter.'); break; }
        L.encounter.turnIndex = (L.encounter.turnIndex+1) % L.encounter.order.length;
        send(`Turn: ${L.encounter.order[L.encounter.turnIndex].name}`); emitState(); break;
      }
      case 'endencounter': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        L.encounter={active:false,order:[],turnIndex:0}; send('Encounter ended.'); emitState(); break;
      }

      // Campaign helpers
      case 'camp': {
        const m = argStr.match(/^(title|summary)\s+([\s\S]+)$/);
        if (!m) { socket.emit('error_message','Usage: /camp title <text> | /camp summary <text>'); break; }
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        if (m[1]==='title')   L.campaign.title   = safe(m[2], 120);
        if (m[1]==='summary') L.campaign.summary = safe(m[2], 2000);
        send(`Campaign ${m[1]} updated.`); emitState(); break;
      }

      case 'scene': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        const mAdd = argStr.match(/^add\s+([^|]+)\|([\s\S]+)$/);
        const mSet = argStr.match(/^set\s+(\S+)$/);
        if (mAdd){
          const scene = { id: randId('scn'), title: safe(mAdd[1],120), content: safe(mAdd[2], 4000), choices: [] };
          L.campaign.scenes.push(scene);
          if (!L.campaign.currentSceneId) L.campaign.currentSceneId = scene.id;
          send(`Scene added: ${scene.title} (${scene.id})`); emitState();
        } else if (mSet){
          const id = mSet[1];
          if (L.campaign.scenes.some(s=>s.id===id)){ L.campaign.currentSceneId = id; send(`Scene set: ${id}`); emitState(); }
          else socket.emit('error_message','Scene not found.');
        } else socket.emit('error_message','Use: /scene add <title>|<content> OR /scene set <sceneId>');
        break;
      }

      case 'consent': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        if (argStr.trim() === 'force') socket.emit('consent_force'); else socket.emit('error_message','Use: /consent force');
        break;
      }

      default: socket.emit('error_message','Unknown command. Try /help');
    }
  }

  // Consent flow
  socket.on('campaign_choice_request', ({choiceId})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (!L.settings.campaignStarted) { socket.emit('error_message','Start campaign first.'); return; }

    const scene = L.campaign.scenes.find(s=>s.id===L.campaign.currentSceneId);
    if (!scene) return;
    const choice = scene.choices.find(c=>c.id===choiceId);
    if (!choice) { socket.emit('error_message','Choice not found.'); return; }

    L.settings.consent.pending = { choiceId: choice.id, text: choice.text, to: choice.to, approvals: new Set(), requestedAt: Date.now() };

    const players = [...L.users.values()].map(u=>u.name).filter(n => n !== L.gm);
    io.to(lobby).emit('campaign_choice_requested', { sceneId: scene.id, choiceId: choice.id, text: choice.text, to: choice.to, requestedBy: username, players });
    emitState();
  });

  socket.on('campaign_choice_ack', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const pending = L.settings.consent.pending;
    if (!pending) return;
    pending.approvals.add(username);
    const nonGM = [...L.users.values()].map(u=>u.name).filter(n => n !== L.gm);
    const allApproved = nonGM.every(n => pending.approvals.has(n));
    if (allApproved) {
      const target = L.campaign.scenes.find(s=>s.id===pending.to);
      if (target) {
        L.campaign.currentSceneId = target.id;
        io.to(lobby).emit('system', `Choice accepted: ${pending.text}`);
        io.to(lobby).emit('campaign_state', L.campaign);
      }
      L.settings.consent.pending = null;
      emitState();
    }
  });

  socket.on('campaign_choice_force', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const pending = L.settings.consent.pending;
    if (!pending) return;
    const target = L.campaign.scenes.find(s=>s.id===pending.to);
    if (target) {
      L.campaign.currentSceneId = target.id;
      io.to(lobby).emit('system', `GM forced proceed: ${pending.text}`);
      io.to(lobby).emit('campaign_state', L.campaign);
    }
    L.settings.consent.pending = null;
    emitState();
  });

  // ===== On disconnect =====
  socket.on('disconnect', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    L.users.delete(socket.id);
    io.to(lobby).emit('system', `${username} left`);
    emitState();
  });
});

// ===== Optional Mongo + Boot =====
(async ()=>{
  if (useMongo) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI, { ignoreUndefined: true });
      await mongoClient.connect();
      db = mongoClient.db(process.env.MONGODB_DB || 'dnd');
      console.log('Mongo connected');
    } catch (e) {
      console.error('Mongo connection failed (continuing without DB):', e.message);
    }
  }
  server.listen(PORT, ()=> console.log(`Server on ${PORT}`));
})();