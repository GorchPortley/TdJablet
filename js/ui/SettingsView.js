// Settings and help overlays.

import { h, toast } from './dom.js';
import { ffmpegAvailable } from '../decode/ffmpeg.js';

export class SettingsView {
  constructor(app) {
    this.app = app;
    this.body = h('div.ov-body');
    this.el = h('section.overlay.hidden', {}, h('div.ov-top', {}, h('h2', {}, 'Settings'), h('button.btn.close', { onclick: () => this.hide() }, '✕')), this.body);
  }

  show() {
    this.render();
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  render() {
    const app = this.app;
    const s = app.settings;
    const b = this.body;
    b.innerHTML = '';
    const sec = (title, ...rows) => b.append(h('div.set-sec', {}, h('h3', {}, title), ...rows));
    const toggle = (key, label, hint, onChange) => {
      const inp = h('input', { type: 'checkbox', checked: !!s.get(key) });
      inp.addEventListener('change', () => {
        s.set(key, inp.checked);
        if (onChange) onChange(inp.checked);
      });
      return h('label.set-row', {}, inp, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null));
    };
    const number = (key, label, hint, { min, max, step, unit }, onChange) => {
      const inp = h('input', { type: 'number', min, max, step, value: s.get(key) });
      inp.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, parseFloat(inp.value) || 0));
        inp.value = v;
        s.set(key, v);
        if (onChange) onChange(v);
      });
      return h('label.set-row.num', {}, h('span', {}, h('b', {}, label), hint ? h('small', {}, hint) : null), h('span.num-in', {}, inp, unit || ''));
    };

    // Output routing
    const max = app.engine.maxChannels;
    const modes = [
      ['stereo', 'Stereo master', 'Built-in mixer, master on outputs 1/2 (speakers, headphone jack, or any audio interface).'],
      ['split', 'Split cue (mono)', 'Master in mono on the left, headphone cue in mono on the right. Use a Y-splitter cable to get headphones from a single jack.'],
      ['int4', 'Master 1/2 + headphones 3/4', 'Built-in mixer with a 4-output USB audio interface.'],
      ['ext4', 'External mixer: A → 1/2, B → 3/4', 'Use the tablet as two CDJs: plug a 4-output USB interface into two channels of a DJ mixer. The built-in mixer is hidden.'],
    ];
    sec(
      'Audio output',
      ...modes.map(([v, label, hint]) => {
        const needs4 = v === 'int4' || v === 'ext4';
        const inp = h('input', { type: 'radio', name: 'routing', value: v, checked: app.engine.routing === v, disabled: needs4 && max < 4 });
        inp.addEventListener('change', () => app.setRouting(v));
        return h(`label.set-row${needs4 && max < 4 ? '.disabled' : ''}`, {}, inp, h('span', {}, h('b', {}, label), h('small', {}, hint + (needs4 && max < 4 ? ` (needs 4 outputs; this device reports ${max})` : ''))));
      }),
      h('p.set-note', {}, `Sample rate ${app.engine.sampleRate} Hz · output latency ${Math.round(((app.engine.ctx.outputLatency || 0) + (app.engine.ctx.baseLatency || 0)) * 1000)} ms`),
    );

    sec(
      'Decks',
      toggle('faderDownFaster', 'Tempo fader: towards you = faster', 'CDJ convention. Turn off for "up = faster".'),
      toggle('needleLock', 'Needle lock', 'While a deck plays, the overview only seeks after a half-second press.'),
      toggle('loadLock', 'Load lock', 'Ask for a second tap before loading onto a playing deck.'),
      number('brakeTime', 'Vinyl stop time', 'How long a deck in VINYL mode takes to stop.', { min: 0, max: 3, step: 0.05, unit: 's' }, () => app.decks.forEach((d) => d.applyVinyl())),
      number('startTime', 'Vinyl start time', '', { min: 0, max: 2, step: 0.02, unit: 's' }, () => app.decks.forEach((d) => d.applyVinyl())),
    );

    sec(
      'Library & rekordbox',
      toggle('keepAudio', 'Keep a copy of imported audio on this device', 'Tracks stay playable offline and after closing the app. Turn off to play straight from a USB stick (you will need to add it again next time).'),
      number('rbOffsetMs', 'rekordbox grid & cue offset', 'If rekordbox beat grids sit consistently early or late on your files (different MP3 decoders), correct it here. Applies to tracks loaded afterwards.', { min: -100, max: 100, step: 1, unit: 'ms' }),
      number('minBpm', 'BPM detection: lowest', 'For tracks without a rekordbox grid.', { min: 50, max: 150, step: 1, unit: 'BPM' }),
      number('maxBpm', 'BPM detection: highest', '', { min: 100, max: 250, step: 1, unit: 'BPM' }),
      h(
        'div.set-row.buttons',
        {},
        h(
          'button.btn.small',
          {
            onclick: async () => {
              const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
              toast(ok ? 'Storage is persistent: the browser will not clear your library by itself.' : 'The browser did not grant persistent storage (installing the app to the home screen usually helps).');
            },
          },
          'Make storage persistent',
        ),
        h(
          'button.btn.small.danger',
          {
            onclick: async () => {
              if (!confirm('Delete the whole library (tracks, stored audio, cues, playlists) from this device?')) return;
              await app.library.clear();
              toast('Library cleared');
            },
          },
          'Clear library…',
        ),
      ),
    );

    const ff = h('small', {}, 'Checking…');
    ffmpegAvailable().then((ok) => {
      ff.textContent = ok
        ? 'Bundled: files the browser cannot play itself (ALAC on Android/Chrome, WMA, APE, WavPack…) are decoded with ffmpeg.wasm (~31 MB, downloaded on first use).'
        : 'Not bundled with this copy of the app. MP3, AAC/M4A, FLAC, WAV, AIFF, Ogg and Opus still work. See the README to enable it.';
    });
    sec('Formats', h('div.set-row', {}, h('span', {}, h('b', {}, 'Extended formats'), ff)));
  }
}

