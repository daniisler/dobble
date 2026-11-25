'use strict';
const $ = (id) => document.getElementById(id);
const BASE = 57;                 // default images needed for the standard deck: loaded before the app opens
const defaultUrl = (i) => `/img/${i}.webp`;
let DECKS = [2, 3, 4, 5, 7, 8, 9, 11, 13, 16].map((q) => ({ q, cards: q * q + q + 1, perCard: q + 1 }));

// ------------------------------------------------------------ image cache
// Every image is fetched AND decoded before it is ever needed, so swapping a
// card is just DOM work on already-decoded bitmaps.
const cache = new Map();      // url -> Promise<HTMLImageElement | null>
const ready = new Map();      // url -> HTMLImageElement (decoded)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG_TIMEOUT = 4000, IMG_TRIES = 3;
// One attempt: resolves when the file has arrived, rejects on error or when it takes longer than IMG_TIMEOUT.
function loadOnce(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const t = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, IMG_TIMEOUT);
    img.onload = () => { clearTimeout(t); resolve(img); };
    img.onerror = () => { clearTimeout(t); reject(new Error('error')); };
    img.src = url;
  });
}
// Decoding is a bonus (it makes the first draw instant), so it may never block: background tabs can leave decode() pending.
async function decodeSoon(img) {
  if (!img.decode) return;
  try { await Promise.race([img.decode(), sleep(1500)]); } catch { }
}
// Never hangs: every attempt has a timeout and a stalled or failed image is retried (with a cache-busting query).
// Resolves to null if it still fails; the failure is not remembered, so a later call tries again.
function preload(url) {
  if (cache.has(url)) return cache.get(url);
  const p = (async () => {
    for (let a = 0; a < IMG_TRIES; a++) {
      try {
        const img = await loadOnce(a ? `${url}?r=${a}` : url);
        await decodeSoon(img);
        ready.set(url, img);
        return img;
      } catch { await sleep(300 * (a + 1)); }
    }
    cache.delete(url);
    return null;
  })();
  cache.set(url, p);
  return p;
}
// Which images does a player download? (1) the 57 default images of the standard deck, before the app opens (they
// are cached by the browser, so repeat visits cost nothing); (2) after joining or creating a room, exactly the images
// that room's deck needs (a bigger deck needs more default images, custom images come from the creator's uploads), and
// again every time the creator changes the deck size or an image. The Ready button waits for all of them.
const roomUrls = (m) => Array.from({ length: m.n }, (_, i) => m.images[i] || defaultUrl(i));
const preloadRoom = (m) => roomUrls(m).filter((u) => !ready.has(u)).forEach(preload);

// ------------------------------------------------------------ theme
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').textContent = t === 'light' ? '🌙' : '☀️';
  try { localStorage.setItem('theme', t); } catch { }
}
$('theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
setTheme(document.documentElement.dataset.theme || 'dark');

// ------------------------------------------------------------ screens
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'home') closeCreateDialog();
  if (id === 'game') resetZoom();
}

// Phones zoom in when a text field is focused (and stay zoomed). Before a game the page must be at 100 % again:
// drop focus, then briefly lock the viewport scale, which makes the browser snap back, and release it.
function resetZoom() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const meta = document.querySelector('meta[name=viewport]');
  if (!meta) return;
  const original = meta.content;
  meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
  window.scrollTo(0, 0);
  setTimeout(() => { meta.content = original; if (typeof fitCards === 'function') try { fitCards(); } catch { } }, 150);
}

// ------------------------------------------------------------ state
let ws, token = localStorage.getItem('token') || null, username = null;
let me = null, lobby = null, selectedLib = null, library = [], lobbyNotice = '';
let G = null;   // game state

// ------------------------------------------------------------ websocket
let openWaiters = [];
const whenConnected = () => (ws && ws.readyState === 1 ? Promise.resolve() : new Promise((r) => openWaiters.push(r)));
// Our seat in a room ({code, id, secret}) is kept in sessionStorage: after a dropped connection or a page reload the
// browser asks the server for the same seat back (the server holds it for RECONNECT_GRACE_SECONDS).
let seat = null, reconnectTimer = 0;
try { seat = JSON.parse(sessionStorage.getItem('seat') || 'null'); } catch { }
function setSeat(v) { seat = v; try { v ? sessionStorage.setItem('seat', JSON.stringify(v)) : sessionStorage.removeItem('seat'); } catch { } }
function backToStart() {
  hideConn(); send({ t: 'leave' }); setSeat(null);
  me = null; lobby = null; G = null; $('count').hidden = true; $('overlay').hidden = true; $('banner').hidden = true;
  show('home');
}
function connect() {
  if (ws && ws.readyState <= 1) return;
  clearTimeout(reconnectTimer);
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  const mine = ws;
  const stuck = setTimeout(() => { if (mine.readyState === 0) mine.close(); }, 6000);   // a connection attempt that never answers is retried
  ws.onopen = () => {
    clearTimeout(stuck); lastMsgAt = performance.now(); openWaiters.splice(0).forEach((r) => r());
    if (seat) mine.send(JSON.stringify({ t: 'resume', code: seat.code, id: seat.id, secret: seat.secret, token }));
  };
  ws.onmessage = (e) => { lastMsgAt = performance.now(); onMsg(JSON.parse(e.data)); if (connShown === 'stall' && !playStuck()) hideConn(); };
  ws.onclose = () => {
    clearTimeout(stuck);
    if (seat && $('loading').classList.contains('active') === false && !$('home').classList.contains('active')) {
      showConn('Connection lost. Trying to reconnect to your room…', 'closed');   // the room, the game and our cards stay as they are
    }
    reconnectTimer = setTimeout(connect, 1000);
  };
}
const connected = () => !!ws && ws.readyState === 1;
const send = (o) => connected() && (ws.send(JSON.stringify(o)), true);

