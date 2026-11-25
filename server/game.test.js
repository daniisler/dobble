'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
// the tests must not depend on a developer's local .env: real environment variables win over it
process.env.APP_NAME = 'MatchMe';
delete process.env.TRUST_PROXY;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'matchme-'));
process.env.ADMIN_USER = 'boss';
process.env.ADMIN_PASSWORD = 's3cret:with:colons';
process.env.CONNECTION_TIMEOUT_SECONDS = '7';
const WebSocket = require('ws');
const { generateDeck } = require('./deck');
const { server, rooms } = require('./server');
test.after(() => { server.closeAllConnections(); server.close(); });

test('every deck size is a perfect deck (any two cards share exactly one symbol)', () => {
  const { ORDERS } = require('./deck');
  assert.deepEqual(ORDERS.map((q) => q * q + q + 1), [7, 13, 21, 31, 57, 73, 91, 133, 183, 273]);
  for (const q of ORDERS) {
    const d = generateDeck(q);
    assert.equal(d.length, q * q + q + 1);
    const symbols = new Set();
    for (const c of d) { assert.equal(new Set(c).size, q + 1); c.forEach((x) => symbols.add(x)); }
    assert.equal(symbols.size, d.length);
    for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++)
      assert.equal(d[i].filter((x) => d[j].includes(x)).length, 1, `q=${q} cards ${i},${j}`);
  }
});

function client(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const q = [], waiters = [];
  const matches = (t, m) => (Array.isArray(t) ? t.includes(m.t) : t === m.t);
  ws.on('message', (r) => {
    const m = JSON.parse(r);
    const w = waiters.findIndex((x) => matches(x.t, m) && (!x.f || x.f(m)));
    if (w >= 0) waiters.splice(w, 1)[0].res(m); else q.push(m);
  });
  // next message of type t (or any of several types), optionally filtered; consumed exactly once
  ws.next = (t, f) => {
    const i = q.findIndex((m) => matches(t, m) && (!f || f(m)));
    if (i >= 0) return Promise.resolve(q.splice(i, 1)[0]);
    return new Promise((res) => waiters.push({ t, f, res }));
  };
  ws.sendj = (o) => ws.send(JSON.stringify(o));
  return new Promise((res) => ws.on('open', () => res(ws)));
}

