import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Crm, DELETE_MARK, ticketNotes } from '../src/crm.js';
import { Drive } from '../src/drive.js';
import { LocalClip } from '../src/localclip.js';
import { createServer, makeSession, readSession } from '../src/server.js';
import { Store } from '../src/store.js';
import { Swiper } from '../src/swiper.js';
import { startFakes } from './fakes.js';

const FOLDER = 'application/vnd.google-apps.folder';
let fakes;
let dataDir;
let swiper;
let config;

const quiet = { error() {}, warn() {}, log() {} };

before(async () => {
  fakes = await startFakes();
  dataDir = mkdtempSync(path.join(tmpdir(), 'swiper-test-'));
  config = loadConfig({
    DATA_DIR: dataDir,
    APP_PASSWORD: 'team-pass',
    SESSION_SECRET: 'x'.repeat(32),
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    GOOGLE_API_BASE: fakes.base,
    GOOGLE_TOKEN_URL: `${fakes.base}/token`,
    DRIVE_ROOT_FOLDER_ID: fakes.root,
    CRM_API_URL: fakes.base,
    CRM_LOGIN: 'swiper',
    CRM_PASSWORD: 'crm-pass',
    LOCALCLIP_API_URL: fakes.base,
    LOCALCLIP_BACKEND_AUTH_SECRET: 'lc-secret',
    LOCALCLIP_USER_ID: 'user-1',
    LOCALCLIP_POLL_MS: '200',
    LOCALCLIP_WAIT_MS: '50',
  });
  swiper = new Swiper({
    config,
    store: new Store(dataDir),
    drive: new Drive(config.google),
    crm: new Crm(config.crm),
    localclip: new LocalClip(config.localclip),
    log: quiet,
  });

  // Drive: root/to sort/sasavot/{минус-4,убили-угар,fps}.mp4 (montage/trash do not exist yet)
  const toSort = fakes.addFile({ name: 'to sort', mimeType: FOLDER, parent: fakes.root });
  const sasavot = fakes.addFile({ name: 'sasavot', mimeType: FOLDER, parent: toSort });
  for (const name of ['минус-4.mp4', 'убили-угар.mp4', 'fps.mp4']) {
    fakes.addFile({ name, parent: sasavot, content: Buffer.from(`video:${name}`) });
  }
  fakes.addFile({ name: 'notes.txt', mimeType: 'text/plain', parent: sasavot });
});

