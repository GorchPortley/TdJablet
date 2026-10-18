// Reader for rekordbox's "Export Collection in xml format" file.
//
// A tiny streaming tag scanner instead of DOMParser: collections can be tens
// of megabytes, the format is simple, and this way it also runs in Node tests.

import { rgbHex } from './anlz.js';

export function parseRekordboxXml(text) {
  const tracks = [];
  const playlists = [];
  const stack = []; // open element names
  const nodeStack = []; // open playlist NODE objects
  let track = null;
  let nextId = 1;

  forEachTag(text, (name, attrs, closing, selfClosing) => {
    if (closing) {
      stack.pop();
      if (name === 'TRACK' && track) {
        tracks.push(finishTrack(track));
        track = null;
      } else if (name === 'NODE') {
        nodeStack.pop();
      }
      return;
    }
    const parent = stack[stack.length - 1];
    if (name === 'TRACK' && parent === 'COLLECTION') {
      track = startTrack(attrs);
      if (selfClosing) {
        tracks.push(finishTrack(track));
        track = null;
      }
    } else if (name === 'TEMPO' && track) {
      track.tempo.push({
        start: num(attrs.Inizio),
        bpm: num(attrs.Bpm),
        beat: parseInt(attrs.Battito, 10) || 1,
        metro: attrs.Metro || '4/4',
      });
    } else if (name === 'POSITION_MARK' && track) {
      track.marks.push({
        name: attrs.Name || '',
        type: parseInt(attrs.Type, 10) || 0,
        start: num(attrs.Start),
        end: attrs.End !== undefined ? num(attrs.End) : null,
        num: attrs.Num !== undefined ? parseInt(attrs.Num, 10) : -1,
        color: attrs.Red !== undefined ? rgbHex(+attrs.Red || 0, +attrs.Green || 0, +attrs.Blue || 0) : null,
      });
    } else if (name === 'NODE') {
      const parentNode = nodeStack[nodeStack.length - 1] || null;
      const node = {
        id: nextId++,
        parentId: parentNode ? parentNode.id : 0,
        name: attrs.Name || '',
        isFolder: attrs.Type === '0',
        keyType: attrs.KeyType === '1' ? 'location' : 'id',
        keys: [],
        order: playlists.length,
      };
      // The invisible ROOT folder is not listed.
      if (!(node.isFolder && node.name === 'ROOT' && !parentNode)) playlists.push(node);
      else node.id = 0;
      if (!selfClosing) nodeStack.push(node);
    } else if (name === 'TRACK' && parent === 'NODE') {
      const node = nodeStack[nodeStack.length - 1];
      if (node && attrs.Key !== undefined) node.keys.push(attrs.Key);
    }
    if (!selfClosing) stack.push(name);
  });

  return { tracks, playlists };
}

function startTrack(a) {
  const location = a.Location || '';
  const path = locationToPath(location);
  return {
    rbId: a.TrackID,
    title: a.Name || '',
    artist: a.Artist || '',
    album: a.Album || '',
    genre: a.Genre || '',
    label: a.Label || '',
    remixer: a.Remixer || '',
    mixName: a.Mix || '',
    comment: a.Comments || '',
    key: a.Tonality || '',
    bpm: num(a.AverageBpm) || null,
    duration: num(a.TotalTime) || null,
    rating: Math.round((parseInt(a.Rating, 10) || 0) / 51),
    color: a.Colour ? '#' + a.Colour.replace(/^0x/i, '').padStart(6, '0').slice(-6).toLowerCase() : '',
    year: parseInt(a.Year, 10) || null,
    kind: a.Kind || '',
    fileSize: parseInt(a.Size, 10) || 0,
    location,
    filePath: path,
    fileName: path.split('/').pop(),
    tempo: [],
    marks: [],
  };
}

function finishTrack(t) {
  t.grid = gridFromTempo(t.tempo, t.duration);
  t.cues = [];
  for (const m of t.marks) {
    if (m.type !== 0 && m.type !== 4) continue; // skip fade-in/out and load markers
    const c = { kind: m.num >= 0 ? 'hot' : 'memory', time: m.start, name: m.name, color: m.color };
    if (m.num >= 0) c.slot = m.num;
    if (m.type === 4 && m.end !== null && m.end > m.start) c.end = m.end;
    t.cues.push(c);
  }
  delete t.tempo;
  delete t.marks;
  return t;
}

/** TEMPO elements → grid spec (see BeatGrid.fromSpec). */
export function gridFromTempo(segments, duration) {
  const segs = segments.filter((s) => s.bpm > 0).sort((a, b) => a.start - b.start);
  if (segs.length === 0) return null;
  if (segs.length === 1) {
    return { type: 'constant', bpm: segs[0].bpm, first: segs[0].start, firstBeatInBar: segs[0].beat };
  }
  const end = (duration || segs[segs.length - 1].start + 600) + 2;
  const times = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const until = i + 1 < segs.length ? segs[i + 1].start - 1e-6 : end;
    const spb = 60 / s.bpm;
    for (let t = s.start; t < until; t += spb) times.push(t);
  }
  return { type: 'beats', times, firstBeatInBar: segs[0].beat };
}

/** "file://localhost/Users/me/Music/a%20b.mp3" → "/Users/me/Music/a b.mp3" */
export function locationToPath(loc) {
  let p = loc.replace(/^file:\/\/localhost/i, '').replace(/^file:\/\//i, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as is */
  }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // Windows drive letter
  return p;
}

function num(s) {
  if (s === undefined || s === null || s === '') return 0;
  return parseFloat(String(s).replace(',', '.')) || 0;
}

// ---------------------------------------------------------------- scanner

const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function forEachTag(text, cb) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text[lt + 1] === '?' || text[lt + 1] === '!') {
      const e = text.indexOf('>', lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    // Find the closing '>' that is not inside a quoted attribute value.
    let j = lt + 1;
    let quote = 0;
    for (; j < n; j++) {
      const c = text.charCodeAt(j);
      if (quote) {
        if (c === quote) quote = 0;
      } else if (c === 34 || c === 39) {
        quote = c;
      } else if (c === 62) {
        break;
      }
    }
    const inner = text.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      cb(inner.slice(1).trim(), null, true, false);
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = /^([\w:.-]+)/.exec(body);
    if (!m) continue;
    const attrs = {};
    ATTR.lastIndex = m[0].length;
    let a;
    while ((a = ATTR.exec(body))) attrs[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
    cb(m[1], attrs, false, selfClosing);
  }
}

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}
