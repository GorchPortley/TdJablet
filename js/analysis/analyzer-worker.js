// Web Worker: waveform + BPM analysis off the UI thread.
// In:  { id, data: Float32Array (mono analysis mix), rate, wantTempo, minBpm, maxBpm }
// Out: { id, wave, tempo } or { id, error }

import { analyzeBands, firstSound } from './waveform.js';
import { detectTempo } from './bpm.js';

self.onmessage = (e) => {
  const { id, data, rate, wantTempo, minBpm, maxBpm } = e.data;
  try {
    const { wave, energy } = analyzeBands(data, rate);
    const tempo = wantTempo ? detectTempo(energy, { minBpm, maxBpm }) : null;
    const start = firstSound(wave);
    self.postMessage(
      { id, wave, tempo, firstSound: start },
      [wave.low.buffer, wave.mid.buffer, wave.high.buffer, wave.peak.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message ? err.message : err) });
  }
};