test('full game with two players, race resolution and accounts', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const post = (u, b, tok, raw) => fetch(base + u, { method: 'POST', headers: Object.assign(tok ? { Authorization: 'Bearer ' + tok } : {}, raw ? {} : { 'Content-Type': 'application/json' }), body: raw || JSON.stringify(b) });

  // accounts + image upload
  let r = await post('/api/register', { username: 'alice', password: 'secret1' });
  const { token } = await r.json();
  assert.equal((await post('/api/login', { username: 'alice', password: 'nope!!' })).status, 400);
  const webp = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', '0.webp'));   // a real 192x192 WebP
  r = await post('/api/images', null, token, webp);
  const img = await r.json();
  assert.ok(img.url);
  assert.equal((await post('/api/images', null, token, Buffer.from('not an image at all'))).status, 400);
  assert.equal((await fetch(base + img.url)).status, 200);

  const a = await client(port), b = await client(port);
  a.sendj({ t: 'create', token });
  const codeMsg = await a.next('lobby');
  b.sendj({ t: 'join', code: codeMsg.code, name: 'bob' });
  await b.next('joined');
  a.sendj({ t: 'setimage', slot: 3, img: img.id });
  const l = await a.next('lobby', (m) => m.images[3]);
  assert.equal(l.images[3], img.url);
  b.sendj({ t: 'setimage', slot: 4, img: img.id });          // non-creator is ignored
  // the same image cannot be used in a second slot
  a.sendj({ t: 'setimage', slot: 5, img: img.id });
  assert.match((await a.next('editerr')).msg, /slot 4/);

  a.sendj({ t: 'ready', v: true }); b.sendj({ t: 'ready', v: true });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.equal(sa.images[3], img.url);
  assert.equal(sa.images[4], undefined);
  assert.equal(sa.stack.length, 15);   // default cards per player

  // both click the same centre card: exactly one wins, the other is rejected
  const common = (x, y) => x.find((s) => y.includes(s));
  a.sendj({ t: 'play', i: 0, s: common(sa.stack[0], sa.center) });
  b.sendj({ t: 'play', i: 0, s: common(sb.stack[0], sb.center) });
  const first = await a.next('play');
  assert.deepEqual(first.card, first.by === sa.you ? sa.stack[0] : sb.stack[0]);
  const loserWs = first.by === sa.you ? b : a;
  // the loser is rejected, unless their symbol also happens to be on the winner's new card (then both are valid)
  const second = (await loserWs.next(['rej', 'play'], (m) => m.t === 'rej' || m.by !== first.by)).t;
  assert.ok(second === 'rej' || second === 'play');

  // a wrong symbol is always rejected
  const nextIdx = second === 'play' ? 1 : 0;
  loserWs.sendj({ t: 'play', i: nextIdx, s: 9999 });
  await loserWs.next('rej', (m) => m.i === nextIdx);
  a.close(); b.close();
  // the choice was saved on the account: a new room starts with it
  const c = await client(port);
  c.sendj({ t: 'create', token });
  assert.equal((await c.next('lobby')).images[3], img.url);
  // deleting the image removes it from the saved set
  await fetch(`${base}/api/images/${img.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  c.sendj({ t: 'leave' });
  c.sendj({ t: 'create', token });
  assert.deepEqual((await c.next('lobby', (m) => m.players.length === 1)).images, {});
  c.close();
  server.close();
});

test('deck size, cancel, stats and account deletion', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port, base = `http://localhost:${port}`;
  const post = (u, b, tok) => fetch(base + u, { method: 'POST', headers: Object.assign(tok ? { Authorization: 'Bearer ' + tok } : {}, { 'Content-Type': 'application/json' }), body: JSON.stringify(b) });
  const { token } = await (await post('/api/register', { username: 'carol', password: 'secret1' })).json();
  const webp = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', '0.webp'));   // a real 192x192 WebP
  const img = await (await fetch(base + '/api/images', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: webp })).json();

  const a = await client(port), b = await client(port);
  a.sendj({ t: 'create', token });
  const code = (await a.next('lobby')).code;
  b.sendj({ t: 'join', code, name: 'bob' });
  await b.next('joined');

  // only the creator can change the deck size; invalid sizes are ignored
  b.sendj({ t: 'setdeck', q: 5 });
  a.sendj({ t: 'setdeck', q: 6 });
  a.sendj({ t: 'setdeck', q: 3 });
  const l = await a.next('lobby', (m) => m.q === 3);
  assert.equal(l.n, 13);

  // 13 cards, 2 players: 6 cards each; slots beyond the deck are rejected
  a.sendj({ t: 'setimage', slot: 13, img: img.id });
  a.sendj({ t: 'setimage', slot: 12, img: img.id });
  assert.equal((await a.next('lobby', (m) => m.images[12])).images[12], img.url);
  // changing the room's images makes everybody confirm again (so nobody starts before the new pictures are downloaded)
  a.sendj({ t: 'ready', v: true });
  await a.next('lobby', (m) => m.players.some((p) => p.ready));
  a.sendj({ t: 'resetimages' });
  await a.next('lobby', (m) => m.players.every((p) => !p.ready) && !m.images[12]);

  // the creator chooses the cards per player; asking for more than the deck can deal is refused at start
  b.sendj({ t: 'setstack', n: 2 });                    // not the creator: ignored
  a.sendj({ t: 'setstack', n: 99 });                   // more than the deck holds: ignored
  a.sendj({ t: 'setstack', n: 8 });
  const ls = await a.next('lobby', (m) => m.stack === 8);
  assert.equal(ls.maxStack, 6);                        // (13 - 1) / 2 players
  a.sendj({ t: 'ready', v: true }); b.sendj({ t: 'ready', v: true });
  assert.match((await a.next('notice')).msg, /Lower the cards per player/);
  a.sendj({ t: 'setstack', n: 4 });
  await a.next('lobby', (m) => m.stack === 4 && m.players.every((p) => !p.ready));

  // start, then the creator cancels the running game
  a.sendj({ t: 'ready', v: true }); b.sendj({ t: 'ready', v: true });
  const [sa, sb] = await Promise.all([a.next('start'), b.next('start')]);
  assert.equal(sa.n, 13); assert.equal(sa.stack.length, 4); assert.equal(sa.total, 4);
  const common = (x, y) => x.find((s) => y.includes(s));
  const sym = common(sa.stack[0], sa.center);
  a.sendj({ t: 'play', i: 0, s: sym });
  const played = await b.next('play');
  assert.equal(played.s, sym);                         // everybody learns which symbol matched
  b.sendj({ t: 'cancel' });                            // not the creator: ignored
  a.sendj({ t: 'cancel' });
  assert.equal((await b.next('cancelled')).playing, true);
  const back = await b.next('lobby', (m) => m.state === 'lobby');
  assert.ok(back.players.every((p) => !p.ready));

  // play a full game alone against the clock to check the end-of-game report
  a.sendj({ t: 'ready', v: true }); b.sendj({ t: 'ready', v: true });
  const [s2] = await Promise.all([a.next('start'), b.next('start')]);
  let center = s2.center;
  for (let i = 0; i < s2.stack.length; i++) {
    a.sendj({ t: 'play', i, s: common(s2.stack[i], center) });
    center = (await a.next('play', (m) => m.by === s2.you && JSON.stringify(m.card) === JSON.stringify(s2.stack[i]))).card;
  }
  const end = await a.next('end');
  assert.equal(end.winner, s2.you);
  assert.equal(end.ranking[0].played, 4);
  assert.equal(end.ranking[0].misses, 0);
  assert.ok(end.totalMs >= 0 && end.ranking[0].avgMs >= 0);
  assert.equal(end.cards, 13);
  assert.equal(end.games, 1);                          // the cancelled game did not count
  assert.equal(end.ranking.find((r) => r.id === s2.you).wins, 1);
  const tally = await a.next('lobby', (m) => m.games === 1);
  assert.equal(tally.players.find((p) => p.id === s2.you).wins, 1);
  assert.equal(tally.players.find((p) => p.id !== s2.you).wins, 0);

  // account deletion needs the password and removes the images
  assert.equal((await post('/api/delete-account', { password: 'wrong!' }, token)).status, 400);
  assert.equal((await post('/api/delete-account', { password: 'secret1' }, token)).status, 200);
  assert.equal((await fetch(base + img.url)).status, 404);
  assert.equal((await post('/api/login', { username: 'carol', password: 'secret1' })).status, 400);
  assert.equal((await fetch(base + '/api/images', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  a.close(); b.close();
});

test('admin overview, usage statistics and client config', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
  // config for the browser: deck sizes and the (configurable) connection timeout
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.connectionTimeoutMs, 7000);
  assert.equal(cfg.appName, 'MatchMe');
  assert.equal(cfg.decks.length, 10);
  // the admin page needs the credentials from .env
  assert.equal((await fetch(base + '/admin')).status, 401);
  assert.equal((await fetch(base + '/admin', { headers: basic('boss', 'wrong') })).status, 401);
  const ok = await fetch(base + '/admin', { headers: basic('boss', 's3cret:with:colons') });
  assert.equal(ok.status, 200);
  const html = await ok.text();
  assert.match(html, /admin/i);
  assert.match(html, /Games finished/);
  // the earlier tests played full games, so they must show up in the statistics
  const { statsOverview } = require('./db');
  const s = statsOverview();
  assert.ok(s.totals.game_finished >= 1 && s.totals.room_created >= 1 && s.totals.register >= 1 && s.totals.connection >= 1);
  assert.ok(s.gameSummary.n >= 1 && s.recent.length >= 1);
  // without credentials configured the page does not exist
  const { adminAuth } = require('./admin');
  const keep = [process.env.ADMIN_USER, process.env.ADMIN_PASSWORD];
  delete process.env.ADMIN_PASSWORD;
  assert.equal(adminAuth({ headers: {} }), null);
  [process.env.ADMIN_USER, process.env.ADMIN_PASSWORD] = keep;
});

