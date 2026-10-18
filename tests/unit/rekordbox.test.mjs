// rekordbox import tests.
//
// The real exports come from the rekordcrate project's test data
// (https://github.com/Holzhaus/rekordcrate, data/). They are downloaded on
// demand into tests/fixtures/rekordcrate (git-ignored); tests that need them
// are skipped when offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePdb } from '../../js/rekordbox/pdb.js';
import { parseAnlz } from '../../js/rekordbox/anlz.js';
import { parseRekordboxXml, locationToPath } from '../../js/rekordbox/xml.js';
import { Library } from '../../js/library/Library.js';
import { MemoryStore } from '../../js/library/LibraryStore.js';
import { BeatGrid } from '../../js/shared/BeatGrid.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, '..', 'fixtures', 'rekordcrate');
const RAW = 'https://raw.githubusercontent.com/Holzhaus/rekordcrate/main/data/';
const FILES = [
  'complete_export/demo_tracks/PIONEER/rekordbox/export.pdb',
  'complete_export/demo_tracks/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT',
  'complete_export/demo_tracks/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.EXT',
  'complete_export/demo_tracks/PIONEER/USBANLZ/P053/0001D21F/ANLZ0000.DAT',
  'complete_export/demo_tracks/PIONEER/USBANLZ/P053/0001D21F/ANLZ0000.EXT',
  'pdb/num_rows/export.pdb',
];

