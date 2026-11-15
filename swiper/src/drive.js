import { createWriteStream, openAsBlob, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,videoMediaMetadata(width,height,durationMillis)';

/** Escape a value for a Drive `q` string literal. */
const q = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Tiny Google Drive v3 REST client (OAuth refresh token, no SDK).
 * Works for My Drive and shared drives.
 */
export class Drive {
  constructor({ clientId, clientSecret, refreshToken, apiBase, tokenUrl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.tokenUrl = tokenUrl;
    this.token = null;
    this.tokenExpires = 0;
    this.folderCache = new Map();
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret && this.refreshToken);
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpires - 60_000) return this.token;
    if (!this.configured) throw new DriveError('Google Диск не настроен (GOOGLE_* в .env)', 500);
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new DriveError(
        `Google OAuth: ${body.error_description || body.error || res.status}. Перевыпустите токен: npm run google-auth`,
        res.status,
      );
    }
    this.token = body.access_token;
    this.tokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
    return this.token;
  }

  async request(pathname, { method = 'GET', params = {}, headers = {}, body, raw = false, base } = {}) {
    const url = new URL((base ?? this.apiBase) + pathname);
    for (const [k, v] of Object.entries({ supportsAllDrives: 'true', ...params })) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${await this.accessToken()}`, ...headers },
        body,
      });
      if (res.status === 401 && attempt === 0) {
        this.token = null; // expired early / revoked: refresh once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3 && !(body instanceof Blob)) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if (raw) {
        if (!res.ok && res.status !== 206) {
          const text = await res.text().catch(() => '');
          throw new DriveError(`Drive ${method} ${pathname}: ${res.status} ${text.slice(0, 300)}`, res.status);
        }
        return res;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new DriveError(
          `Drive ${method} ${pathname}: ${res.status} ${json.error?.message || text.slice(0, 300)}`,
          res.status,
        );
      }
      return json;
    }
  }

  async list(query, fields = FILE_FIELDS) {
    const files = [];
    let pageToken;
    do {
      const page = await this.request('/drive/v3/files', {
        params: {
          q: query,
          fields: `nextPageToken,files(${fields})`,
          pageSize: 1000,
          pageToken,
          includeItemsFromAllDrives: 'true',
          orderBy: 'createdTime',
        },
      });
      files.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  getFile(id) {
    return this.request(`/drive/v3/files/${encodeURIComponent(id)}`, { params: { fields: FILE_FIELDS } });
  }

  listFolders(parentId) {
    return this.list(`${q(parentId)} in parents and mimeType = '${FOLDER_MIME}' and trashed = false`, 'id,name');
  }

  listVideos(parentId) {
    return this.list(`${q(parentId)} in parents and mimeType contains 'video/' and trashed = false`);
  }

  /** Child folder by name, created when missing. Cached per process. */
  async ensureFolder(parentId, name) {
    const key = `${parentId}/${name}`;
    if (this.folderCache.has(key)) return this.folderCache.get(key);
    const found = await this.list(
      `${q(parentId)} in parents and name = ${q(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`,
      'id,name',
    );
    let id = found[0]?.id;
    if (!id) {
      const created = await this.request('/drive/v3/files', {
        method: 'POST',
        params: { fields: 'id' },
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      });
      id = created.id;
    }
    this.folderCache.set(key, id);
    return id;
  }

  async ensurePath(parentId, names) {
    let id = parentId;
    for (const name of names.filter(Boolean)) id = await this.ensureFolder(id, name);
    return id;
  }

  /** Move a file into `folderId` (removing all its current parents). */
  async move(fileId, folderId) {
    const { parents = [] } = await this.request(`/drive/v3/files/${encodeURIComponent(fileId)}`, {
      params: { fields: 'parents' },
    });
    if (parents.length === 1 && parents[0] === folderId) return;
    return this.request(`/drive/v3/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      params: {
        addParents: folderId,
        removeParents: parents.filter((p) => p !== folderId).join(',') || undefined,
        fields: 'id,parents',
      },
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  }

  /** Raw media response, forwarding a Range header (for streaming to the browser). */
  media(fileId, range) {
    return this.request(`/drive/v3/files/${encodeURIComponent(fileId)}`, {
      params: { alt: 'media' },
      headers: range ? { range } : {},
      raw: true,
    });
  }

  async download(fileId, destPath) {
    const res = await this.media(fileId);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
    return destPath;
  }

  /** Resumable upload of a local file; returns {id, name, webViewLink}. */
  async upload(localPath, { name, parentId, mimeType = 'video/mp4' }) {
    const size = statSync(localPath).size;
    const init = await this.request('/upload/drive/v3/files', {
      method: 'POST',
      params: { uploadType: 'resumable', fields: 'id,name,webViewLink' },
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': mimeType,
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({ name, parents: [parentId], mimeType }),
      raw: true,
    });
    const location = init.headers.get('location');
    if (!location) throw new DriveError('Drive upload: no resumable session URL', 500);
    const res = await fetch(location, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': mimeType,
      },
      body: await openAsBlob(localPath, { type: mimeType }),
    });
    const text = await res.text();
    if (!res.ok) throw new DriveError(`Drive upload ${name}: ${res.status} ${text.slice(0, 300)}`, res.status);
    const file = JSON.parse(text);
    return file.webViewLink ? file : this.getFile(file.id);
  }
}

export const folderLink = (id) => `https://drive.google.com/drive/folders/${id}`;
export const fileLink = (id) => `https://drive.google.com/file/d/${id}/view`;