// ------------------------------------------------------------------ uploads and request security
const sharp = require('sharp');
const solid = (w, h, fmt = 'png') => sharp({ create: { width: w, height: h, channels: 3, background: '#3366aa' } })[fmt]().toBuffer();

test('uploads: any PNG/JPEG/WebP is shrunk to a small WebP; anything else is refused; served so it can never run as a page', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'eve', password: 'secret1' }) })).json();
  const up = (body) => fetch(base + '/api/images', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
  const stored = async (r) => { const j = await r.json(); const img = await fetch(base + j.url); return { res: img, buf: Buffer.from(await img.arrayBuffer()), url: j.url }; };

  // a big photo-sized image is downscaled (fits in 256 x 256), converted to WebP, and stays tiny
  const big = await up(await solid(3000, 2000));
  assert.equal(big.status, 200);
  const b = await stored(big);
  const meta = await sharp(b.buf).metadata();
  assert.equal(meta.format, 'webp');
  assert.ok(meta.width <= 256 && meta.height <= 256 && meta.width === 256, `${meta.width}x${meta.height}`);
  assert.ok(b.buf.length < 20 * 1024);
  // small images are kept at their size (no enlarging); JPEG and WebP work too
  const small = await stored(await up(await solid(100, 60, 'jpeg')));
  assert.equal((await sharp(small.buf).metadata()).width, 100);
  assert.equal((await up(fs.readFileSync(path.join(__dirname, '..', 'public', 'img', '0.webp')))).status, 200);
  // a valid picture with a script appended: the stored file is a fresh re-encode without the extra bytes
  const polyglot = Buffer.concat([await solid(64, 64), Buffer.from('<script>alert(1)</script>')]);
  const pg = await stored(await up(polyglot));
  assert.ok(!pg.buf.includes('<script>'));

  // refused: SVG with a script, HTML, random bytes, truncated files, GIF, decompression bombs, oversized uploads
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 400);
  assert.equal((await up(Buffer.from('<html><script>alert(1)</script></html>'))).status, 400);
  assert.equal((await up(Buffer.alloc(100, 7))).status, 400);
  assert.equal((await up((await solid(200, 200)).subarray(0, 60))).status, 400);
  assert.equal((await up(Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'latin1'))).status, 400);
  assert.equal((await up(await solid(6500, 6500))).status, 400);                 // 42 megapixels: too many pixels to decode
  assert.equal((await up(Buffer.alloc(9 * 1024 * 1024, 1))).status, 413);        // answered, not just disconnected
  // without a login nothing can be uploaded
  assert.equal((await fetch(base + '/api/images', { method: 'POST', body: await solid(10, 10) })).status, 401);

  // served as a picture only: right type, no sniffing, no scripts, not embeddable elsewhere
  assert.equal(b.res.status, 200);
  assert.equal(b.res.headers.get('content-type'), 'image/webp');
  assert.equal(b.res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(b.res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(b.res.headers.get('cross-origin-resource-policy'), 'same-origin');
  // only the exact generated names are served from /u/
  for (const bad of ['/u/../package.json', '/u/%2e%2e/package.json', '/u/abc.webp', '/u/' + 'a'.repeat(24) + '.svg', '/u/' + 'a'.repeat(24) + '.html', '/u/']) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
});

