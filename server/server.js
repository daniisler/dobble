'use strict';
require('./env');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const { generateDeck, shuffle, ORDERS, DECK_SIZES } = require('./deck');
const db = require('./db');
const { adminAuth, renderAdmin } = require('./admin');

const APP_NAME = (process.env.APP_NAME || 'MatchMe').trim().slice(0, 40) || 'MatchMe';   // shown in titles and headings
const PORT = +process.env.PORT || 8003;
const PUBLIC = path.join(__dirname, '..', 'public');
const DEFAULT_STACK = 15;   // cards per player unless the creator chooses otherwise
const PENALTY_MS = 3000;       // lockout after a wrong symbol
const LATE_WINDOW_MS = 1000;   // how long after another player's card a click on the old centre card still counts as "too slow"
const SLACK_MS = 150;          // network slack: the client starts its own countdown a little before the server hears the click
// how long (seconds) a player may be unreachable before the browser shows "Connection lost" (CONNECTION_TIMEOUT_SECONDS in .env)
const CONNECTION_TIMEOUT_MS = Math.min(120, Math.max(2, Number(process.env.CONNECTION_TIMEOUT_SECONDS) || 5)) * 1000;
const COUNTDOWN = 3;
// how long (seconds) a player who lost the connection keeps their seat in the room and can resume it (RECONNECT_GRACE_SECONDS in .env)
const RECONNECT_GRACE_MS = Math.min(600, Math.max(5, Number(process.env.RECONNECT_GRACE_SECONDS) || 60)) * 1000;

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
    this.setId = null;     // ... and which of that account's sets
    this.q = 7;            // deck order: q*q+q+1 cards (and as many symbols)
    this.stackSize = DEFAULT_STACK;   // cards each player has to get rid of
    this.startedAt = 0;
    this.recent = [];      // recent centre-card changes: {prev card, at, by}
    this.games = 0;        // finished games in this room (cancelled ones do not count)
    this.wins = {};        // player id -> number of games won in this room
    this.locked = false;   // creator closed the room for new players
    this.penaltyMs = PENALTY_MS;   // lockout after a wrong symbol (creator's choice, 1-5 s)
  }
  get n() { return this.q * this.q + this.q + 1; }
  // the players of the current game (when the creator started without waiting, the others sit this game out)
  get playing() { return this.players.filter((p) => !p.sit); }
  maxStack(k = this.players.length) { return Math.floor((this.n - 1) / Math.max(1, k)); }   // one card stays in the middle
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
      locked: this.locked, penaltyMs: this.penaltyMs,
      games: this.games, players: this.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, away: p.away, sit: p.sit, wins: this.wins[p.id] || 0 }))
    };
  }
  broadcastActive(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.playing) if (p.ws.readyState === 1) p.ws.send(s);
  }
  pushLobby() { this.broadcast(this.lobbyMsg()); }
  add(ws, name) {
    const p = { ws, id: this.nextId++, secret: crypto.randomBytes(12).toString('hex'), away: false, sit: false, graceTimer: null, name, ready: false, stack: [], played: 0, penaltyUntil: 0, misses: 0, lastPlayAt: 0, bestMs: Infinity };
    this.players.push(p);
    ws.player = p; ws.room = this;
    if (this.creator === null) this.creator = p.id;
    send(ws, { t: 'joined', you: p.id, code: this.code, secret: p.secret, state: this.state });
    this.pushLobby();
  }
  // The connection of a player dropped: keep their seat for a while so they can come back (they are un-readied, the game goes on).
  disconnect(ws) {
    const p = this.players.find((x) => x.ws === ws);
    if (!p) return;
    p.away = true; p.ready = false;
    ws.player = null; ws.room = null;
    clearTimeout(p.graceTimer);
    p.graceTimer = setTimeout(() => this.remove(ws), RECONNECT_GRACE_MS);
    p.graceTimer.unref();
    if (this.state === 'countdown') this.cancelCountdown();
    if (this.state !== 'playing') this.pushLobby();
  }
  // the set picker is only for the creator who owns the room's images (the account that created it)
  sendSets(ws) {
    if (!ws.user || this.ownerUserId !== ws.user.id || !ws.player || this.creator !== ws.player.id) return;
    send(ws, { t: 'sets', sets: db.listSets(ws.user.id), current: this.setId });
  }
  useSet(ws, setId) {
    this.setId = setId; db.touchSet(setId);
    this.images = db.loadSelections(setId);
    for (const pl of this.players) pl.ready = false;
    this.pushLobby(); this.sendSets(ws);
  }
  // a returning player takes their seat back on a new connection and is brought up to date
  resume(ws, p) {
    clearTimeout(p.graceTimer);
    const old = p.ws;
    if (old !== ws) { old.player = null; old.room = null; try { old.terminate(); } catch { } }
    p.ws = ws; p.away = false;
    ws.player = p; ws.room = this;
    send(ws, { t: 'joined', you: p.id, code: this.code, secret: p.secret, state: this.state, resumed: true });
    if (this.state === 'playing' && !p.sit) {
      send(ws, {
        t: 'start', you: p.id, n: this.n, creator: this.creator, images: this.images, center: this.center, stack: p.stack, total: p.stack.length, penaltyMs: this.penaltyMs,
        players: this.playing.map(q => ({ id: q.id, name: q.name })),
        resume: { played: p.played, left: this.playing.map(q => [q.id, q.stack.length - q.played]), penaltyMs: Math.max(0, p.penaltyUntil - Date.now()) }
      });
    } else this.pushLobby();   // (in a running game the lobby screen must not be pushed over the game)
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
      if (!this.playing.length) { this.cancel(); return; }       // everybody who was playing has left
      this.broadcastActive(this.progressMsg());
    } else {
      if (this.state === 'countdown') this.cancelCountdown();
      this.pushLobby();
      this.checkStart();
    }
  }
  checkStart() {
    if (this.state === 'lobby' && this.players.length && this.players.every(p => p.ready)) this.begin();
  }
  // the creator starts without waiting for players who are not ready (or are reconnecting): they sit this game out
  startNow() {
    if (this.state !== 'lobby') return;
    const host = this.players.find((p) => p.id === this.creator);
    if (!host || host.away) return;
    host.ready = true;
    for (const p of this.players) p.sit = !p.ready || p.away;
    this.begin();
  }
  begin() {
    const k = this.playing.length;
    if (this.stackSize > this.maxStack(k)) {
      for (const p of this.players) { p.ready = false; p.sit = false; }
      this.broadcast({ t: 'notice', msg: `${k} player${k === 1 ? '' : 's'} × ${this.stackSize} cards needs more than the ${this.n - 1} cards this deck can deal. Lower the cards per player (max ${this.maxStack(k)}) or choose a bigger deck.` });
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
  cancelCountdown() { clearTimeout(this.timer); this.state = 'lobby'; for (const p of this.players) p.sit = false; this.broadcast({ t: 'count', n: 0 }); }
  // the creator stops a countdown or a running game; everybody goes back to the lobby
  cancel() {
    if (this.state !== 'countdown' && this.state !== 'playing') return;
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) db.logEvent('game_cancelled');
    clearTimeout(this.timer);
    this.state = 'lobby';
    for (const p of this.players) { p.ready = false; p.sit = false; }
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
    for (const p of this.players) { p.stack = p.sit ? [] : deck.splice(0, per); p.played = 0; p.penaltyUntil = 0; p.misses = 0; p.lastPlayAt = this.startedAt; p.bestMs = Infinity; }
    this.state = 'playing';
    db.logEvent('game_started');
    // each player is sent their own stack up front so clicks can be shown instantly (client-side prediction)
    for (const p of this.playing) {
      send(p.ws, {
        t: 'start', you: p.id, n: this.n, creator: this.creator, images: this.images, center: this.center, stack: p.stack, total: per, penaltyMs: this.penaltyMs,
        players: this.playing.map(q => ({ id: q.id, name: q.name }))
      });
    }
    for (const p of this.players) if (p.sit) send(p.ws, this.lobbyMsg());     // players sitting this game out see the lobby with a note
  }
  progressMsg(extra) {
    return Object.assign({ t: 'prog', creator: this.creator, left: this.playing.map(p => [p.id, p.stack.length - p.played]) }, extra);
  }
  // Every click goes through here, and the server alone decides what it was: a correct play, a wrong symbol
  // (3 s lockout, counted as a miss) or "too slow" (right a moment ago, somebody else was faster: no penalty at all, play on).
  play(p, idx, sym) {
    const now = Date.now();
    if (this.state !== 'playing' || p.sit || idx !== p.played || now < p.penaltyUntil) return send(p.ws, { t: 'rej', i: idx });
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
      this.broadcastActive({
        t: 'play', by: p.id, i: idx, card, s: sym,
        left: this.playing.map(q => [q.id, q.stack.length - q.played])
      });
      if (won) this.end(p);
      return;
    }
    // the click did not match the centre card: was it right a moment ago, before somebody else covered it?
    const faster = card.includes(sym) && this.recent.findLast((e) => e.by !== p.id && now - e.at <= LATE_WINDOW_MS && e.prev.includes(sym));
    if (faster) {
      return send(p.ws, { t: 'rej', i: idx, why: 'late', by: faster.by });
    }
    p.penaltyUntil = now + this.penaltyMs - SLACK_MS;
    p.misses++;
    send(p.ws, { t: 'rej', i: idx, why: 'wrong', ms: this.penaltyMs });
  }
  end(winner) {
    this.state = 'lobby';
    this.games++;
    this.wins[winner.id] = (this.wins[winner.id] || 0) + 1;
    const total = winner.lastPlayAt - this.startedAt;
    const ranking = this.playing.map(p => ({
      id: p.id, name: p.name, left: p.stack.length - p.played, played: p.played, misses: p.misses, wins: this.wins[p.id] || 0,
      avgMs: p.played ? Math.round((p.lastPlayAt - this.startedAt) / p.played) : null,
      bestMs: p.played ? p.bestMs : null, lastPlayAt: p.lastPlayAt,
    })).sort((a, b) => a.left - b.left || a.lastPlayAt - b.lastPlayAt);
    db.logEvent('game_finished');
    db.logGame({ cards: this.n, players: this.playing.length, stack: this.stackSize, durationMs: total, misses: this.playing.reduce((n, p) => n + p.misses, 0), customImages: Object.keys(this.images).filter((k) => +k < this.n).length });
    this.broadcastActive({ t: 'end', winner: winner.id, totalMs: total, cards: this.n, games: this.games, ranking });
    for (const p of this.players) { p.ready = false; p.sit = false; }
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
      case 'resume': {
        if (room) return;
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        const pl = r && r.players.find((x) => x.id === m.id);
        if (!pl || typeof m.secret !== 'string' || m.secret.length !== pl.secret.length || !crypto.timingSafeEqual(Buffer.from(m.secret), Buffer.from(pl.secret))) return send(ws, { t: 'resumefail' });
        ws.user = db.userForToken(m.token);
        r.resume(ws, pl);
        return r.sendSets(ws);
      }
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
          if (r.locked) return send(ws, { t: 'error', msg: 'This room is locked by its creator' });
        }
        db.logEvent(m.t === 'create' ? 'room_created' : 'room_joined');
        if (m.t === 'create' && ws.user) { r.ownerUserId = ws.user.id; r.setId = db.latestSet(ws.user.id); r.images = db.loadSelections(r.setId); }
        r.add(ws, name);
        return r.sendSets(ws);
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
          if (persist) db.saveSelection(room.setId, m.slot, null);
        } else {
          const img = db.imageOwnedBy(m.img, ws.user.id);
          if (!img) return;
          // the same image may not fill two slots of the deck in use; copies in unused slots are simply moved
          const usedAt = Object.keys(room.images).find((s) => room.images[s] === img.url && +s !== m.slot && +s < room.n);
          for (const k of Object.keys(room.images)) if (room.images[k] === img.url && +k !== m.slot && +k >= room.n) delete room.images[k];
          if (usedAt !== undefined) return send(ws, { t: 'editerr', msg: `That image is already used in slot ${+usedAt + 1}` });
          room.images[m.slot] = img.url;
          if (persist) db.saveSelection(room.setId, m.slot, img.id);
        }
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      }
      case 'resetimages':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        room.images = {};
        if (ws.user && room.ownerUserId === ws.user.id) db.clearSelections(room.setId);
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      case 'useset': case 'newset': case 'renameset': case 'delset': {
        // only the creator who owns the room's images, only in the lobby
        if (!room || room.state !== 'lobby' || room.creator !== p.id || !ws.user || room.ownerUserId !== ws.user.id) return;
        try {
          if (m.t === 'useset') { const id = db.setOwnedBy(m.id, ws.user.id); if (id) room.useSet(ws, id); }
          else if (m.t === 'newset') room.useSet(ws, db.createSet(ws.user.id, m.name));
          else if (m.t === 'renameset') { db.renameSet(ws.user.id, room.setId, m.name); room.sendSets(ws); }
          else { db.deleteSet(ws.user.id, room.setId); room.useSet(ws, db.latestSet(ws.user.id)); }
        } catch (e) { send(ws, { t: 'editerr', msg: e.message }); }
        return;
      }
      case 'host': {                                // hand the room over to somebody else
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        const target = room.players.find((x) => x.id === m.id);
        if (!target || target === p || target.away) return;
        room.creator = target.id;
        room.pushLobby();
        room.sendSets(target.ws);                   // (only does something when the new host owns the room's images)
        return;
      }
      case 'lock':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        room.locked = !!m.v; room.pushLobby(); return;
      case 'setpenalty':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        if (!Number.isInteger(m.ms) || m.ms < 1000 || m.ms > 5000 || m.ms % 1000) return;
        room.penaltyMs = m.ms;
        for (const pl of room.players) pl.ready = false;
        room.pushLobby(); return;
      case 'startnow':
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        room.startNow(); return;
      case 'kick': {
        // the creator removes somebody from the lobby (not during a countdown or a game, not themselves)
        if (!room || room.state !== 'lobby' || room.creator !== p.id) return;
        const target = room.players.find((x) => x.id === m.id);
        if (!target || target === p) return;
        clearTimeout(target.graceTimer);
        send(target.ws, { t: 'kicked' });
        const tws = target.ws;
        room.remove(tws);
        return;
      }
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
      case 'leave': if (room) { clearTimeout(p.graceTimer); room.remove(ws); } return;
      case 'play':
        if (room && Number.isInteger(m.i) && Number.isInteger(m.s)) room.play(p, m.i, m.s);
        return;
    }
  });
  ws.on('close', () => { if (ws.room) ws.room.disconnect(ws); });
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