// ---- connection watchdog: the server answers pings; if nothing has come back for STALL_MS (default 5 s), or a card
// we played has not been answered for that long, tell the player that the connection is lost.
let STALL_MS = 5000;     // overridden by the server (CONNECTION_TIMEOUT_SECONDS in .env)
let pingTimer = 0;
let lastMsgAt = 0, connShown = null;
function playStuck() { return !!(G && G.active && G.pending.length && G.pendingSince && performance.now() - G.pendingSince > STALL_MS); }
function showConn(msg, kind) { connShown = kind; $('connmsg').textContent = msg; $('connlost').hidden = false; }
function hideConn() { connShown = null; $('connlost').hidden = true; }
$('connbtn').onclick = backToStart;
$('connretry').onclick = () => {
  $('connmsg').textContent = 'Reconnecting…';
  if (ws && ws.readyState === 1) { try { ws.close(); } catch { } }   // a stalled connection: drop it, the new one resumes our seat
  else connect();
};
function startPings() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (connected()) ws.send('{"t":"ping"}'); }, Math.max(500, Math.min(2000, STALL_MS / 2.5)));
}
startPings();
setInterval(() => {
  if (!ws || ws.readyState !== 1 || me == null || connShown) return;
  if (performance.now() - lastMsgAt > STALL_MS || playStuck()) showConn('The server is not responding. Check your internet connection.', 'stall');
}, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastMsgAt = performance.now(); if (G && G.pendingSince) G.pendingSince = performance.now(); } });

function onMsg(m) {
  switch (m.t) {
    case 'joined':
      me = m.you; mySets = null; setSeat({ code: m.code, id: m.you, secret: m.secret });
      if (m.resumed) {
        hideConn();
        if (m.state !== 'playing') { G = null; $('overlay').hidden = true; $('banner').hidden = true; }   // the game ended or was cancelled meanwhile
      }
      break;
    case 'resumefail':
      setSeat(null); me = null; lobby = null; G = null; hideConn(); $('count').hidden = true; $('overlay').hidden = true; $('banner').hidden = true;
      show('home'); $('homeerr').textContent = 'Your room is no longer available.';
      break;
    case 'error': $('homeerr').textContent = m.msg; break;
    case 'sets': mySets = m; renderSets(); break;
    case 'editerr': $('editorerr').textContent = m.msg; break;
    case 'notice': setNotice(m.msg); break;
    case 'lobby': onLobby(m); break;
    case 'count': onCount(m); break;
    case 'cancelled': onCancelled(m); break;
    case 'start': onStart(m); break;
    case 'play': onPlay(m); break;
    case 'prog': onProg(m); break;
    case 'rej': onRej(m); break;
    case 'end': onEnd(m); break;
  }
}

// ------------------------------------------------------------ home / accounts
async function api(method, url, body, raw) {
  const r = await fetch(url, { method, headers: Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, raw ? {} : { 'Content-Type': 'application/json' }), body: raw ? body : body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(j.error || 'Request failed'); err.status = r.status; throw err; }
  return j;
}
function renderAuth() {
  $('nickrow').hidden = !!username;
  $('member').hidden = !username;
  if (!username) $('delform').hidden = true;
  $('whoami').textContent = username || '';
}
function setSession(r) { token = r.token; username = r.username; localStorage.setItem('token', token); }
function clearSession() { mySets = null; token = null; username = null; library = []; localStorage.removeItem('token'); renderAuth(); }