test('a malformed URL does not crash the server, and unknown pages show the 404 page', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  const nf = await fetch(base + '/no/such/page');
  assert.equal(nf.status, 404);
  assert.match(await nf.text(), /Page not found/);
  assert.equal((await fetch(base + '/server/server.js')).status, 404);          // source files are not served
  assert.equal((await fetch(base + '/')).headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(base + '/api/config')).status, 200);                // still alive
});

test('login attempts are rate limited', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  let limited = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nobody', password: 'wrongpass' }) });
    if (r.status === 429) limited++;
  }
  assert.ok(limited >= 5, `expected the limiter to kick in, got ${limited}`);
});

test('a player who loses the connection keeps their seat and can resume it, also in a running game', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const a = await client(port), b = await client(port);
  a.sendj({ t: 'create', name: 'Ann' });
  const ja = await a.next('joined');
  const code = (await a.next('lobby')).code;
  b.sendj({ t: 'join', code, name: 'Bob' });
  const jb = await b.next('joined');
  assert.ok(ja.secret && jb.secret && ja.secret !== jb.secret);
  // a wrong secret is refused
  const x = await client(port);
  x.sendj({ t: 'resume', code, id: jb.you, secret: 'f'.repeat(jb.secret.length) });
  await x.next('resumefail'); x.close();
  // Bob drops in the lobby: his seat stays, marked away
  b.close();
  const away = await a.next('lobby', (m) => m.players.some((p) => p.away));
  assert.equal(away.players.length, 2);
  const b2 = await client(port);
  b2.sendj({ t: 'resume', code, id: jb.you, secret: jb.secret });
  const re = await b2.next('joined');
  assert.equal(re.resumed, true); assert.equal(re.you, jb.you);
  await a.next('lobby', (m) => m.players.every((p) => !p.away));
  // start a game, drop Bob mid-game, he comes back with his cards
  a.sendj({ t: 'ready', v: true }); b2.sendj({ t: 'ready', v: true });
  const sb = await b2.next('start');
  await a.next('start');
  b2.close();
  const b3 = await client(port);
  b3.sendj({ t: 'resume', code, id: jb.you, secret: jb.secret });
  const again = await b3.next('start');
  assert.deepEqual(again.stack, sb.stack);
  assert.deepEqual(again.center, sb.center);
  assert.equal(again.resume.played, 0);
  // leaving for good frees the seat at once
  b3.sendj({ t: 'leave' });
  await a.next('prog');
  a.close(); b3.close();
});

