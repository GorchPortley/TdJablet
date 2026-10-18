// Reads title / artist / BPM / key etc. from audio files without decoding them.
// Supports ID3v2 (MP3, AIFF, WAV), FLAC Vorbis comments, MP4/M4A atoms and
// WAV LIST/INFO. Falls back to "Artist - Title" from the file name.

import { fourcc } from './pcm.js';

export async function readTags(file) {
  const name = file.name || '';
  let tags = {};
  try {
    const head = new DataView(await file.slice(0, 64).arrayBuffer());
    if (head.byteLength >= 10) {
      const id = fourcc(head, 0);
      if (id.startsWith('ID3')) {
        const size = 10 + syncsafe(head, 6);
        const tag = new DataView(await file.slice(0, size).arrayBuffer());
        tags = parseId3(tag);
        // FLAC files sometimes carry an ID3 tag in front.
        const after = new DataView(await file.slice(size, size + 4).arrayBuffer());
        if (after.byteLength === 4 && fourcc(after, 0) === 'fLaC') tags = { ...tags, ...(await readFlac(file, size)) };
      } else if (id === 'fLaC') {
        tags = await readFlac(file, 0);
      } else if (fourcc(head, 4) === 'ftyp') {
        tags = await readMp4(file);
      } else if (id === 'FORM' || id === 'RIFF') {
        tags = await readChunked(file, id === 'RIFF');
      }
    }
  } catch (e) {
    console.warn('tag read failed', name, e);
  }
  if (!tags.title) {
    const base = name.replace(/\.[^.]+$/, '');
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    if (m && !tags.artist) {
      tags.artist = m[1].trim();
      tags.title = m[2].trim();
    } else {
      tags.title = base;
    }
  }
  if (typeof tags.bpm === 'string') tags.bpm = parseFloat(tags.bpm.replace(',', '.')) || undefined;
  return tags;
}

// ---------------------------------------------------------------- ID3v2

const ID3_FIELDS = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TALB: 'album', TAL: 'album',
  TCON: 'genre', TCO: 'genre',
  TBPM: 'bpm', TBP: 'bpm',
  TKEY: 'key', TKE: 'key',
  TPUB: 'label', TPB: 'label',
  TYER: 'year', TDRC: 'year', TYE: 'year',
  TPE4: 'remixer', TP4: 'remixer',
};

export function parseId3(v) {
  const major = v.getUint8(3);
  const flags = v.getUint8(5);
  const size = syncsafe(v, 6);
  let bytes = new Uint8Array(v.buffer, v.byteOffset + 10, Math.min(size, v.byteLength - 10));
  if (flags & 0x80 && major < 4) bytes = unsync(bytes);
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  if (flags & 0x40 && major >= 3) off += major === 4 ? syncsafe(d, 0) : d.getUint32(0) + 4;
  const out = {};
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;
  while (off + hdrLen <= d.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(off, off + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    let len;
    if (major === 2) len = (d.getUint8(off + 3) << 16) | (d.getUint8(off + 4) << 8) | d.getUint8(off + 5);
    else if (major === 4) len = syncsafe(d, off + 4);
    else len = d.getUint32(off + 4);
    const body = bytes.subarray(off + hdrLen, off + hdrLen + len);
    off += hdrLen + len;
    const field = ID3_FIELDS[id];
    if (field && !out[field]) {
      let text = decodeText(body[0], body.subarray(1)).split('\0').filter(Boolean).join(', ').trim();
      if (field === 'genre') text = text.replace(/^\((\d+)\)\s*/, '').trim();
      if (text) out[field] = text;
    } else if ((id === 'COMM' || id === 'COM') && !out.comment && body.length > 4) {
      const enc = body[0];
      const rest = body.subarray(4);
      const [, value] = splitTerminated(enc, rest);
      const text = decodeText(enc, value).replace(/\0+$/, '').trim();
      if (text) out.comment = text;
    }
  }
  return out;
}

function splitTerminated(enc, bytes) {
  const wide = enc === 1 || enc === 2;
  for (let i = 0; i < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) {
      return [bytes.subarray(0, i), bytes.subarray(i + (wide ? 2 : 1))];
    }
  }
  return [bytes, new Uint8Array(0)];
}

