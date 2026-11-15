import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig } from './config.js';
import { Crm } from './crm.js';
import { Drive } from './drive.js';
import { LocalClip } from './localclip.js';
import { Store } from './store.js';
import { Swiper } from './swiper.js';

const PUBLIC = path.join(ROOT, 'public');
const COOKIE = 'swiper_session';
const SESSION_DAYS = 30;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/manifest+json',
  '.png': 'image/png',
};

// ------------------------------------------------------------------ sessions

const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

export function makeSession(secret, name) {
  const payload = Buffer.from(JSON.stringify({ name, exp: Date.now() + SESSION_DAYS * 86400_000 })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function readSession(secret, value) {
  if (!value) return null;
  const [payload, mac] = value.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(secret, payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );

const isHttps = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || String(req.headers['cf-visitor'] || '').includes('https');

const clientIp = (req) =>
  String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');

const passwordOk = (expected, given) => {
  const a = Buffer.from(sign('pw', String(expected)));
  const b = Buffer.from(sign('pw', String(given ?? '')));
  return timingSafeEqual(a, b);
};

// ------------------------------------------------------------------ helpers

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Некорректный JSON'), { status: 400 });
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/privacy' ? 'privacy.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, { message: 'Not found' });
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    // SPA-style fallback
    if (!path.extname(rel)) return serveStatic(req, res, '/');
    send(res, 404, { message: 'Not found' });
  }
}

// ------------------------------------------------------------------ app

export function createServer({ config, swiper }) {
  const loginAttempts = new Map(); // ip -> [timestamps]

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    const method = req.method || 'GET';

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { message: 'Method not allowed' });
      return serveStatic(req, res, pathname);
    }

    if (pathname === '/api/login' && method === 'POST') {
      const ip = clientIp(req);
      const now = Date.now();
      const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < 60_000);
      if (recent.length >= 10) return send(res, 429, { message: 'Слишком много попыток, подождите минуту' });
      loginAttempts.set(ip, [...recent, now]);
      const body = await readJson(req);
      if (!config.appPassword) return send(res, 500, { message: 'APP_PASSWORD не задан в swiper/.env' });
      const name = String(body.name || '').trim().slice(0, 40);
      if (!name) return send(res, 400, { message: 'Введите имя' });
      if (!passwordOk(config.appPassword, body.password)) return send(res, 401, { message: 'Неверный пароль' });
      const cookie = [
        `${COOKIE}=${encodeURIComponent(makeSession(config.sessionSecret, name))}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${SESSION_DAYS * 86400}`,
        ...(isHttps(req) ? ['Secure'] : []),
      ].join('; ');
      return send(res, 200, { name }, { 'set-cookie': cookie });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0` });
    }

    const session = readSession(config.sessionSecret, cookies(req)[COOKIE]);
    if (!session) return send(res, 401, { message: 'Нужно войти' });
    const by = session.name;

    if (pathname === '/api/me' && method === 'GET') return send(res, 200, { name: by });

    if (pathname === '/api/state' && method === 'GET') {
      return send(res, 200, swiper.state(url.searchParams.get('streamer') || ''));
    }

    if (pathname === '/api/sync' && method === 'POST') {
      await swiper.sync();
      return send(res, 200, swiper.state(url.searchParams.get('streamer') || ''));
    }

    if (pathname === '/api/health' && method === 'GET') {
      const [localclip] = await Promise.all([swiper.localclip.health()]);
      return send(res, 200, {
        drive: swiper.drive.configured,
        crm: swiper.crm.enabled,
        localclip,
        lastSyncAt: swiper.store.lastSyncAt,
        lastSyncError: swiper.store.lastSyncError,
      });
    }

    const m = pathname.match(/^\/api\/clips\/([A-Za-z0-9_-]{5,100})\/(video|decision|undo|retry)$/);
    if (m) {
      const [, id, action] = m;
      if (action === 'video' && (method === 'GET' || method === 'HEAD')) {
        const known =
          swiper.store.get(id) ||
          swiper.store.all().some((c) => (c.outputs || []).some((o) => o.driveId === id));
        if (!known) return send(res, 404, { message: 'Клип не найден' });
        const upstream = await swiper.drive.media(id, req.headers.range);
        const headers = {
          'content-type': upstream.headers.get('content-type') || 'video/mp4',
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=300',
        };
        for (const h of ['content-length', 'content-range']) {
          const v = upstream.headers.get(h);
          if (v) headers[h] = v;
        }
        res.writeHead(upstream.status, headers);
        if (method === 'HEAD' || !upstream.body) {
          upstream.body?.cancel().catch(() => {});
          return res.end();
        }
        const stream = Readable.fromWeb(upstream.body);
        res.on('close', () => stream.destroy());
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
      if (method !== 'POST') return send(res, 405, { message: 'Method not allowed' });
      if (action === 'decision') {
        const body = await readJson(req);
        return send(res, 200, await swiper.decide(id, body.action, by));
      }
      if (action === 'undo') return send(res, 200, await swiper.undo(id, by));
      if (action === 'retry') return send(res, 200, swiper.retry(id, by));
    }

    send(res, 404, { message: 'Not found' });
  };

  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      const status = err.status && err.status < 500 ? err.status : 500;
      if (status === 500) console.error('[http]', req.method, req.url, err);
      if (res.headersSent) return res.destroy();
      send(res, status, { message: err.message || 'Ошибка сервера' });
    });
  });
}

// ------------------------------------------------------------------ main

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const config = loadConfig();
  const swiper = new Swiper({
    config,
    store: new Store(config.dataDir),
    drive: new Drive({ ...config.google }),
    crm: new Crm(config.crm),
    localclip: new LocalClip(config.localclip),
  });
  if (!config.appPassword) console.warn('[swiper] APP_PASSWORD пуст: войти на сайт не получится');
  if (!swiper.drive.configured) console.warn('[swiper] Google Диск не настроен: npm run google-auth');
  if (!swiper.crm.enabled) console.warn('[swiper] CRM не настроена (CRM_*): тикеты создаваться не будут');
  swiper.start();
  createServer({ config, swiper }).listen(config.port, config.host, () => {
    console.log(`[swiper] http://${config.host}:${config.port}`);
  });
  const shutdown = () => {
    swiper.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
