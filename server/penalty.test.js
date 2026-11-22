'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
// the tests must not depend on a developer's local .env: real environment variables win over it
process.env.APP_NAME = 'MatchMe';
delete process.env.TRUST_PROXY;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'matchme-pen-'));
const { generateDeck } = require('./deck');
const { Room } = require('./server');

const deck = generateDeck(3);
const common = (x, y) => x.find((s) => y.includes(s));

// centre card c, player A's card a, player B's card b, where B's matching symbol with c is NOT on a
// (so after A plays over c, B's click on that symbol is "right a moment ago, but too slow", never valid)
function pick() {
  for (const c of deck) for (const a of deck) for (const b of deck) {
    if (c === a || c === b || a === b) continue;
    const sb = common(b, c);
    if (!a.includes(sb)) return { c, a, b, sa: common(a, c), sb };
  }
}

function setup() {
  const { c, a, b, sa, sb } = pick();
  const spare = deck.filter((x) => x !== c && x !== a && x !== b);
  const mkWs = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); } });
  const mkPlayer = (id, stack) => ({ ws: mkWs(), id, name: 'P' + id, ready: false, stack, played: 0, penaltyUntil: 0, misses: 0, lastPlayAt: 0, bestMs: Infinity });
  const room = new Room('TEST');
  const A = mkPlayer(1, [a, spare[0], spare[1]]), B = mkPlayer(2, [b, spare[2], spare[3]]);
  room.players.push(A, B);
  room.state = 'playing'; room.center = c; room.startedAt = 0;
  let t = 1000;
  const realNow = Date.now;
  Date.now = () => t;
  return { room, A, B, a, b, sa, sb, at: (ms) => { t = ms; }, restore: () => { Date.now = realNow; }, last: (p) => p.ws.sent[p.ws.sent.length - 1] };
}

test('right symbol, but somebody else was faster: no penalty, no pause, no miss', () => {
  const s = setup();
  try {
    s.at(1000); s.room.play(s.A, 0, s.sa);
    assert.equal(s.room.center, s.a);
    s.at(1300); s.room.play(s.B, 0, s.sb);                       // B clicks the symbol that WAS on the old centre card
    assert.deepEqual({ t: 'rej', i: 0, why: 'late', by: 1 }, s.last(s.B));
    assert.equal(s.B.misses, 0);
    s.at(1350); s.room.play(s.B, 0, common(s.b, s.a));           // B can play on straight away
    assert.equal(s.last(s.B).t, 'play');
    assert.equal(s.B.misses, 0);
  } finally { s.restore(); }
});

test('wrong symbol: decided by the server, 3 s lockout, counted as a miss', () => {
  const s = setup();
  try {
    const wrong = s.b.find((x) => !s.room.center.includes(x));
    s.at(1000); s.room.play(s.B, 0, wrong);                      // the client never tells the server it missed: the click is enough
    assert.equal(s.last(s.B).why, 'wrong');
    assert.equal(s.B.misses, 1);
    const ok = common(s.b, s.room.center);
    s.at(3000); s.room.play(s.B, 0, ok);                         // 2 s later: still locked
    assert.deepEqual({ t: 'rej', i: 0 }, s.last(s.B));
    s.at(3900); s.room.play(s.B, 0, ok);                         // after 3 s: allowed again
    assert.equal(s.last(s.B).t, 'play');
  } finally { s.restore(); }
});

test('too late is only forgiven within a second of the other player\'s card', () => {
  const s = setup();
  try {
    s.at(1000); s.room.play(s.A, 0, s.sa);
    s.at(2500); s.room.play(s.B, 0, s.sb);                       // 1.5 s later: just a wrong symbol
    assert.equal(s.last(s.B).why, 'wrong');
    assert.equal(s.B.misses, 1);
  } finally { s.restore(); }
});

test('a symbol that is not even on the player\'s own card is a wrong click', () => {
  const s = setup();
  try {
    s.at(1000); s.room.play(s.B, 0, 9999);
    assert.equal(s.last(s.B).why, 'wrong');
    assert.equal(s.B.misses, 1);
  } finally { s.restore(); }
});
