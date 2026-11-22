'use strict';
// A deliberately crude admin overview: GET /admin, protected by HTTP Basic auth.
// Credentials come from ADMIN_USER / ADMIN_PASSWORD (see .env.example). If either is missing the page is disabled.
const crypto = require('crypto');
const db = require('./db');

const same = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest());

// null = admin page disabled, false = wrong/missing credentials, true = ok
function adminAuth(req) {
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) return null;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [u, ...rest] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return same(u, user) & same(rest.join(':'), pass) ? true : false;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
  rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td class="empty" colspan="${head.length}">Nothing yet</td></tr>`}</tbody></table>`;
const tile = (label, value, accent) => `<div class="tile${accent ? ' accent' : ''}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
const panel = (title, ...body) => `<section><h2>${esc(title)}</h2>${body.join('')}</section>`;
const sec = (ms) => (ms == null ? '-' : (ms / 1000).toFixed(1) + ' s');
const num = (v) => (v == null ? '-' : Math.round(v * 10) / 10);

const CSS = `
:root{--bg:#f1f3f8;--panel:#fff;--fg:#1a1f2e;--muted:#6a7390;--line:#e1e5ef;--head:#eef1f8;--accent:#ff4d4d;--ok:#14a85a}
@media (prefers-color-scheme:dark){:root{--bg:#10131c;--panel:#1a1f2e;--fg:#eef1f8;--muted:#8c94ab;--line:#2c3449;--head:#232a3d;--ok:#3ddc84}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{margin:0;font-size:1.25rem;letter-spacing:.06em}header .dot{width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px #ff4d4d33}
header .sub{color:var(--muted);margin-left:auto;font-size:.85rem}
main{max-width:1000px;margin:0 auto;padding:18px 16px 40px}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:16px;overflow-x:auto}
h2{margin:0 0 12px;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}
.tile{background:var(--head);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column}
.tile b{font-size:1.7rem;line-height:1.1}.tile span{color:var(--muted);font-size:.8rem;margin-top:2px}
.tile.accent b{color:var(--accent)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th{background:var(--head);text-align:right;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:8px 10px;white-space:nowrap}
td{text-align:right;padding:8px 10px;border-top:1px solid var(--line);white-space:nowrap}
th:first-child,td:first-child{text-align:left}tbody tr:hover{background:var(--head)}td.empty{text-align:center;color:var(--muted)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.cols section{margin:0}
`;

function renderAdmin(live) {
  const s = db.statsOverview(14);
  const t = (k) => s.totals[k] || 0;
  const days = Object.keys(s.daily).sort().reverse();
  const g = s.gameSummary;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(live.appName)} admin</title><link rel="icon" href="data:,"><style>${CSS}</style></head><body>
<header><span class="dot"></span><h1>${esc(String(live.appName).toUpperCase())} ADMIN</h1><span class="sub">${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC</span></header>
<main>
${panel('Right now', `<div class="tiles">${tile('Open rooms', live.rooms, true)}${tile('Connected players', live.players, true)}</div>`)}
${panel('Totals', `<div class="tiles">${[
    tile('Page views', t('page_view')), tile('Connections', t('connection')), tile('Rooms created', t('room_created')), tile('Rooms joined', t('room_joined')),
    tile('Games started', t('game_started')), tile('Games finished', t('game_finished')), tile('Games cancelled', t('game_cancelled')),
    tile('Accounts', s.accounts), tile('Registrations', t('register')), tile('Logins', t('login')), tile('Accounts deleted', t('account_deleted')),
    tile('Uploaded images', s.images), tile('Upload size', (s.uploadBytes / 1048576).toFixed(1) + ' MB')].join('')}</div>`)}
<div class="cols">
${panel('Finished games', table(['Games', 'Avg players', 'Avg duration', 'Misses'], [[g.n, num(g.players), sec(g.ms), g.misses || 0]]))}
${panel('By deck size', table(['Cards', 'Games', 'Avg players', 'Avg duration'], s.byDeck.map((r) => [r.cards, r.n, num(r.players), sec(r.ms)])))}
</div>
<div style="height:16px"></div>
${panel('Last 14 days (UTC)', table(['Day', 'Page views', 'Rooms created', 'Games started', 'Games finished', 'New accounts'],
    days.map((d) => [d, s.daily[d].page_view || 0, s.daily[d].room_created || 0, s.daily[d].game_started || 0, s.daily[d].game_finished || 0, s.daily[d].register || 0])))}
${panel('Last 20 finished games', table(['When (UTC)', 'Cards', 'Players', 'Cards each', 'Duration', 'Misses', 'Custom images'],
    s.recent.map((r) => [new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19), r.cards, r.players, r.stack, sec(r.duration_ms), r.misses, r.custom_images])))}
</main></body></html>`;
}

module.exports = { adminAuth, renderAdmin };
