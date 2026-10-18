// Reader for rekordbox analysis files (PIONEER/USBANLZ/.../ANLZ0000.DAT / .EXT).
// These hold the beat grid (PQTZ) and the memory/hot cues (PCOB in .DAT,
// PCO2 with colours and comments in .EXT). Big-endian, tagged sections.

export function parseAnlz(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  if (v.byteLength < 12 || tag(v, 0) !== 'PMAI') throw new Error('Not a rekordbox ANLZ file');
  const out = { path: '', beats: null, cues: [], extendedCues: false };
  let off = v.getUint32(4);
  while (off + 12 <= v.byteLength) {
    const t = tag(v, off);
    const lenHeader = v.getUint32(off + 4);
    const lenTag = v.getUint32(off + 8);
    if (lenTag < 12 || off + lenTag > v.byteLength) break;
    if (t === 'PPTH') {
      const len = v.getUint32(off + 12);
      out.path = utf16be(v, off + 16, len);
    } else if (t === 'PQTZ') {
      const n = v.getUint32(off + 20);
      const beats = [];
      for (let i = 0, p = off + lenHeader; i < n && p + 8 <= off + lenTag; i++, p += 8) {
        beats.push({ beat: v.getUint16(p), bpm: v.getUint16(p + 2) / 100, time: v.getUint32(p + 4) / 1000 });
      }
      out.beats = beats;
    } else if (t === 'PCO2') {
      const cues = readPco2(v, off, lenHeader, lenTag);
      if (!out.extendedCues) {
        out.cues = [];
        out.extendedCues = true;
      }
      out.cues.push(...cues);
    } else if (t === 'PCOB' && !out.extendedCues) {
      out.cues.push(...readPcob(v, off, lenHeader, lenTag));
    }
    off += lenTag;
  }
  return out;
}

/** Merge the .DAT and .EXT results (EXT cues win because they carry colours and names). */
export function mergeAnlz(dat, ext) {
  if (!dat) return ext;
  if (!ext) return dat;
  return {
    path: dat.path || ext.path,
    beats: dat.beats || ext.beats,
    cues: ext.extendedCues ? ext.cues : dat.cues,
    extendedCues: ext.extendedCues,
  };
}

function readPcob(v, off, lenHeader, lenTag) {
  const n = v.getUint16(off + 18);
  const cues = [];
  let p = off + lenHeader;
  for (let i = 0; i < n && p + 40 <= off + lenTag; i++) {
    if (tag(v, p) !== 'PCPT') break;
    const lenEntry = v.getUint32(p + 8);
    const hot = v.getUint32(p + 12);
    const status = v.getUint32(p + 16);
    const type = v.getUint8(p + 28);
    const time = v.getUint32(p + 32);
    const loop = v.getUint32(p + 36);
    if (status !== 0) cues.push(cue(hot, type, time, loop, '', null));
    p += lenEntry || 0x38;
  }
  return cues;
}

function readPco2(v, off, lenHeader, lenTag) {
  const n = v.getUint16(off + 16);
  const cues = [];
  let p = off + lenHeader;
  for (let i = 0; i < n && p + 28 <= off + lenTag; i++) {
    if (tag(v, p) !== 'PCP2') break;
    const lenEntry = v.getUint32(p + 8);
    const hot = v.getUint32(p + 12);
    const type = v.getUint8(p + 16);
    const time = v.getUint32(p + 20);
    const loop = v.getUint32(p + 24);
    let comment = '';
    let color = null;
    if (lenEntry > 44) {
      const lc = v.getUint32(p + 40);
      comment = utf16be(v, p + 44, lc);
      if (lenEntry >= 48 + lc) {
        const r = v.getUint8(p + 45 + lc);
        const g = v.getUint8(p + 46 + lc);
        const b = v.getUint8(p + 47 + lc);
        if (v.getUint8(p + 44 + lc) !== 0 || r || g || b) color = rgbHex(r, g, b);
      }
    }
    cues.push(cue(hot, type, time, loop, comment, color));
    p += lenEntry;
  }
  return cues;
}

function cue(hot, type, timeMs, loopMs, name, color) {
  const c = {
    kind: hot > 0 ? 'hot' : 'memory',
    time: timeMs / 1000,
    name,
    color,
  };
  if (hot > 0) c.slot = hot - 1;
  if (type === 2 && loopMs !== 0xffffffff && loopMs > timeMs) c.end = loopMs / 1000;
  return c;
}

export function rgbHex(r, g, b) {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function tag(v, off) {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
}

function utf16be(v, off, len) {
  const n = Math.max(0, Math.min(len, v.byteLength - off));
  return new TextDecoder('utf-16be').decode(new Uint8Array(v.buffer, v.byteOffset + off, n)).replace(/\0+$/, '');
}
