// DeckCore: everything one "CDJ" does to make sound.
//
// Lives inside the AudioWorklet (see engine-processor.js) but has no Web Audio
// dependencies, so the unit tests can drive it directly.
//
// Model
//   pos      playhead, in source frames (fractional). Tracks are decoded at the
//            AudioContext sample rate, so a speed of 1.0 is normal playback.
//   motor    the transport speed: where the "platter" wants to go (tempo fader,
//            start/stop ramps). Corrections such as bend, phase push and sync
//            are added on top of it.
//   vel      the speed actually used for the current sample.
//
// While the Tape (the touch jog replacement) is held, the playhead instead
// follows the finger through a critically damped spring, which turns jittery
// touch events into smooth vinyl-like motion.

import { BeatGrid } from '../../shared/BeatGrid.js';
import { TimeStretch } from './TimeStretch.js';

const I16 = 1 / 32768;
const JUMP_FADE = 256; // cross-fade length for jumps (loops, hot cues), ~5 ms

export class DeckCore {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.L = null;
    this.R = null;
    this.length = 0;
    this.grid = null;

    // Settings that survive loading a new track (like the knobs on a CDJ).
    this.tempo = 1;
    this.keyLock = false;
    this.reverse = false;
    this.brakeTime = 0; // seconds, 0 = instant CDJ stop
    this.startTime = 0; // seconds, 0 = instant CDJ start
    this.slipEnabled = false;
    this.syncOn = false;

    this.stretch = new TimeStretch(sampleRate);
    this.scratchW = (2 * Math.PI * 18) / sampleRate; // follower stiffness (~18 Hz)
    this.maxExtrap = Math.round(0.03 * sampleRate); // predict the finger for at most 30 ms
    this.declickStep = 1 / (0.003 * sampleRate);
    this.pathStep = 1 / (0.005 * sampleRate);
    this.dcR = 1 - (2 * Math.PI * 8) / sampleRate; // DC blocker so a stopped record is silent

