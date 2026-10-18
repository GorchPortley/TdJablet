import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeckCore } from '../../js/audio/dsp/DeckCore.js';
import { EngineCore } from '../../js/audio/engine-processor.js';
import { BeatGrid } from '../../js/shared/BeatGrid.js';

const SR = 48000;
const BLOCK = 128;

function sine(freq, seconds, amp = 0.5) {
  const n = Math.round(seconds * SR);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(32767 * amp * Math.sin((2 * Math.PI * freq * i) / SR));
  return a;
}

function ramp(seconds) {
  // Sample value encodes its own index (mod 30000) so we can see where the playhead read from.
  const n = Math.round(seconds * SR);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = i % 30000;
  return a;
}

function renderSeconds(target, seconds) {
  // Renders exactly round(seconds * SR) frames, in 128-frame blocks plus a short last block.
  const total = Math.round(seconds * SR);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  for (let off = 0; off < total; off += BLOCK) {
    const n = Math.min(BLOCK, total - off);
    const l = L.subarray(off, off + n);
    const r = R.subarray(off, off + n);
    if (target instanceof EngineCore) {
      target.render([[l, r], [new Float32Array(n), new Float32Array(n)]], n);
    } else {
      target.render(l, r, n);
    }
  }
  return { L, R };
}

/** Estimate the frequency of a signal from its zero crossings. */
function zeroCrossFreq(x, start, end) {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = start + 1; i < end; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + -x[i - 1] / (x[i] - x[i - 1]);
      if (first < 0) first = t;
      else count++;
      last = t;
    }
  }
  return (count * SR) / (last - first);
}

function loadDeck(d, data, extra = {}) {
  d.command({ cmd: 'load', left: data, right: data, length: data.length, pos: 0, ...extra });
}

test('plays at normal speed and advances exactly one frame per sample', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 3));
  d.command({ cmd: 'play' });
  renderSeconds(d, 1);
  assert.ok(Math.abs(d.pos - SR) < 1e-6, `pos ${d.pos}`);
});

test('output pitch follows tempo without key lock', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 4));
  d.command({ cmd: 'tempo', value: 1.08 });
  d.command({ cmd: 'play' });
  const { L } = renderSeconds(d, 1);
  const f = zeroCrossFreq(L, 4800, L.length);
  assert.ok(Math.abs(f - 440 * 1.08) < 1, `freq ${f}`);
});

test('key lock keeps the pitch while the tempo changes', () => {
  for (const tempo of [0.9, 1.08, 1.16]) {
    const d = new DeckCore(SR);
    loadDeck(d, sine(440, 6));
    d.command({ cmd: 'keyLock', on: true });
    d.command({ cmd: 'tempo', value: tempo });
    d.command({ cmd: 'play' });
    const { L } = renderSeconds(d, 2);
    const f = zeroCrossFreq(L, 9600, L.length);
    assert.ok(Math.abs(f - 440) < 2, `tempo ${tempo}: freq ${f}`);
    assert.ok(Math.abs(d.pos - 2 * SR * tempo) < 2, `tempo ${tempo}: pos ${d.pos}`);
  }
});

test('key lock output is clean (no large discontinuities)', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(220, 6, 0.5));
  d.command({ cmd: 'keyLock', on: true });
  d.command({ cmd: 'tempo', value: 1.1 });
  d.command({ cmd: 'play' });
  const { L } = renderSeconds(d, 2);
  // A 220 Hz sine at amplitude 0.5 moves at most 2*pi*220*0.5/48000 = 0.0144 per sample.
  let worst = 0;
  for (let i = 9600; i < L.length; i++) worst = Math.max(worst, Math.abs(L[i] - L[i - 1]));
  assert.ok(worst < 0.03, `max step ${worst}`);
});

test('pausing fades out instead of clicking, and stops the playhead', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 3));
  d.command({ cmd: 'play' });
  renderSeconds(d, 0.5);
  d.command({ cmd: 'pause' });
  const { L } = renderSeconds(d, 0.1);
  const p = d.pos;
  renderSeconds(d, 0.1);
  assert.equal(d.pos, p);
  assert.ok(Math.abs(L[L.length - 1]) < 1e-3);
  assert.ok(p - 0.5 * SR < 0.01 * SR, 'stopped within 10 ms');
});

test('loops wrap sample-accurately', () => {
  const d = new DeckCore(SR);
  loadDeck(d, ramp(5));
  d.command({ cmd: 'play' });
  d.command({ cmd: 'loop', in: 1000, out: 1000 + 24000 });
  renderSeconds(d, 2);
  assert.ok(d.pos >= 1000 && d.pos < 25000, `pos ${d.pos}`);
  // 96000 samples rendered; position = 96000 wrapped into [1000, 25000)
  const expected = 1000 + ((96000 - 1000) % 24000);
  assert.ok(Math.abs(d.pos - expected) < 1e-6, `pos ${d.pos} expected ${expected}`);
  d.command({ cmd: 'loopExit' });
  renderSeconds(d, 1);
  assert.ok(Math.abs(d.pos - expected - SR) < 1e-6);
});

