// Main-thread side of the audio engine: creates the AudioContext, the worklet
// that runs both decks, the built-in mixer and the output routing.
//
//   worklet out 0 (deck A) ─┐ trim → EQ → filter ┬→ fader → xfader ─┐
//   worklet out 1 (deck B) ─┘                    └→ cue (PFL) ──────┼→ phones
//                                                         master ←──┘
//
// Output routing modes
//   stereo  master on outputs 1/2 (built-in speakers / headphone jack)
//   split   mono master on the left, mono cue on the right (DJ splitter cable)
//   int4    master on 1/2, headphones on 3/4 (4-channel USB interface)
//   ext4    deck A on 1/2, deck B on 3/4, for an external DJ mixer: the tablet
//           behaves like two CDJs and the built-in mixer is bypassed

import { toInt16 } from '../decode/decode.js';

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.node = null;
    this.state = [null, null];
    this.stateTime = 0;
    this.lengths = [0, 0];
    this.routing = 'stereo';
    this._routeLinks = [];
    this._token = 0;
  }

  async start(latencyHint = 'interactive') {
    const AC = window.AudioContext || window.webkitAudioContext;
    // iOS: play even when the ring/silent switch is set to silent.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {
      /* not supported */
    }
    this.ctx = new AC({ latencyHint });
    this.ctx.resume(); // while we are still inside the user's tap (iOS)
    await this.ctx.audioWorklet.addModule(new URL('./engine-processor.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'tdj-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 2,
      outputChannelCount: [2, 2],
    });
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this._buildMixer();
    await this.ctx.resume();
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  get maxChannels() {
    return this.ctx ? this.ctx.destination.maxChannelCount : 2;
  }

  send(deck, cmd, data = {}, transfer = []) {
    if (this.node) this.node.port.postMessage({ deck, cmd, ...data }, transfer);
  }

  _onMessage(m) {
    if (m.type === 'state') {
      this.state = m.decks;
      this.stateTime = m.time;
    } else {
      this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
    }
  }

  /** Context time of the sample being heard right now (output latency included). */
  audibleTime() {
    const ctx = this.ctx;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /** Playhead (frames) of what you are hearing right now, extrapolated between worklet reports. */
  positionNow(deck) {
    const s = this.state[deck];
    if (!s || !this.ctx) return 0;
    const dt = Math.max(-0.5, Math.min(0.1, this.audibleTime() - this.stateTime));
    let p = s.pos + s.vel * dt * this.ctx.sampleRate;
    if (s.loopOn && s.vel > 0 && p >= s.loopOut && s.pos < s.loopOut) {
      p = s.loopIn + ((p - s.loopIn) % (s.loopOut - s.loopIn));
    }
    return Math.max(0, Math.min(this.lengths[deck] || p, p));
  }

  /** Hand decoded audio to a deck. `grid` is a BeatGrid in frames or null. */
  loadTrack(deck, decoded, grid, pos) {
    const left = toInt16(decoded.channels[0]);
    const right = decoded.channels[1] ? toInt16(decoded.channels[1]) : null;
    const token = ++this._token;
    this.lengths[deck] = left.length;
    const transfer = right ? [left.buffer, right.buffer] : [left.buffer];
    this.send(deck, 'load', { left, right, length: left.length, grid: gridMsg(grid), pos, token }, transfer);
    // Make the UI see the new track immediately, before the first worklet report.
    this.state[deck] = { ...(this.state[deck] || {}), pos, vel: 0, playing: false, loopOn: false, push: 0 };
    return token;
  }

  setGrid(deck, grid) {
    this.send(deck, 'grid', { grid: gridMsg(grid) });
  }

  // ------------------------------------------------------------ mixer

  _buildMixer() {
    const ctx = this.ctx;
    const biquad = (type, freq, q, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      f.gain.value = gain;
      return f;
    };
    this.masterBus = ctx.createGain();
    this.cueBus = ctx.createGain();
    this.ch = [0, 1].map((i) => {
      const trim = ctx.createGain();
      this.node.connect(trim, i, 0);
      const low = biquad('lowshelf', 220, 0.7);
      const mid = biquad('peaking', 1000, 0.7);
      const high = biquad('highshelf', 3800, 0.7);
      const lpf = biquad('lowpass', ctx.sampleRate / 2.05, 0.9);
      const hpf = biquad('highpass', 10, 0.9);
      const fader = ctx.createGain();
      const xf = ctx.createGain();
      const cue = ctx.createGain();
      cue.gain.value = 0;
      trim.connect(low).connect(mid).connect(high).connect(lpf).connect(hpf);
      hpf.connect(fader).connect(xf).connect(this.masterBus);
      hpf.connect(cue).connect(this.cueBus);
      return { trim, low, mid, high, lpf, hpf, fader, xf, cue };
    });

    this.masterVol = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterOut = ctx.createGain();
    this.masterBus.connect(this.masterVol).connect(this.limiter).connect(this.masterOut);

    this.phonesCue = ctx.createGain();
    this.phonesMaster = ctx.createGain();
    this.phones = ctx.createGain();
    this.cueBus.connect(this.phonesCue).connect(this.phones);
    this.masterOut.connect(this.phonesMaster).connect(this.phones);
    this.setCueMix(0.25);
    this.setCrossfader(0.5);
    this.setRouting('stereo');
  }

  /** @returns the mode actually used (falls back to stereo if the interface has < 4 outputs). */
  setRouting(mode) {
    const ctx = this.ctx;
    for (const [src, dst] of this._routeLinks) {
      try {
        src.disconnect(dst);
      } catch {
        /* already gone */
      }
    }
    this._routeLinks = [];
    const four = mode === 'int4' || mode === 'ext4';
    if (four && this.maxChannels < 4) mode = 'stereo';
    const dest = ctx.destination;
    const nch = four && mode !== 'stereo' ? 4 : 2;
    try {
      dest.channelCount = nch;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
    } catch {
      /* some browsers refuse; stereo still works */
    }
    const merger = ctx.createChannelMerger(nch);
    const link = (src, dst, out = 0, inp = 0) => {
      src.connect(dst, out, inp);
      this._routeLinks.push([src, dst]);
    };
    link(merger, dest);
    const stereoTo = (src, ch) => {
      const sp = ctx.createChannelSplitter(2);
      link(src, sp);
      link(sp, merger, 0, ch);
      link(sp, merger, 1, ch + 1);
    };
    const monoTo = (src, ch) => {
      const g = ctx.createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      g.channelInterpretation = 'speakers';
      link(src, g);
      link(g, merger, 0, ch);
    };
    if (mode === 'split') {
      monoTo(this.masterOut, 0);
      monoTo(this.phones, 1);
    } else if (mode === 'int4') {
      stereoTo(this.masterOut, 0);
      stereoTo(this.phones, 2);
    } else if (mode === 'ext4') {
      stereoTo(this.ch[0].trim, 0);
      stereoTo(this.ch[1].trim, 2);
    } else {
      mode = 'stereo';
      stereoTo(this.masterOut, 0);
    }
    this.routing = mode;
    return mode;
  }

  _set(param, value) {
    param.setTargetAtTime(value, this.ctx.currentTime, 0.008);
  }

  /** EQ knob 0..1 (0.5 = flat, 0 = kill, 1 = +6 dB). band: 'low' | 'mid' | 'high' */
  setEq(deck, band, k) {
    const db = k >= 0.5 ? (k - 0.5) * 12 : Math.max(-40, 40 * Math.log10(Math.max(1e-3, k / 0.5)));
    this._set(this.ch[deck][band].gain, db);
  }

  /** Filter knob -1..1: left = low-pass sweep, right = high-pass sweep, centre = off. */
  setFilter(deck, f) {
    const c = this.ch[deck];
    const nyq = this.ctx.sampleRate / 2.05;
    const lp = f < -0.02 ? 20000 * Math.pow(70 / 20000, -f) : nyq;
    const hp = f > 0.02 ? 20 * Math.pow(9000 / 20, f) : 10;
    this._set(c.lpf.frequency, Math.min(nyq, lp));
    this._set(c.hpf.frequency, hp);
  }

  setTrim(deck, k) {
    this._set(this.ch[deck].trim.gain, k);
  }

  setFader(deck, v) {
    this._set(this.ch[deck].fader.gain, v * v);
  }

  /** Crossfader 0 (A) .. 1 (B): both full in the middle, constant power towards the ends. */
  setCrossfader(x) {
    const a = x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI);
    const b = x >= 0.5 ? 1 : Math.cos((0.5 - x) * Math.PI);
    this._set(this.ch[0].xf.gain, a);
    this._set(this.ch[1].xf.gain, b);
  }

  setCue(deck, on) {
    this._set(this.ch[deck].cue.gain, on ? 1 : 0);
  }

  setMaster(v) {
    this._set(this.masterVol.gain, v * v);
  }

  /** Headphone mix 0 = cue only, 1 = master only. */
  setCueMix(x) {
    this._set(this.phonesCue.gain, Math.cos((x * Math.PI) / 2));
    this._set(this.phonesMaster.gain, Math.sin((x * Math.PI) / 2));
  }
}

function gridMsg(grid) {
  return grid ? { frames: grid.frames, firstBeatInBar: grid.firstBeatInBar } : null;
}
