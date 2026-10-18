// UI for one deck: the info header with the overview waveform, and the
// control panel (tempo fader, hot cues, loops, transport, bend lever).
// Deck B's panel is mirrored so both tempo faders and both PLAY buttons sit
// at the outer edges of the tablet, under your thumbs.

import { h, pad, fmtTime, setText, toggleClass, toast } from './dom.js';
import { TempoFader, BendLever } from './controls.js';
import { Overview } from './Overview.js';
import { Tape } from './Tape.js';

const LETTERS = 'ABCDEFGH';

export class DeckView {
  constructor(deck, app) {
    this.deck = deck;
    this.app = app;
    const L = 'AB'[deck.i];
    const d = deck;

    // ---------------- header
    this.title = h('b.dh-t');
    this.artist = h('span.dh-a');
    this.bpmEl = h('b');
    this.pitchEl = h('b');
    this.rangeEl = h('small');
    this.keyEl = h('b');
    this.timeEl = h('b');
    this.timeLbl = h('small', {}, 'REMAIN');
    this.badge = h('span.dh-badge', {}, L);
    this.menuBtn = h('button.dh-menu', { title: 'Deck menu', 'aria-label': 'Deck menu' }, '⋯');
    this.menuBtn.addEventListener('click', () => this.openMenu());
    const timeStat = h('div.stat.time', {}, this.timeEl, this.timeLbl);
    timeStat.addEventListener('click', () => {
      this.showElapsed = !this.showElapsed;
    });
    this.overviewCanvas = h('canvas.overview');
    this.head = h(
      `div.deck-head.deck-${L.toLowerCase()}`,
      {},
      h(
        'div.dh-row',
        {},
        this.badge,
        h('div.dh-title', {}, this.title, this.artist),
        h(
          'div.dh-stats',
          {},
          h('div.stat.bpm', {}, this.bpmEl, h('small', {}, 'BPM')),
          h('div.stat.pitch', {}, this.pitchEl, this.rangeEl),
          h('div.stat.key', {}, this.keyEl, h('small', {}, 'KEY')),
          timeStat,
          this.menuBtn,
        ),
      ),
      this.overviewCanvas,
    );

    this.tapeCanvas = h(`canvas.tape.tape-${L.toLowerCase()}`);

    // ---------------- panel
    const btn = (label, cls, onDown, onUp) => pad(h(`button.btn${cls ? '.' + cls : ''}`, {}, ...[].concat(label)), onDown, onUp);
    this.syncBtn = btn('SYNC', 'mode', () => this.app.setSync(d.i, !d.sync));
    this.mtBtn = btn('MT', 'mode', () => d.setKeyLock(!d.keyLock));
    this.mtBtn.title = 'Master tempo (key lock)';
    this.slipBtn = btn('SLIP', 'mode', () => d.setSlip(!d.slip));
    this.vinylBtn = btn('VINYL', 'mode', () => this.app.setVinyl(d.i, !this.app.vinyl(d.i)));
    this.vinylBtn.title = 'Tape mode: VINYL = drag scratches, off (CDJ) = drag nudges the phase';
    this.shiftBtn = btn('SHIFT', 'mode.shift', () => {
      d.shift = !d.shift;
      d.changed();
    });

    this.hot = [];
    const hotGrid = h('div.hotcues');
    for (let s = 0; s < 8; s++) {
      const name = h('span.hc-name');
      const b = pad(h('button.hc', {}, h('span.hc-l', {}, LETTERS[s]), name), () => d.hotCue(s));
      b._name = name;
      this.hot.push(b);
      hotGrid.append(b);
    }

    this.loopSizeEl = h('span.ls');
    this.loopBtn = btn(h('span', {}, 'LOOP ', this.loopSizeEl), 'loop.autoloop', () => d.autoLoop());
    this.inBtn = btn('IN', 'loop', () => d.loopIn());
    this.outBtn = btn('OUT', 'loop', () => d.loopOut());
    this.reloopBtn = btn('RELOOP', 'loop', () => d.reloopExit());
    this.jumpSizeL = h('span');
    this.jumpSizeR = h('span');
    const rowA = h(
      'div.row.r-loop',
      {},
      this.inBtn,
      this.outBtn,
      this.reloopBtn,
      btn([h('span', {}, '◀'), h('small', {}, 'CALL')], 'memo.two', () => d.call(-1)),
      (this.memBtn = btn('MEMO', 'memo', () => d.memory())),
      btn([h('span', {}, '▶'), h('small', {}, 'CALL')], 'memo.two', () => d.call(1)),
    );
    this.memBtn.title = 'Store the cue point (or the active loop) as a memory cue. SHIFT + MEMO deletes it.';
    const rowB = h(
      'div.row.r-size',
      {},
      btn('½', 'size', () => d.resizeLoop(0.5)),
      this.loopBtn,
      btn('×2', 'size', () => d.resizeLoop(2)),
      btn(h('span', {}, '◀ ', this.jumpSizeL), 'jump', () => d.beatJump(-1)),
      btn(h('span', {}, this.jumpSizeR, ' ▶'), 'jump', () => d.beatJump(1)),
    );

    this.cueBtn = pad(h('button.transport.cue', {}, 'CUE'), () => d.cueDown(), () => d.cueUp());
    this.playBtn = pad(h('button.transport.play', { 'aria-label': 'Play / pause' }, '▶︎❚❚'), () => d.playPause());
    this.bend = new BendLever({ onBend: (v) => d.send('bend', { value: v }) });

    this.fader = new TempoFader({
      onChange: (v) => d.setFader(v),
      onReset: () => d.setFader(0),
      downFaster: () => this.app.settings.get('faderDownFaster'),
    });
    this.rangeBtn = pad(h('button.range'), () => d.cycleRange());
    this.resetBtn = pad(h('button.range.reset', { title: 'Tempo to 0' }, '0'), () => d.setFader(0));

    this.panel = h(
      `div.deck-panel.panel-${L.toLowerCase()}${deck.i === 1 ? '.mirror' : ''}`,
      {},
      h('div.dp-fader', {}, this.rangeBtn, this.fader.el, this.resetBtn),
      h(
        'div.dp-main',
        {},
        h('div.row.r-modes', {}, this.syncBtn, this.mtBtn, this.slipBtn, this.vinylBtn, this.shiftBtn),
        hotGrid,
        rowA,
        rowB,
        h('div.row.r-transport', {}, this.cueBtn, this.playBtn, this.bend.el),
      ),
    );

    this.overview = new Overview(this.overviewCanvas, deck, app);
    this.tape = new Tape(this.tapeCanvas, deck, app, { flip: deck.i === 1 });
    deck.addEventListener('change', () => this.refresh());
    this.refresh();
  }

