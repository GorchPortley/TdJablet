// The built-in two-channel mixer (hidden when an external mixer is used).

import { h, pad, toggleClass } from './dom.js';
import { Knob, Fader } from './controls.js';

export class MixerView {
  constructor(engine) {
    this.engine = engine;
    this.cue = [false, false];
    this.cueBtns = [];
    const strip = (i) => {
      const k = (label, band) => new Knob({ label, onChange: (v) => engine.setEq(i, band, v) }).el;
      const filter = new Knob({ label: 'FILTER', onChange: (v) => engine.setFilter(i, v * 2 - 1) });
      const cueBtn = pad(h('button.btn.cue-btn', { title: 'Pre-listen in headphones' }, '🎧'), () => {
        this.cue[i] = !this.cue[i];
        engine.setCue(i, this.cue[i]);
        toggleClass(cueBtn, 'on', this.cue[i]);
      });
      this.cueBtns.push(cueBtn);
      const fader = new Fader({ vertical: true, value: 1, onChange: (v) => engine.setFader(i, v) });
      return h(
        `div.mx-ch.mx-${'ab'[i]}`,
        {},
        h('div.mx-label', {}, 'AB'[i]),
        h('div.mx-knobs', {}, k('HI', 'high'), k('MID', 'mid'), k('LOW', 'low'), filter.el),
        cueBtn,
        fader.el,
      );
    };
    const xf = new Fader({ vertical: false, value: 0.5, onChange: (v) => engine.setCrossfader(v), cls: 'xf' });
    this.el = h('div.mixer', {}, h('div.mx-strips', {}, strip(0), strip(1)), h('div.mx-xf', {}, h('span', {}, 'A'), xf.el, h('span', {}, 'B')));
  }
}
