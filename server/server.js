'use strict';
require('./env');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { generateDeck, shuffle, ORDERS, DECK_SIZES } = require('./deck');
const db = require('./db');
const { adminAuth, renderAdmin } = require('./admin');

const APP_NAME = (process.env.APP_NAME || 'MatchMe').trim().slice(0, 40) || 'MatchMe';   // shown in titles and headings
const PORT = +process.env.PORT || 8003;
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_PLAYERS = 8;
const DEFAULT_STACK = 15;   // cards per player unless the creator chooses otherwise
const PENALTY_MS = 3000;       // lockout after a wrong symbol
const LATE_WINDOW_MS = 1000;   // how long after another player's card a click on the old centre card still counts as "too slow"
const SLACK_MS = 150;          // network slack: the client starts its own countdown a little before the server hears the click
// how long (seconds) a player may be unreachable before the browser shows "Connection lost" (CONNECTION_TIMEOUT_SECONDS in .env)
const CONNECTION_TIMEOUT_MS = Math.min(120, Math.max(2, Number(process.env.CONNECTION_TIMEOUT_SECONDS) || 5)) * 1000;
const COUNTDOWN = 3;

// ---------------------------------------------------------------- static
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};
// ---- small in-memory rate limiter (per IP or per user), against password guessing and upload spam
const TRUST_PROXY = ['1', 'true'].includes(String(process.env.TRUST_PROXY).toLowerCase());   // behind nginx: use X-Forwarded-For
const clientIp = (req) => (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(), recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now); hits.set(key, recent);
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();
const TOO_MANY = 'Too many attempts, please try again later';

const named = (html) => html.toString().replaceAll('{{APP_NAME}}', APP_NAME.replace(/[&<>"]/g, ''));
const NOT_FOUND_PAGE = named(fs.readFileSync(path.join(PUBLIC, '404.html')));
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(NOT_FOUND_PAGE); }

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { if (n - c.length <= limit) reject(new Error('Too large')); chunks.length = 0; } else chunks.push(c); });   // stop collecting, the caller answers 413
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const bearer = (req) => db.userForToken((req.headers.authorization || '').replace(/^Bearer /, ''));

