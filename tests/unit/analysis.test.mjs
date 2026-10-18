import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBands, firstSound } from '../../js/analysis/waveform.js';
import { detectTempo } from '../../js/analysis/bpm.js';
import { BeatGrid } from '../../js/shared/BeatGrid.js';

const RATE = 12000;

/** A simple synthetic dance track: kick on every beat, hi-hat on the off-beats, a bass line. */
function synthTrack(bpm, seconds, first = 0.25, { swingNoise = 0 } = {}) {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  const spb = 60 / bpm;
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let k = 0; first + k * spb < seconds; k++) {
    const t0 = first + k * spb + swingNoise * rnd();
    const i0 = Math.round(t0 * RATE);
    // kick: decaying sine sweep
    for (let i = 0; i < 0.15 * RATE && i0 + i < n; i++) {
      const t = i / RATE;
      const f = 50 + 100 * Math.exp(-t * 30);
      x[i0 + i] += 0.8 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * f * t);
    }
    // off-beat hat: short noise burst
    const h0 = Math.round((t0 + spb / 2) * RATE);
    for (let i = 0; i < 0.03 * RATE && h0 + i < n; i++) x[h0 + i] += 0.15 * Math.exp((-i / RATE) * 120) * rnd();
  }
  for (let i = 0; i < n; i++) x[i] += 0.1 * Math.sin((2 * Math.PI * 55 * i) / RATE);
  return x;
}

for (const bpm of [124, 128, 140, 174, 92.5]) {
  test(`detects ${bpm} BPM and the beat phase`, () => {
    const first = 0.31;
    const x = synthTrack(bpm, 90, first);
    const { energy } = analyzeBands(x, RATE);
    const r = detectTempo(energy);
    assert.ok(r, 'got a result');
    assert.ok(Math.abs(r.bpm - bpm) < 0.02, `bpm ${r.bpm}`);
    const spb = 60 / bpm;
    let d = (r.first - first) / spb;
    d -= Math.round(d);
    const ms = d * spb * 1000;
    assert.ok(Math.abs(ms) < 2.5, `phase off by ${ms.toFixed(2)} ms`);
  });
}

test('tolerates sloppy timing', () => {
  const x = synthTrack(126, 120, 0.1, { swingNoise: 0.004 });
  const r = detectTempo(analyzeBands(x, RATE).energy);
  assert.ok(Math.abs(r.bpm - 126) < 0.05, `bpm ${r.bpm}`);
});

test('silence gives no tempo', () => {
  const r = detectTempo(analyzeBands(new Float32Array(RATE * 20), RATE).energy);
  assert.equal(r, null);
});

test('waveform has three bands and finds the first sound', () => {
  const x = new Float32Array(RATE * 4);
  for (let i = RATE; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 60 * i) / RATE) + 0.2 * Math.sin((2 * Math.PI * 5000 * i) / RATE);
  const { wave } = analyzeBands(x, RATE);
  assert.equal(wave.low.length, 600);
  assert.ok(Math.abs(firstSound(wave) - 1) < 0.02);
  const mid = Math.round(2.5 * 150);
  assert.ok(wave.low[mid] > wave.high[mid], 'more bass than treble');
  assert.ok(wave.high[mid] > wave.mid[mid] * 1.5, 'treble lands in the high band');
});

test('BeatGrid basics', () => {
  const sr = 48000;
  const g = BeatGrid.constant(120, 12000, sr, 10 * sr, 3);
  // first beat at or after 0 is 12000 itself
  assert.equal(g.frames[0], 12000);
  assert.equal(g.barBeat(0), 3);
  assert.ok(Math.abs(g.beatAt(12000 + 6000) - 0.25) < 1e-9);
  assert.ok(Math.abs(g.frameAt(2.5) - (12000 + 2.5 * 24000)) < 1e-9);
  assert.ok(Math.abs(g.bpmAt(100000, sr) - 120) < 1e-9);
  assert.ok(Math.abs(g.beatAt(0) - -0.5) < 1e-9, 'extrapolates before the first beat');
  const d = g.withDownbeat(2);
  assert.equal(d.barBeat(2), 1);
  assert.equal(d.barBeat(6), 1);
  const spec = g.toSpec(sr);
  const g2 = BeatGrid.fromSpec(spec, 44100, 10 * 44100);
  assert.ok(Math.abs(g2.bpmAt(1000, 44100) - 120) < 1e-6);
  const dbl = g.scaledTempo(2);
  assert.ok(Math.abs(dbl.bpmAt(100000, sr) - 240) < 1e-9);
  // anchor before 0 with a bar offset
  const h = BeatGrid.constant(120, -30000, sr, 10 * sr, 1);
  assert.ok(h.frames[0] >= 0 && h.frames[0] < 24000);
  assert.equal(h.barBeat(0), 3); // -30000 + 2 beats = 18000
});
