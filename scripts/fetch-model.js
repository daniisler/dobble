'use strict';
// Downloads what the picture editor's "Remove background" tool needs and serves from this app (nothing is loaded from
// other sites while the app runs):
//   - the SlimSAM segmentation model (Apache-2.0, about 14 MB, quantized) by Zigeng Chen et al., in the ONNX version of Xenova
//   - Transformers.js (Apache-2.0) and the ONNX Runtime WebAssembly file (MIT, about 14 MB) that run it in the browser
// Files are pinned to exact versions and verified by SHA-256. It runs after `npm install` / `npm ci` (so also while building
// the Docker image) and can be run again with `npm run fetch-model`. If a download fails, the app still works: the editor then
// falls back to its simple colour-based method. Set SKIP_MODEL_DOWNLOAD=1 to skip it.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', 'public');
const HF = 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/';
const JSD = 'https://cdn.jsdelivr.net/npm/';
const FILES = [
  [JSD + '@huggingface/transformers@4.3.2/dist/transformers.min.js', 'vendor/transformers.min.js', '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb'],
  [JSD + 'onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.mjs', 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f'],
  [JSD + 'onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort-wasm-simd-threaded.wasm', 'vendor/ort-wasm-simd-threaded.wasm', '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3'],
  [HF + 'config.json', 'models/Xenova/slimsam-77-uniform/config.json', '6339884f168658d3ca6473b486973913fb33e84e625e06ae2dd7b4a808187419'],
  [HF + 'preprocessor_config.json', 'models/Xenova/slimsam-77-uniform/preprocessor_config.json', '225545a743c654e3c495ec6f545a0eaba57c8ba3fbbd8483b3cb1c0fc58db517'],
  [HF + 'quantize_config.json', 'models/Xenova/slimsam-77-uniform/quantize_config.json', '2a1e2927485ff8675da940616e77578321e2083477d3fb22d2cfc53c604fb8ff'],
  [HF + 'onnx/vision_encoder_quantized.onnx', 'models/Xenova/slimsam-77-uniform/onnx/vision_encoder_quantized.onnx', 'cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971'],
  [HF + 'onnx/prompt_encoder_mask_decoder_quantized.onnx', 'models/Xenova/slimsam-77-uniform/onnx/prompt_encoder_mask_decoder_quantized.onnx', 'cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2'],
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  if (process.env.SKIP_MODEL_DOWNLOAD) return console.log('Picture editor model: skipped (SKIP_MODEL_DOWNLOAD)');
  let got = 0, failed = 0;
  for (const [url, rel, hash] of FILES) {
    const dest = path.join(PUBLIC, rel);
    try { if (sha(fs.readFileSync(dest)) === hash) continue; } catch { }       // already there and intact
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha(buf) !== hash) throw new Error('checksum mismatch');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest + '.part', buf); fs.renameSync(dest + '.part', dest);
      got++; console.log('downloaded', rel, (buf.length / 1e6).toFixed(1) + ' MB');
    } catch (e) { failed++; console.warn(`could not fetch ${rel}: ${e.message}`); }
  }
  if (failed) console.warn(`Picture editor model: ${failed} file(s) missing. Background removal falls back to the simple method. Retry with: npm run fetch-model`);
  else console.log(got ? 'Picture editor model: ready' : 'Picture editor model: already installed');
}
main().catch((e) => console.warn('Picture editor model: ' + e.message)).finally(() => process.exit(0));
