# Bhajan Planner — Comprehensive QA Audit Test Log

**Audit Date:** 2026-11-13
**Targets Tested:**
- **Live (Railway Development):** `https://bhajanschedular-development.up.railway.app/`
- **Local (Primary Dev Server):** `http://localhost:8000/`
- **Isolated Authenticated Mirror (Temp SQLite Clone of `bhajans.db`):** Ephemeral local Express server (`http://127.0.0.1:60341`) running identical app code against a temporary copy of `bhajans.db` with an ephemeral test account (`zz_audit_superadmin`, destroyed on exit).

---

## 1. Live & Local Data Mutation Statement (Cleanliness Guarantee)

- **Live site (`bhajanschedular-development.up.railway.app`):** **0 records created, modified, or deleted.** All live probes were strictly read-only GETs, non-mutating UI filter/theme interactions, invalid-credential auth denial checks, or unauthenticated 401/403/302 guard checks.
- **Local database (`e:\Academics\Coding Skills\Bhajan_Schedular\bhajans.db`):** **0 records created, modified, or deleted.**
- **Isolated temp mirror (`%TEMP%/bhajan-audit-mirror-*`):** Created temporary `zz_audit_superadmin` admin user and tested destructive/admin write paths (`POST /admin/permission`, `POST /admin/danger-reset-history`, `POST /submit`); temp copy removed / isolated from workspace DB.
- **Pre-existing test artifacts observed in DB/Mirror:** Bulletins `test3433532` and `test test` (visible in `admin-bulletins_375_default.png`), plus submission singer `tester` on `2026-11-05` (`admin-session-view_1440_default.png`), already existed prior to this audit.

---

## 2. HTTP Endpoint Matrix (Live vs Local — 40 Probed Routes)

