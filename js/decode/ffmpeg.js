// Last-resort decoder: ffmpeg compiled to WebAssembly (ffmpeg.wasm).
//
// Only used for files the browser cannot decode itself (ALAC on Chrome, WMA,
// APE, WavPack, ...). The ~31 MB core is not part of the repository; the
// GitHub Pages workflow (or tools/fetch-ffmpeg.sh) places it in vendor/ffmpeg/.
// It is loaded on first use and then cached by the service worker.

const BASE = new URL('../../vendor/ffmpeg/', import.meta.url);
let loading = null;

export async function ffmpegAvailable() {
  try {
    if (self.caches && (await caches.match(new URL('core/ffmpeg-core.wasm', BASE).href))) return true;
  } catch {
    /* no Cache API */
  }
  try {
    const r = await fetch(new URL('core/ffmpeg-core.js', BASE), { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

async function getFFmpeg(onStatus) {
  if (!loading) {
    loading = (async () => {
      onStatus?.('Loading extended format support…');
      const { FFmpeg } = await import(new URL('ffmpeg/index.js', BASE).href);
      const ff = new FFmpeg();
      await ff.load({
        coreURL: new URL('core/ffmpeg-core.js', BASE).href,
        wasmURL: new URL('core/ffmpeg-core.wasm', BASE).href,
      });
      return ff;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Decode any file ffmpeg understands to { sampleRate, length, channels }. */
export async function ffmpegDecode(arrayBuffer, sampleRate, onStatus) {
  const ff = await getFFmpeg(onStatus);
  onStatus?.('Decoding with ffmpeg…');
  const name = `in${Date.now()}`;
  await ff.writeFile(name, new Uint8Array(arrayBuffer));
  try {
    const code = await ff.exec(['-i', name, '-vn', '-ac', '2', '-ar', String(sampleRate), '-f', 'f32le', 'out.raw']);
    if (code !== 0) throw new Error(`ffmpeg could not decode this file (exit ${code})`);
    const raw = await ff.readFile('out.raw');
    const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2);
    const n = f.length >> 1;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      L[i] = f[j];
      R[i] = f[j + 1];
    }
    return { sampleRate, length: n, channels: [L, R] };
  } finally {
    ff.deleteFile(name).catch(() => {});
    ff.deleteFile('out.raw').catch(() => {});
  }
}
