// TimeStretch: "master tempo" / key lock.
//
// A WSOLA (waveform similarity overlap-add) time stretcher in the spirit of
// SoundTouch. Because a deck keeps the whole track in memory we can read the
// source at any position, which keeps this much simpler than a streaming
// stretcher:
//
//   * The deck owns the playhead and moves it at the current speed.
//   * Whenever this stretcher runs out of output it cuts a new segment of
//     source audio starting near the playhead, at normal (unchanged) pitch.
//   * The start of the segment is nudged by up to +-W samples so that it lines
//     up with the audio the previous segment would have continued with, and
//     the two are cross-faded over O samples.
//
// Playing segments faster or slower than the playhead moves changes the tempo
// while the pitch stays put.

const I16 = 1 / 32768;

export class TimeStretch {
  constructor(sampleRate) {
    this.S = Math.round(0.06 * sampleRate); // segment length
    this.O = Math.round(0.01 * sampleRate); // cross-fade length
    this.W = Math.round(0.015 * sampleRate); // search radius
    const segOut = this.S - this.O; // samples produced per segment
    this.outL = new Float32Array(segOut);
    this.outR = new Float32Array(segOut);
    this.tailL = new Float32Array(this.O);
    this.tailR = new Float32Array(this.O);
    this.spareL = new Float32Array(this.O); // swapped with tail* on jumps (no allocation on the audio thread)
    this.spareR = new Float32Array(this.O);
    this.read = 0;
    this.avail = 0;
    this.hasTail = false;
    this.search = false;
    this.l = 0; // last pulled sample
    this.r = 0;
  }

  /** Forget everything; the next segment starts cleanly at the playhead. */
  reset() {
    this.read = 0;
    this.avail = 0;
    this.hasTail = false;
    this.search = false;
  }

  /**
   * The playhead jumped (loop, hot cue...). The audio that would have played
   * next becomes the fade-out for the first segment at the new position.
   */
  jump() {
    if (!this.hasTail) {
      this.reset();
      return;
    }
    const O = this.O;
    const rem = this.avail - this.read;
    const tl = this.spareL;
    const tr = this.spareR;
    let k = 0;
    for (; k < O && k < rem; k++) {
      tl[k] = this.outL[this.read + k];
      tr[k] = this.outR[this.read + k];
    }
    for (let j = 0; k < O; k++, j++) {
      tl[k] = this.tailL[j];
      tr[k] = this.tailR[j];
    }
    this.spareL = this.tailL;
    this.spareR = this.tailR;
    this.tailL = tl;
    this.tailR = tr;
    this.read = 0;
    this.avail = 0;
    this.search = false; // land exactly on the jump target
  }

  /** Produce one output sample into this.l / this.r. */
  pull(deck) {
    if (this.read >= this.avail) this._segment(deck);
    const i = this.read++;
    this.l = this.outL[i];
    this.r = this.outR[i];
  }

  _segment(deck) {
    const { S, O } = this;
    const L = deck.L;
    const R = deck.R;
    const n = deck.length;
    let c = Math.round(deck.pos);
    if (this.hasTail && this.search) c = this._bestMatch(deck, c);

    const outL = this.outL;
    const outR = this.outR;
    const fast = c >= 0 && c + S < n;
    for (let k = 0; k < S - O; k++) {
      const i = c + k;
      let sl = 0;
      let sr = 0;
      if (fast || (i >= 0 && i < n)) {
        sl = L[i] * I16;
        sr = R[i] * I16;
      }
      if (k < O && this.hasTail) {
        const w = (k + 0.5) / O;
        sl = this.tailL[k] * (1 - w) + sl * w;
        sr = this.tailR[k] * (1 - w) + sr * w;
      }
      outL[k] = sl;
      outR[k] = sr;
    }
    // Remember what this segment would continue with; the next segment fades from it.
    for (let k = 0; k < O; k++) {
      const i = c + S - O + k;
      const ok = fast || (i >= 0 && i < n);
      this.tailL[k] = ok ? L[i] * I16 : 0;
      this.tailR[k] = ok ? R[i] * I16 : 0;
    }
    this.hasTail = true;
    this.search = true;
    this.read = 0;
    this.avail = S - O;
  }

  /** Find the start near `c` whose first O samples best match the stored tail. */
  _bestMatch(deck, c) {
    const { O, W } = this;
    const L = deck.L;
    const R = deck.R;
    const n = deck.length;
    if (c - W < 0 || c + W + O >= n) return c;
    const tl = this.tailL;
    const tr = this.tailR;

    const score = (d, step) => {
      let xy = 0;
      let yy = 1e-9;
      const base = c + d;
      for (let k = 0; k < O; k += step) {
        const y = (L[base + k] + R[base + k]) * I16;
        xy += (tl[k] + tr[k]) * y;
        yy += y * y;
      }
      const s = xy / Math.sqrt(yy);
      const t = d / W;
      return s * (1 - 0.25 * t * t); // gently prefer staying near the playhead
    };

    let best = 0;
    let bestScore = -Infinity;
    for (let d = -W; d <= W; d += 4) {
      const s = score(d, 4);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let d = Math.max(-W, coarse - 3); d <= Math.min(W, coarse + 3); d++) {
      const s = score(d, 2);
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }
    return c + best;
  }
}
