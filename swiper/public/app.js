// Clip Tinder — front-end (no build step).
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  },
};

const S = {
  tab: 'new',
  streamer: store.get('streamer', ''),
  muted: store.get('muted', true),
  data: null,
  decided: new Map(), // id -> status it had when swiped here; hidden until the server moves it on
  skipped: [], // "maybe" tab: ids pushed to the end locally
  deckIds: '',
  pollTimer: null,
};

// ------------------------------------------------------------------ api

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Нужно войти');
  }
  if (!res.ok) throw new Error(data.message || `Ошибка ${res.status}`);
  return data;
}

const qs = () => (S.streamer ? `?streamer=${encodeURIComponent(S.streamer)}` : '');

async function refresh({ sync = false } = {}) {
  const btn = $('#refresh');
  if (sync) btn.classList.add('spin');
  try {
    S.data = await api(sync ? `/api/sync${qs()}` : `/api/state${qs()}`, { method: sync ? 'POST' : 'GET' });
    // Drop optimistic ids the server already moved on.
    const statusOf = new Map([...S.data.queue, ...S.data.maybe].map((c) => [c.id, c.status]));
    for (const [id, was] of [...S.decided]) if (statusOf.get(id) !== was) S.decided.delete(id);
    render();
    setStatus(S.data.lastSyncError ? `Диск: ${S.data.lastSyncError}` : syncText(S.data.lastSyncAt), Boolean(S.data.lastSyncError));
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.classList.remove('spin');
    schedulePoll();
  }
}

function schedulePoll() {
  clearTimeout(S.pollTimer);
  const busy = S.data?.jobs?.some((j) => j.status === 'queued' || j.status === 'processing');
  S.pollTimer = setTimeout(refresh, S.tab === 'jobs' || busy ? 4000 : 15000);
}

