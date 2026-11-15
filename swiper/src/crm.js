/**
 * Client for the GTA6 Content CRM API (NestJS, JWT).
 * Logs in once with a dedicated user and re-logs only on 401 (login is rate limited to 5/min).
 */
export class Crm {
  constructor({ apiUrl, login, password }) {
    this.apiUrl = apiUrl;
    this.login = login;
    this.password = password;
    this.token = null;
    this.loggingIn = null;
  }

  get enabled() {
    return Boolean(this.apiUrl && this.login && this.password);
  }

  async signIn() {
    this.loggingIn ??= (async () => {
      try {
        const res = await fetch(`${this.apiUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login: this.login, password: this.password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.accessToken) {
          throw new Error(`CRM login: ${res.status} ${body.message || ''}`.trim());
        }
        this.token = body.accessToken;
      } finally {
        this.loggingIn = null;
      }
    })();
    return this.loggingIn;
  }

  async call(method, pathname, body) {
    if (!this.token) await this.signIn();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiUrl}/api${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        await this.signIn();
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const msg = Array.isArray(json?.message) ? json.message.join('; ') : json?.message;
        const err = new Error(`CRM ${method} ${pathname}: ${res.status} ${msg || text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return json;
    }
  }

  createTicket(data) {
    return this.call('POST', '/tickets', data);
  }

  updateTicket(id, data) {
    return this.call('PATCH', `/tickets/${id}`, data);
  }

  addVideos(id, urls) {
    return this.call('POST', `/tickets/${id}/videos`, { urls });
  }
}

const NOTES_MAX = 5000;
const TITLE_MAX = 200;
export const DELETE_MARK = '[УДАЛИТЬ]';

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const fmtSize = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} ГБ` : `${(n / 1024 ** 2).toFixed(1)} МБ`;
};

export const fmtDuration = (ms) => {
  const s = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(s) || s <= 0) return '—';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const baseName = (name) => name.replace(/\.[^.]+$/, '');

export function ticketTitle(clip) {
  const title = `${baseName(clip.name)} (${clip.streamer})`;
  const full = clip.status === 'trashed' ? `${DELETE_MARK} ${title}` : title;
  return full.slice(0, TITLE_MAX);
}

const STATUS_TEXT = {
  new: 'на оценке',
  maybe: 'на подумать',
  queued: 'в очереди на монтаж',
  processing: 'монтируется',
  done: 'смонтировано',
  trashed: 'удалено (в trash)',
  error: 'ошибка монтажа',
  gone: 'файл пропал из to sort',
};

/** Full ticket notes rebuilt from the clip record every time (idempotent, never grows unbounded). */
export function ticketNotes(clip) {
  const lines = [
    'Клип из Google Диска (свайпер)',
    `Статус в свайпере: ${STATUS_TEXT[clip.status] || clip.status}`,
    `Стример: ${clip.streamer}`,
    `Файл: ${clip.name}`,
    `Размер: ${fmtSize(clip.size)} · Длительность: ${fmtDuration(clip.durationMs)}${
      clip.width && clip.height ? ` · ${clip.width}×${clip.height}` : ''
    }`,
    `Загружен на диск: ${fmtDate(clip.createdTime)}`,
    `Исходник: ${clip.webViewLink}`,
  ];
  if (clip.folderLink) lines.push(`Папка: ${clip.folderLink}`);
  if (clip.montageMode) lines.push(`Монтаж: ${clip.montageMode === 'full' ? 'целиком, без вырезания пауз' : 'сокращённый (паузы вырезаны)'}`);
  if (clip.outputs?.length) {
    lines.push('', 'Смонтировано:');
    for (const o of clip.outputs) {
      lines.push(`• ${o.name}${o.hookTitle ? ` — «${o.hookTitle}»` : ''}`, `  ${o.webViewLink}`);
    }
  }
  if (clip.error) lines.push('', `Ошибка: ${clip.error}`);
  if (clip.history?.length) {
    lines.push('', 'История:');
    for (const h of clip.history.slice(-20)) {
      lines.push(`• ${fmtDate(h.at)} — ${h.text}${h.by ? ` (${h.by})` : ''}`);
    }
  }
  let notes = lines.join('\n');
  if (notes.length > NOTES_MAX) notes = `${notes.slice(0, NOTES_MAX - 1)}…`;
  return notes;
}
