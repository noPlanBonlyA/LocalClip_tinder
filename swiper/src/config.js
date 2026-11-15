import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env parser: KEY=value, # comments, optional quotes. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function loadConfig(overrides = {}) {
  const file = { ...readEnvFile(path.join(ROOT, '.env')) };
  // Process env wins over the file, explicit overrides (tests) win over both.
  const env = { ...file, ...process.env, ...overrides };
  const get = (key, fallback = '') => {
    const v = env[key];
    return v === undefined || v === '' ? fallback : String(v);
  };
  const int = (key, fallback) => {
    const n = Number.parseInt(get(key, ''), 10);
    return Number.isFinite(n) ? n : fallback;
  };

  const dataDir = path.resolve(ROOT, get('DATA_DIR', 'data'));
  mkdirSync(dataDir, { recursive: true });

  let sessionSecret = get('SESSION_SECRET');
  if (!sessionSecret) {
    const secretFile = path.join(dataDir, 'session-secret');
    if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'));
    sessionSecret = readFileSync(secretFile, 'utf8').trim();
  }

  let taskOptions = {};
  try {
    taskOptions = JSON.parse(get('LOCALCLIP_TASK_OPTIONS', '{}'));
  } catch {
    console.warn('[config] LOCALCLIP_TASK_OPTIONS is not valid JSON, ignored');
  }

  const localclipEnvFile = path.resolve(ROOT, get('LOCALCLIP_ENV_FILE', '../.env'));
  const localclipEnv = readEnvFile(localclipEnvFile);

  return {
    host: get('HOST', '127.0.0.1'),
    port: int('PORT', 3200),
    appPassword: get('APP_PASSWORD'),
    sessionSecret,
    dataDir,
    syncIntervalMs: Math.max(10, int('SYNC_INTERVAL_SEC', 60)) * 1000,
    google: {
      clientId: get('GOOGLE_CLIENT_ID'),
      clientSecret: get('GOOGLE_CLIENT_SECRET'),
      refreshToken: get('GOOGLE_REFRESH_TOKEN'),
      // Tests point these at a fake server.
      apiBase: get('GOOGLE_API_BASE', 'https://www.googleapis.com'),
      tokenUrl: get('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
    },
    drive: {
      rootFolderId: get('DRIVE_ROOT_FOLDER_ID'),
      toSortName: get('DRIVE_TO_SORT_NAME', 'to sort'),
      montageName: get('DRIVE_MONTAGE_NAME', 'montage'),
      trashName: get('DRIVE_TRASH_NAME', 'trash'),
      sourcesSubfolder: get('DRIVE_SOURCES_SUBFOLDER', 'исходники'),
    },
    crm: {
      apiUrl: get('CRM_API_URL').replace(/\/+$/, ''),
      login: get('CRM_LOGIN'),
      password: get('CRM_PASSWORD'),
    },
    localclip: {
      apiUrl: get('LOCALCLIP_API_URL', 'http://127.0.0.1:8000').replace(/\/+$/, ''),
      authSecret: get('LOCALCLIP_BACKEND_AUTH_SECRET', localclipEnv.BACKEND_AUTH_SECRET || ''),
      databaseUrl: get(
        'LOCALCLIP_DATABASE_URL',
        'postgresql://supoclip:supoclip_password@127.0.0.1:5433/supoclip',
      ),
      userId: get('LOCALCLIP_USER_ID'),
      taskOptions,
      timeoutMs: Math.max(1, int('LOCALCLIP_TIMEOUT_MIN', 120)) * 60_000,
      pollMs: Math.max(200, int('LOCALCLIP_POLL_MS', 10_000)),
      waitMs: Math.max(100, int('LOCALCLIP_WAIT_MS', 30_000)),
    },
  };
}
