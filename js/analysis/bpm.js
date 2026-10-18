// Tempo and beat-phase detection for tracks that don't come with a rekordbox
// beat grid.
//
//   1. Onset strength: how much the energy jumps in each band, ~300 times a second.
//   2. Coarse tempo: autocorrelation of the onset strength, scoring each BPM by
//      how well the pattern repeats after 1, 2, 3 and 4 beats.
//   3. Fine tempo + phase: the onset strength's Fourier coefficient at the beat
//      frequency. Its magnitude peaks sharply at the exact BPM (the longer the
//      track, the sharper), and its angle says where the beats are.

import { ONSET_RATE } from './waveform.js';

/** Small constant: the onset function peaks slightly after the true attack. */
const ONSET_LAG = -0.0008;

export function onsetStrength(energy) {
  const { low, mid, high } = energy;
  const n = low.length;
  const raw = new Float32Array(n);
  let pl = Math.log1p(1000 * low[0]);
  let pm = Math.log1p(1000 * mid[0]);
  let ph = Math.log1p(1000 * high[0]);
  for (let t = 1; t < n; t++) {
    const l = Math.log1p(1000 * low[t]);
    const m = Math.log1p(1000 * mid[t]);
    const h = Math.log1p(1000 * high[t]);
    raw[t] = 1.0 * Math.max(0, l - pl) + 0.5 * Math.max(0, m - pm) + 0.3 * Math.max(0, h - ph);
    pl = l;
    pm = m;
    ph = h;
  }
  // Subtract a moving average (0.2 s) so only the peaks remain.
  const half = Math.round(0.1 * energy.rate);
  const out = new Float32Array(n);
  let acc = 0;
  let cnt = 0;
  for (let t = 0; t < Math.min(n, half); t++) {
    acc += raw[t];
    cnt++;
  }
  for (let t = 0; t < n; t++) {
    const add = t + half;
    if (add < n) {
      acc += raw[add];
      cnt++;
    }
    const rem = t - half - 1;
    if (rem >= 0) {
      acc -= raw[rem];
      cnt--;
    }
    out[t] = Math.max(0, raw[t] - acc / cnt);
  }
  return out;
}

function coarseTempo(o, rate, lo, hi) {
  // Work at half rate: plenty for a first guess and 4x cheaper.
  const n = o.length >> 1;
  const x = new Float32Array(n);
  for (let t = 0; t < n; t++) x[t] = o[2 * t] + o[2 * t + 1];
  const r = rate / 2;
  const maxLag = Math.ceil((4 * 60 * r) / lo) + 2;
  const minLag = Math.floor((60 * r) / hi) - 1;
  const acf = new Float32Array(maxLag + 2);
  for (let l = minLag; l <= maxLag + 1; l++) {
    let s = 0;
    for (let t = 0; t + l < n; t++) s += x[t] * x[t + l];
    acf[l] = s / (n - l);
  }
  const at = (lag) => {
    const i = Math.floor(lag);
    const f = lag - i;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };
  let best = 0;
  let bestScore = -Infinity;
  for (let b = lo; b <= hi; b += 0.1) {
    const P = (60 * r) / b;
    const s = at(P) + 0.5 * at(2 * P) + 0.33 * at(3 * P) + 0.25 * at(4 * P);
    const oct = Math.log2(b / 125);
    const score = s * Math.exp(-0.5 * oct * oct);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

/** Fourier coefficients of o at the beat frequency and its 2nd harmonic. */
function beatSpectrum(o, rate, bpm) {
  const w = (2 * Math.PI * bpm) / 60 / rate;
  const cr = Math.cos(w);
  const ci = -Math.sin(w);
  let zr = 1;
  let zi = 0;
  let sr = 0;
  let si = 0;
  let s2r = 0;
  let s2i = 0;
  for (let t = 0; t < o.length; t++) {
    const v = o[t];
    if (v !== 0) {
      sr += v * zr;
      si += v * zi;
      s2r += v * (zr * zr - zi * zi);
      s2i += v * (2 * zr * zi);
    }
    const nr = zr * cr - zi * ci;
    zi = zr * ci + zi * cr;
    zr = nr;
    if ((t & 1023) === 1023) {
      const m = 1 / Math.hypot(zr, zi);
      zr *= m;
      zi *= m;
    }
  }
  return { re: sr, im: si, score: Math.hypot(sr, si) + 0.5 * Math.hypot(s2r, s2i) };
}

/**
 * @param energy  output of analyzeBands().energy
 * @returns {{bpm, first, confidence} | null}  first = time (s) of a downbeat
 */
export function detectTempo(energy, { minBpm = 75, maxBpm = 175 } = {}) {
  const rate = energy.rate || ONSET_RATE;
  const o = onsetStrength(energy);
  if (o.length < rate * 8) return null;
  let total = 0;
  for (let t = 0; t < o.length; t++) total += o[t];
  if (total <= 1e-6) return null;

  const coarse = coarseTempo(o, rate, minBpm, maxBpm);

  const scan = (from, to, step) => {
    let best = from;
    let bestS = -Infinity;
    const scores = [];
    for (let b = from; b <= to + 1e-9; b += step) {
      const s = beatSpectrum(o, rate, b).score;
      scores.push(s);
      if (s > bestS) {
        bestS = s;
        best = b;
      }
    }
    return { best, bestS, scores };
  };
  let { best } = scan(coarse - 1.5, coarse + 1.5, 0.02);
  const fine = scan(best - 0.03, best + 0.03, 0.002);
  best = fine.best;
  let bestS = fine.bestS;

  // Most dance music sits on whole BPMs; prefer that when it fits as well.
  const whole = Math.round(best);
  if (Math.abs(best - whole) < 0.035) {
    const s = beatSpectrum(o, rate, whole).score;
    if (s >= 0.95 * bestS) {
      best = whole;
      bestS = s;
    }
  }

  // Beat phase: fold the onset strength over one beat and take the strongest
  // point. (The Fourier angle would be the *average* onset position, which is
  // pulled late by everything that happens after the kick's attack.)
  const period = (60 * rate) / best; // in onset frames
  const bins = Math.max(8, Math.round(period));
  const hist = new Float64Array(bins);
  for (let t = 0; t < o.length; t++) {
    if (o[t] === 0) continue;
    const ph = ((t % period) / period) * bins;
    const j = Math.floor(ph);
    const f = ph - j;
    hist[j % bins] += o[t] * (1 - f);
    hist[(j + 1) % bins] += o[t] * f;
  }
  let peak = 0;
  for (let j = 1; j < bins; j++) if (hist[j] > hist[peak]) peak = j;
  const a = hist[(peak - 1 + bins) % bins];
  const b = hist[peak];
  const c = hist[(peak + 1) % bins];
  const den = a - 2 * b + c;
  const delta = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  let t0 = ((peak + delta) / bins) * period;
  t0 = ((t0 % period) + period) % period;

  // Downbeat guess: the first beat that clearly has something on it.
  const strengths = [];
  for (let k = 0; t0 + k * period < o.length; k++) {
    const c = Math.round(t0 + k * period);
    let m = 0;
    for (let j = c - 2; j <= c + 2; j++) if (j >= 0 && j < o.length && o[j] > m) m = o[j];
    strengths.push(m);
  }
  const sorted = strengths.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  let firstK = 0;
  while (firstK < strengths.length && strengths[firstK] < 0.3 * median) firstK++;
  if (firstK >= strengths.length) firstK = 0;

  const first = (t0 + firstK * period) / rate + ONSET_LAG;
  const confidence = Math.min(1, bestS / total);
  return { bpm: best, first, confidence };
}
