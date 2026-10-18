// Deck: the "CDJ" as seen from the UI. Holds the loaded track, its beat grid,
// cue points and loops, and turns button presses into engine commands.
// Sample-accurate work (the playhead itself) happens in the audio worklet;
// this class decides *what* should happen, CDJ-style.

import { BeatGrid } from './shared/BeatGrid.js';
import { decodeAudio } from './decode/decode.js';

export const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64];
export const TEMPO_RANGES = [0.06, 0.1, 0.16, 1.0];
export const HOT_COLORS = ['#ff3b5c', '#ff9f0a', '#ffd60a', '#30d158', '#40c8e0', '#0a84ff', '#5e5ce6', '#bf5af2'];
const ANALYSIS_VERSION = 1;

let cueIds = 0;

export class Deck extends EventTarget {
  constructor(index, { engine, library, analyzer, settings }) {
    super();
    this.i = index;
    this.engine = engine;
    this.library = library;
    this.analyzer = analyzer;
    this.settings = settings;
    this.track = null;
    this.length = 0;
    this.grid = null;
    this.wave = null;
    this.firstSound = 0;
    this.offset = 0; // seconds added to stored cue/grid times (rekordbox decoder offset)
    this.cuePoint = 0;
    this.loopSize = 4;
    this.pendingLoopIn = null;
    this.lastLoop = null;
    this.range = settings.get('tempoRange')[index] || 0.1;
    this.tempoFader = 0;
    this.keyLock = !!settings.get('keyLock')[index];
    this.slip = false;
    this.sync = false;
    this.reverse = false;
    this.shift = false;
    this.cuePreviewing = false;
    this.cueLatched = false;
    this.loading = false;
    this.status = '';
    this.error = '';
  }

  // ------------------------------------------------------------ state

  get sr() {
    return this.engine.sampleRate;
  }
  get state() {
    return this.engine.state[this.i] || {};
  }
  get loaded() {
    return !!this.track && this.length > 0;
  }
  get playing() {
    return !!this.state.playing;
  }
  /** Audible playhead, in frames. */
  get pos() {
    return this.engine.positionNow(this.i);
  }
  /** Current speed ratio from the tempo fader or sync (1 = original tempo). */
  get rate() {
    const r = this.state.rate;
    return typeof r === 'number' ? r : 1 + this.tempoFader * this.range;
  }
  get pitchPercent() {
    return (this.rate - 1) * 100;
  }
  /** BPM as currently playing. */
  get bpm() {
    if (!this.loaded) return null;
    if (this.grid) return this.grid.bpmAt(this.pos, this.sr) * this.rate;
    return this.track.bpm ? this.track.bpm * this.rate : null;
  }
  get quantize() {
    return !!this.settings.get('quantize');
  }
  get hotCues() {
    const out = new Array(8).fill(null);
    if (this.track) for (const c of this.track.cues || []) if (c.kind === 'hot' && c.slot >= 0 && c.slot < 8) out[c.slot] = c;
    return out;
  }
  get memoryCues() {
    if (!this.track) return [];
    return (this.track.cues || []).filter((c) => c.kind === 'memory').sort((a, b) => a.time - b.time);
  }

  cueFrame(c) {
    return (c.time + this.offset) * this.sr;
  }
  cueEndFrame(c) {
    return (c.end + this.offset) * this.sr;
  }
  /** Stored (rekordbox time base) seconds for a frame position. */
  storeTime(frame) {
    return Math.round((frame / this.sr - this.offset) * 1000) / 1000;
  }
  framesPerBeat(p = this.pos) {
    if (this.grid) return this.grid.framesPerBeatAt(p);
    const bpm = (this.track && this.track.bpm) || 120;
    return (60 * this.sr) / bpm;
  }
  snap(p) {
    return this.quantize && this.grid ? Math.max(0, this.grid.nearestBeatFrame(p)) : p;
  }

  send(cmd, data) {
    this.engine.send(this.i, cmd, data);
  }

  changed(what = 'change') {
    this.dispatchEvent(new Event(what));
    if (what !== 'change') this.dispatchEvent(new Event('change'));
  }

  // ------------------------------------------------------------ loading

