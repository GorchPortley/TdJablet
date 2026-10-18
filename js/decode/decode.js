// Turn any audio file into PCM at the AudioContext's sample rate.
//
//   1. The browser's own decoder (MP3, AAC/M4A, FLAC, Ogg, Opus, WAV, and on
//      Safari also AIFF and ALAC). It resamples to the context rate for us.
//   2. Our WAV/AIFF parser (AIFF on Chrome/Android, unusual WAV variants).
//   3. ffmpeg.wasm, if it is bundled (everything else).

import { parsePcm } from './pcm.js';
import { ffmpegDecode, ffmpegAvailable } from './ffmpeg.js';

export async function decodeAudio(blob, ctx, onStatus) {
  const bytes = await blob.arrayBuffer();
  const rate = ctx.sampleRate;
  const errors = [];

  try {
    const ab = await decodeNative(ctx, bytes.slice(0));
    const channels = [];
    for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) channels.push(ab.getChannelData(c));
    return { sampleRate: ab.sampleRate, length: ab.length, channels, decoder: 'browser' };
  } catch (e) {
    errors.push(`browser: ${e && e.message ? e.message : e}`);
  }

  try {
    const pcm = parsePcm(bytes);
    if (pcm) {
      pcm.channels = pcm.channels.slice(0, 2);
      const out = pcm.sampleRate === rate ? pcm : await resample(pcm, rate);
      out.decoder = 'pcm';
      return out;
    }
  } catch (e) {
    errors.push(`pcm: ${e.message}`);
  }

  if (await ffmpegAvailable()) {
    const out = await ffmpegDecode(bytes, rate, onStatus);
    out.decoder = 'ffmpeg';
    return out;
  }
  errors.push('ffmpeg: not bundled with this build');
  throw new Error(`Can't decode this file (${errors.join('; ')})`);
}

function decodeNative(ctx, bytes) {
  // Older Safari only supports the callback form.
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

/** Resample with the browser's own (good quality) resampler. */
export async function resample(pcm, rate) {
  const frames = Math.ceil((pcm.length * rate) / pcm.sampleRate);
  const nch = pcm.channels.length;
  try {
    const off = new OfflineAudioContext(nch, frames, rate);
    const buf = off.createBuffer(nch, pcm.length, pcm.sampleRate);
    for (let c = 0; c < nch; c++) buf.copyToChannel(pcm.channels[c], c);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    const channels = [];
    for (let c = 0; c < nch; c++) channels.push(out.getChannelData(c));
    return { sampleRate: rate, length: out.length, channels };
  } catch {
    // Sample rate the browser can't handle in an AudioBuffer: plain linear interpolation.
    const ratio = pcm.sampleRate / rate;
    const channels = pcm.channels.map((ch) => {
      const o = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        const p = i * ratio;
        const j = Math.floor(p);
        const t = p - j;
        o[i] = (ch[j] || 0) * (1 - t) + (ch[j + 1] || 0) * t;
      }
      return o;
    });
    return { sampleRate: rate, length: frames, channels };
  }
}

/** Float32 [-1, 1] → Int16, which halves the memory a loaded track needs. */
export function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = f32[i] * 32767;
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : Math.round(s);
  }
  return out;
}

/** Mono mix decimated to roughly 11-12 kHz, used for waveform and BPM analysis. */
export function analysisMix(channels, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 12000));
  const L = channels[0];
  const R = channels[1] || channels[0];
  const n = Math.floor(L.length / factor);
  const out = new Float32Array(n);
  const k = 0.5 / factor;
  for (let i = 0, j = 0; i < n; i++) {
    let s = 0;
    for (let f = 0; f < factor; f++, j++) s += L[j] + R[j];
    out[i] = s * k;
  }
  return { data: out, rate: sampleRate / factor };
}