| # | Method & Endpoint | Live Status / ms / Size / Enc | Local Status / ms / Size / Enc | Expected vs Actual & Notes |
|---|---|---|---|---|
| 1 | `GET /healthz` | `200` / `652 ms` / `159 B` | `200` / `13 ms` / `158 B` | PASS — Health check healthy |
| 2 | `GET /` | `200` / `478 ms` / `128,031 B` (`br`) | `200` / `59 ms` / `130,527 B` (`gzip`) | PASS — Serves app shell (`manifest.dev.json`) |
| 3 | `GET /master-bank` | `200` / `334 ms` / `669,783 B` (`br`) | `200` / `87 ms` / `676,757 B` (`gzip`) | PERF FAIL — Huge ~670 KB raw HTML inlining full catalog JSON |
| 4 | `GET /plan-view` | `200` / `266 ms` / `92,048 B` (`br`) | `200` / `20 ms` / `95,582 B` (`gzip`) | SEC FAIL on `?session_date=` payload (Reflected XSS) |
| 5 | `GET /database` | `200` / `310 ms` / `114,787 B` (`br`) | `200` / `36 ms` / `444,843 B` (`gzip`) | DATA DIFF — Local has 77 sessions (445 KB) vs Live archive count (115 KB) |
| 6 | `GET /bulletins` | `200` / `280 ms` / `84,688 B` (`br`) | `200` / `20 ms` / `87,432 B` (`gzip`) | PASS (page); client shell nav shows delayed/stuck `Loading...` briefly |
| 7 | `GET /my-reports` | `200` / `270 ms` / `97,270 B` (`br`) | `200` / `11 ms` / `99,228 B` (`gzip`) | PASS (`ticketCodeInput` missing `<label>`) |
| 8 | `GET /notification-settings` | `200` / `278 ms` / `109,235 B` (`br`) | `200` / `10 ms` / `111,476 B` (`gzip`) | PASS |
| 9 | `GET /singer/login` | `200` / `304 ms` / `97,318 B` (`br`) | `200` / `13 ms` / `101,856 B` (`gzip`) | PASS (`no-store`) |
| 10 | `GET /submit-form` | `302` / `251 ms` | `302` / `4 ms` | PASS — Unauthenticated singer redirects |
| 11 | `GET /my-hub` | `401` / `262 ms` | `401` / `3 ms` | WARN — Redirect/401 discrepancy (`Accept` header/JSON vs redirect check) |
| 12 | `GET /singer/hub` | `401` / `274 ms` | `401` / `3 ms` | WARN — Browser with `Accept: text/html` should redirect smoothly |
| 13 | `GET /my-activity` | `302` / `262 ms` | `302` / `2 ms` | PASS |
| 14 | `GET /singers` | `302` / `258 ms` | `302` / `1 ms` | PASS |
| 15 | `GET /admin-login` | `200` / `267 ms` / `37,782 B` | `200` / `8 ms` / `38,532 B` | WARN — Local Google GSI 403 error in console; fresh modal overlay blocks login |
| 16 | `GET /forgot-password` | `200` / `258 ms` / `32,367 B` | `200` / `6 ms` / `33,033 B` | PASS (unlabeled `input#`) |
| 17 | `GET /manifest.json` | `200` / `250 ms` / `1,965 B` | `200` / `6 ms` / `2,049 B` | PASS |
| 18 | `GET /manifest.dev.json` | `200` / `252 ms` / `2,004 B` | `200` / `3 ms` / `2,004 B` | PASS — Serves `Bhajan Planner DEV` / `/images/icons/dev/icon-*.png` |
| 19 | `GET /sw.js` | `200` / `263 ms` / `8,740 B` | `200` / `3 ms` / `9,003 B` | PASS |
| 20 | `GET /images/icons/dev/icon-192x192.png` | `200` / `276 ms` / `98,716 B` | `200` / `3 ms` / `98,716 B` | PASS (`public, max-age=604800`) |
| 21 | `GET /images/icons/dev/bhajan-planner-dev-192.png` | `404` / `279 ms` | `404` / `3 ms` | INFO — Legacy filename absent; manifest points to `icon-192x192.png` |
| 22 | `GET /api/singers` | `200` / `272 ms` / `418 B` | `200` / `3 ms` / `1,327 B` | DATA DIFF — Local has larger singer roster (`1,327 B` vs `418 B`) |
| 23 | `GET /api/deity-rules` | `200` / `262 ms` / `984 B` | `200` / `3 ms` / `984 B` | PASS |
| 24 | `GET /api/check-cooldown?title=Ganesha` | `200` / `272 ms` / `4 B` | `200` / `3 ms` / `4 B` | PASS (Returns JSON `null`) |
| 25 | `GET /api/scale-suggestions?title=Ganesha&singer=Test&gender=Male` | `200` / `273 ms` / `57 B` | `200` / `3 ms` / `57 B` | PASS |
| 26 | `GET /api/notifications/unread-count` | `200` / `250 ms` / `11 B` | `200` / `2 ms` / `11 B` | PASS |
| 27 | `GET /api/notifications/vapid-key` | `200` / `278 ms` / `103 B` | `200` / `2 ms` / `103 B` | PASS |
| 28 | `GET /admin` | `302` / `267 ms` | `302` / `1 ms` | PASS — Unauth redirects to `/admin-login` |
| 29 | `GET /admin/users` | `404` / `271 ms` | `404` / `2 ms` | FAIL (Auth ordering) — Unmounted path returns 404 directly before auth redirect |
| 30 | `GET /admin/admin-users` | `302` / `273 ms` | `302` / `2 ms` | PASS |
| 31 | `GET /admin/diwali` | `302` / `264 ms` | `302` / `2 ms` | PASS |
| 32 | `GET /admin/analytics` | `302` / `258 ms` | `302` / `1 ms` | PASS |
| 33 | `GET /admin/download-backup` | `302` / `287 ms` | `302` / `2 ms` | PASS |
| 34 | `GET /admin/danger-reset-history` | `302` / `334 ms` | `302` / `2 ms` | PASS on `GET`, **404 on `POST`** (see Functional Probes) |
| 35 | `GET /admin/api/cloudflare/audio-files` | `302` / `296 ms` | `302` / `1 ms` | WARN — API route redirects to `/admin-login` instead of `401` JSON unless JSON `Accept` set |
| 36 | `POST /api/admin/toggle-lock` | `403` / `288 ms` | `403` / `4 ms` | PASS (CSRF + Auth enforced) |
| 37 | `POST /admin/permission` | `403` / `280 ms` | `403` / `2 ms` | PASS (CSRF + Auth enforced) |
| 38 | `POST /api/add-master-bhajan` | `403` / `277 ms` | `403` / `1 ms` | PASS (CSRF + Auth enforced) |
| 39 | `POST /api/reports/submit` | `403` / `338 ms` | `403` / `1 ms` | PASS (CSRF token required on anonymous POST) |
| 40 | `GET /zz-nonexistent-audit-404` | `404` / `290 ms` | `404` / `3 ms` | PASS |