  /** Things that change on events (not every frame). */
  refresh() {
    const d = this.deck;
    const t = d.track;
    setText(this.title, t ? t.title : d.loading ? 'Loading…' : 'No track');
    setText(this.artist, t ? t.artist : '');
    setText(this.keyEl, (t && t.key) || '—');
    setText(this.rangeEl, d.range >= 1 ? 'WIDE' : `±${Math.round(d.range * 100)}`);
    setText(this.rangeBtn, d.range >= 1 ? 'WIDE' : `±${Math.round(d.range * 100)}%`);
    toggleClass(this.syncBtn, 'on', d.sync);
    toggleClass(this.mtBtn, 'on', d.keyLock);
    toggleClass(this.slipBtn, 'on', d.slip);
    toggleClass(this.vinylBtn, 'on', this.app.vinyl(d.i));
    toggleClass(this.shiftBtn, 'on', d.shift);
    toggleClass(this.panel, 'shifted', d.shift);
    const size = fmtBeats(d.loopSize);
    setText(this.loopSizeEl, size);
    setText(this.jumpSizeL, size);
    setText(this.jumpSizeR, size);
    toggleClass(this.inBtn, 'armed', d.pendingLoopIn !== null);
    const hc = d.hotCues;
    this.hot.forEach((b, s) => {
      const c = hc[s];
      b.style.setProperty('--hc', c ? c.color || '#30d158' : 'transparent');
      toggleClass(b, 'set', !!c);
      toggleClass(b, 'is-loop', !!(c && c.end));
      setText(b._name, c ? c.name || (c.end ? 'LOOP' : '') : '');
    });
  }

