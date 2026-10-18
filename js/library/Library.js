// The music library: tracks, playlists and where their audio lives.
//
// Audio can be "stored" (copied into the browser's storage so it is still
// there next time, even offline), "session" (only referenced until the page
// is closed) or "missing" (we know the track from rekordbox but haven't been
// given the file yet). Adding files later re-links them by name and size.

import { readTags } from '../decode/tags.js';
import { recordsFromUsb, recordsFromXml, classifyFiles, matchKey } from '../rekordbox/import.js';

let idCounter = 0;
function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class Library extends EventTarget {
  constructor(store) {
    super();
    this.store = store;
    this.tracks = new Map();
    this.playlists = new Map();
    this.session = new Map(); // track id -> File (not persisted)
    this.byKey = new Map(); // "name|size" -> id
    this.byName = new Map(); // "name" -> [ids]
  }

  async load() {
    for (const t of await this.store.getAll('tracks')) {
      if (t.audio === 'session') t.audio = 'missing';
      this.tracks.set(t.id, t);
    }
    for (const p of await this.store.getAll('playlists')) this.playlists.set(p.id, p);
    this._reindex();
    this._changed();
  }

  _reindex() {
    this.byKey.clear();
    this.byName.clear();
    for (const t of this.tracks.values()) this._index(t);
  }

  _index(t) {
    if (!t.fileName) return;
    this.byKey.set(matchKey(t.fileName, t.fileSize), t.id);
    const n = t.fileName.toLowerCase();
    if (!this.byName.has(n)) this.byName.set(n, []);
    const list = this.byName.get(n);
    if (!list.includes(t.id)) list.push(t.id);
  }

  _changed() {
    this.dispatchEvent(new Event('change'));
  }

  _find(name, size) {
    const id = this.byKey.get(matchKey(name, size));
    if (id) return this.tracks.get(id);
    // Same name and either size unknown on one side or a single candidate.
    const list = this.byName.get((name || '').toLowerCase()) || [];
    const cands = list.map((i) => this.tracks.get(i)).filter((t) => t && (!size || !t.fileSize || t.fileSize === size));
    return cands.length === 1 ? cands[0] : null;
  }

  // ------------------------------------------------------------ importing

  /**
   * Add whatever the user picked: audio files, a rekordbox XML, or a whole
   * rekordbox USB stick (folder with PIONEER/rekordbox/export.pdb).
   */
  async addFiles(files, { persist = true, onProgress = () => {} } = {}) {
    const c = classifyFiles(files);
    const report = { added: 0, linked: 0, rekordbox: 0, playlists: 0, failed: [] };
    const dirty = new Set();
    const consumed = new Set();

    for (const x of c.xml) {
      onProgress(`Reading ${x.name}…`);
      try {
        const { records, playlists } = recordsFromXml(await x.text());
        const idMap = new Map();
        for (const rec of records) idMap.set(rec.rbId, this._merge(rec, dirty, report));
        report.playlists += await this._replacePlaylists('rekordbox-xml', playlists, idMap);
      } catch (e) {
        report.failed.push(`${x.name}: ${e.message}`);
      }
    }

    if (c.pdb) {
      onProgress('Reading rekordbox USB export…');
      try {
        const read = async (path) => {
          const f = c.byUsbPath.get(path.toLowerCase());
          return f ? f.arrayBuffer() : null;
        };
        const { records, playlists } = await recordsFromUsb(await c.pdb.arrayBuffer(), read);
        const idMap = new Map();
        let i = 0;
        for (const rec of records) {
          const id = this._merge(rec, dirty, report);
          idMap.set(rec.rbId, id);
          const f = c.byUsbPath.get((rec.filePath || '').toLowerCase());
          if (f) {
            consumed.add(f);
            onProgress(`Importing ${++i}/${records.length}: ${rec.title}`);
            await this._attach(this.tracks.get(id), f, persist, report);
          }
        }
        report.playlists += await this._replacePlaylists('rekordbox-usb', playlists, idMap);
      } catch (e) {
        report.failed.push(`export.pdb: ${e.message}`);
      }
    }

    const loose = c.audio.filter((f) => !consumed.has(f));
    let n = 0;
    for (const f of loose) {
      onProgress(`Adding ${++n}/${loose.length}: ${f.name}`);
      try {
        let t = this._find(f.name, f.size);
        if (t) {
          report.linked++;
        } else {
          const tags = await readTags(f);
          t = {
            id: newId('t'),
            title: tags.title || f.name,
            artist: tags.artist || '',
            album: tags.album || '',
            genre: tags.genre || '',
            label: tags.label || '',
            remixer: tags.remixer || '',
            comment: tags.comment || '',
            key: tags.key || '',
            bpm: tags.bpm || null,
            duration: tags.duration || null,
            rating: 0,
            year: tags.year ? parseInt(tags.year, 10) || null : null,
            fileName: f.name,
            fileSize: f.size,
            filePath: f.webkitRelativePath || f.name,
            source: 'files',
            grid: null,
            cues: [],
            audio: 'missing',
            addedAt: Date.now(),
          };
          this.tracks.set(t.id, t);
          this._index(t);
          report.added++;
        }
        dirty.add(t.id);
        await this._attach(t, f, persist, report);
      } catch (e) {
        report.failed.push(`${f.name}: ${e.message}`);
      }
    }

    await this._save(dirty);
    this._changed();
    return report;
  }

  /** Create or update a track from a rekordbox record. Returns its id. */
  _merge(rec, dirty, report) {
    let t = this._find(rec.fileName, rec.fileSize);
    if (!t) {
      t = { id: newId('t'), audio: 'missing', addedAt: Date.now(), cues: [], grid: null };
      this.tracks.set(t.id, t);
    }
    // rekordbox prep is the source of truth for metadata, grid and cues.
    const { grid, cues, location, ...meta } = rec;
    Object.assign(t, meta);
    if (grid) {
      t.grid = grid;
      t.gridSource = 'rekordbox';
    }
    if (cues && cues.length) t.cues = cues.map((c) => ({ ...c, id: newId('c') }));
    if (location) t.location = location;
    this._index(t);
    dirty.add(t.id);
    report.rekordbox++;
    return t.id;
  }

  async _attach(t, file, persist, report) {
    if (persist) {
      try {
        await this.store.put('audio', t.id, file);
        t.audio = 'stored';
        this.session.delete(t.id);
        return;
      } catch (e) {
        report.failed.push(`${file.name}: could not store a copy (${e.message}); using it for this session only`);
      }
    }
    this.session.set(t.id, file);
    t.audio = 'session';
  }

  async _replacePlaylists(source, lists, idMap) {
    for (const p of [...this.playlists.values()]) {
      if (p.source === source) {
        this.playlists.delete(p.id);
        await this.store.delete('playlists', p.id);
      }
    }
    const ids = new Map(lists.map((p) => [p.rbId, `pl-${source}-${p.rbId}`]));
    const entries = [];
    for (const p of lists) {
      const rec = {
        id: ids.get(p.rbId),
        name: p.name,
        parentId: p.rbParentId ? ids.get(p.rbParentId) || null : null,
        isFolder: p.isFolder,
        order: p.order,
        source,
        trackIds: p.rbTrackIds.map((r) => idMap.get(r)).filter(Boolean),
      };
      this.playlists.set(rec.id, rec);
      entries.push([rec.id, rec]);
    }
    await this.store.putMany('playlists', entries);
    return lists.length;
  }

  async _save(ids) {
    const entries = [];
    for (const id of ids) {
      const t = this.tracks.get(id);
      if (t) entries.push([id, t]);
    }
    if (entries.length) await this.store.putMany('tracks', entries);
  }

  // ------------------------------------------------------------ access

  async getAudio(id) {
    if (this.session.has(id)) return this.session.get(id);
    const t = this.tracks.get(id);
    if (!t || t.audio !== 'stored') return null;
    return (await this.store.get('audio', id)) || null;
  }

  getAnalysis(id) {
    return this.store.get('analysis', id);
  }

  saveAnalysis(id, data) {
    return this.store.put('analysis', id, data);
  }

  async update(id, patch) {
    const t = this.tracks.get(id);
    if (!t) return;
    Object.assign(t, patch);
    await this.store.put('tracks', id, t);
    this._changed();
  }

  async remove(ids) {
    for (const id of ids) {
      this.tracks.delete(id);
      this.session.delete(id);
      await this.store.delete('tracks', id);
      await this.store.delete('audio', id);
      await this.store.delete('analysis', id);
    }
    for (const p of this.playlists.values()) {
      const before = p.trackIds.length;
      p.trackIds = p.trackIds.filter((t) => !ids.includes(t));
      if (p.trackIds.length !== before) await this.store.put('playlists', p.id, p);
    }
    this._reindex();
    this._changed();
  }

  async clear() {
    for (const s of ['tracks', 'playlists', 'audio', 'analysis']) await this.store.clear(s);
    this.tracks.clear();
    this.playlists.clear();
    this.session.clear();
    this._reindex();
    this._changed();
  }

  /** Children of a playlist folder (null = top level), in rekordbox order. */
  playlistChildren(parentId) {
    return [...this.playlists.values()]
      .filter((p) => (p.parentId || null) === parentId)
      .sort((a, b) => (a.source === b.source ? a.order - b.order : a.source < b.source ? -1 : 1));
  }

  /**
   * Tracks to show in the browser.
   * @param {string} text   search words (all must match somewhere)
   * @param {string|null} playlistId
   * @param {{key: string, dir: 1|-1}|null} sort  null keeps playlist order
   */
  query(text = '', playlistId = null, sort = null) {
    let list;
    if (playlistId && this.playlists.has(playlistId)) {
      list = this.playlists.get(playlistId).trackIds.map((id) => this.tracks.get(id)).filter(Boolean);
    } else {
      list = [...this.tracks.values()];
      if (!sort) sort = { key: 'addedAt', dir: -1 };
    }
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      list = list.filter((t) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.key} ${t.label} ${t.remixer} ${t.comment} ${t.bpm ? Math.round(t.bpm) : ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    if (sort) {
      const { key, dir } = sort;
      list = list.slice().sort((a, b) => {
        const x = a[key];
        const y = b[key];
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
      });
    }
    return list;
  }
}