async function api(req, res, url) {
  try {
    if (req.method === 'POST' && (url === '/api/login' || url === '/api/register')) {
      const ip = clientIp(req);
      if (url === '/api/register' ? limited('reg:' + ip, 10, 3600e3) : limited('login:' + ip, 20, 600e3)) return json(res, 429, { error: TOO_MANY });
      const b = JSON.parse((await readBody(req, 2048)).toString() || '{}');
      return json(res, 200, url === '/api/login' ? db.login(b.username, b.password) : db.register(b.username, b.password));
    }
    if (url === '/api/me') { const u = bearer(req); return u ? json(res, 200, { username: u.username }) : json(res, 401, { error: 'Not logged in' }); }
    if (url === '/api/config') return json(res, 200, { appName: APP_NAME, decks: DECK_SIZES, connectionTimeoutMs: CONNECTION_TIMEOUT_MS });
    if (url === '/api/logout') { db.logout((req.headers.authorization || '').replace(/^Bearer /, '')); return json(res, 200, {}); }
    const user = bearer(req);
    if (!user) return json(res, 401, { error: 'Not logged in' });
    if (url === '/api/delete-account' && req.method === 'POST') {
      if (limited('del:' + user.id, 5, 600e3)) return json(res, 429, { error: TOO_MANY });
      const b = JSON.parse((await readBody(req, 2048)).toString() || '{}');
      const urls = db.deleteAccount(user.id, b.password);
      for (const r of rooms.values()) { if (r.ownerUserId === user.id) r.ownerUserId = null; urls.forEach((u) => r.dropImage(u)); }
      for (const ws of wss.clients) if (ws.user && ws.user.id === user.id) ws.user = null;
      return json(res, 200, {});
    }
    if (url === '/api/images' && req.method === 'GET') return json(res, 200, { images: db.listImages(user.id) });
    if (url === '/api/images' && req.method === 'POST') {
      if (limited('up:' + user.id, 400, 600e3)) return json(res, 429, { error: TOO_MANY });
    }
    if (url === '/api/images' && req.method === 'POST') return json(res, 200, await db.addImage(user.id, await readBody(req, db.MAX_BYTES)));
    const m = url.match(/^\/api\/images\/([0-9a-f]{24})$/);
    if (m && req.method === 'DELETE') {
      const url = db.listImages(user.id).find((i) => i.id === m[1]);
      const ok = db.deleteImage(user.id, m[1]);
      if (ok && url) for (const r of rooms.values()) r.dropImage(url.url);
      return json(res, ok ? 200 : 404, {});
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.message === 'Too large') {                      // answer first, then drop the rest of the upload
      res.on('finish', () => req.destroy());
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({ error: 'Image too large (max 8 MB)' }));
      return;
    }
    json(res, 400, { error: e.message });
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400).end('Bad request'); return; }   // a malformed %-escape must not crash the server
  if (p.includes('\0')) return notFound(res);
  if (p.startsWith('/api/')) return api(req, res, p);
  if (p === '/admin') {
    const ok = adminAuth(req);
    if (ok === null) return notFound(res);                                  // no ADMIN_USER / ADMIN_PASSWORD configured
    if (!ok) { setTimeout(() => { res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${APP_NAME} admin"` }).end('Login required'); }, 500); return; }
    let players = 0; for (const r of rooms.values()) players += r.players.length;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderAdmin({ rooms: rooms.size, players, appName: APP_NAME }));
    return;
  }
  if (p === '/') db.logEvent('page_view');
  let root = PUBLIC, uploaded = false;
  if (p.startsWith('/u/')) {
    // uploaded images: only the exact names the server generates ("<24 hex>.webp|png|jpg"), nothing else
    if (!/^\/u\/[0-9a-f]{24}\.(webp|png|jpg)$/.test(p)) return notFound(res);
    root = db.UPLOADS; p = p.slice(2); uploaded = true;
  }
  if (p === '/') p = '/index.html';
  if (p === '/404.html') return notFound(res);
  const file = path.join(root, path.normalize(p));
  if (!file.startsWith(root + path.sep)) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.webp' || uploaded ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    // user-supplied files may only ever be shown as pictures: no scripts, no framing, no embedding on other sites
    if (uploaded) Object.assign(headers, { 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.writeHead(200, headers);
    res.end(ext === '.html' ? named(data) : data);
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (; ;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[(Math.random() * letters.length) | 0];
    if (!rooms.has(c)) return c;
  }
}

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

class Room {
  constructor(code) {
    this.code = code;
    this.players = [];     // {ws, id, name, ready, stack, played, penaltyUntil}
    this.state = 'lobby';  // lobby | countdown | playing
    this.center = null;
    this.nextId = 1;
    this.timer = null;
    this.creator = null;   // player id allowed to change images
    this.images = {};      // slot (0..56) -> custom image url (each url used at most once)
    this.ownerUserId = null; // account whose saved selections this room mirrors
    this.q = 7;            // deck order: q*q+q+1 cards (and as many symbols)
    this.stackSize = DEFAULT_STACK;   // cards each player has to get rid of
    this.startedAt = 0;
    this.recent = [];      // recent centre-card changes: {prev card, at, by}
    this.games = 0;        // finished games in this room (cancelled ones do not count)
    this.wins = {};        // player id -> number of games won in this room
  }
  get n() { return this.q * this.q + this.q + 1; }
  maxStack() { return Math.floor((this.n - 1) / Math.max(1, this.players.length)); }   // one card stays in the middle
  dropImage(url) {
    let changed = false;
    for (const [slot, u] of Object.entries(this.images)) if (u === url) { delete this.images[slot]; changed = true; }
    if (changed && this.state === 'lobby') { for (const pl of this.players) pl.ready = false; this.pushLobby(); }
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players) if (p.ws.readyState === 1) p.ws.send(s);
  }
  lobbyMsg() {
    return {
      t: 'lobby', code: this.code, state: this.state, creator: this.creator, images: this.images, q: this.q, n: this.n, stack: this.stackSize, maxStack: this.maxStack(),
      games: this.games, players: this.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, wins: this.wins[p.id] || 0 }))
    };
  }
  pushLobby() { this.broadcast(this.lobbyMsg()); }
  add(ws, name) {
    const p = { ws, id: this.nextId++, name, ready: false, stack: [], played: 0, penaltyUntil: 0, misses: 0, lastPlayAt: 0, bestMs: Infinity };
    this.players.push(p);
    ws.player = p; ws.room = this;
    if (this.creator === null) this.creator = p.id;
    send(ws, { t: 'joined', you: p.id });
    this.pushLobby();
  }
  remove(ws) {
    const i = this.players.findIndex(p => p.ws === ws);
    if (i < 0) return;
    const p0 = this.players[i];
    this.players.splice(i, 1);
    ws.player = null; ws.room = null;
    if (this.creator === p0.id && this.players.length) this.creator = this.players[0].id;
    if (!this.players.length) { clearTimeout(this.timer); rooms.delete(this.code); return; }
    if (this.state === 'playing') {
      this.broadcast(this.progressMsg());
    } else {
      if (this.state === 'countdown') this.cancelCountdown();
      this.pushLobby();
      this.checkStart();
    }
  }
  checkStart() {
    if (this.state === 'lobby' && this.players.length && this.players.every(p => p.ready)) {
      if (this.stackSize > this.maxStack()) {
        for (const p of this.players) p.ready = false;
        this.broadcast({ t: 'notice', msg: `${this.players.length} player${this.players.length === 1 ? '' : 's'} × ${this.stackSize} cards needs more than the ${this.n - 1} cards this deck can deal. Lower the cards per player (max ${this.maxStack()}) or choose a bigger deck.` });
        this.pushLobby();
        return;
      }
      this.state = 'countdown';
      this.pushLobby();
      let n = COUNTDOWN;
      const tick = () => {
        if (n > 0) { this.broadcast({ t: 'count', n }); n--; this.timer = setTimeout(tick, 1000); }
        else this.start();
      };
      tick();
    }
  }
  cancelCountdown() { clearTimeout(this.timer); this.state = 'lobby'; this.broadcast({ t: 'count', n: 0 }); }
  // the creator stops a countdown or a running game; everybody goes back to the lobby
  cancel() {
    if (this.state !== 'countdown' && this.state !== 'playing') return;
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) db.logEvent('game_cancelled');
    clearTimeout(this.timer);
    this.state = 'lobby';
    for (const p of this.players) p.ready = false;
    this.broadcast({ t: 'count', n: 0 });
    this.broadcast({ t: 'cancelled', playing: wasPlaying });
    this.pushLobby();
  }
  start() {
    const deck = shuffle(generateDeck(this.q).map(c => shuffle(c.slice())));
    const per = this.stackSize;
    this.center = deck.pop();
    this.startedAt = Date.now();
    this.recent = [];
    for (const p of this.players) { p.stack = deck.splice(0, per); p.played = 0; p.penaltyUntil = 0; p.misses = 0; p.lastPlayAt = this.startedAt; p.bestMs = Infinity; }
    this.state = 'playing';
    db.logEvent('game_started');
    // each player is sent their own stack up front so clicks can be shown instantly (client-side prediction)
    for (const p of this.players) {
      send(p.ws, {
        t: 'start', you: p.id, n: this.n, creator: this.creator, images: this.images, center: this.center, stack: p.stack, total: per,
        players: this.players.map(q => ({ id: q.id, name: q.name }))
      });
    }
  }
  progressMsg(extra) {
    return Object.assign({ t: 'prog', creator: this.creator, left: this.players.map(p => [p.id, p.stack.length - p.played]) }, extra);
  }
  // Every click goes through here, and the server alone decides what it was: a correct play, a wrong symbol
  // (3 s lockout, counted as a miss) or "too slow" (right a moment ago, somebody else was faster: no penalty at all, play on).
  play(p, idx, sym) {
    const now = Date.now();
    if (this.state !== 'playing' || idx !== p.played || now < p.penaltyUntil) return send(p.ws, { t: 'rej', i: idx });
    const card = p.stack[idx];
    if (!card) return send(p.ws, { t: 'rej', i: idx });
    if (card.includes(sym) && this.center.includes(sym)) {
      p.played++;
      p.bestMs = Math.min(p.bestMs, now - p.lastPlayAt);
      p.lastPlayAt = now;
      this.recent = this.recent.filter((e) => now - e.at <= LATE_WINDOW_MS);
      this.recent.push({ prev: this.center, at: now, by: p.id });
      this.center = card;
      const won = p.played === p.stack.length;
      // single broadcast: new centre card + everyone's remaining counts
      this.broadcast({
        t: 'play', by: p.id, i: idx, card, s: sym,
        left: this.players.map(q => [q.id, q.stack.length - q.played])
      });
      if (won) this.end(p);
      return;
    }
    // the click did not match the centre card: was it right a moment ago, before somebody else covered it?
    const faster = card.includes(sym) && this.recent.findLast((e) => e.by !== p.id && now - e.at <= LATE_WINDOW_MS && e.prev.includes(sym));
    if (faster) {
      return send(p.ws, { t: 'rej', i: idx, why: 'late', by: faster.by });
    }
    p.penaltyUntil = now + PENALTY_MS - SLACK_MS;
    p.misses++;
    send(p.ws, { t: 'rej', i: idx, why: 'wrong', ms: PENALTY_MS });
  }
  end(winner) {
    this.state = 'lobby';
    this.games++;
    this.wins[winner.id] = (this.wins[winner.id] || 0) + 1;
    const total = winner.lastPlayAt - this.startedAt;
    const ranking = this.players.map(p => ({
      id: p.id, name: p.name, left: p.stack.length - p.played, played: p.played, misses: p.misses, wins: this.wins[p.id] || 0,
      avgMs: p.played ? Math.round((p.lastPlayAt - this.startedAt) / p.played) : null,
      bestMs: p.played ? p.bestMs : null, lastPlayAt: p.lastPlayAt,
    })).sort((a, b) => a.left - b.left || a.lastPlayAt - b.lastPlayAt);
    db.logEvent('game_finished');
    db.logGame({ cards: this.n, players: this.players.length, stack: this.stackSize, durationMs: total, misses: this.players.reduce((n, p) => n + p.misses, 0), customImages: Object.keys(this.images).filter((k) => +k < this.n).length });
    for (const p of this.players) p.ready = false;
    this.broadcast({ t: 'end', winner: winner.id, totalMs: total, cards: this.n, games: this.games, ranking });
    this.pushLobby();
  }
}

