import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePcm } from '../../js/decode/pcm.js';
import { readTags } from '../../js/decode/tags.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const dir = mkdtempSync(join(tmpdir(), 'tdj-'));

function make(name, args) {
  const out = join(dir, name);
  if (!existsSync(out)) {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=1', ...args, out]);
  }
  return out;
}

/** Minimal File stand-in for Node (readTags only uses name, size, slice()). */
function fileFrom(path) {
  const buf = readFileSync(path);
  const blob = new Blob([buf]);
  return Object.assign(blob, { name: path.split('/').pop() });
}

const formats = [
  ['s16.wav', ['-c:a', 'pcm_s16le']],
  ['s24.wav', ['-c:a', 'pcm_s24le']],
  ['f32.wav', ['-c:a', 'pcm_f32le']],
  ['u8.wav', ['-c:a', 'pcm_u8']],
  ['s16.aiff', ['-c:a', 'pcm_s16be']],
  ['s24.aiff', ['-c:a', 'pcm_s24be']],
  ['sowt.aifc', ['-c:a', 'pcm_s16le', '-f', 'aiff']],
];

for (const [name, args] of formats) {
  test(`parses ${name}`, { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
    const path = make(name, ['-ac', '2', ...args]);
    const buf = readFileSync(path);
    const pcm = parsePcm(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.ok(pcm, 'recognised');
    assert.equal(pcm.sampleRate, 44100);
    assert.equal(pcm.channels.length, 2);
    assert.ok(Math.abs(pcm.length - 44100) < 2, `length ${pcm.length}`);
    // ffmpeg's sine source has amplitude 1/8, and the mono->stereo upmix is -3 dB
    let peak = 0;
    for (const s of pcm.channels[0]) peak = Math.max(peak, Math.abs(s));
    assert.ok(Math.abs(peak - 0.125 * Math.SQRT1_2) < 0.008, `peak ${peak}`);
  });
}

const meta = ['-metadata', 'title=Test Title', '-metadata', 'artist=Test Artist', '-metadata', 'album=LP', '-metadata', 'genre=House'];

const tagged = [
  ['tags.mp3', ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3', '-metadata', 'TBPM=128', '-metadata', 'TKEY=8A', ...meta]],
  ['tags24.mp3', ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '4', ...meta]],
  ['tags.flac', ['-c:a', 'flac', '-metadata', 'BPM=128', '-metadata', 'INITIALKEY=8A', ...meta]],
  ['tags.m4a', ['-c:a', 'aac', '-b:a', '96k', ...meta]],
  ['tags.aiff', ['-c:a', 'pcm_s16be', '-write_id3v2', '1', ...meta]],
  ['tags.wav', ['-c:a', 'pcm_s16le', ...meta]],
];

for (const [name, args] of tagged) {
  test(`reads tags from ${name}`, { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    const t = await readTags(fileFrom(make(name, args)));
    assert.equal(t.title, 'Test Title');
    assert.equal(t.artist, 'Test Artist');
    if (!name.endsWith('.wav')) assert.equal(t.album, 'LP');
    if (name === 'tags.mp3' || name === 'tags.flac') {
      assert.equal(t.bpm, 128);
      assert.equal(t.key, '8A');
    }
    if (name.endsWith('.flac') || name.endsWith('.m4a') || name.endsWith('.aiff') || name.endsWith('.wav')) {
      assert.ok(Math.abs(t.duration - 1) < 0.05, `duration ${t.duration}`);
    }
  });
}

test('falls back to "Artist - Title" from the file name', async () => {
  const f = Object.assign(new Blob([new Uint8Array(100)]), { name: 'Some Artist - Some Track (Extended Mix).mp3' });
  const t = await readTags(f);
  assert.equal(t.artist, 'Some Artist');
  assert.equal(t.title, 'Some Track (Extended Mix)');
});
