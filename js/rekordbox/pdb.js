// Reader for rekordbox "Device Library" exports: PIONEER/rekordbox/export.pdb,
// the database a CDJ reads from a USB stick.
//
// Format notes come from the reverse-engineering work of Deep Symmetry
// (https://djl-analysis.deepsymmetry.org/) and the rekordcrate project.
// Everything is little-endian. The file is a list of fixed-size pages; each
// table is a linked list of pages, and each page holds rows addressed through
// an index that grows backwards from the end of the page.

const T = {
  TRACKS: 0,
  GENRES: 1,
  ARTISTS: 2,
  ALBUMS: 3,
  LABELS: 4,
  KEYS: 5,
  COLORS: 6,
  PLAYLIST_TREE: 7,
  PLAYLIST_ENTRIES: 8,
  ARTWORK: 13,
};

const HEAP_START = 0x28;

export function parsePdb(arrayBuffer) {
  const v = new DataView(arrayBuffer);
  const lenPage = v.getUint32(4, true);
  const numTables = v.getUint32(8, true);
  if (lenPage < 512 || lenPage > 65536 || numTables > 64) throw new Error('Not a rekordbox export.pdb');
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const o = 28 + i * 16;
    tables.set(v.getUint32(o, true), { type: v.getUint32(o, true), firstPage: v.getUint32(o + 8, true), lastPage: v.getUint32(o + 12, true) });
  }

  const rows = (type) => {
    const t = tables.get(type);
    return t ? tableRows(v, lenPage, t) : [];
  };
  const named = (type, idOff, nameOff) => {
    const m = new Map();
    for (const p of rows(type)) m.set(v.getUint32(p + idOff, true), dstr(v, p + nameOff));
    return m;
  };

  const genres = named(T.GENRES, 0, 4);
  const labels = named(T.LABELS, 0, 4);
  const keys = named(T.KEYS, 0, 8);
  const artwork = named(T.ARTWORK, 0, 4);

  const colors = new Map();
  for (const p of rows(T.COLORS)) colors.set(v.getUint16(p + 5, true), dstr(v, p + 8));

  const artists = new Map();
  for (const p of rows(T.ARTISTS)) {
    const sub = v.getUint16(p, true);
    const ofs = sub === 0x64 ? v.getUint16(p + 10, true) : v.getUint8(p + 9);
    artists.set(v.getUint32(p + 4, true), dstr(v, p + ofs));
  }

  const albums = new Map();
  for (const p of rows(T.ALBUMS)) {
    const sub = v.getUint16(p, true);
    const ofs = sub === 0x84 ? v.getUint16(p + 22, true) : v.getUint8(p + 21);
    albums.set(v.getUint32(p + 12, true), { name: dstr(v, p + ofs), artistId: v.getUint32(p + 8, true) });
  }

  const tracks = [];
  for (const p of rows(T.TRACKS)) {
    const s = (i) => dstr(v, p + v.getUint16(p + 0x5e + 2 * i, true));
    const tempo = v.getUint32(p + 56, true);
    const album = albums.get(v.getUint32(p + 64, true));
    tracks.push({
      id: v.getUint32(p + 72, true),
      title: s(17),
      artist: artists.get(v.getUint32(p + 68, true)) || '',
      album: album ? album.name : '',
      genre: genres.get(v.getUint32(p + 60, true)) || '',
      label: labels.get(v.getUint32(p + 40, true)) || '',
      remixer: artists.get(v.getUint32(p + 44, true)) || '',
      key: keys.get(v.getUint32(p + 32, true)) || '',
      color: colors.get(v.getUint8(p + 88)) || '',
      rating: v.getUint8(p + 89),
      bpm: tempo ? tempo / 100 : null,
      duration: v.getUint16(p + 84, true),
      sampleRate: v.getUint32(p + 8, true),
      bitrate: v.getUint32(p + 48, true),
      year: v.getUint16(p + 80, true) || null,
      fileSize: v.getUint32(p + 16, true),
      artwork: artwork.get(v.getUint32(p + 28, true)) || '',
      comment: s(16),
      mixName: s(12),
      dateAdded: s(10),
      analyzePath: s(14),
      fileName: s(19),
      filePath: s(20),
    });
  }

  const playlists = new Map();
  for (const p of rows(T.PLAYLIST_TREE)) {
    const id = v.getUint32(p + 12, true);
    playlists.set(id, {
      id,
      parentId: v.getUint32(p, true),
      order: v.getUint32(p + 8, true),
      isFolder: v.getUint32(p + 16, true) !== 0,
      name: dstr(v, p + 20),
      entries: [],
    });
  }
  for (const p of rows(T.PLAYLIST_ENTRIES)) {
    const pl = playlists.get(v.getUint32(p + 8, true));
    if (pl) pl.entries.push([v.getUint32(p, true), v.getUint32(p + 4, true)]);
  }
  const playlistList = [...playlists.values()].map((pl) => {
    pl.entries.sort((a, b) => a[0] - b[0]);
    const trackIds = pl.entries.map((e) => e[1]);
    delete pl.entries;
    return { ...pl, trackIds };
  });
  playlistList.sort((a, b) => a.parentId - b.parentId || a.order - b.order);

  return { tracks, playlists: playlistList };
}

/** Absolute offsets of every present row in a table. */
function tableRows(v, lenPage, table) {
  const out = [];
  const seen = new Set();
  let page = table.firstPage;
  for (;;) {
    const base = page * lenPage;
    if (seen.has(page) || base + lenPage > v.byteLength) break;
    seen.add(page);
    const type = v.getUint32(base + 8, true);
    const flags = v.getUint8(base + 27);
    if (type === table.type && (flags & 0x40) === 0) {
      // Bytes 0x18-0x1a pack two counters: 13 bits of row offsets, 11 bits of rows.
      const numOffsets = (v.getUint8(base + 0x18) | (v.getUint8(base + 0x19) << 8)) & 0x1fff;
      const groups = Math.ceil(numOffsets / 16);
      for (let g = 0; g < groups; g++) {
        const gb = base + lenPage - g * 0x24;
        const present = v.getUint16(gb - 4, true);
        const inGroup = Math.min(16, numOffsets - g * 16);
        for (let r = 0; r < inGroup; r++) {
          if (!((present >> r) & 1)) continue;
          const ofs = v.getUint16(gb - 6 - 2 * r, true);
          const p = base + HEAP_START + ofs;
          if (p < base + lenPage) out.push(p);
        }
      }
    }
    if (page === table.lastPage) break;
    page = v.getUint32(base + 12, true);
  }
  return out;
}

/** DeviceSQL string. */
function dstr(v, p) {
  if (p >= v.byteLength) return '';
  const kind = v.getUint8(p);
  if (kind === 0x40 || kind === 0x90) {
    const len = v.getUint16(p + 1, true) - 4;
    if (len <= 0) return '';
    const bytes = new Uint8Array(v.buffer, v.byteOffset + p + 4, Math.min(len, v.byteLength - p - 4));
    if (kind === 0x90) {
      if (bytes[0] === 0x03) return latin1(bytes.subarray(1)).replace(/\0+$/, ''); // ISRC quirk
      return new TextDecoder('utf-16le').decode(bytes).replace(/\0+$/, '');
    }
    return latin1(bytes);
  }
  if (kind & 1) {
    const len = (kind >> 1) - 1;
    if (len <= 0) return '';
    return latin1(new Uint8Array(v.buffer, v.byteOffset + p + 1, len));
  }
  return '';
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
