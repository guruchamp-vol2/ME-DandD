
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
import * as tabletop from './tabletop.js';
import {readState,writeState,validateCampaign} from './state-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize:512000, cors: { origin: '*', methods: ['GET','POST'] } });

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
let useMongo = !!process.env.MONGODB_URI;
let mongoClient = null, db = null;
async function upsertLobbyMeta(name, changes){
  if (useMongo) await db.collection('lobbies').updateOne({name},{ $set:{name, ...changes}}, {upsert:true});
}

// ===== Helpers =====
const nowISO = () => new Date().toISOString();
const safe = (s, max=120) => String(s ?? '').trim().slice(0, max);
const clamp = (n, a, b) => Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : a;
const randId = (p='id') => `${p}_${crypto.randomUUID()}`;

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
  const expected=Buffer.from(hashHex,'hex');
  return expected.length===test.length && crypto.timingSafeEqual(expected,test);
};

// ===== Dice =====
const DICE_ADV = /^(\d*)d(\d+)(k[hl](\d+))?([+\-]\d+)?$/i;
function rollAdvanced(exprRaw) {
  const expr = safe(exprRaw, 40).replace(/\s+/g,'').toLowerCase();
  if (expr === 'adv' || expr === 'd20adv') return rollAdvanced('2d20kh1');
  if (expr === 'dis' || expr === 'd20dis') return rollAdvanced('2d20kl1');
  const m = expr.match(DICE_ADV);
  if (!m) throw new Error('Invalid dice. Try d20, 3d6+2, 4d6kh3, adv/dis.');
  const count = parseInt(m[1] || '1', 10);
  const sides = parseInt(m[2], 10);
  const keepMode = m[3]?.slice(1,2); const keepN = m[4] ? parseInt(m[4],10) : null;
  const mod = m[5] ? parseInt(m[5], 10) : 0;
  if (count < 1 || sides < 1 || count > 100 || sides > 1000) throw new Error('Too big (<=100 dice, <=1000 sides).');
  if (keepN !== null && (keepN < 1 || keepN > count)) throw new Error('Keep out of range.');
  const rolls = Array.from({length:count}, () => crypto.randomInt(1,sides+1));
  let used = [...rolls];
  if (keepMode && keepN) { used.sort((a,b)=> keepMode==='h'? b-a : a-b); used = used.slice(0, keepN); }
  const total = used.reduce((a,b)=>a+b,0) + mod;
  return { expression: exprRaw, rolls, used, modifier: mod, total };
}