function decodeText(enc, bytes) {
  try {
    if (enc === 0) return new TextDecoder('latin1').decode(bytes);
    if (enc === 1) {
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

function unsync(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return Uint8Array.from(out);
}

function syncsafe(v, off) {
  return ((v.getUint8(off) & 0x7f) << 21) | ((v.getUint8(off + 1) & 0x7f) << 14) | ((v.getUint8(off + 2) & 0x7f) << 7) | (v.getUint8(off + 3) & 0x7f);
}

// ---------------------------------------------------------------- FLAC

const VORBIS_FIELDS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', GENRE: 'genre', BPM: 'bpm', TBPM: 'bpm',
  INITIALKEY: 'key', KEY: 'key', COMMENT: 'comment', DESCRIPTION: 'comment', DATE: 'year',
  LABEL: 'label', ORGANIZATION: 'label', PUBLISHER: 'label', REMIXER: 'remixer',
};

async function readFlac(file, start) {
  const out = {};
  let off = start + 4;
  for (let guard = 0; guard < 64; guard++) {
    const h = new DataView(await file.slice(off, off + 4).arrayBuffer());
    if (h.byteLength < 4) break;
    const last = h.getUint8(0) & 0x80;
    const type = h.getUint8(0) & 0x7f;
    const len = (h.getUint8(1) << 16) | (h.getUint8(2) << 8) | h.getUint8(3);
    if (type === 0 || type === 4) {
      const b = new DataView(await file.slice(off + 4, off + 4 + len).arrayBuffer());
      if (type === 0 && b.byteLength >= 18) {
        const rate = (b.getUint8(10) << 12) | (b.getUint8(11) << 4) | (b.getUint8(12) >> 4);
        const total = (b.getUint8(13) & 0x0f) * 4294967296 + b.getUint32(14);
        if (rate && total) out.duration = total / rate;
      } else if (type === 4) {
        Object.assign(out, parseVorbisComments(b), { duration: out.duration });
      }
    }
    off += 4 + len;
    if (last) break;
  }
  if (out.duration === undefined) delete out.duration;
  return out;
}

export function parseVorbisComments(v) {
  const out = {};
  let off = 0;
  const vendor = v.getUint32(off, true);
  off += 4 + vendor;
  const count = v.getUint32(off, true);
  off += 4;
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < count && off + 4 <= v.byteLength; i++) {
    const len = v.getUint32(off, true);
    off += 4;
    const s = dec.decode(new Uint8Array(v.buffer, v.byteOffset + off, Math.min(len, v.byteLength - off)));
    off += len;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const field = VORBIS_FIELDS[s.slice(0, eq).toUpperCase()];
    if (field && !out[field]) out[field] = s.slice(eq + 1).trim();
  }
  return out;
}

// ---------------------------------------------------------------- MP4 / M4A

const MP4_FIELDS = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', '©gen': 'genre',
  '©cmt': 'comment', '©day': 'year', tmpo: 'bpm',
};

