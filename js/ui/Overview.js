// Whole-track waveform with cue markers. Touch it to jump (needle search).
// With "needle lock" on (default) that only works while the deck is paused,
// or after pressing and holding for half a second while it plays.

import { fitCanvas } from './dom.js';

export class Overview {
  constructor(canvas, deck, app) {
    this.canvas = canvas;
    this.deck = deck;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.size = fitCanvas(canvas, () => (this.cache = null));
    this.cache = null; // pre-rendered waveform
    this.cacheWave = null;
    this.armed = false;
    this.holdTimer = 0;
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => this.up());
    canvas.addEventListener('pointercancel', () => this.up());
  }

  frameAt(clientX) {
    const r = this.canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.deck.length;
  }

  down(e) {
    e.preventDefault();
    const d = this.deck;
    if (!d.loaded) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.lastX = e.clientX;
    const locked = this.app.settings.get('needleLock') && d.playing;
    if (!locked) {
      this.armed = true;
      d.seek(this.frameAt(e.clientX));
    } else {
      this.holdTimer = setTimeout(() => {
        this.armed = true;
        d.seek(this.frameAt(this.lastX));
      }, 500);
    }
  }

  move(e) {
    this.lastX = e.clientX;
    if (this.armed) this.deck.seek(this.frameAt(e.clientX));
  }

  up() {
    clearTimeout(this.holdTimer);
    this.armed = false;
  }

  _render() {
    const { w, h, dpr } = this.size;
    const wave = this.deck.wave;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = wave.peak.length;
    const mid = h / 2;
    const bands = [
      [wave.low, '#2b6cff'],
      [wave.mid, '#f2a53a'],
      [wave.high, '#f2f2f2'],
    ];
    for (const [arr, color] of bands) {
      x.fillStyle = color;
      for (let col = 0; col < w; col++) {
        const a = Math.floor((col / w) * n);
        const b = Math.max(a + 1, Math.floor(((col + 1) / w) * n));
        let v = 0;
        for (let i = a; i < b; i++) if (arr[i] > v) v = arr[i];
        const hh = (v / 255) * (mid - 1);
        x.fillRect(col, mid - hh, 1, hh * 2);
      }
    }
    this.cache = c;
    this.cacheWave = wave;
  }

  draw() {
    const { ctx } = this;
    const { w, h, dpr } = this.size;
    const d = this.deck;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    if (!d.loaded) return;
    if (d.wave && (!this.cache || this.cacheWave !== d.wave)) this._render();
    if (this.cache && this.cacheWave === d.wave) ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = (f) => (f / d.length) * w;
    const p = X(d.pos);
    // dim what has been played
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, p, h);
    const st = d.state;
    if (st.loopOn) {
      ctx.fillStyle = 'rgba(255,170,0,0.35)';
      ctx.fillRect(X(st.loopIn), 0, Math.max(2, X(st.loopOut) - X(st.loopIn)), h);
    }
    for (const c of d.memoryCues) {
      ctx.fillStyle = '#ff3030';
      ctx.fillRect(X(d.cueFrame(c)) - 1, h - 6, 3, 6);
    }
    d.hotCues.forEach((c) => {
      if (!c) return;
      ctx.fillStyle = c.color || '#30d158';
      ctx.fillRect(X(d.cueFrame(c)) - 1, 0, 3, 7);
    });
    ctx.fillStyle = '#ff8c00';
    ctx.fillRect(X(d.cuePoint) - 1, 0, 2, h);
    ctx.fillStyle = '#fff';
    ctx.fillRect(p - 1, 0, 2, h);
    // remaining time warning in the last 30 s, like a CDJ
    const remaining = (d.length - d.pos) / d.sr;
    if (d.playing && remaining < 30 && Math.floor(performance.now() / 400) % 2) {
      ctx.strokeStyle = '#ff3030';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, w - 2, h - 2);
    }
  }
}