    this.resetTransport();
  }

  resetTransport() {
    this.pos = 0;
    this.vel = 0;
    this.motor = 0;
    this.playing = false;
    this.instantStop = false;
    this.gain = 0;
    this.bend = 0;
    this.bendNow = 0;
    this.push = 0;
    this.scratching = false;
    this.sTarget = 0;
    this.sVel = 0;
    this.sAge = 0;
    this.loopOn = false;
    this.loopIn = 0;
    this.loopOut = 0;
    this.slipping = false;
    this.slipPos = 0;
    this.syncTempo = this.tempo;
    this.syncCorr = 0;
    this.fadeLeft = 0;
    this.fadePos = 0;
    this.pathMix = 0;
    this.dcxL = this.dcxR = this.dcyL = this.dcyR = 0;
    this.ended = false;
    if (this.stretch) this.stretch.reset();
  }

  /** Transport speed before bend/push/sync corrections (tempo fader or sync). */
  get baseRate() {
    return this.syncOn ? this.syncTempo : this.tempo;
  }

  get loaded() {
    return this.L !== null;
  }

  // ---------------------------------------------------------------- commands

  command(msg) {
    switch (msg.cmd) {
      case 'load':
        this.L = msg.left;
        this.R = msg.right || msg.left;
        this.length = msg.length;
        this.grid = msg.grid ? new BeatGrid(msg.grid.frames, msg.grid.firstBeatInBar) : null;
        this.resetTransport();
        this.pos = clamp(msg.pos || 0, 0, this.length);
        break;
      case 'unload':
        this.L = this.R = null;
        this.length = 0;
        this.grid = null;
        this.resetTransport();
        break;
      case 'grid':
        this.grid = msg.grid ? new BeatGrid(msg.grid.frames, msg.grid.firstBeatInBar) : null;
        break;
      case 'play':
        if (!this.loaded) break;
        if (this.pos >= this.length) break;
        this.playing = true;
        this.instantStop = false;
        this.ended = false;
        break;
      case 'pause':
        this.playing = false;
        this.instantStop = !!msg.instant;
        break;
      case 'seek':
        this.jumpTo(clamp(msg.pos, 0, this.length));
        this.ended = false;
        break;
      case 'cueStop': // CDJ "back cue": jump to the cue point and stop dead
        this.jumpTo(clamp(msg.pos, 0, this.length));
        this.playing = false;
        this.instantStop = true;
        this.slipping = false;
        break;
      case 'jump': {
        let target = msg.pos;
        if (msg.quantize && this.grid && this.playing) target = this.phaseMatchedTarget(target);
        this.jumpTo(clamp(target, 0, this.length));
        this.ended = false;
        break;
      }
      case 'beatJump': {
        const target = this.grid
          ? this.grid.frameAt(this.grid.beatAt(this.pos) + msg.beats)
          : this.pos + msg.beats * ((60 * this.sr) / 120);
        const delta = target - this.pos;
        if (this.loopOn) {
          this.loopIn += delta;
          this.loopOut += delta;
        }
        this.jumpTo(clamp(target, 0, this.length));
        break;
      }
      case 'tempo':
        this.tempo = msg.value;
        break;
      case 'bend':
        this.bend = msg.value;
        break;
      case 'keyLock':
        this.keyLock = !!msg.on;
        break;
      case 'reverse':
        this.reverse = !!msg.on;
        break;
      case 'vinyl':
        this.brakeTime = msg.brake || 0;
        this.startTime = msg.start || 0;
        break;
      case 'push':
        if (this.playing) this.push += msg.frames;
        break;
      case 'scratchStart':
        this.scratching = true;
        this.sTarget = this.pos;
        this.sVel = 0;
        this.sAge = 0;
        this.push = 0;
        if (this.slipEnabled && this.playing && !this.slipping) this.startSlip();
        break;
      case 'scratchMove':
        if (!this.scratching) break;
        this.sTarget += msg.delta;
        this.sVel = msg.vel;
        this.sAge = 0;
        break;
      case 'scratchEnd':
        if (!this.scratching) break;
        this.scratching = false;
        this.motor = this.playing ? this.vel : 0;
        if (this.slipping && !this.loopOn) this.endSlip();
        break;
      case 'loop':
        this.loopIn = msg.in;
        this.loopOut = Math.max(msg.out, msg.in + 16);
        this.loopOn = true;
        if (this.slipEnabled && this.playing && !this.slipping) this.startSlip();
        if (msg.jump || this.pos >= this.loopOut) this.jumpTo(this.loopIn);
        break;
      case 'loopExit':
        this.loopOn = false;
        if (this.slipping && !this.scratching) this.endSlip();
        break;
      case 'loopResize':
        this.loopOut = Math.max(msg.out, this.loopIn + 16);
        if (this.loopOn && this.pos >= this.loopOut) {
          const len = this.loopOut - this.loopIn;
          this.jumpTo(this.loopIn + ((this.pos - this.loopIn) % len));
        }
        break;
      case 'slip':
        this.slipEnabled = !!msg.on;
        if (!this.slipEnabled) this.slipping = false;
        break;
      case 'sync':
        if (this.syncOn && !msg.on) this.tempo = this.syncTempo; // keep the synced tempo, no jump
        this.syncOn = !!msg.on;
        if (this.syncOn) this.syncTempo = this.tempo;
        this.syncCorr = 0;
        break;
      default:
        break;
    }
  }

  startSlip() {
    this.slipping = true;
    this.slipPos = this.pos;
  }

  endSlip() {
    this.slipping = false;
    this.jumpTo(clamp(this.slipPos, 0, this.length));
  }

  /** Move the playhead with a short cross-fade so it never clicks. */
  jumpTo(p) {
    if (this.pathMix < 1) {
      this.fadePos = this.pos;
      this.fadeLeft = JUMP_FADE;
    }
    if (this.pathMix > 0) this.stretch.jump();
    this.pos = p;
  }

  /**
   * Quantized jump target: land on `target` but keep the current position
   * within the beat, so a playing deck stays in phase with whatever it is
   * mixed with.
   */
  phaseMatchedTarget(target) {
    const g = this.grid;
    const now = g.beatAt(this.pos);
    const tgt = g.beatAt(target);
    let d = (now - Math.floor(now)) - (tgt - Math.floor(tgt));
    if (d >= 0.5) d -= 1;
    if (d < -0.5) d += 1;
    return g.frameAt(tgt + d);
  }

  // ---------------------------------------------------------------- rendering

  render(outL, outR, n) {
    if (!this.L) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    if (!this.playing && !this.scratching && this.motor === 0 && this.gain === 0) {
      // Stopped: silence, and make sure the next start is clean.
      outL.fill(0);
      outR.fill(0);
      this.vel = 0;
      this.fadeLeft = 0;
      if (this.pathMix > 0) {
        this.pathMix = 0;
        this.stretch.reset();
      }
      this.dcxL = this.dcxR = this.dcyL = this.dcyR = 0;
      return;
    }

    const sr = this.sr;
    const dir = this.reverse ? -1 : 1;
    const base = this.baseRate * dir;
    this.bendNow += (this.bend - this.bendNow) * 0.25;

    // --- transport (motor) for this block
    const m0 = this.motor;
    let m1 = m0;
    let gainTarget = 1;
    if (this.playing) {
      if (this.startTime > 0) m1 = approach(m0, base, (Math.abs(base) * n) / (this.startTime * sr));
      else m1 = base;
    } else if (this.brakeTime > 0 && !this.instantStop) {
      m1 = approach(m0, 0, (Math.abs(this.tempo) * n) / (this.brakeTime * sr));
      if (m0 === 0 && m1 === 0) gainTarget = 0;
    } else {
      gainTarget = 0; // keep moving while fading out, stop once silent
    }
    if (this.scratching) gainTarget = 1;

    // --- corrections (only while playing normally)
    let corr = 0;
    if (this.playing && !this.scratching) {
      if (this.push !== 0) {
        const lim = 0.12 * Math.max(0.25, Math.abs(m1));
        let c = clamp(this.push / (0.08 * sr), -lim, lim);
        if (Math.abs(c * n) >= Math.abs(this.push)) {
          c = this.push / n;
          this.push = 0;
        } else {
          this.push -= c * n;
          if (Math.abs(this.push) < 0.01) this.push = 0;
        }
        corr += c;
      }
      corr += this.syncCorr;
    } else if (!this.playing) {
      this.push = 0;
    }

    const vTarget = m1 * (1 + this.bendNow) + corr;
    // CDJ-style instant start: full speed at once (the gain ramp prevents a click).
    if (this.playing && !this.scratching && m0 === 0 && this.startTime === 0) this.vel = vTarget;
    let v = this.vel;
    let dv = this.scratching ? 0 : (vTarget - v) / n;
    const wantStretch = this.keyLock && this.playing && !this.scratching && vTarget > 0.25 && vTarget < 4;
    const slipVel = this.playing ? base : 0;

    const L = this.L;
    const R = this.R;
    const len = this.length;
    const w = this.scratchW;
    const w2 = w * w;
    const w2x = 2 * w;
    const dcR = this.dcR;
    let gain = this.gain;
    let stopNow = false;

    for (let i = 0; i < n; i++) {
      if (this.scratching) {
        const ext = this.sAge < this.maxExtrap;
        const tgt = this.sTarget + this.sVel * (ext ? this.sAge : this.maxExtrap);
        const tv = ext ? this.sVel : 0;
        v += w2 * (tgt - this.pos) - w2x * (v - tv);
        if (v > 16) v = 16;
        else if (v < -16) v = -16;
        this.sAge++;
      } else {
        v += dv;
      }

      // --- produce a sample at the current playhead
      const m = this.pathMix;
      let l = 0;
      let r = 0;
      if (m < 1) {
        const p = this.pos;
        const ip = Math.floor(p);
        const t = p - ip;
        if (ip >= 1 && ip < len - 2) {
          l = cubic(L[ip - 1], L[ip], L[ip + 1], L[ip + 2], t);
          r = cubic(R[ip - 1], R[ip], R[ip + 1], R[ip + 2], t);
        } else {
          l = cubic(at(L, ip - 1, len), at(L, ip, len), at(L, ip + 1, len), at(L, ip + 2, len), t);
          r = cubic(at(R, ip - 1, len), at(R, ip, len), at(R, ip + 1, len), at(R, ip + 2, len), t);
        }
        if (this.fadeLeft > 0) {
          const g = this.fadeLeft / JUMP_FADE;
          const fp = this.fadePos;
          const fi = Math.floor(fp);
          const ft = fp - fi;
          const fl = cubic(at(L, fi - 1, len), at(L, fi, len), at(L, fi + 1, len), at(L, fi + 2, len), ft);
          const fr = cubic(at(R, fi - 1, len), at(R, fi, len), at(R, fi + 1, len), at(R, fi + 2, len), ft);
          l += (fl - l) * g;
          r += (fr - r) * g;
          this.fadePos += v;
          this.fadeLeft--;
        }
        l *= I16;
        r *= I16;
      }
      if (m > 0) {
        this.stretch.pull(this);
        l += (this.stretch.l - l) * m;
        r += (this.stretch.r - r) * m;
      }
      if (wantStretch) {
        if (m < 1) this.pathMix = Math.min(1, m + this.pathStep);
      } else if (m > 0) {
        this.pathMix = Math.max(0, m - this.pathStep);
        if (this.pathMix === 0) this.stretch.reset();
      }

      if (gain !== gainTarget) {
        gain = gain < gainTarget ? Math.min(gainTarget, gain + this.declickStep) : Math.max(gainTarget, gain - this.declickStep);
      }
      l *= gain;
      r *= gain;

      const yl = l - this.dcxL + dcR * this.dcyL;
      const yr = r - this.dcxR + dcR * this.dcyR;
      this.dcxL = l;
      this.dcxR = r;
      this.dcyL = yl;
      this.dcyR = yr;
      outL[i] = yl;
      outR[i] = yr;

      // --- advance
      this.pos += v;
      if (this.slipping) this.slipPos += slipVel;

      if (this.loopOn) {
        const ll = this.loopOut - this.loopIn;
        if (v > 0 && this.pos >= this.loopOut && this.pos - v < this.loopOut) this.jumpTo(this.pos - ll);
        else if (v < 0 && this.pos < this.loopIn && this.pos - v >= this.loopIn) this.jumpTo(this.pos + ll);
      }
      if (this.pos >= len) {
        this.pos = len;
        if (v > 0) {
          if (this.scratching) v = 0;
          else if (this.playing) stopNow = true;
        }
      } else if (this.pos < 0) {
        this.pos = 0;
        if (v < 0) {
          if (this.scratching) v = 0;
          else if (this.playing && this.reverse) stopNow = true;
        }
      }
      if (stopNow) {
        // Ran off the end of the track: stop like a CDJ does.
        stopNow = false;
        this.playing = false;
        this.ended = true;
        this.slipping = false;
        m1 = 0;
        v = 0;
        dv = 0;
        gainTarget = 0;
      }
    }

    this.gain = gain;
    this.vel = v;
    if (!this.playing && gainTarget === 0 && gain === 0) {
      this.motor = 0;
      this.vel = 0;
      this.instantStop = false;
    } else {
      this.motor = m1;
    }
  }

  /** Small snapshot for the UI thread. */
  snapshot() {
    return {
      pos: this.pos,
      vel: this.vel,
      playing: this.playing,
      scratching: this.scratching,
      loopOn: this.loopOn,
      loopIn: this.loopIn,
      loopOut: this.loopOut,
      slipping: this.slipping,
      slipPos: this.slipPos,
      rate: this.baseRate,
      syncOn: this.syncOn,
      ended: this.ended,
      push: this.push,
    };
  }
}

// Catmull-Rom cubic interpolation between x0 and x1.
function cubic(xm1, x0, x1, x2, t) {
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}

function at(buf, i, len) {
  return i >= 0 && i < len ? buf[i] : 0;
}

function approach(x, target, step) {
  if (x < target) return Math.min(target, x + step);
  if (x > target) return Math.max(target, x - step);
  return x;
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
