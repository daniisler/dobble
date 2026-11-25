'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Cutout = require('../public/cutout.js');

// a synthetic picture: even background with a little noise, a red disc with a dark core, and a separate blue square
function picture(w, h, bg, noise = 3) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  for (let i = 0; i < w * h; i++) { data.set([bg[0] + rnd(), bg[1] + rnd(), bg[2] + rnd(), 255], i * 4); }
  const set = (x, y, c) => data.set([c[0] + rnd(), c[1] + rnd(), c[2] + rnd(), 255], (y * w + x) * 4);
  return { width: w, height: h, data, set };
}

test('clicking an object suggests an outline that follows it and ignores the other objects', () => {
  const img = picture(160, 120, [245, 245, 240]);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 160; x++) {
    const d = Math.hypot(x - 90, y - 60);
    if (d < 38) img.set(x, y, d < 12 ? [30, 30, 40] : [210, 40, 40]);             // red disc, dark core
    if (x > 8 && x < 30 && y > 8 && y < 30) img.set(x, y, [40, 60, 200]);          // blue square
  }
  const r = Cutout.suggest(img, 90 + 25, 60, 0.4);
  assert.ok(r, 'a suggestion is made');
  assert.ok(r.polygon.length >= 8 && r.polygon.length <= 60, `outline has ${r.polygon.length} nodes`);
  const disc = Math.PI * 38 * 38, a = Cutout.area(r.polygon);
  assert.ok(Math.abs(a - disc) / disc < 0.08, `outline area ${a.toFixed(0)} is close to the disc ${disc.toFixed(0)}`);
  assert.ok(Cutout.inside(r.polygon, 90, 60), 'the dark core stays inside');
  assert.ok(!Cutout.inside(r.polygon, 20, 20), 'the other object is not included');
  assert.ok(!Cutout.inside(r.polygon, 5, 100), 'the background is outside');
  // clicking the other object selects that one instead
  const s = Cutout.suggest(img, 20, 20, 0.4);
  assert.ok(Cutout.inside(s.polygon, 20, 20) && !Cutout.inside(s.polygon, 90, 60));
});

test('an object that has the colour of a corner of the background is still found, transparent areas count as background', () => {
  const img = picture(100, 100, [255, 255, 255], 2);
  for (let y = 30; y < 80; y++) for (let x = 25; x < 75; x++) img.set(x, y, (x + y) % 2 ? [20, 120, 20] : [250, 250, 245]);   // speckled: white and green
  const r = Cutout.suggest(img, 50, 55, 0.3);
  assert.ok(r && Cutout.inside(r.polygon, 50, 55));
  // transparent pixels are never part of the object
  for (let i = 0; i < 100 * 100; i++) if (i % 100 < 10) img.data[i * 4 + 3] = 0;
  assert.equal(Cutout.suggest(img, 3, 50, 0.3), null);
});

test('masks: specks are cleaned up, outlines come as one ring per region and one per hole', () => {
  const w = 120, h = 100, m = new Uint8Array(w * h);
  const disc = (cx, cy, r, v) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - cx, y - cy) < r) m[y * w + x] = v; };
  disc(30, 50, 22, 1);                 // a region
  disc(30, 50, 8, 0);                  // with a hole in it
  disc(85, 40, 14, 1);                 // another region
  m[5 * w + 5] = 1;                    // a speck
  m[50 * w + 110] = 1; m[50 * w + 111] = 1;
  disc(85, 40, 2, 0);                  // a tiny hole
  const clean = Cutout.cleanMask(m, w, h);
  assert.equal(clean[5 * w + 5], 0, 'speck removed');
  assert.equal(clean[40 * w + 85], 1, 'tiny hole filled');
  assert.equal(clean[50 * w + 30], 0, 'the big hole stays');
  const rings = Cutout.ringsFromMask(clean, w, h);
  assert.equal(rings.length, 3, 'two regions and one hole');
  const areas = rings.map((r) => Cutout.area(r)).sort((a, b) => b - a);
  assert.ok(Math.abs(areas[0] - Math.PI * 22 * 22) / (Math.PI * 22 * 22) < 0.1);
  assert.ok(Math.abs(areas[2] - Math.PI * 8 * 8) / (Math.PI * 8 * 8) < 0.2);
  // a selection touching the picture border still gives one closed ring
  const full = new Uint8Array(w * h).fill(1);
  const r2 = Cutout.ringsFromMask(full, w, h);
  assert.equal(r2.length, 1);
  assert.ok(Math.abs(Cutout.area(r2[0]) - w * h) < 2);
});
