// End-to-end test: drives the real app in headless Chromium.
//
//   node tests/e2e/run.mjs            run the checks
//   node tests/e2e/run.mjs --shots    also save screenshots to test-results/
//
// Needs ffmpeg (to make test audio) and Playwright. rekordbox fixtures come
// from tests/fixtures/rekordcrate (downloaded by `npm test`).

import { createServer } from 'node:http';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = process.argv.includes('--shots');
const OUT = join(ROOT, 'test-results');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const g = execSync('npm root -g').toString().trim();
    return import(join(g, 'playwright', 'index.mjs'));
  }
}

// ---------------------------------------------------------------- static server

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};
function serve() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = join(ROOT, p);
      if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------------------------------------------------------------- fixtures

const BPM = 128;
const dir = mkdtempSync(join(tmpdir(), 'tdj-e2e-'));
function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
}
// Kick on every beat from 0.2 s, an off-beat noise hat, and a quiet bass tone.
const spb = 60 / BPM;
const expr = `0.7*sin(2*PI*55*t)*exp(-25*mod(t-0.2,${spb}))*gte(t,0.2)+0.15*(random(0)-0.5)*exp(-90*mod(t-0.2-${spb / 2},${spb}))*gte(t,0.2+${spb / 2})+0.05*sin(2*PI*220*t)`;
const master = join(dir, 'master.wav');
ffmpeg(['-f', 'lavfi', '-i', `aevalsrc='${expr}|${expr}':s=44100:d=45`, '-c:a', 'pcm_s16le', master]);
const formats = [
  ['mp3', ['-c:a', 'libmp3lame', '-b:a', '192k']],
  ['flac', ['-c:a', 'flac']],
  ['m4a', ['-c:a', 'aac', '-b:a', '160k']],
  ['alac.m4a', ['-c:a', 'alac']],
  ['aiff', ['-c:a', 'pcm_s16be']],
  ['wav', ['-c:a', 'pcm_s24le']],
  ['ogg', ['-c:a', 'libvorbis', '-q:a', '4']],
  ['opus', ['-c:a', 'libopus', '-b:a', '128k']],
];
const audioFiles = formats.map(([ext, args], i) => {
  const f = join(dir, `Test Artist - Track ${String(i + 1).padStart(2, '0')} (${ext}).${ext.endsWith('.m4a') ? 'm4a' : ext}`);
  ffmpeg(['-i', master, ...args, f]);
  return f;
});

// A rekordbox USB stick: the demo export plus an audio file where the database expects it.
const FIX = join(ROOT, 'tests', 'fixtures', 'rekordcrate', 'complete_export', 'demo_tracks');
const usb = join(dir, 'USB');
const haveUsb = existsSync(join(FIX, 'PIONEER', 'rekordbox', 'export.pdb'));
if (haveUsb) {
  cpSync(join(FIX, 'PIONEER'), join(usb, 'PIONEER'), { recursive: true });
  const track = join(usb, 'Contents', 'Loopmasters', 'UnknownAlbum', 'Demo Track 1.mp3');
  mkdirSync(dirname(track), { recursive: true });
  ffmpeg(['-i', master, '-c:a', 'libmp3lame', '-b:a', '192k', track]);
}

// An XML export that adds cues to one of the plain files (matched by name + size).
const mp3 = audioFiles[0];
const mp3Name = mp3.split('/').pop();
const xmlPath = join(dir, 'rekordbox.xml');
writeFileSync(
  xmlPath,
  `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="6.8.5"/>
<COLLECTION Entries="1">
<TRACK TrackID="1" Name="Prepared In Rekordbox" Artist="Test Artist" Size="${statSync(mp3).size}" TotalTime="45" AverageBpm="128.00" Tonality="8A" Location="file://localhost/Music/${encodeURIComponent(mp3Name)}">
<TEMPO Inizio="0.200" Bpm="128.00" Metro="4/4" Battito="1"/>
<POSITION_MARK Name="" Type="0" Start="3.950" Num="-1"/>
<POSITION_MARK Name="Drop" Type="0" Start="15.200" Num="0" Red="40" Green="226" Blue="20"/>
<POSITION_MARK Name="Roll" Type="4" Start="20.200" End="22.075" Num="2" Red="255" Green="140" Blue="0"/>
</TRACK></COLLECTION>
<PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Name="Gig" Type="1" KeyType="0" Entries="1"><TRACK Key="1"/></NODE></NODE></PLAYLISTS>
</DJ_PLAYLISTS>`,
);

