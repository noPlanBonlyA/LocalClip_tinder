// One-time: get a Google Drive refresh token and write it to swiper/.env.
// Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (OAuth client of type "Desktop app") in swiper/.env.
//   npm run google-auth
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, loadConfig } from '../src/config.js';

const config = loadConfig();
const { clientId, clientSecret } = config.google;
if (!clientId || !clientSecret) {
  console.error('Сначала впишите GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET в swiper/.env (см. README).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const server = http.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive',
  access_type: 'offline',
  prompt: 'consent',
  state,
}).toString();

console.log('\nОткройте ссылку в браузере и войдите аккаунтом, у которого есть доступ на редактирование папки на Диске:\n');
console.log(authUrl.toString(), '\n');

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== '/callback') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
      res.end('<h2>Ошибка авторизации, попробуйте ещё раз.</h2>');
      return reject(new Error(url.searchParams.get('error') || 'bad state'));
    }
    res.end('<h2>Готово! Можно закрыть вкладку и вернуться в терминал.</h2>');
    resolve(url.searchParams.get('code'));
  });
});
server.close();

const res = await fetch(config.google.tokenUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }),
});
const body = await res.json();
if (!res.ok || !body.refresh_token) {
  console.error('Google не выдал refresh_token:', body);
  process.exit(1);
}

const envFile = path.join(ROOT, '.env');
let env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
env = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)
  ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${body.refresh_token}`)
  : `${env.trimEnd()}\nGOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`;
writeFileSync(envFile, env);
console.log('✅ GOOGLE_REFRESH_TOKEN записан в swiper/.env. Перезапустите свайпер.');
