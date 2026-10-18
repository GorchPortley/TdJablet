// Three-band waveform (like rekordbox's "3Band" view) plus the band energies
// the BPM detector works from. Input is the mono, decimated analysis mix.

export const WAVE_RATE = 150; // waveform points per second
export const ONSET_RATE = 300; // energy frames per second for beat detection

/** RBJ biquad (Butterworth Q) low- or high-pass, from `x` into `out`. */
function biquad(x, out, rate, freq, high) {
  const w = (2 * Math.PI * freq) / rate;
  const cs = Math.cos(w);
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (high ? (1 + cs) / 2 : (1 - cs) / 2) / a0;
  const b1 = (high ? -(1 + cs) : 1 - cs) / a0;
  const b2 = b0;
  const a1 = (-2 * cs) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    out[i] = y0;
  }
  return out;
}

/**
 * @returns {{ wave: {rate, low, mid, high, peak}, energy: {rate, low, mid, high} }}
 *   wave.* are Uint8Array (0..255), energy.* are Float32Array (mean square)
 */
export function analyzeBands(x, rate) {
  const n = x.length;
  // Each band gets its own 4th-order filter pair (subtracting filtered signals
  // would leak bass into the mids because of phase differences).
  const tmp = new Float32Array(n);
  const low = biquad(biquad(x, tmp, rate, 200, false), new Float32Array(n), rate, 200, false);
  const mid = biquad(biquad(x, tmp, rate, 200, true), new Float32Array(n), rate, 2500, false);
  const high = biquad(biquad(x, tmp, rate, 2500, true), new Float32Array(n), rate, 2500, true);

  const nWave = Math.max(1, Math.ceil((n / rate) * WAVE_RATE));
  const wl = new Float32Array(nWave);
  const wm = new Float32Array(nWave);
  const wh = new Float32Array(nWave);
  const wp = new Float32Array(nWave);
  const nOn = Math.max(1, Math.ceil((n / rate) * ONSET_RATE));
  const el = new Float32Array(nOn);
  const em = new Float32Array(nOn);
  const eh = new Float32Array(nOn);
  const cnt = new Float32Array(nOn);
  const kw = WAVE_RATE / rate;
  const ko = ONSET_RATE / rate;

  for (let i = 0; i < n; i++) {
    const l = low[i];
    const m = mid[i];
    const h = high[i];
    const w = (i * kw) | 0;
    const al = l < 0 ? -l : l;
    const am = m < 0 ? -m : m;
    const ah = h < 0 ? -h : h;
    const ap = x[i] < 0 ? -x[i] : x[i];
    if (al > wl[w]) wl[w] = al;
    if (am > wm[w]) wm[w] = am;
    if (ah > wh[w]) wh[w] = ah;
    if (ap > wp[w]) wp[w] = ap;
    const o = (i * ko) | 0;
    el[o] += l * l;
    em[o] += m * m;
    eh[o] += h * h;
    cnt[o]++;
  }
  for (let o = 0; o < nOn; o++) {
    const c = cnt[o] || 1;
    el[o] /= c;
    em[o] /= c;
    eh[o] /= c;
  }

  let max = 1e-6;
  for (let i = 0; i < nWave; i++) if (wp[i] > max) max = wp[i];
  const q = (a) => {
    const out = new Uint8Array(nWave);
    for (let i = 0; i < nWave; i++) out[i] = Math.min(255, Math.round((a[i] / max) * 255));
    return out;
  };
  return {
    wave: { rate: WAVE_RATE, low: q(wl), mid: q(wm), high: q(wh), peak: q(wp) },
    energy: { rate: ONSET_RATE, low: el, mid: em, high: eh },
  };
}

/** Time (s) of the first sound louder than `db` relative to the loudest peak. */
export function firstSound(wave, db = -36) {
  const thr = 255 * Math.pow(10, db / 20);
  for (let i = 0; i < wave.peak.length; i++) if (wave.peak[i] >= thr) return i / wave.rate;
  return 0;
}