async function fixtures() {
  try {
    for (const f of FILES) {
      const dest = join(FIX, f);
      if (existsSync(dest)) continue;
      const r = await fetch(RAW + f);
      if (!r.ok) throw new Error(`${r.status} ${f}`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    }
    return true;
  } catch (e) {
    console.warn('rekordbox fixtures unavailable:', e.message);
    return false;
  }
}
const online = await fixtures();
const skip = !online && 'fixtures not downloadable';

function ab(path) {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Stand-in for a browser File picked from a folder. */
function fakeFile(relPath, bytes) {
  const blob = new Blob([bytes]);
  return Object.assign(blob, { name: relPath.split('/').pop(), webkitRelativePath: relPath });
}

test('reads the demo USB export', { skip }, () => {
  const pdb = parsePdb(ab(join(FIX, FILES[0])));
  assert.equal(pdb.tracks.length, 2);
  const t = pdb.tracks.find((x) => x.title === 'Demo Track 1');
  assert.equal(t.artist, 'Loopmasters');
  assert.equal(t.bpm, 128);
  assert.equal(t.key, 'Fm');
  assert.equal(t.duration, 172);
  assert.equal(t.filePath, '/Contents/Loopmasters/UnknownAlbum/Demo Track 1.mp3');
  assert.equal(t.analyzePath, '/PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT');
});

test('reads a large export with >256 rows per page', { skip }, () => {
  const pdb = parsePdb(ab(join(FIX, FILES[5])));
  assert.equal(pdb.tracks.length, 3886);
  const ids = new Set(pdb.tracks.map((t) => t.id));
  const lists = pdb.playlists.filter((p) => !p.isFolder);
  const entries = lists.flatMap((p) => p.trackIds);
  assert.equal(entries.length, 7440);
  assert.ok(entries.every((id) => ids.has(id)), 'every playlist entry points at a track');
  assert.ok(pdb.playlists.some((p) => p.isFolder && p.name === 'PBAR CURRENT'));
});

test('reads the ANLZ beat grid', { skip }, () => {
  const a = parseAnlz(ab(join(FIX, FILES[1])));
  assert.equal(a.path, '/Contents/Loopmasters/UnknownAlbum/Demo Track 1.mp3');
  assert.equal(a.beats.length, 368);
  assert.deepEqual(a.beats[0], { beat: 1, bpm: 128, time: 0.025 });
  assert.equal(a.beats[1].beat, 2);
  assert.ok(Math.abs(a.beats[1].time - a.beats[0].time - 60 / 128) < 0.002);
});

/** Builds a synthetic ANLZ file with cue sections, the way rekordbox lays them out. */
function synthAnlz({ ext }) {
  const parts = [];
  const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const be16 = (n) => [(n >>> 8) & 255, n & 255];
  const str = (s) => [...s].map((c) => c.charCodeAt(0));
  const section = (tag, header, body) => [...str(tag), ...be32(12 + header.length), ...be32(12 + header.length + body.length), ...header, ...body];
  if (!ext) {
    const pcpt = (hot, type, time, loop) => {
      const e = [...str('PCPT'), ...be32(0x1c), ...be32(0x38), ...be32(hot), ...be32(1), ...be32(0x10000), ...be16(0xffff), ...be16(0xffff), type, 0, ...be16(0x3e8), ...be32(time), ...be32(loop)];
      while (e.length < 0x38) e.push(0);
      return e;
    };
    const hot = [...pcpt(1, 1, 30000, 0xffffffff), ...pcpt(3, 2, 45000, 46875)];
    parts.push(section('PCOB', [...be32(1), 0, 0, ...be16(2), ...be32(0xffffffff)], hot));
    parts.push(section('PCOB', [...be32(0), 0, 0, ...be16(1), ...be32(0xffffffff)], pcpt(0, 1, 1000, 0xffffffff)));
  } else {
    const pcp2 = (hot, type, time, loop, name, rgb) => {
      const comment = [];
      for (const ch of name + '\0') comment.push(...be16(ch.charCodeAt(0)));
      const e = [...str('PCP2'), ...be32(0x10), 0, 0, 0, 0, ...be32(hot), type, 0, 0, 0, ...be32(time), ...be32(loop), 0, 0, 0, 0, 0, 0, 0, 0, ...be16(0), ...be16(0), ...be32(comment.length), ...comment, rgb ? 1 : 0, ...(rgb || [0, 0, 0])];
      const len = e.length;
      e.splice(8, 4, ...be32(len));
      return e;
    };
    const cues = [...pcp2(1, 1, 30000, 0xffffffff, 'Drop', [255, 0, 0]), ...pcp2(2, 2, 45000, 46875, 'Loop', [0, 255, 0])];
    parts.push(section('PCO2', [...be32(1), ...be16(2), 0, 0], cues));
    parts.push(section('PCO2', [...be32(0), ...be16(1), 0, 0], pcp2(0, 1, 1000, 0xffffffff, '', null)));
  }
  const body = parts.flat();
  const head = [...str('PMAI'), ...be32(28), ...be32(28 + body.length)];
  while (head.length < 28) head.push(0);
  return new Uint8Array([...head, ...body]).buffer;
}

test('reads hot cues and memory cues from .DAT (PCOB)', () => {
  const a = parseAnlz(synthAnlz({ ext: false }));
  assert.deepEqual(
    a.cues.map((c) => [c.kind, c.slot, c.time, c.end]),
    [
      ['hot', 0, 30, undefined],
      ['hot', 2, 45, 46.875],
      ['memory', undefined, 1, undefined],
    ],
  );
});

test('reads coloured, named cues from .EXT (PCO2)', () => {
  const a = parseAnlz(synthAnlz({ ext: true }));
  assert.equal(a.cues.length, 3);
  assert.deepEqual(a.cues[0], { kind: 'hot', slot: 0, time: 30, name: 'Drop', color: '#ff0000' });
  assert.equal(a.cues[1].end, 46.875);
  assert.equal(a.cues[1].color, '#00ff00');
  assert.equal(a.cues[2].kind, 'memory');
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.8.5" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="11" Name="Night &amp; Day" Artist="Some Artist" Album="LP" Genre="House" Kind="MP3 File" Size="1234567" TotalTime="300" AverageBpm="124.00" Tonality="8A" Rating="153" Colour="0xFF007F" Location="file://localhost/Users/me/Music/Night%20%26%20Day.mp3">
      <TEMPO Inizio="0.104" Bpm="124.00" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="" Type="0" Start="0.104" Num="-1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="62.040" Num="0" Red="40" Green="226" Blue="20"/>
      <POSITION_MARK Name="Roll" Type="4" Start="93.008" End="94.943" Num="3" Red="255" Green="140" Blue="0"/>
    </TRACK>
    <TRACK TrackID="12" Name="Tempo Change" Artist="Live Band" Size="999" TotalTime="200" AverageBpm="100.00" Location="file://localhost/C:/Music/live.flac">
      <TEMPO Inizio="0.5" Bpm="100.00" Metro="4/4" Battito="1"/>
      <TEMPO Inizio="60.5" Bpm="120.00" Metro="4/4" Battito="1"/>
    </TRACK>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT" Count="2">
      <NODE Name="Friday" Type="0" Count="1">
        <NODE Name="Warmup" Type="1" KeyType="0" Entries="2">
          <TRACK Key="12"/>
          <TRACK Key="11"/>
        </NODE>
      </NODE>
      <NODE Name="By location" Type="1" KeyType="1" Entries="1">
        <TRACK Key="file://localhost/Users/me/Music/Night%20%26%20Day.mp3"/>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

test('parses rekordbox XML: tracks, grid, cues, playlists', () => {
  const x = parseRekordboxXml(XML);
  assert.equal(x.tracks.length, 2);
  const t = x.tracks[0];
  assert.equal(t.title, 'Night & Day');
  assert.equal(t.fileName, 'Night & Day.mp3');
  assert.equal(t.bpm, 124);
  assert.equal(t.rating, 3);
  assert.equal(t.color, '#ff007f');
  assert.deepEqual(t.grid, { type: 'constant', bpm: 124, first: 0.104, firstBeatInBar: 1 });
  assert.equal(t.cues.length, 3);
  assert.deepEqual(t.cues[1], { kind: 'hot', time: 62.04, name: 'Drop', color: '#28e214', slot: 0 });
  assert.equal(t.cues[2].end, 94.943);
  assert.equal(x.tracks[1].grid.type, 'beats');
  assert.equal(x.tracks[1].filePath, 'C:/Music/live.flac');
  const g = BeatGrid.fromSpec(x.tracks[1].grid, 1000, 200000);
  assert.ok(Math.abs(g.bpmAt(30000, 1000) - 100) < 1e-6);
  assert.ok(Math.abs(g.bpmAt(90000, 1000) - 120) < 1e-6);
  assert.deepEqual(
    x.playlists.map((p) => [p.name, p.isFolder, p.keys.length]),
    [
      ['Friday', true, 0],
      ['Warmup', false, 2],
      ['By location', false, 1],
    ],
  );
  assert.equal(locationToPath('file://localhost/Users/a%20b/c.mp3'), '/Users/a b/c.mp3');
});

test('library: XML import, then the audio files re-link by name and size', async () => {
  const lib = new Library(new MemoryStore());
  await lib.load();
  const xmlFile = Object.assign(new Blob([XML]), { name: 'rekordbox.xml' });
  const r1 = await lib.addFiles([xmlFile]);
  assert.equal(r1.rekordbox, 2);
  assert.equal(lib.tracks.size, 2);
  assert.ok([...lib.tracks.values()].every((t) => t.audio === 'missing'));
  const warm = [...lib.playlists.values()].find((p) => p.name === 'Warmup');
  assert.deepEqual(
    warm.trackIds.map((id) => lib.tracks.get(id).title),
    ['Tempo Change', 'Night & Day'],
  );
  const folder = [...lib.playlists.values()].find((p) => p.name === 'Friday');
  assert.equal(warm.parentId, folder.id);

  const audio = Object.assign(new Blob([new Uint8Array(1234567)]), { name: 'Night & Day.mp3' });
  const r2 = await lib.addFiles([audio]);
  assert.equal(r2.linked, 1);
  assert.equal(r2.added, 0);
  const t = [...lib.tracks.values()].find((x) => x.title === 'Night & Day');
  assert.equal(t.audio, 'stored');
  assert.ok(await lib.getAudio(t.id));
  assert.equal(t.cues.length, 3);

  // Re-importing the XML updates instead of duplicating.
  await lib.addFiles([xmlFile]);
  assert.equal(lib.tracks.size, 2);
  assert.equal(lib.query('night').length, 1);
  assert.equal(lib.query('124').length, 1);
});

test('library: importing a whole USB stick folder', { skip }, async () => {
  const root = 'MYUSB/';
  const files = [
    fakeFile(root + 'PIONEER/rekordbox/export.pdb', readFileSync(join(FIX, FILES[0]))),
    fakeFile(root + 'PIONEER/USBANLZ/P016/0000875E/ANLZ0000.DAT', readFileSync(join(FIX, FILES[1]))),
    fakeFile(root + 'PIONEER/USBANLZ/P016/0000875E/ANLZ0000.EXT', readFileSync(join(FIX, FILES[2]))),
    fakeFile(root + 'Contents/Loopmasters/UnknownAlbum/Demo Track 1.mp3', new Uint8Array(1000)),
  ];
  const lib = new Library(new MemoryStore());
  await lib.load();
  const r = await lib.addFiles(files);
  assert.equal(r.rekordbox, 2);
  assert.deepEqual(r.failed, []);
  const t1 = [...lib.tracks.values()].find((t) => t.title === 'Demo Track 1');
  const t2 = [...lib.tracks.values()].find((t) => t.title === 'Demo Track 2');
  assert.equal(t1.audio, 'stored');
  assert.equal(t2.audio, 'missing');
  assert.equal(t1.gridSource, 'rekordbox');
  assert.equal(t1.grid.times.length, 368);
  assert.equal(t1.grid.times[0], 0.025);
  assert.equal(t2.grid, null, 'no ANLZ files for track 2 in this pick');
});
