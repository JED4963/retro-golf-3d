// Retro Golf 3D - the online match server.
// It serves the game page (index.html in this folder, a copy of "Retro Golf 3D.html") and runs the rooms for online
// matches: up to 4 real players play the same holes at the same time and see each other on the course.
// No installs needed: it only uses what comes with Node.js.   Start it with:   node server.js
// It keeps nothing on disk and knows nothing about the players except the golfer name they typed and how their golfer looks.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = Number(process.env.PORT) || 8791;
const GAME_FILE = path.join(__dirname, 'index.html');
const MAX_PLAYERS = 4, STALE_MS = 12000, EMPTY_ROOM_MS = 60000, MAX_BODY = 6000, MAX_ROOMS = 300, SYNC_MS = 200;
const COURSES = 11, WEATHERS = 6, HOLE_SETS = [3, 6, 9];

// ---------- the game page ----------
let page = null, pageZip = null;
function loadGame() { try { page = fs.readFileSync(GAME_FILE); pageZip = zlib.gzipSync(page); } catch (e) { page = null; pageZip = null; } }
loadGame();
try { const w = fs.watchFile(GAME_FILE, { interval: 4000 }, loadGame); if (w && w.unref) w.unref(); } catch (e) {}

// ---------- small helpers ----------
const now = () => Date.now();
const hex = n => crypto.randomBytes(n).toString('hex');
const num = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
const int = (v, lo, hi, d = 0) => Math.round(num(v, lo, hi, d));
// a golfer name: capital letters, numbers and spaces only, at most 12 long (nothing else can be typed to other players)
const cleanName = v => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12) || 'GOLFER';
// how a golfer looks: a few short words / colours, nothing else
function cleanLook(v) {
  const out = {}; if (!v || typeof v !== 'object') return out; let n = 0;
  for (const k of Object.keys(v)) {
    if (n >= 20 || !/^[a-zA-Z0-9]{1,12}$/.test(k)) continue;
    const x = v[k];
    if (typeof x === 'string' && x.length <= 20 && /^[#\w ]*$/.test(x)) { out[k] = x; n++; }
    else if (typeof x === 'number' && Number.isFinite(x)) { out[k] = x; n++; }
  }
  return out;
}
// what a player is doing right now (sent by their game about five times a second)
function cleanState(v) {
  if (!v || typeof v !== 'object') return null;
  const sc = Array.isArray(v.sc) ? v.sc.slice(0, 18).map(s => int(s, 1, 99, 9)) : [];
  return { hn: int(v.hn, 0, 17), st: int(v.st, 0, 99), sc, ph: int(v.ph, 0, 5),
    x: num(v.x, -3000, 3000), y: num(v.y, -3000, 3000), z: num(v.z, 0, 400), gx: num(v.gx, -3000, 3000), gy: num(v.gy, -3000, 3000),
    aim: num(v.aim, -100, 100), phi: num(v.phi, -4, 4), po: int(v.po, 0, 6), kd: int(v.kd, 0, 2), cl: int(v.cl, 0, 3) };
}

// ---------- rooms ----------
const rooms = new Map();   // code -> {code, pub, host, state:'lobby'|'play', seed, set:{ci,holes,weather}, players: Map(id -> player), emptyAt}
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let i = 0; i < 300; i++) { let c = ''; for (let k = 0; k < 4; k++) c += LETTERS[crypto.randomInt(LETTERS.length)]; if (!rooms.has(c)) return c; }
  return null;
}
function makeRoom(pub) {
  if (rooms.size >= MAX_ROOMS) return null; const code = newCode(); if (!code) return null;
  const room = { code, pub: !!pub, host: null, state: 'lobby', seed: 0, set: { ci: 0, holes: 3, weather: 0 }, players: new Map(), emptyAt: 0, round: 0 };
  rooms.set(code, room); return room;
}
function addPlayer(room, name, look) {
  const p = { id: hex(4), key: hex(12), name: cleanName(name), look: cleanLook(look), me: null, last: now(), round: 0 };
  // two players in one room never have exactly the same name on screen
  const names = new Set([...room.players.values()].map(q => q.name)); let n = p.name, k = 2; while (names.has(n)) n = (p.name.slice(0, 10) + ' ' + k++).trim(); p.name = n;
  room.players.set(p.id, p); if (!room.host) room.host = p.id; room.emptyAt = 0; return p;
}
function dropPlayer(room, id) {
  room.players.delete(id);
  if (room.host === id) room.host = room.players.size ? room.players.keys().next().value : null;
  if (!room.players.size) room.emptyAt = now();
}
function sweep() {
  const t = now();
  for (const room of rooms.values()) {
    for (const p of [...room.players.values()]) if (t - p.last > STALE_MS) dropPlayer(room, p.id);
    if (!room.players.size && (!room.emptyAt || t - room.emptyAt > EMPTY_ROOM_MS)) rooms.delete(room.code);
  }
}
setInterval(sweep, 3000).unref();
function view(room, you) {
  return { code: room.code, pub: room.pub, host: room.host, state: room.state, seed: room.seed, round: room.round, set: room.set, you, every: SYNC_MS, max: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, look: p.look, me: p.round === room.round ? p.me : null })) };
}
const fail = (status, err) => Object.assign(new Error(err), { status });

