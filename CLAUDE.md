# CLAUDE.md — Agarwal Brothers Sales App (AB Sales)

Working notes for Claude (and any developer) on this project: what it is, how it is built, the owner's rules, and a log of the work.
Keep this file up to date after every batch of work.

## 1. What this is

- **Offline Android app (APK) for the field sales team of Agarwal Brothers** (lab equipment supplier, Jaipur). A rep records **expenses (with a bill photo), clients and meetings** on the phone. Management will later see the data in the website's admin panel.
- **Separate repo:** `https://github.com/Syntaxio-dev/ab-sales-app.git`, branch `main`, remote `origin` is connected. Local path `C:\xampp\htdocs\ab-sales-app`.
- The website is another project: `C:\xampp\htdocs\AB-new-project1` (Laravel 12 + Filament). Read its `CLAUDE.md` for the palette and its rules. **Never edit the website from this project's sessions unless the owner asks.** (A Sales module was started there and then rolled back on 24 Oct 2026, because the app comes first and the site API will be built to fit the app.)
- The sister app **Prysm** (`C:\xampp\htdocs\personal-app`) uses the same stack and release flow. Its `CLAUDE.md` is the model for this one.
- Sideloaded APK (no Play Store). Android 8+ (minSdk 26).
- **Owner:** writes Hinglish, **has no app-development experience**, cannot specify details. So decide like a senior developer, explain briefly in short plain Hinglish, and **think about security risk in every step** (owner's explicit instruction).

## 2. Standing rules (owner's)

1. Reply in short, plain Hinglish. Be honest: say what was verified and what was NOT (the Java/native side only compiles in CI; nothing was run on a real phone yet).
2. **Security first** in every decision (section 6).
3. **Commit and push only when told** ("commit" / "push kr do"). Nothing is committed yet. Batch changes.
4. **Update this CLAUDE.md after every batch of work.**
5. Never write secrets (passwords, keystore, tokens) into any file in this repo.
6. Ask before destructive actions. Never delete the owner's files without a clear answer (see section 9: disk clean-up).
7. Palette only (same as the website); no new colours. UI text in English. Mobile first.
8. Never use native `alert/confirm/prompt`: use `confirmDialog`, `alertDialog`, `dialog`, `toast` from `src/ui/kit.js`.

## 3. Hard rules (do not break)

1. **Never change `appId` `com.agarwalbrothers.sales`** (capacitor.config.json, android/app/build.gradle). A new id is a new app and all data on the phones is lost on update.
2. **Never change the signing key.** It lives OUTSIDE the repo: `C:\Users\DELL\ab-sales-keystore\` (`ab-sales.p12`, `KEYSTORE_PASSWORD.txt`, `KEYSTORE_BASE64.txt`). The owner must **back it up** and paste the two GitHub secrets `KEYSTORE_BASE64` and `KEYSTORE_PASSWORD` (alias is `absales`). A different key blocks in-place updates.
3. **No network calls in the app** (`fetch`, `XMLHttpRequest`, `WebSocket`, analytics, remote scripts). A test (`tests/source-rules.test.js`) fails if any appear. The manifest has **no `uses-permission` at all**.
4. Never use `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `eval`: text goes in through `h()` in `src/ui/dom.js` (text nodes only). Tested.
5. **Stored data format is a promise:** records and keys in `src/data/store.js` (`e:`, `c:`, `m:`, `b:` slots, field names). New fields get defaults when read; never rename or drop old ones, or phones with data break. Field names already match what the office server will use (`uuid`, `amount_paise`, `expense_date`, `next_followup_at` ...).
6. `status` of an expense is never taken from the phone's form: only the office will change it, later, through sync. `Store.saveExpense` keeps the old value.
7. Money is whole **paise** (integer). Times are UTC ISO strings; shown in local time. Expense date is a plain `YYYY-MM-DD`.
8. Build (`npm run build`) and run `npm test` before saying "done".

## 4. Stack

- **Vite 8 + vanilla JavaScript** (ES modules, no framework) → wrapped by **Capacitor 8** into an Android APK. Fonts: IBM Plex Sans + IBM Plex Mono via `@fontsource` (bundled, works offline).
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
  data/                store.js (encrypted records), persist.js (Memory / LocalStorage persistence)
  platform/            native.js (phone: SQLite, Keystore, camera, share), web.js (browser preview only)
  ui/                  dom.js, kit.js (pages, dialogs, toast, field), auth.js, tabs.js, forms.js, settings.js, export.js, format.js
  style.css            all styles (palette tokens in :root)
tests/                 node --test: core, vault, store, source-rules   (npm test)
assets/ab-logo.png     the company logo (copy of the website's sidebar-logo.png); source of all icons
scripts/make-icons.mjs builds the launcher icons + splash screens from it (needs: npm i --no-save sharp)
android/               Capacitor project, hardened (manifest, FLAG_SECURE in MainActivity.java, signing in app/build.gradle)
```

## 6. Security design (do not weaken without asking the owner)

- **Encrypted at rest.** Every record and bill photo is sealed with AES-256-GCM before it reaches SQLite; the storage slot (`e:<id>` ...) is part of what is authenticated, so a record moved to another slot is refused. A changed byte is detected.
- **PIN (6 digits) is never stored.** Stored in the Keystore backed store: salt, a random device secret, and the data key wrapped (AES-GCM) with `KEK = HMAC(deviceSecret, PBKDF2-SHA256(pin, salt, 300 000))`. An attacker needs the device's secret store **and** the PIN. Changing the PIN only re-wraps the key.
- **Lockout:** 5 wrong PINs, then 30 s, 1 m, 2 m, 5 m, 15 m. Kept in secure storage (survives restart). Weak PINs (111111, 123456, 654321) are refused.
- **Auto-lock** after 60 s in the background; locking closes the store (decrypted records leave memory) and closes every open page/dialog. The camera pauses the timer on purpose (`app.suspendAutoLock`).
- **Forgot PIN = erase the app data** (there is no server copy yet; the app says so).
- **Android:** `allowBackup=false` + data-extraction rules (no cloud/adb backup), cleartext off, `FLAG_SECURE` (no screenshots, blank recent-apps card), WebView debugging off, **no permissions** (INTERNET removed: the app physically cannot send data in version 1; **add it back only together with the server work, plus certificate pinning**).
- **Content-Security-Policy** in the production build only: own files only, `connect-src 'self'`, no inline script/style.
- **Export** leaves the phone unencrypted by nature: the app warns before sharing. CSV cells starting with `= + - @` get an apostrophe (formula injection). Export files live in the app's private cache and are deleted on every lock / start.
- **Logging:** never log PINs, keys or record contents. A test fails on `console.log/info/debug`.
- **Browser preview is NOT secure** (the "device secret" sits next to the data): it shows a red banner and must never hold real data.
- Not done yet (ideas): biometric unlock, root detection, certificate pinning (needs the server), encrypted export file.

## 7. Design system

Same tokens as the website (see `:root` in `src/style.css`): navy `#0B2545`, link `#0077B6`, cyan `#00B4D8`, cyan-ink `#007C98` (cyan text on light), slate `#6C757D`, ice `#F4F9FB`, success `#2A9D8F`, alert `#E76F51`. Primary buttons: solid navy with a cyan bottom edge. Mono uppercase eyebrow labels. Motion: fade-up about 600 ms, 22 px, 70 ms stagger, only `transform`/`opacity` (cheap on old phones), `prefers-reduced-motion` respected. A `[hidden]` rule forces `display:none` (otherwise flex/grid rules show hidden elements; this bit us).

## 8. Commands

```bash
npm install
npm run dev            # preview at http://127.0.0.1:5173
npm run build          # web build into dist/  (about 1 s)
npm test               # 47 tests (node --test), no extra tools
npx cap sync android   # copy the web build and plugins into android/ (CI does it too)
npm i --no-save sharp && node scripts/make-icons.mjs   # only after the logo changes; rewrites android/.../res icons and splash
```
Real-browser end-to-end checks were done with **puppeteer-core + the installed Chrome**, installed only in the session scratchpad (never in the project): setup, weak PIN, expense, hostile text, meeting, lock/unlock, reload, lockout, and "nothing readable in browser storage".

## 9. Release / update flow

1. Owner pastes the two GitHub secrets (once).
2. Commit and push (only when told) → Actions "Build APK" → download artifact `AB-Sales-vX.Y` → install on the phone (over the old app, never uninstall). `versionCode` = GitHub run number; version comes from `package.json` (`1.0.0` is shown as `1.0`; bump only that field).
3. Android 13+ sideload: if features misbehave, Settings > App > "Allow restricted settings". Play Protect may ask about an unknown APK.

## 10. Not verified yet (be honest about these)

- **Nothing ran on a real phone or emulator.** The Java side (MainActivity, Gradle changes) only compiles in CI.
- Removing `INTERNET` from the manifest, the strict CSP, the camera plugin and the Keystore secure storage were not exercised inside the Android WebView. If the first APK shows a blank screen, first try adding `<uses-permission android:name="android.permission.INTERNET" />` back, then relax the CSP in `vite.config.js`.

## 11. Gotchas learned

- **8 GB RAM, 2 cores** (i7-6600U) and a small C: drive. Flutter + Gradle + VS Code's Java server crashed with "insufficient memory" (JVM `hs_err_pid*.log` files) and filled the disk. That is why this app is Vite + Capacitor with CI builds, not Flutter. Do not install Android Studio / run Gradle here.
- VS Code's Red Hat Java extension tries to import `android/` and shows Java warnings: `.vscode/settings.json` turns the importers off. If it still bothers, disable the Java extension for this workspace.
- **Git Bash eats backslashes**: an SDK path with `\\` created a stray folder with 10k files inside the repo once. Quote paths, use forward slashes.
- `position: fixed` elements have `offsetParent === null`: test visibility with `getClientRects().length`.
- `node --test` needs a quoted glob (`"tests/*.test.js"`); the directory form fails on Node 24.
- PowerShell treats a native command's stderr text as an error under `$ErrorActionPreference='Stop'` (keytool, java -version).
- Password inputs cannot be "triple-click selected" by tests: clear the value and dispatch `input`.

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
