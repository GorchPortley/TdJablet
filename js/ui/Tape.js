// The Tape: TdJablet's replacement for the jog wheel.
//
// A jog wheel works because you can feel it. On glass you can't, and a
// virtual platter under a fingertip is small, imprecise and hides what you are
// doing. The Tape is the zoomed waveform itself, and you drag the music:
//
//   CDJ mode, playing   drag = PHASE PUSH. Drag the waveform until its beat
//                       lines meet the other deck's (stacked right above/below).
//                       The deck glides there with a short, smooth pitch bend,
//                       so you set *where* the beat goes, not how hard to spin.
//   CDJ mode, paused    drag = SEARCH with audible scrubbing to find a cue.
//   Vinyl mode          touch = hand on the record: hold to stop, drag to scratch.
//
//   Precision: slide your finger up or down *off* the tape while dragging and
//   the same movement moves the music less (½, ¼, ...) - like fine scrubbing
//   on a phone. No need to zoom in for fine nudges.
//   Two fingers: pinch to zoom (both tapes zoom together).
//
// For holding a speed difference (riding the pitch) use the BEND lever.

import { fitCanvas } from './dom.js';

const COLORS = {
  bg: '#0b0d12',
  low: '#2b6cff',
  mid: '#f2a53a',
  high: '#f2f2f2',
  beat: 'rgba(255,255,255,0.34)',
  bar: 'rgba(255,70,70,0.75)',
  playhead: '#ffffff',
  cue: '#ff8c00',
  memory: '#ff3030',
  loop: 'rgba(255,170,0,0.22)',
  loopEdge: '#ffaa00',
};