  async load(track) {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.status = 'Loading…';
    this.changed();
    try {
      const blob = await this.library.getAudio(track.id);
      if (!blob) throw new Error('The audio for this track is not on this device yet. Open the library and add the file (or the USB folder).');
      const decoded = await decodeAudio(blob, this.engine.ctx, (s) => {
        this.status = s;
        this.changed();
      });
      const sr = this.sr;
      this.track = track;
      this.decoder = decoded.decoder;
      this.length = decoded.length;
      this.wave = null;
      this.firstSound = 0;
      this.pendingLoopIn = null;
      this.lastLoop = null;
      this.cuePreviewing = false;
      this.offset = track.source && track.source.startsWith('rekordbox') ? (this.settings.get('rbOffsetMs') || 0) / 1000 : 0;
      const seconds = decoded.length / sr;
      if (!track.duration || Math.abs(track.duration - seconds) > 1) this.library.update(track.id, { duration: Math.round(seconds) });

      this.grid = track.grid ? BeatGrid.fromSpec(track.grid, sr, decoded.length) : null;
      if (this.grid && this.offset) this.grid = this.grid.shifted(this.offset * sr);
      const mem = this.memoryCues;
      this.cuePoint = mem.length ? Math.max(0, this.cueFrame(mem[0])) : 0;
      this.engine.loadTrack(this.i, decoded, this.grid, this.cuePoint);
      this.status = 'Analysing…';
      this.loading = false;
      this.changed('loaded');
      await this._analyze(track, decoded);
    } catch (e) {
      console.error(e);
      this.error = e.message || String(e);
      this.loading = false;
    }
    this.status = '';
    this.changed();
  }

  async _analyze(track, decoded) {
    let a = await this.library.getAnalysis(track.id).catch(() => null);
    if (!a || a.version !== ANALYSIS_VERSION) {
      a = await this.analyzer.analyze(decoded, {
        wantTempo: true,
        minBpm: this.settings.get('minBpm'),
        maxBpm: this.settings.get('maxBpm'),
      });
      a.version = ANALYSIS_VERSION;
      this.library.saveAnalysis(track.id, a).catch((e) => console.warn('could not cache analysis', e));
    }
    if (this.track !== track) return; // another track was loaded meanwhile
    this.wave = a.wave;
    this.firstSound = a.firstSound || 0;
    const sr = this.sr;
    if (!this.grid && a.tempo) {
      const spec = { type: 'constant', bpm: a.tempo.bpm, first: a.tempo.first, firstBeatInBar: 1 };
      this.grid = BeatGrid.fromSpec(spec, sr, this.length);
      this.engine.setGrid(this.i, this.grid);
      const patch = { grid: spec, gridSource: 'detected' };
      if (!track.bpm) patch.bpm = Math.round(a.tempo.bpm * 100) / 100;
      this.library.update(track.id, patch);
    }
    // Auto cue to the first sound when nothing else placed the cue point.
    if (!this.memoryCues.length && !this.playing && this.cuePoint === 0 && this.pos < 1) {
      let c = this.firstSound * sr;
      if (this.grid) {
        const nb = this.grid.nearestBeatFrame(c);
        if (nb >= 0 && Math.abs(nb - c) < 0.15 * sr) c = nb;
      }
      this.cuePoint = Math.max(0, c);
      this.send('seek', { pos: this.cuePoint });
    }
  }

  eject() {
    if (this.playing) return;
    this.send('unload');
    this.track = null;
    this.length = 0;
    this.grid = null;
    this.wave = null;
    this.engine.lengths[this.i] = 0;
    this.changed('loaded');
  }

  // ------------------------------------------------------------ transport

  playPause() {
    if (!this.loaded) return;
    if (this.cuePreviewing) {
      this.cueLatched = true; // PLAY while holding CUE: keep playing after release
      return;
    }
    this.send(this.playing ? 'pause' : 'play');
  }

  cueDown() {
    if (!this.loaded) return;
    if (this.playing && !this.cuePreviewing) {
      this.send('cueStop', { pos: this.cuePoint }); // back cue
      return;
    }
    const p = this.pos;
    if (Math.abs(p - this.cuePoint) < 0.01 * this.sr) {
      this.cuePreviewing = true;
      this.cueLatched = false;
      this.send('play');
    } else {
      this.cuePoint = this.snap(p);
      if (Math.abs(this.cuePoint - p) > 0.5) this.send('seek', { pos: this.cuePoint });
    }
    this.changed();
  }

  cueUp() {
    if (!this.cuePreviewing) return;
    this.cuePreviewing = false;
    if (!this.cueLatched) this.send('cueStop', { pos: this.cuePoint });
    this.changed();
  }

  seek(frame) {
    if (!this.loaded) return;
    this.send('seek', { pos: Math.max(0, Math.min(this.length, frame)) });
  }

  // ------------------------------------------------------------ cues

  async _saveCues(cues) {
    this.track.cues = cues;
    await this.library.update(this.track.id, { cues });
    this.changed();
  }