---

## 3. Playwright Cross-Breakpoint & Interactive Test Matrix

Breakpoints tested across all public, singer, and admin pages: **375px**, **768px**, **1024px**, **1440px**.

### A. Public & App Shell Pages (`playwright_public_audit.json` & `playwright_clean_interactive.json`)

| Test Case | Live Result | Local Result | Observed Evidence / Failure Cause |
|---|---|---|---|
| Home (`/` at 375/768/1024/1440) | **FAIL (JS)** | **FAIL (JS)** | Zero horizontal overflow (`0px`), clean branding (`home_375_clean.png`, `home_1440_clean.png`), **HOWEVER** uncaught `RangeError: Maximum call stack size exceeded` at 768/1024/1440 (`app-shell-router.js:1238-1301`) + fresh-visit `#whatsNewOverlay` & `#notifPromptOverlay` auto-block interaction. |
| Master Bank (`/master-bank`) | **FAIL (HTTP 401 + JS + UX)** | **FAIL (HTTP 401 + JS + UX)** | Fires unauthenticated `GET /api/singer/songbook` returning HTTP `401` console error on load; `input#filterBankTitle` has no `<label>`; `144-148` touch targets `< 44px` (`btn-pitch-drone-play` 22x22, `sheet` 75x26, `card-details-arrow-btn` 30x30). |
| Bhajan Details (`/bhajan/1`) | **FAIL (404)** | **FAIL (404)** | Bhajan ID `1` does not exist (`404`); valid ID tested (`/bhajan/341`) returns `200` (*"Ganesha Charanam Parama Pavanam Sathya Sainam Gajananam"*). |
| Bhajan Details valid (`/bhajan/341`) | **WARN** | **WARN** | Renders detail sheet after fetch, but direct client transition showed `< Back Loading...` during fetch (`bhajan-details_375_clean.png`). |
| Plan View (`/plan-view`) + Date Switcher | **PASS (Func) / FAIL (XSS)** | **PASS (Func) / FAIL (XSS)** | Switching session dates works (`2` options live -> `2026-10-22`, `21` options local -> `2026-11-05`). Select label truncates at 375px (`plan-view_375_clean.png`). **P0 Reflected XSS** confirmed via `session_date`. |
| Database Archives (`/database`) | **PASS (Func) / WARN (Shell)** | **PASS (Func) / WARN (Shell)** | Search & archive cards render (Live: 1 card; Local: 12 initial -> 68 filtered), **but** direct client navigation after shell load flashed/stalled on `Loading...` (`database_1440_clean.png`, `database_375_clean.png`) + `19–109` touch targets `< 44px`. |
| Bulletins (`/bulletins`) | **WARN** | **WARN** | Server returns `200`, `database` & `bulletins` transition on clean sweep rendered blank `Loading...` screen at 250ms post-`networkidle` (`bulletins_375_clean.png`). |
| My Reports (`/my-reports`) | **WARN** | **WARN** | Unlabeled `input#ticketCodeInput`; `RangeError: Maximum call stack size exceeded`. |
| Notification Settings (`/notification-settings`) | **WARN** | **WARN** | `h1Count=0`, `RangeError: Maximum call stack size exceeded`. |
| Singer Login (`/singer/login`) | **WARN** | **WARN** | Renders cleanly (`singer-login_375_clean.png`), **except** disabled button contrast in dark mode is very faint, and `RangeError: Maximum call stack size exceeded` fires on desktop viewports. |
| Admin Login (`/admin-login`) | **FAIL (UX) / PASS (Auth Denial)** | **FAIL (UX) / PASS (Auth Denial)** | Invalid login returns error cleanly on `/admin-login`. **However**, `#whatsNewOverlay` & `#notifPromptOverlay` auto-open on `/admin-login` (`admin-login_375_default.png`) blocking the Submit button; Local also triggers Google GSI `403` console error. |
| Forgot Password (`/forgot-password`) | **WARN** | **WARN** | Unlabeled `input#`, `h1Count=0`. |
| Dark Mode Toggle (`#shellThemeToggle`) at 375px | **FAIL (Live Blocked)** | **PASS** | On Live fresh visit, `#notifPromptOverlay.show` intercepted clicks on `#shellThemeToggle` causing 30s timeout! On Local after overlay dismissal, toggling to `data-theme="dark"` succeeded (`isDark: true`). |
| Notification Bell Drawer (`#shellNotifBtn`) | **FAIL (Live Blocked)** | **PASS** | Blocked by `#notifPromptOverlay` on Live; opened `#notifPanel` on Local (`drawerOpen: true`). |