// ---------------------------------------------------------------- sockets
const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 1024 });

wss.on('connection', (ws, req) => {
  req.socket.setNoDelay(true);
  db.logEvent('connection');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const room = ws.room, p = ws.player;
    switch (m.t) {
      case 'ping': return send(ws, { t: 'pong', c: m.c });
      case 'create': case 'join': {
        if (room) return;
        ws.user = db.userForToken(m.token);
        const name = ws.user ? ws.user.username : (String(m.name || '').trim().slice(0, 16) || 'Player');
        let r;
        if (m.t === 'create') { r = new Room(makeCode()); rooms.set(r.code, r); }
        else {
          r = rooms.get(String(m.code || '').toUpperCase().trim());
          if (!r) return send(ws, { t: 'error', msg: 'Room not found' });
          if (r.state !== 'lobby') return send(ws, { t: 'error', msg: 'Game already running' });
          if (r.players.length >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full' });
        }
        db.logEvent(m.t === 'create' ? 'room_created' : 'room_joined');
        if (m.t === 'create' && ws.user) { r.ownerUserId = ws.user.id; r.images = db.loadSelections(ws.user.id); }
        return r.add(ws, name);
      }
      case 'ready':
        if (!room || room.state !== 'lobby') return;
        p.ready = !!m.v; room.pushLobby(); room.checkStart(); return;
      case 'setimage': {
        // only the lobby creator, only in the lobby, only with images from their own library
        if (!room || room.state !== 'lobby' || room.creator !== p.id || !ws.user) return;
        if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot >= room.n) return;
        const persist = room.ownerUserId === ws.user.id;
        if (m.img === null) {
          delete room.images[m.slot];
          if (persist) db.saveSelection(ws.user.id, m.slot, null);
        } else {
          const img = db.imageOwnedBy(m.img, ws.user.id);
          if (!img) return;
          // the same image may not fill two slots of the deck in use; copies in unused slots are simply moved
          const usedAt = Object.keys(room.images).find((s) => room.images[s] === img.url && +s !== m.slot && +s < room.n);
          for (const k of Object.keys(room.images)) if (room.images[k] === img.url && +k !== m.slot && +k >= room.n) delete room.images[k];
          if (usedAt !== undefined) return send(ws, { t: 'editerr', msg: `That image is already used in slot ${+usedAt + 1}` });
          room.images[m.slot] = img.url;
          if (persist) db.saveSelection(ws.user.id, m.slot, img.id);
        }
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      }
      case 'resetimages':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        room.images = {};
        if (ws.user && room.ownerUserId === ws.user.id) db.clearSelections(ws.user.id);
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      case 'setdeck':
        if (!room || room.state !== 'lobby' || room.creator !== p.id || !ORDERS.includes(m.q)) return;
        room.q = m.q;
        room.stackSize = Math.max(1, Math.min(room.stackSize, room.maxStack()));   // never start in an impossible setting
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      case 'setstack':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        if (!Number.isInteger(m.n) || m.n < 1 || m.n > room.n - 1) return;
        room.stackSize = m.n;
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      case 'cancel':
        if (room && room.creator === p.id) room.cancel();
        return;
      case 'leave': if (room) room.remove(ws); return;
      case 'play':
        if (room && Number.isInteger(m.i) && Number.isInteger(m.s)) room.play(p, m.i, m.s);
        return;
    }
  });
  ws.on('close', () => { if (ws.room) ws.room.remove(ws); });
  ws.on('error', () => { });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);
heartbeat.unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`${APP_NAME} running on http://localhost:${PORT}`));
}
module.exports = { server, Room, rooms };