const syncText = (iso) => (iso ? `Диск прочитан ${new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Диск ещё не прочитан');

function setStatus(text, bad = false) {
  const line = $('#status-line');
  line.textContent = text;
  line.classList.toggle('bad', bad);
}

// ------------------------------------------------------------------ formatting

const fmtDur = (ms) => {
  const s = Math.round(Number(ms) / 1000);
  return s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : null;
};
const fmtSize = (b) => (b ? `${(b / 1024 / 1024).toFixed(1)} МБ` : null);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const baseName = (n) => n.replace(/\.[^.]+$/, '');

// ------------------------------------------------------------------ render

function render() {
  if (!S.data) return;
  const visible = (list) => list.filter((c) => S.decided.get(c.id) !== c.status);
  const counts = {
    new: visible(S.data.queue).length,
    maybe: visible(S.data.maybe).length,
    jobs: S.data.jobs.filter((j) => j.status === 'queued' || j.status === 'processing' || j.status === 'error').length,
  };
  for (const [k, v] of Object.entries(counts)) $(`[data-count="${k}"]`).textContent = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));

  renderChips();
  const deckTab = S.tab === 'new' || S.tab === 'maybe';
  $('#deck-view').hidden = !deckTab;
  $('#list-view').hidden = deckTab;
  $('#streamers').hidden = !deckTab;
  if (deckTab) renderDeck();
  else renderList();
}

function renderChips() {
  const box = $('#streamers');
  const key = S.tab === 'maybe' ? 'maybe' : 'new';
  const list = S.data.streamers.filter((s) => s[key] > 0 || s.name === S.streamer);
  const total = list.reduce((n, s) => n + s[key], 0);
  box.replaceChildren(
    chip('', `Все · ${total}`),
    ...list.map((s) => chip(s.name, `${s.name} · ${s[key]}`)),
  );
  box.hidden = list.length < 2 && !S.streamer;
}

function chip(value, label) {
  const b = el('button', { className: `chip${S.streamer === value ? ' active' : ''}`, textContent: label });
  b.onclick = () => {
    S.streamer = value;
    store.set('streamer', value);
    S.deckIds = '';
    refresh();
  };
  return b;
}

function deckClips() {
  const list = (S.tab === 'maybe' ? S.data.maybe : S.data.queue).filter((c) => S.decided.get(c.id) !== c.status);
  if (S.tab !== 'maybe') return list;
  const rank = (c) => S.skipped.indexOf(c.id);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function renderDeck() {
  const clips = deckClips().slice(0, 2);
  const ids = clips.map((c) => c.id).join(',') + `|${S.tab}`;
  const deck = $('#deck');
  const enabled = clips.length > 0;
  for (const id of ['#btn-left', '#btn-right', '#btn-maybe', '#btn-full']) $(id).disabled = !enabled;
  $('#btn-maybe').title = S.tab === 'maybe' ? 'Пропустить (оставить на подумать)' : 'На подумать — ↑';
  if (ids === S.deckIds) return; // keep playing videos untouched between polls
  S.deckIds = ids;

  if (!clips.length) {
    deck.replaceChildren(
      el(
        'div',
        { className: 'empty' },
        el('div', { className: 'big', textContent: S.tab === 'maybe' ? '🤔' : '🎉' }),
        el('strong', { textContent: S.tab === 'maybe' ? 'Нечего обдумывать' : 'Все клипы разобраны' }),
        el('span', { textContent: 'Новые клипы из «to sort» появятся сами (или нажмите ⟳).' }),
      ),
    );
    return;
  }
  // Reuse the existing card node for a clip when possible (no video restart).
  const existing = new Map([...deck.querySelectorAll('.card')].map((n) => [n.dataset.id, n]));
  const nodes = clips.map((clip, i) => {
    const node = existing.get(clip.id) || buildCard(clip);
    node.classList.toggle('back', i > 0);
    node.style.transform = '';
    node.style.opacity = '';
    node.querySelectorAll('.stamp').forEach((s) => (s.style.opacity = 0));
    return node;
  });
  deck.replaceChildren(...nodes.reverse()); // top card last in DOM
  activate(nodes[nodes.length - 1]);
  const back = nodes.length > 1 ? nodes[0] : null;
  if (back) {
    const v = $('video', back);
    v.pause();
    v.preload = 'auto';
  }
}

function buildCard(clip) {
  const video = el('video', {
    src: `/api/clips/${encodeURIComponent(clip.id)}/video`,
    playsInline: true,
    loop: true,
    muted: true,
    preload: 'metadata',
  });
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  const bar = el('i');
  const meta = [fmtDur(clip.durationMs), fmtSize(clip.size), clip.width && clip.height ? `${clip.width}×${clip.height}` : null]
    .filter(Boolean)
    .join(' · ');
  const sound = el('button', { className: 'sound', ariaLabel: 'Звук', textContent: S.muted ? '🔇' : '🔊' });
  const card = el(
    'article',
    { className: 'card paused' },
    video,
    el('div', { className: 'loading', textContent: 'Загрузка…' }),
    el('div', { className: 'progress' }, bar),
    el('div', { className: 'shade' }),
    clip.status === 'maybe' ? el('div', { className: 'badge-maybe', textContent: 'на подумать' }) : null,
    sound,
    el('div', { className: 'play', textContent: '▶' }),
    el('div', { className: 'stamp yes', textContent: 'Монтаж' }),
    el('div', { className: 'stamp no', textContent: 'Удалить' }),
    el('div', { className: 'stamp maybe', textContent: S.tab === 'maybe' ? 'Позже' : 'Подумать' }),
    el(
      'div',
      { className: 'info' },
      el('span', { className: 'streamer', textContent: clip.streamer }),
      el('div', { className: 'title', textContent: baseName(clip.name) }),
      el('div', { className: 'meta', textContent: meta }),
    ),
  );
  card.dataset.id = clip.id;
  video.addEventListener('loadeddata', () => card.querySelector('.loading')?.remove());
  video.addEventListener('timeupdate', () => {
    if (video.duration) bar.style.width = `${(video.currentTime / video.duration) * 100}%`;
  });
  video.addEventListener('play', () => card.classList.remove('paused'));
  video.addEventListener('pause', () => card.classList.add('paused'));
  video.addEventListener('error', () => {
    const l = card.querySelector('.loading');
    if (l) l.textContent = 'Не удалось загрузить видео';
  });
  sound.addEventListener('pointerdown', (e) => e.stopPropagation());
  sound.addEventListener('click', (e) => {
    e.stopPropagation();
    setMuted(!S.muted);
  });
  attachDrag(card);
  return card;
}

function activate(card) {
  const v = $('video', card);
  v.preload = 'auto';
  v.muted = S.muted;
  v.play().catch(() => {
    // Autoplay with sound blocked: fall back to muted.
    v.muted = true;
    v.play().catch(() => {});
  });
}

function setMuted(muted) {
  S.muted = muted;
  store.set('muted', muted);
  document.querySelectorAll('.card .sound').forEach((b) => (b.textContent = muted ? '🔇' : '🔊'));
  const top = topCard();
  if (top) {
    const v = $('video', top);
    v.muted = muted;
    if (v.paused) v.play().catch(() => {});
  }
}

const topCard = () => {
  const cards = document.querySelectorAll('#deck .card');
  return cards[cards.length - 1] || null;
};

// ------------------------------------------------------------------ swipe

function attachDrag(card) {
  let start = null;
  const stamps = { yes: $('.stamp.yes', card), no: $('.stamp.no', card), maybe: $('.stamp.maybe', card) };

  card.addEventListener('pointerdown', (e) => {
    if (card.classList.contains('back') || e.button > 0) return;
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 40) * (dy < 0 ? 1 : 0.3)}px) rotate(${dx / 18}deg)`;
    stamps.yes.style.opacity = Math.max(0, Math.min(1, dx / 100));
    stamps.no.style.opacity = Math.max(0, Math.min(1, -dx / 100));
    stamps.maybe.style.opacity = Math.abs(dx) < 60 ? Math.max(0, Math.min(1, -dy / 110)) : 0;
  });
  const end = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const tap = Math.abs(dx) < 8 && Math.abs(dy) < 8 && Date.now() - start.t < 350;
    start = null;
    card.classList.remove('dragging');
    const w = card.offsetWidth;
    if (dx > Math.min(110, w * 0.28)) return decide('right');
    if (dx < -Math.min(110, w * 0.28)) return decide('left');
    if (dy < -120 && Math.abs(dx) < 70) return decide('maybe');
    card.style.transform = '';
    for (const s of Object.values(stamps)) s.style.opacity = 0;
    if (tap && e.type === 'pointerup') {
      const v = $('video', card);
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

const LABELS = { right: '✅ На монтаж (сокращённый)', full: '⏱ На монтаж целиком', left: '🗑 В корзину', maybe: '🤔 На подумать' };

async function decide(action) {
  const card = topCard();
  if (!card) return;
  const id = card.dataset.id;
  const clip = [...S.data.queue, ...S.data.maybe].find((c) => c.id === id);
  const fly = { right: 'translate(140%, 0) rotate(24deg)', full: 'translate(140%, -20%) rotate(18deg)', left: 'translate(-140%, 0) rotate(-24deg)', maybe: 'translate(0, -130%)' }[action];
  card.style.transform = fly;
  card.style.opacity = '0';
  $('video', card).pause();
  if (navigator.vibrate) navigator.vibrate(12);

  // "Maybe" inside the maybe tab = just look at it later.
  if (S.tab === 'maybe' && action === 'maybe') {
    S.skipped = [...S.skipped.filter((x) => x !== id), id];
    setTimeout(() => {
      S.deckIds = '';
      render();
    }, 200);
    return;
  }

  S.decided.set(id, clip?.status || (S.tab === 'maybe' ? 'maybe' : 'new'));
  setTimeout(() => {
    S.deckIds = '';
    render();
  }, 220);
  try {
    await api(`/api/clips/${encodeURIComponent(id)}/decision`, { method: 'POST', body: { action } });
    showToast(`${LABELS[action]}: ${clip ? baseName(clip.name) : ''}`, id);
    refresh();
  } catch (err) {
    S.decided.delete(id);
    S.deckIds = '';
    render();
    showToast(`Не получилось: ${err.message}`);
  }
}

// ------------------------------------------------------------------ toast / undo

let toastTimer;
function showToast(text, undoId) {
  $('#toast-text').textContent = text;
  const undo = $('#toast-undo');
  undo.hidden = !undoId;
  undo.onclick = undoId ? () => doUndo(undoId) : null;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), undoId ? 7000 : 4000);
}

