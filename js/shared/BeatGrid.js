// BeatGrid: where every beat of a track sits, in sample frames.
//
// Used on the main thread (drawing grid lines, quantizing cues and loops) and
// inside the audio worklet (sync, quantized jumps), so it must stay free of
// any DOM or Web Audio dependencies.
//
// A grid is stored as a plain list of beat positions so that tracks with
// tempo changes (rekordbox "dynamic" grids) work the same as constant ones.
// Before the first and after the last beat the grid is extrapolated using the
// nearest beat interval.

export class BeatGrid {
  /**
   * @param {ArrayLike<number>} frames  frame position of each beat, ascending
   * @param {number} firstBeatInBar     bar position (1..beatsPerBar) of beat 0
   * @param {number} beatsPerBar
   */
  constructor(frames, firstBeatInBar = 1, beatsPerBar = 4) {
    this.frames = Float64Array.from(frames);
    this.firstBeatInBar = firstBeatInBar;
    this.beatsPerBar = beatsPerBar;
    this._hint = 0; // last search index; playback moves slowly so this is usually right
  }

  /** Build a constant-tempo grid covering [0, totalFrames]. */
  static constant(bpm, firstBeatFrame, sampleRate, totalFrames, firstBeatInBar = 1) {
    const spb = (60 * sampleRate) / bpm;
    // Index (relative to the anchor beat) of the first beat at or after frame 0.
    const k0 = Math.ceil(-firstBeatFrame / spb - 1e-9);
    const k1 = Math.floor((totalFrames - firstBeatFrame) / spb) + 1;
    const count = Math.max(2, k1 - k0 + 1);
    const frames = new Float64Array(count);
    for (let i = 0; i < count; i++) frames[i] = firstBeatFrame + (k0 + i) * spb;
    const bar = mod(firstBeatInBar - 1 + k0, 4) + 1;
    return new BeatGrid(frames, bar);
  }

  /**
   * Build a grid from a stored, sample-rate independent spec (see library):
   *   { type: 'beats', times: [sec...], firstBeatInBar }
   *   { type: 'constant', bpm, first: sec, firstBeatInBar }
   */
  static fromSpec(spec, sampleRate, totalFrames) {
    if (!spec) return null;
    if (spec.type === 'constant' && spec.bpm > 0) {
      return BeatGrid.constant(spec.bpm, spec.first * sampleRate, sampleRate, totalFrames, spec.firstBeatInBar || 1);
    }
    if (spec.type === 'beats' && spec.times && spec.times.length >= 2) {
      const f = new Float64Array(spec.times.length);
      for (let i = 0; i < f.length; i++) f[i] = spec.times[i] * sampleRate;
      return new BeatGrid(f, spec.firstBeatInBar || 1);
    }
    return null;
  }

  get count() {
    return this.frames.length;
  }

  /** Index i such that frames[i] <= frame < frames[i+1], clamped to [0, n-2]. */
  _segment(frame) {
    const f = this.frames;
    const n = f.length;
    let i = this._hint;
    if (i > n - 2) i = n - 2;
    if (f[i] <= frame && frame < f[i + 1]) return i;
    if (i + 2 < n && f[i + 1] <= frame && frame < f[i + 2]) return (this._hint = i + 1);
    let lo = 0;
    let hi = n - 2;
    if (frame < f[0]) return (this._hint = 0);
    if (frame >= f[n - 1]) return (this._hint = n - 2);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid] <= frame) lo = mid;
      else hi = mid - 1;
    }
    return (this._hint = lo);
  }

  /** Fractional beat index at a frame position (beat 0 = frames[0]). */
  beatAt(frame) {
    const f = this.frames;
    const n = f.length;
    if (frame < f[0]) return (frame - f[0]) / (f[1] - f[0]);
    if (frame >= f[n - 1]) return n - 1 + (frame - f[n - 1]) / (f[n - 1] - f[n - 2]);
    const i = this._segment(frame);
    return i + (frame - f[i]) / (f[i + 1] - f[i]);
  }

  /** Frame position of a (fractional) beat index. */
  frameAt(beat) {
    const f = this.frames;
    const n = f.length;
    if (beat <= 0) return f[0] + beat * (f[1] - f[0]);
    if (beat >= n - 1) return f[n - 1] + (beat - (n - 1)) * (f[n - 1] - f[n - 2]);
    const i = Math.floor(beat);
    return f[i] + (beat - i) * (f[i + 1] - f[i]);
  }

  framesPerBeatAt(frame) {
    const i = this._segment(frame);
    return this.frames[i + 1] - this.frames[i];
  }

  bpmAt(frame, sampleRate) {
    return (60 * sampleRate) / this.framesPerBeatAt(frame);
  }

  /** Bar position 1..beatsPerBar of an integer beat index. */
  barBeat(beatIndex) {
    return mod(this.firstBeatInBar - 1 + Math.floor(beatIndex), this.beatsPerBar) + 1;
  }

  nearestBeatFrame(frame) {
    return this.frameAt(Math.round(this.beatAt(frame)));
  }

  /** Copy of this grid with every beat moved by `delta` frames. */
  shifted(delta) {
    const f = new Float64Array(this.frames.length);
    for (let i = 0; i < f.length; i++) f[i] = this.frames[i] + delta;
    return new BeatGrid(f, this.firstBeatInBar, this.beatsPerBar);
  }

  /** Copy of this grid where integer beat `beatIndex` becomes the downbeat (bar position 1). */
  withDownbeat(beatIndex) {
    const bar = mod(-Math.round(beatIndex), this.beatsPerBar) + 1;
    return new BeatGrid(this.frames, bar, this.beatsPerBar);
  }

  /** Double (factor 2) or halve (factor 0.5) the tempo of the grid. */
  scaledTempo(factor) {
    const f = this.frames;
    if (factor === 2) {
      const out = new Float64Array(f.length * 2 - 1);
      for (let i = 0; i < f.length - 1; i++) {
        out[2 * i] = f[i];
        out[2 * i + 1] = (f[i] + f[i + 1]) / 2;
      }
      out[out.length - 1] = f[f.length - 1];
      return new BeatGrid(out, 1, this.beatsPerBar);
    }
    if (factor === 0.5 && f.length >= 4) {
      const out = new Float64Array(Math.ceil(f.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = f[2 * i];
      return new BeatGrid(out, 1, this.beatsPerBar);
    }
    return this;
  }

  /** Sample-rate independent representation for storage. */
  toSpec(sampleRate) {
    const times = new Array(this.frames.length);
    for (let i = 0; i < times.length; i++) times[i] = this.frames[i] / sampleRate;
    return { type: 'beats', times, firstBeatInBar: this.firstBeatInBar };
  }
}

export function mod(a, n) {
  return ((a % n) + n) % n;
}