### B. Authenticated Singer & Admin Mirror Matrix (`playwright_admin_mirror_audit.json`)

| Test Case | Result | Observed Evidence |
|---|---|---|
| Admin Login UI (`super_admin`) | **WARN (Blocked on Fresh Context)** | Failed initially until `#whatsNewOverlay`, `#notifPromptOverlay`, and `#pwaInstallOverlay` were forcibly hidden; once dismissed, form login + redirect to `/admin` passed. |
| Submit Form (`/submit-form`, authenticated singer, 375/768/1024/1440) | **WARN** | Zero horizontal overflow (`0px` container), renders form cleanly, `availableDates: []` when testing past closed window; `views/submit-form.ejs:282-318` forces horizontal table scrolling (`560px` rule) instead of utilizing its `data-label` attrs. |
| Singer Hub (`/singer/hub`) & My Activity (`/my-activity`) | **PASS (Layout)** | Rendered across all 4 breakpoints (`0px` overflow), blocked visually on initial load by `#whatsNewOverlay`. |
| Admin Dashboard (`/admin`) | **WARN** | Sidebar drawer opens cleanly on 375px (`{x:0, y:0, w:290, h:812, transform:"matrix(1,0,0,1,0,0)"}`), **but** November 2026 header wraps onto 2 lines at 375px (`admin-dashboard_375_default.png`), row 5 (`29, 30`) sits beneath bottom sticky `Admin` pill, desktop topbar wraps `Bhajan Planner` & `Public App` onto 2 lines and fails to truncate long usernames (`admin-dashboard_1440_default.png`). |
| `POST /admin/permission` with `type="special"` / `"festival"` | **FAIL (`400`)** | Dashboard modal buttons (`views/admin-dashboard.ejs:114,123`) send `special`/`festival`, rejected with `400 {"error":"Validation failed","details":["Permission type must be one of: open, restricted, closed, clear."]}` (`validators.js:151`). |
| Admin Session View (`/admin/date/2026-11-05`) | **FAIL (Visual/Logic)** | Duplicate `(Thursday)` subtitle beneath `Thursday, Nov 5, 2026`; Past session shows green `Submissions Open` badge; all 4 KPI stat cards truncate labels/values (`2 Bhajan... / PROGRAM S...`) at 375px; jarring hardcoded indigo/teal buttons (`admin-session-view_375_default.png`, `admin-session-view_1440_default.png`). |
| Admin Edit Submission (`/admin/edit/784`) | **WARN** | Functional form load passes; back links box-wrap awkwardly into uneven tiles on 375px (`admin-edit-submission_375_default.png`). |
| Admin Deity Rules (`/admin/rules`) | **FAIL (Mobile Card UX)** | Search placeholder truncated (`Search deity na`); mobile card renders blank spaces above `- 0 +` / `- 2 +` steppers without field labels (`admin-rules_375_default.png`). |
| Admin Missing Bhajans (`/admin/missing-bhajans`) | **FAIL (Data Consistency)** | Sidebar badge reports **421** (`helpers.js` normalized title match) while page KPIs report **461** (`adminController.js` exact lowercase match) (`admin-missing-bhajans_375_default.png`). |
| Admin Users (`/admin/admin-users`) & Create Form (`/admin/admin-users/new`) | **FAIL (UI/Contrast)** | `/admin/admin-users` hero `Dashboard` outline button has dark text on dark indigo gradient (`admin-users_375_default.png`); `/admin/admin-users/new` has mismatched card widths/left border alignment due to missing `.admin-card` wrapper & stray `</div>` (`admin-user-form_1440_default.png`). |
| Analytics (`/admin/analytics`) | **FAIL (Data + Contrast)** | Both hero buttons (`Singers`, `Dashboard`) unreadable dark-on-dark (`analytics_1440_default.png`); Tempo math sums to **101%** (`4% + 94% + 3%`) and folds **129** `medium fast`/`medium slow`/`not specified` rows silently into `medium` (`693`); unique count reports `603` exact vs `588` normalized titles. |
| Singers Directory (`/admin/singers`) | **FAIL (Filter Clip + Stats)** | Mobile filter strip clips `Not [Protected]` vertically (`singers_375_default.png`); 27 of 37 singers lack gender (`9 Male 24%`, `1 Female 3%`). |
| Admin Reports (`/admin/reports`) | **WARN (UI)** | Search placeholder truncates (`Search ticket #, title, lyri`) + large unused vertical space inside filter card (`admin-reports_375_default.png`). |
| Admin Bulletins (`/admin/bulletins`) | **WARN** | Test bulletins (`test3433532`, `test test`) live in DB; `+ New Bulletin` styled as bare maroon text link on mobile (`admin-bulletins_375_default.png`). |
| Admin Notifications (`/admin/notifications`) | **PASS** | Renders push subscription cards cleanly (`admin-notifications_375_default.png`). |
| Activity Logs (`/admin/activity-logs`) | **FAIL (Contrast + Metric)** | `Purge (>30d)` and `Dashboard` buttons suffer dark-on-dark hero contrast failure; `Online Admins` shows `0` even while actively logged in viewing the page (`activity-logs_375_default.png`). |
| Admin Import Sessions (`/admin/import-sessions`) | **WARN** | Top nav buttons wrap unevenly at 375px (`admin-import-sessions_375_default.png`). |
| Admin Danger Reset (`/admin/danger-reset-history`) | **FAIL (`POST 404`)** | `GET` page renders cleanly (`admin-danger-reset_375_default.png`), **but submitting form (`POST /admin/danger-reset-history`) returns HTTP `404`** because `routes/admin.js` never mounted `adminController.dangerResetHistory`! |
| Diwali Dashboard (`/admin/diwali`) | **PASS** | Clean layout & stats (`7` pairs, `17` bhajans, `5` sequences) on desktop & mobile (`diwali-dashboard_1440_default.png`, `diwali-dashboard_375_default.png`). |