after(async () => {
  swiper?.stop();
  await fakes?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const byName = (name) => swiper.store.all().find((c) => c.name === name);
const settle = () => Promise.all([...swiper.crmChains.values()]);

test('sync picks up clips per streamer folder and opens a BACKLOG ticket for each', async () => {
  await swiper.sync();
  await settle();
  const state = swiper.state('');
  assert.deepEqual(state.queue.map((c) => c.name), ['минус-4.mp4', 'убили-угар.mp4', 'fps.mp4']);
  assert.ok(state.queue.every((c) => c.streamer === 'sasavot'));
  assert.deepEqual(state.streamers, [{ name: 'sasavot', new: 3, maybe: 0 }]);

  assert.equal(fakes.tickets.size, 3);
  const t = [...fakes.tickets.values()].find((x) => x.title === 'минус-4 (sasavot)');
  assert.equal(t.status, 'BACKLOG');
  assert.equal(t.streamer, 'sasavot');
  assert.match(t.sourceUrl, /^https:\/\/drive\.example\//);
  assert.match(t.notes, /Длительность: 0:47/);
  assert.match(t.notes, /на оценке/);

  // second sync: nothing new, no duplicate tickets
  await swiper.sync();
  await settle();
  assert.equal(fakes.tickets.size, 3);
});

test('swipe left moves the file to trash/<streamer> and marks the ticket for deletion', async () => {
  const clip = byName('fps.mp4');
  await swiper.decide(clip.id, 'left', 'Андрей');
  await settle();
  assert.equal(fakes.pathOf(clip.id), 'trash/sasavot/fps.mp4');
  const t = fakes.tickets.get(byName('fps.mp4').crmTicketId);
  assert.equal(t.title, `${DELETE_MARK} fps (sasavot)`);
  assert.equal(t.status, 'BACKLOG');
  assert.match(t.notes, /удалить → trash \(Андрей\)/);
});

test('undo brings a trashed clip back to "to sort" and clears the mark', async () => {
  const clip = byName('fps.mp4');
  await swiper.undo(clip.id, 'Андрей');
  await settle();
  assert.equal(fakes.pathOf(clip.id), 'to sort/sasavot/fps.mp4');
  assert.equal(fakes.tickets.get(clip.crmTicketId).title, 'fps (sasavot)');
  assert.equal(byName('fps.mp4').status, 'new');
});

test('maybe keeps the file in place and the ticket in BACKLOG', async () => {
  const clip = byName('убили-угар.mp4');
  await swiper.decide(clip.id, 'maybe', 'Андрей');
  await settle();
  assert.equal(fakes.pathOf(clip.id), 'to sort/sasavot/убили-угар.mp4');
  const state = swiper.state('');
  assert.deepEqual(state.maybe.map((c) => c.name), ['убили-угар.mp4']);
  assert.equal(fakes.tickets.get(clip.crmTicketId).status, 'BACKLOG');
  // a maybe clip can still be decided later
  await assert.rejects(swiper.decide(clip.id, 'bogus', 'x'), /action/);
});

test('swipe right: LocalClip renders, result lands in montage/<streamer>, ticket gets the videos and moves to UNIQUIFIED', async () => {
  const clip = byName('минус-4.mp4');
  await swiper.decide(clip.id, 'right', 'Андрей');
  assert.equal(byName('минус-4.mp4').status, 'queued');
  await swiper.montage(clip.id);
  await settle();

  const done = byName('минус-4.mp4');
  assert.equal(done.status, 'done');
  assert.equal(done.outputs.length, 1);
  const out = fakes.files.get(done.outputs[0].driveId);
  assert.equal(fakes.pathOf(out.id), 'montage/sasavot/минус-4.mp4');
  assert.equal(out.content.toString(), `rendered:${done.localclipTaskId}-c1`);
  // original moved out of "to sort"
  assert.equal(fakes.pathOf(clip.id), 'montage/sasavot/исходники/минус-4.mp4');

  const task = fakes.tasks.get(done.localclipTaskId);
  assert.match(task.body.source.url, /^upload:\/\//);
  assert.equal(task.body.output_format, 'vertical');
  // default swipe right = short edit: LocalClip cuts pauses and filler words
  assert.equal(task.body.cut_long_pauses, true);
  assert.equal(task.body.remove_filler_words, true);

  const t = fakes.tickets.get(done.crmTicketId);
  assert.equal(t.status, 'UNIQUIFIED');
  assert.deepEqual(t.videos.map((v) => v.url), [done.outputs[0].webViewLink]);
  assert.match(t.notes, /Смонтировано:/);
  assert.ok(t.notes.includes(done.outputs[0].webViewLink));
  assert.match(t.notes, /Угар на 4 минусе/);

  // it is no longer offered for review, and the next sync does not resurrect it
  await swiper.sync();
  assert.ok(!swiper.state('').queue.some((c) => c.id === clip.id));
  await assert.rejects(swiper.decide(clip.id, 'left', 'x'), /уже обработан/);
});

test('a LocalClip failure marks the job as error and retry re-queues it', async () => {
  const clip = byName('fps.mp4');
  await swiper.decide(clip.id, 'right', 'Андрей');
  const realGetTask = swiper.localclip.getTask.bind(swiper.localclip);
  swiper.localclip.getTask = async () => ({ status: 'error', progress_message: 'GPU out of memory' });
  await assert.rejects(swiper.montage(clip.id), /GPU out of memory/);
  swiper.localclip.getTask = realGetTask;
  assert.equal(byName('fps.mp4').localclipTaskId, null);
  swiper.store.update(clip.id, { status: 'error', error: 'LocalClip: GPU out of memory' });
  swiper.retry(clip.id, 'Андрей');
  assert.equal(byName('fps.mp4').status, 'queued');
});

test('while LocalClip is down the job waits in the queue, then runs when it is back', async () => {
  const clip = byName('fps.mp4');
  assert.equal(clip.status, 'queued');
  const realAvailable = swiper.localclip.available.bind(swiper.localclip);
  swiper.localclip.available = async () => false;
  const worker = swiper.runWorker();
  try {
    await new Promise((r) => setTimeout(r, 200));
    let waiting = byName('fps.mp4');
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.progress.waiting, true);
    assert.equal(waiting.error, null);

    swiper.localclip.available = realAvailable;
    swiper.wakeWorker();
    const deadline = Date.now() + 5000;
    while (byName('fps.mp4').status !== 'done' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(byName('fps.mp4').status, 'done');
  } finally {
    swiper.stopped = true;
    swiper.wakeWorker();
    await worker;
    swiper.stopped = false;
  }
});

test('unreachable LocalClip database is reported as "not running", not a crash', async () => {
  const { LocalClip: LC } = await import('../src/localclip.js');
  const lc = new LC({ apiUrl: fakes.base, databaseUrl: 'postgresql://u:p@127.0.0.1:1/db' });
  await assert.rejects(lc.resolveUserId(), (err) => err.unavailable === true && /не запущен/.test(err.message));
  assert.equal(await lc.available(), false);
});

test('a later CRM sync does not add the videos twice or move the ticket back', async () => {
  const done = byName('минус-4.mp4');
  const t = fakes.tickets.get(done.crmTicketId);
  t.status = 'POSTED'; // moved on by hand in the CRM
  await swiper.pushCrm(done.id);
  assert.equal(t.status, 'POSTED');
  assert.equal(t.videos.length, 1);
});

test('"целиком" montage keeps the full length and is named "(целиком)"', async () => {
  const folder = byName('минус-4.mp4').streamerFolderId;
  // the original минус-4 now lives in montage/…/исходники, so add a fresh clip to to sort/sasavot
  const toSort = [...fakes.files.values()].find((f) => f.name === 'to sort').id;
  const sasavot = [...fakes.files.values()].find((f) => f.name === 'sasavot' && f.parents[0] === toSort).id;
  assert.equal(folder, sasavot);
  fakes.addFile({ name: 'долгий-замес.mp4', parent: sasavot, content: Buffer.from('video:long') });
  await swiper.sync();
  const clip = byName('долгий-замес.mp4');
  await swiper.decide(clip.id, 'full', 'Андрей');
  assert.equal(byName('долгий-замес.mp4').montageMode, 'full');
  await swiper.montage(clip.id);
  await settle();
  const done = byName('долгий-замес.mp4');
  const task = fakes.tasks.get(done.localclipTaskId);
  assert.equal(task.body.cut_long_pauses, false);
  assert.equal(task.body.remove_filler_words, false);
  assert.equal(fakes.pathOf(done.outputs[0].driveId), 'montage/sasavot/долгий-замес (целиком).mp4');
  const t = fakes.tickets.get(done.crmTicketId);
  assert.equal(t.status, 'UNIQUIFIED');
  assert.match(t.notes, /Монтаж: целиком/);
  assert.match(t.notes, /на монтаж целиком \(Андрей\)/);
});

test('files removed from "to sort" by hand are marked gone', async () => {
  const clip = byName('убили-угар.mp4');
  fakes.files.get(clip.id).parents = [fakes.root];
  await swiper.sync();
  await settle();
  assert.equal(byName('убили-угар.mp4').status, 'gone');
});

test('notes stay under the CRM 5000-char limit', () => {
  const notes = ticketNotes({
    name: 'a.mp4',
    streamer: 's',
    status: 'new',
    webViewLink: 'x',
    history: Array.from({ length: 500 }, () => ({ at: new Date().toISOString(), text: 'y'.repeat(300) })),
  });
  assert.ok(notes.length <= 5000);
});

test('http: login, session cookie, auth guard and Range video proxy', async () => {
  const server = createServer({ config, swiper });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'A', password: 'nope' }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'Андрей', password: 'team-pass' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal(readSession(config.sessionSecret, decodeURIComponent(cookie.split('=')[1])).name, 'Андрей');

    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.ok(Array.isArray(state.queue));

    const clip = swiper.store.all()[0];
    const ranged = await fetch(`${base}/api/clips/${clip.id}/video`, { headers: { cookie, range: 'bytes=0-4' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-4/${fakes.files.get(clip.id).content.length}`);
    assert.equal(await ranged.text(), 'video');

    const unknown = await fetch(`${base}/api/clips/zzzzzzzz/video`, { headers: { cookie } });
    assert.equal(unknown.status, 404);

    // forged cookie
    const forged = makeSession('other-secret', 'evil');
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `swiper_session=${forged}` } })).status, 401);

    const html = await fetch(`${base}/`);
    assert.match(await html.text(), /Clip Tinder/);
  } finally {
    server.close();
  }
});