// ---------- what the game can ask for ----------
const api = {
  // join: {name, look, mode:'create'|'quick'|'join', code}
  join(b) {
    let room = null;
    if (b.mode === 'join') { room = rooms.get(String(b.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)); if (!room) throw fail(404, 'NO ROOM WITH THAT CODE'); }
    else if (b.mode === 'quick') { for (const r of rooms.values()) if (r.pub && r.state === 'lobby' && r.players.size > 0 && r.players.size < MAX_PLAYERS) { room = r; break; } if (!room) room = makeRoom(true); }
    else room = makeRoom(false);
    if (!room) throw fail(503, 'THE SERVER IS FULL. TRY AGAIN SOON');
    if (room.players.size >= MAX_PLAYERS) throw fail(409, 'THAT ROOM IS FULL');
    if (room.state !== 'lobby') throw fail(409, 'THAT MATCH HAS ALREADY STARTED');
    const p = addPlayer(room, b.name, b.look);
    return { id: p.id, key: p.key, room: view(room, p.id) };
  },
  // sync: {code, id, key, me, set (host), start (host), again (host)}
  sync(b) {
    const room = rooms.get(String(b.code || '')); if (!room) throw fail(404, 'THE ROOM HAS CLOSED');
    const p = room.players.get(String(b.id || '')); if (!p || p.key !== b.key) throw fail(403, 'YOU ARE NO LONGER IN THIS ROOM');
    p.last = now();
    if (b.look && room.state === 'lobby') p.look = cleanLook(b.look);
    if (room.state === 'play' && b.me && int(b.round, 0, 1e6) === room.round) { p.me = cleanState(b.me); p.round = room.round; }
    if (room.host === p.id) {
      if (b.set && room.state === 'lobby') { const s = b.set; room.set = { ci: int(s.ci, 0, COURSES - 1), holes: HOLE_SETS.includes(s.holes) ? s.holes : 3, weather: int(s.weather, 0, WEATHERS - 1) }; }
      if (b.start && room.state === 'lobby' && room.players.size >= 2) { room.state = 'play'; room.round++; room.seed = crypto.randomInt(1, 2 ** 31 - 1); for (const q of room.players.values()) q.me = null; }
      if (b.again && room.state === 'play') room.state = 'lobby';
    }
    return { room: view(room, p.id) };
  },
  leave(b) {
    const room = rooms.get(String(b.code || '')); if (room) { const p = room.players.get(String(b.id || '')); if (p && p.key === b.key) dropPlayer(room, p.id); }
    return { ok: true };
  }
};

// ---------- a simple limit on how fast one address may ask ----------
const hits = new Map();
// (a whole school can sit behind one address, so the limit is roomy: it is there to stop a runaway script, not a class)
function tooFast(ip) { const t = now(); let h = hits.get(ip); if (!h || t - h.t > 1000) { h = { t, n: 0 }; hits.set(ip, h); } return ++h.n > 400; }
// a hosting service passes the player's own address on in this header; without one it is the address that connected
const addressOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 60) || req.socket.remoteAddress || '?';
setInterval(() => { const t = now(); for (const [k, h] of hits) if (t - h.t > 5000) hits.delete(k); }, 5000).unref();

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
function send(res, status, obj) { const s = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }); res.end(s); }

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method === 'GET') {
    if (url === '/api/health') return send(res, 200, { ok: true, rooms: rooms.size });
    if (url === '/' || url === '/index.html') {
      if (!page) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Retro Golf 3D match server is running. (No game page here: copy "Retro Golf 3D.html" next to server.js as index.html.)'); return; }
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) }); res.end(gz ? pageZip : page); return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return;
  }
  if (req.method !== 'POST' || !url.startsWith('/api/')) { res.writeHead(405, CORS); res.end(); return; }
  const fn = api[url.slice(5)]; if (!fn) return send(res, 404, { err: 'UNKNOWN REQUEST' });
  const ip = addressOf(req); if (tooFast(ip)) return send(res, 429, { err: 'SLOW DOWN' });
  let body = '', size = 0, dead = false;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { dead = true; send(res, 413, { err: 'TOO BIG' }); req.destroy(); } else body += c; });
  req.on('end', () => {
    if (dead) return;
    try { const b = JSON.parse(body || '{}'); if (!b || typeof b !== 'object') throw fail(400, 'BAD REQUEST'); send(res, 200, fn(b)); }
    catch (e) { send(res, e.status || 400, { err: e.status ? e.message : 'BAD REQUEST' }); }
  });
});
if (require.main === module) server.listen(PORT, () => console.log('Retro Golf 3D match server on port ' + PORT + (page ? ' (game page: ' + (page.length / 1024 | 0) + ' KB)' : ' (no game page found)')));
module.exports = { server, api, rooms, cleanName, cleanLook, cleanState };