export class Tape {
  constructor(canvas, deck, app, { flip = false } = {}) {
    this.canvas = canvas;
    this.deck = deck;
    this.app = app;
    this.flip = flip; // draw cue flags at the bottom (deck below the phase meter)
    this.ctx = canvas.getContext('2d');
    this.size = fitCanvas(canvas);
    this.pointers = new Map();
    this.mode = null;
    this.grabPos = 0;
    this.grabDelta = 0;
    this.fine = 1;
    this.shown = 0;
    this.settleUntil = 0;
    this.lastMoveT = 0;
    this.stillSent = false;
    this.vel = 0;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get pxPerFrame() {
    return this.size.w / (this.app.zoom * this.deck.sr);
  }

  // ------------------------------------------------------------ gestures

  down(e) {
    e.preventDefault();
    const d = this.deck;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      if (this.mode === 'scratch') d.send('scratchEnd');
      const [a, b] = [...this.pointers.values()];
      this.mode = 'pinch';
      this.pinchDist = Math.max(20, Math.abs(a.x - b.x));
      this.pinchZoom = this.app.zoom;
      return;
    }
    if (this.pointers.size > 2 || !d.loaded) return;
    this.lastX = e.clientX;
    this.lastT = e.timeStamp;
    this.vel = 0;
    this.fine = 1;
    const vinyl = this.app.vinyl(d.i);
    if (vinyl || !d.playing) {
      this.mode = 'scratch';
      this.label = vinyl ? 'SCRATCH' : 'SEARCH';
      this.grabPos = d.pos;
      this.grabDelta = 0;
      d.send('scratchStart');
    } else {
      this.mode = 'push';
      this.label = 'NUDGE';
    }
    this.lastMoveT = performance.now();
    this.stillSent = false;
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.mode === 'pinch') {
      const [a, b] = [...this.pointers.values()];
      if (!b) return;
      const dist = Math.max(20, Math.abs(a.x - b.x));
      this.app.setZoom((this.pinchZoom * this.pinchDist) / dist);
      return;
    }
    if (this.mode !== 'scratch' && this.mode !== 'push') return;
    const dx = e.clientX - this.lastX;
    const dt = (e.timeStamp - this.lastT) / 1000;
    this.lastX = e.clientX;
    this.lastT = e.timeStamp;
    this.fine = this.fineGain(e.clientY);
    const frames = (-dx / this.pxPerFrame) * this.fine;
    if (frames === 0) return;
    if (this.mode === 'scratch') {
      this.grabDelta += frames;
      const inst = dt > 0 ? frames / (dt * this.deck.sr) : 0;
      this.vel = this.vel * 0.4 + inst * 0.6;
      this.deck.send('scratchMove', { delta: frames, vel: this.vel });
    } else {
      this.deck.send('push', { frames });
    }
    this.lastMoveT = performance.now();
    this.stillSent = false;
  }

  up(e) {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.mode === 'pinch') {
      if (this.pointers.size === 0) this.mode = null;
      return;
    }
    if (this.mode === 'scratch') this.deck.send('scratchEnd');
    if (this.mode) this.settleUntil = performance.now() + 200;
    this.mode = null;
    this.fine = 1;
  }

  /** 1 on the tape, less the further the finger is above/below it. */
  fineGain(y) {
    const r = this.canvas.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    return 1 / (1 + d / 60);
  }

  /** Position to draw: follows the finger directly while scratching. */
  displayPos() {
    const d = this.deck;
    let target;
    if (this.mode === 'scratch') target = this.grabPos + this.grabDelta;
    else target = d.pos + (d.state.push || 0); // show where a phase push is taking the deck
    const now = performance.now();
    if (now < this.settleUntil && Math.abs(target - this.shown) < 0.3 * d.sr) this.shown += (target - this.shown) * 0.35;
    else this.shown = target;
    return this.shown;
  }

  // ------------------------------------------------------------ drawing

  draw() {
    const { ctx } = this;
    const { w, h, dpr } = this.size;
    const d = this.deck;
    // Finger resting still: tell the engine so it doesn't keep extrapolating.
    if (this.mode === 'scratch' && !this.stillSent && performance.now() - this.lastMoveT > 30) {
      d.send('scratchMove', { delta: 0, vel: 0 });
      this.vel = 0;
      this.stillSent = true;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;

    if (!d.loaded) {
      ctx.fillStyle = d.error ? '#ff6b6b' : '#6b7385';
      ctx.font = '600 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const msg = d.error || d.status || `Deck ${'AB'[d.i]} — open the library to load a track`;
      wrapText(ctx, msg, w / 2, mid, w - 40, 20);
      return;
    }

    const sr = d.sr;
    const pos = this.displayPos();
    const ppf = this.pxPerFrame;
    const cx = w / 2;
    const left = pos - cx / ppf;
    const right = pos + (w - cx) / ppf;
    const X = (f) => cx + (f - pos) * ppf;
    const st = d.state;

    // Loop region
    if (st.loopOn) {
      const a = X(st.loopIn);
      const b = X(st.loopOut);
      ctx.fillStyle = COLORS.loop;
      ctx.fillRect(a, 0, b - a, h);
    }

    // Waveform
    if (d.wave) {
      const wv = d.wave;
      const rate = wv.rate;
      const amp = mid - 6;
      const n = wv.low.length;
      const step = 1; // css px per column
      const cols = Math.ceil(w / step) + 1;
      const ptsPerPx = (rate / sr) / ppf;
      const bands = [
        [wv.low, COLORS.low],
        [wv.mid, COLORS.mid],
        [wv.high, COLORS.high],
      ];
      for (const [arr, color] of bands) {
        ctx.beginPath();
        ctx.moveTo(0, mid);
        if (!this._top || this._top.length < cols) this._top = new Float32Array(cols);
        const top = this._top;
        for (let c = 0; c < cols; c++) {
          const f = left + (c * step) / ppf;
          const i0 = (f / sr) * rate;
          let v = 0;
          if (ptsPerPx > 1) {
            const a = Math.max(0, Math.floor(i0));
            const b = Math.min(n, Math.floor(i0 + ptsPerPx));
            for (let i = a; i < b; i++) if (arr[i] > v) v = arr[i];
          } else {
            const i = Math.floor(i0);
            if (i >= 0 && i < n) {
              const t = i0 - i;
              v = arr[i] * (1 - t) + (i + 1 < n ? arr[i + 1] : 0) * t;
            }
          }
          top[c] = (v / 255) * amp;
          ctx.lineTo(c * step, mid - top[c]);
        }
        for (let c = cols - 1; c >= 0; c--) ctx.lineTo(c * step, mid + top[c]);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#3a4252';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.status || 'Analysing waveform…', cx, mid);
    }

    // Beat grid
    if (d.grid) {
      const g = d.grid;
      const b0 = Math.floor(g.beatAt(left));
      const b1 = Math.ceil(g.beatAt(right));
      const dense = (b1 - b0) > w / 6;
      for (let b = b0; b <= b1; b++) {
        const x = Math.round(X(g.frameAt(b))) + 0.5;
        const isBar = g.barBeat(b) === 1;
        if (dense && !isBar) continue;
        ctx.strokeStyle = isBar ? COLORS.bar : COLORS.beat;
        ctx.lineWidth = isBar ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(x, isBar ? 0 : h * 0.12);
        ctx.lineTo(x, isBar ? h : h * 0.88);
        ctx.stroke();
      }
    }

    // Loop edges, pending loop in
    if (st.loopOn) {
      ctx.fillStyle = COLORS.loopEdge;
      ctx.fillRect(X(st.loopIn) - 1, 0, 2, h);
      ctx.fillRect(X(st.loopOut) - 1, 0, 2, h);
    }
    if (d.pendingLoopIn !== null) {
      ctx.fillStyle = COLORS.loopEdge;
      ctx.fillRect(X(d.pendingLoopIn) - 1, 0, 2, h);
    }

    // Memory cues (bottom triangles), hot cues (flags), cue point
    const flagY = this.flip ? h - 16 : 0;
    for (const c of d.memoryCues) {
      const x = X(d.cueFrame(c));
      if (x < -20 || x > w + 20) continue;
      tri(ctx, x, this.flip ? 0 : h, this.flip ? 9 : -9, COLORS.memory);
    }
    d.hotCues.forEach((c, slot) => {
      if (!c) return;
      const x = X(d.cueFrame(c));
      if (c.end) {
        ctx.fillStyle = hexA(c.color || '#ffaa00', 0.18);
        ctx.fillRect(x, 0, X(d.cueEndFrame(c)) - x, h);
      }
      if (x < -30 || x > w + 30) return;
      ctx.fillStyle = c.color || '#30d158';
      ctx.fillRect(x - 1, 0, 2, h);
      ctx.fillRect(x, flagY, 16, 16);
      ctx.fillStyle = '#000';
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ABCDEFGH'[slot], x + 8, flagY + 8.5);
    });
    const cx2 = X(d.cuePoint);
    if (cx2 > -10 && cx2 < w + 10) tri(ctx, cx2, this.flip ? h : 0, this.flip ? -10 : 10, COLORS.cue);

    // Slip: where the track will be when you let go
    if (st.slipping) {
      const sx = X(st.slipPos);
      ctx.fillStyle = 'rgba(80,220,255,0.9)';
      ctx.fillRect(sx - 1, 0, 2, h);
    }

    // Playhead
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(cx - 1, 0, 2, h);
    tri(ctx, cx, 0, 7, COLORS.playhead);
    tri(ctx, cx, h, -7, COLORS.playhead);

    // Gesture feedback
    if (this.mode === 'scratch' || this.mode === 'push') {
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const label = this.fine < 0.97 ? `${this.label}  FINE ×${this.fine.toFixed(2)}` : this.label;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(6, this.flip ? 4 : h - 22, tw + 12, 18);
      ctx.fillStyle = this.mode === 'push' ? '#7cf29b' : '#ffd60a';
      ctx.fillText(label, 12, this.flip ? 7 : h - 19);
    }
  }
}

function tri(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - Math.abs(size) * 0.8, y);
  ctx.lineTo(x + Math.abs(size) * 0.8, y);
  ctx.lineTo(x, y + size);
  ctx.closePath();
  ctx.fill();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  lines.push(line);
  const y0 = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lineH));
}