$('btn-logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch { } clearSession(); };
$('btn-delete').onclick = () => { $('delform').hidden = false; $('delerr').textContent = ''; $('delpass').focus(); };
$('del-cancel').onclick = () => { $('delform').hidden = true; $('delpass').value = ''; };
$('del-go').onclick = async () => {
  try {
    await api('POST', '/api/delete-account', { password: $('delpass').value });
    $('delpass').value = ''; $('delform').hidden = true; clearSession();
    $('homeerr').textContent = 'Your account and all your images were deleted.';
  } catch (e) { $('delerr').textContent = e.message; }
};

$('btn-join').onclick = () => {
  $('homeerr').textContent = '';
  if (!username && !$('nick').value.trim()) { $('homeerr').textContent = 'Enter a nickname first.'; $('nick').focus(); return; }
  if (!send({ t: 'join', code: $('code').value, name: $('nick').value, token })) $('homeerr').textContent = 'Not connected to the server yet, retrying…';
};
$('code').oninput = (e) => { e.target.value = e.target.value.toUpperCase(); };

// Creating a room is where accounts matter: custom images need one. Logged-in users create right away.
const createRoom = (name) => {
  if (!send({ t: 'create', name, token })) { $('homeerr').textContent = $('dlgerr').textContent = 'Not connected to the server yet, retrying…'; }
};
$('btn-create').onclick = () => {
  $('homeerr').textContent = '';
  if (username) return createRoom();
  $('homepanel').hidden = true; $('createdlg').hidden = false; $('dlgerr').textContent = '';
  $('guestnick').value = $('nick').value;
  $('user').focus();
};
function closeCreateDialog() { $('homepanel').hidden = false; $('createdlg').hidden = true; }
$('dlg-back').onclick = closeCreateDialog;
async function authThenCreate(mode) {
  try {
    setSession(await api('POST', '/api/' + mode, { username: $('user').value, password: $('pass').value }));
    $('pass').value = ''; renderAuth();
    await loadLibrary();
    createRoom();
  } catch (e) { $('dlgerr').textContent = e.message; }
}
$('createdlg').onsubmit = () => { authThenCreate('login'); return false; };
$('dlg-login').onclick = (e) => { e.preventDefault(); authThenCreate('login'); };
$('dlg-register').onclick = () => authThenCreate('register');
$('dlg-guest').onclick = () => {
  const nm = $('guestnick').value.trim();
  if (!nm) { $('dlgerr').textContent = 'Enter a nickname to play as a guest.'; $('guestnick').focus(); return; }
  $('nick').value = nm;
  createRoom(nm);
};

// ------------------------------------------------------------ lobby
function setNotice(msg) {
  lobbyNotice = msg; $('lobbyerr').textContent = msg;
  clearTimeout(setNotice.t);
  if (msg) setNotice.t = setTimeout(() => { lobbyNotice = ''; $('lobbyerr').textContent = ''; }, 8000);
}
function onLobby(m) {
  lobby = m;
  preloadRoom(m);                          // on every update, whatever screen we are on (e.g. results)
  if (G && G.active) return;               // game running; ignore lobby pushes until results are dismissed
  if (G && G.results) { G.pendingLobby = m; return; }
  showLobby();
}
const deckLabel = (d) => `${d.cards} cards · ${d.perCard} symbols per card`;
function showLobby() {
  const m = lobby;
  show('lobby');
  const isCreator = m.creator === me;
  $('roomcode').textContent = m.code;
  $('playerlist').innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><span></span>';
    li.children[0].textContent = p.name + (p.id === m.creator ? ' ★' : '') + (p.id === me ? ' (you)' : '');
    // from the second finished game on, show the wins in this room
    li.children[1].textContent = (m.games >= 2 ? `🏆 ${p.wins}` + (p.ready ? ' · ' : '') : '') + (p.away ? 'reconnecting…' : p.ready ? 'ready' : '');
    if (p.ready) li.children[1].className = 'ready';
    $('playerlist').appendChild(li);
  }
  // deck size: the creator picks, everybody sees
  const sel = $('deck');
  if (sel.options.length !== DECKS.length) {
    sel.replaceChildren(...DECKS.map((d) => { const o = document.createElement('option'); o.value = d.q; o.textContent = deckLabel(d); return o; }));
  }
  sel.value = m.q; sel.hidden = !isCreator; $('deckrow').querySelector('label').hidden = !isCreator;
  const cur = DECKS.find((d) => d.q === m.q);
  $('decktext').textContent = isCreator
    ? `${cur.cards} cards → ${cur.perCard} symbols on every card. Any two cards share exactly one symbol. ` +
    `This deck needs ${m.n} different images (slots you don't fill use the default images).`
    : `Deck: ${deckLabel(cur)}`;
  // cards per player: the creator chooses how long the game is
  const ssel = $('stack');
  const presets = m.maxStack <= 20 ? Array.from({ length: m.maxStack }, (_, i) => i + 1)     // small decks: every number
    : [3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200].filter((v) => v <= m.maxStack).concat([m.maxStack]);
  const opts = [...new Set(presets.concat([m.stack]))].filter((v) => v >= 1).sort((a, b) => a - b);
  ssel.replaceChildren(...opts.map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v === m.maxStack ? `${v} (maximum)` : String(v); return o; }));
  ssel.value = m.stack; ssel.hidden = !isCreator; $('stacklabel').hidden = !isCreator;
  const np = m.players.length, tooMany = m.stack > m.maxStack;
  $('stacktext').textContent = tooMany
    ? `${np} player${np === 1 ? '' : 's'} × ${m.stack} cards is more than this deck can deal. At most ${m.maxStack} per player, so lower it or choose a bigger deck.`
    : isCreator ? `Each player gets ${m.stack} cards and the first to play them all wins. With ${np} player${np === 1 ? '' : 's'} this deck allows up to ${m.maxStack} each.`
      : `Cards per player: ${m.stack}`;
  $('stacktext').classList.toggle('err', tooMany);
  const mine = m.players.find((p) => p.id === me);
  const btn = $('btn-ready');
  btn.classList.toggle('on', !!(mine && mine.ready));
  btn.textContent = mine && mine.ready ? 'Ready ✓' : 'Ready';
  $('lobbystatus').textContent = m.state === 'countdown' ? 'Starting…' : 'The game starts when everyone is ready.';
  $('crowdwarn').hidden = np <= 6;
  $('crowdwarn').textContent = `${np} players: with more than 6 players the game can get crowded.`;
  $('lobbyerr').textContent = lobbyNotice;
  // make sure the full image set for this room is decoded before the player can ready up
  const need = roomUrls(m).filter((u) => !ready.has(u));
  btn.disabled = need.length > 0;
  if (need.length) {
    btn.textContent = 'Loading images…'; Promise.all(need.map(preload)).then(async () => {
      if (lobby !== m) return;
      if (need.some((u) => !ready.has(u))) await sleep(2000);          // some image failed: wait a moment, then try again
      if (lobby === m) showLobby();
    });
  }
  renderEditor();
}
$('deck').onchange = (e) => send({ t: 'setdeck', q: +e.target.value });
$('stack').onchange = (e) => send({ t: 'setstack', n: +e.target.value });
$('btn-ready').onclick = () => {
  const mine = lobby.players.find((p) => p.id === me);
  setNotice('');
  send({ t: 'ready', v: !(mine && mine.ready) });
};
$('btn-leave').onclick = backToStart;

