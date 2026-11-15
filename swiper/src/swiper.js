import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileLink, folderLink } from './drive.js';
import { ticketNotes, ticketTitle } from './crm.js';
import { safeFileName } from './localclip.js';

const UNKNOWN_STREAMER = 'неизвестно';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Public view of a clip for the browser (no internal fields). */
export function clipView(clip) {
  return {
    id: clip.id,
    name: clip.name,
    streamer: clip.streamer,
    size: clip.size,
    durationMs: clip.durationMs,
    width: clip.width,
    height: clip.height,
    createdTime: clip.createdTime,
    webViewLink: clip.webViewLink,
    status: clip.status,
    progress: clip.progress || null,
    error: clip.error || null,
    outputs: clip.outputs || [],
    crmTicketId: clip.crmTicketId || null,
    decidedAt: clip.decidedAt || null,
    montageMode: clip.montageMode || null,
    history: (clip.history || []).slice(-10),
  };
}

/**
 * Wires Drive <-> swipe decisions <-> LocalClip montage <-> CRM tickets.
 *
 *   to sort/<streamer>/x.mp4  --sync-->  ticket in CRM (Бэклог)
 *   swipe left   -> trash/<streamer>/x.mp4, ticket title "[УДАЛИТЬ] ..." stays in Бэклог
 *   "подумать"   -> file stays, ticket stays in Бэклог
 *   swipe right  -> LocalClip renders -> montage/<streamer>/x.mp4 (+ original to montage/<streamer>/исходники/),
 *                   ticket gets the rendered videos and moves to Уникализировано
 */
export class Swiper {
  constructor({ config, store, drive, crm, localclip, log = console }) {
    this.config = config;
    this.store = store;
    this.drive = drive;
    this.crm = crm;
    this.localclip = localclip;
    this.log = log;
    this.tmpDir = path.join(config.dataDir, 'tmp');
    mkdirSync(this.tmpDir, { recursive: true });
    this.syncing = null;
    this.workerWake = null;
    this.stopped = false;
    this.crmChains = new Map();
  }

  // ---------------------------------------------------------------- folders

  async folders() {
    const { rootFolderId, toSortName, montageName, trashName } = this.config.drive;
    if (!rootFolderId) throw new Error('DRIVE_ROOT_FOLDER_ID не задан');
    const [toSort, montage, trash] = await Promise.all([
      this.drive.ensureFolder(rootFolderId, toSortName),
      this.drive.ensureFolder(rootFolderId, montageName),
      this.drive.ensureFolder(rootFolderId, trashName),
    ]);
    return { toSort, montage, trash };
  }

  // ---------------------------------------------------------------- sync

  /** Re-read "to sort" (deduplicated: concurrent callers share one run). */
  sync() {
    this.syncing ??= this.#sync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async #sync() {
    try {
      const { toSort } = await this.folders();
      const streamerFolders = await this.drive.listFolders(toSort);
      const groups = await Promise.all([
        this.drive.listVideos(toSort).then((files) => ({ folder: { id: toSort, name: UNKNOWN_STREAMER }, files })),
        ...streamerFolders.map((folder) =>
          this.drive.listVideos(folder.id).then((files) => ({ folder, files })),
        ),
      ]);

      const seen = new Set();
      for (const { folder, files } of groups) {
        for (const file of files) {
          seen.add(file.id);
          this.#upsertFromDrive(file, folder);
        }
      }
      // Pending clips that vanished from "to sort" (moved/deleted by hand).
      for (const clip of this.store.all()) {
        if ((clip.status === 'new' || clip.status === 'maybe') && !seen.has(clip.id)) {
          this.store.update(clip.id, { status: 'gone' }, 'файл пропал из to sort (перемещён/удалён вручную)');
          this.pushCrm(clip.id);
        }
      }
      this.store.lastSyncAt = new Date().toISOString();
      this.store.lastSyncError = null;
      this.store.save();
      // Retry CRM updates that failed earlier.
      for (const clip of this.store.all()) if (clip.crmSynced === false) this.pushCrm(clip.id);
    } catch (err) {
      this.store.lastSyncError = err.message;
      this.log.error('[sync]', err.message);
      throw err;
    }
  }

