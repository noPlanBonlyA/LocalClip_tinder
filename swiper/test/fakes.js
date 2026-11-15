// One fake HTTP server that plays Google (OAuth + Drive v3), the CRM API and the LocalClip API.
import { createHmac } from 'node:crypto';
import http from 'node:http';

const FOLDER = 'application/vnd.google-apps.folder';

export async function startFakes({ localclipSecret = 'lc-secret', localclipUser = 'user-1', pollsUntilDone = 2 } = {}) {
  let seq = 0;
  const nextId = (p) => `${p}${(++seq).toString().padStart(6, '0')}`;
  const files = new Map(); // id -> {id,name,mimeType,parents,content,createdTime,size}
  const tickets = new Map();
  const tasks = new Map();
  const calls = [];
  const sessions = new Map();

  const addFile = ({ name, mimeType = 'video/mp4', parent, content = Buffer.alloc(0) }) => {
    const id = nextId(mimeType === FOLDER ? 'fold' : 'file');
    files.set(id, {
      id,
      name,
      mimeType,
      parents: parent ? [parent] : [],
      content,
      size: String(content.length),
      createdTime: new Date(Date.now() + seq).toISOString(),
    });
    return id;
  };
  const view = (f) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    parents: f.parents,
    size: f.mimeType === FOLDER ? undefined : f.size,
    createdTime: f.createdTime,
    webViewLink: `https://drive.example/${f.id}`,
    videoMediaMetadata: f.mimeType.startsWith('video/') ? { width: 1920, height: 1080, durationMillis: '47000' } : undefined,
  });

  const root = addFile({ name: 'root', mimeType: FOLDER });

  /** Evaluate the small subset of Drive `q` the client uses. */
  const match = (f, q) =>
    q.split(' and ').every((cond) => {
      cond = cond.trim();
      let m;
      if ((m = cond.match(/^'(.+)' in parents$/))) return f.parents.includes(m[1]);
      if ((m = cond.match(/^mimeType = '(.+)'$/))) return f.mimeType === m[1];
      if ((m = cond.match(/^mimeType contains '(.+)'$/))) return f.mimeType.includes(m[1]);
      if ((m = cond.match(/^name = '(.*)'$/))) return f.name === m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      if (cond === 'trashed = false') return true;
      throw new Error(`fake drive: unsupported q "${cond}"`);
    });

  const body = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  };
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const p = url.pathname;
    calls.push(`${req.method} ${p}`);
    try {
      // ---------------- Google
      if (p === '/token') return json(res, 200, { access_token: 'tok', expires_in: 3600 });
      if (p.startsWith('/drive/') || p.startsWith('/upload/')) {
        if (req.headers.authorization !== 'Bearer tok') return json(res, 401, { error: { message: 'auth' } });
      }
      if (p === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q');
        const list = [...files.values()].filter((f) => match(f, q)).map(view);
        return json(res, 200, { files: list });
      }
      if (p === '/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse((await body(req)).toString());
        const id = addFile({ name: meta.name, mimeType: meta.mimeType, parent: meta.parents[0] });
        return json(res, 200, { id });
      }
      let m;
      if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
        const f = files.get(decodeURIComponent(m[1]));
        if (!f) return json(res, 404, { error: { message: 'not found' } });
        if (req.method === 'PATCH') {
          await body(req);
          const add = url.searchParams.get('addParents');
          const remove = (url.searchParams.get('removeParents') || '').split(',').filter(Boolean);
          f.parents = [...f.parents.filter((x) => !remove.includes(x)), ...(add ? [add] : [])];
          return json(res, 200, { id: f.id, parents: f.parents });
        }
        if (url.searchParams.get('alt') === 'media') {
          const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
          if (range) {
            const start = Number(range[1]);
            const end = range[2] ? Number(range[2]) : f.content.length - 1;
            res.writeHead(206, {
              'content-type': f.mimeType,
              'content-length': end - start + 1,
              'content-range': `bytes ${start}-${end}/${f.content.length}`,
            });
            return res.end(f.content.subarray(start, end + 1));
          }
          res.writeHead(200, { 'content-type': f.mimeType, 'content-length': f.content.length });
          return res.end(f.content);
        }
        return json(res, 200, view(f));
      }
      if (p === '/upload/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse((await body(req)).toString());
        const sid = nextId('sess');
        sessions.set(sid, meta);
        res.writeHead(200, { location: `http://127.0.0.1:${server.address().port}/upload-session/${sid}` });
        return res.end();
      }
      if ((m = p.match(/^\/upload-session\/(.+)$/)) && req.method === 'PUT') {
        const meta = sessions.get(m[1]);
        const id = addFile({ name: meta.name, mimeType: meta.mimeType, parent: meta.parents[0], content: await body(req) });
        return json(res, 200, { id, name: meta.name, webViewLink: `https://drive.example/${id}` });
      }

      // ---------------- CRM
      if (p === '/api/auth/login') {
        const b = JSON.parse((await body(req)).toString());
        if (b.login !== 'swiper' || b.password !== 'crm-pass') return json(res, 401, { message: 'bad' });
        return json(res, 200, { accessToken: 'crm-jwt' });
      }
      if (p.startsWith('/api/tickets')) {
        if (req.headers.authorization !== 'Bearer crm-jwt') return json(res, 401, { message: 'auth' });
        const b = JSON.parse((await body(req)).toString() || '{}');
        if (p === '/api/tickets' && req.method === 'POST') {
          if (!b.sourceUrl || !b.streamer) return json(res, 400, { message: ['bad'] });
          const id = tickets.size + 1;
          tickets.set(id, { id, status: 'BACKLOG', ...b });
          return json(res, 201, tickets.get(id));
        }
        if ((m = p.match(/^\/api\/tickets\/(\d+)\/videos$/)) && req.method === 'POST') {
          const t = tickets.get(Number(m[1]));
          if (!t) return json(res, 404, { message: 'not found' });
          if (!Array.isArray(b.urls) || !b.urls.length || b.urls.length > 20) return json(res, 400, { message: ['urls'] });
          t.videos = [...(t.videos || []), ...b.urls.map((url) => ({ url }))];
          return json(res, 201, t.videos);
        }
        if ((m = p.match(/^\/api\/tickets\/(\d+)$/)) && req.method === 'PATCH') {
          const t = tickets.get(Number(m[1]));
          if (!t) return json(res, 404, { message: 'not found' });
          if (b.status && !['BACKLOG', 'UNIQUIFIED', 'POSTED'].includes(b.status)) {
            return json(res, 400, { message: ['Статус: BACKLOG, UNIQUIFIED или POSTED'] });
          }
          if (b.status === 'UNIQUIFIED' && !(t.videos || []).length) {
            return json(res, 422, { code: 'TICKET_NEEDS_VIDEOS', message: 'Добавьте хотя бы одно уникализированное видео' });
          }
          Object.assign(t, b);
          return json(res, 200, t);
        }
      }

      // ---------------- LocalClip
      const lcAuth = () => {
        const user = req.headers['x-localclip-user-id'];
        const ts = req.headers['x-localclip-ts'];
        const sig = createHmac('sha256', localclipSecret).update(`${user}:${ts}`).digest('hex');
        return user === localclipUser && req.headers['x-localclip-signature'] === sig;
      };
      if (p === '/health') return json(res, 200, { status: 'healthy' });
      if (p === '/upload' || p.startsWith('/tasks')) {
        if (!lcAuth()) return json(res, 401, { detail: 'Invalid auth signature' });
      }
      if (p === '/upload' && req.method === 'POST') {
        const raw = await body(req);
        if (!raw.includes('name="video"')) return json(res, 400, { detail: 'No video file provided' });
        return json(res, 200, { video_path: `upload://${nextId('up')}.mp4` });
      }
      if (p === '/tasks/' && req.method === 'POST') {
        const b = JSON.parse((await body(req)).toString());
        const id = nextId('task');
        tasks.set(id, { id, polls: 0, body: b });
        return json(res, 200, { task_id: id });
      }
      if ((m = p.match(/^\/tasks\/([^/]+)$/))) {
        const t = tasks.get(m[1]);
        t.polls += 1;
        const done = t.polls > pollsUntilDone;
        return json(res, 200, { id: t.id, status: done ? 'completed' : 'processing', progress: done ? 100 : 40, progress_message: 'Rendering' });
      }
      if ((m = p.match(/^\/tasks\/([^/]+)\/clips$/))) {
        return json(res, 200, { clips: [{ id: `${m[1]}-c1`, hook_title: 'Угар на 4 минусе' }] });
      }
      if ((m = p.match(/^\/tasks\/([^/]+)\/clips\/([^/]+)\/file$/))) {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        return res.end(Buffer.from(`rendered:${m[2]}`));
      }
      json(res, 404, { message: `fake: no route ${req.method} ${p}` });
    } catch (err) {
      json(res, 500, { message: err.message });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    root,
    files,
    tickets,
    tasks,
    calls,
    addFile,
    pathOf(id) {
      const names = [];
      let f = files.get(id);
      while (f && f.id !== root) {
        names.unshift(f.name);
        f = files.get(f.parents[0]);
      }
      return names.join('/');
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