async function doUndo(id) {
  $('#toast').hidden = true;
  try {
    await api(`/api/clips/${encodeURIComponent(id)}/undo`, { method: 'POST' });
    S.decided.delete(id);
    S.deckIds = '';
    await refresh();
    showToast('↩︎ Отменено');
  } catch (err) {
    showToast(err.message);
  }
}

// ------------------------------------------------------------------ lists (montage / trash)

function renderList() {
  const box = $('#list-view');
  const items = S.tab === 'jobs' ? S.data.jobs : S.data.trashed;
  if (!items.length) {
    box.replaceChildren(
      el('div', { className: 'list-empty', textContent: S.tab === 'jobs' ? 'Пока ничего не отправлено на монтаж' : 'Корзина пуста' }),
    );
    return;
  }
  box.replaceChildren(...items.map(row));
}

const PILL = { queued: 'в очереди', processing: 'монтаж', done: 'готово', error: 'ошибка', trashed: 'удалено' };
const pillText = (c) => (c.progress?.waiting ? 'ждёт ПК' : PILL[c.status] || c.status);

function row(c) {
  const parts = [
    el(
      'div',
      { className: 'row-head' },
      el('div', { className: 'row-title', textContent: baseName(c.name) }),
      el('span', { className: `pill ${c.progress?.waiting ? 'queued' : c.status}`, textContent: pillText(c) }),
    ),
    el(
      'div',
      {
        className: 'row-sub',
        textContent: [
          c.streamer,
          fmtDur(c.durationMs),
          c.montageMode === 'full' ? 'целиком' : c.montageMode === 'cut' ? 'сокращённый' : null,
          fmtTime(c.decidedAt),
          c.crmTicketId ? `тикет #${c.crmTicketId}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      },
    ),
  ];
  if (c.status === 'processing' || c.status === 'queued') {
    const pct = c.progress?.percent ?? (c.status === 'queued' ? 0 : 5);
    parts.push(el('div', { className: 'bar' }, el('i', { style: `width:${pct}%` })));
    parts.push(el('div', { className: 'row-sub', textContent: c.progress?.message || 'Ждёт своей очереди' }));
  }
  if (c.error) parts.push(el('div', { className: 'err-text', textContent: c.error }));
  if (c.outputs?.length) {
    parts.push(
      el(
        'div',
        { className: 'links' },
        ...c.outputs.map((o) => el('a', { href: o.webViewLink, target: '_blank', rel: 'noopener', textContent: `▶ ${o.name}${o.hookTitle ? ` — «${o.hookTitle}»` : ''}` })),
      ),
    );
  }
  const actions = [];
  if (c.status === 'error') actions.push(button('Повторить', () => act(c.id, 'retry', 'Повторяем монтаж')));
  if (c.status === 'queued') actions.push(button('Отменить', () => doUndo(c.id)));
  if (c.status === 'trashed') actions.push(button('Вернуть в to sort', () => doUndo(c.id)));
  actions.push(el('a', { className: 'btn ghost small', href: c.webViewLink, target: '_blank', rel: 'noopener', textContent: 'Исходник' }));
  parts.push(el('div', { className: 'row-actions' }, ...actions));
  return el('div', { className: 'row' }, ...parts);
}

const button = (text, onclick) => Object.assign(el('button', { className: 'btn small', textContent: text }), { onclick });

async function act(id, action, okText) {
  try {
    await api(`/api/clips/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    showToast(okText);
    refresh();
  } catch (err) {
    showToast(err.message);
  }
}

// ------------------------------------------------------------------ login / boot

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  clearTimeout(S.pollTimer);
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { name: form.get('name'), password: form.get('password') } });
    showApp();
    refresh();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    S.tab = t.dataset.tab;
    S.deckIds = '';
    document.querySelectorAll('#deck video').forEach((v) => v.pause());
    render();
    schedulePoll();
  }),
);
$('#refresh').addEventListener('click', () => refresh({ sync: true }));
$('#btn-left').addEventListener('click', () => decide('left'));
$('#btn-right').addEventListener('click', () => decide('right'));
$('#btn-full').addEventListener('click', () => decide('full'));
$('#btn-maybe').addEventListener('click', () => decide('maybe'));

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden || e.target.closest('input')) return;
  const deckTab = S.tab === 'new' || S.tab === 'maybe';
  if (!deckTab) return;
  if (e.key === 'ArrowRight') decide(e.shiftKey ? 'full' : 'right');
  else if (e.key === 'f' || e.key === 'а') decide('full');
  else if (e.key === 'ArrowLeft') decide('left');
  else if (e.key === 'ArrowUp') decide('maybe');
  else if (e.key === 'm' || e.key === 'ь') setMuted(!S.muted);
  else if (e.key === ' ') {
    const v = topCard() && $('video', topCard());
    if (v) v.paused ? v.play().catch(() => {}) : v.pause();
  } else return;
  e.preventDefault();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#app').hidden) refresh();
});

(async () => {
  try {
    await api('/api/me');
    showApp();
    refresh();
  } catch {
    showLogin();
  }
})();