test('an account can keep several sets of picks and switch between them', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port, base = `http://localhost:${port}`;
  const post = (u, b, tok, raw) => fetch(base + u, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + tok }, raw ? {} : { 'Content-Type': 'application/json' }), body: raw || JSON.stringify(b) });
  const { token } = await (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'setter', password: 'secret1' }) })).json();
  const webp = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', '0.webp'));
  const i1 = await (await post('/api/images', null, token, webp)).json();
  const i2 = await (await post('/api/images', null, token, webp)).json();

  const a = await client(port);
  a.sendj({ t: 'create', token });
  const s0 = await a.next('sets');
  assert.equal(s0.sets.length, 1); assert.equal(s0.sets[0].name, 'Set 1');
  const first = s0.current;
  a.sendj({ t: 'setimage', slot: 1, img: i1.id });
  assert.equal((await a.next('lobby', (m) => m.images[1])).images[1], i1.url);
  // a new set starts empty, and the picks are kept per set
  a.sendj({ t: 'newset', name: '  Second   set ' });
  const s1 = await a.next('sets', (m) => m.sets.length === 2);
  assert.equal(s1.sets[1].name, 'Second set'); assert.notEqual(s1.current, first);
  assert.deepEqual((await a.next('lobby', (m) => !m.images[1])).images, {});
  a.sendj({ t: 'setimage', slot: 2, img: i2.id });
  await a.next('lobby', (m) => m.images[2]);
  a.sendj({ t: 'useset', id: first });
  assert.deepEqual((await a.next('lobby', (m) => m.images[1])).images, { 1: i1.url });
  // somebody else's set id is refused; renaming and deleting work
  a.sendj({ t: 'useset', id: 99999 });
  a.sendj({ t: 'renameset', name: 'Mine' });
  assert.equal((await a.next('sets', (m) => m.sets[0].name === 'Mine')).current, first);
  a.sendj({ t: 'delset' });
  const after = await a.next('sets', (m) => m.sets.length === 1);
  assert.equal(after.sets[0].name, 'Second set');
  // a new room by the same account starts with the set used last
  a.close();
  const c = await client(port);
  c.sendj({ t: 'create', token });
  const s2 = await c.next('sets');
  assert.equal(s2.current, after.current);
  assert.deepEqual((await c.next('lobby')).images, { 2: i2.url });
  // deleting an image removes it from every set
  assert.equal((await fetch(base + '/api/images/' + i2.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } })).status, 200);
  c.close();
});

test('the room creator can kick players out of the lobby, nobody else can, and not during a game', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const a = await client(port), b = await client(port), c = await client(port);
  a.sendj({ t: 'create', name: 'Ann' });
  const ja = await a.next('joined'); const code = (await a.next('lobby')).code;
  b.sendj({ t: 'join', code, name: 'Bob' }); const jb = await b.next('joined');
  c.sendj({ t: 'join', code, name: 'Cy' }); const jc = await c.next('joined');
  b.sendj({ t: 'kick', id: jc.you });                         // a non-creator is ignored
  a.sendj({ t: 'kick', id: ja.you });                         // the creator cannot kick themselves
  a.sendj({ t: 'kick', id: jb.you });
  await b.next('kicked');
  const l = await a.next('lobby', (m) => m.players.length === 2 && m.players[1].name === 'Cy');
  assert.deepEqual(l.players.map((p) => p.name), ['Ann', 'Cy']);
  // after the kick Bob can join again as a new player (a kick is not a ban) but has no seat to resume
  b.sendj({ t: 'resume', code, id: jb.you, secret: jb.secret });
  await b.next('resumefail');
  // no kicking while a game runs
  a.sendj({ t: 'ready', v: true }); c.sendj({ t: 'ready', v: true });
  await a.next('start'); await c.next('start');
  a.sendj({ t: 'kick', id: jc.you });
  c.sendj({ t: 'ping', c: 1 });
  await c.next('pong');
  assert.equal(rooms.get(code).players.length, 2);
  a.close(); b.close(); c.close();
});

