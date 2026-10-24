# CLAUDE.md — Agarwal Brothers Sales App (AB Sales)

Working notes for Claude (and any developer) on this project: what it is, how it is built, the owner's rules, and a log of the work.
Keep this file up to date after every batch of work.

## 1. What this is

- **Offline Android app (APK) for the field sales team of Agarwal Brothers** (lab equipment supplier, Jaipur). A rep records **expenses (with a bill photo), clients and meetings** on the phone (it works fully offline) and, once the rep signs in to the office, the app **syncs them to the website**. Management sees them (and the insights) in the website's admin panel, page **Sales team > Sales management**.
- **Separate repo:** `https://github.com/Syntaxio-dev/ab-sales-app.git`, branch `main`, remote `origin` is connected. Local path `C:\xampp\htdocs\ab-sales-app`.
- The website is another project: `C:\xampp\htdocs\AB-new-project1` (Laravel 12 + Filament). Read its `CLAUDE.md` for the palette and its rules. **Never edit the website from this project's sessions unless the owner asks.** On 25 Oct 2026 the owner asked for the connection: the website now has an isolated Sales module (`app/Sales`, API `/api/sales/v1`, contract in the website's `docs/sales-api.md`, its own `CLAUDE.md` section). **Rule: every new app feature also gets its table/fields in the API and an insight on the website's Sales management page.** The module is built so it can move to a sub-domain later.
- The sister app **Prysm** (`C:\xampp\htdocs\personal-app`) uses the same stack and release flow. Its `CLAUDE.md` is the model for this one.
- Sideloaded APK (no Play Store). Android 8+ (minSdk 26).
- **Owner:** writes Hinglish, **has no app-development experience**, cannot specify details. So decide like a senior developer, explain briefly in short plain Hinglish, and **think about security risk in every step** (owner's explicit instruction).

## 2. Standing rules (owner's)

1. Reply in short, plain Hinglish. Be honest: say what was verified and what was NOT (the Java/native side only compiles in CI; nothing was run on a real phone yet).
2. **Security first** in every decision (section 6).
3. **Commit and push only when told** ("commit" / "push kr do"). Batch changes. (25 Oct: the owner told me to push both projects and update Hostinger after the sync work.)
4. **Update this CLAUDE.md after every batch of work.**
5. Never write secrets (passwords, keystore, tokens) into any file in this repo.
6. Ask before destructive actions. Never delete the owner's files without a clear answer (see section 9: disk clean-up).
7. Palette only: the website's colours, in a **light and a dark variant** (tokens in `src/style.css`, section 7). No new colours, and no hard-coded colour outside the token block. UI text in English. Mobile first. No emoji; icons are the inline SVG line icons in `src/ui/dom.js`.
8. Never use native `alert/confirm/prompt`: use `confirmDialog`, `alertDialog`, `dialog`, `toast` from `src/ui/kit.js`.

## 3. Hard rules (do not break)

1. **Never change `appId` `com.agarwalbrothers.sales`** (capacitor.config.json, android/app/build.gradle). A new id is a new app and all data on the phones is lost on update.
2. **Never change the signing key.** It lives OUTSIDE the repo: `C:\Users\DELL\ab-sales-keystore\` (`ab-sales.p12`, `KEYSTORE_PASSWORD.txt`, `KEYSTORE_BASE64.txt`). The owner must **back it up** and paste the two GitHub secrets `KEYSTORE_BASE64` and `KEYSTORE_PASSWORD` (alias is `absales`). A different key blocks in-place updates.
3. **The only network code is `src/sync/http.js`** (https only, to the one office address fixed at build time; no `XMLHttpRequest`, `WebSocket`, analytics or remote scripts anywhere). `tests/source-rules.test.js` fails if `fetch` appears outside that file, if its strict options are removed, or if a web address is written into the source. The manifest asks for **INTERNET and nothing else dangerous** (plus the unused normal `USE_BIOMETRIC` / `USE_FINGERPRINT` of the secure-storage plugin).
4. Never use `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `eval`: text goes in through `h()` in `src/ui/dom.js` (text nodes only). Tested.
5. **Stored data format is a promise:** records and keys in `src/data/store.js` (`e:`, `c:`, `m:`, `b:`, `t:` slots, `profile`, `sync`, field names). New fields get defaults when read; never rename or drop old ones, or phones with data break. Field names already match what the office server will use (`uuid`, `amount_paise`, `expense_date`, `next_followup_at` ...).
6. `status` of an expense is never taken from the phone's form: only the office changes it, through sync (`putFromServer`). `Store.saveExpense` keeps the old value, and an approved or rejected expense can no longer be edited or deleted on the phone (the app shows it read-only).
7. Money is whole **paise** (integer). Times are UTC ISO strings; shown in local time. Expense date is a plain `YYYY-MM-DD`.
8. Build (`npm run build`) and run `npm test` before saying "done".

## 4. Stack

- **Vite 8 + vanilla JavaScript** (ES modules, no framework) → wrapped by **Capacitor 8** into an Android APK. Fonts via `@fontsource` (bundled, work offline): **Sora** (headings, amounts), **Manrope** (all UI text), **JetBrains Mono** (small uppercase labels).
- **Plugins:** `@capacitor-community/sqlite` (durable storage), `@aparajita/capacitor-secure-storage` (Android Keystore backed secrets), `@capacitor/camera` (system camera / gallery, no CAMERA permission), `@capacitor/share` + `@capacitor/filesystem` (export), `@capacitor/app` (background / back button).
- **Build:** GitHub Actions (`.github/workflows/build-apk.yml`) runs tests, builds and signs the APK. **This laptop (8 GB RAM, 2 cores) cannot build it locally and does not need to.**
- Browser preview: `npm run dev` → http://127.0.0.1:5173 (Chrome mobile view, Ctrl+Shift+M). Production-like preview with the CSP: `npm run build` then `npm run preview` → http://127.0.0.1:4173.

## 5. Project map

```
index.html, vite.config.js (CSP in the build, __APP_VERSION__ from package.json), capacitor.config.json
src/
  main.js              boot, three states (setup / locked / unlocked), tab shell, back button, auto-lock wiring
  app.js               App controller: phase, setUp / unlock / lock / changePin / eraseEverything, auto-lock timer
  core/                phone.js (+91 normalising), rules.js (ALL validation, also re-checked in the store), csv.js (formula-safe)
  security/            crypto.js (WebCrypto helpers), vault.js (PIN, key wrapping, lockout)
  data/                store.js (encrypted records + sync bookkeeping: dirty flags, tombstones, `sync` slot), persist.js (Memory / LocalStorage persistence)
  sync/                http.js (the ONLY network code), engine.js (SyncEngine: connect, push, bill upload, pull, bill download), merge.js (cleaners + conflict rule)
  config.js            SERVER_URL / API_BASE from VITE_SERVER_URL (fixed at build time; empty = no office link)
  platform/            native.js (phone: SQLite, Keystore, camera, share), web.js (browser preview only)
  ui/                  dom.js (h, icon, svg), kit.js (pages, dialogs, toast, field, chipGroup), auth.js (setup + lock keypad), tabs.js (4 screens),
                       forms.js (incl. the read-only reviewed expense), settings.js (incl. Appearance, Office), office.js (Home sync card, Connect page, Settings office group), export.js, format.js, theme.js (light / dark / system)
  style.css            all styles; every colour is a token in :root and :root[data-theme="dark"]
public/theme-init.js   plain script in <head>: sets data-theme before the first paint (no white flash)
tests/                 node --test: core, vault, store, compat, sync (+ helpers/fake-office.js, a fake of the API), source-rules   (npm test)
assets/ab-logo.png     the company logo (copy of the website's sidebar-logo.png); source of all icons
scripts/make-icons.mjs builds the launcher icons + splash screens from it (needs: npm i --no-save sharp)
android/               Capacitor project, hardened (manifest, FLAG_SECURE in MainActivity.java, signing in app/build.gradle)
```

## 6. Security design (do not weaken without asking the owner)

- **Encrypted at rest.** Every record and bill photo is sealed with AES-256-GCM before it reaches SQLite; the storage slot (`e:<id>` ...) is part of what is authenticated, so a record moved to another slot is refused. A changed byte is detected.
- **PIN (6 digits) is never stored.** Stored in the Keystore backed store: salt, a random device secret, and the data key wrapped (AES-GCM) with `KEK = HMAC(deviceSecret, PBKDF2-SHA256(pin, salt, 300 000))`. An attacker needs the device's secret store **and** the PIN. Changing the PIN only re-wraps the key.
- **Lockout:** 5 wrong PINs, then 30 s, 1 m, 2 m, 5 m, 15 m. Kept in secure storage (survives restart). Weak PINs (111111, 123456, 654321) are refused.
- **Auto-lock** after 60 s in the background; locking closes the store (decrypted records leave memory) and closes every open page/dialog. The camera pauses the timer on purpose (`app.suspendAutoLock`).
- **Forgot PIN = erase the app data.** Once the phone was synced, the office holds a copy: sign in again on the fresh install and everything (bill photos too) comes back.
- **Android:** `allowBackup=false` + data-extraction rules (no cloud/adb backup), cleartext off, `FLAG_SECURE` (no screenshots, blank recent-apps card), WebView debugging off, **no INTERNET and no dangerous permissions**, INTERNET only (added back on 25 Oct 2026 with the office link). Still to do: certificate pinning.
- **Content-Security-Policy** in the production build only: own files only, `connect-src 'self' <office origin>` (built from `VITE_SERVER_URL`; the build refuses anything but https), no inline script/style.
- **Office link (sync):** the password is sent once to sign in and is never stored; only the 30-day token is kept, **inside the encrypted data** (it is gone when the app is locked). One phone per rep: signing in on a second phone signs the first out (its data stays). Everything coming from the server is re-validated (`sync/merge.js` cleaners) and shown as text only; the office's decision on an expense always wins; a different account than the one the phone was set up for needs an explicit confirmation. Local development may use `http://127.0.0.1` only (`ALLOW_LOCAL_HTTP` = Vite dev mode).
- **Export** leaves the phone unencrypted by nature: the app warns before sharing. CSV cells starting with `= + - @` get an apostrophe (formula injection). Export files live in the app's private cache and are deleted on every lock / start.
- **Logging:** never log PINs, keys or record contents. A test fails on `console.log/info/debug`.
- **Browser preview is NOT secure** (the "device secret" sits next to the data): it shows a red banner and must never hold real data.
- Not done yet (ideas): biometric unlock, root detection, certificate pinning (needs the server), encrypted export file.

## 7. Design system (redesign of 24 Oct 2026, made with Claude Design)

- **Two themes**, `light` and `dark`, as CSS variables on `:root` and `:root[data-theme="dark"]` (full table in `src/style.css`). Dark is pure black (AMOLED); the borders carry the structure. Settings > Appearance: **System** (default, follows the phone live), **Light**, **Dark**. The choice is kept in localStorage key `ab-theme` (not secret; `ui/theme.js` and `public/theme-init.js` are the only users) and also sets `<meta name="theme-color">` (`#0B2545` light, `#000000` dark).
- **Dark-mode glow stays very low** (owner's request): no neon halos. Buttons get a faint soft shadow, the hero card only a hairline cyan border, the PIN dots a barely visible glow. The cyan is a quiet accent. Do not add stronger glows.
- Light: ice `#F4F9FB` background, white cards, navy `#0B2545` ink and primary buttons (cyan bottom edge). Dark: black, `#0B0F13` cards, `#22D3F5` accent and primary button. Cyan is never body text on light (use `--link` / `--eyebrow`).
- **Contrast rule: text at least 4.5:1** (3:1 for large). Checked in the browser on every main screen, both themes. One deliberate deviation from the design file: light `--mute` is `#5F6870` (the file says `#6C757D`, which measured 4.4 on the page background and less on chips). Danger *text* uses `--al-ink`, not `--alert`; avatar initials use `--ink`.
- **Type:** Sora 500-700 for headings and amounts (letter-spacing -0.02em), Manrope for everything else (body 15 px), JetBrains Mono 10.5 px uppercase eyebrows.
- **Layout:** no top bar. Each screen has a large Sora title (26 px, sub-pages 22 px) on the background. A **floating tab dock** (Home, Expenses, Clients, Meetings) and a pill "add" button above it. Sub-pages (forms, settings) slide up with a pinned Save button. Hero card on Home with the orbit motif and a 7-day bar chart. Custom **numeric keypad** on the lock screen (setup keeps the system keyboard).
- Radii: cards 18-24, rows 16, inputs 16, chips 20, icon tiles 13. Motion: fade-up about 600 ms, 22 px, 70 ms stagger (only on tab changes), only `transform`/`opacity`, `prefers-reduced-motion` respected.
- A `[hidden]` rule forces `display:none` (flex/grid rules otherwise show hidden elements; this bit us). The logo (`assets/ab-logo.png`) is blended into the background with CSS (multiply in light, inverted + screen in dark).

## 8. Commands

```bash
npm install
npm run dev            # preview at http://127.0.0.1:5173
npm run build          # web build into dist/  (about 1 s)
npm test               # 91 tests (node --test), no extra tools
npx cap sync android   # copy the web build and plugins into android/ (CI does it too)
npm i --no-save sharp && node scripts/make-icons.mjs   # only after the logo changes; rewrites android/.../res icons and splash
```
Real-browser end-to-end checks were done with **puppeteer-core + the installed Chrome**, installed only in the session scratchpad (never in the project): setup, weak PIN, expense, hostile text, meeting, lock/unlock, reload, lockout, and "nothing readable in browser storage".

## 9. Release / update flow (same system as Prysm)

**The office address:** the workflow default is the temporary Hostinger link; the GitHub repo variable `SERVER_URL` overrides it (Settings > Secrets and variables > Actions > Variables), for example `https://mediumpurple-rook-621617.hostingersite.com` (later the real domain). CI passes it as `VITE_SERVER_URL`; a tag build fails without it. Local `npm run dev` uses `.env.development` (`http://127.0.0.1:8000`, the website's `php artisan serve`; the website's `.env` needs `SALES_CORS_ORIGINS=https://localhost,http://127.0.0.1:5173`). Changing the address = a new build.

**Why an update keeps the data:** a new APK is installed OVER the old app. Android allows that only if (1) the `appId` is the same, (2) the APK is signed with the same key, and (3) `versionCode` is higher. The data (SQLite + the Keystore secret) stays in the app's private storage and is untouched. **Never uninstall** (`allowBackup` is off: uninstalling deletes the data for good).
- `appId` `com.agarwalbrothers.sales`: never change. Signing key: never change (alias `absales`; file copy in `C:\Users\DELL\ab-sales-keystore\`, the owner must back it up; GitHub secrets `KEYSTORE_BASE64` and `KEYSTORE_PASSWORD`). `versionCode` = GitHub run number (CI) so it only goes up.
- **Data compatibility:** a newer version must read what an older one stored. Only ADD fields, give each a default in `DEFAULTS` (`src/data/store.js`, Prysm's `normalize()` idea). `tests/compat.test.js` + `tests/fixtures/v1.0-data.json` hold real v1.0 records and must keep passing; never regenerate the fixture.
- **CI fails on purpose** when the two signing secrets are missing (Prysm builds a throw-away-key APK; that APK could never update an installed copy, and the only way out would be an uninstall = data loss).

**To ship a new version**
1. Make the change; keep the data rules above.
2. Bump `version` in `package.json` only (`1.0.0` -> `1.1.0`; shown as `v1.1` in Settings, `versionName` `1.1`, APK `AB-Sales-v1.1.apk`). Add the version to the list below.
3. `npm test` and `npm run build`.
4. Commit as `AB Sales v1.1: <what changed>`, tag it (`git tag v1.1`) and push the commit and the tag (`git push origin main v1.1`): **only when the owner says so**. The build starts from the TAG (ordinary pushes to main build nothing, so there is never a double build); CI fails if the tag does not match `package.json`.
5. GitHub Actions "Build APK" runs the tests, builds, signs, uploads the artifact `AB-Sales-v1.1` (a zip) and publishes a **Release** with the plain `AB-Sales-v1.1.apk` (about 5 minutes, on GitHub's computers; this laptop does nothing).
6. On the phone open https://github.com/Syntaxio-dev/ab-sales-app/releases (signed in to GitHub), download `AB-Sales-v1.1.apk`, install it over the old app. Direct link pattern: `https://github.com/Syntaxio-dev/ab-sales-app/releases/download/v1.1/AB-Sales-v1.1.apk`. A test build without a release: Actions > Build APK > Run workflow (the zip is under "Artifacts").

**One-time setup:** repo > Settings > Secrets and variables > Actions > New repository secret, twice: `KEYSTORE_BASE64` = the whole text of `KEYSTORE_BASE64.txt`, `KEYSTORE_PASSWORD` = the text of `KEYSTORE_PASSWORD.txt` (both in the keystore folder).

**Android 13+ sideload:** if something misbehaves, Settings > App > "Allow restricted settings". Play Protect may ask about an unknown APK.

**Building on this laptop (only when GitHub cannot be used):** works, but slow: it needs JDK 21 (`C:\dev\jdk-21`), the Android SDK (`C:\dev\android-sdk`) and about 15 minutes of Gradle downloads the first time, with only about 1 GB of RAM free. Command (PowerShell): set `JAVA_HOME`, `ANDROID_HOME`, `KEYSTORE_FILE` and `KEYSTORE_PASSWORD`, then in `android`: `.\gradlew.bat assembleRelease --no-daemon --max-workers=1 "-Dorg.gradle.jvmargs=-Xmx1g"`. It must be signed with the same key and have a `versionCode` that is not lower than what is installed (local builds use 1: use `GITHUB_RUN_NUMBER` to raise it). The normal way is GitHub.

### Versions
- **v1.0** (24 Oct 2026): first release. Expenses with bill photo, clients, meetings with follow-ups, Home summary, export (CSV/JSON), erase all, change PIN, light / dark / system theme, encrypted storage, PIN lock with lockout and auto-lock. A first signed APK (`AB-Sales-v1.0.apk`, versionCode 1) was built on this laptop and checked (company key fingerprint SHA-256 `F1:70:8E:09:75:46:7B:8E:22:C4:D8:B6:1B:36:CE:40:A9:50:47:7F:05:1F:C6:3D:55:A6:8B:92:39:B8:6E:46`, minSdk 26).
- **v1.1**: skipped on purpose (the owner asked for the next release to be called v1.2).
- **v1.3** (25 Oct 2026): **office sync** (Home card, Connect to office, Settings > Office, read-only approved/rejected expenses, pending/refused indicators), INTERNET permission, CSP `connect-src` for the office.
- **v1.2** (24 Oct 2026): the redesign (light / dark / system theme, floating dock, hero card, lock keypad, new fonts), the data-compatibility guard (`DEFAULTS` + `tests/compat.test.js`), releases built from tags with a plain-APK Release page, CI refuses to build without the signing secrets.

## 10. Not verified yet (be honest about these)

- **v1.0 was installed on the owner's phone and runs** (owner's report, 24 Oct 2026). So the Android WebView, the Keystore secure storage, the strict CSP and the missing INTERNET permission all work. Still not reported or checked: camera / gallery bill photos, export / share on the phone, auto-lock timing, other phone brands. The Java side (MainActivity, Gradle changes) compiled on this laptop and in CI.
- If a future change makes the app show a blank screen on the phone, first suspect the strict CSP in `vite.config.js` and the missing `INTERNET` permission (try adding `<uses-permission android:name="android.permission.INTERNET" />` back).

- **The redesign was built from the written prompt only.** The visual reference file `AB Sales Redesign.dc.html` was not available on this PC, so the screens were matched to the prompt's tokens and screen descriptions, not compared side by side with the file.
- `android/` was deliberately not touched, so the native status bar, navigation bar and the Android launch splash are still white/light: on a dark phone the very first moment of a cold start can flash light before the web page paints (the app itself has no flash).
- Dark mode and the keypad were checked in desktop Chrome (360 px and wide), not on a real phone.

- **Sync was checked** against the real Laravel dev server with a Node end-to-end run (push, bill upload, office approve/reject, pull, a second phone getting everything back with the bill, delete reaching the other phone, one-phone-at-a-time sign-out) and with a real-Chrome UI run (Connect page, wrong password, link confirmation, sync, read-only approved expense, sign out). **Not yet checked on a real phone / the live server:** the WebView's CORS call to the Hostinger domain (origin `https://localhost`), camera bill upload size on mobile data, behaviour with a flaky network.

## 11. Gotchas learned

- **8 GB RAM, 2 cores** (i7-6600U) and a small C: drive. Flutter + Gradle + VS Code's Java server crashed with "insufficient memory" (JVM `hs_err_pid*.log` files) and filled the disk. That is why this app is Vite + Capacitor with CI builds, not Flutter. Do not install Android Studio / run Gradle here.
- VS Code's Red Hat Java extension tries to import `android/` and shows Java warnings: `.vscode/settings.json` turns the importers off. If it still bothers, disable the Java extension for this workspace.
- **Git Bash eats backslashes**: an SDK path with `\\` created a stray folder with 10k files inside the repo once. Quote paths, use forward slashes.
- `position: fixed` elements have `offsetParent === null`: test visibility with `getClientRects().length`.
- `node --test` needs a quoted glob (`"tests/*.test.js"`); the directory form fails on Node 24.
- PowerShell treats a native command's stderr text as an error under `$ErrorActionPreference='Stop'` (keytool, java -version).
- Password inputs cannot be "triple-click selected" by tests: clear the value and dispatch `input`.
- **`element.append(null)` and `replaceChildren(null)` print the word "null"** on the screen. Use `h()` / `append()` from `ui/dom.js` or the `fill()` helper in `tabs.js` (they skip empty parts). The end-to-end test now fails on any stray "null", "undefined" or "NaN" text.
- Puppeteer reloads the page when `setViewport` changes `isMobile` / `hasTouch`: keep them the same, or the app locks mid-test.
- `innerText` returns text after CSS `text-transform` (eyebrows come back in capitals): compare accordingly.
- **The Android WebView runs under `https://localhost`**: the website's `SALES_CORS_ORIGINS` default must contain it. The app uses the WebView's `fetch` on purpose (not `CapacitorHttp`): timeouts/aborts work and the CSP applies.
- Re-login on a second phone signs the first out by design; a test script that signs in twice with one account must expect that.
- Native `replaceChildren(...parts)` prints "null" for empty parts: `.filter(Boolean)` first (bit us again in `ui/office.js`).
- Removing `sharp` (and other `--no-save` installs) happens on the next `npm install` / `uninstall`: reinstall it when you need `scripts/make-icons.mjs`.

## 12. Tools on this laptop

Node 24 / npm 11 (everything the project needs). Left over from the abandoned Flutter attempt under `C:\dev` (about 2.5 GB, **not needed**): `flutter` (SDK), `android-sdk`, `jdk-17` (only `keytool` was used, to make the signing key). `C:\dev\_archive\flutter-attempt` holds the old Flutter source (0.2 MB). Ask the owner before deleting the SDKs.

## 13. Work log

**24 Oct 2026**
- Repo connected to GitHub. Website Sales module started and rolled back (see section 1).
- Tried Flutter (Dart): worked, 40 tests, but too heavy for this laptop (slow preview, Java out-of-memory crashes). Owner asked for the Prysm stack instead; Flutter source archived.
- Built v1.0 on Vite + vanilla JS + Capacitor: encrypted store, PIN vault with lockout, auto-lock, expenses with bill photo, clients, meetings with follow-ups, home summary, settings (export CSV/JSON, change PIN, erase all), hardened Android project, CI workflow, signing key (outside the repo).
- App icon and splash made from the company logo (test-tube + atom mark; adaptive, round and legacy icons; white splash with the full logo) by `scripts/make-icons.mjs`.
- Verified: 47 Node tests, production build (about 1 s, 17 KB gzip JS), real-Chrome end-to-end run with the CSP on (12 checks, no console errors).
- Disk clean-up done on the owner's request: temp files and caches, Pictures screenshots, two songs on the Desktop. Website-related images (Desktop "Unbranded chemicals bottels stock images", recent Downloads, Obsidian notes) were deliberately NOT deleted: waiting for the owner's answer.

**24 Oct 2026 (evening): UI redesign, light + dark**
- New design system from the Claude Design prompt: tokens for both themes, Sora + Manrope + JetBrains Mono (IBM Plex removed), floating dock, large titles, hero card with 7-day bars, expense form with category chips and the big amount card, custom lock keypad, pinned Save buttons. Settings > Appearance (System / Light / Dark, default System). Logic, storage, security and `android/` untouched.
- Dark glow kept very low on purpose (owner: it must look natural, not pushed).
- Fixed along the way: the word "null" printed on pages and on empty tabs, hidden elements shown by flex/grid rules, 5 contrast failures in light mode, a meeting form that silently defaulted to "Someone else".
- Verified: 47 Node tests; production build with the CSP; real-Chrome end-to-end run (setup, weak PIN, expense + filters, hostile text, meeting, theme switch with persistence and no flash on reload, System following the phone live, keypad lock/unlock/lockout, 360 px and wide) with a computed text-contrast check on every main screen in both themes and no console or CSP errors.

**24 Oct 2026 (night): v1.2 released**
- Owner installed the locally built v1.0 on his phone: it runs. Redesign + data-safety tests + tag-based workflow committed (`f6376b0`) and pushed; tag `v1.2` pushed; GitHub Actions run #3 built, tested (53 tests) and signed it, and published the Release https://github.com/Syntaxio-dev/ab-sales-app/releases/tag/v1.2 (`AB-Sales-v1.2.apk`, 16.2 MB).
- Checked on the downloaded APK: signing certificate SHA-256 identical to v1.0's (so it installs over it), `versionCode` 3 (v1.0 has 1), `versionName` 1.2, minSdk 26, same package.
- The repo is PUBLIC (visible to anyone, including the Release APK). It holds no secrets; making it private is the owner's choice (repo Settings > General > Danger Zone).
- Not yet reported by the owner: how v1.2 behaves on the phone (update over v1.0 with the data kept, dark mode, keypad, camera, export).

**25 Oct 2026: office sync (v1.3)**
- Owner: connect the app to the website, add a Sales management page there, every future feature must show insights on the website, keep the module movable to a sub-domain. Owner then also asked to push both projects and update Hostinger (files and database) for live testing.
- App: `src/sync/*` (http, merge, engine), store extensions (dirty flags, tombstones, exclusive write queue, reviewed-expense lock), UI (`ui/office.js`, read-only reviewed expenses), `config.js`, CSP connect-src from `VITE_SERVER_URL`, INTERNET permission, CI variable `SERVER_URL`, `.env.development`. 91 Node tests (incl. a fake office server implementing the API contract) + the real-server Node run + the real-Chrome UI run.
- Website (separate repo, see its CLAUDE.md): `app/Sales` module, API, 5 admin screens, 66 Sales tests.
- Found and fixed on the way: a lost-edit race between a sync and a user save (writes now go through one queue), a millisecond-precision bug in the conflict rule (server column DATETIME(3)), the sync card printing "null", the reviewed expense amount without Indian formatting, test-harness guard leakage on the website.
- **v1.3 released** (CI run #5): https://github.com/Syntaxio-dev/ab-sales-app/releases/tag/v1.3 (`AB-Sales-v1.3.apk`, 17.0 MB), signing certificate SHA-256 identical to v1.0 / v1.2 (checked with apksigner). Run #4 failed only because one sync test depended on timing (an edit landing during a push can come before or after the sync's last round); the tests now wait for conditions instead of fixed sleeps and passed 12 of 12 runs under CPU load, so the tag was moved to the fixed commit. Website side was deployed to the temporary Hostinger site the same day (see the website's CLAUDE.md); test rep `TEST01` exists there.