test('slip mode returns to where the track would have been', () => {
  const d = new DeckCore(SR);
  loadDeck(d, ramp(10));
  d.command({ cmd: 'slip', on: true });
  d.command({ cmd: 'play' });
  renderSeconds(d, 1);
  d.command({ cmd: 'loop', in: SR, out: SR + 12000 });
  renderSeconds(d, 2);
  d.command({ cmd: 'loopExit' });
  assert.ok(Math.abs(d.pos - 3 * SR) < 1, `pos ${d.pos}`);
});

test('phase push moves the playhead by exactly the pushed amount', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 5));
  d.command({ cmd: 'play' });
  renderSeconds(d, 0.5);
  d.command({ cmd: 'push', frames: -2400 }); // pull back 50 ms
  renderSeconds(d, 1.5);
  assert.ok(Math.abs(d.pos - (2 * SR - 2400)) < 1, `pos ${d.pos}`);
  assert.equal(d.push, 0);
});

test('scratch: the playhead follows the finger and comes to rest on it', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 5));
  d.command({ cmd: 'seek', pos: SR });
  d.command({ cmd: 'scratchStart' });
  // Finger moves 0.25 s of audio forward over 100 ms, in 60 Hz steps.
  const steps = 6;
  const total = 0.25 * SR;
  for (let s = 0; s < steps; s++) {
    d.command({ cmd: 'scratchMove', delta: total / steps, vel: total / (0.1 * SR) });
    renderSeconds(d, 0.1 / steps);
  }
  d.command({ cmd: 'scratchMove', delta: 0, vel: 0 });
  renderSeconds(d, 0.3);
  assert.ok(Math.abs(d.pos - (SR + total)) < 5, `pos ${d.pos}`);
  d.command({ cmd: 'scratchEnd' });
  renderSeconds(d, 0.1);
  assert.ok(Math.abs(d.pos - (SR + total)) < 50, 'paused deck stays put after release');
});

test('vinyl mode: holding the record while playing stops it, releasing resumes', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 5));
  d.command({ cmd: 'play' });
  renderSeconds(d, 0.5);
  d.command({ cmd: 'scratchStart' });
  renderSeconds(d, 0.2);
  const held = d.pos;
  renderSeconds(d, 0.2);
  assert.ok(Math.abs(d.pos - held) < 2, 'record held still');
  d.command({ cmd: 'scratchEnd' });
  renderSeconds(d, 0.5);
  assert.ok(Math.abs(d.pos - (held + 0.5 * SR)) < 100, `resumed, pos ${d.pos}`);
});

test('quantized jumps keep the beat phase', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 30), { grid: { frames: BeatGrid.constant(120, 0, SR, 30 * SR).frames, firstBeatInBar: 1 } });
  d.command({ cmd: 'play' });
  renderSeconds(d, 1.1); // 2.2 beats in
  d.command({ cmd: 'jump', pos: 10 * SR, quantize: true }); // beat 20
  const beat = d.grid.beatAt(d.pos);
  assert.ok(Math.abs(beat - Math.floor(beat) - 0.2) < 1e-6, `beat ${beat}`);
});

test('beat sync matches tempo and phase of the master deck', () => {
  const e = new EngineCore(SR);
  const [a, b] = e.decks;
  const gridA = BeatGrid.constant(128, 0.1 * SR, SR, 60 * SR);
  const gridB = BeatGrid.constant(124, 0.37 * SR, SR, 60 * SR);
  loadDeck(a, sine(440, 60), { grid: { frames: gridA.frames, firstBeatInBar: 1 } });
  loadDeck(b, sine(330, 60), { grid: { frames: gridB.frames, firstBeatInBar: 1 } });
  e.command({ deck: 0, cmd: 'play' });
  e.command({ deck: 1, cmd: 'play' });
  renderSeconds(e, 0.3);
  e.command({ deck: 1, cmd: 'sync', on: true });
  renderSeconds(e, 3);
  assert.ok(Math.abs(b.baseRate - 128 / 124) < 1e-9, `rate ${b.baseRate}`);
  const pa = gridA.beatAt(a.pos);
  const pb = gridB.beatAt(b.pos);
  let err = (pa - Math.floor(pa)) - (pb - Math.floor(pb));
  if (err > 0.5) err -= 1;
  if (err < -0.5) err += 1;
  const ms = ((err * 60) / 128) * 1000;
  assert.ok(Math.abs(ms) < 1, `phase error ${ms} ms`);
  // Turning sync off keeps the tempo instead of jumping back to the fader.
  e.command({ deck: 1, cmd: 'sync', on: false });
  assert.ok(Math.abs(b.tempo - 128 / 124) < 1e-9);
});

test('stops at the end of the track', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 0.5));
  d.command({ cmd: 'play' });
  renderSeconds(d, 1);
  assert.equal(d.playing, false);
  assert.equal(d.ended, true);
  assert.equal(d.pos, d.length);
});

test('a big phase push still lands within about a second', () => {
  const d = new DeckCore(SR);
  loadDeck(d, sine(440, 10));
  d.command({ cmd: 'play' });
  renderSeconds(d, 0.2);
  d.command({ cmd: 'push', frames: 0.4 * SR });
  renderSeconds(d, 1.25);
  assert.equal(d.push, 0);
  assert.ok(Math.abs(d.pos - (1.45 * SR + 0.4 * SR)) < 1, `pos ${d.pos}`);
});