function onCount(m) {
  $('count').hidden = !m.n;
  $('countnum').textContent = m.n;
  $('btn-cancel-count').hidden = !(lobby && lobby.creator === me);
}
$('btn-cancel-count').onclick = () => send({ t: 'cancel' });
function onCancelled(m) {
  $('count').hidden = true; $('overlay').hidden = true; $('btn-cancel').hidden = true;
  G = null;
  setNotice(m.playing ? 'The room creator cancelled the game.' : 'The room creator cancelled the start.');
}

// ---- custom image editor (lobby creator with an account)
// ---- sets of picks (the room creator's account): switch, add, rename, delete
let mySets = null;
function renderSets() {
  const on = !!(mySets && lobby && lobby.creator === me && username);
  $('setbar').hidden = !on;
  if (!on) return;
  const sel = $('setsel'); sel.innerHTML = '';
  for (const st of mySets.sets) { const o = document.createElement('option'); o.value = st.id; o.textContent = st.name; sel.appendChild(o); }
  sel.value = mySets.current;
  $('set-del').disabled = false;
}
$('setsel').onchange = (e) => { $('editorerr').textContent = ''; selectedLib = null; send({ t: 'useset', id: +e.target.value }); };
$('set-new').onclick = () => { const n = prompt('Name of the new set', `Set ${(mySets ? mySets.sets.length : 0) + 1}`); if (n !== null) { selectedLib = null; send({ t: 'newset', name: n }); } };
$('set-rename').onclick = () => {
  const cur = mySets && mySets.sets.find((x) => x.id === mySets.current);
  const n = prompt('New name for this set', cur ? cur.name : ''); if (n !== null) send({ t: 'renameset', name: n });
};
$('set-del').onclick = () => {
  const cur = mySets && mySets.sets.find((x) => x.id === mySets.current);
  if (cur && confirm(`Delete the set "${cur.name}"? Your uploaded images stay in your library.`)) { selectedLib = null; send({ t: 'delset' }); }
};

function renderEditor() {
  renderSets();
  const isCreator = lobby.creator === me;
  $('editor').hidden = !(isCreator && username);
  $('editornote').hidden = !(isCreator && !username);
  $('editornote').textContent = 'To use your own images, log in before creating a room.';
  if (!(isCreator && username)) return;
  const n = lobby.n;
  const slots = $('slots'); slots.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const custom = lobby.images[i];
    const c = document.createElement('div');
    c.className = 'cell' + (custom ? ' custom' : '');
    const img = new Image(); img.src = custom || defaultUrl(i); c.appendChild(img);
    c.onclick = () => {
      $('editorerr').textContent = '';
      if (selectedLib) { send({ t: 'setimage', slot: i, img: selectedLib }); selectedLib = null; }
      else if (custom) send({ t: 'setimage', slot: i, img: null });
    };
    slots.appendChild(c);
  }
  const lib = $('library'); lib.innerHTML = '';
  const usedAt = {};
  for (const [slot, url] of Object.entries(lobby.images)) if (+slot < n) usedAt[url] = +slot + 1;
  if (selectedLib && !library.some((im) => im.id === selectedLib && !usedAt[im.url])) selectedLib = null;
  for (const im of library) {
    const c = document.createElement('div');
    const used = usedAt[im.url];
    c.className = 'cell' + (selectedLib === im.id ? ' picked' : '') + (used ? ' used' : '');
    if (used) { c.title = `Used in slot ${used}`; const b = document.createElement('span'); b.className = 'badge'; b.textContent = '#' + used; c.appendChild(b); }
    const img = new Image(); img.src = im.url; c.appendChild(img);
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
    x.onclick = async (e) => { e.stopPropagation(); try { await api('DELETE', '/api/images/' + im.id); if (selectedLib === im.id) selectedLib = null; await loadLibrary(); } catch (er) { $('editorerr').textContent = er.message; } };
    c.appendChild(x);
    c.onclick = () => {
      if (used) { $('editorerr').textContent = `That image is already used in slot ${used}. Click that slot to free it first.`; return; }
      $('editorerr').textContent = '';
      selectedLib = selectedLib === im.id ? null : im.id; renderEditor();
    };
    lib.appendChild(c);
  }
}
async function loadLibrary() {
  if (!token) { library = []; return; }
  try { library = (await api('GET', '/api/images')).images; } catch { library = []; }
  if (lobby) renderEditor();
}
$('btn-reset').onclick = () => send({ t: 'resetimages' });
// Shrinks one picture in the browser (saves bandwidth; the server shrinks again to be safe) and uploads it.
async function uploadOne(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('not a readable image'); }
  try {
    const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const k = Math.min(s / bmp.width, s / bmp.height, 1), w = bmp.width * k, h = bmp.height * k;
    cv.getContext('2d').drawImage(bmp, (s - w) / 2, (s - h) / 2, w, h);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/webp', 0.85));
    await api('POST', '/api/images', blob, true);
  } finally { bmp.close(); }                                   // free the decoded bitmap right away (matters with many images)
}

