// Promise wrapper around the analysis worker.

import { analysisMix } from '../decode/decode.js';

export class Analyzer {
  constructor() {
    this.worker = new Worker(new URL('./analyzer-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.next = 1;
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
  }

  /** @returns {Promise<{wave, tempo, firstSound}>} */
  analyze(decoded, { wantTempo = true, minBpm = 75, maxBpm = 175 } = {}) {
    const mix = analysisMix(decoded.channels, decoded.sampleRate);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, data: mix.data, rate: mix.rate, wantTempo, minBpm, maxBpm }, [mix.data.buffer]);
    });
  }
}