  hotCue(slot) {
    if (!this.loaded) return;
    const c = this.hotCues[slot];
    if (this.shift) {
      this.shift = false;
      if (c) this._saveCues(this.track.cues.filter((x) => x !== c));
      else this.changed();
      return;
    }
    if (!c) {
      const st = this.state;
      const cue = { id: `c${Date.now()}${cueIds++}`, kind: 'hot', slot, name: '', color: HOT_COLORS[slot] };
      if (st.loopOn) {
        cue.time = this.storeTime(st.loopIn);
        cue.end = this.storeTime(st.loopOut);
      } else {
        cue.time = this.storeTime(this.snap(this.pos));
      }
      this._saveCues([...(this.track.cues || []), cue]);
      return;
    }
    const start = this.cueFrame(c);
    if (c.end) {
      const out = this.cueEndFrame(c);
      this.send('loop', { in: start, out, jump: true });
      this.lastLoop = { in: start, out };
    } else {
      this.send('jump', { pos: start, quantize: this.quantize });
    }
    if (!this.playing) this.send('play');
  }

  /** MEMORY: store the cue point (or the active loop) as a memory cue. SHIFT+MEMORY deletes. */
  memory() {
    if (!this.loaded) return;
    const near = this.memoryCues.find((c) => Math.abs(this.cueFrame(c) - this.cuePoint) < 0.02 * this.sr);
    if (this.shift) {
      this.shift = false;
      if (near) this._saveCues(this.track.cues.filter((x) => x !== near));
      else this.changed();
      return;
    }
    const st = this.state;
    const cue = { id: `c${Date.now()}${cueIds++}`, kind: 'memory', name: '', color: null };
    if (st.loopOn) {
      cue.time = this.storeTime(st.loopIn);
      cue.end = this.storeTime(st.loopOut);
    } else {
      if (near) return;
      cue.time = this.storeTime(this.cuePoint);
    }
    this._saveCues([...(this.track.cues || []), cue]);
  }

  /** CALL ◀ / ▶: move the cue point to the previous / next memory cue. */
  call(dir) {
    if (!this.loaded) return;
    const p = this.pos;
    const list = this.memoryCues;
    const margin = 0.05 * this.sr;
    const c = dir < 0 ? list.filter((m) => this.cueFrame(m) < p - margin).pop() : list.find((m) => this.cueFrame(m) > p + margin);
    if (!c) return;
    this.cuePoint = this.cueFrame(c);
    if (c.end) this.lastLoop = { in: this.cuePoint, out: this.cueEndFrame(c) };
    if (this.playing) this.send('jump', { pos: this.cuePoint, quantize: this.quantize });
    else this.send('seek', { pos: this.cuePoint });
    this.changed();
  }

  // ------------------------------------------------------------ loops

  loopIn() {
    if (!this.loaded || this.state.loopOn) return;
    this.pendingLoopIn = this.snap(this.pos);
    this.changed();
  }

  loopOut() {
    if (!this.loaded) return;
    if (this.state.loopOn) {
      this.send('loopExit');
      return;
    }
    const inP = this.pendingLoopIn !== null ? this.pendingLoopIn : this.lastLoop && this.lastLoop.in;
    if (inP === null || inP === undefined) return;
    const out = this.snap(this.pos);
    if (out <= inP + 0.01 * this.sr) return;
    this.send('loop', { in: inP, out });
    this.lastLoop = { in: inP, out };
    this.pendingLoopIn = null;
    this.changed();
  }

  /** Beat loop of the current size, starting on the beat we're in (quantized). */
  autoLoop() {
    if (!this.loaded) return;
    if (this.state.loopOn) {
      this.send('loopExit');
      return;
    }
    const p = this.pos;
    const size = this.loopSize;
    let a;
    let b;
    if (this.grid && this.quantize) {
      const beat = this.grid.beatAt(p);
      const start = size >= 1 ? Math.floor(beat) : Math.floor(beat / size) * size;
      a = this.grid.frameAt(start);
      b = this.grid.frameAt(start + size);
    } else {
      a = p;
      b = p + size * this.framesPerBeat(p);
    }
    this.send('loop', { in: a, out: b });
    this.lastLoop = { in: a, out: b };
    this.pendingLoopIn = null;
    this.changed();
  }

  reloopExit() {
    if (!this.loaded) return;
    if (this.state.loopOn) this.send('loopExit');
    else if (this.lastLoop) this.send('loop', { ...this.lastLoop, jump: true });
  }

  resizeLoop(factor) {
    const idx = LOOP_SIZES.indexOf(this.loopSize);
    const next = LOOP_SIZES[Math.max(0, Math.min(LOOP_SIZES.length - 1, idx + (factor > 1 ? 1 : -1)))];
    if (next === this.loopSize) return;
    const st = this.state;
    if (this.loaded && st.loopOn) {
      const ratio = next / this.loopSize;
      const out = this.grid ? this.grid.frameAt(this.grid.beatAt(st.loopIn) + (this.grid.beatAt(st.loopOut) - this.grid.beatAt(st.loopIn)) * ratio) : st.loopIn + (st.loopOut - st.loopIn) * ratio;
      this.send('loopResize', { out });
      this.lastLoop = { in: st.loopIn, out };
    }
    this.loopSize = next;
    this.changed();
  }

