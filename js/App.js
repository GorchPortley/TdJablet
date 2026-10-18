// App: creates the engine, library and decks, builds the screen and runs
// the drawing loop.

import { AudioEngine } from './audio/AudioEngine.js';
import { Analyzer } from './analysis/Analyzer.js';
import { Library } from './library/Library.js';
import { IdbStore, MemoryStore } from './library/LibraryStore.js';
import { Deck } from './Deck.js';
import { Settings } from './ui/Settings.js';
import { DeckView } from './ui/DeckView.js';
import { MixerView } from './ui/MixerView.js';
import { PhaseMeter } from './ui/PhaseMeter.js';
import { Browser } from './ui/Browser.js';
import { SettingsView, HelpView } from './ui/SettingsView.js';
import { h, toast, toggleClass, setText } from './ui/dom.js';

export class App {
  constructor(root) {
    this.root = root;
    this.settings = new Settings();
    this.zoom = this.settings.get('zoom');
    this.engine = new AudioEngine();
    this.decks = [];
    this.views = [];
  }

  async init() {
    let store;
    try {
      store = await new IdbStore().open();
    } catch (e) {
      console.warn('IndexedDB unavailable', e);
      store = new MemoryStore();
      this.noStorage = true;
    }
    this.library = new Library(store);
    await this.library.load();
    this.showStart();
  }

  showStart() {
    const problems = [];
    if (!window.isSecureContext) problems.push('This page must be opened over https:// (or on localhost) for the audio engine to work.');
    else if (!window.AudioWorkletNode) problems.push('This browser does not support AudioWorklet. Use a current Safari, Chrome, Edge or Firefox.');
    const go = h('button.btn.start-btn', { disabled: problems.length > 0 }, 'Start');
    const overlay = h(
      'div.start',
      {},
      h(
        'div.start-box',
        {},
        h('h1', {}, 'TdJablet'),
        h('p', {}, 'A CDJ-style player for your tablet. Touch-first: drag the music itself instead of spinning a jog wheel.'),
        ...problems.map((p) => h('p.err', {}, p)),
        go,
        h('small', {}, `${this.library.tracks.size} tracks in your library on this device`),
      ),
    );
    go.addEventListener('click', async () => {
      go.disabled = true;
      go.textContent = 'Starting…';
      try {
        await this.start();
        overlay.remove();
      } catch (e) {
        console.error(e);
        go.textContent = 'Start';
        go.disabled = false;
        overlay.querySelector('.start-box').append(h('p.err', {}, `Could not start audio: ${e.message}`));
      }
    });
    this.root.append(overlay);
  }

  async start() {
    await this.engine.start(this.settings.get('latency'));
    this.analyzer = new Analyzer();
    const deps = { engine: this.engine, library: this.library, analyzer: this.analyzer, settings: this.settings };
    this.decks = [new Deck(0, deps), new Deck(1, deps)];
    this.decks.forEach((d) => d.syncEngine());
    this.buildUi();
    this.setRouting(this.settings.get('routing'), false);
    this.setDeckCount(this.settings.get('deckCount'));
    this.engine.addEventListener('ended', (e) => this.decks[e.detail.deck].changed());
    this.keepAwake();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.keepAwake();
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (this.noStorage) toast('Browser storage is unavailable: the library will not be saved.', 6000);
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    if (!this.settings.get('helpSeen')) this.help.show();
    else if (this.library.tracks.size === 0) this.browser.show();
  }

