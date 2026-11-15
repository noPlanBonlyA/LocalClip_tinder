# Clip Tinder — как развернуть, чтобы всё работало

## Где что крутится

```
 телефон / комп команды
          │ https
          ▼
 ┌──────────────────────────┐     Google Drive API     ┌──────────────────────┐
 │  Свайпер (сайт)          │ ───────────────────────▶ │  Google Диск         │
 │  сервер: Railway         │                          │  to sort / montage / │
 │  папка swiper/           │ ───── CRM API ─────────▶ │  trash               │
 └──────────┬───────────────┘   (Railway, уже есть)    └──────────────────────┘
            │ https, постоянный адрес Tailscale Funnel
            ▼
 ┌──────────────────────────┐
 │  LocalClip (монтаж)      │   Windows-ПК с видеокартой NVIDIA,
 │  :8000 API + воркер      │   должен быть включён, когда нужен монтаж
 └──────────────────────────┘
```

- **Свайпер** работает на сервере, поэтому открывается с телефона всегда, даже когда ПК выключен. Свайпать можно в любое время: клипы «на монтаж» ждут в очереди со статусом «ждёт ПК» и монтируются, как только ПК и LocalClip включатся.
- **LocalClip** работает только на Windows-ПК: монтаж идёт на его видеокарте. Наружу он открыт через **Tailscale Funnel**. Это бесплатный постоянный https-адрес вида `https://<имя-пк>.<что-то>.ts.net`, и он не меняется при перезапусках, в отличие от быстрого туннеля Cloudflare. Без подписи секретом `BACKEND_AUTH_SECRET` API LocalClip запросы не принимает.
- **CRM** уже на Railway: `https://api-production-34217a49.up.railway.app`. В ней ничего менять не нужно.

Порядок: **1 → 2 → 3 → 4**. Потом проверка.

## Перед началом: что нужно от человека

> **Для нейронки, которая это выполняет.** Секреты не печатай, не пересылай и не коммить. Входы в аккаунты и вставку токенов делает человек: дойдя до такого шага, остановись и попроси его. Проверяй только наличие и формат значения, например «начинается с `sk-ant-oat`», но не само значение.

**Входы в аккаунты (делает человек):**

| Шаг | Куда входить |
|---|---|
| 1.3 | `claude setup-token`: аккаунт Claude с подпиской Pro или Max |
| 1.6 | Tailscale: любой аккаунт, например Google |
| 2.2 | `npm run google-auth`: аккаунт-владелец папки на Диске (`andrey.spb521@gmail.com`) |
| 2.1 | Google Cloud Console, проект clipTinder, тот же аккаунт |
| 4 | Railway: аккаунт, где уже стоит CRM |

**Секреты и где их взять.** В git их нет и не должно быть:

| Секрет | Откуда | Куда |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` на ПК | `.env` LocalClip на ПК |
| `BACKEND_AUTH_SECRET` | `.env` LocalClip на ПК (создаётся при первом запуске) | Railway: `LOCALCLIP_BACKEND_AUTH_SECRET` |
| `LOCALCLIP_USER_ID` | база LocalClip на ПК (шаг 1.5) | Railway |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `swiper/.env` на Маке, где свайпер настраивался первым | Railway |
| `GOOGLE_REFRESH_TOKEN` | `npm run google-auth` (шаг 2.2) | Railway |
| `CRM_LOGIN`, `CRM_PASSWORD` | пользователь в CRM → «Команда» | Railway |
| `APP_PASSWORD`, `SESSION_SECRET` | придумать (`openssl rand -hex 32`) | Railway |

**Если `swiper/.env` с Мака недоступен.** Секрет OAuth-клиента в консоли Google повторно не посмотреть. Откройте https://console.cloud.google.com/auth/clients?project=cliptinder → клиент «swiper» → **Add secret** (или создайте новый клиент типа Desktop app). Скопируйте ID и новый секрет в `swiper/.env`, затем выполните шаг 2.2.

**Файлы, которых нет в репозитории** и которые при переезде нужно перенести руками с машины, где свайпер работал раньше:
- `swiper/.env` — ключи (см. выше);
- `swiper/data/state.json` — очередь, связь клипов с тикетами, история. Без него сервер создаст тикеты заново для клипов, которые ещё лежат в `to sort` (см. шаг 4).

Старый свайпер (например, на Маке) нужно **остановить** до запуска нового, иначе тикеты в CRM задвоятся.

---

## 1. Windows-ПК: LocalClip

Нужны: Windows 10/11, видеокарта NVIDIA, подписка Claude (Pro или Max).

1. **Склонировать** репозиторий в обычную папку, не в OneDrive:
   ```
   git clone https://github.com/noPlanBonlyA/LocalClip_tinder.git C:\gta6_clip\LocalClip_tinder
   ```
2. **Запустить** `LocalClip.cmd`. Первый запуск долгий: качаются Python, Node, ffmpeg, CUDA, PostgreSQL, Redis и Whisper. Потом обязательно **один раз открыть http://localhost:3107** в браузере: так создаётся встроенный пользователь.
3. **Токен Claude.** Без него LocalClip не сможет вызвать AI («Not logged in»). В обычном PowerShell выполнить `claude setup-token` и войти. В `C:\gta6_clip\LocalClip_tinder\.env` вписать `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…`, без кавычек и пробелов. Токен живёт год.
4. **Перезапустить LocalClip:** `Close LocalClip.cmd`, затем `LocalClip.cmd`. Проверка: http://127.0.0.1:8000/health → `{"status":"healthy"}`.
5. **Достать данные для свайпера.** Они понадобятся на шаге 4:
   - `LOCALCLIP_BACKEND_AUTH_SECRET` — значение `BACKEND_AUTH_SECRET` из того же `.env`;
   - `LOCALCLIP_USER_ID` — выполнить в PowerShell:
     ```
     $env:PGPASSWORD = "supoclip_password"
     & "C:\gta6_clip\LocalClip_tinder\.localclip\tools\pgsql\bin\psql.exe" -h 127.0.0.1 -p 5433 -U supoclip -d supoclip -t -c "SELECT id FROM users WHERE email='me@localclip.local'"
     ```
6. **Постоянный адрес через Tailscale Funnel:**
   - `winget install -e --id tailscale.tailscale`, затем войти в Tailscale (иконка в трее → Log in; подойдёт аккаунт Google);
   - в PowerShell от администратора выполнить `tailscale funnel --bg 8000`. При первом запуске он даст ссылку: открыть её и разрешить HTTPS и Funnel для своей сети Tailscale. Потом повторить команду;
   - `tailscale funnel status` покажет адрес `https://<имя-пк>.<tailnet>.ts.net`. Это **`LOCALCLIP_API_URL`**;
   - проверка из любого браузера: `https://<имя-пк>.<tailnet>.ts.net/health` → `{"status":"healthy"}`.

   Funnel с `--bg` переживает перезагрузку ПК, запускать его второй раз не нужно.