  beatJump(dir) {
    if (this.loaded) this.send('beatJump', { beats: dir * this.loopSize });
  }

  // ------------------------------------------------------------ tempo & modes

  setFader(t) {
    if (this.sync) return; // locked to the master while synced (like a CDJ)
    this.tempoFader = Math.max(-1, Math.min(1, t));
    this.send('tempo', { value: 1 + this.tempoFader * this.range });
    this.changed();
  }

  cycleRange() {
    const rate = this.rate;
    const idx = TEMPO_RANGES.indexOf(this.range);
    this.range = TEMPO_RANGES[(idx + 1) % TEMPO_RANGES.length];
    this.tempoFader = Math.max(-1, Math.min(1, (rate - 1) / this.range));
    if (!this.sync) this.send('tempo', { value: 1 + this.tempoFader * this.range });
    const r = this.settings.get('tempoRange').slice();
    r[this.i] = this.range;
    this.settings.set('tempoRange', r);
    this.changed();
  }

  setSync(on) {
    if (on === this.sync) return;
    if (!on) {
      // Keep the synced tempo and move the fader there (widening the range if needed).
      const rate = this.rate;
      while (Math.abs(rate - 1) > this.range && this.range < 1) this.range = TEMPO_RANGES[TEMPO_RANGES.indexOf(this.range) + 1];
      this.tempoFader = Math.max(-1, Math.min(1, (rate - 1) / this.range));
    }
    this.sync = on;
    this.send('sync', { on });
    this.changed();
  }

  setKeyLock(on) {
    this.keyLock = on;
    this.send('keyLock', { on });
    const k = this.settings.get('keyLock').slice();
    k[this.i] = on;
    this.settings.set('keyLock', k);
    this.changed();
  }

  setSlip(on) {
    this.slip = on;
    this.send('slip', { on });
    this.changed();
  }

  setReverse(on) {
    this.reverse = on;
    this.send('reverse', { on });
    this.changed();
  }

  applyVinyl() {
    const v = this.settings.get('vinyl');
    const vinyl = Array.isArray(v) ? !!v[this.i] : !!v;
    this.send('vinyl', { brake: vinyl ? this.settings.get('brakeTime') : 0, start: vinyl ? this.settings.get('startTime') : 0 });
  }

  /** Re-send everything the worklet should know (after start-up). */
  syncEngine() {
    this.send('tempo', { value: 1 + this.tempoFader * this.range });
    this.send('keyLock', { on: this.keyLock });
    this.applyVinyl();
  }

  // ------------------------------------------------------------ grid editing

  async _saveGrid(source = 'user') {
    if (!this.grid || !this.track) return;
    this.engine.setGrid(this.i, this.grid);
    const g = this.offset ? this.grid.shifted(-this.offset * this.sr) : this.grid;
    const bpm = Math.round(this.grid.bpmAt(this.pos, this.sr) * 100) / 100;
    await this.library.update(this.track.id, { grid: g.toSpec(this.sr), gridSource: source, bpm });
    this.changed();
  }

  /** Make the beat nearest the playhead the "1" of the bar. */
  setDownbeatHere() {
    if (!this.grid) return;
    this.grid = this.grid.withDownbeat(Math.round(this.grid.beatAt(this.pos)));
    this._saveGrid();
  }

  /** Move the whole grid so a beat sits exactly at the playhead. */
  gridToPlayhead() {
    if (!this.grid) return;
    const p = this.pos;
    this.grid = this.grid.shifted(p - this.grid.nearestBeatFrame(p));
    this._saveGrid();
  }

  shiftGrid(ms) {
    if (!this.grid) return;
    this.grid = this.grid.shifted((ms / 1000) * this.sr);
    this._saveGrid();
  }

  scaleGrid(factor) {
    if (!this.grid) return;
    this.grid = this.grid.scaledTempo(factor);
    this._saveGrid();
  }

  /** Build a constant grid from a typed-in BPM, anchored on the beat nearest the playhead. */
  setBpm(bpm) {
    if (!this.loaded || !(bpm > 20 && bpm < 400)) return;
    const anchor = this.grid ? this.grid.nearestBeatFrame(this.pos) : this.pos;
    this.grid = BeatGrid.constant(bpm, anchor, this.sr, this.length);
    this._saveGrid();
  }
}