  #upsertFromDrive(file, folder) {
    const meta = {
      name: file.name,
      streamer: folder.name.trim().slice(0, 200) || UNKNOWN_STREAMER,
      streamerFolderId: folder.id,
      size: file.size ? Number(file.size) : null,
      mimeType: file.mimeType,
      createdTime: file.createdTime,
      durationMs: file.videoMediaMetadata?.durationMillis ? Number(file.videoMediaMetadata.durationMillis) : null,
      width: file.videoMediaMetadata?.width || null,
      height: file.videoMediaMetadata?.height || null,
      webViewLink: file.webViewLink || fileLink(file.id),
      folderLink: folderLink(folder.id),
    };
    const existing = this.store.get(file.id);
    if (!existing) {
      this.store.put({
        id: file.id,
        ...meta,
        status: 'new',
        crmTicketId: null,
        crmSynced: false,
        outputs: [],
        history: [],
        firstSeenAt: new Date().toISOString(),
      });
      this.store.update(file.id, {}, `попал на оценку (to sort/${meta.streamer})`);
      this.pushCrm(file.id);
      return;
    }
    // A file that was trashed/gone and is back in "to sort" is up for review again.
    const back = existing.status === 'gone' || existing.status === 'trashed';
    const changed = Object.entries(meta).some(([k, v]) => existing[k] !== v);
    if (back) {
      this.store.update(file.id, { ...meta, status: 'new' }, 'снова в to sort — на оценке');
      this.pushCrm(file.id);
    } else if (changed && (existing.status === 'new' || existing.status === 'maybe')) {
      this.store.update(file.id, meta);
    }
  }

  // ---------------------------------------------------------------- queue for the UI

  state(streamer) {
    const all = this.store.all();
    const match = (c) => !streamer || c.streamer === streamer;
    const byCreated = (a, b) => String(a.createdTime).localeCompare(String(b.createdTime));
    const byDecided = (a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || ''));
    const pending = all.filter((c) => c.status === 'new' || c.status === 'maybe');
    const streamers = {};
    for (const c of pending) {
      streamers[c.streamer] ??= { name: c.streamer, new: 0, maybe: 0 };
      streamers[c.streamer][c.status] += 1;
    }
    return {
      queue: all.filter((c) => c.status === 'new' && match(c)).sort(byCreated).map(clipView),
      maybe: all.filter((c) => c.status === 'maybe' && match(c)).sort(byCreated).map(clipView),
      jobs: all
        .filter((c) => ['queued', 'processing', 'error', 'done'].includes(c.status))
        .sort(byDecided)
        .slice(0, 50)
        .map(clipView),
      trashed: all.filter((c) => c.status === 'trashed').sort(byDecided).slice(0, 30).map(clipView),
      streamers: Object.values(streamers).sort((a, b) => a.name.localeCompare(b.name)),
      lastSyncAt: this.store.lastSyncAt,
      lastSyncError: this.store.lastSyncError,
      crmEnabled: this.crm.enabled,
    };
  }

  // ---------------------------------------------------------------- decisions

  async decide(id, action, by) {
    const clip = this.store.get(id);
    if (!clip) throw httpError(404, 'Клип не найден');
    if (clip.status !== 'new' && clip.status !== 'maybe') {
      throw httpError(409, `Клип уже обработан (${clip.status})`);
    }
    const decidedAt = new Date().toISOString();
    if (action === 'right' || action === 'full') {
      const montageMode = action === 'full' ? 'full' : 'cut';
      this.store.update(
        id,
        { status: 'queued', montageMode, decidedAt, error: null, progress: null },
        montageMode === 'full' ? '👍 на монтаж целиком' : '👍 на монтаж (сокращённый)',
        by,
      );
      this.wakeWorker();
    } else if (action === 'left') {
      const { trash } = await this.folders();
      const target = await this.drive.ensureFolder(trash, clip.streamer);
      await this.drive.move(id, target);
      this.store.update(id, { status: 'trashed', decidedAt, folderLink: folderLink(target) }, '👎 удалить → trash', by);
    } else if (action === 'maybe') {
      this.store.update(id, { status: 'maybe', decidedAt }, '🤔 на подумать', by);
    } else {
      throw httpError(400, 'action: right | full | left | maybe');
    }
    this.pushCrm(id);
    return clipView(this.store.get(id));
  }

  /** Undo a swipe while it is still reversible (trash -> back to "to sort", queued/maybe -> on review). */
  async undo(id, by) {
    const clip = this.store.get(id);
    if (!clip) throw httpError(404, 'Клип не найден');
    if (clip.status === 'trashed') {
      await this.drive.move(id, clip.streamerFolderId);
      this.store.update(id, { status: 'new', decidedAt: null, folderLink: folderLink(clip.streamerFolderId) }, '↩︎ отмена: вернули из trash', by);
    } else if (clip.status === 'queued' || clip.status === 'maybe') {
      this.store.update(id, { status: 'new', decidedAt: null }, '↩︎ отмена', by);
    } else {
      throw httpError(409, clip.status === 'processing' ? 'Уже монтируется — отменить нельзя' : 'Нечего отменять');
    }
    this.pushCrm(id);
    return clipView(this.store.get(id));
  }

  retry(id, by) {
    const clip = this.store.get(id);
    if (!clip) throw httpError(404, 'Клип не найден');
    if (clip.status !== 'error') throw httpError(409, 'Повторить можно только упавший монтаж');
    this.store.update(id, { status: 'queued', error: null, progress: null }, '🔁 повтор монтажа', by);
    this.pushCrm(id);
    this.wakeWorker();
    return clipView(this.store.get(id));
  }

  // ---------------------------------------------------------------- CRM

  /** Create/update the clip's ticket. Serialized per clip; failures are retried on the next sync. */
  pushCrm(id) {
    if (!this.crm.enabled) return Promise.resolve();
    const prev = this.crmChains.get(id) || Promise.resolve();
    const next = prev.then(() => this.#pushCrm(id)).catch((err) => {
      this.log.error('[crm]', id, err.message);
      this.store.update(id, { crmSynced: false });
    });
    this.crmChains.set(id, next);
    next.finally(() => {
      if (this.crmChains.get(id) === next) this.crmChains.delete(id);
    });
    return next;
  }

  async #pushCrm(id) {
    const clip = this.store.get(id);
    if (!clip) return;
    const fields = { title: ticketTitle(clip), notes: ticketNotes(clip) };
    if (!clip.crmTicketId) {
      const ticket = await this.crm.createTicket({ sourceUrl: clip.webViewLink, streamer: clip.streamer, ...fields });
      this.store.update(id, { crmTicketId: ticket.id });
    }
    const ticketId = this.store.get(id).crmTicketId;
    try {
      await this.crm.updateTicket(ticketId, fields);
      // Montaged: attach the rendered videos (the CRM requires one) and move to "Уникализировано", once.
      // Later manual moves in the CRM are left alone.
      if (clip.status === 'done' && !clip.crmUniquifiedSet) {
        const urls = (clip.outputs || []).map((o) => o.webViewLink).slice(0, 20);
        if (!clip.crmVideosAdded && urls.length) {
          await this.crm.addVideos(ticketId, urls);
          this.store.update(id, { crmVideosAdded: true });
        }
        await this.crm.updateTicket(ticketId, { status: 'UNIQUIFIED' });
        this.store.update(id, { crmUniquifiedSet: true });
      }
    } catch (err) {
      if (err.status === 404) {
        // Ticket deleted in the CRM: create a fresh one next time.
        this.store.update(id, { crmTicketId: null, crmSynced: false, crmVideosAdded: false, crmUniquifiedSet: false });
        return;
      }
      throw err;
    }
    this.store.update(id, { crmSynced: true });
  }

  // ---------------------------------------------------------------- montage worker

  wakeWorker() {
    this.workerWake?.();
  }

  async runWorker() {
    // Jobs that failed only because LocalClip was not running go back to the queue.
    for (const c of this.store.all()) {
      if (c.status === 'error' && /ECONNREFUSED|недоступ|не запущен/i.test(c.error || '')) {
        this.store.update(c.id, { status: 'queued', error: null, progress: null }, 'снова в очереди: ждёт LocalClip');
        this.pushCrm(c.id);
      }
    }
    // After a restart, half-done jobs continue where they stopped.
    while (!this.stopped) {
      const job = this.store
        .all()
        .filter((c) => c.status === 'processing' || c.status === 'queued')
        .sort((a, b) =>
          a.status === b.status
            ? String(a.decidedAt).localeCompare(String(b.decidedAt))
            : a.status === 'processing'
              ? -1
              : 1,
        )[0];
      if (!job) {
        await new Promise((resolve) => {
          this.workerWake = resolve;
          setTimeout(resolve, 30_000);
        });
        this.workerWake = null;
        continue;
      }
      try {
        if (!(await this.localclip.available())) {
          await this.#waitForLocalClip();
          continue;
        }
        await this.montage(job.id);
      } catch (err) {
        if (err.unavailable) {
          // LocalClip went away mid-job: keep the job (and its LocalClip task id), resume later.
          this.log.warn('[montage]', job.id, err.message);
          await this.#waitForLocalClip();
          continue;
        }
        this.log.error('[montage]', job.id, err.message);
        this.store.update(job.id, { status: 'error', error: err.message, progress: null }, `ошибка монтажа: ${err.message}`);
        this.pushCrm(job.id);
        await sleep(2000);
      }
    }
  }

  /** Mark waiting jobs and sleep until LocalClip may be back (or a new swipe wakes the worker). */
  async #waitForLocalClip() {
    const message = 'Ждёт запуска LocalClip на ПК…';
    for (const c of this.store.all()) {
      if ((c.status === 'queued' || c.status === 'processing') && c.progress?.message !== message) {
        this.setProgress(c.id, { percent: c.progress?.percent || 0, message, waiting: true });
      }
    }
    await new Promise((resolve) => {
      this.workerWake = resolve;
      setTimeout(resolve, this.config.localclip.waitMs ?? 30_000);
    });
    this.workerWake = null;
  }

  setProgress(id, progress) {
    this.store.update(id, { progress });
  }

  async montage(id) {
    let clip = this.store.get(id);
    if (clip.status !== 'processing') {
      clip = this.store.update(id, { status: 'processing' }, 'монтаж начат');
      this.pushCrm(id);
    }
    const ext = path.extname(clip.name) || '.mp4';
    const work = path.join(this.tmpDir, id);
    mkdirSync(work, { recursive: true });
    try {
      // 1. Drive -> LocalClip
      if (!clip.localclipTaskId) {
        this.setProgress(id, { percent: 2, message: 'Скачиваю с Google Диска…' });
        const src = path.join(work, `source${ext}`);
        await this.drive.download(id, src);
        this.setProgress(id, { percent: 8, message: 'Загружаю в LocalClip…' });
        const videoPath = await this.localclip.upload(src, safeFileName(clip.name));
        const taskId = await this.localclip.createTask(videoPath, `${clip.streamer}: ${clip.name}`, {
          mode: clip.montageMode || 'cut',
        });
        clip = this.store.update(id, { localclipTaskId: taskId }, `задача LocalClip ${taskId}`);
        rmSync(src, { force: true });
      }

      // 2. Wait for LocalClip
      const taskId = clip.localclipTaskId;
      const deadline = Date.now() + this.config.localclip.timeoutMs;
      for (;;) {
        const task = await this.localclip.getTask(taskId);
        if (task.status === 'completed') break;
        if (task.status === 'error' || task.status === 'cancelled') {
          this.store.update(id, { localclipTaskId: null }); // a retry starts a fresh task
          throw new Error(`LocalClip: ${task.progress_message || task.status}`);
        }
        if (Date.now() > deadline) throw new Error('LocalClip не закончил за отведённое время (LOCALCLIP_TIMEOUT_MIN)');
        this.setProgress(id, {
          percent: Math.max(10, Math.min(90, Number(task.progress) || 10)),
          message: task.progress_message || (task.status === 'queued' ? 'В очереди LocalClip…' : 'Монтаж…'),
        });
        await sleep(this.config.localclip.pollMs);
      }

      // 3. LocalClip -> Drive montage/<streamer>/
      const clips = await this.localclip.clips(taskId);
      if (!clips.length) throw new Error('LocalClip не сделал ни одного клипа');
      const { montage } = await this.folders();
      const target = await this.drive.ensureFolder(montage, clip.streamer);
      const base = clip.name.replace(/\.[^.]+$/, '');
      const outputs = [...(clip.outputs || [])];
      for (const [i, out] of clips.entries()) {
        if (outputs.some((o) => o.clipId === out.id)) continue; // uploaded before a restart
        this.setProgress(id, { percent: 92, message: `Выгружаю на Google Диск (${i + 1}/${clips.length})…` });
        const local = path.join(work, `out-${i}.mp4`);
        await this.localclip.downloadClip(taskId, out.id, local);
        const suffix = clip.montageMode === 'full' ? ' (целиком)' : '';
        const name = safeFileName(clips.length > 1 ? `${base}${suffix} (${i + 1}).mp4` : `${base}${suffix}.mp4`);
        const file = await this.drive.upload(local, { name, parentId: target });
        rmSync(local, { force: true });
        outputs.push({
          clipId: out.id,
          driveId: file.id,
          name: file.name,
          webViewLink: file.webViewLink || fileLink(file.id),
          hookTitle: out.hook_title || null,
        });
        this.store.update(id, { outputs });
      }

      // 4. Original out of "to sort"
      const sourcesFolder = await this.drive.ensurePath(target, [this.config.drive.sourcesSubfolder]);
      await this.drive.move(id, sourcesFolder);

      this.store.update(
        id,
        { status: 'done', progress: null, error: null, folderLink: folderLink(target) },
        `смонтировано: ${outputs.length} видео в montage/${clip.streamer}`,
      );
      await this.pushCrm(id);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    const tick = () =>
      this.sync().catch(() => {}).finally(() => {
        if (!this.stopped) this.syncTimer = setTimeout(tick, this.config.syncIntervalMs);
      });
    tick();
    this.workerDone = this.runWorker();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.syncTimer);
    this.wakeWorker();
  }
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
