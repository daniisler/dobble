'use strict';
require('./env');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// The database used to be called "dobble.sqlite": move it (and its journal files) to the new name once, keeping all data.
for (const ext of ['', '-wal', '-shm']) {
  const old = path.join(DATA, 'dobble.sqlite' + ext), now = path.join(DATA, 'matchme.sqlite' + ext);
  if (fs.existsSync(old) && !fs.existsSync(path.join(DATA, 'matchme.sqlite'))) fs.renameSync(old, now);
}
const db = new DatabaseSync(path.join(DATA, 'matchme.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL,
    salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, ext TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS images_user ON images(user_id);
  -- usage statistics: anonymous counters only (no names, no IP addresses)
  CREATE TABLE IF NOT EXISTS events (ts INTEGER NOT NULL, type TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_type_ts ON events(type, ts);
  CREATE TABLE IF NOT EXISTS games (
    ts INTEGER NOT NULL, cards INTEGER, players INTEGER, stack INTEGER, duration_ms INTEGER, misses INTEGER, custom_images INTEGER);
  CREATE TABLE IF NOT EXISTS selections (
    user_id INTEGER NOT NULL, slot INTEGER NOT NULL, image_id TEXT NOT NULL,
    PRIMARY KEY (user_id, slot), UNIQUE (user_id, image_id));
`);

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (username, salt, hash, created) VALUES (?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?,?,?)'),
  sessionUser: db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  imagesOf: db.prepare('SELECT id, ext FROM images WHERE user_id = ? ORDER BY created DESC'),
  countImages: db.prepare('SELECT COUNT(*) AS n FROM images WHERE user_id = ?'),
  insertImage: db.prepare('INSERT INTO images (id, user_id, ext, created) VALUES (?,?,?,?)'),
  image: db.prepare('SELECT id, user_id, ext FROM images WHERE id = ?'),
  deleteImage: db.prepare('DELETE FROM images WHERE id = ? AND user_id = ?'),
  selections: db.prepare('SELECT s.slot, i.id, i.ext FROM selections s JOIN images i ON i.id = s.image_id WHERE s.user_id = ?'),
  clearSlot: db.prepare('DELETE FROM selections WHERE user_id = ? AND slot = ?'),
  clearImage: db.prepare('DELETE FROM selections WHERE user_id = ? AND image_id = ?'),
  clearAll: db.prepare('DELETE FROM selections WHERE user_id = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  allImageFiles: db.prepare('SELECT id, ext FROM images WHERE user_id = ?'),
  delImages: db.prepare('DELETE FROM images WHERE user_id = ?'),
  delSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  setSel: db.prepare('INSERT INTO selections (user_id, slot, image_id) VALUES (?,?,?)'),
};

// ---- usage statistics (never allowed to break the game: errors are swallowed)
const insertEvent = db.prepare('INSERT INTO events (ts, type) VALUES (?, ?)');
const insertGame = db.prepare('INSERT INTO games (ts, cards, players, stack, duration_ms, misses, custom_images) VALUES (?,?,?,?,?,?,?)');
function logEvent(type) { try { insertEvent.run(Date.now(), type); } catch { } }
function logGame(g) { try { insertGame.run(Date.now(), g.cards, g.players, g.stack, g.durationMs, g.misses, g.customImages); } catch { } }

function statsOverview(days = 14) {
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const totals = Object.fromEntries(all('SELECT type, COUNT(*) AS n FROM events GROUP BY type').map((r) => [r.type, r.n]));
  const since = Date.now() - days * 864e5;
  const daily = {};
  for (const r of all("SELECT date(ts/1000,'unixepoch') AS d, type, COUNT(*) AS n FROM events WHERE ts > ? GROUP BY d, type", since)) (daily[r.d] ||= {})[r.type] = r.n;
  let bytes = 0;
  for (const f of fs.readdirSync(UPLOADS)) { try { bytes += fs.statSync(path.join(UPLOADS, f)).size; } catch { } }
  return {
    totals, daily,
    accounts: all('SELECT COUNT(*) AS n FROM users')[0].n,
    images: all('SELECT COUNT(*) AS n FROM images')[0].n,
    uploadBytes: bytes,
    gameSummary: all('SELECT COUNT(*) AS n, AVG(players) AS players, AVG(duration_ms) AS ms, SUM(misses) AS misses FROM games')[0],
    byDeck: all('SELECT cards, COUNT(*) AS n, AVG(players) AS players, AVG(duration_ms) AS ms FROM games GROUP BY cards ORDER BY cards'),
    recent: all('SELECT * FROM games ORDER BY ts DESC LIMIT 20'),
  };
}

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function register(username, password) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('Username: 3-16 letters, digits or _');
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) throw new Error('Password must be 6+ characters');
  if (q.userByName.get(username)) throw new Error('Username taken');
  const salt = crypto.randomBytes(16).toString('hex');
  q.insertUser.run(username, salt, hash(password, salt), Date.now());
  logEvent('register');
  return login(username, password);
}

function login(username, password) {
  const u = q.userByName.get(String(username));
  const bad = new Error('Wrong username or password');
  if (!u || typeof password !== 'string') throw bad;
  const a = Buffer.from(hash(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  if (!crypto.timingSafeEqual(a, b)) throw bad;
  const token = crypto.randomBytes(24).toString('hex');
  q.insertSession.run(token, u.id, Date.now());
  logEvent('login');
  return { token, username: u.username };
}

const userForToken = (t) => (typeof t === 'string' && t.length === 48 ? q.sessionUser.get(t) || null : null);
const logout = (t) => q.deleteSession.run(String(t));

// ---- images
// Every upload is decoded, shrunk and re-encoded as a small WebP on the server, so whatever a user sends (huge photos,
// odd formats, files with hidden extra data, EXIF metadata) is never stored or served as it came in.
const sharp = require('sharp');
sharp.cache(false);
const MAX_IMAGES = 300;           // enough for a complete 273-card deck of custom images
const MAX_BYTES = 8 * 1024 * 1024;          // largest upload accepted (it is shrunk to a few KB)
const MAX_SIDE = 256;                       // stored pictures fit in 256 x 256 pixels
const MAX_INPUT_PIXELS = 40e6;              // refuse decompression bombs (about 6300 x 6300)
async function normalizeImage(buf) {
  try {
    const img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });   // animations: first frame only
    const meta = await img.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new Error('format');      // no SVG (scripts!), GIF, TIFF, ...
    return await img.rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
  } catch { throw new Error('Unsupported or damaged image (use PNG, JPEG or WebP, up to about 6000 x 6000 pixels)'); }
}
async function addImage(userId, input) {
  if (input.length > MAX_BYTES) throw new Error('Image too large');
  if (q.countImages.get(userId).n >= MAX_IMAGES) throw new Error('Image limit reached');
  const buf = await normalizeImage(input);
  const id = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(UPLOADS, `${id}.webp`), buf);
  q.insertImage.run(id, userId, 'webp', Date.now());
  logEvent('image_uploaded');
  return { id, url: `/u/${id}.webp` };
}
const listImages = (userId) => q.imagesOf.all(userId).map(r => ({ id: r.id, url: `/u/${r.id}.${r.ext}` }));
const imageOwnedBy = (id, userId) => { const r = q.image.get(String(id)); return r && r.user_id === userId ? { id: r.id, url: `/u/${r.id}.${r.ext}` } : null; };
function deleteImage(userId, id) {
  const r = q.image.get(String(id));
  if (!r || r.user_id !== userId) return false;
  q.deleteImage.run(id, userId);
  q.clearImage.run(userId, id);
  fs.rm(path.join(UPLOADS, `${r.id}.${r.ext}`), () => { });
  return true;
}

// ---- saved slot -> image choices
const loadSelections = (userId) => Object.fromEntries(q.selections.all(userId).map(r => [r.slot, `/u/${r.id}.${r.ext}`]));
function saveSelection(userId, slot, imageId) {   // imageId null = back to default
  q.clearSlot.run(userId, slot);
  if (imageId) { q.clearImage.run(userId, imageId); q.setSel.run(userId, slot, imageId); }
}
const clearSelections = (userId) => q.clearAll.run(userId);

// ---- account deletion: the user, their sessions, saved picks and every uploaded image (rows and files)
function deleteAccount(userId, password) {
  const u = q.userById.get(userId);
  if (!u || typeof password !== 'string') throw new Error('Wrong password');
  const a = Buffer.from(hash(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  if (!crypto.timingSafeEqual(a, b)) throw new Error('Wrong password');
  const urls = [];
  for (const r of q.allImageFiles.all(userId)) {
    urls.push(`/u/${r.id}.${r.ext}`);
    fs.rmSync(path.join(UPLOADS, `${r.id}.${r.ext}`), { force: true });
  }
  q.clearAll.run(userId); q.delImages.run(userId); q.delSessions.run(userId); q.delUser.run(userId);
  logEvent('account_deleted');
  return urls;
}

module.exports = { logEvent, logGame, statsOverview, deleteAccount, loadSelections, saveSelection, clearSelections, register, login, logout, userForToken, addImage, listImages, imageOwnedBy, deleteImage, UPLOADS, MAX_BYTES };