---

## 4. Security, Performance & Raw Data Reconciliation Checks

| Check | Result | Findings |
|---|---|---|
| Reflected XSS (`GET /plan-view?session_date=</script><script>alert(1)</script>`) | **FAIL (CRITICAL P0)** | Confirmed on **BOTH Live and Local**: `<%- JSON.stringify(sessionDate) %>` in `views/plan-view.ejs:148` outputs `"</script><script>alert(1)</script>"` unescaped inside `<script>`, breaking out of the tag; CSP permits `'unsafe-inline'`. |
| SQL Injection (`GET /api/check-cooldown`, `GET /bhajan/'OR'1`) | **PASS** | Sequelize parameterized queries block SQL injection; returns clean JSON `null` / `404` HTML without SQL errors or stack traces. |
| Auth & CSRF Guards on Admin/API Writes | **PASS (Except Diwali inconsistency? Verified clean)** | All admin pages redirect unauthenticated users to `/admin-login`; unauthenticated POSTs return `403` CSRF or `401` JSON. `routes/diwali.js:27` enforces `requireSuperAdmin` via router middleware. Zero stack trace leaks on tested error endpoints. |
| Lighthouse Performance & Accessibility (8 Runs) | **WARN / PERF DEBT** | **Live Mobile:** Home `P=77 A=96`, Master Bank `P=75 A=90`, Plan View `P=77 A=94` (`FCP 3.6–3.9s`, `LCP 4.3–4.5s`). **Local Desktop:** Home `P=97 A=96`. **Issues:** `errors-in-console` (stack overflow + 401), `color-contrast` (`1.02` ratio in `#notifPromptOverlay`), `bf-cache` fail on `admin-login`. |
| `npm audit --json` | **FAIL (17 Vulns)** | `1 critical` (`tar` <=7.5.20 via `sqlite3`), `6 high` (`body-parser`, `cacache`, `make-fetch-happen`, `multer`, `node-gyp`, `sqlite3`), `8 moderate` (`connect-session-sequelize`, `exceljs`, `ip-address`, `minimatch`, `nodemon`, `qs`, `sequelize`, `uuid`), `2 low`. |
| Analytics DB Reconciliation (`bhajans.db` raw SQL) | **MISMATCH FOUND** | DB has `741` rows across `77` sessions and `1024` active master bhajans (`21` submission singers vs `28` `singer_dictionary` rows). Speeds in DB: `medium: 564`, `medium fast: 79`, `medium slow: 41`, `slow: 27`, `fast: 21`, `not specified: 8`, `Not specified: 1`. Analytics merges `129` non-medium rows (`17.4%`) into `medium (693)` and rounds percentages to `101%`. |