// ===== In-memory state & defaults =====
const memory = { lobbies: new Map(), sessions:new Map() };
const STATE_FILE=process.env.DND_STATE_FILE || path.join(__dirname,'.data','lobbies.json');
let saving=Promise.resolve(),saveTimer;
const persist=()=>{
  if(saveTimer)return;
  saveTimer=setTimeout(()=>{
    saveTimer=null;
    saving=saving.then(()=>writeState(STATE_FILE,{lobbies:memory.lobbies,sessions:memory.sessions})).catch(e=>console.error('Lobby persistence failed:',e.message));
  },100);
};
const completeConsent=(L,room)=>{
  const pending=L.settings.consent.pending;
  if(!pending || ![...L.users.values()].filter(u=>u.name!==L.gm).every(u=>pending.approvals.has(u.name)))return;
  if(L.campaign.scenes.some(s=>s.id===pending.to))L.campaign.currentSceneId=pending.to;
  L.settings.consent.pending=null;io.to('dnd:'+room).emit('campaign_state',L.campaign);
};
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
      identities:new Map(),
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
    try {const docs = await db.collection('lobbies').find({}, { projection:{_id:0,name:1}}).toArray();return res.json(docs.map(d=>d.name));}
    catch {return res.status(503).json({error:'Lobby database unavailable'});}
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
  const supplied=socket.handshake.auth?.resumeToken;
  const sessionToken=typeof supplied==='string' && memory.sessions.has(supplied)?supplied:crypto.randomBytes(32).toString('hex');
  const session=memory.sessions.get(sessionToken) || {name:'Anon',lobby:null,lastSeen:Date.now()};
  memory.sessions.set(sessionToken,session);
  let username=session.name;
  let lobby=null;
  socket.emit('session',{resumeToken:sessionToken});
  let count=0,windowStart=Date.now();
  let eventQueue=Promise.resolve();
  const on=(event,handler)=>socket.on(event,(payload)=>{
    if(Date.now()-windowStart>10000){windowStart=Date.now();count=0;}
    if(++count>300){socket.emit('error_message','Too many requests. Please slow down.');return;}
    if(lobby && !memory.lobbies.get(lobby)?.users.has(socket.id)){lobby=null;session.lobby=null;}
    eventQueue=eventQueue.then(()=>{if(lobby && !memory.lobbies.get(lobby)?.users.has(socket.id)){lobby=null;session.lobby=null;}if(!socket.connected)return;return handler(payload && typeof payload==='object'?payload:{});}).catch(e=>{console.error('Socket request failed:',e.message);socket.emit('error_message',e.message || 'Request failed.');}).finally(()=>{session.lastSeen=Date.now();persist();});
  });

  const emitState = () => {
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const users = [...L.users.values()].map(u => u.name);
    io.to('dnd:'+lobby).emit('state', {
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
      tabletop:tabletop.publicTabletop(L),
      pendingChoice:L.settings.consent.pending?{...L.settings.consent.pending,approvals:[...L.settings.consent.pending.approvals]}:null,
    });
    const gmSocket=[...L.users.entries()].find(([,u])=>u.name===L.gm)?.[0];
    if(gmSocket)io.to(gmSocket).emit('gm_private',{notes:tabletop.ensureTabletop(L).gmNotes || ''});
  };
  const emitMap = () => { if (!lobby) return; const L = ensureLobby(lobby); io.to('dnd:'+lobby).emit('map_state', L.map); };
  const joinOk = (L, name) => !L.bans.has((name||'').toLowerCase());
  const uniqueName = (L, base) => {
    let nm = base || 'Anon';
    const reserved=name => (L.identities.get(name) && L.identities.get(name)!==sessionToken) || [...L.users.entries()].some(([id,u])=>id!==socket.id && u.name===name && L.identities.get(name)!==sessionToken);
    if (!reserved(nm)) return nm;
    let i=2; while(reserved(`${base.slice(0,20)}${i}`))i++;
    base=base.slice(0,20);
    return `${base}${i}`;
  };

  on('identify', ({name})=>{ if(lobby){socket.emit('error_message','Leave the lobby before changing your name.');return;} username=safe(name || 'Anon',24);session.name=username;socket.emit('identified',{username}); });

  on('join_lobby', async ({ lobby: lobbyName, password })=>{
    lobbyName = safe(lobbyName || 'tavern', 40) || 'tavern';
    if(!memory.lobbies.has(lobbyName) && memory.lobbies.size>=100){socket.emit('error_message','Lobby limit reached.');return;}
    if(typeof password!=='string' && password!=null){socket.emit('error_message','Invalid password.');return;}
    if(password?.length>128){socket.emit('error_message','Password is too long.');return;}
    const L = ensureLobby(lobbyName);
    if(L.users.size>=16 && !L.users.has(socket.id)){socket.emit('error_message','Lobby is full.');return;}
    if (!joinOk(L, username)) { socket.emit('error_message','You are banned from this lobby.'); return; }
    const returning=L.identities.get(username)===sessionToken;
    if (L.passwordHash && !returning && (!password || !verifyPass(password,L.passwordHash))) {
      socket.emit('error_message','Lobby is locked (wrong password).');return;
    }
    if(lobby && lobby!==lobbyName){
      const previous=memory.lobbies.get(lobby);previous?.users.delete(socket.id);socket.leave('dnd:'+lobby);
      if(previous)io.to('dnd:'+lobby).emit('system',`${username} left`);
      emitState();
    }
    username=uniqueName(L,username);
    L.identities.set(username,sessionToken);
    if(!L.gm)L.gm=username;
    if(!L.passwordHash && password){
      if(L.gm!==username){socket.emit('error_message','Only the GM can set a password.');return;}
      L.passwordHash=hashPass(password);
      await upsertLobbyMeta(lobbyName,{password:true,gm:L.gm});
    }
    lobby=lobbyName;session.name=username;session.lobby=lobby;
    for(const [sid,u] of L.users)if(sid!==socket.id && u.name===username){
      L.users.delete(sid);io.sockets.sockets.get(sid)?.disconnect(true);
    }
    L.users.set(socket.id,{name:username});socket.join('dnd:'+lobby);
    socket.emit('identified',{username});
    const history = { messages: L.messages.slice(-40), rolls: L.rolls.slice(-40) };
    socket.emit('joined', { lobby, username, history, gm: L.gm, settings: {campaignStarted:L.settings.campaignStarted,requireCharacter:L.settings.requireCharacter} });
    io.to('dnd:'+lobby).emit('system', `${username} joined ${lobby}`);

    if (L.settings.requireCharacter && !L.characters.has(username)) {
      io.to(socket.id).emit('character_required', { reason: 'GM requires a character before playing.' });
    }

    emitState(); emitMap();
  });

  const isLockedForPlayers = (L) => L.settings.lockedUntilStart && !L.settings.campaignStarted;
  const isGM = (L) => L.gm === username && L.identities.get(username)===sessionToken && L.users.has(socket.id);

  // ===== Chat & Roll =====
  on('chat', async ({text})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const msg = safe(text, 500);
    if (!msg) return;
    if (msg.startsWith('/')) { await handleCommand(L, msg); return; }
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const payload = { user: username, text: msg, ts: nowISO() };
    io.to('dnd:'+lobby).emit('chat', payload);
    L.messages.push(payload);if(L.messages.length>200)L.messages.shift();
  });

  on('roll', async ({expression})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    try{
      const res = rollAdvanced(expression || 'd20');
      const payload = { user: username, ...res, ts: nowISO(), lobby };
      io.to('dnd:'+lobby).emit('roll', payload);
      L.rolls.push(payload);if(L.rolls.length>200)L.rolls.shift();
    }catch(e){ socket.emit('error_message', e.message || 'Bad dice expression.'); }
  });

  // ===== Characters =====
  on('character_upsert', (sheet)=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if(!sheet || typeof sheet!=='object'){socket.emit('error_message','Invalid character.');return;}
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
      speed: clamp(parseInt(sheet.speed ?? 30,10), 0, 120),
      profs: safe(sheet.profs, 200),
      traits: safe(sheet.traits, 800),
      class: safe(sheet.class, 24),
      level: clamp(parseInt(sheet.level || 1,10)||1, 1, 20),
      ac: clamp(parseInt(sheet.ac || 10,10)||10, 1, 30),
      hp: clamp(parseInt(sheet.hp ?? 10,10), 0, 1000),
      maxHp: clamp(parseInt(sheet.maxHp || 10,10)||10, 1, 1000),
      notes: safe(sheet.notes, 2000),
      abilities,
      updatedAt: nowISO(),
    };
    sanitized.hp=Math.min(sanitized.hp,sanitized.maxHp);
    L.characters.set(target, sanitized);
    io.to('dnd:'+lobby).emit('system', `${username} updated ${target}'s sheet`);
    io.to('dnd:'+lobby).emit('characters', Object.fromEntries([...L.characters.entries()]));
    emitState();
  });

  on('character_delete', ({name})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const target = safe(name || username, 24);
    const gm = isGM(L);
    if (!gm && target !== username) { socket.emit('error_message','You can only remove your own sheet.'); return; }
    L.characters.delete(target);
    io.to('dnd:'+lobby).emit('system', `${username} removed ${target}'s sheet`);
    io.to('dnd:'+lobby).emit('characters', Object.fromEntries([...L.characters.entries()]));
    emitState();
  });

  // ===== Map =====
  on('map_request', ()=> { if (lobby) emitMap(); });

  on('map_init', ({w,h})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    w = clamp(parseInt(w||20,10)||20, 5, 60);
    h = clamp(parseInt(h||20,10)||20, 5, 60);
    L.map = { w, h, tiles: Array.from({length:h},()=>Array(w).fill(0)), tokens: {} };
    io.to('dnd:'+lobby).emit('system', `Map set to ${w}×${h}`);
    emitMap();
  });

  on('map_set', ({x,y,val})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const {w,h} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    if (!Array.isArray(L.map.tiles[y])) return;
    L.map.tiles[y][x] = val ? 1 : 0;
    emitMap();
  });

  on('token_add', ({id,name,color})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const {w,h} = L.map;
    const tid = safe(id||`t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, 40);
    if(['__proto__','constructor','prototype'].includes(tid) || !/^[a-zA-Z0-9_-]+$/.test(tid)){socket.emit('error_message','Invalid token ID.');return;}
    if(Object.hasOwn(L.map.tokens,tid)){socket.emit('error_message','Token ID already exists.');return;}
    if(Object.keys(L.map.tokens).length>=100){socket.emit('error_message','Map token limit reached.');return;}
    const nm = safe(name || username, 24);
    let x=0,y=0;
    outer: for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) {
      if ((L.map.tiles[yy]?.[xx] ?? 0)===0 && !Object.values(L.map.tokens).some(t=>t.x===xx&&t.y===yy)) { x=xx; y=yy; break outer; }
    }
    L.map.tokens[tid] = { id:tid, name:nm, x, y, color: safe(color||'#222', 16), owner: username };
    emitMap();
  });

  on('token_move', ({id,x,y})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const tok = Object.hasOwn(L.map.tokens,id)?L.map.tokens[id]:null;
    if (!tok) return;
    if (!isGM(L) && tok.owner !== username) { socket.emit('error_message','Only owner or GM can move this token.'); return; }
    const {w,h,tiles} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    if ((tiles?.[y]?.[x] ?? 0)===1) return; // wall
    tok.x = x; tok.y = y;
    emitMap();
  });

  on('token_remove', ({id})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const tok = Object.hasOwn(L.map.tokens,id)?L.map.tokens[id]:null;
    if (!tok) return;
    if (!isGM(L) && tok.owner !== username) return;
    delete L.map.tokens[id];
    emitMap();
  });

  on('map_clear', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const {w,h} = L.map;
    L.map.tiles = Array.from({length:h},()=>Array(w).fill(0));
    emitMap();
  });

  on('ping', ({x,y})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (isLockedForPlayers(L) && !isGM(L)) { socket.emit('error_message','Campaign not started by GM yet.'); return; }
    const {w,h} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    io.to('dnd:'+lobby).emit('map_ping', { x, y, by: username, ts: nowISO() });
  });

  // ===== Campaign: load / start / consent =====
  on('campaign_load', async ({ key }) => {
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
    io.to('dnd:'+lobby).emit('system', `GM loaded campaign: ${L.campaign.title}`);
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
    emitState();
  });

  on('campaign_get', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    socket.emit('campaign_state', L.campaign);
  });

  on('campaign_start', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (L.settings.campaignStarted) { socket.emit('error_message','Campaign already started.'); return; }
    L.settings.campaignStarted = true;L.campaign.started=true;
    io.to('dnd:'+lobby).emit('system', 'GM started the campaign!');
    io.to('dnd:'+lobby).emit('campaign_started', { sceneId: L.campaign.currentSceneId });
    for (const [sid, u] of L.users.entries()){
      if (!L.characters.has(u.name)) io.to(sid).emit('character_required', { reason: 'campaign_started' });
    }
    emitState();
  });

  on('campaign_update_meta', ({title, summary})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (title) L.campaign.title = safe(title, 120);
    if (summary != null) L.campaign.summary = safe(summary, 2000);
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_scene_add', ({title, content})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const scene = { id: randId('scn'), title: safe(title||'New Scene',120), content: safe(content||'', 4000), choices: [] };
    if(L.campaign.scenes.length>=100){socket.emit('error_message','Scene limit reached.');return;}
    L.campaign.scenes.push(scene);
    if (!L.campaign.currentSceneId) L.campaign.currentSceneId = scene.id;
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_scene_set', ({sceneId})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (L.campaign.scenes.some(s=>s.id===sceneId)){
      L.campaign.currentSceneId = sceneId;
      io.to('dnd:'+lobby).emit('system', `Scene changed to: ${sceneId}`);
      io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
    }
  });

  on('campaign_choice_add', ({sceneId, text, to})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const scene = L.campaign.scenes.find(s=>s.id===sceneId);
    if (!scene) return;
    if(!L.campaign.scenes.some(s=>s.id===to)){socket.emit('error_message','Destination scene not found.');return;}
    if(scene.choices.length>=30){socket.emit('error_message','Choice limit reached.');return;}
    scene.choices.push({ id: randId('ch'), text: safe(text||'Choice', 200), to: safe(to||'', 120) });
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_handout_add', ({title, content})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if(L.campaign.handouts.length>=100)return;
    L.campaign.handouts.push({ id: randId('hd'), title: safe(title||'Handout',120), content: safe(content||'', 4000) });
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_quest_add', ({title})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if(L.campaign.quests.length>=100)return;
    L.campaign.quests.push({ id: randId('q'), title: safe(title||'Quest', 200), done: false });
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_quest_toggle', ({id})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const q = L.campaign.quests.find(q=>q.id===id);
    if (!q) return;
    q.done = !q.done;
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('campaign_note_add', ({text})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const t = safe(text, 1000);
    if (!t) return;
    L.campaign.notes.push({ by: username, text: t, ts: nowISO() });
    if(L.campaign.notes.length>200)L.campaign.notes.shift();
    io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
  });

  on('tabletop_hp',({name,delta})=>{if(!lobby)return;const L=ensureLobby(lobby);tabletop.adjustHP(L,username,safe(name,24),Number(delta),isGM(L));emitState();});
  on('inventory_add',({name,item})=>{if(!lobby)return;const L=ensureLobby(lobby);tabletop.inventoryAdd(L,username,safe(name,24),item,isGM(L));emitState();});
  on('inventory_remove',({name,id})=>{if(!lobby)return;const L=ensureLobby(lobby);tabletop.inventoryRemove(L,username,safe(name,24),id,isGM(L));emitState();});
  on('condition_toggle',({name,condition,duration})=>{if(!lobby)return;const L=ensureLobby(lobby);tabletop.setCondition(L,username,safe(name,24),condition,duration,isGM(L));emitState();});
  on('npc_add',({preset,name})=>{if(!lobby)return;const L=ensureLobby(lobby);if(!isGM(L))throw Error('GM only.');tabletop.addNPC(L,preset,name);emitState();});
  on('npc_remove',({name})=>{if(!lobby)return;const L=ensureLobby(lobby);if(!isGM(L))throw Error('GM only.');const state=tabletop.ensureTabletop(L);state.npcs.delete(name);state.inventories.delete(name);state.conditions.delete(name);const current=L.encounter.order[L.encounter.turnIndex]?.name;L.encounter.order=L.encounter.order.filter(e=>e.name!==name);L.encounter.turnIndex=Math.max(0,L.encounter.order.findIndex(e=>e.name===current));if(!L.encounter.order.length)L.encounter.active=false;emitState();});
  on('encounter_auto',()=>{if(!lobby)return;const L=ensureLobby(lobby);if(!isGM(L))throw Error('GM only.');tabletop.startEncounter(L);emitState();});
  on('encounter_advance',()=>{if(!lobby)return;const L=ensureLobby(lobby);tabletop.advanceEncounter(L,username,isGM(L));emitState();});
  on('combat_attack',({actor,target,ability,expression})=>{
    if(!lobby)return;const L=ensureLobby(lobby);
    const expr=safe(expression,30);if(!/^(?:[1-9]|10)d(?:[1-9]|[1-9][0-9]|100)(?:[+-](?:[0-9]|1[0-9]|20))?$/.test(expr))throw Error('Damage must use 1–10 dice, at most 100 sides, and a modifier up to 20.');
    const damage=Math.max(0,rollAdvanced(expr).total);
    const entry=tabletop.resolveAttack(L,username,safe(actor,24),safe(target,24),ability,damage,isGM(L),undefined,rollAdvanced(expr.replace(/[+-]\d+$/,'')).total);
    io.to('dnd:'+lobby).emit('combat_result',entry);emitState();
  });
  on('journal_add',({text})=>{if(!lobby)return;const L=ensureLobby(lobby);const value=safe(text,2000);if(!value)return;const state=tabletop.ensureTabletop(L);state.journal.push({id:crypto.randomUUID(),author:username,text:value,time:Date.now()});if(state.journal.length>100)state.journal.shift();emitState();});
  on('gm_notes',({text})=>{if(!lobby)return;const L=ensureLobby(lobby);if(!isGM(L))throw Error('GM only.');tabletop.ensureTabletop(L).gmNotes=safe(text,12000);socket.emit('gm_notes_saved');});
  on('map_generate',({kind,w,h})=>{if(!lobby)return;const L=ensureLobby(lobby);if(!isGM(L))throw Error('GM only.');L.map=tabletop.generateMap(kind,w,h);emitMap();});

  // ===== Slash-commands =====
  async function handleCommand(L, line){
    const [cmd, ...rest] = line.slice(1).split(' ');
    const argStr = rest.join(' ').trim();
    const gm = isGM(L);
    const send = (t)=> io.to('dnd:'+lobby).emit('system', t);

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
        L.settings.campaignStarted = true;L.campaign.started=true;
        send('GM started the campaign!');
        io.to('dnd:'+lobby).emit('campaign_started', { sceneId: L.campaign.currentSceneId });
        for (const [sid, u] of L.users.entries()){
          if (!L.characters.has(u.name)) io.to(sid).emit('character_required', { reason: 'campaign_started' });
        }
        emitState();
        break;
      }

      case 'me': {
        const text = argStr || 'does something dramatic';
        io.to('dnd:'+lobby).emit('chat', { user: username, text: `*${text}*`, ts: nowISO() });
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
          io.to('dnd:'+lobby).emit('roll', payload);
          L.rolls.push(payload);if(L.rolls.length>200)L.rolls.shift();
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
        if (!gm) { socket.emit('error_message','Only GM can change password.'); break; }
        if (!argStr) { socket.emit('error_message','Usage: /setpass <password>'); break; }
        L.passwordHash = hashPass(argStr);
        if (!L.gm) L.gm = username;
        await upsertLobbyMeta?.(lobby, { password:true, gm:L.gm, updatedAt: nowISO() });
        send('Lobby password set/updated.');
        emitState();
        break;
      }

      case 'gm': {
        if(!gm){socket.emit('error_message','GM only.');break;}
        const target=safe(argStr.replace(/^@/,''),24);
        if(![...L.users.values()].some(u=>u.name===target)){socket.emit('error_message','Player not found.');break;}
        L.gm=target;send(`${target} is now the GM.`);emitState();break;
      }
      case 'kick': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        const target = safe(argStr,24);
        const entry = [...L.users.entries()].find(([,u])=>u.name===target);
        if (!entry) { socket.emit('error_message','User not found'); break; }
        const [targetId] = entry;
        io.to(targetId).emit('error_message','You were kicked by the GM.');
        io.sockets.sockets.get(targetId)?.disconnect(true);
        L.users.delete(targetId);
        send(`${target} was kicked by the GM.`);
        emitState();
        break;
      }

      case 'ban': { if(!gm){socket.emit('error_message','GM only.');break;}const target=safe(argStr,24).toLowerCase();L.bans.add(target);for(const [sid,u] of L.users)if(u.name.toLowerCase()===target)io.sockets.sockets.get(sid)?.disconnect(true);send(`${target} is banned.`);emitState();break; }
      case 'unban': { if (!gm) { socket.emit('error_message','GM only.'); break; } L.bans.delete(safe(argStr,24).toLowerCase()); send(`${argStr} is unbanned.`); emitState(); break; }

      // Encounter
      case 'startencounter': {
        if (!gm) { socket.emit('error_message','GM only.'); break; }
        L.encounter={active:true,order:[],turnIndex:0,round:1};
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
        tabletop.advanceEncounter(L,username,gm);send(`Turn: ${L.encounter.order[L.encounter.turnIndex].name}`);emitState();break;
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
          if(L.campaign.scenes.length>=100){socket.emit('error_message','Scene limit reached.');return;}
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
        if (argStr.trim() === 'force') {const pending=L.settings.consent.pending;if(pending){L.campaign.currentSceneId=pending.to;L.settings.consent.pending=null;io.to('dnd:'+lobby).emit('campaign_state',L.campaign);emitState();}} else socket.emit('error_message','Use: /consent force');
        break;
      }

      default: socket.emit('error_message','Unknown command. Try /help');
    }
  }

  // Consent flow
  on('campaign_choice_request', ({choiceId})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    if (!L.settings.campaignStarted) { socket.emit('error_message','Start campaign first.'); return; }

    const scene = L.campaign.scenes.find(s=>s.id===L.campaign.currentSceneId);
    if (!scene) return;
    const choice = scene.choices.find(c=>c.id===choiceId);
    if (!choice || !L.campaign.scenes.some(s=>s.id===choice.to)) { socket.emit('error_message','Choice has no valid destination.'); return; }

    L.settings.consent.pending = { choiceId: choice.id, text: choice.text, to: choice.to, approvals: new Set(), requestedAt: Date.now() };

    const players = [...L.users.values()].map(u=>u.name).filter(n => n !== L.gm);
    io.to('dnd:'+lobby).emit('campaign_choice_requested', { sceneId: scene.id, choiceId: choice.id, text: choice.text, to: choice.to, requestedBy: username, players });
    if(!players.length){L.campaign.currentSceneId=choice.to;L.settings.consent.pending=null;io.to('dnd:'+lobby).emit('campaign_state',L.campaign);}
    emitState();
  });

  on('campaign_choice_ack', ()=>{
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
        io.to('dnd:'+lobby).emit('system', `Choice accepted: ${pending.text}`);
        io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
      }
      L.settings.consent.pending = null;
      emitState();
    }
  });

  on('campaign_choice_force', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    if (!isGM(L)) { socket.emit('error_message','GM only.'); return; }
    const pending = L.settings.consent.pending;
    if (!pending) return;
    const target = L.campaign.scenes.find(s=>s.id===pending.to);
    if (target) {
      L.campaign.currentSceneId = target.id;
      io.to('dnd:'+lobby).emit('system', `GM forced proceed: ${pending.text}`);
      io.to('dnd:'+lobby).emit('campaign_state', L.campaign);
    }
    L.settings.consent.pending = null;
    emitState();
  });

  on('leave_lobby',()=>{
    if(!lobby)return;
    const L=ensureLobby(lobby);L.users.delete(socket.id);completeConsent(L,lobby);emitState();socket.leave('dnd:'+lobby);
    session.lobby=null;lobby=null;socket.emit('left_lobby');
  });
  on('campaign_export',()=>{if(lobby)socket.emit('campaign_exported',ensureLobby(lobby).campaign);});
  on('campaign_import',({campaign})=>{
    if(!lobby)return;
    const L=ensureLobby(lobby);if(!isGM(L)){socket.emit('error_message','GM only.');return;}
    L.campaign=validateCampaign(campaign);L.settings.campaignStarted=false;L.settings.consent.pending=null;
    io.to('dnd:'+lobby).emit('campaign_state',L.campaign);emitState();
  });
  if(session.lobby){socket.emit('resume_lobby',{lobby:session.lobby,name:session.name});}

  // ===== On disconnect =====
  socket.on('disconnect', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    L.users.delete(socket.id);
    completeConsent(L,lobby);
    io.to('dnd:'+lobby).emit('system', `${username} left`);
    emitState();persist();
  });
});

// ===== Optional Mongo + Boot =====
(async ()=>{
  const saved=await readState(STATE_FILE);
  if(saved){memory.lobbies=saved.lobbies;memory.sessions=saved.sessions;for(const L of memory.lobbies.values()){L.identities ??= new Map();L.settings.consent.pending=null;}}
  await loadCampaignRegistry();
  if (useMongo) {
    try {
      mongoClient = new MongoClient(process.env.MONGODB_URI, { ignoreUndefined: true });
      await mongoClient.connect();
      db = mongoClient.db(process.env.MONGODB_DB || 'dnd');
      console.log('Mongo connected');
    } catch (e) {
      console.error('Mongo connection failed (using local persistence):', e.message);useMongo=false;
    }
  }
  server.listen(PORT, ()=> console.log(`Server on ${PORT}`));
})().catch(error=>{console.error('Startup failed:',error.message);process.exitCode=1;});