// Uploading many pictures: three at a time, with a progress bar that fills up and a summary at the end.
let uploading = false;
$('file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || uploading) return;
  uploading = true;
  $('uploadlabel').classList.add('disabled'); $('file').disabled = true; $('btn-reset').disabled = true;
  $('editorerr').textContent = '';
  const bar = $('upprogress'), fill = $('upfill'), text = $('uptext');
  bar.hidden = false; fill.classList.remove('done'); fill.style.width = '0%';
  let next = 0, done = 0, ok = 0, stopped = '';
  const failed = [];
  const show = () => { fill.style.width = (done / files.length * 100) + '%'; text.textContent = `Uploading ${done} / ${files.length}…`; };
  show();
  const worker = async () => {
    while (next < files.length && !stopped) {
      const f = files[next++];
      try { await uploadOne(f); ok++; }
      catch (er) {
        if (er.status === 429 || /limit reached/i.test(er.message)) stopped = er.message;      // no point in trying the rest
        else failed.push(`${f.name}: ${er.message}`);
      }
      done++; show();
      if (ok && ok % 10 === 0) loadLibrary();                  // the library fills up while uploading
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await loadLibrary();
  const skipped = files.length - done;
  fill.style.width = '100%'; fill.classList.toggle('done', !stopped && !failed.length);
  text.textContent = `Done: ${ok} of ${files.length} uploaded` + (failed.length ? `, ${failed.length} failed` : '') + (skipped ? `, ${skipped} skipped` : '') + '.';
  const problems = failed.slice(0, 3).concat(failed.length > 3 ? [`and ${failed.length - 3} more`] : []);
  if (stopped) problems.unshift(`Stopped: ${stopped}`);
  $('editorerr').textContent = problems.join(' · ');
  $('uploadlabel').classList.remove('disabled'); $('file').disabled = false; $('btn-reset').disabled = false;
  uploading = false;
  setTimeout(() => { if (!uploading && !stopped && !failed.length) bar.hidden = true; }, 3000);   // a clean run hides the bar again
};

// ------------------------------------------------------------ cards
// Random circle packing inside the unit disc (the card). Circle sizes are random; the whole set is scaled so
// it fills as much of the card as the random start allows, and the card edge acts as a wall, so symbols
// spread out to the rim instead of huddling in the middle. Returns [{x, y, r}] in percent of the card box.
function packCircles(n) {
  const WALL = 0.965;
  const w = Array.from({ length: n }, () => 0.5 + Math.random());           // relative sizes (up to 3:1)
  const sumSq = w.reduce((s, v) => s + v * v, 0);
  for (const target of [0.70, 0.66, 0.62, 0.58, 0.54, 0.50, 0.46]) {
    const k = Math.sqrt(target / sumSq) * WALL;
    const r = w.map((v) => v * k);
    for (let attempt = 0; attempt < 4; attempt++) {
      const c = r.map((ri) => {
        const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * (WALL - ri);
        return { x: Math.cos(a) * d, y: Math.sin(a) * d };
      });
      const relax = () => {
        let worst = 0;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          let dx = c[j].x - c[i].x, dy = c[j].y - c[i].y, d = Math.hypot(dx, dy);
          const gap = r[i] + r[j] - d;
          if (gap <= 0) continue;
          if (gap > worst) worst = gap;
          if (d < 1e-6) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d = Math.hypot(dx, dy); }
          const f = gap / 2 / d;
          c[i].x -= dx * f; c[i].y -= dy * f; c[j].x += dx * f; c[j].y += dy * f;
        }
        for (let i = 0; i < n; i++) {                       // the card edge is a wall
          const d = Math.hypot(c[i].x, c[i].y), lim = WALL - r[i];
          if (d > lim) { c[i].x *= lim / d; c[i].y *= lim / d; }
        }
        return worst;
      };
      let worst = 1;
      for (let it = 0; it < 120 && worst > 0.004; it++) worst = relax();
      if (worst <= 0.004) return c.map((p, i) => ({ x: 50 + p.x * 50, y: 50 + p.y * 50, r: r[i] * 50 }));
    }
  }
  const out = [];                                           // fallback: ring
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; out.push({ x: 50 + 30 * Math.cos(t), y: 50 + 30 * Math.sin(t), r: 100 / (n + 2) }); }
  return out;
}

