// Touch controls: tempo fader, bend lever, knobs and faders.
//
// All of them use *relative* dragging - touching a control never makes it
// jump to where your finger landed - and the tempo fader and knobs support the
// same precision trick as the Tape: slide your finger sideways, away from the
// control, and the same movement changes the value less.

import { h } from './dom.js';

/** Common drag plumbing: onDrag(dx, dy, e, gain) with dx/dy in CSS px. */
function draggable(el, { onStart, onDrag, onEnd, fineAxis = null, onDouble }) {
  let id = null;
  let lx = 0;
  let ly = 0;
  let sx = 0;
  let sy = 0;
  let lastTap = 0;
  el.addEventListener('pointerdown', (e) => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    try {
      el.setPointerCapture(id);
    } catch {
      /* ignore */
    }
    lx = sx = e.clientX;
    ly = sy = e.clientY;
    const now = performance.now();
    if (onDouble && now - lastTap < 300) onDouble();
    lastTap = now;
    el.classList.add('active');
    if (onStart) onStart(e);
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - lx;
    const dy = e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    let gain = 1;
    if (fineAxis === 'x') gain = 1 / (1 + Math.abs(e.clientX - sx) / 70);
    if (fineAxis === 'y') gain = 1 / (1 + Math.abs(e.clientY - sy) / 70);
    onDrag(dx, dy, e, gain);
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('active');
    if (onEnd) onEnd(e);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Vertical tempo fader. value -1..1, onChange(value). */
export class TempoFader {
  constructor({ onChange, onReset, downFaster = () => true }) {
    this.value = 0;
    this.disabled = false;
    this.thumb = h('div.tf-thumb');
    this.fine = h('div.tf-fine');
    this.track = h('div.tf-track', {}, h('div.tf-center'), this.thumb, this.fine);
    this.el = h('div.tempo-fader', {}, this.track);
    draggable(this.track, {
      fineAxis: 'x',
      onDouble: onReset,
      onDrag: (dx, dy, e, gain) => {
        if (this.disabled) return;
        const len = this.track.clientHeight - 40;
        const dir = downFaster() ? 1 : -1;
        const v = Math.max(-1, Math.min(1, this.value + ((dir * dy * 2) / len) * gain));
        this.fine.textContent = gain < 0.95 ? `FINE ×${gain.toFixed(2)}` : '';
        onChange(v);
      },
      onEnd: () => (this.fine.textContent = ''),
    });
    this.downFaster = downFaster;
  }

  set(v, disabled = false) {
    if (v === this.value && disabled === this.disabled && this._dir === this.downFaster()) return;
    this.value = v;
    this.disabled = disabled;
    this._dir = this.downFaster();
    const frac = (this._dir ? v : -v) * 0.5 + 0.5; // 0 = top
    this.thumb.style.top = `calc(${(frac * 100).toFixed(3)}% - ${(frac * 40).toFixed(2)}px)`;
    this.el.classList.toggle('disabled', disabled);
  }
}

/** Spring-loaded horizontal pitch-bend lever: hold it off-centre to run faster/slower. */
export class BendLever {
  constructor({ onBend, max = 0.08 }) {
    this.thumb = h('div.bend-thumb');
    this.el = h('div.bend', {}, h('span.bend-l', {}, '−'), h('span.bend-r', {}, '+'), this.thumb);
    let x = 0;
    const apply = () => {
      const half = (this.el.clientWidth - this.thumb.clientWidth) / 2;
      const f = Math.max(-1, Math.min(1, x / half));
      this.thumb.style.transform = `translateX(${(f * half).toFixed(1)}px)`;
      // Quadratic: small deflections give the gentle 0.1-1 % nudges beatmatching needs.
      onBend(Math.sign(f) * f * f * max);
    };
    draggable(this.el, {
      onStart: () => {
        x = 0;
      },
      onDrag: (dx) => {
        x += dx;
        apply();
      },
      onEnd: () => {
        x = 0;
        this.thumb.style.transition = 'transform 120ms ease-out';
        apply();
        setTimeout(() => (this.thumb.style.transition = ''), 130);
      },
    });
  }
}

/** Rotary knob, drag up/down. value 0..1. Double-tap resets. */
export class Knob {
  constructor({ label, value = 0.5, def = 0.5, bipolar = true, onChange }) {
    this.value = value;
    this.def = def;
    this.bipolar = bipolar;
    this.onChange = onChange;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 40 40');
    this.svg.innerHTML =
      '<circle cx="20" cy="20" r="15" class="k-body"/>' +
      '<path class="k-track" fill="none" stroke-width="3"/>' +
      '<path class="k-arc" fill="none" stroke-width="3"/>' +
      '<line class="k-ptr" x1="20" y1="20" x2="20" y2="8" stroke-width="2.5" stroke-linecap="round"/>';
    this.el = h('div.knob', {}, this.svg, h('span.k-label', {}, label));
    draggable(this.el, {
      fineAxis: 'x',
      onDouble: () => this.set(this.def, true),
      onDrag: (dx, dy, e, gain) => this.set(this.value - (dy / 160) * gain, true),
    });
    this.set(value, false);
  }

  set(v, notify) {
    v = Math.max(0, Math.min(1, v));
    // Snap to the centre detent.
    if (this.bipolar && Math.abs(v - 0.5) < 0.015) v = 0.5;
    this.value = v;
    const a0 = -135;
    const a = a0 + v * 270;
    const from = this.bipolar ? 0 : a0;
    const arc = (s, e) => {
      const p = (deg) => {
        const r = ((deg - 90) * Math.PI) / 180;
        return `${(20 + 17 * Math.cos(r)).toFixed(2)} ${(20 + 17 * Math.sin(r)).toFixed(2)}`;
      };
      const lo = Math.min(s, e);
      const hi = Math.max(s, e);
      return `M ${p(lo)} A 17 17 0 ${hi - lo > 180 ? 1 : 0} 1 ${p(hi)}`;
    };
    this.svg.querySelector('.k-track').setAttribute('d', arc(a0, 135));
    this.svg.querySelector('.k-arc').setAttribute('d', Math.abs(a - from) < 0.5 ? '' : arc(from, a));
    this.svg.querySelector('.k-ptr').setAttribute('transform', `rotate(${a.toFixed(1)} 20 20)`);
    if (notify && this.onChange) this.onChange(v);
  }
}

/** Linear fader (vertical channel fader or horizontal crossfader). value 0..1. */
export class Fader {
  constructor({ vertical = true, value = 1, def = value, onChange, cls = '' }) {
    this.vertical = vertical;
    this.value = value;
    this.onChange = onChange;
    this.thumb = h('div.f-thumb');
    this.el = h(`div.fader${vertical ? '.v' : '.h'}${cls ? '.' + cls : ''}`, {}, h('div.f-line'), this.thumb);
    draggable(this.el, {
      onDouble: () => this.set(def, true),
      onDrag: (dx, dy) => {
        const len = (vertical ? this.el.clientHeight : this.el.clientWidth) - 28;
        this.set(this.value + (vertical ? -dy : dx) / len, true);
      },
    });
    requestAnimationFrame(() => this.set(value, false));
  }

  set(v, notify) {
    this.value = Math.max(0, Math.min(1, v));
    const pct = this.vertical ? 1 - this.value : this.value;
    const prop = this.vertical ? 'top' : 'left';
    this.thumb.style[prop] = `calc(${(pct * 100).toFixed(2)}% - ${(pct * 28).toFixed(2)}px)`;
    if (notify && this.onChange) this.onChange(this.value);
  }
}
