// Turns parsed rekordbox data into TdJablet library records.
// Pure functions: the Library decides how to merge them with what it has.

import { parsePdb } from './pdb.js';
import { parseAnlz, mergeAnlz } from './anlz.js';
import { parseRekordboxXml } from './xml.js';

export const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|alac|flac|wav|wave|aif|aiff|aifc|ogg|oga|opus|wma|ape|wv|webm|caf|mka)$/i;

/** Library-shaped fields from a rekordbox track (PDB or XML). */
function baseRecord(t, source) {
  return {
    title: t.title || t.fileName || 'Untitled',
    artist: t.artist || '',
    album: t.album || '',
    genre: t.genre || '',
    label: t.label || '',
    remixer: t.remixer || '',
    comment: t.comment || '',
    key: t.key || '',
    bpm: t.bpm || null,
    duration: t.duration || null,
    rating: t.rating || 0,
    year: t.year || null,
    fileName: t.fileName || '',
    fileSize: t.fileSize || 0,
    filePath: t.filePath || '',
    source,
    rbId: String(t.rbId !== undefined ? t.rbId : t.id),
  };
}

/** Grid spec from PQTZ beats. */
export function gridFromBeats(beats) {
  if (!beats || beats.length < 2) return null;
  return { type: 'beats', times: beats.map((b) => b.time), firstBeatInBar: beats[0].beat || 1 };
}

/**
 * Build records from a USB export.
 * @param {ArrayBuffer} pdbBytes  export.pdb
 * @param {(path: string) => Promise<ArrayBuffer|null>} readFile  reads a file by its
 *        path on the stick, e.g. "/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT"
 */
export async function recordsFromUsb(pdbBytes, readFile) {
  const pdb = parsePdb(pdbBytes);
  const records = [];
  for (const t of pdb.tracks) {
    const rec = baseRecord(t, 'rekordbox-usb');
    if (t.analyzePath) {
      let dat = null;
      let ext = null;
      try {
        const d = await readFile(t.analyzePath);
        if (d) dat = parseAnlz(d);
      } catch (e) {
        console.warn('ANLZ .DAT unreadable', t.analyzePath, e);
      }
      try {
        const e = await readFile(t.analyzePath.replace(/\.DAT$/i, '.EXT'));
        if (e) ext = parseAnlz(e);
      } catch (e) {
        console.warn('ANLZ .EXT unreadable', t.analyzePath, e);
      }
      const a = mergeAnlz(dat, ext);
      if (a) {
        rec.grid = gridFromBeats(a.beats);
        rec.cues = a.cues;
      }
    }
    records.push(rec);
  }
  const playlists = pdb.playlists.map((p) => ({
    rbId: String(p.id),
    rbParentId: p.parentId ? String(p.parentId) : null,
    name: p.name,
    isFolder: p.isFolder,
    order: p.order,
    rbTrackIds: p.trackIds.map(String),
  }));
  return { records, playlists };
}

export function recordsFromXml(text) {
  const xml = parseRekordboxXml(text);
  const records = xml.tracks.map((t) => {
    const rec = baseRecord(t, 'rekordbox-xml');
    rec.grid = t.grid;
    rec.cues = t.cues;
    rec.location = t.location;
    return rec;
  });
  const byLocation = new Map(xml.tracks.map((t) => [t.location, String(t.rbId)]));
  const playlists = xml.playlists.map((p) => ({
    rbId: String(p.id),
    rbParentId: p.parentId ? String(p.parentId) : null,
    name: p.name,
    isFolder: p.isFolder,
    order: p.order,
    rbTrackIds: p.keys.map((k) => (p.keyType === 'location' ? byLocation.get(k) : k)).filter(Boolean),
  }));
  return { records, playlists };
}

/**
 * Sort a dropped/picked list of files into what they are.
 * Files picked from a folder carry webkitRelativePath ("USB/PIONEER/rekordbox/export.pdb").
 */
export function classifyFiles(files) {
  const out = { audio: [], xml: [], pdb: null, usbRoot: '', byUsbPath: new Map() };
  for (const f of files) {
    const rel = f.webkitRelativePath || f.name;
    if (/(^|\/)PIONEER\/rekordbox\/export\.pdb$/i.test(rel) || (/^export\.pdb$/i.test(f.name) && !out.pdb)) {
      out.pdb = f;
      const i = rel.toUpperCase().lastIndexOf('PIONEER/');
      out.usbRoot = i >= 0 ? rel.slice(0, i) : '';
    } else if (/\.xml$/i.test(f.name)) {
      out.xml.push(f);
    } else if (AUDIO_EXT.test(f.name)) {
      out.audio.push(f);
    }
  }
  // Index everything under the USB root by its path on the stick.
  for (const f of files) {
    const rel = f.webkitRelativePath || '';
    if (!rel || !rel.startsWith(out.usbRoot)) continue;
    out.byUsbPath.set(pathKey('/' + rel.slice(out.usbRoot.length)), f);
  }
  return out;
}

/** Case- and Unicode-insensitive key for paths and names (Mac sticks often store decomposed accents). */
export function pathKey(p) {
  return (p || '').normalize('NFC').toLowerCase();
}

export function matchKey(name, size) {
  return `${pathKey(name)}|${size || 0}`;
}