// A card keeps its layout for the whole game: the card you click looks the same in your hand and in the centre.
const layouts = new Map();
function layoutCard(card) {
  const key = card.join(',');
  let l = layouts.get(key);
  if (!l) {
    const circles = packCircles(card.length);
    // random assignment of symbols to the packed spots, each with its own random rotation
    const order = card.slice().sort(() => Math.random() - 0.5);
    l = circles.map((c, i) => ({ sym: order[i], x: c.x, y: c.y, size: c.r * 2 * 1.1, rot: Math.random() * 360 }));
    layouts.set(key, l);
  }
  return l;
}
function precomputeLayouts(cards) {            // spread the work over idle time so clicks are never blocked
  let i = 0;
  const step = () => { if (i < cards.length) { layoutCard(cards[i++]); setTimeout(step, 0); } };
  step();
}

function drawCard(el, card, interactive) {
  const frag = document.createDocumentFragment();
  for (const it of layoutCard(card)) {
    const src = G.urls[it.sym];
    const img = ready.get(src) ? ready.get(src).cloneNode() : new Image();
    if (!img.src) img.src = src;
    img.style.cssText = `left:${it.x - it.size / 2}%;top:${it.y - it.size / 2}%;width:${it.size}%;height:${it.size}%;transform:rotate(${it.rot}deg)`;
    img.dataset.sym = it.sym;
    img.draggable = false;
    if (interactive) img.className = 'hit';
    frag.appendChild(img);
  }
  el.replaceChildren(frag);
}

// ------------------------------------------------------------ game
const COLORS = ['#ff4d4d', '#4da3ff', '#3ddc84', '#ffc833', '#c77dff', '#ff8a3d', '#2ee6d6', '#ff6fb5'];
async function onStart(m) {
  const urls = [];
  for (let i = 0; i < m.n; i++) urls.push(m.images[i] || defaultUrl(i));
  await Promise.all(urls.map(preload));
  layouts.clear();
  G = {
    active: true, colors: {}, last: null, serverLast: null, serverSym: null, creator: m.creator, urls, stack: m.stack, total: m.total,
    confirmed: 0, pending: [], center: m.center, serverCenter: m.center, penaltyUntil: 0, lockKind: null, pendingSince: null, recent: [], left: {}, names: {}
  };
  m.players.forEach((p, i) => { G.names[p.id] = p.name; G.colors[p.id] = COLORS[i % COLORS.length]; });
  if (m.resume) {                                  // coming back into a running game: carry on where the server says we are
    G.confirmed = m.resume.played; G.center = G.serverCenter = m.center;
    for (const [id, n] of m.resume.left) G.left[id] = n;
    if (m.resume.penaltyMs > 0) G.penaltyUntil = performance.now() + m.resume.penaltyMs;
  }
  me = m.you;
  $('count').hidden = true; $('overlay').hidden = true; $('banner').hidden = true;
  layoutCard(m.center); m.stack.slice(0, 3).forEach(layoutCard);
  show('game');
  fitCards();
  renderAll();
  setLast(null);
  updateCancelBtn();
  precomputeLayouts(m.stack.slice(3));
}
const myIndex = () => G.confirmed + G.pending.length;

// Size both cards to use all the space under the top bar: side by side or stacked, whichever gives bigger cards.
function fitCards() {
  const t = $('table'), game = $('game');
  if (!game.classList.contains('active')) return;
  const w = t.clientWidth, h = t.clientHeight;
  const lab = (document.querySelector('.card-wrap .label').offsetHeight || 24) + 6;   // label + gap
  const ring = 16;                                                                   // room for the glow/ring around a card
  const row = Math.min((w - 16 - 2 * ring) / 2, h - lab - ring);
  const col = Math.min(w - ring, (h - 8 - 2 * lab - 2 * ring) / 2);
  const stacked = col > row;
  t.classList.toggle('col', stacked);
  game.style.setProperty('--card', Math.max(80, Math.floor(stacked ? col : row)) + 'px');
}
window.addEventListener('resize', fitCards);
if (window.ResizeObserver) new ResizeObserver(fitCards).observe($('table'));
// who played the centre card, and which symbol matched (a modest ring on that symbol)
function setLast(id, sym) {
  G.last = id;
  const c = id == null ? null : G.colors[id];
  const center = $('center');
  center.style.boxShadow = c ? `0 0 0 8px ${c}, 0 6px 30px var(--shadow)` : '';
  const l = $('label-center');
  l.textContent = id == null ? 'Centre card' : (id === me ? 'You played this card' : `${G.names[id]} played this card`);
  l.style.color = c || '';
  if (id != null) { center.classList.remove('pop'); void center.offsetWidth; center.classList.add('pop'); }
  if (c && sym != null) {
    const el = center.querySelector(`img[data-sym="${sym}"]`);
    if (el) el.style.boxShadow = `0 0 0 3px ${c}99`;
  }
  document.querySelectorAll('#hud span').forEach((el) => { if (+el.dataset.id === id) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } });
}
function updateCancelBtn() { $('btn-cancel').hidden = !(G && G.active && G.creator === me); }
$('btn-cancel').onclick = () => { if (confirm('Cancel the game for everyone?')) send({ t: 'cancel' }); };
function renderAll() {
  drawCard($('center'), G.center, false);
  renderMine();
  renderHud();
}
function renderMine() {
  const c = G.stack[myIndex()];
  if (c) drawCard($('mine'), c, true); else $('mine').replaceChildren();
}
function renderHud() {
  const hud = $('hud');
  hud.replaceChildren();
  for (const id of Object.keys(G.names).map(Number)) {
    const left = id in G.left ? G.left[id] : G.total;
    const s = document.createElement('span');
    const mineLeft = id === me ? G.stack.length - myIndex() : left;
    s.dataset.id = id;
    s.style.setProperty('--c', G.colors[id]);
    s.textContent = `${G.names[id]}${id === me ? ' (you)' : ''}: ${mineLeft}`;
    if (id === me) s.className = 'me';
    hud.appendChild(s);
  }
}

