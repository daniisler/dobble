'use strict';
// The picture editor that opens after choosing a file to upload. Tools:
//   Remove background  click objects (or background parts) to select them with a segmentation model (segment.js), extend or
//                      shrink the selection with more clicks, fix the outline by dragging its nodes, then keep or remove it
//   Crop               the picture is shown in the round frame it gets in the game: move and zoom it inside the circle
//   Draw / Erase, Rotate, Undo, Start over
//   Add picture        a second picture can be prepared (same tools) and then placed on the first one
// ImageEditor.open(file, {index, total}) resolves to
//   {action:'upload', file}  a round-cropped PNG with transparency
//   {action:'skip'} | {action:'rest', file} (this one and all remaining files unchanged) | {action:'cancel'}
const ImageEditor = (() => {
  const $ = (id) => document.getElementById(id);
  const EDIT_SIDE = 800;        // pictures are edited at (at most) this size
  const OUT = 512;              // the result is a OUT x OUT picture with a round crop; the server shrinks it further
  const HISTORY = 10;

  let busy = false;
  function open(file, info = {}) {
    if (busy) return Promise.resolve({ action: 'upload', file });
    busy = true;
    return new Promise(async (resolve) => {
      const root = $('imged'), stage = $('imged-stage'), cv = $('imged-cv'), pv = $('imged-pv'), ov = $('imged-ov');
      const ctx = cv.getContext('2d', { willReadFrequently: true }), pctx = pv.getContext('2d'), octx = ov.getContext('2d');
      let bmp;
      try { bmp = await createImageBitmap(file); } catch { busy = false; return resolve({ action: 'upload', file }); }   // unreadable: let the upload report it

      // ---------------------------------------------------------------- state
      let tool = 'crop', version = 0, edited = false, below = null, place = null, crop = null, autoCache = null;
      let selMask = null, rings = [], selNodes = new Set(), addMode = 'add', multi = false, last = null;
      let modelState = 'idle', modelMissing = false, modelPromise = null, embeddedVersion = -1, embTimer = 0, clickQueue = Promise.resolve();
      let view = { w: 0, h: 0, f: 1 };                 // the shown canvas: css size and css pixels per canvas pixel
      const hist = [];
      const selHist = [];                                // earlier selections (for undoing click, drag and delete steps of the background removal)
      const ptrs = new Map();
      let drag = null, box = null, stroke = null, pinch = null, pan = null, vpan = null, tap = null, spaceDown = false;
      let zv = { z: 1, x: 0, y: 0 }, zoomKey = '';        // zoom of the picture in the selection / draw / erase tools: screen = picture * view.f * z + (x, y)

      // ---------------------------------------------------------------- loading pictures into the canvas
      function setCanvasFrom(source, sw, sh) {
        const k = Math.min(1, EDIT_SIDE / Math.max(sw, sh));
        cv.width = Math.max(1, Math.round(sw * k)); cv.height = Math.max(1, Math.round(sh * k));
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(source, 0, 0, cv.width, cv.height);
      }
      function resetSelection() { selMask = null; rings = []; selNodes.clear(); last = null; selHist.length = 0; }
      const snapSel = () => ({ mask: selMask, rings: rings.map((r) => r.map((q) => [...q])) });
      function pushSel(snap = snapSel()) { selHist.push(snap); if (selHist.length > 30) selHist.shift(); }
      function undoSel() {
        const sn = selHist.pop(); if (!sn) return;
        selMask = sn.mask; rings = sn.rings; selNodes.clear(); last = null; err(''); updateUI(); redraw();
      }
      function touched() {                               // the pixels changed
        version++; autoCache = null; resetSelection();
        if (tool === 'cut') { clearTimeout(embTimer); embTimer = setTimeout(ensureEmbedding, 300); }
      }
      setCanvasFrom(bmp, bmp.width, bmp.height); bmp.close();

      $('imged-title').textContent = file.name || 'Edit image';
      $('imged-count').textContent = info.total > 1 ? `Image ${info.index} of ${info.total}` : '';
      $('imged-skip').hidden = !(info.total > 1);
      $('imged-rest').hidden = !(info.total > 1 && info.index < info.total);
      $('imged-err').textContent = '';
      root.hidden = false;
      const prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';

      // ---------------------------------------------------------------- helpers
      const err = (t) => { $('imged-err').textContent = t || ''; };
      const W = () => cv.width, H = () => cv.height;
      function tmpCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
      function snapshot() { hist.push(ctx.getImageData(0, 0, cv.width, cv.height)); if (hist.length > HISTORY) hist.shift(); updateUI(); }
      function undo() {
        if (tool === 'cut' && selHist.length) return undoSel();            // in the selection tool, Undo first takes back selection steps
        const s = hist.pop(); if (!s) return;
        cv.width = s.width; cv.height = s.height; ctx.putImageData(s, 0, 0);
        crop = null; touched(); layout(); updateUI();
      }
      function alphaBounds() {
        const w = W(), h = H(), d = ctx.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
      }

      // ---------------------------------------------------------------- layout: the shown canvas fills the window as well as it can
      function layout() {
        const maxW = Math.max(120, Math.min(stage.parentElement.clientWidth - 26, 700));
        const maxH = Math.max(170, window.innerHeight - (window.innerWidth < 600 ? 400 : 340));
        let w, h, shown;
        if (tool === 'crop') { w = h = Math.floor(Math.min(maxW, maxH, 460)); shown = pv; }
        else if (tool === 'place' && below) { const s = Math.min(maxW / below.canvas.width, maxH / below.canvas.height); w = Math.floor(below.canvas.width * s); h = Math.floor(below.canvas.height * s); shown = pv; }
        else { const s = Math.min(maxW / cv.width, maxH / cv.height); w = Math.max(60, Math.floor(cv.width * s)); h = Math.max(60, Math.floor(cv.height * s)); shown = cv; }
        const dpr = window.devicePixelRatio || 1;
        cv.style.display = shown === cv ? 'block' : 'none';
        pv.style.display = shown === pv ? 'block' : 'none';
        for (const c of [cv, pv, ov]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
        for (const c of [pv, ov]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
        pctx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        view = { w, h, f: shown === cv ? w / cv.width : tool === 'place' ? w / below.canvas.width : w / OUT };
        const key = cv.width + 'x' + cv.height;
        if (key !== zoomKey) { zv = { z: 1, x: 0, y: 0 }; zoomKey = key; }
        setZoom(zv.z, zv.x, zv.y, false);
        redraw();
      }
      // zoom in the selection / draw / erase tools: the picture is scaled with CSS, the overlay is drawn in the zoomed coordinates
      function setZoom(z, x, y, doRedraw = true) {
        z = Math.max(1, Math.min(12, z));
        zv = { z, x: Math.min(0, Math.max(view.w * (1 - z), x)), y: Math.min(0, Math.max(view.h * (1 - z), y)) };
        if (z === 1) zv.x = zv.y = 0;
        cv.style.transformOrigin = '0 0';
        cv.style.transform = z === 1 ? '' : `translate(${zv.x}px, ${zv.y}px) scale(${z})`;
        $('view-reset').hidden = z === 1 || !(tool === 'cut' || tool === 'draw' || tool === 'erase');
        if (doRedraw) redraw();
      }
      const zoomAt = (vx, vy, factor) => { const z = Math.max(1, Math.min(12, zv.z * factor)), r = z / zv.z; setZoom(z, vx - (vx - zv.x) * r, vy - (vy - zv.y) * r); };
      $('view-reset').onclick = () => setZoom(1, 0, 0);
      const toView = (e) => { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      const toImg = (e) => { const [x, y] = toView(e); return [(x - zv.x) / (view.f * zv.z), (y - zv.y) / (view.f * zv.z)]; };

      // ---------------------------------------------------------------- crop: the round frame
      function autoCrop() {
        if (autoCache && autoCache.v === version) return autoCache.c;
        const w = W(), h = H(), d = ctx.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1, transparent = false;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const a = d[(y * w + x) * 4 + 3];
          if (a < 250) transparent = true;
          if (a > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        }
        let c;
        if (x1 < 0) c = { k: 1, ox: 0, oy: 0 };
        else if (!transparent) c = { k: OUT / Math.min(w, h), ox: 0, oy: 0 };           // a plain picture fills the circle
        else {                                                                          // a cut-out: the circle that just contains it
          const bx = (x0 + x1 + 1) / 2, by = (y0 + y1 + 1) / 2;
          let r2 = 0;
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[(y * w + x) * 4 + 3] > 16) r2 = Math.max(r2, (x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2);
          const k = (OUT / 2 * 0.95) / (Math.sqrt(r2) || 1);
          c = { k, ox: -(bx - w / 2) * k, oy: -(by - h / 2) * k };
        }
        autoCache = { v: version, c };
        return c;
      }
      const cropState = () => crop || autoCrop();
      function drawCropFrame(c2d, S, c, f) {                                            // picture + dimmed outside + circle, into an S x S view
        const w = W() * c.k * f, h = H() * c.k * f, x = S / 2 + c.ox * f - w / 2, y = S / 2 + c.oy * f - h / 2;
        c2d.clearRect(0, 0, S, S);
        c2d.drawImage(cv, x, y, w, h);
      }
      function drawCrop() {
        const S = view.w, f = S / OUT, c = cropState();
        drawCropFrame(pctx, S, c, f);
        pctx.save(); pctx.beginPath(); pctx.rect(0, 0, S, S); pctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
        pctx.fillStyle = 'rgba(0,0,0,.55)'; pctx.fill('evenodd'); pctx.restore();
        pctx.beginPath(); pctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2); pctx.strokeStyle = '#fff'; pctx.lineWidth = 2; pctx.stroke();
        $('crop-zoom').value = Math.round(100 * c.k / autoCrop().k);
      }
      function zoomCropAt(vx, vy, factor) {                                              // keep the picture point under (vx, vy) fixed
        const f = view.w / OUT, c = { ...cropState() }, ux = vx / f, uy = vy / f;
        const px = (ux - OUT / 2 - c.ox) / c.k + W() / 2, py = (uy - OUT / 2 - c.oy) / c.k + H() / 2;
        const k0 = autoCrop().k, k = Math.max(k0 * 0.2, Math.min(k0 * 4, c.k * factor));
        crop = { k, ox: ux - OUT / 2 - (px - W() / 2) * k, oy: uy - OUT / 2 - (py - H() / 2) * k };
        drawCrop();
      }
      $('crop-zoom').oninput = (e) => { zoomCropAt(view.w / 2, view.h / 2, (autoCrop().k * e.target.value / 100) / cropState().k); };
      $('crop-fit').onclick = () => { crop = null; drawCrop(); };

      // ---------------------------------------------------------------- combining two pictures
      function drawPlace() {
        const base = below.canvas, f = view.f;
        pctx.clearRect(0, 0, view.w, view.h);
        pctx.drawImage(base, 0, 0, view.w, view.h);
        pctx.save();
        pctx.translate(place.x * f, place.y * f); pctx.rotate(place.rot); pctx.scale(place.s * f, place.s * f);
        pctx.drawImage(place.layer, -place.layer.width / 2, -place.layer.height / 2);
        pctx.restore();
        pctx.save();                                                                       // a dashed frame shows what can be dragged
        pctx.translate(place.x * f, place.y * f); pctx.rotate(place.rot);
        pctx.setLineDash([6, 4]); pctx.strokeStyle = '#000'; pctx.lineWidth = 3;
        const hw = place.layer.width * place.s * f / 2, hh = place.layer.height * place.s * f / 2;
        pctx.strokeRect(-hw, -hh, hw * 2, hh * 2); pctx.strokeStyle = '#fff'; pctx.lineWidth = 1.5; pctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
        pctx.restore();
        $('place-size').value = Math.round(100 * place.s / place.s0);
        $('place-rot').value = Math.round(place.rot * 180 / Math.PI);
      }
      function startPlace() {
        const b = alphaBounds();
        if (!b) return err('Nothing is left of the second picture.');
        const layer = tmpCanvas(b.w, b.h); layer.getContext('2d').drawImage(cv, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
        const base = below.canvas, s0 = 0.5 * Math.min(base.width, base.height) / Math.max(b.w, b.h);
        place = { layer, s0, s: s0, rot: 0, x: base.width / 2, y: base.height / 2 };
        err(''); setTool('place');
      }
      function finishPlace() {
        const base = below.canvas, out = tmpCanvas(base.width, base.height), c = out.getContext('2d');
        c.drawImage(base, 0, 0);
        c.save(); c.translate(place.x, place.y); c.rotate(place.rot); c.scale(place.s, place.s);
        c.drawImage(place.layer, -place.layer.width / 2, -place.layer.height / 2); c.restore();
        cv.width = out.width; cv.height = out.height; ctx.drawImage(out, 0, 0);
        below = null; place = null; hist.length = 0; edited = true; crop = null; touched();
        setTool('crop');
      }
      $('imged-add').onclick = () => $('imged-file2').click();
      $('imged-file2').onchange = async (e) => {
        const f = e.target.files[0]; e.target.value = '';
        if (!f || below) return;
        let b2; try { b2 = await createImageBitmap(f); } catch { return err('The second picture could not be read.'); }
        const copy = tmpCanvas(cv.width, cv.height); copy.getContext('2d').drawImage(cv, 0, 0);
        below = { canvas: copy };
        setCanvasFrom(b2, b2.width, b2.height); b2.close();
        hist.length = 0; edited = true; crop = null; touched(); err('');
        setTool('cut');
      };
      $('pic2-place').onclick = startPlace;
      $('pic2-discard').onclick = () => {
        if (!below) return;
        cv.width = below.canvas.width; cv.height = below.canvas.height; ctx.drawImage(below.canvas, 0, 0);
        below = null; place = null; hist.length = 0; crop = null; touched(); setTool('crop');
      };
      $('place-done').onclick = finishPlace;
      $('place-back').onclick = () => { place = null; setTool('cut'); };
      $('place-size').oninput = (e) => { if (place) { place.s = place.s0 * e.target.value / 100; drawPlace(); } };
      $('place-rot').oninput = (e) => { if (place) { place.rot = e.target.value * Math.PI / 180; drawPlace(); } };

      // ---------------------------------------------------------------- background removal: selection of regions
      const setStatus = (t) => { $('cut-status').textContent = t; };
      function initModel() {
        if (modelState !== 'idle') return modelPromise;
        modelState = 'loading';
        const g = jobGen;
        if (tool === 'cut') setBusy('Loading the background-removal model…', 'First time only: about 28 MB are downloaded, later it starts at once.');
        modelPromise = Segmenter.load((t) => { if (tool === 'cut' && g === jobGen) setBusy(t, 'First time only: about 28 MB are downloaded, later it starts at once.'); }).then((ok) => {
          modelState = ok ? 'ready' : 'fallback'; modelMissing = !ok;
          $('cut-tol-label').hidden = ok;
          if (g === jobGen) setBusy(null);
          readyStatus(); if (ok) ensureEmbedding();
          return ok;
        });
        return modelPromise;
      }
      // a clear "working" state: spinner over the picture with the elapsed time, and a Cancel button below it
      let jobGen = 0, busyTimer = 0, busyStart = 0, busyBase = '';
      function renderBusy() { const s = Math.round((Date.now() - busyStart) / 1000); $('busy-text').textContent = busyBase + (s >= 2 ? `  ${s} s` : ''); }
      function setBusy(text, note = '') {
        const on = text != null;
        $('imged-busy').hidden = $('busy-cancel').hidden = $('busy-simple').hidden = !on;
        if (!on) { clearInterval(busyTimer); busyStart = 0; return; }
        busyBase = text; $('busy-note').textContent = note;
        if (!busyStart) { busyStart = Date.now(); busyTimer = setInterval(renderBusy, 500); }
        renderBusy();
      }
      function analysingNote() {
        const i = Segmenter.info();
        return 'The model looks at the whole picture once. A fast computer needs about 4 seconds, a phone often 30 seconds up to several minutes. Afterwards every click takes about half a second.'
          + (i.threads < 2 ? ` It is running on ONE thread${i.isolated ? '' : ' because this page is not cross-origin isolated (it needs HTTPS and the server\'s Cross-Origin headers)'}, which is the slow way.` : ` (${i.threads} threads)`);
      }
      // the instant colour-based method instead of the model, for slow devices
      $('busy-simple').onclick = () => { jobGen++; clickQueue = Promise.resolve(); setBusy(null); modelState = 'fallback'; $('cut-tol-label').hidden = false; readyStatus(); };
      $('busy-cancel').onclick = () => { jobGen++; clickQueue = Promise.resolve(); setBusy(null); setStatus(''); setTool('crop'); };
      function readyStatus() {
        setStatus(modelState === 'ready' ? 'Ready. Click the object to keep, or a part of the background to remove.'
          : modelState === 'fallback' ? (modelMissing ? 'Simple mode: the background-removal model is not installed on this server (npm run fetch-model). ' : 'Simple mode (colour based, works best on plain backgrounds). ') + 'Click an object; use the sensitivity slider.' : '');
      }
      async function ensureEmbedding() {
        if (tool !== 'cut' || modelState !== 'ready' || embeddedVersion === version) return;
        const v = version, g = jobGen;
        setBusy('Analysing the picture…', analysingNote());
        try { await Segmenter.prepare(cv, v); } catch { if (g === jobGen) setBusy(null); return; }
        if (g === jobGen && v === version) setBusy(null);
        if (v === version) { embeddedVersion = v; if (tool === 'cut') readyStatus(); }
      }
      function rasterize(ringList) {
        const t = tmpCanvas(W(), H()), c = t.getContext('2d', { willReadFrequently: true });
        c.beginPath();
        for (const r of ringList) { r.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); }
        c.fill('evenodd');
        const d = c.getImageData(0, 0, t.width, t.height).data, m = new Uint8Array(t.width * t.height);
        for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 127 ? 1 : 0;
        return m;
      }
      function setSelection(mask, replace = false) {
        if (!replace) pushSel();                                        // (replace: cycling the same spot is still one undo step)
        if (!mask || !mask.some((v) => v)) { selMask = null; rings = []; }
        else { selMask = Cutout.cleanMask(mask, W(), H()); rings = Cutout.ringsFromMask(selMask, W(), H()); }
        selNodes.clear(); updateUI(); redraw();
      }
      function selectAt(x, y, op) {
        clickQueue = clickQueue.then(() => doSelect(x, y, op)).catch((e) => { console.warn(e); err('Selecting failed: ' + (e && e.message || e)); });
      }
      async function doSelect(x, y, op) {
        const g = jobGen;
        if (modelState === 'idle' || modelState === 'loading') { await initModel(); if (g !== jobGen) return; }
        const v = version;
        let cands;
        if (modelState === 'ready') {
          setStatus('Selecting…');
          if (embeddedVersion !== v) {
            setBusy('Analysing the picture…', analysingNote());
            try { await Segmenter.prepare(cv, v); } finally { if (g === jobGen) setBusy(null); }
            if (g !== jobGen) return;
            embeddedVersion = v;
          }
          const r = await Segmenter.segment(Math.round(x), Math.round(y), v);
          if (g !== jobGen) return;
          cands = r.masks.map((m, i) => ({ mask: m, iou: r.iou[i] }));
        } else {
          const r = Cutout.suggest(ctx.getImageData(0, 0, W(), H()), x, y, +$('cut-tol').value / 100);
          if (!r) { readyStatus(); return err('Nothing found there. Try another spot or change the sensitivity.'); }
          cands = [{ mask: rasterize([r.polygon]) }];
        }
        if (v !== version) return;
        err('');
        const same = last && last.version === v && last.op === op && Math.hypot(last.x - x, last.y - y) < 8 / (view.f * zv.z) && last.cands.length > 1;
        let idx = 0, before;
        if (same) { idx = (last.idx + 1) % last.cands.length; before = last.before; cands = last.cands; }
        else before = selMask ? Uint8Array.from(selMask) : new Uint8Array(W() * H());
        const m = cands[idx].mask, next = new Uint8Array(before.length);
        if (op === 'add') for (let i = 0; i < next.length; i++) next[i] = before[i] | m[i];
        else for (let i = 0; i < next.length; i++) next[i] = before[i] & (m[i] ^ 1);
        setSelection(next, same);
        last = { x, y, op, cands, idx, before, version: v };
        setStatus(modelState === 'ready' ? (cands.length > 1 ? 'Click the same spot again to try another shape. ' : '') + 'Click more areas to extend the selection.' : 'Click more areas to extend the selection.');
      }
      function applySelection(keep) {
        if (!rings.length) return err('Select something first: click on the picture.');
        snapshot();
        const t = tmpCanvas(W(), H()), c = t.getContext('2d');
        c.beginPath();
        if (!keep) c.rect(0, 0, W(), H());
        for (const r of rings) { r.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); }
        c.clip('evenodd'); c.drawImage(cv, 0, 0);
        ctx.clearRect(0, 0, W(), H()); ctx.drawImage(t, 0, 0);
        const analysed = embeddedVersion === version;
        edited = true; err(''); touched(); redraw(); updateUI();
        if (analysed && modelState === 'ready') { Segmenter.keep(version); embeddedVersion = version; }   // no new analysis: the geometry is unchanged
      }
      $('cut-add').onclick = () => { addMode = 'add'; updateUI(); };
      $('cut-sub').onclick = () => { addMode = 'sub'; updateUI(); };
      $('cut-multi').onclick = () => { multi = !multi; updateUI(); };
      $('cut-keep').onclick = () => applySelection(true);
      $('cut-remove').onclick = () => applySelection(false);
      $('cut-invert').onclick = () => { const m = new Uint8Array(W() * H()); for (let i = 0; i < m.length; i++) m[i] = (selMask ? selMask[i] : 0) ^ 1; last = null; setSelection(m); };
      $('cut-clear').onclick = () => { last = null; setSelection(null); };
      $('cut-tol').onchange = () => { if (last && modelState === 'fallback') { const { x, y, op, before } = last; selMask = before; selectAt(x, y, op); } };
      function deleteSelectedNodes() {
        if (!selNodes.size) return;
        pushSel();
        rings = rings.map((r, ri) => {
          const del = new Set([...selNodes].filter((k) => +k.split(':')[0] === ri).map((k) => +k.split(':')[1]));
          return r.length - del.size >= 3 ? r.filter((_, i) => !del.has(i)) : r;          // a ring keeps at least three nodes
        });
        selNodes.clear(); selMask = rasterize(rings); last = null; updateUI(); redraw();
      }
      $('cut-delnode').onclick = deleteSelectedNodes;
      $('cut-undo').onclick = undoSel;

      // ---------------------------------------------------------------- overlay (selection, outline, nodes)
      function hitRadius(e) { return e && e.pointerType === 'touch' ? 20 : 12; }
      function drawOverlay() {
        octx.clearRect(0, 0, view.w, view.h);
        if (tool !== 'cut') return;
        const k = view.f * zv.z, X = (x) => x * k + zv.x, Y = (y) => y * k + zv.y;
        if (rings.length) {
          octx.beginPath();
          for (const r of rings) { r.forEach(([x, y], i) => (i ? octx.lineTo(X(x), Y(y)) : octx.moveTo(X(x), Y(y)))); octx.closePath(); }
          octx.fillStyle = 'rgba(46,204,113,.34)'; octx.fill('evenodd');
          octx.lineJoin = 'round'; octx.strokeStyle = '#000'; octx.lineWidth = 4; octx.stroke();
          octx.strokeStyle = '#fff'; octx.lineWidth = 2; octx.stroke();
          const total = rings.reduce((n, r) => n + r.length, 0), rad = total > 250 ? 3.5 : 5;
          rings.forEach((r, ri) => r.forEach(([x, y], i) => {
            const on = selNodes.has(ri + ':' + i);
            octx.beginPath(); octx.arc(X(x), Y(y), on ? rad + 2 : rad, 0, 7);
            octx.fillStyle = on ? '#ff4d4d' : '#fff'; octx.fill(); octx.strokeStyle = '#000'; octx.lineWidth = 1.5; octx.stroke();
          }));
        }
        if (box) {
          octx.setLineDash([5, 4]); octx.strokeStyle = '#000'; octx.lineWidth = 3; octx.strokeRect(X(box.x0), Y(box.y0), (box.x1 - box.x0) * k, (box.y1 - box.y0) * k);
          octx.strokeStyle = '#fff'; octx.lineWidth = 1.5; octx.strokeRect(X(box.x0), Y(box.y0), (box.x1 - box.x0) * k, (box.y1 - box.y0) * k); octx.setLineDash([]);
        }
      }
      function redraw() {
        if (tool === 'crop') drawCrop(); else if (tool === 'place' && place) drawPlace();
        drawOverlay();
      }
      function nodeAt(p, e) {
        const R = hitRadius(e) / (view.f * zv.z); let best = null;
        rings.forEach((r, ri) => r.forEach((n, i) => { const d = Math.hypot(n[0] - p[0], n[1] - p[1]); if (d <= R && (!best || d < best.d)) best = { d, key: ri + ':' + i, ri, i }; }));
        return best;
      }
      function edgeAt(p, e) {
        const R = hitRadius(e) / (view.f * zv.z); let best = null;
        rings.forEach((r, ri) => r.forEach((a, i) => {
          const b = r[(i + 1) % r.length], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
          const at = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(p[0] - at[0], p[1] - at[1]);
          if (d <= R && (!best || d < best.d)) best = { d, ri, i, at };
        }));
        return best;
      }

      // ---------------------------------------------------------------- drawing and erasing
      function brush(e) {
        const p = toImg(e), size = +$(tool === 'draw' ? 'draw-size' : 'erase-size').value;
        ctx.save(); ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = size;
        if (tool === 'erase') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; } else ctx.strokeStyle = $('draw-color').value;
        ctx.beginPath(); ctx.moveTo(stroke[0], stroke[1]); ctx.lineTo(p[0] + 0.01, p[1]); ctx.stroke(); ctx.restore();
        stroke = p;
      }

      // ---------------------------------------------------------------- pointer handling (mouse, pen and touch)
      const mid = () => { const a = [...ptrs.values()]; return [(a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2]; };
      const span = () => { const a = [...ptrs.values()]; return [Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x)]; };
      function relPt(e) { const r = ov.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

      ov.onpointerdown = (e) => {
        ov.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, relPt(e));
        if (ptrs.size === 2) {                                                          // two fingers: pinch (zoom and move)
          const [d, ang] = span(), m = mid();
          pinch = { d, ang, m, crop: { ...cropState() }, place: place && { ...place }, zv: { ...zv } };
          if (drag) { for (const [k, o] of drag.orig) { const [r, i] = k.split(':'); if (rings[r]) rings[r][i] = o; } drag = null; }
          stroke = null; box = null; tap = null; pan = null; vpan = null; redraw();
          return;
        }
        if (ptrs.size > 1) return;
        if ((tool === 'cut' || tool === 'draw' || tool === 'erase') && (e.button === 1 || spaceDown)) { e.preventDefault(); vpan = relPt(e); return; }   // move the zoomed picture
        const p = toImg(e);
        if (tool === 'draw' || tool === 'erase') { snapshot(); edited = true; stroke = p; brush(e); return; }
        if (tool === 'crop' || tool === 'place') { pan = relPt(e); return; }
        if (tool !== 'cut') return;
        const mods = e.shiftKey || e.ctrlKey || e.metaKey || multi;
        const hit = nodeAt(p, e);
        if (hit) {
          const was = selNodes.has(hit.key);                                              // with Ctrl/Shift/multi: a tap toggles, a drag moves all selected
          if (!mods && !was) selNodes.clear();
          selNodes.add(hit.key);
          drag = { start: p, orig: new Map([...selNodes].map((k) => { const [r, i] = k.split(':'); return [k, [...rings[r][i]]]; })), moved: false, toggleOff: mods && was, key: hit.key, before: snapSel() };
          updateUI(); redraw(); return;
        }
        if (!mods && e.button !== 2) {
          const ed = edgeAt(p, e);
          if (ed) {                                                                      // click on an outline: add a node there and drag it
            const beforeInsert = snapSel();
            rings[ed.ri].splice(ed.i + 1, 0, ed.at);
            selNodes.clear(); selNodes.add(ed.ri + ':' + (ed.i + 1));
            drag = { start: p, orig: new Map([[ed.ri + ':' + (ed.i + 1), [...ed.at]]]), moved: true, before: beforeInsert };
            updateUI(); redraw(); return;
          }
        }
        if (mods) { box = { x0: p[0], y0: p[1], x1: p[0], y1: p[1], additive: e.shiftKey || e.ctrlKey || e.metaKey }; return; }
        if (selNodes.size) { selNodes.clear(); updateUI(); }
        tap = { x: p[0], y: p[1], s: relPt(e), id: e.pointerId, op: e.button === 2 || e.altKey || addMode === 'sub' ? 'sub' : 'add' };   // a click counts when the finger is lifted (it may become a pinch)
      };
      ov.onpointermove = (e) => {
        if (!ptrs.has(e.pointerId)) return;
        const now = relPt(e); const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, now);
        if (tap && Math.hypot(now.x - tap.s.x, now.y - tap.s.y) > 8) tap = null;
        if (pinch && ptrs.size >= 2) {
          const [d, ang] = span(), m = mid(), s = d / pinch.d;
          if (tool === 'cut' || tool === 'draw' || tool === 'erase') {
            const z0 = pinch.zv, z = Math.max(1, Math.min(12, z0.z * s)), qx = (pinch.m[0] - z0.x) / z0.z, qy = (pinch.m[1] - z0.y) / z0.z;
            setZoom(z, m[0] - qx * z, m[1] - qy * z); return;
          }
          if (tool === 'crop') {
            const f = view.w / OUT, c0 = pinch.crop, k0 = autoCrop().k;
            const k = Math.max(k0 * 0.2, Math.min(k0 * 4, c0.k * s));
            const ux0 = pinch.m[0] / f, uy0 = pinch.m[1] / f, ux = m[0] / f, uy = m[1] / f;
            const px = (ux0 - OUT / 2 - c0.ox) / c0.k + W() / 2, py = (uy0 - OUT / 2 - c0.oy) / c0.k + H() / 2;
            crop = { k, ox: ux - OUT / 2 - (px - W() / 2) * k, oy: uy - OUT / 2 - (py - H() / 2) * k };
          } else if (tool === 'place' && place) {
            const f = view.f, p0 = pinch.place, rot = p0.rot + (ang - pinch.ang), sc = Math.max(p0.s0 * 0.05, Math.min(p0.s0 * 3, p0.s * s));
            const vx = pinch.m[0] / f - p0.x, vy = pinch.m[1] / f - p0.y;                // the layer point under the first midpoint
            const c0 = Math.cos(-p0.rot), s0_ = Math.sin(-p0.rot), lx = (vx * c0 - vy * s0_) / p0.s, ly = (vx * s0_ + vy * c0) / p0.s;
            place.s = sc; place.rot = rot;
            place.x = m[0] / f - (Math.cos(rot) * lx - Math.sin(rot) * ly) * sc; place.y = m[1] / f - (Math.sin(rot) * lx + Math.cos(rot) * ly) * sc;
          }
          redraw(); return;
        }
        if (vpan) { setZoom(zv.z, zv.x + now.x - vpan.x, zv.y + now.y - vpan.y); vpan = { ...now }; return; }
        if (stroke && (tool === 'draw' || tool === 'erase')) { brush(e); return; }
        if (pan && (tool === 'crop' || tool === 'place')) {
          const dx = now.x - prev.x, dy = now.y - prev.y;
          if (tool === 'crop') { const c = { ...cropState() }; c.ox += dx / (view.w / OUT); c.oy += dy / (view.w / OUT); crop = c; }
          else if (place) { place.x += dx / view.f; place.y += dy / view.f; }
          redraw(); return;
        }
        if (drag) {
          const p = toImg(e), dx = p[0] - drag.start[0], dy = p[1] - drag.start[1];
          for (const [k, o] of drag.orig) { const [r, i] = k.split(':'); rings[r][i] = [Math.max(0, Math.min(W(), o[0] + dx)), Math.max(0, Math.min(H(), o[1] + dy))]; }
          if (Math.hypot(dx, dy) * view.f * zv.z > 3) drag.moved = true;
          redraw(); return;
        }
        if (box) { const p = toImg(e); box.x1 = p[0]; box.y1 = p[1]; redraw(); }
      };
      const up = (e) => {
        ptrs.delete(e.pointerId);
        if (ptrs.size < 2) pinch = null;
        if (ptrs.size === 1 && (tool === 'crop' || tool === 'place')) pan = [...ptrs.values()][0];
        if (ptrs.size) return;
        if (stroke) autoCache = null;                                                     // drawn or erased: the automatic crop must look again
        pan = null; stroke = null; vpan = null;
        if (tap && tap.id === e.pointerId) { const t = tap; tap = null; selectAt(t.x, t.y, t.op); }
        if (drag) {
          if (drag.moved) { pushSel(drag.before); selMask = rasterize(rings); last = null; }
          else {
            for (const [k, o] of drag.orig) { const [r, i] = k.split(':'); rings[r][i] = o; }       // (a tap, not a drag: nothing moves)
            if (drag.toggleOff) selNodes.delete(drag.key);
          }
          drag = null; updateUI(); redraw();
        }
        if (box) {
          const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
          if (x1 - x0 > 4 / (view.f * zv.z) || y1 - y0 > 4 / (view.f * zv.z)) {
            if (!box.additive) selNodes.clear();
            rings.forEach((r, ri) => r.forEach(([x, y], i) => { if (x >= x0 && x <= x1 && y >= y0 && y <= y1) selNodes.add(ri + ':' + i); }));
          }
          box = null; updateUI(); redraw();
        }
      };
      ov.onpointerup = up; ov.onpointercancel = up;
      ov.oncontextmenu = (e) => e.preventDefault();
      ov.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
      ov.ondblclick = (e) => {                                                           // double click on a node removes it
        if (tool !== 'cut') return;
        const hit = nodeAt(toImg(e), e);
        if (hit) { selNodes.clear(); selNodes.add(hit.key); deleteSelectedNodes(); }
      };
      ov.onwheel = (e) => {
        if (tool === 'cut' || tool === 'draw' || tool === 'erase') { e.preventDefault(); const [x, y] = toView(e); zoomAt(x, y, Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * (e.ctrlKey ? 0.01 : 0.0025))); }
        else if (tool === 'crop') { e.preventDefault(); const [x, y] = toView(e); zoomCropAt(x, y, e.deltaY < 0 ? 1.1 : 1 / 1.1); }
        else if (tool === 'place' && place) { e.preventDefault(); place.s = Math.max(place.s0 * 0.05, Math.min(place.s0 * 3, place.s * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); drawPlace(); }
      };

      // ---------------------------------------------------------------- tools and buttons
      const HINTS = {
        cut: 'Click the object you want (or part of the background). More clicks extend the selection; Alt+click or "Subtract" shrinks it. Drag the nodes to correct the outline, click an outline to add a node, Ctrl/Shift+click selects several nodes. Zoom with the mouse wheel or two fingers (move the picture with Space+drag, the middle mouse button or two fingers) to reach small areas.',
        crop: 'This is the round frame the picture gets in the game. Drag the picture, use the mouse wheel or pinch to zoom.',
        draw: 'Draw on the picture with the chosen colour. Zoom with the mouse wheel or two fingers.', erase: 'Rub out parts of the picture (they become transparent).',
        place: 'Drag the second picture to move it, pinch or use the sliders to resize and turn it. Press Done when it fits.',
      };
      function setTool(t) {
        if (t === 'crop' && below) t = 'cut';
        tool = t; stroke = null; box = null; drag = null; tap = null;
        if (t === 'crop' || t === 'place') { zv = { z: 1, x: 0, y: 0 }; cv.style.transform = ''; $('view-reset').hidden = true; }
        for (const [id, on] of [['opt-cut', t === 'cut'], ['opt-crop', t === 'crop'], ['opt-draw', t === 'draw'], ['opt-erase', t === 'erase'], ['opt-place', t === 'place']]) $(id).hidden = !on;
        $('imged-hint').textContent = HINTS[t];
        ov.style.cursor = t === 'cut' ? 'crosshair' : t === 'crop' || t === 'place' ? 'grab' : 'none';
        if (t !== 'cut') setBusy(null);
        if (t === 'cut') { if (modelState === 'idle') initModel(); else if (modelState === 'loading') setBusy('Loading the background-removal model…', 'First time only: about 28 MB are downloaded, later it starts at once.'); else if (modelState === 'ready') { readyStatus(); ensureEmbedding(); } else readyStatus(); }
        updateUI(); layout();
      }
      document.querySelectorAll('#imged [data-tool]').forEach((b) => { b.onclick = () => { if (tool !== 'place') setTool(b.dataset.tool); }; });
      $('imged-rotate').onclick = () => {
        snapshot();
        const t = tmpCanvas(cv.height, cv.width), c = t.getContext('2d');
        c.translate(t.width, 0); c.rotate(Math.PI / 2); c.drawImage(cv, 0, 0);
        cv.width = t.width; cv.height = t.height; ctx.drawImage(t, 0, 0);
        edited = true; crop = null; touched(); layout();
      };
      $('imged-undo').onclick = undo;
      $('imged-reset').onclick = async () => {
        if ((edited || hist.length || below) && !confirm('Discard all changes and start again with the original picture?')) return;
        let b; try { b = await createImageBitmap(file); } catch { return; }
        setCanvasFrom(b, b.width, b.height); b.close();
        below = null; place = null; hist.length = 0; edited = false; crop = null; touched(); err(''); setTool('crop');
      };
      function updateUI() {
        $('imged-undo').disabled = !(hist.length || (tool === 'cut' && selHist.length)) || tool === 'place';
        $('cut-undo').disabled = !selHist.length;
        document.querySelectorAll('#imged [data-tool]').forEach((b) => { b.classList.toggle('on', b.dataset.tool === tool); b.disabled = tool === 'place'; });
        document.querySelector('#imged [data-tool=crop]').hidden = !!below;
        $('imged-add').hidden = !!below; $('imged-add').disabled = tool === 'place';
        $('imged-rotate').disabled = $('imged-reset').disabled = tool === 'place';
        $('imged-pic2').hidden = !below || tool === 'place';
        const locked = !!below || tool === 'place';
        $('imged-ok').disabled = $('imged-rest').disabled = locked;
        $('imged-ok').title = locked ? 'Place or discard the second picture first' : '';
        $('cut-add').classList.toggle('on', addMode === 'add'); $('cut-sub').classList.toggle('on', addMode === 'sub'); $('cut-multi').classList.toggle('on', multi);
        const has = rings.length > 0;
        $('cut-keep').disabled = $('cut-remove').disabled = !has; $('cut-clear').disabled = !has; $('cut-delnode').disabled = !selNodes.size;
      }

      // ---------------------------------------------------------------- result: the round crop as a PNG with transparency
      function result(name) {
        if (!alphaBounds()) return null;                                                  // nothing left
        const out = tmpCanvas(OUT, OUT), c = out.getContext('2d'), k = cropState();
        c.beginPath(); c.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2); c.clip();
        drawCropFrame(c, OUT, k, 1);
        return new Promise((r) => out.toBlob((b) => r(new File([b], name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' })), 'image/png'));
      }

      function finish(r) {
        jobGen++; setBusy(null);
        document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); window.removeEventListener('resize', layout);
        document.body.style.overflow = prevOverflow;
        root.hidden = true; busy = false;
        ov.onpointerdown = ov.onpointermove = ov.onpointerup = ov.onpointercancel = ov.ondblclick = ov.onwheel = ov.oncontextmenu = null;
        resolve(r);
      }
      const onKeyUp = (e) => { if (e.key === ' ') spaceDown = false; };
      const onKey = (e) => {
        if (e.key === ' ' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement && document.activeElement.tagName)) { spaceDown = true; e.preventDefault(); }
        const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName) && document.activeElement.type !== 'range';
        if (e.key === 'Escape') {
          if (selNodes.size) { selNodes.clear(); updateUI(); redraw(); }
          else if (!edited && !below || confirm('Close the editor and discard your changes?')) finish({ action: 'cancel' });
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && selNodes.size && !typing) { e.preventDefault(); deleteSelectedNodes(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      };
      document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKeyUp);
      window.addEventListener('resize', layout);

      $('imged-ok').onclick = async () => {
        jobGen++; setBusy(null);
        const f = await result(file.name || 'image');
        if (!f) return err('Nothing is left of the picture. Undo a step first.');
        finish({ action: 'upload', file: f });
      };
      $('imged-skip').onclick = () => finish({ action: 'skip' });
      $('imged-rest').onclick = async () => {
        const f = await result(file.name || 'image');
        if (!f) return err('Nothing is left of the picture. Undo a step first.');
        finish({ action: 'rest', file: f });
      };
      $('imged-cancel').onclick = () => { if (!edited && !below || confirm('Close the editor and discard your changes?')) finish({ action: 'cancel' }); };

      root.__state = () => ({ zoom: { ...zv }, pointers: ptrs.size, rings, selNodes: [...selNodes], view, w: cv.width, h: cv.height, tool, below: !!below, crop: crop && { ...crop }, autoK: autoCrop().k });   // (read-only, for automated tests)
      readyStatus(); $('cut-tol-label').hidden = true;
      setTool('crop');
    });
  }
  return { open };
})();
