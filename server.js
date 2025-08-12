import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import { MongoClient } from 'mongodb';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import crypto from 'crypto';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
// Serve index at root
app.get('/', (req, res) => res.sendFile(process.cwd() + '/public/index.html'));

// SPA fallback (optional, useful for client-side routing)
app.get('*', (req, res) => res.sendFile(process.cwd() + '/public/index.html'));


const PORT = process.env.PORT || 10000;
const useMongo = !!process.env.MONGODB_URI;
let mongoClient = null, db = null;

// ---------------- Rate limiting ----------------
const limiter = new RateLimiterMemory({ points: 20, duration: 3 });
const limitSocket = async (socket, key='generic') => {
  try { await limiter.consume(`${socket.handshake.address}:${key}`); }
  catch { socket.emit('error_message', 'Rate limited—try again in a moment.'); throw new Error('rate'); }
};

// ---------------- Helpers ----------------
const nowISO = () => new Date().toISOString();
const safe = (s, max=120) => String(s ?? '').trim().slice(0, max);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

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

// ---------------- Dice ----------------
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

// ---------------- State ----------------
const memory = {
  lobbies: new Map(),
};

/* Lobby structure:
{
  createdAt, gm, passwordHash?, bans:Set, users:Map<sid,{name}>
  macros: Map<username, Map<macro,expr>>,
  messages:[], rolls:[],
  characters: Map<characterName, sheet>,
  encounter: { active, order:[{name, init}], turnIndex },
  map: { w, h, tiles: number[][] (0=open,1=wall), tokens: Record<id,{id,name,x,y,color,owner}> }
}
*/
const defaultMap = () => ({ w: 20, h: 20, tiles: Array.from({length:20}, () => Array(20).fill(0)), tokens: {} });

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
    });
  }
  return memory.lobbies.get(name);
}

// ---------------- Persistence helpers ----------------
async function persist(col, doc){ if (useMongo) await db.collection(col).insertOne(doc); }
async function upsertLobbyMeta(name, changes){ if (useMongo) await db.collection('lobbies').updateOne({name},{ $set:{name, ...changes}}, {upsert:true}); }

// ---------------- REST ----------------
app.get('/health', (req,res)=> res.json({ok:true, useMongo}));
app.get('/lobbies', async (req,res)=>{
  if (useMongo) {
    const docs = await db.collection('lobbies').find({}, { projection:{_id:0,name:1}}).toArray();
    return res.json(docs.map(d=>d.name));
  }
  res.json([...memory.lobbies.keys()]);
});