// Instant feedback: the click is applied locally right away and sent to the
// server; the server arbitrates races and we roll back on rejection.
// Touching a card must never select anything: block the long-press menu, selection and the tap's compatibility events.
for (const id of ['mine', 'center']) {
  const el = $(id);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('selectstart', (e) => e.preventDefault());
  el.addEventListener('dragstart', (e) => e.preventDefault());
  el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });   // pointerdown still fires first
}
$('mine').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const sel = window.getSelection && window.getSelection();
  if (sel && sel.rangeCount) sel.removeAllRanges();
  if (!G || !G.active) return;
  const t = e.target;
  if (!t.dataset || t.dataset.sym === undefined) return;
  if (performance.now() < G.penaltyUntil) return;
  const sym = +t.dataset.sym;
  const idx = myIndex(), card = G.stack[idx];
  if (!card) return;
  if (G.center.includes(sym)) {
    if (!G.pending.length) G.pendingSince = performance.now();
    G.pending.push(idx);
    G.center = card;
    send({ t: 'play', i: idx, s: sym });
    drawCard($('center'), G.center, false);
    renderMine();
    renderHud();
    setLast(me, sym);
  } else {
    // not a match for the centre card. Was it right a moment ago, before somebody else played over it?
    // (shown instantly; the server makes the real decision and tells us if it disagrees)
    const now = performance.now();
    const faster = card.includes(sym) && G.recent.findLast((e) => e.by !== me && now - e.at <= LATE_WINDOW && e.prev.includes(sym));
    send({ t: 'play', i: idx, s: sym });
    if (faster) showFaster(faster.by); else startLockout('wrong');
  }
});

function onPlay(m) {
  if (!G || !G.active) return;
  const now = performance.now();
  G.recent = G.recent.filter((e) => now - e.at <= 2 * LATE_WINDOW);
  G.recent.push({ prev: G.serverCenter, at: now, by: m.by });      // what the centre card was before this play
  G.serverCenter = m.card; G.serverLast = m.by; G.serverSym = m.s;
  for (const [id, n] of m.left) G.left[id] = n;
  if (m.by === me) {
    G.confirmed++;
    G.pending.shift();
    G.pendingSince = G.pending.length ? performance.now() : null;
  } else if (!G.pending.length) {
    G.center = m.card;
    drawCard($('center'), G.center, false);
  }
  renderHud();
  if (m.by !== me && !G.pending.length) setLast(m.by, m.s);
}
function onProg(m) {                      // somebody left, or the creator changed
  if (!G) return;
  G.creator = m.creator;
  const present = new Set(m.left.map((x) => x[0]));
  for (const id of Object.keys(G.names)) if (!present.has(+id)) { delete G.names[id]; delete G.left[id]; }
  for (const [id, n] of m.left) G.left[id] = n;
  updateCancelBtn();
  if (G.active) renderHud();
}
function onRej(m) {
  if (!G || !G.active) return;
  if (m.i === G.confirmed && G.pending.length) {   // roll back all optimistic plays
    G.pending = []; G.pendingSince = null;
    G.center = G.serverCenter;
    renderAll();
    setLast(G.serverLast, G.serverSym);
  }
  // the server's verdict on a wrong click: use it if our instant guess differed or was missing
  if (m.why === 'late') showFaster(m.by);
  else if (m.why === 'wrong' && (G.lockKind !== 'wrong' || performance.now() >= G.penaltyUntil)) startLockout('wrong');
}
// "X was faster!": a short banner at the top. No penalty and no pause, play simply goes on.
let bannerTimer = 0;
function showFaster(by) {
  const el = $('banner');
  el.textContent = `${G.names[by] || 'Someone'} was faster!`;
  el.style.setProperty('--c', G.colors[by] || 'var(--accent)');
  el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, 1100);
}