---

## 5. Extended Admin Panel Verification (`mobtest` Credentials & Uncovered Routes)

> **Scope Rule Applied:** Existing 17 mirror-audited admin views were already covered (`playwright_admin_mirror_audit.json`, 40 admin screenshots) and were not re-screenshotted. Probed (a) Live Railway `mobtest` authentication, (b) all previously uncovered secondary admin HTML/JSON/export routes, (c) standard `admin` vs `super_admin` RBAC, and (d) POST/param edge cases on an isolated local mirror of `bhajans.db` (zero mutations to production data or `bhajans.db`).

| Check | Result | Observed Evidence |
|---|---|---|
| Live Railway Login (`mobtest` / `123456789`) | **FAIL (`401` on Live)** | `GET /admin-login` -> `200` (779 ms, CSRF token issued); `POST /admin-login` -> `401` (`Invalid username or password`). Local `bhajans.db` holds `mobtest` (`id: 3`, `display_name: "tester"`, `role: "super_admin"`), confirming Railway's volume DB does not share this account/password. |
| Local `mobtest` Full Route Sweep (35 Admin Routes) | **PASS (`200`/`301`/`302`)** | Authenticated login (`200`) cleanly unlocked all admin & super-admin routes: `/admin`, `/admin/date/2026-11-12`, `/admin/edit/784`, `/admin/rules`, `/admin/missing-bhajans`, `/admin/analytics`, `/admin/singers`, `/admin/singer-dictionary` (`301 -> /admin/singers`), `/admin/reports`, `/admin/bulletins`, `/admin/bulletins/new`, `/admin/bulletins/6/edit`, `/admin/notifications`, `/admin/activity-logs`, `/api/admin/activity-feed`, `/admin/import-sessions`, `/admin/archived-master-bhajans`, `/admin/export-master` (644 KB JSON, 1,024 entries), `/admin/users` (`302 -> /admin/admin-users`), `/admin/admin-users`, `/admin/admin-users/new`, `/admin/admin-users/2/edit`, `/admin/admin-users/2/reset-password`, `/admin/danger-reset-history`, `/admin/download-backup` (`4.06 MB .sqlite` attachment), `/admin/diwali`, `/admin/diwali/entry`, `/admin/diwali/import`, `/admin/diwali/export/yearly` (`9.59 KB .xlsx`), `/admin/diwali/sequence/editor`, `/admin/diwali/export/sequence` (`9.69 KB .xlsx`), `/admin/diwali/api/search-master?q=sai`, `/admin/diwali/participant/37`, `/admin/api/sessions/2026-11-12/audio`, `/admin/api/cloudflare/audio-files`. |
| Standard `admin` (`prashant16`) RBAC Enforcement | **PASS (`403` Clean Denial)** | Sidebar cleanly hides `admin-users`, `diwali`, `danger-reset-history`, and `download-backup`. Direct navigation/POST to all 8 restricted endpoints (`/admin/admin-users`, `/admin/users`, `/admin/diwali`, `/admin/diwali/entry`, `/admin/download-backup`, `/admin/danger-reset-history`, `POST /admin/activity-logs/purge`, `POST /admin/danger-reset-history`) returned HTTP `403` (`Forbidden: Super Admin access required`) with zero stack leaks (returned as plain text rather than styled admin error page). |
| Unbounded Payload & Inline Style Bloat on Admin Tables | **FAIL (Perf/Debt)** | `/admin/archived-master-bhajans` served **`1,990,093 B` (~2.0 MB HTML)** with **`7,966` inline `style=` attributes**; `/admin/activity-logs` served **`422,488 B` HTML** (`2,287` inline styles) + **`130,979 B` JSON** (`/api/admin/activity-feed`); `/admin/missing-bhajans` served **`313,637 B`** (`1,350` inline styles, `187` inline `onclick`); `/admin/singers` served **`214,188 B`** (`669` inline styles). |
| `POST /admin/edit/:id` & `GET /admin/date/:date` Edge Validation | **FAIL (Bug)** | `POST /admin/edit/784` with missing fields/date returned **`302` redirect to `/admin/date/undefined`** (`controllers/adminController.js:426-445` omits validation and row existence check); `GET /admin/date/not-a-date` emitted Moment/Sequelize `DATEONLY` fallback deprecation stack trace and rendered empty `200 OK` page. Missing ID GETs (`/admin/edit/9999999`, `/admin/bulletins/9999999/edit`, `/admin/admin-users/9999999/*`, `/admin/diwali/participant/9999999`) cleanly returned `404`. |
| Secondary Admin Form Labels, Headings, Titles & Server `_csrf` | **WARN (A11y / Hygiene)** | Unlabeled inputs (`missing for/id`) on `/admin`, `/admin/date/:date`, `/admin/edit/:id`, `/admin/rules`, `/admin/missing-bhajans`, `/admin/singers`, `/admin/notifications`, `/admin/import-sessions`, `/admin/archived-master-bhajans`, `/admin/admin-users/new`, `/admin/admin-users/:id/edit`, `/admin/admin-users/:id/reset-password`, `/admin/diwali/*`. Missing `<h1>` on `/admin/edit/:id`, `/admin/bulletins*`, `/admin/notifications`, `/admin/diwali/{entry,import,sequence/editor}`. Generic `<title>Bhajan Planner</title>` on `/admin/activity-logs`, `/admin/admin-users`, `/admin/admin-users/:id/reset-password`. 10 admin/Diwali POST forms omit server `_csrf` hidden inputs (relying on `public/js/script.js` submit injection). |
| Branch Divergence Inspection (`git log origin/develop..origin/main --oneline`) | **INFO** | Verified **33 commits** ahead on `origin/main`: mobile bottom nav & `SSSSO` fixes (`e5177b1`..`44d3436`), Diwali drag-drop/musicians/manual builder/SQLite locking (`9b3531b`..`67acd1b`), Claude-style sidebar hover/pin (`96008e0`), bulletin preview fixes (`4504eda`, `d007d06`), and dedicated server-side portrait/landscape PDF generator (`ecad7b1`..`5db8435`). |

