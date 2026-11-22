'use strict';
// A "perfect" card deck (any two cards share exactly one symbol) is a finite projective plane of order q,
// which exists for every prime power q: q*q+q+1 cards, q+1 symbols per card, q*q+q+1 distinct symbols.
// Prime powers up to 16 are supported (273 cards).

const ORDERS = [2, 3, 4, 5, 7, 8, 9, 11, 13, 16];
const DECK_SIZES = ORDERS.map((q) => ({ q, cards: q * q + q + 1, perCard: q + 1 }));

function primePower(q) {
  for (let p = 2; p <= q; p++) {
    if (q % p) continue;
    let k = 0, x = q;
    while (x % p === 0) { x /= p; k++; }
    if (x === 1) return [p, k];
    break;
  }
  throw new Error(`${q} is not a prime power`);
}

// GF(q) as add/mul tables over elements 0..q-1 (base-p digits = polynomial coefficients)
function field(q) {
  const [p, k] = primePower(q);
  const digits = (a) => { const d = []; for (let i = 0; i < k; i++) { d.push(a % p); a = Math.floor(a / p); } return d; };
  const undigits = (d) => d.reduce((s, v, i) => s + v * p ** i, 0);
  const add = (a, b) => { const x = digits(a), y = digits(b); return undigits(x.map((v, i) => (v + y[i]) % p)); };
  if (k === 1) {
    return { add: (a, b) => (a + b) % p, mul: (a, b) => (a * b) % p };
  }
  // find a monic irreducible polynomial of degree k: the quotient ring is a field iff it has no zero divisors
  for (let m = 0; m < q; m++) {
    const mod = digits(m);                     // x^k = -(mod) lower-order terms
    const mulPoly = (a, b) => {
      const x = digits(a), y = digits(b), r = new Array(2 * k - 1).fill(0);
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) r[i + j] = (r[i + j] + x[i] * y[j]) % p;
      for (let d = 2 * k - 2; d >= k; d--) {   // reduce using x^k = -mod
        const c = r[d]; r[d] = 0;
        for (let i = 0; i < k; i++) r[d - k + i] = ((r[d - k + i] - c * mod[i]) % p + p) % p;
      }
      return undigits(r.slice(0, k));
    };
    let ok = true;
    for (let a = 1; a < q && ok; a++) for (let b = 1; b < q; b++) if (mulPoly(a, b) === 0) { ok = false; break; }
    if (ok) {
      const mt = []; for (let a = 0; a < q; a++) { mt.push([]); for (let b = 0; b < q; b++) mt[a].push(mulPoly(a, b)); }
      const at = []; for (let a = 0; a < q; a++) { at.push([]); for (let b = 0; b < q; b++) at[a].push(add(a, b)); }
      return { add: (a, b) => at[a][b], mul: (a, b) => mt[a][b] };
    }
  }
  throw new Error('no irreducible polynomial found');
}

const cache = new Map();
function generateDeck(q = 7) {
  if (cache.has(q)) return cache.get(q);
  const F = field(q);
  const aff = (x, y) => x * q + y;     // q*q affine points
  const slope = (m) => q * q + m;      // q slope points (ideal points of non-vertical lines)
  const inf = q * q + q;               // ideal point of the vertical lines
  const cards = [];
  for (let m = 0; m < q; m++) {
    for (let b = 0; b < q; b++) {      // line y = m*x + b
      const c = [];
      for (let x = 0; x < q; x++) c.push(aff(x, F.add(F.mul(m, x), b)));
      c.push(slope(m));
      cards.push(c);
    }
  }
  for (let x = 0; x < q; x++) {        // vertical line x = c
    const c = [];
    for (let y = 0; y < q; y++) c.push(aff(x, y));
    c.push(inf);
    cards.push(c);
  }
  const line = [inf];                  // the line at infinity
  for (let m = 0; m < q; m++) line.push(slope(m));
  cards.push(line);
  cache.set(q, cards);
  return cards;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { generateDeck, shuffle, ORDERS, DECK_SIZES };
