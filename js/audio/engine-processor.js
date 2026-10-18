// The audio thread. One AudioWorkletProcessor runs both decks so that beat
// sync can compare their playheads sample-accurately (two separate worklet
// nodes could only talk to each other through the main thread).
//
// Output 0 = deck A (stereo), output 1 = deck B (stereo). Mixing, EQ and
// routing happen in ordinary Web Audio nodes on the main thread side
// (see AudioEngine.js).

import { DeckCore, clamp } from './dsp/DeckCore.js';

export class EngineCore {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.decks = [new DeckCore(sampleRate), new DeckCore(sampleRate)];
  }

  command(msg) {
    const d = this.decks[msg.deck];
    if (!d) return;
    if (msg.cmd === 'sync' && msg.on) {
      // Only one follower at a time: the other deck becomes the master.
      const other = this.decks[1 - msg.deck];
      if (other.syncOn) other.command({ cmd: 'sync', on: false });
    }
    d.command(msg);
  }

  /** Beat sync: make the follower match the master's tempo and beat phase. */
  syncStep() {
    for (let i = 0; i < 2; i++) {
      const d = this.decks[i];
      if (!d.syncOn) continue;
      const m = this.decks[1 - i];
      d.syncCorr = 0;
      if (!d.grid || !m.grid || !d.loaded || !m.loaded) {
        d.syncTempo = d.tempo;
        continue;
      }
      const sr = this.sr;
      const masterBpm = m.grid.bpmAt(m.pos, sr) * m.baseRate;
      const ownBpm = d.grid.bpmAt(d.pos, sr);
      let ratio = masterBpm / ownBpm;
      let mDiv = 1; // master beats per compared beat
      let dDiv = 1; // follower beats per compared beat
      if (ratio > 1.5) {
        ratio /= 2;
        mDiv = 2;
      } else if (ratio < 0.67) {
        ratio *= 2;
        dDiv = 2;
      }
      d.syncTempo = ratio;

      const running =
        d.playing && m.playing && !d.scratching && !m.scratching && !d.reverse && !m.reverse && d.gain > 0.99 && Math.abs(m.vel) > 0.2;
      if (!running) continue;
      const pm = m.grid.beatAt(m.pos) / mDiv;
      const pd = d.grid.beatAt(d.pos) / dDiv;
      let e = (pm - Math.floor(pm)) - (pd - Math.floor(pd));
      if (e >= 0.5) e -= 1;
      if (e < -0.5) e += 1;
      const errFrames = e * dDiv * d.grid.framesPerBeatAt(d.pos);
      if (Math.abs(errFrames) > 0.02 * sr) {
        d.jumpTo(clamp(d.pos + errFrames, 0, d.length));
      } else {
        d.syncCorr = clamp(errFrames / (0.3 * sr), -0.01, 0.01);
      }
    }
  }

  render(outputs, n) {
    this.syncStep();
    for (let i = 0; i < 2; i++) {
      const out = outputs[i];
      if (!out || out.length === 0) continue;
      const l = out[0];
      const r = out[1] || out[0];
      this.decks[i].render(l, r, n);
    }
  }
}

if (typeof registerProcessor === 'function') {
  class EngineProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.core = new EngineCore(sampleRate);
      this.blocks = 0;
      this.reportEvery = Math.max(1, Math.round(sampleRate / 128 / 90)); // ~90 reports per second
      this.ended = [false, false];
      this.port.onmessage = (e) => {
        const msg = e.data;
        this.core.command(msg);
        if (msg.cmd === 'load') this.port.postMessage({ type: 'loaded', deck: msg.deck, token: msg.token });
      };
    }

    process(inputs, outputs) {
      const n = outputs[0] && outputs[0][0] ? outputs[0][0].length : 128;
      this.core.render(outputs, n);
      if (++this.blocks >= this.reportEvery) {
        this.blocks = 0;
        const decks = this.core.decks;
        this.port.postMessage({
          type: 'state',
          time: currentTime + n / sampleRate,
          decks: [decks[0].snapshot(), decks[1].snapshot()],
        });
        for (let i = 0; i < 2; i++) {
          if (decks[i].ended && !this.ended[i]) this.port.postMessage({ type: 'ended', deck: i });
          this.ended[i] = decks[i].ended;
        }
      }
      return true;
    }
  }
  registerProcessor('tdj-engine', EngineProcessor);
}
