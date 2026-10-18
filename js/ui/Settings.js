// App settings, kept per device in localStorage.

const DEFAULTS = {
  deckCount: 2,
  routing: 'stereo',
  latency: 'interactive',
  zoom: 8, // seconds visible across a Tape
  vinyl: [false, false], // per deck Tape mode: false = CDJ (drag nudges while playing), true = vinyl (drag scratches)
  brakeTime: 0.25, // vinyl stop time (s), used in vinyl mode
  startTime: 0.08, // vinyl start time (s)
  faderDownFaster: true, // CDJ convention: tempo fader towards you = faster
  needleLock: true, // overview seek only while paused (or press-and-hold)
  loadLock: true, // ask before loading onto a playing deck
  keepAudio: true, // copy imported audio into browser storage
  rbOffsetMs: 0, // shift applied to rekordbox grids and cues (decoder differences, mostly MP3)
  minBpm: 75,
  maxBpm: 175,
  tempoRange: [0.1, 0.1],
  keyLock: [false, false],
  quantize: true,
  helpSeen: false,
};

const KEY = 'tdjablet.settings';

export class Settings extends EventTarget {
  constructor() {
    super();
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      saved = {};
    }
    this.values = { ...DEFAULTS, ...saved };
  }

  get(k) {
    return this.values[k];
  }

  set(k, v) {
    this.values[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      /* private mode etc: settings just won't persist */
    }
    this.dispatchEvent(new CustomEvent('change', { detail: { key: k, value: v } }));
  }
}
