// Strip between the two Tapes: where each deck is in its bar, and how far
// deck B's beats are from deck A's (green = in phase).

import { fitCanvas } from './dom.js';

export class PhaseMeter {
  constructor(canvas, decks) {
    this.canvas = canvas;
    this.decks = decks;
    this.ctx = canvas.getContext('2d');
    this.size = fitCanvas(canvas);
  }

  /** Beat-phase difference B - A in beats (-0.5..0.5), or null. */
  offset() {
    const [a, b] = this.decks;
    if (!a.grid || !b.grid || !a.loaded || !b.loaded) return null;
    const pa = a.grid.beatAt(a.pos);
    const pb = b.grid.beatAt(b.pos);
    let e = (pb - Math.floor(pb)) - (pa - Math.floor(pa));
    if (e >= 0.5) e -= 1;
    if (e < -0.5) e += 1;
    return e;
  }

  draw() {
    const { ctx } = this;
    const { w, h, dpr } = this.size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, w, h);
    const boxW = Math.min(26, w / 14);
    this.decks.forEach((d, i) => {
      if (!d.grid || !d.loaded) return;
      const beat = Math.floor(d.grid.beatAt(d.pos));
      const inBar = d.grid.barBeat(beat);
      for (let k = 1; k <= 4; k++) {
        const x = i === 0 ? 6 + (k - 1) * (boxW + 3) : w - 6 - (5 - k) * (boxW + 3);
        ctx.fillStyle = k === inBar ? (k === 1 ? '#ff4646' : '#e8e8e8') : '#202633';
        ctx.fillRect(x, 3, boxW, h - 6);
      }
    });
    const e = this.offset();
    const cx = w / 2;
    const span = w * 0.28;
    ctx.fillStyle = '#1a1f2a';
    ctx.fillRect(cx - span, h / 2 - 1, span * 2, 2);
    ctx.fillStyle = '#4a5468';
    ctx.fillRect(cx - 1, 2, 2, h - 4);
    if (e === null) return;
    const [a] = this.decks;
    const ms = (e * 60000) / (a.bpm || 120);
    const x = cx + Math.max(-1, Math.min(1, e * 2)) * span;
    const good = Math.abs(ms) < 8;
    ctx.fillStyle = good ? '#30d158' : Math.abs(ms) < 25 ? '#ffd60a' : '#ff6b3d';
    ctx.fillRect(x - 5, 2, 10, h - 4);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = e < 0 ? 'left' : 'right';
    const label = `B ${ms >= 0 ? '+' : ''}${ms.toFixed(0)} ms`;
    ctx.fillStyle = '#c9d1e0';
    ctx.fillText(label, e < 0 ? cx + 10 : cx - 10, h / 2);
  }
}