test('creator options: hand over the host role, lock the room, penalty length, start without waiting', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const common = (x, y) => x.find((s) => y.includes(s));
  const a = await client(port), b = await client(port), c = await client(port);
  a.sendj({ t: 'create', name: 'Ann' });
  const ja = await a.next('joined'); const code = (await a.next('lobby')).code;
  b.sendj({ t: 'join', code, name: 'Bob' }); const jb = await b.next('joined');

  // lock: only the creator can; new players are refused, a seat holder can still resume
  b.sendj({ t: 'lock', v: true });
  a.sendj({ t: 'lock', v: true });
  assert.equal((await a.next('lobby', (m) => m.locked)).locked, true);
  c.sendj({ t: 'join', code, name: 'Cy' });
  assert.match((await c.next('error')).msg, /locked/);
  a.sendj({ t: 'lock', v: false });
  await a.next('lobby', (m) => !m.locked);
  c.sendj({ t: 'join', code, name: 'Cy' }); const jc = await c.next('joined');

  // penalty length: 1-5 whole seconds, creator only, it reaches the start message
  b.sendj({ t: 'setpenalty', ms: 1000 });
  a.sendj({ t: 'setpenalty', ms: 7000 });
  a.sendj({ t: 'setpenalty', ms: 1500 });
  a.sendj({ t: 'setpenalty', ms: 2000 });
  assert.equal((await a.next('lobby', (m) => m.penaltyMs === 2000)).penaltyMs, 2000);

  // host hand-over: only the creator, not to oneself
  b.sendj({ t: 'host', id: jb.you });
  a.sendj({ t: 'host', id: ja.you });
  a.sendj({ t: 'host', id: jb.you });
  assert.equal((await a.next('lobby', (m) => m.creator === jb.you)).creator, jb.you);
  a.sendj({ t: 'setpenalty', ms: 4000 });                      // Ann is no longer the creator: ignored
  b.sendj({ t: 'setstack', n: 1 });
  await b.next('lobby', (m) => m.stack === 1);

  // start now: Bob (host) and Ann are ready, Cy is not: Cy sits this game out
  c.sendj({ t: 'startnow' });                                  // ignored, Cy is not the host
  a.sendj({ t: 'ready', v: true });
  await b.next('lobby', (m) => m.players.find((p) => p.id === ja.you).ready);
  b.sendj({ t: 'startnow' });
  const sb = await b.next('start'), sa = await a.next('start');
  assert.equal(sb.penaltyMs, 2000);
  assert.deepEqual(sb.players.map((p) => p.id).sort(), [ja.you, jb.you].sort());
  const sat = await c.next('lobby', (m) => m.state === 'playing');
  assert.equal(sat.players.find((p) => p.id === jc.you).sit, true);
  // the sitter cannot play; the players can finish, and only they get the results
  c.sendj({ t: 'play', i: 0, s: 1 });
  b.sendj({ t: 'play', i: 0, s: common(sb.stack[0], sb.center) });
  const end = await b.next('end'); await a.next('end');
  assert.equal(end.ranking.length, 2);
  const back = await c.next('lobby', (m) => m.state === 'lobby' && m.games === 1);
  assert.ok(back.players.every((p) => !p.sit));
  a.close(); b.close(); c.close();
});

test('cross-origin isolation headers (for the multi-threaded editor model) and file types of the model files', async () => {
  if (!server.listening) await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const r = await fetch(base + '/');
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
  // model files are downloaded by `npm run fetch-model`; when they are present they must be served with the right types and cached
  const wasm = path.join(__dirname, '..', 'public', 'vendor', 'ort-wasm-simd-threaded.wasm');
  if (fs.existsSync(wasm)) {
    const w = await fetch(base + '/vendor/ort-wasm-simd-threaded.wasm');
    assert.equal(w.status, 200); assert.equal(w.headers.get('content-type'), 'application/wasm');
    assert.match(w.headers.get('cache-control'), /max-age/);
    assert.equal((await fetch(base + '/models/HRusby/mobilesam-onnx/config.json')).headers.get('content-type'), 'application/json');
  }
});
