'use strict';
// Background removal that works without any model or download: the user clicks the object, and we
//  1. learn what the BACKGROUND looks like from the picture's border (a few colour clusters in Lab space),
//  2. flood-fill that background inwards from the border, so everything the flood cannot reach is object,
//     including parts whose colour differs from the click (a red truck with black wheels stays whole),
//  3. keep the one connected object that contains the click, smooth it, trace its outline and simplify it
//     to a polygon of a few dozen points that the editor lets the user drag around.
// It runs in the browser (global `Cutout`) and in Node (tests). Works best on fairly even backgrounds; the
// polygon editing is there for everything else.
(function (root) {
  const ANALYSIS_SIDE = 256;   // the analysis runs on a copy of at most this many pixels per side

  function toLab(r, g, b) {
    const f = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
    const R = f(r), G = f(g), B = f(b);
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, y = R * 0.2126 + G * 0.7152 + B * 0.0722, z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const h = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * h(y) - 16, 500 * (h(x) - h(y)), 200 * (h(y) - h(z))];
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // average the picture down to the analysis size
  function shrink(img) {
    const { width: w, height: h, data } = img;
    const k = Math.min(1, ANALYSIS_SIDE / Math.max(w, h));
    const aw = Math.max(1, Math.round(w * k)), ah = Math.max(1, Math.round(h * k));
    const lab = new Float32Array(aw * ah * 3), alpha = new Uint8Array(aw * ah);
    for (let y = 0; y < ah; y++) {
      const y0 = Math.floor(y * h / ah), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / ah));
      for (let x = 0; x < aw; x++) {
        const x0 = Math.floor(x * w / aw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / aw));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]; n++;
        }
        const o = y * aw + x, l = toLab(r / n, g / n, b / n);
        lab[o * 3] = l[0]; lab[o * 3 + 1] = l[1]; lab[o * 3 + 2] = l[2];
        alpha[o] = a / n;
      }
    }
    return { aw, ah, lab, alpha, sx: w / aw, sy: h / ah };
  }
  const px = (A, i) => [A.lab[i * 3], A.lab[i * 3 + 1], A.lab[i * 3 + 2]];

  // a few colour clusters describing the background: [{c: Lab centre, r: spread}]
  function backgroundModel(A, click) {
    const { aw, ah, alpha } = A;
    const t = Math.max(1, Math.round(0.03 * Math.min(aw, ah)));
    const all = [], far = [];
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      if (x >= t && y >= t && x < aw - t && y < ah - t) continue;
      const i = y * aw + x;
      if (alpha[i] < 128) continue;
      const p = px(A, i);
      all.push(p);
      if (dist(p, click) > 18) far.push(p);       // border pixels that look like the clicked object do not describe the background
    }
    let S = far.length >= 12 ? far : all;
    if (!S.length) return [];
    if (S.length > 1500) { const step = S.length / 1500; S = Array.from({ length: 1500 }, (_, i) => S[Math.floor(i * step)]); }
    // k-means, k = 4, started from far-apart samples
    const K = Math.min(4, S.length), cent = [S[0]];
    while (cent.length < K) {
      let best = null, bd = -1;
      for (const p of S) { const d = Math.min(...cent.map((c) => dist(p, c))); if (d > bd) { bd = d; best = p; } }
      cent.push(best);
    }
    let member = new Array(S.length).fill(0);
    for (let it = 0; it < 8; it++) {
      member = S.map((p) => { let bi = 0, bd = Infinity; cent.forEach((c, i) => { const d = dist(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; });
      for (let k = 0; k < K; k++) {
        const m = S.filter((_, i) => member[i] === k);
        if (m.length) cent[k] = [0, 1, 2].map((j) => m.reduce((s, p) => s + p[j], 0) / m.length);
      }
    }
    return cent.map((c, k) => {
      const m = S.filter((_, i) => member[i] === k);
      return { c, n: m.length, r: m.length ? Math.sqrt(m.reduce((s, p) => s + dist(p, c) ** 2, 0) / m.length) : 0 };
    }).filter((m) => m.n > 0);
  }

  // tolerance 0..1 (the editor's slider)
  function suggest(img, clickX, clickY, tolerance = 0.4) {
    const A = shrink(img), { aw, ah, alpha } = A, N = aw * ah;
    const cx = Math.min(aw - 1, Math.max(0, Math.floor(clickX / A.sx))), cy = Math.min(ah - 1, Math.max(0, Math.floor(clickY / A.sy)));
    // the clicked colour: median of the 5x5 neighbourhood
    const near = [];
    for (let y = Math.max(0, cy - 2); y <= Math.min(ah - 1, cy + 2); y++) for (let x = Math.max(0, cx - 2); x <= Math.min(aw - 1, cx + 2); x++) near.push(px(A, y * aw + x));
    const click = [0, 1, 2].map((j) => near.map((p) => p[j]).sort((a, b) => a - b)[near.length >> 1]);
    if (alpha[cy * aw + cx] < 128) return null;                              // clicked something already transparent

    const model = backgroundModel(A, click);
    const T = 6 + 30 * tolerance;
    const bgLike = (i, m) => {
      if (alpha[i] < 128) return true;
      const p = px(A, i);
      for (const b of model) if (dist(p, b.c) < (T + 1.5 * b.r) * m) return true;
      return false;
    };
    // if the click itself looks like background, get stricter until it does not
    let m = 1;
    const ci = cy * aw + cx;
    while (m > 0.12 && bgLike(ci, m)) m *= 0.85;

    // flood the background in from the border
    const bg = new Uint8Array(N), stack = [];
    const push = (x, y) => { const i = y * aw + x; if (!bg[i] && bgLike(i, m)) { bg[i] = 1; stack.push(i); } };
    for (let x = 0; x < aw; x++) { push(x, 0); push(x, ah - 1); }
    for (let y = 0; y < ah; y++) { push(0, y); push(aw - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % aw, y = (i / aw) | 0;
      if (x > 0) push(x - 1, y); if (x < aw - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1); if (y < ah - 1) push(x, y + 1);
    }
    let mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = bg[i] ? 0 : 1;

    // smooth the edge (two box blurs, then threshold), keep the clicked object only
    mask = smooth(mask, aw, ah);
    mask = component(mask, aw, ah, cx, cy);
    if (!mask) return null;
    let area = 0; for (let i = 0; i < N; i++) area += mask[i];
    if (area < N * 0.002) return null;

    const ring = trace(mask, aw, ah);
    if (!ring) return null;
    let eps = 1.3, poly = simplify(ring, eps);
    while (poly.length > 48 && eps < 8) { eps *= 1.3; poly = simplify(ring, eps); }
    return { polygon: poly.map(([x, y]) => [x * A.sx, y * A.sy]), coverage: area / N };
  }

  function smooth(mask, w, h) {
    let cur = Float32Array.from(mask);
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(cur.length);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) { s += cur[yy * w + xx]; n++; }
        out[y * w + x] = s / n;
      }
      cur = out;
    }
    return Uint8Array.from(cur, (v) => (v >= 0.5 ? 1 : 0));
  }

  // only the 4-connected region of `mask` that contains (x, y) (or the nearest object pixel when it was smoothed away)
  function component(mask, w, h, x, y) {
    let start = y * w + x;
    if (!mask[start]) {
      let bd = Infinity; start = -1;
      for (let i = 0; i < mask.length; i++) if (mask[i]) { const d = (i % w - x) ** 2 + (((i / w) | 0) - y) ** 2; if (d < bd) { bd = d; start = i; } }
      if (start < 0) return null;
    }
    const out = new Uint8Array(mask.length), stack = [start];
    out[start] = 1;
    while (stack.length) {
      const i = stack.pop(), px_ = i % w, py = (i / w) | 0;
      const nb = [];
      if (px_ > 0) nb.push(i - 1); if (px_ < w - 1) nb.push(i + 1); if (py > 0) nb.push(i - w); if (py < h - 1) nb.push(i + w);
      for (const j of nb) if (mask[j] && !out[j]) { out[j] = 1; stack.push(j); }
    }
    return out;
  }

  // walk along the outside edge of the pixels (corner to corner, object on the right-hand side): a closed list of corners
  function trace(mask, w, h) {
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
    let sx = -1, sy = -1;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { sx = i % w; sy = (i / w) | 0; break; }
    if (sx < 0) return null;
    const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    let x = sx, y = sy, d = 0;
    const pts = [[x, y]];
    for (let guard = 0; guard < 4 * w * h + 8; guard++) {
      x += DX[d]; y += DY[d];
      let AL, AR;
      if (d === 0) { AL = on(x, y - 1); AR = on(x, y); }
      else if (d === 1) { AL = on(x, y); AR = on(x - 1, y); }
      else if (d === 2) { AL = on(x - 1, y); AR = on(x - 1, y - 1); }
      else { AL = on(x - 1, y - 1); AR = on(x, y - 1); }
      const nd = AR ? (AL ? (d + 3) % 4 : d) : (d + 1) % 4;
      if (x === sx && y === sy && nd === 0) return pts;
      if (nd !== d) pts.push([x, y]);
      d = nd;
    }
    return null;
  }

  // Ramer-Douglas-Peucker on a closed ring
  function simplify(ring, eps) {
    if (ring.length < 4) return ring;
    let far = 0, fd = -1;
    for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
    const part = (pts) => {
      if (pts.length < 3) return pts.slice(0, -1);
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      let mi = 0, md = -1;
      for (let i = 1; i < pts.length - 1; i++) {
        const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / len;
        if (d > md) { md = d; mi = i; }
      }
      if (md <= eps) return [a];
      return part(pts.slice(0, mi + 1)).concat(part(pts.slice(mi)));
    };
    const first = ring.slice(0, far + 1), second = ring.slice(far).concat([ring[0]]);
    const out = part(first).concat(part(second));
    return out.length >= 3 ? out : ring;
  }

  function inside(poly, x, y) {                      // point in polygon
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function area(poly) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    return Math.abs(s) / 2;
  }


  // ---- masks and outlines (used by the editor for selections made by the model, by clicks, or by hand)

  // connected regions (4-neighbourhood) of the pixels equal to `value`: {labels, sizes, border} (border[i]: touches the picture edge)
  function components(mask, w, h, value) {
    const labels = new Int32Array(mask.length).fill(-1), sizes = [], border = [];
    const stack = new Int32Array(mask.length);
    for (let s = 0; s < mask.length; s++) {
      if (labels[s] !== -1 || mask[s] !== value) continue;
      const id = sizes.length; let size = 0, touches = false, sp = 0;
      stack[sp++] = s; labels[s] = id;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0;
        size++;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
        if (x > 0 && labels[i - 1] === -1 && mask[i - 1] === value) { labels[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && labels[i + 1] === -1 && mask[i + 1] === value) { labels[i + 1] = id; stack[sp++] = i + 1; }
        if (y > 0 && labels[i - w] === -1 && mask[i - w] === value) { labels[i - w] = id; stack[sp++] = i - w; }
        if (y < h - 1 && labels[i + w] === -1 && mask[i + w] === value) { labels[i + w] = id; stack[sp++] = i + w; }
      }
      sizes.push(size); border.push(touches);
    }
    return { labels, sizes, border };
  }

  // remove specks: tiny selected islands disappear, tiny holes inside the selection are filled
  function cleanMask(mask, w, h, minFrac = 0.0012) {
    const minArea = Math.max(6, Math.round(minFrac * w * h)), out = Uint8Array.from(mask);
    const fg = components(mask, w, h, 1);
    for (let i = 0; i < out.length; i++) if (mask[i] === 1 && fg.sizes[fg.labels[i]] < minArea) out[i] = 0;
    const bg = components(out, w, h, 0);
    for (let i = 0; i < out.length; i++) if (out[i] === 0 && !bg.border[bg.labels[i]] && bg.sizes[bg.labels[i]] < minArea) out[i] = 1;
    return out;
  }

  // The outlines of a selection: one closed ring of corner points per selected region, plus one per hole in it.
  // Drawn together with the even-odd rule they give back the selection. `epsFrac`: simplification, as a fraction of the picture size.
  function ringsFromMask(mask, w, h, epsFrac = 0.0025, maxNodes = 140) {
    const rings = [];
    const addAll = (value) => {
      const c = components(mask, w, h, value);
      for (let id = 0; id < c.sizes.length; id++) {
        if (value === 0 && c.border[id]) continue;                       // background around the selection is not a hole
        const one = new Uint8Array(mask.length);
        for (let i = 0; i < one.length; i++) if (c.labels[i] === id) one[i] = 1;
        const ring = trace(one, w, h);
        if (!ring) continue;
        let eps = Math.max(0.8, epsFrac * Math.max(w, h)), poly = simplify(ring, eps);
        while (poly.length > maxNodes && eps < 60) { eps *= 1.25; poly = simplify(ring, eps); }
        if (poly.length >= 3) rings.push(poly);
      }
    };
    addAll(1); addAll(0);
    return rings;
  }

  const api = { suggest, inside, area, components, cleanMask, ringsFromMask, simplify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Cutout = api;
})(typeof self !== 'undefined' ? self : this);