// ---------------- Sockets ----------------
io.on('connection', (socket)=>{
  let username = 'Anon';
  let lobby = null;

  const emitState = () => {
    if (!lobby) return;
    const L = ensureLobby(lobby);
    io.to(lobby).emit('state', {
      users: [...L.users.values()].map(u=>u.name),
      gm: L.gm,
      characters: Object.fromEntries([...L.characters.entries()]),
      encounter: L.encounter
    });
  };
  const emitMap = () => {
    if (!lobby) return;
    const L = ensureLobby(lobby);
    io.to(lobby).emit('map_state', L.map);
  };
  const joinOk = (L, name) => !L.bans.has((name||'').toLowerCase());
  const uniqueName = (L, base) => {
    let nm = base || 'Anon';
    if (![...L.users.values()].some(u => u.name === nm)) return nm;
    let i=2; while ([...L.users.values()].some(u=>u.name===`${base}${i}`)) i++;
    return `${base}${i}`;
  };

  socket.on('identify', ({name})=>{
    username = safe(name || 'Anon', 24);
    socket.emit('identified', { username });
  });

  socket.on('join_lobby', async ({ lobby: lobbyName, password })=>{
    try{
      await limitSocket(socket,'join');
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
      socket.emit('joined', { lobby, history, gm: L.gm });
      io.to(lobby).emit('system', `${username} joined ${lobby}`);
      emitState();
      emitMap();
      if (useMongo) await upsertLobbyMeta(lobby, { updatedAt: nowISO() });
    }catch{}
  });

  // ---------- Chat & Roll ----------
  socket.on('chat', async ({text})=>{
    try{
      await limitSocket(socket,'chat');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const msg = safe(text, 500);
      if (!msg) return;

      if (msg.startsWith('/')) { await handleCommand(L, msg); return; }

      const payload = { user: username, text: msg, ts: nowISO() };
      io.to(lobby).emit('chat', payload);
      L.messages.push(payload);
      if (useMongo) await persist('messages', { lobby, ...payload });
    }catch{}
  });

  socket.on('roll', async ({expression})=>{
    try{
      await limitSocket(socket,'roll');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const userMacros = L.macros.get(username) || new Map();
      const expr = userMacros.get(safe(expression,50)) || expression || 'd20';
      const res = rollAdvanced(expr);
      const payload = { user: username, ...res, ts: nowISO(), lobby };
      io.to(lobby).emit('roll', payload);
      L.rolls.push(payload);
      if (useMongo) await persist('rolls', payload);
    }catch(e){ socket.emit('error_message', e.message || 'Bad dice expression.'); }
  });

  // ---------- Character upsert/delete ----------
  socket.on('character_upsert', async (sheet)=>{
    try{
      await limitSocket(socket,'char');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const isGM = L.gm === username;
      const target = safe(sheet?.name || username, 24);
      if (!isGM && target !== username) return;

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
      if (useMongo) await upsertLobbyMeta(lobby, { updatedAt: nowISO() });
      emitState();
    }catch{}
  });

  socket.on('character_delete', async ({name})=>{
    try{
      await limitSocket(socket,'char');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const target = safe(name || username, 24);
      const isGM = L.gm === username;
      if (!isGM && target !== username) return;
      L.characters.delete(target);
      io.to(lobby).emit('system', `${username} removed ${target}'s sheet`);
      io.to(lobby).emit('characters', Object.fromEntries([...L.characters.entries()]));
      emitState();
    }catch{}
  });

  // ---------- Mini-map events ----------
  socket.on('map_request', ()=> { if (lobby) emitMap(); });

  socket.on('map_init', async ({w,h})=>{
    try{
      await limitSocket(socket,'map');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      if (L.gm !== username) { socket.emit('error_message','GM only.'); return; }
      w = clamp(parseInt(w||20,10)||20, 5, 60);
      h = clamp(parseInt(h||20,10)||20, 5, 60);
      L.map = { w, h, tiles: Array.from({length:h},()=>Array(w).fill(0)), tokens: {} };
      io.to(lobby).emit('system', `Map set to ${w}×${h}`);
      emitMap();
    }catch{}
  });

  socket.on('map_set', async ({x,y,val})=>{
    try{
      await limitSocket(socket,'map');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      if (L.gm !== username) { socket.emit('error_message','GM only.'); return; }
      const {w,h} = L.map;
      x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
      L.map.tiles[y][x] = val ? 1 : 0;
      emitMap();
    }catch{}
  });

  socket.on('token_add', async ({id,name,color})=>{
    try{
      await limitSocket(socket,'map');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const {w,h} = L.map;
      const tid = safe(id||`t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, 40);
      const nm = safe(name || username, 24);
      let x=0,y=0;
      outer: for (let yy=0; yy<h; yy++) for (let xx=0; xx<w; xx++) {
        if (L.map.tiles[yy][xx]===0 && !Object.values(L.map.tokens).some(t=>t.x===xx&&t.y===yy)) { x=xx; y=yy; break outer; }
      }
      L.map.tokens[tid] = { id:tid, name:nm, x, y, color: safe(color||'#222', 16), owner: username };
      emitMap();
    }catch{}
  });

  socket.on('token_move', async ({id,x,y})=>{
    try{
      await limitSocket(socket,'map');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const tok = L.map.tokens?.[id];
      if (!tok) return;
      const isGM = L.gm === username;
      if (!isGM && tok.owner !== username) { socket.emit('error_message','Only owner or GM can move this token.'); return; }
      const {w,h,tiles} = L.map;
      x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
      if (tiles[y][x]===1) return; // wall
      tok.x = x; tok.y = y;
      emitMap();
    }catch{}
  });

  socket.on('token_remove', async ({id})=>{
    try{
      await limitSocket(socket,'map');
      if (!lobby) return;
      const L = ensureLobby(lobby);
      const tok = L.map.tokens?.[id];
      if (!tok) return;
      const isGM = L.gm === username;
      if (!isGM && tok.owner !== username) return;
      delete L.map.tokens[id];
      emitMap();
    }catch{}
  });

  socket.on('map_clear', async ()=>{
    try{
      await limitSocket(socket,'map');
    if (!lobby) return;
      const L = ensureLobby(lobby);
      if (L.gm !== username) { socket.emit('error_message','GM only.'); return; }
      const {w,h} = L.map;
      L.map.tiles = Array.from({length:h},()=>Array(w).fill(0));
      emitMap();
    }catch{}
  });

  socket.on('ping', ({x,y})=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    const {w,h} = L.map;
    x = clamp(parseInt(x,10)||0, 0, w-1); y = clamp(parseInt(y,10)||0, 0, h-1);
    io.to(lobby).emit('map_ping', { x, y, by: username, ts: nowISO() });
  });

  // ---------- Commands ----------
  async function handleCommand(L, line){
    const [cmd, ...rest] = line.slice(1).split(' ');
    const argStr = rest.join(' ').trim();
    const isGM = L.gm === username;
    const send = (t)=> io.to(lobby).emit('system', t);

    switch ((cmd||'').toLowerCase()){
      case 'help':
        socket.emit('system',
          'Commands: /help, /me <action>, /w @name <msg>, /roll <expr>, /macro add name=expr | del name | list, ' +
          '/setpass <pass> (GM on first set), /kick <name>, /ban <name>, /unban <name>, /gm <msg>, ' +
          '/startencounter, /setinit <name> <n>, /next, /endencounter.  Map: use the Map tab (GM can draw).'
        );
        break;
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
        const res = rollAdvanced(argStr || 'd20');
        const payload = { user: username, ...res, ts: nowISO(), lobby };
        io.to(lobby).emit('roll', payload);
        L.rolls.push(payload);
        if (useMongo) await persist('rolls', payload);
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
        if (L.passwordHash && !isGM) { socket.emit('error_message','Only GM can change password.'); break; }
        if (!argStr) { socket.emit('error_message','Usage: /setpass <password>'); break; }
        L.passwordHash = hashPass(argStr);
        if (!L.gm) L.gm = username;
        await upsertLobbyMeta(lobby, { password:true, gm:L.gm, updatedAt: nowISO() });
        send('Lobby password set/updated.'); emitState(); break;
      }
      case 'gm': { if (!isGM) { socket.emit('error_message','GM only.'); break; } send(`[GM] ${argStr}`); break; }
      case 'kick': {
        if (!isGM) { socket.emit('error_message','GM only.'); break; }
        const target = safe(argStr,24);
        const entry = [...L.users.entries()].find(([,u])=>u.name===target);
        if (!entry) { socket.emit('error_message','User not found'); break; }
        const [targetId] = entry;
        io.to(targetId).emit('error_message','You were kicked by the GM.');
        io.sockets.sockets.get(targetId)?.leave(lobby);
        L.users.delete(targetId);
        send(`${target} was kicked by the GM.`); emitState(); break;
      }
      case 'ban':  { if (!isGM) { socket.emit('error_message','GM only.'); break; } L.bans.add(safe(argStr,24).toLowerCase()); send(`${argStr} is banned.`); emitState(); break; }
      case 'unban':{ if (!isGM) { socket.emit('error_message','GM only.'); break; } L.bans.delete(safe(argStr,24).toLowerCase()); send(`${argStr} is unbanned.`); emitState(); break; }
      case 'startencounter': { if (!isGM) { socket.emit('error_message','GM only.'); break; } L.encounter={active:true,order:[],turnIndex:0}; send('Encounter started. Use /setinit <name> <n>.'); emitState(); break; }
      case 'setinit': {
        if (!isGM) { socket.emit('error_message','GM only.'); break; }
        const m = argStr.match(/^(\S+)\s+(-?\d+)$/);
        if (!m) { socket.emit('error_message','Usage: /setinit <name> <number>'); break; }
        const name = m[1], init = Number(m[2]);
        const i = L.encounter.order.findIndex(o=>o.name===name);
        if (i>=0) L.encounter.order[i].init = init; else L.encounter.order.push({name,init});
        L.encounter.order.sort((a,b)=>b.init-a.init);
        send(`Initiative set: ${name} → ${init}`); emitState(); break;
      }
      case 'next': { if (!isGM) { socket.emit('error_message','GM only.'); break; }
        if (!L.encounter.active || L.encounter.order.length===0) { socket.emit('error_message','No active encounter.'); break; }
        L.encounter.turnIndex = (L.encounter.turnIndex+1) % L.encounter.order.length;
        send(`Turn: ${L.encounter.order[L.encounter.turnIndex].name}`); emitState(); break;
      }
      case 'endencounter': { if (!isGM) { socket.emit('error_message','GM only.'); break; } L.encounter={active:false,order:[],turnIndex:0}; send('Encounter ended.'); emitState(); break; }
      default: socket.emit('error_message','Unknown command. Try /help');
    }
  }

  socket.on('disconnect', ()=>{
    if (!lobby) return;
    const L = ensureLobby(lobby);
    L.users.delete(socket.id);
    io.to(lobby).emit('system', `${username} left`);
    emitState();
  });
});

// ---------------- Start ----------------
async function start(){
  if (useMongo){
    mongoClient = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 10 });
    await mongoClient.connect();
    db = mongoClient.db(process.env.MONGODB_DB || 'dnd');
    await db.collection('lobbies').createIndex({ name: 1 }, { unique: true }).catch(()=>{});
    await db.collection('messages').createIndex({ lobby: 1, ts: -1 });
    await db.collection('rolls').createIndex({ lobby: 1, ts: -1 });
    console.log('Connected to MongoDB');
  } else {
    console.log('Running with in-memory storage.');
  }
  server.listen(PORT, ()=> console.log(`Server on ${PORT}`));
}
start().catch(e=>{ console.error(e); process.exit(1); });
