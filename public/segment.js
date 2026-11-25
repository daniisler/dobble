'use strict';
// Click-to-select for the picture editor, done by a real segmentation model (SlimSAM, a compact version of Meta's Segment
// Anything model, Apache-2.0) that runs inside the browser through Transformers.js and ONNX Runtime (WebAssembly).
// Nothing is sent anywhere: the model files are served by this app (public/models, public/vendor, fetched by
// scripts/fetch-model.js) and are only downloaded when somebody first uses the "Remove background" tool.
//
//   Segmenter.load(onStatus)         -> Promise<boolean>   (false: not installed / not supported, use the simple method)
//   Segmenter.prepare(canvas, id)    -> Promise            looks at a picture once (a few seconds); `id` names its version
//   Segmenter.segment(x, y, id)      -> Promise<{masks:[Uint8Array], iou:[number], w, h}>   candidates for a click, best first
const Segmenter = (() => {
  const MODEL = 'Xenova/slimsam-77-uniform';
  let T = null, model = null, processor = null, loading = null, failed = false;
  let prepared = { id: null, promise: null, image: null, emb: null };
  let threads = 1;

  function load(onStatus = () => { }) {
    if (failed) return Promise.resolve(false);
    if (model) return Promise.resolve(true);
    if (loading) return loading;
    loading = (async () => {
      try {
        onStatus('Loading the background-removal model…');
        const head = await fetch(`/models/${MODEL}/onnx/vision_encoder_quantized.onnx`, { method: 'HEAD' });
        if (!head.ok) throw new Error('model files not installed');
        T = await import('/vendor/transformers.min.js');
        const { env } = T;
        env.allowRemoteModels = false; env.allowLocalModels = true; env.localModelPath = '/models/';
        env.backends.onnx.wasm.wasmPaths = { mjs: '/vendor/ort-wasm-simd-threaded.mjs', wasm: '/vendor/ort-wasm-simd-threaded.wasm' };
        // several threads need cross-origin isolation, which the server turns on
        threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
        env.backends.onnx.wasm.numThreads = threads;
        env.backends.onnx.wasm.proxy = true;     // run the model in a background worker, so the page (spinner, Cancel button) stays responsive
        const files = {};
        const progress = (e) => {
          if (e.status !== 'progress' || !e.total) return;
          files[e.file] = [e.loaded, e.total];
          const [l, t] = Object.values(files).reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
          onStatus(`Loading the background-removal model… ${Math.round(100 * l / t)}%`);
        };
        model = await T.SamModel.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: progress });
        processor = await T.AutoProcessor.from_pretrained(MODEL);
        return true;
      } catch (e) {
        console.warn('Segmentation model unavailable:', e);
        failed = true; model = null;
        return false;
      }
    })();
    return loading;
  }

  // the picture as the model sees it: transparent parts on neutral grey
  async function toRaw(canvas) {
    const t = document.createElement('canvas'); t.width = canvas.width; t.height = canvas.height;
    const c = t.getContext('2d'); c.fillStyle = '#808080'; c.fillRect(0, 0, t.width, t.height); c.drawImage(canvas, 0, 0);
    const blob = await new Promise((r) => t.toBlob(r, 'image/png'));
    return T.RawImage.fromBlob(blob);
  }

  function prepare(canvas, id) {
    if (!model) return Promise.reject(new Error('model not loaded'));
    if (prepared.id === id && prepared.promise) return prepared.promise;
    const mine = prepared = { id, promise: null, image: null, emb: null };
    mine.promise = (async () => {
      mine.image = await toRaw(canvas);
      const inputs = await processor(mine.image);
      mine.emb = await model.get_image_embeddings(inputs);
    })();
    return mine.promise;
  }

  async function segment(x, y, id) {
    const cur = prepared;
    if (!cur || cur.id !== id) throw new Error('picture changed');
    await cur.promise;
    const p = await processor(cur.image, { input_points: [[[x, y]]], input_labels: [[1]] });
    const out = await model({ ...cur.emb, input_points: p.input_points, input_labels: p.input_labels });
    const masks = (await processor.post_process_masks(out.pred_masks, p.original_sizes, p.reshaped_input_sizes))[0];   // [1, 3, H, W] booleans
    const [, n, h, w] = masks.dims, iou = Array.from(out.iou_scores.data);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => iou[b] - iou[a]);
    return { w, h, iou: order.map((i) => iou[i]), masks: order.map((i) => Uint8Array.from(masks.data.subarray(i * w * h, (i + 1) * w * h), (v) => (v ? 1 : 0))) };
  }

  // how the model runs here (shown to the user while waiting, because it decides the speed)
  const info = () => ({ threads, isolated: !!self.crossOriginIsolated });
  // the picture only lost pixels (a cut-out was applied): the analysis of the original is still good for it, so keep it
  function keep(id) { if (prepared.promise) prepared.id = id; }
  return { load, prepare, segment, info, keep };
})();