async function readMp4(file) {
  // moov can be anywhere (often at the end), so walk the top-level boxes.
  let off = 0;
  for (let guard = 0; guard < 256 && off + 8 <= file.size; guard++) {
    const h = new DataView(await file.slice(off, off + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = fourcc(h, 4);
    if (size === 1) size = h.getUint32(8) * 4294967296 + h.getUint32(12);
    else if (size === 0) size = file.size - off;
    if (size < 8) break;
    if (type === 'moov') {
      const moov = new DataView(await file.slice(off, off + Math.min(size, 32 << 20)).arrayBuffer());
      return parseMoov(moov);
    }
    off += size;
  }
  return {};
}

function parseMoov(v) {
  const out = {};
  const walk = (start, end, path) => {
    let off = start;
    while (off + 8 <= end) {
      let size = v.getUint32(off);
      const type = fourcc(v, off + 4);
      if (size === 0) size = end - off;
      if (size < 8 || off + size > end) break;
      const body = off + 8;
      if (type === 'mvhd') {
        const ver = v.getUint8(body);
        const scale = v.getUint32(body + (ver === 1 ? 20 : 12));
        const dur = ver === 1 ? v.getUint32(body + 24) * 4294967296 + v.getUint32(body + 28) : v.getUint32(body + 16);
        if (scale) out.duration = dur / scale;
      } else if (type === 'udta' || type === 'trak' || type === 'ilst') {
        walk(body, off + size, path + '/' + type);
      } else if (type === 'meta') {
        walk(body + 4, off + size, path + '/meta'); // full box: skip version/flags
      } else if (path.endsWith('/ilst')) {
        readIlstItem(type, body, off + size);
      }
      off += size;
    }
  };
  const readIlstItem = (type, start, end) => {
    let name = '';
    let off = start;
    while (off + 16 <= end) {
      const size = v.getUint32(off);
      const t = fourcc(v, off + 4);
      if (size < 8) break;
      if (t === 'name') {
        name = new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + off + 12, size - 12));
      } else if (t === 'data') {
        const kind = v.getUint32(off + 8) & 0xffffff;
        const valOff = off + 16;
        const valLen = size - 16;
        let field = MP4_FIELDS[type];
        if (type === '----' && /initialkey|^key$/i.test(name)) field = 'key';
        if (type === '----' && /^bpm$/i.test(name)) field = 'bpm';
        if (type === '----' && /label|publisher/i.test(name)) field = 'label';
        if (field && !out[field]) {
          if (kind === 21 || type === 'tmpo') {
            if (valLen >= 2) out[field] = valLen >= 4 ? v.getUint32(valOff) : v.getUint16(valOff);
          } else {
            out[field] = new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + valOff, valLen)).trim();
          }
        }
      }
      off += size;
    }
  };
  walk(8, v.byteLength, '');
  return out;
}

// ---------------------------------------------------------------- WAV / AIFF chunks

const RIFF_INFO = { INAM: 'title', IART: 'artist', IPRD: 'album', IGNR: 'genre', ICMT: 'comment', ICRD: 'year' };

async function readChunked(file, little) {
  const out = {};
  let off = 12;
  let rate = 0;
  let frames = 0;
  let byteRate = 0;
  let dataLen = 0;
  for (let guard = 0; guard < 512 && off + 8 <= file.size; guard++) {
    const h = new DataView(await file.slice(off, off + 8).arrayBuffer());
    const id = fourcc(h, 0);
    const size = h.getUint32(4, little);
    const body = off + 8;
    const small = size < 8 << 20;
    if ((id === 'ID3 ' || id === 'id3 ') && small) {
      Object.assign(out, parseId3(new DataView(await file.slice(body, body + size).arrayBuffer())));
    } else if (id === 'LIST' && little && small) {
      const b = new DataView(await file.slice(body, body + size).arrayBuffer());
      if (fourcc(b, 0) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.byteLength) {
          const sid = fourcc(b, p);
          const slen = b.getUint32(p + 4, true);
          const field = RIFF_INFO[sid];
          if (field && !out[field]) {
            out[field] = new TextDecoder('latin1').decode(new Uint8Array(b.buffer, p + 8, Math.min(slen, b.byteLength - p - 8))).replace(/\0+$/, '').trim();
          }
          p += 8 + slen + (slen & 1);
        }
      }
    } else if (id === 'fmt ') {
      const b = new DataView(await file.slice(body, body + 16).arrayBuffer());
      byteRate = b.getUint32(8, true);
    } else if (id === 'data') {
      dataLen = size;
    } else if (id === 'COMM') {
      const b = new DataView(await file.slice(body, body + 18).arrayBuffer());
      frames = b.getUint32(2, false);
      const se = b.getUint16(8, false);
      const mant = b.getUint32(10, false) * 4294967296 + b.getUint32(14, false);
      rate = mant * Math.pow(2, (se & 0x7fff) - 16383 - 63);
    }
    off = body + size + (size & 1);
  }
  if (rate && frames) out.duration = frames / rate;
  else if (byteRate && dataLen) out.duration = dataLen / byteRate;
  return out;
}