  buildUi() {
    const s = this.settings;
    this.views = this.decks.map((d) => new DeckView(d, this));
    const [A, B] = this.views;
    this.phaseCanvas = h('canvas.phase');
    this.mixer = new MixerView(this.engine);
    this.browser = new Browser(this);
    this.settingsView = new SettingsView(this);
    this.help = new HelpView(this);

    const btn = (label, onclick, attrs = {}) => h('button.tb', { onclick, ...attrs }, label);
    this.qBtn = btn('Q', () => {
      s.set('quantize', !s.get('quantize'));
      this.refreshTop();
    }, { title: 'Quantize: cues, loops and jumps snap to the beat grid' });
    this.deck1Btn = btn('1 DECK', () => this.setDeckCount(1));
    this.deck2Btn = btn('2 DECKS', () => this.setDeckCount(2));
    this.zoomLbl = h('span.zoom-lbl');
    const range = (value, oninput, title) => {
      const r = h('input.tb-range', { type: 'range', min: 0, max: 1, step: 0.01, value, title });
      r.addEventListener('input', () => oninput(parseFloat(r.value)));
      return r;
    };
    this.engine.setMaster(0.9);
    this.masterCtl = h('label.tb-ctl', {}, h('span', {}, 'MASTER'), range(0.9, (v) => this.engine.setMaster(v), 'Master volume'));
    this.phonesCtl = h('label.tb-ctl.phones-ctl', {}, h('span', {}, 'CUE ↔ MST'), range(0.25, (v) => this.engine.setCueMix(v), 'Headphones: cue / master mix'));

    this.top = h(
      'header.topbar',
      {},
      btn('☰ LIBRARY', () => this.browser.show(), { class: 'tb lib-btn' }),
      h('span.logo', {}, 'TdJablet'),
      h('div.seg', {}, this.deck1Btn, this.deck2Btn),
      this.qBtn,
      h('div.seg.zoom', {}, btn('−', () => this.setZoom(this.zoom * 1.4), { 'aria-label': 'Zoom out' }), this.zoomLbl, btn('+', () => this.setZoom(this.zoom / 1.4), { 'aria-label': 'Zoom in' })),
      this.masterCtl,
      this.phonesCtl,
      h('span.spacer'),
      btn('?', () => this.help.show(), { title: 'How it works' }),
      btn('⚙', () => this.settingsView.show(), { title: 'Settings' }),
      btn('⛶', () => this.toggleFullscreen(), { title: 'Full screen' }),
    );

    this.waves = h('main.wavezone', {}, A.head, A.tapeCanvas, this.phaseCanvas, B.tapeCanvas, B.head);
    this.controls = h('footer.controls', {}, A.panel, this.mixer.el, B.panel);
    this.root.append(this.top, this.waves, this.controls, this.browser.el, this.settingsView.el, this.help.el);
    this.phase = new PhaseMeter(this.phaseCanvas, this.decks);
    this.refreshTop();

    // Desktop convenience: drop files anywhere to import them.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer.files || [])];
      if (files.length) this.importFiles(files);
    });
  }

  frame() {
    if (this.browser.visible) return; // covered by the library
    for (const v of this.views) {
      if (v.deck.i === 1 && this.deckCount === 1) continue;
      v.frame();
    }
    if (this.deckCount === 2) this.phase.draw();
  }

  refreshTop() {
    toggleClass(this.qBtn, 'on', this.settings.get('quantize'));
    toggleClass(this.deck1Btn, 'on', this.deckCount === 1);
    toggleClass(this.deck2Btn, 'on', this.deckCount === 2);
    setText(this.zoomLbl, `${this.zoom < 10 ? this.zoom.toFixed(1) : Math.round(this.zoom)} s`);
  }

  // ------------------------------------------------------------ actions

  setDeckCount(n) {
    this.deckCount = n === 1 ? 1 : 2;
    this.settings.set('deckCount', this.deckCount);
    this.root.classList.toggle('decks-1', this.deckCount === 1);
    this.root.classList.toggle('decks-2', this.deckCount === 2);
    this.refreshTop();
  }

  setZoom(z) {
    this.zoom = Math.max(1.5, Math.min(32, z));
    this.settings.set('zoom', this.zoom);
    this.refreshTop();
  }

  setRouting(mode, announce = true) {
    const used = this.engine.setRouting(mode);
    this.settings.set('routing', used);
    this.root.classList.toggle('ext-mixer', used === 'ext4');
    this.root.classList.toggle('no-cue', used === 'stereo');
    if (announce && used !== mode) toast('That output mode needs an audio interface with 4 outputs.');
  }

  vinyl(i) {
    const v = this.settings.get('vinyl');
    return Array.isArray(v) ? !!v[i] : !!v;
  }

  setVinyl(i, on) {
    const v = [this.vinyl(0), this.vinyl(1)];
    v[i] = on;
    this.settings.set('vinyl', v);
    this.decks[i].applyVinyl();
    this.decks[i].changed();
  }

  /** Beat sync: one deck follows the other, so switching one on releases the other. */
  setSync(i, on) {
    if (on) this.decks[1 - i].setSync(false);
    this.decks[i].setSync(on);
  }

  /** The deck the other one follows when synced. */
  isMaster(i) {
    const other = this.decks[1 - i];
    return !!other && other.sync && this.decks[i].loaded;
  }

  async loadTrack(i, track) {
    if (this.deckCount === 1) i = 0;
    await this.decks[i].load(track);
    if (this.decks[i].error) toast(this.decks[i].error, 6000);
    this.decks[1 - i].changed();
  }

  async importFiles(files) {
    this.browser.show();
    const persist = this.settings.get('keepAudio');
    try {
      const r = await this.library.addFiles(files, { persist, onProgress: (t) => this.browser.setStatus(t) });
      const parts = [];
      if (r.added) parts.push(`${r.added} added`);
      if (r.linked) parts.push(`${r.linked} linked to rekordbox tracks`);
      if (r.rekordbox) parts.push(`${r.rekordbox} rekordbox tracks`);
      if (r.playlists) parts.push(`${r.playlists} playlists`);
      toast(parts.length ? `Imported: ${parts.join(', ')}` : 'Nothing to import in that selection', 5000);
      if (r.failed.length) {
        console.warn(r.failed);
        toast(`${r.failed.length} problem(s): ${r.failed.slice(0, 3).join(' · ')}`, 8000);
      }
    } catch (e) {
      console.error(e);
      toast(`Import failed: ${e.message}`, 6000);
    }
    this.browser.setStatus('');
  }

  async keepAwake() {
    try {
      if (navigator.wakeLock) this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* not allowed right now */
    }
  }

  toggleFullscreen() {
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else {
      const el = d.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el).catch?.(() => toast('Full screen is not available here. On iPad, use Share → Add to Home Screen.'));
      else toast('Full screen is not available here. On iPad, use Share → Add to Home Screen.');
    }
  }
}