  /** Per-frame updates. */
  frame() {
    const d = this.deck;
    const st = d.state;
    this.tape.draw();
    this.overview.draw();
    const bpm = d.bpm;
    setText(this.bpmEl, bpm ? bpm.toFixed(2) : '—');
    const p = d.pitchPercent;
    setText(this.pitchEl, `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
    if (d.loaded) {
      const pos = d.pos / d.sr;
      const len = d.length / d.sr;
      setText(this.timeEl, this.showElapsed ? fmtTime(pos, true) : `-${fmtTime(len - pos, true)}`);
      setText(this.timeLbl, this.showElapsed ? 'ELAPSED' : 'REMAIN');
    } else setText(this.timeEl, '—');
    toggleClass(this.playBtn, 'on', !!st.playing);
    const atCue = d.loaded && !st.playing && Math.abs(d.pos - d.cuePoint) < 0.01 * d.sr;
    toggleClass(this.cueBtn, 'on', atCue || d.cuePreviewing);
    toggleClass(this.cueBtn, 'blink', d.loaded && !st.playing && !atCue);
    toggleClass(this.loopBtn, 'on', !!st.loopOn);
    toggleClass(this.reloopBtn, 'on', !!st.loopOn);
    toggleClass(this.slipBtn, 'slipping', !!st.slipping);
    // tempo fader follows sync
    const rate = d.rate;
    const v = d.sync ? Math.max(-1, Math.min(1, (rate - 1) / d.range)) : d.tempoFader;
    this.fader.set(v, d.sync);
    toggleClass(this.badge, 'master', this.app.isMaster(d.i));
  }

  openMenu() {
    const d = this.deck;
    const close = () => layer.remove();
    const item = (label, fn, disabled = false) =>
      h(
        'button.menu-item',
        {
          disabled,
          onclick: () => {
            close();
            fn();
          },
        },
        label,
      );
    const g = !!d.grid;
    const info = d.track
      ? `${d.track.fileName || ''} · grid: ${d.track.gridSource || (d.grid ? 'rekordbox' : 'none')} · ${d.track.source || ''}`
      : 'No track loaded';
    const box = h(
      'div.menu',
      {},
      h('div.menu-info', {}, info),
      h('div.menu-sec', {}, 'Beat grid'),
      item('Beat 1 is here', () => d.setDownbeatHere(), !g),
      item('Move grid to playhead', () => d.gridToPlayhead(), !g),
      h('div.menu-row', {}, item('Grid ◀ 5 ms', () => d.shiftGrid(-5), !g), item('Grid ▶ 5 ms', () => d.shiftGrid(5), !g)),
      h('div.menu-row', {}, item('BPM ×2', () => d.scaleGrid(2), !g), item('BPM ÷2', () => d.scaleGrid(0.5), !g)),
      item(
        'Set BPM…',
        () => {
          const v = parseFloat(String(prompt('BPM of this track (the grid is anchored on the beat nearest the playhead):', d.grid ? d.grid.bpmAt(d.pos, d.sr).toFixed(2) : '')).replace(',', '.'));
          if (v) d.setBpm(v);
        },
        !d.loaded,
      ),
      h('div.menu-sec', {}, 'Deck'),
      item(d.reverse ? 'Reverse: ON' : 'Reverse: off', () => d.setReverse(!d.reverse), !d.loaded),
      item(
        'Eject',
        () => {
          if (d.playing) toast('Pause the deck before ejecting');
          else d.eject();
        },
        !d.loaded,
      ),
    );
    const layer = h('div.menu-layer', {}, h('div.menu-backdrop', { onclick: () => close() }), box);
    document.body.append(layer);
    const r = this.menuBtn.getBoundingClientRect();
    box.style.top = `${Math.max(8, Math.min(window.innerHeight - box.offsetHeight - 8, r.bottom + 6))}px`;
    box.style.left = `${Math.max(8, Math.min(window.innerWidth - 268, r.right - 260))}px`;
  }
}

export function fmtBeats(b) {
  if (b >= 1) return String(b);
  return `1/${Math.round(1 / b)}`;
}