// ---------------------------------------------------------------- run

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const { chromium } = await loadPlaywright();
const srv = await serve();
const url = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
if (SHOTS) mkdirSync(OUT, { recursive: true });
const shot = async (name) => SHOTS && page.screenshot({ path: join(OUT, `${name}.png`) });
const wait = (ms) => page.waitForTimeout(ms);
const evalApp = (fn, arg) => page.evaluate(fn, arg);

try {
  await page.goto(url);
  await page.click('.start-btn');
  await page.waitForSelector('.topbar');
  check('app starts', true);
  await shot('01-help');
  await page.click('.help .btn.close');

  // ---- import plain files
  await page.setInputFiles('.browser input[type=file][accept^="audio"]', audioFiles);
  await page.waitForFunction((n) => window.tdj.library.tracks.size === n, audioFiles.length, { timeout: 30000 });
  check('imports audio files', true, `${audioFiles.length} files`);
  await shot('02-library');

  // ---- every format decodes, analyses at ~128 BPM
  const ids = await evalApp(() => [...window.tdj.library.tracks.values()].sort((a, b) => a.fileName.localeCompare(b.fileName)).map((t) => [t.id, t.fileName]));
  for (const [id, name] of ids) {
    const r = await evalApp(async (id) => {
      const app = window.tdj;
      const d = app.decks[0];
      await app.loadTrack(0, app.library.tracks.get(id));
      const t0 = performance.now();
      while (!d.wave && !d.error && performance.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
      return { error: d.error, decoder: d.decoder, seconds: d.length / d.sr, bpm: d.grid ? d.grid.bpmAt(d.sr * 10, d.sr) : null, first: d.grid ? d.grid.frames[0] / d.sr : null };
    }, id);
    const phase = r.first !== null ? (((r.first - 0.2) / spb) % 1 + 1) % 1 : null;
    const phaseMs = phase === null ? NaN : Math.min(phase, 1 - phase) * spb * 1000;
    const ok = !r.error && Math.abs(r.seconds - 45) < 0.2 && r.bpm && Math.abs(r.bpm - BPM) < 0.05;
    check(`decode + analyse ${name}`, ok, r.error || `${r.decoder}, ${r.seconds.toFixed(2)} s, ${r.bpm && r.bpm.toFixed(3)} BPM, grid ${phaseMs.toFixed(1)} ms off (codec delay included)`);
  }

  // ---- XML import merges cues onto the existing mp3
  await page.setInputFiles('.browser input[type=file][accept^=".xml"]', xmlPath);
  await page.waitForFunction(() => [...window.tdj.library.tracks.values()].some((t) => t.title === 'Prepared In Rekordbox'), null, { timeout: 15000 });
  const merged = await evalApp(() => {
    const lib = window.tdj.library;
    const t = [...lib.tracks.values()].find((x) => x.title === 'Prepared In Rekordbox');
    return { count: lib.tracks.size, cues: t.cues.length, audio: t.audio, playlists: [...lib.playlists.values()].map((p) => p.name) };
  });
  check('rekordbox XML merges onto the existing file', merged.count === audioFiles.length && merged.cues === 3 && merged.audio === 'stored', JSON.stringify(merged));

  // ---- USB stick import
  if (haveUsb) {
    await page.setInputFiles('.browser input[type=file]:not([accept])', usb);
    await page.waitForFunction(() => [...window.tdj.library.tracks.values()].some((t) => t.title === 'Demo Track 1' && t.audio !== 'missing'), null, { timeout: 30000 }).catch(() => {});
    const u = await evalApp(() => {
      const t = [...window.tdj.library.tracks.values()].find((x) => x.title === 'Demo Track 1');
      return { audio: t.audio, gridSource: t.gridSource, beats: t.grid && t.grid.times.length, bpm: t.bpm, key: t.key };
    });
    check('rekordbox USB folder import', u.audio === 'stored' && u.gridSource === 'rekordbox' && u.beats === 368 && u.key === 'Fm', JSON.stringify(u));
  } else {
    check('rekordbox USB folder import', true, 'skipped: run npm test first to download fixtures');
  }
  await page.click('.browser .btn.close');

  // ---- two decks: load, play, cue, sync
  const loaded = await evalApp(async () => {
    const app = window.tdj;
    const lib = app.library;
    const find = (q) => [...lib.tracks.values()].find((t) => t.fileName.includes(q) || t.title === q);
    await app.loadTrack(0, find('Prepared In Rekordbox'));
    await app.loadTrack(1, find('(flac)'));
    const t0 = performance.now();
    while ((!app.decks[0].wave || !app.decks[1].wave) && performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
    const a = app.decks[0];
    return { cueAt: a.cuePoint / a.sr, hot: a.hotCues.filter(Boolean).length, gridSource: a.track.gridSource };
  });
  check('loads to the first memory cue, rekordbox hot cues present', Math.abs(loaded.cueAt - 3.95) < 0.01 && loaded.hot === 2, JSON.stringify(loaded));

  await page.click('.panel-a .transport.play');
  await page.click('.panel-b .transport.play');
  await wait(1500);
  const playing = await evalApp(() => window.tdj.decks.map((d) => ({ playing: d.playing, pos: d.pos / d.sr })));
  check('both decks play', playing.every((p) => p.playing && p.pos > 0.8), JSON.stringify(playing));
  await shot('03-two-decks-playing');

  // Sync deck B to A and check the phase meter.
  await page.click('.panel-b .r-modes .btn:nth-child(1)');
  await wait(1500);
  const phaseMs = await evalApp(() => {
    const e = window.tdj.phase.offset();
    return (e * 60000) / window.tdj.decks[0].bpm;
  });
  check('SYNC locks deck B to deck A', Math.abs(phaseMs) < 3, `${phaseMs.toFixed(2)} ms`);
  // Only one deck can follow: syncing A releases B.
  await page.click('.panel-a .r-modes .btn:nth-child(1)');
  const flags = await evalApp(() => window.tdj.decks.map((d) => d.sync));
  check('SYNC on A releases B', flags[0] === true && flags[1] === false, JSON.stringify(flags));
  await page.click('.panel-a .r-modes .btn:nth-child(1)'); // sync off

  // ---- The Tape: a 20 px drag on deck A while playing = phase push
  const pushed = await evalApp(async () => {
    const app = window.tdj;
    const a = app.decks[0];
    const tape = app.views[0].tape;
    const r = tape.canvas.getBoundingClientRect();
    const expect = (-20 / tape.pxPerFrame) / a.sr; // seconds
    const before = app.phase.offset();
    const fire = (type, x) =>
      tape.canvas.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: r.top + r.height / 2, bubbles: true, isPrimary: true }));
    const x0 = r.left + r.width / 2;
    fire('pointerdown', x0);
    for (let i = 1; i <= 4; i++) {
      await new Promise((res) => setTimeout(res, 16));
      fire('pointermove', x0 + i * 5);
    }
    fire('pointerup', x0 + 20);
    await new Promise((res) => setTimeout(res, 1500));
    const after = app.phase.offset();
    const spb = 60 / a.bpm;
    let moved = (after - before) * spb; // B-A offset grows when A falls back
    if (moved > spb / 2) moved -= spb;
    if (moved < -spb / 2) moved += spb;
    return { expect, moved };
  });
  check('Tape push moves deck A by the dragged amount', Math.abs(pushed.moved - Math.abs(pushed.expect)) < 0.006, `expected ${(Math.abs(pushed.expect) * 1000).toFixed(1)} ms, moved ${(pushed.moved * 1000).toFixed(1)} ms`);

  // ---- hot cue, loop, CUE
  const cueTest = await evalApp(async () => {
    const app = window.tdj;
    const a = app.decks[0];
    a.hotCue(0); // "Drop" at 15.2 s
    await new Promise((r) => setTimeout(r, 300));
    const afterHot = a.pos / a.sr;
    a.autoLoop();
    await new Promise((r) => setTimeout(r, 2500));
    const st = a.state;
    const inLoop = st.loopOn && a.pos >= st.loopIn && a.pos <= st.loopOut;
    const len = (st.loopOut - st.loopIn) / a.sr;
    a.autoLoop(); // exit
    a.cueDown(); // back cue (playing)
    a.cueUp();
    await new Promise((r) => setTimeout(r, 300));
    return { afterHot, inLoop, len, stopped: !a.playing, back: a.pos / a.sr };
  });
  check('hot cue jumps (quantized)', cueTest.afterHot > 15.2 && cueTest.afterHot < 16.2, `${cueTest.afterHot.toFixed(3)} s`);
  check('4-beat auto loop holds the playhead', cueTest.inLoop && Math.abs(cueTest.len - 4 * spb) < 0.002, `${cueTest.len.toFixed(4)} s`);
  check('CUE while playing returns to the cue point and stops', cueTest.stopped && Math.abs(cueTest.back - 3.95) < 0.01, `${cueTest.back.toFixed(3)} s`);
  await page.click('.panel-b .transport.play'); // pause B

  // ---- scratch in vinyl mode while paused: drag moves playhead
  const scratch = await evalApp(async () => {
    const app = window.tdj;
    const a = app.decks[0];
    app.setVinyl(0, true);
    const tape = app.views[0].tape;
    const r = tape.canvas.getBoundingClientRect();
    const before = a.pos;
    const fire = (type, x) => tape.canvas.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'touch', clientX: x, clientY: r.top + 20, bubbles: true }));
    const x0 = r.left + r.width / 2;
    fire('pointerdown', x0);
    for (let i = 1; i <= 10; i++) {
      await new Promise((res) => setTimeout(res, 16));
      fire('pointermove', x0 - i * 12);
    }
    await new Promise((res) => setTimeout(res, 400));
    fire('pointerup', x0 - 120);
    await new Promise((res) => setTimeout(res, 300));
    app.setVinyl(0, false);
    return { moved: (a.pos - before) / a.sr, expect: 120 / tape.pxPerFrame / a.sr };
  });
  check('Tape scratch follows the finger', Math.abs(scratch.moved - scratch.expect) < 0.02, `expected ${scratch.expect.toFixed(3)} s, moved ${scratch.moved.toFixed(3)} s`);

  // ---- layouts
  if (SHOTS) {
    await page.click('.panel-a .transport.play');
    await wait(500);
    for (const [w, h, name] of [
      [1180, 820, 'ipad-air-landscape'],
      [1024, 768, 'ipad-landscape'],
      [1280, 800, 'android-landscape'],
      [1366, 1024, 'ipad-pro-landscape'],
      [820, 1180, 'ipad-portrait'],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await wait(400);
      await shot(`10-${name}-${w}x${h}`);
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.click('.seg .tb:nth-child(1)'); // 1 deck
    await wait(400);
    await shot('11-one-deck');
    await page.click('.seg .tb:nth-child(2)');
    await page.click('.panel-a .transport.play');
    await page.click('.lib-btn');
    await wait(300);
    await shot('12-library-with-playlists');
    await page.click('.browser .btn.close');
    await page.click('.topbar button[title=Settings]');
    await wait(300);
    await shot('13-settings');
    await page.click('.overlay:not(.hidden) .btn.close');
    await page.click('.deck-a .dh-menu');
    await wait(200);
    await shot('14-deck-menu');
    await page.click('.menu-backdrop');
  }

  // Layout sanity: nothing overflows the viewport at common tablet sizes.
  for (const [w, h] of [
    [1180, 820],
    [1024, 768],
    [1280, 800],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await wait(300);
    const lay = await evalApp(() => {
      const tapes = [...document.querySelectorAll('.tape')].map((c) => c.getBoundingClientRect().height);
      const ctl = document.querySelector('.controls').getBoundingClientRect();
      const btns = [...document.querySelectorAll('.controls button')].filter((b) => b.offsetParent);
      const small = btns.filter((b) => b.getBoundingClientRect().height < 30 || b.getBoundingClientRect().width < 30).length;
      return { tapes, bottom: ctl.bottom, vh: innerHeight, scrollW: document.documentElement.scrollWidth, vw: innerWidth, small };
    });
    check(`layout ${w}x${h}`, lay.bottom <= lay.vh + 1 && lay.tapes.every((t) => t >= 56) && lay.scrollW <= lay.vw && lay.small === 0, JSON.stringify(lay));
  }

  const relevant = errors.filter((e) => !/favicon/i.test(e));
  check('no errors in the console', relevant.length === 0, relevant.slice(0, 5).join(' | '));
} catch (e) {
  check('unexpected exception', false, e.stack);
} finally {
  await browser.close();
  srv.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