export class HelpView {
  constructor(app) {
    this.app = app;
    this.el = h(
      'section.overlay.help.hidden',
      {},
      h('div.ov-top', {}, h('h2', {}, 'How to play TdJablet'), h('button.btn.close', { onclick: () => this.hide() }, '✕')),
      h(
        'div.ov-body',
        {},
        h('div.help-hero', {}, h('h3', {}, 'The Tape replaces the jog wheel'), h('p', {}, 'Each deck’s zoomed waveform is a strip of tape you can grab. Deck A’s tape sits right above deck B’s, so you can see whether the beat lines meet.')),
        h(
          'div.help-grid',
          {},
          card('Nudge (CDJ mode, playing)', 'Drag the waveform so its beat lines meet the other deck’s. The deck glides there with a short, smooth bend — you choose where the beat goes, not how hard to spin.'),
          card('Search (CDJ mode, paused)', 'Drag to scrub through the track and hear it. Press CUE to set the cue point where you stopped.'),
          card('Scratch (VINYL on)', 'Touch = hand on the record: hold still to stop it, drag to scratch, let go to release. With SLIP on, the track carries on underneath.'),
          card('Fine control', 'While dragging the tape, a fader or a knob, slide your finger off the control (up/down for the tape, sideways for faders and knobs). The same movement then changes less: ½, ¼… No need to zoom in.'),
          card('Bend lever', 'Hold it left or right to run slower or faster for as long as you hold — for when the tempos are close but not quite equal. Then fix the tempo fader.'),
          card('Phase meter', 'Between the tapes: each deck’s position in its bar, and how many milliseconds deck B is ahead (+) or behind (−) deck A. Green = in phase.'),
          card('Zoom', 'Pinch the tapes with two fingers, or use − / + in the top bar.'),
          card('CUE / PLAY', 'Like a CDJ: CUE while paused sets the cue point, hold CUE to preview from it, CUE while playing jumps back and stops. Hot cues A–H: tap an empty pad to store, SHIFT + pad to delete.'),
          card('Loops', 'LOOP plays a beat loop of the shown size (½ and ×2 change it, also while looping). IN / OUT for manual loops, RELOOP to exit or re-enter. ◀ ▶ beat-jump by the same size.'),
          card('rekordbox', 'Import a whole rekordbox USB stick (the folder that contains PIONEER) or an XML export: beat grids, hot cues, memory cues, colours and playlists come along. Memory cues: ◀ / ▶ CALL to step through them, MEMO to store one (SHIFT + MEMO deletes).'),
        ),
      ),
    );
  }

  show() {
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
    this.app.settings.set('helpSeen', true);
  }
}

function card(title, text) {
  return h('div.help-card', {}, h('b', {}, title), h('p', {}, text));
}