7. **Автозапуск LocalClip.** Нажать Win+R → `shell:startup` и положить в открывшуюся папку ярлык на `LocalClip.cmd`. Тогда LocalClip сам стартует при входе в Windows.

> Если домен уже есть в Cloudflare, вместо Tailscale подойдёт постоянный туннель Cloudflare (Zero Trust → Networks → Tunnels, сервис `http://127.0.0.1:8000`). Быстрый туннель `cloudflared tunnel --url …` для сервера **не подходит**: его адрес меняется при каждом запуске.

**Видеокарта.** Режим вычислений LocalClip подбирает сам: на RTX 20xx и новее — float16, на старых вроде GTX 1050 Ti — int8. Если на карте с 4 ГБ появится «out of memory», добавь в `.env` строку `WHISPER_GPU_BATCH_SIZE=4`. Пока идёт монтаж, лучше не играть: видеопамять общая.

---

## 2. Google Диск (OAuth)

Уже сделано: проект **clipTinder** в Google Cloud, включён Google Drive API, создан OAuth-клиент «swiper» (Desktop app). Его ID и секрет лежат в `swiper/.env` на Маке.

Что осталось:

1. **Опубликовать приложение**, иначе Google отзывает токен каждые 7 дней.
   - https://console.cloud.google.com/auth/branding?project=cliptinder: в «Application home page» вписать адрес свайпера (появится на шаге 4), в «Application privacy policy link» — `<адрес свайпера>/privacy`. Сохранить.
   - https://console.cloud.google.com/auth/audience?project=cliptinder → **Publish app**.
   - Если Google попросит подтвердить домен или пройти проверку — для внутреннего инструмента это не обязательно, можно остаться в режиме Testing. Тогда раз в неделю нужно повторять шаг 2.
2. **Получить токен** на любом компьютере с Node 22+, где есть `swiper/.env` с `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`:
   ```
   cd swiper && npm install && npm run google-auth
   ```
   Войти аккаунтом-владельцем папки на Диске (`andrey.spb521@gmail.com`). `GOOGLE_REFRESH_TOKEN` появится в `swiper/.env`; его значение понадобится на шаге 4.

Структура на Диске (папка `DRIVE_ROOT_FOLDER_ID` = `1TUTNzuNI8n9tv5NlN72EKkdZYHuP6GsH`):

```
to sort/<стример>/клип.mp4      ← сюда кидаете клипы
montage/<стример>/              ← готовые видео (создаётся само)
montage/<стример>/исходники/    ← исходники после монтажа
trash/<стример>/                ← удалённые свайпом влево
```

---

## 3. CRM

Ничего менять не нужно. Лучше завести в разделе **«Команда»** отдельного пользователя `swiper`, чтобы в CRM было видно, какие тикеты создал автомат. Его логин и пароль пойдут в `CRM_LOGIN` и `CRM_PASSWORD`.

Что делает свайпер с тикетами:

| Событие | Тикет |
|---|---|
| клип появился в `to sort` | создаётся в «Бэклоге»: ссылка, размер, длительность, история |
| свайп влево | остаётся в «Бэклоге», в названии `[УДАЛИТЬ]` |
| «на подумать» | остаётся в «Бэклоге» |
| смонтировано | готовые видео прикрепляются к тикету, тикет → «Уникализировано» |

---

## 4. Сервер: свайпер на Railway

1. В Railway: **New → GitHub Repo → `noPlanBonlyA/LocalClip_tinder`**. Можно в том же проекте, где CRM.
2. В настройках сервиса:
   - **Root Directory:** `swiper`. Railway сам найдёт `swiper/Dockerfile`;
   - **Volumes → Add Volume**, mount path `/data`. Там хранится состояние очереди, без тома оно теряется при каждом деплое;
   - **Networking → Generate Domain**. Получится `https://<что-то>.up.railway.app`, это адрес свайпера для команды.
3. **Variables:**

   | Переменная | Значение |
   |---|---|
   | `APP_PASSWORD` | общий пароль команды для входа на сайт |
   | `SESSION_SECRET` | случайная строка ≥ 32 символов (`openssl rand -hex 32`) |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | из `swiper/.env` (шаг 2) |
   | `GOOGLE_REFRESH_TOKEN` | из `swiper/.env` после `npm run google-auth` |
   | `DRIVE_ROOT_FOLDER_ID` | `1TUTNzuNI8n9tv5NlN72EKkdZYHuP6GsH` |
   | `CRM_API_URL` | `https://api-production-34217a49.up.railway.app` |
   | `CRM_LOGIN`, `CRM_PASSWORD` | пользователь CRM (шаг 3) |
   | `LOCALCLIP_API_URL` | адрес Tailscale Funnel (шаг 1.6) |
   | `LOCALCLIP_BACKEND_AUTH_SECRET` | `BACKEND_AUTH_SECRET` из `.env` LocalClip (шаг 1.5) |
   | `LOCALCLIP_USER_ID` | id из шага 1.5 |

   Остальное можно не задавать: значения по умолчанию из `swiper/.env.example` подходят.
4. **Deploy.** Если Railway попросит health check path, укажи `/`.
5. Вернуться на шаг 2.1 и вписать адрес свайпера в Branding Google.

> **Перенос с Мака.** Если до этого свайпер работал на Маке, перед первым запуском на сервере скопируйте `swiper/data/state.json` в том `/data`, например через `railway run`. Иначе сервер начнёт с нуля и создаст в CRM новые тикеты для клипов, которые ещё лежат в `to sort`. Клипы, уже разобранные на Маке, в `to sort` больше не лежат и задвоены не будут.
>
> Важно: одновременно должен работать **только один** свайпер. Если запустить свайпер и на Маке, и на сервере, тикеты в CRM задвоятся.

---

## Проверка

1. Открыть адрес свайпера с телефона, войти: имя любое, пароль `APP_PASSWORD`. Добавить на главный экран: «Поделиться» → «На экран Домой».
2. Положить клип в `to sort/<стример>/` на Диске. Не позже чем через минуту, или сразу по кнопке ⟳, он появится в свайпере, а в CRM — в «Бэклоге».
3. Свайпнуть вправо. Во вкладке «Монтаж» статус пойдёт так: «Скачиваю» → «Загружаю в LocalClip» → «Generating transcript» → «Analyzing content with AI» → «Creating clip» → «Выгружаю на Google Диск» → **готово**. Видео появится в `montage/<стример>/`, тикет переедет в «Уникализировано». На GTX 1050 Ti клип длиной 20 с монтируется примерно за 1,5 минуты.

Режимы монтажа:
- **свайп вправо / ✓** — сокращённый: LocalClip вырезает паузы и слова-паразиты;
- **«⏱ целиком»** — по полному хронометражу, файл `имя (целиком).mp4`.

## Частые проблемы

| Симптом в свайпере | Что делать |
|---|---|
| «ждёт ПК» | ПК выключен, LocalClip не запущен или Funnel не работает. Проверь `https://<…>.ts.net/health` |
| `Requested float16 compute type…` | старая версия LocalClip: на ПК выполнить `git pull` и перезапустить LocalClip |
| `Claude Code failed: Not logged in` | не задан `CLAUDE_CODE_OAUTH_TOKEN` в `.env` LocalClip (шаг 1.3), после этого перезапустить LocalClip |
| `Google OAuth: invalid_grant` | токен Google отозван (приложение не опубликовано и прошло 7 дней): повторить шаг 2.2 и обновить `GOOGLE_REFRESH_TOKEN` на сервере |
| `CRM login: 401` | неверный `CRM_LOGIN` или `CRM_PASSWORD` |
| ошибка монтажа | во вкладке «Монтаж» нажать **«Повторить»**; логи LocalClip — в `.localclip\logs` на ПК |

## Вариант без сервера

Всё можно запустить и на одном Windows-ПК: `Swiper.cmd` поднимает свайпер рядом с LocalClip и открывает его через туннель Cloudflare. Подробности — в [swiper/README.md](swiper/README.md). Минус: сайт доступен, только пока ПК включён.
