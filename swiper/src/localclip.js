import { createHmac } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const LOCAL_EMAIL = 'me@localclip.local';

/** LocalClip (or its database) is not running: the job should wait, not fail. */
export function unavailable(message) {
  const err = new Error(message);
  err.unavailable = true;
  return err;
}

/**
 * Client for the LocalClip backend (FastAPI on :8000).
 * Auth: the same HMAC-signed headers the LocalClip frontend uses (BACKEND_AUTH_SECRET from LocalClip's .env),
 * on behalf of LocalClip's built-in local user, so the tasks show up in the LocalClip app too.
 */
export class LocalClip {
  constructor({ apiUrl, authSecret, databaseUrl, userId, taskOptions }) {
    this.apiUrl = apiUrl;
    this.authSecret = authSecret;
    this.databaseUrl = databaseUrl;
    this.userId = userId || null;
    this.taskOptions = taskOptions || {};
  }

  async resolveUserId() {
    if (this.userId) return this.userId;
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: this.databaseUrl, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
    } catch (err) {
      throw unavailable(`База LocalClip недоступна (${err.code || err.message}): LocalClip не запущен на этом ПК`);
    }
    try {
      const { rows } = await client.query('SELECT id FROM users WHERE email = $1', [LOCAL_EMAIL]);
      if (!rows[0]) {
        throw new Error('В LocalClip ещё нет локального пользователя: откройте LocalClip один раз в браузере');
      }
      this.userId = rows[0].id;
      return this.userId;
    } finally {
      await client.end().catch(() => {});
    }
  }

  async headers() {
    const userId = await this.resolveUserId();
    if (!this.authSecret) return { 'x-localclip-user-id': userId };
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.authSecret).update(`${userId}:${ts}`).digest('hex');
    return { 'x-localclip-user-id': userId, 'x-localclip-ts': ts, 'x-localclip-signature': signature };
  }

  async call(method, pathname, { json, form, raw = false } = {}) {
    const headers = await this.headers();
    if (json) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.apiUrl + pathname, {
        method,
        headers,
        body: json ? JSON.stringify(json) : form,
      });
    } catch (err) {
      throw unavailable(`LocalClip недоступен (${this.apiUrl}): ${err.cause?.code || err.message}. Запущен ли LocalClip?`);
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail = body?.detail?.message || body?.detail || text.slice(0, 300);
      throw new Error(`LocalClip ${method} ${pathname}: ${res.status} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return body;
  }

  async health() {
    const res = await fetch(`${this.apiUrl}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    return Boolean(res?.ok);
  }

  /** True when LocalClip's API answers and its local user is known. */
  async available() {
    if (!(await this.health())) return false;
    try {
      await this.resolveUserId();
      return true;
    } catch (err) {
      if (err.unavailable) return false;
      throw err;
    }
  }

  async upload(localPath, filename) {
    const form = new FormData();
    form.append('video', await openAsBlob(localPath, { type: 'video/mp4' }), filename);
    const body = await this.call('POST', '/upload', { form });
    return body.video_path; // "upload://<uuid>.mp4"
  }

  /**
   * mode "cut" (default): LocalClip cuts pauses > 0.7s and filler words — a short, punchy edit.
   * mode "full": keep the whole length (no pause / filler cutting).
   */
  async createTask(videoPath, title, { mode = 'cut' } = {}) {
    const full = mode === 'full';
    const body = await this.call('POST', '/tasks/', {
      json: {
        output_format: 'vertical',
        add_subtitles: true,
        ...this.taskOptions,
        cut_long_pauses: !full,
        remove_filler_words: !full,
        source: { url: videoPath, title },
      },
    });
    return body.task_id;
  }

  getTask(taskId) {
    return this.call('GET', `/tasks/${encodeURIComponent(taskId)}`);
  }

  async clips(taskId) {
    const body = await this.call('GET', `/tasks/${encodeURIComponent(taskId)}/clips`);
    return body.clips || [];
  }

  async downloadClip(taskId, clipId, destPath) {
    const res = await this.call(
      'GET',
      `/tasks/${encodeURIComponent(taskId)}/clips/${encodeURIComponent(clipId)}/file`,
      { raw: true },
    );
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    return destPath;
  }
}

export const safeFileName = (name) =>
  path.basename(String(name)).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'clip';
