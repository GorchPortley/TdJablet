// The library browser: import music / rekordbox prep, browse playlists,
// search, and load tracks onto the decks.

import { h, fmtTime, toast } from './dom.js';

const ROW_H = 52;
const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.mp4,.aac,.flac,.wav,.aif,.aiff,.aifc,.ogg,.opus,.alac,.wma,.ape,.wv,.caf';

export class Browser {
  constructor(app) {
    this.app = app;
    this.lib = app.library;
    this.playlistId = null;
    this.missingOnly = false;
    this.text = '';
    this.sortKey = 'auto';
    this.selected = null;
    this.expanded = new Set();
    this.rows = [];
    this.list = [];
    this.armed = null;

    const picker = (opts) => {
      const inp = h('input', { type: 'file', multiple: true, ...opts, style: { display: 'none' } });
      inp.addEventListener('change', () => {
        const files = [...inp.files];
        inp.value = '';
        if (files.length) this.app.importFiles(files);
      });
      return inp;
    };
    const filesIn = picker({ accept: AUDIO_ACCEPT });
    const dirIn = picker({});
    dirIn.webkitdirectory = true;
    const xmlIn = picker({ accept: '.xml,text/xml,application/xml' });

    this.search = h('input.br-search', { type: 'search', placeholder: 'Search title, artist, BPM, key…', autocomplete: 'off' });
    this.search.addEventListener('input', () => {
      this.text = this.search.value;
      this.update();
    });
    this.sortSel = h(
      'select.br-sort',
      {},
      ...[
        ['auto', 'Playlist order / newest'],
        ['title', 'Title'],
        ['artist', 'Artist'],
        ['bpm', 'BPM'],
        ['key', 'Key'],
        ['duration', 'Time'],
        ['addedAt', 'Date added'],
      ].map(([v, l]) => h('option', { value: v }, l)),
    );
    this.sortSel.addEventListener('change', () => {
      this.sortKey = this.sortSel.value;
      this.update();
    });
    this.removeBtn = h('button.btn.small', { disabled: true, onclick: () => this.removeSelected() }, 'Remove');

    this.side = h('nav.br-side');
    this.spacer = h('div.br-spacer');
    this.scroll = h('div.br-scroll', {}, this.spacer);
    this.scroll.addEventListener('scroll', () => this.renderRows());
    this.empty = h('div.br-empty');
    this.status = h('div.br-status');

    this.el = h(
      'section.browser.hidden',
      {},
      h(
        'div.br-top',
        {},
        h('button.btn.close', { onclick: () => this.hide(), 'aria-label': 'Close library' }, '✕'),
        this.search,
        this.sortSel,
        this.removeBtn,
        h(
          'div.br-import',
          {},
          h('button.btn.small.accent', { onclick: () => filesIn.click() }, '＋ Music files'),
          h('button.btn.small.accent', { onclick: () => dirIn.click(), title: 'A music folder, or the root of a rekordbox USB stick' }, '＋ Folder / USB'),
          h('button.btn.small.accent', { onclick: () => xmlIn.click(), title: 'rekordbox: File → Export Collection in xml format' }, '＋ rekordbox XML'),
        ),
        filesIn,
        dirIn,
        xmlIn,
      ),
      h(
        'div.br-body',
        {},
        this.side,
        h(
          'div.br-main',
          {},
          h('div.br-head', {}, h('span.c-title', {}, 'Title / Artist'), h('span.c-bpm', {}, 'BPM'), h('span.c-key', {}, 'Key'), h('span.c-time', {}, 'Time'), h('span.c-load', {}, 'Load')),
          this.scroll,
          this.empty,
        ),
      ),
      this.status,
    );
    this.lib.addEventListener('change', () => {
      if (this.visible) this.update();
    });
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  show() {
    this.el.classList.remove('hidden');
    this.update();
    this.updateStorage();
  }

  hide() {
    this.el.classList.add('hidden');
  }

  /** Import progress etc.; an empty string goes back to the storage summary. */
  setStatus(text) {
    this.statusText = text;
    this.status.textContent = text || this.storageText || '';
    if (!text) this.updateStorage();
  }

  async updateStorage() {
    const n = this.lib.tracks.size;
    const withAudio = [...this.lib.tracks.values()].filter((t) => t.audio !== 'missing').length;
    let s = `${n} tracks · ${withAudio} playable on this device`;
    try {
      const est = await navigator.storage.estimate();
      s += ` · storage ${fmtBytes(est.usage)} of ${fmtBytes(est.quota)}`;
    } catch {
      /* not available */
    }
    if (!this.statusText) this.status.textContent = s;
    this.storageText = s;
  }

  update() {
    this.renderSide();
    const sort = this.sortKey === 'auto' ? null : { key: this.sortKey, dir: this.sortKey === 'addedAt' ? -1 : 1 };
    let list = this.lib.query(this.text, this.playlistId, sort);
    if (this.missingOnly) list = list.filter((t) => t.audio === 'missing');
    this.list = list;
    this.spacer.style.height = `${list.length * ROW_H}px`;
    if (this.lib.tracks.size === 0) {
      this.empty.innerHTML = '';
      this.empty.append(
        h('h3', {}, 'Your library is empty'),
        h('p', {}, 'Add music files, a music folder, or the root folder of a rekordbox USB stick (with the PIONEER folder) to bring in your beat grids, cues and playlists.'),
        h('p', {}, 'Or export your collection from rekordbox as XML (File → Export Collection in xml format), import it here, then add the music files.'),
      );
      this.empty.style.display = 'block';
    } else if (!list.length) {
      this.empty.innerHTML = '';
      this.empty.append(h('p', {}, 'No tracks match.'));
      this.empty.style.display = 'block';
    } else {
      this.empty.style.display = 'none';
    }
    this.renderRows(true);
    this.removeBtn.disabled = !this.selected;
  }

  renderSide() {
    const lib = this.lib;
    this.side.innerHTML = '';
    const item = (label, count, active, onclick, depth = 0, cls = '') =>
      h(`button.side-item${active ? '.active' : ''}${cls}`, { onclick, style: { paddingLeft: `${12 + depth * 14}px` } }, h('span', {}, label), count !== null ? h('small', {}, String(count)) : null);
    this.side.append(
      item('All tracks', lib.tracks.size, !this.playlistId && !this.missingOnly, () => {
        this.playlistId = null;
        this.missingOnly = false;
        this.update();
      }),
    );
    const missing = [...lib.tracks.values()].filter((t) => t.audio === 'missing').length;
    if (missing) {
      this.side.append(
        item('Audio missing', missing, this.missingOnly, () => {
          this.playlistId = null;
          this.missingOnly = true;
          this.update();
        }, 0, '.warn'),
      );
    }
    const walk = (parentId, depth) => {
      for (const p of lib.playlistChildren(parentId)) {
        if (p.isFolder) {
          const open = this.expanded.has(p.id);
          this.side.append(
            item(`${open ? '▾' : '▸'} ${p.name}`, null, false, () => {
              if (open) this.expanded.delete(p.id);
              else this.expanded.add(p.id);
              this.renderSide();
            }, depth, '.folder'),
          );
          if (open) walk(p.id, depth + 1);
        } else {
          this.side.append(
            item(p.name, p.trackIds.length, this.playlistId === p.id, () => {
              this.playlistId = p.id;
              this.missingOnly = false;
              this.update();
            }, depth),
          );
        }
      }
    };
    if (lib.playlists.size) this.side.append(h('div.side-sec', {}, 'rekordbox playlists'));
    walk(null, 0);
  }

  renderRows(force = false) {
    const top = this.scroll.scrollTop;
    const height = this.scroll.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const last = Math.min(this.list.length, Math.ceil((top + height) / ROW_H) + 4);
    const needed = last - first;
    while (this.rows.length < needed) {
      const r = this.makeRow();
      this.rows.push(r);
      this.scroll.append(r.el);
    }
    for (let k = 0; k < this.rows.length; k++) {
      const r = this.rows[k];
      const i = first + k;
      if (i >= last) {
        r.el.style.display = 'none';
        r.track = null;
        continue;
      }
      const t = this.list[i];
      r.el.style.display = '';
      r.el.style.transform = `translateY(${i * ROW_H}px)`;
      if (!force && r.track === t) continue;
      r.track = t;
      this.fillRow(r, t);
    }
  }

  makeRow() {
    const r = {};
    r.color = h('span.r-color');
    r.title = h('b');
    r.artist = h('small');
    r.bpm = h('span.c-bpm');
    r.key = h('span.c-key');
    r.time = h('span.c-time');
    r.loadA = h('button.load', { onclick: (e) => (e.stopPropagation(), this.loadTo(0, r.track, r.loadA)) }, 'A');
    r.loadB = h('button.load', { onclick: (e) => (e.stopPropagation(), this.loadTo(1, r.track, r.loadB)) }, 'B');
    r.el = h(
      'div.br-row',
      {
        onclick: () => {
          this.selected = r.track ? r.track.id : null;
          this.renderRows(true);
          this.removeBtn.disabled = !this.selected;
        },
      },
      r.color,
      h('span.c-title', {}, r.title, r.artist),
      r.bpm,
      r.key,
      r.time,
      h('span.c-load', {}, r.loadA, r.loadB),
    );
    return r;
  }

  fillRow(r, t) {
    r.title.textContent = t.title;
    r.artist.textContent = [t.artist, t.album].filter(Boolean).join(' — ');
    r.bpm.textContent = t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 2 : 0) : '';
    r.key.textContent = t.key || '';
    r.time.textContent = t.duration ? fmtTime(t.duration) : '';
    r.color.style.background = t.color || 'transparent';
    r.el.classList.toggle('missing', t.audio === 'missing');
    r.el.classList.toggle('selected', this.selected === t.id);
    r.el.classList.toggle('on-deck', this.app.decks.some((d) => d.track && d.track.id === t.id));
    r.loadB.style.display = this.app.deckCount === 2 ? '' : 'none';
    r.loadA.textContent = this.app.deckCount === 2 ? 'A' : 'LOAD';
  }

  loadTo(i, track, btn) {
    if (!track) return;
    if (track.audio === 'missing') {
      toast(`"${track.fileName || track.title}" isn't on this device yet — add the file or its folder and it will be linked automatically.`, 5000);
      return;
    }
    const deck = this.app.decks[i];
    const key = `${i}:${track.id}`;
    if (deck.playing && this.app.settings.get('loadLock') && this.armed !== key) {
      this.armed = key;
      btn.classList.add('armed');
      toast(`Deck ${'AB'[i]} is playing — tap ${'AB'[i]} again to load anyway`);
      setTimeout(() => {
        if (this.armed === key) this.armed = null;
        btn.classList.remove('armed');
      }, 2500);
      return;
    }
    this.armed = null;
    btn.classList.remove('armed');
    this.app.loadTrack(i, track);
    this.hide();
  }

  async removeSelected() {
    const t = this.lib.tracks.get(this.selected);
    if (!t) return;
    if (this.app.decks.some((d) => d.track && d.track.id === t.id)) {
      toast('That track is loaded on a deck');
      return;
    }
    if (!confirm(`Remove "${t.title}" from the library on this device?`)) return;
    this.selected = null;
    await this.lib.remove([t.id]);
  }
}

function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