// Wrong symbol: 3 s lockout, with a short "Wrong symbol!" message for the first two seconds.
const LATE_WINDOW = 1000, WRONG_LOCK = 3000;
let lockRaf = 0;
function startLockout(kind) {
  G.penaltyUntil = performance.now() + WRONG_LOCK;
  G.lockKind = kind;
  $('mine').classList.add('penalty');
  const ov = $('overlay');
  ov.hidden = false;
  cancelAnimationFrame(lockRaf);
  const tick = () => {
    if (!G) { ov.hidden = true; return; }
    const left = G.penaltyUntil - performance.now();
    if (left <= 0) { ov.hidden = true; $('mine').classList.remove('penalty'); return; }
    $('pen-msg').textContent = WRONG_LOCK - left < 2000 ? 'Wrong symbol!' : '';
    $('pen-num').textContent = Math.ceil(left / 1000);
    lockRaf = requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------ results
const fmtS = (ms) => (ms / 1000).toFixed(2) + ' s';
const fmtT = (ms) => {
  const s = ms / 1000, m = Math.floor(s / 60);
  return m ? `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')} min` : `${s.toFixed(1)} s`;
};
function ordinal(n) {
  const v = n % 100;
  return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th');
}
function onEnd(m) {
  G.active = false; G.results = true;
  $('overlay').hidden = true; $('btn-cancel').hidden = true;
  const won = m.winner === me;
  const medals = ['🥇', '🥈', '🥉'];
  const w = $('winner');
  w.innerHTML = '<div class="trophy">🏆</div><h2></h2><div class="sub"></div>';
  w.querySelector('h2').textContent = won ? 'You win!' : `${G.names[m.winner] || 'Someone'} wins!`;
  w.querySelector('.sub').textContent = `Emptied the stack in ${fmtT(m.totalMs)} · ${m.cards}-card deck`;
  const place = m.ranking.findIndex((r) => r.id === me) + 1;
  const mine = m.ranking.find((r) => r.id === me);
  $('yourresult').textContent = !mine ? '' : won
    ? `${mine.misses ? mine.misses + (mine.misses > 1 ? ' misses' : ' miss') : 'No misses'}, on average ${fmtS(mine.avgMs)} per card.`
    : `You finished ${ordinal(place)} with ${mine.left} card${mine.left === 1 ? '' : 's'} left.`;

  const table = $('ranking');
  table.replaceChildren();
  const head = document.createElement('tr');
  const showWins = m.games >= 2;                                   // several games in this room: show the win tally
  for (const h of ['#', 'Player', 'Left', 'Played', 'Avg / card', 'Fastest', 'Misses'].concat(showWins ? ['Wins in room'] : [])) { const th = document.createElement('th'); th.textContent = h; head.appendChild(th); }
  table.appendChild(head);
  m.ranking.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = (r.id === m.winner ? 'win ' : '') + (r.id === me ? 'you' : '');
    const cells = [medals[i] || String(i + 1), null, r.left, r.played, r.avgMs == null ? '–' : fmtS(r.avgMs), r.bestMs == null ? '–' : fmtS(r.bestMs), r.misses].concat(showWins ? [r.wins] : []);
    cells.forEach((v, k) => {
      const td = document.createElement('td');
      if (k === 1) {
        const dot = document.createElement('span'); dot.className = 'dot'; dot.style.setProperty('--c', G.colors[r.id] || '#888');
        td.append(dot, r.name);                      // names are always inserted as text
      } else td.textContent = v;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });

  const awards = [];
  const fast = m.ranking.filter((r) => r.bestMs != null).sort((a, b) => a.bestMs - b.bestMs)[0];
  if (fast) awards.push(`⚡ Fastest card: ${fast.name} (${fmtS(fast.bestMs)})`);
  const clean = m.ranking.filter((r) => r.misses === 0 && r.played > 0);
  if (clean.length && clean.length < m.ranking.length) awards.push(`🎯 No misses: ${clean.map((r) => r.name).join(', ')}`);
  $('awards').replaceChildren(...awards.map((t) => { const s = document.createElement('span'); s.textContent = t; return s; }));
  show('results');
}
function leaveResults() {
  const l = G && G.pendingLobby; G = null;
  if (l) lobby = l;
  if (lobby) showLobby();
}
$('btn-back').onclick = leaveResults;
$('btn-again').onclick = () => { leaveResults(); send({ t: 'ready', v: true }); };

// ------------------------------------------------------------ boot
// The loading screen can never hang: images and the server connection each have timeouts and retries, we move on after
// MAX_BOOT_MS whatever is still missing (it keeps loading in the background and the Ready button waits for it), and
// if the app has still not started after RELOAD_MS the page reloads itself once, which is what a manual reload does.
const MAX_BOOT_MS = 10000, SLOW_MS = 5000, RELOAD_MS = 15000;
let booted = false;
(async function boot() {
  let n = 0;
  const bump = () => { n++; $('loadbar').style.width = (n / BASE * 100) + '%'; $('loadtext').textContent = `Loading images… ${n}/${BASE}`; };
  setTimeout(() => { if (!booted) { $('loadtext').textContent += ' (taking longer than usual…)'; $('loadreload').hidden = false; } }, SLOW_MS);
  setTimeout(() => {
    if (booted) return;
    try { if (!sessionStorage.getItem('autoReload')) { sessionStorage.setItem('autoReload', '1'); location.reload(); } } catch { }
  }, RELOAD_MS);
  connect();
  api('GET', '/api/config').then((r) => { DECKS = r.decks; STALL_MS = r.connectionTimeoutMs; startPings(); if (r.appName) document.title = r.appName; }).catch(() => { });
  await Promise.race([
    Promise.all([whenConnected(), ...[...Array(BASE).keys()].map((i) => preload(defaultUrl(i)).then(bump))]),
    sleep(MAX_BOOT_MS),
  ]);
  if (token) { try { username = (await api('GET', '/api/me')).username; await loadLibrary(); } catch { token = null; localStorage.removeItem('token'); } }
  renderAuth();
  booted = true;
  try { sessionStorage.removeItem('autoReload'); } catch { }
  $('loadreload').hidden = true;
  if (me == null) show('home');   // (a reload inside a room has already been taken back to it)
})();
$('loadreload').onclick = () => location.reload();
