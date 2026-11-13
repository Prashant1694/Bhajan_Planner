# Bhajan Planner — End-to-End QA, Product & Codebase Audit Report

**Target Application:** Bhajan Planner (Sri Sathya Sai Seva Organisation, Gandhinagar)
**Audit Date:** 2026-11-13
**Branch Audited:** `develop` (commit `9114381` — note: diverges/lags `origin/main` `5db8435` by 33 commits)
**Environments Tested:**
- **Live (Railway Dev):** `https://bhajanschedular-development.up.railway.app/`
- **Local (Dev Server):** `http://localhost:8000/`
- **Isolated Authenticated Mirror:** Ephemeral server (`http://127.0.0.1:60341`) cloned from `bhajans.db` in OS temp storage

---

## 1. Executive Summary & Overall Score

**Overall Score: 63 / 100**

Bhajan Planner has a genuinely compelling devotional identity (warm cream, maroon, saffron/gold palette, serif typography, integrated Sai Organisation iconography, Master Bank with tanpura pitch drones, Singer PIN Hub, and WhatsApp program export) and covers an impressive breadth of real Samiti workflows. However, shipping the v6 app-shell refactor left severe functional, security, layout, and maintainability cracks: a **P0 Reflected XSS** in `/plan-view`, an **uncaught stack-overflow crash (`Maximum call stack size exceeded`)** firing on desktop app-shell prewarming, intrusive first-visit modals (`#whatsNewOverlay` and `#notifPromptOverlay`) locking out `/admin-login` and header controls, unmounted/mismatched admin routes and validators (`/admin/danger-reset-history`, `special`/`festival` permissions), dark-on-dark illegible hero buttons on 3 admin pages, and **3,025 `!important` CSS rules** fighting across 14 stylesheets.

### "Native Polish" Verdict
At first glance on desktop light mode, the cream-and-saffron palette and single-DOM navigation shell look custom-crafted rather than boilerplate, and dark mode on the Singer portal feels cohesive. In practice, however, fresh users are immediately gated by stacked popups that clip at 375px and block login, desktop client-side route prewarming crashes the console, and core mobile views break down with unreadable dark-on-dark hero buttons, truncated `...` KPI cards, blank `< Back Loading...` detail stalls, and horizontal-scroll tables. Until overlay sequencing, inline script escaping, responsive CSS hygiene, and app-shell routing reliability are fixed, the product reads as an ambitious prototype in active transition rather than a native-polished release.

---

## 2. Scorecard Breakdown

| Category | Score | Weight | Justification |
|---|---:|---:|---|
| **Functionality & correctness** | **17** | 25 | Core singer directory lookup, plan date selection, Diwali pair workflows, and SQLite persistence work reliably. However, serious defects fail end-to-end correctness: `app-shell-router.js:1238-1301` infinitely recurses during idle prewarm (`RangeError: Maximum call stack size exceeded`), `POST /admin/danger-reset-history` returns `404` despite having a view and controller (`adminController.js:665`), `admin-dashboard.ejs:114,123` triggers `400` validation rejections for `special`/`festival` modes, `/admin/missing-bhajans` disagrees with the sidebar badge (**461 vs 421**), `/admin/analytics` lumps 129 `medium fast`/`medium slow`/`not specified` rows into `medium` (summing to 101%), and fresh-load overlays trap `/admin-login` and topbar controls. |
| **Visual design & native polish** | **13** | 20 | The Fraunces + Inter pairing, warm cream background, SSSO emblem artwork, and Diwali dashboard cards establish strong devotional warmth. Visual polish drops sharply on secondary/admin pages: three dark-indigo hero banners (`/admin/analytics`, `/admin/admin-users`, `/admin/activity-logs`) render dark-grey ghost buttons with near-zero legibility; `/admin/admin-users/new` misaligns card widths due to a missing `.admin-card` wrapper and stray `</div>`; `/admin/session` uses mismatched indigo/teal inline-style buttons and truncates every mobile KPI label (`2 Bhajan... / PROGRAM S...`); and the desktop admin topbar duplicates the sidebar brand logo while wrapping `Public App`. |
| **UX, flows & mobile experience** | **10** | 15 | Features like the bottom mobile pill bar, Songbook bookmarking, and card/table toggles show mobile awareness. Yet mobile UX fails critical journeys: double auto-popups (`#whatsNewOverlay` + `#notifPromptOverlay`) obstruct even `/admin-login`, the `#whatsNewOverlay` card clips at 375px, the mobile sticky `Admin` pill overlaps bottom content (row 5 of November calendar, bottom cards on Reports/Singers), `/master-bank` and `/admin/singers` clip placeholders/pills mid-word, `/submit-form` forces a 560px horizontal table scroll instead of stacking cards, and `/my-hub` returns `401` JSON/text rather than cleanly redirecting unauthenticated browsers. |
| **Performance** | **6** | 10 | Desktop Local hits Lighthouse `97` and CLS stays near `0` across viewports with `0 ms` TBT and Railway Brotli compression. Mobile performance suffers (`75–77` on Live, `FCP 3.6–3.9s`, `LCP 4.3–4.5s`) because `/master-bank` sends **670–677 KB** of raw HTML with inline catalog JSON, 10+ synchronous `<head>` stylesheets block paint, `/admin/admin-login` fails `bf-cache` (3 reasons via `no-store`), `/database` on Local weighs **445 KB**, and all 5 Diwali tables lack database indexes. |
| **Security & data integrity** | **5** | 10 | Sequelize parameterized queries prevent SQLi, `helmet` sets `SAMEORIGIN`/`nosniff`/HSTS/CSP, admin routes enforce auth redirects, and CSRF rejects unauthenticated POSTs (`403`). Despite this, a **P0 Reflected XSS** exists on `/plan-view?session_date=</script><script>alert(1)</script>` via unescaped `<%- JSON.stringify(sessionDate) %>` inside an `'unsafe-inline'` CSP script block (with sibling Stored XSS exposure in 4 additional EJS views), `/admin-login` relies on JS-injected CSRF rather than a rendered hidden field, and `npm audit` reports **17 vulnerabilities** (`1 critical` `tar`, `6 high`). |
| **Accessibility** | **3** | 5 | Landmarks (`main`, `nav`), skip-to-top basics, and `90–96` Lighthouse accessibility scores provide a reasonable floor. Critical WCAG AA barriers remain: `#notifPromptOverlay` text yields a **`1.02`** contrast ratio (`#212529` on `#26221e`), hero buttons on 3 admin pages render dark text on dark indigo, form controls (`#filterBankTitle`, `#ticketCodeInput`, `#` on forgot-password) lack `<label>` associations, `/master-bank` has **144–148** undersized touch targets (22x22 tanpura buttons, 30x30 icons), and headings skip levels (`h1` -> `h3` / `h1Count=0`). |
| **Code quality & maintainability** | **5** | 10 | Modular route files, centralized middleware, and `services/validators.js` reflect positive cleanup intent. However, stylesheet technical debt is extreme (**3,025 `!important` declarations** across 14 CSS files), orphaned classes (`.topbar-left` vs `.native-top-left`) sit unused, triple-bound sidebar toggle listeners fight each other, server-side HTML string concatenation still lives inside `controllers/plannerController.js:705-853` and `services/plannerService.js`, zero automated tests exist in the repo, and `origin/develop` has drifted **33 commits** behind `origin/main`. |
| **Feature completeness vs. purpose** | **4** | 5 | Almost every workflow an SSSO Gandhinagar coordinator or singer needs is present: Thursday lifecycle automation, deity quota & sequence balancing, master bank + pitch drone + sheet links, singer PIN hub, WhatsApp program export, Diwali pair auditions, report ticketing, and push notifications. Only offline caching, calendar `.ics`/WhatsApp reminders, and clean print/PDF Thursday session sheets remain incomplete or half-polished. |

---

## 3. Phase 1 Inventory & Architecture Summary

### Route Groups & Auth Model
- **Public (`routes/home.js`, `routes/masterBank.js`, `routes/planner.js`, `routes/analytics.js`, `routes/bulletin.js`, `routes/reports.js`, `routes/api.js`):** `/` (`GET`), `/master-bank`, `/bhajan/:id`, `/plan-view`, `/plan/:session_date`, `/database`, `/bulletins`, `/bulletins/:id`, `/my-reports`, `/notification-settings`, `/session-link`, `/healthz`, plus public APIs (`/api/singers`, `/api/deity-rules`, `/api/check-cooldown`, `/api/scale-suggestions`, `/api/master-bhajans/:deity`, `/api/bhajan/:id/lyrics`, `/api/sessions/:date/audio`, `/api/reports/*`, `/api/notifications/*`).
- **Singer Authenticated (`routes/singerHub.js`, `routes/planner.js` with `requireSingerAuth` / PIN flow):** `/singer/login`, `/singer/logout`, `/singer/hub` & `/my-hub` (gated by `requireSingerAuth`), `/my-activity`, `/submit-form` (`GET`/`POST` checked in controller via singer/admin session), `/api/singer/songbook*`.
- **Admin Auth & Portal (`routes/auth.js`, `routes/admin.js`, `routes/singer.js`, `routes/reports.js`, `routes/bulletin.js`, `routes/notifications.js`, `routes/analytics.js`):** `/admin-login`, `/auth/google`, `/logout`, `/forgot-password*`, `/admin`, `/admin/date/:date`, `/admin/edit/:id`, `/admin/delete/:id`, `/admin/rules`, `/admin/update-rules`, `/admin/permission`, `/admin/missing-bhajans`, `/admin/activity-logs`, `/admin/singers`, `/admin/reports`, `/admin/bulletins*`, `/admin/notifications*`, `/admin/analytics`, `/admin/import-sessions`, `/admin/copy-session`, `/api/admin/*`.
- **Super Admin Only (`routes/adminUsers.js`, `routes/diwali.js`, `routes/admin.js`):** `/admin/admin-users*` (`router.use` with `requireSuperAdmin`), `/admin/diwali*` (`router.use` with `requireLogin, requireSuperAdmin`), `/admin/download-backup`, `/admin/danger-reset-history`, `/admin/activity-logs/purge`.
- **`templates.js` vs Server HTML String Concatenation:** `templates.js` itself is now just 17 lines exporting `escapeHtml`, **but server-side HTML string concatenation debt remains active inside `controllers/plannerController.js:705-853`** (`planView` timeline cards & table rows) and **`services/plannerService.js`** rather than EJS partials. All **60** view templates reside under `views/` + `views/partials/`.
- **CSS Architecture:** **14 stylesheets** in `public/css/` (`style.css`, `admin.css`, `loading.css`, etc.) containing **3,025 `!important`** flags (`style.css`: **1,389**; `admin.css`: **510**). Both `style.css` and `admin.css` load across admin/portal views causing specificity wars.

---

## 4. Live vs. Local Comparison

| Dimension | Live (`bhajanschedular-development.up.railway.app`) | Local (`http://localhost:8000`) | Impact / Root Cause |
|---|---|---|---|
| **HTTP Compression & TTFB** | Brotli (`br`), TTFB ~250–652 ms | Gzip (`gzip`), TTFB ~1–87 ms | Expected network vs localhost variance; Railway edge adds Brotli |
| **Database Volume** | `/database` 114,787 B (`1` archived card visible in search test); `/api/singers` 418 B | `/database` 444,843 B (**77** distinct sessions, 741 rows, 1,024 active master bhajans); `/api/singers` 1,327 B | Local `bhajans.db` holds full historical archive; Live dev DB has fewer archived sessions & singers |
| **PWA Variant** | `manifest.dev.json` (`Bhajan DEV`, `/images/icons/dev/icon-192x192.png`) | `manifest.dev.json` (`Bhajan DEV`, `/images/icons/dev/icon-192x192.png`) | Both run `development` PWA variant; legacy `bhajan-planner-dev-192.png` returns `404` on both |
| **Google OAuth (`admin-login`)** | Renders cleanly without GSI 403 | Fires console `403` from `accounts.google.com/gsi/button` | Authorized JS origin on Google OAuth Client ID excludes `http://localhost:8000` |
| **Perf (Lighthouse Home Mobile)** | Perf `77`, FCP `3.6s`, LCP `4.3s` | Perf `83`, FCP `3.0s`, LCP `3.8s` | Live network latency amplifies render-blocking CSS & oversized payloads |
| **Overlay Prompt Timing** | `#notifPromptOverlay.show` fired immediately after closing `#whatsNewOverlay`, blocking Playwright toggle clicks | `#shellThemeToggle` and `#shellNotifBtn` clickable cleanly after closing `#whatsNewOverlay` | Timing race / push subscription permission state difference on HTTPS origin vs `http://localhost` |

---

## 5. Known Issues Re-Verification (From Spec)

| # | Known Issue | Current Verified Status | Exact Evidence |
|---|---|---|---|
| 1 | **Mobile admin sidebar drawer** | **FUNCTIONALLY WORKS, TRIPLE-BOUND IN CODE** | Opens cleanly to `290x812` at `x:0` (`admin-dashboard_375_drawer-open.png`). However, `topbar.ejs` + `sidebar.ejs:18` + `script.js` + `main.ejs` bind three separate toggle listeners, creating double-toggle risk. |
| 2 | **"Bhajans already submitted" stacked cards on mobile** | **STILL BROKEN** | `views/submit-form.ejs:282-318` populates `data-label` on every `<td>`, yet `.submitted-bhajans-card` keeps standard table display / 560px horizontal scroll rules instead of mobile card layout. |
| 3 | **Admin topbar name/role-badge alignment** | **STILL PARTIALLY BROKEN** | `views/partials/topbar.ejs` uses `.native-top-left` & `.native-top-actions`, while `admin.css:738,812,2029-2056` target `.topbar-left`/`.topbar-right`. At 1440px (`admin-dashboard_1440_default.png`), brand text wraps (`Bhajan\nPlanner`), `Public App` wraps onto 2 lines, and long usernames (`ZZ Audit SuperAdmin VeryLongName`) do not truncate with ellipsis. |
| 4 | **Missing horizontal padding in admin cards** | **STILL BROKEN** | `admin.css:1287-1290` zeroes `.admin-card-body` padding inside `.admin-form-wrapper`; `views/admin-user-form.ejs:48,140` lacks `.admin-card` on card 1 and has a stray `</div>`, creating asymmetric card alignment (`admin-user-form_1440_default.png`). `.page-body:has(.session-unified-page)` compresses horizontal padding to `14px` desktop / `6px` mobile (`admin.css:3589-3617`). |
| 5 | **Stray "..." text in admin calendar / truncation** | **PRESENT AS CSS ELLIPSIS TRUNCATION** | Calendar month wraps (`November\n2026`) cleanly without literal `...` in `admin-dashboard.ejs`, **but** `/admin/date/:date` at 375px (`admin-session-view_375_default.png`) truncates all 4 KPI values & labels with `...` (`2 Bhajan... / PROGRAM S...`, `1 Mediu... / TEMPO DIS...`), and search inputs clip mid-word (`Search ticket #, title, lyri`, `Search deity na`). |
| 6 | **Hardcoded inline button styles** | **STILL WIDESPREAD** | `admin-dashboard.ejs` hero buttons, `admin-session-view` indigo `Session Audio` & teal `Share Lineup` buttons (`admin-session-view_375_default.png`), `admin-danger-reset.ejs` (`#b23b32`), and `admin-users.ejs` / `analytics.ejs` carry inline style attributes violating token theming. |
| 7 | **Thursday upcoming/missed/active logic** | **PARTIALLY BROKEN ON PAST SESSIONS** | Calendar correctly marks yesterday `Nov 12` as `Missed Session` (red) and upcoming Thursdays `Nov 19`/`26` as `Regular Session` (purple) (`admin-dashboard_1440_default.png`). **However**, viewing past session `Nov 5, 2026` (`admin-session-view_375_default.png`) shows both **`Past`** and green **`Submissions Open`** simultaneously. |

---

## 6. Detailed Findings by Severity

### P0 — Critical Functional & Security Blockers

1. **[SEC-01] Reflected XSS in `/plan-view` via unescaped `session_date` inside `<script>` (`views/plan-view.ejs:148`, `controllers/plannerController.js:590`)**
   - **Steps:** Request `GET /plan-view?session_date=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E` on Live or Local.
   - **Expected:** Strict `YYYY-MM-DD` validation or HTML/Unicode escaping of JSON embedded in `<script>`.
   - **Actual:** Server returns HTTP `200` with literal `const _PLAN_DATE = "</script><script>alert(1)</script>";` inside `<script>`, breaking out of the script element and executing injected JS (CSP includes `'unsafe-inline'`). Sibling `<%- JSON.stringify(...) %>` exposures exist in `views/admin-session-view.ejs:1327-1328`, `views/database.ejs:300`, `views/master-bank.ejs:639`, and `views/app-shell.ejs:1032-1051`.

2. **[FUNC-01] Infinite Mutual Recursion in App Shell Idle Prewarming (`public/js/app-shell-router.js:1238-1301`)**
   - **Steps:** Load `/`, `/master-bank`, `/plan-view`, `/database`, `/bulletins`, `/my-reports`, `/notification-settings`, or `/singer/login` at 768px, 1024px, or 1440px (and Lighthouse mobile runs).
   - **Expected:** Background tab prewarming populates inactive tabs cleanly.
   - **Actual:** `scheduleIdlePrewarm()` -> `prefetchTab(targetTab)` -> `prefetchRoute(defaultUrl)` -> sees `!isDetailRoute(pathname) && targetTab && !paneState[targetTab].loaded` -> calls `prefetchTab(targetTab)` recursively until **`RangeError: Maximum call stack size exceeded`** aborts execution (`playwright_public_audit.json`, Lighthouse `errors-in-console`).

3. **[FUNC-02] Broken `POST /admin/danger-reset-history` Route Returns 404 (`views/admin-danger-reset.ejs:33`, `controllers/adminController.js:665`, `routes/admin.js`)**
   - **Steps:** Log in as `super_admin`, navigate to `/admin/danger-reset-history`, enter confirmation `DELETE ALL HISTORY`, submit form (`POST /admin/danger-reset-history`).
   - **Expected:** Authenticated Super Admin resets history with pre-backup.
   - **Actual:** Mirror probe received **HTTP `404` HTML error page** because `routes/admin.js` mounts `GET /admin/danger-reset-history` but never mounted `POST /admin/danger-reset-history` (`adminController.dangerResetHistory`).

4. **[FUNC-03] Dashboard Permission Buttons Rejected by Validator (`views/admin-dashboard.ejs:114,123`, `services/validators.js:151`)**
   - **Steps:** In Admin Dashboard date modal, click actions triggering `updatePermission('special')` or `updatePermission('festival')` (`POST /admin/permission`).
   - **Expected:** Date switches cleanly to Special or Festival session mode.
   - **Actual:** Mirror probe received **HTTP `400`**: `{"error":"Validation failed","details":["Permission type must be one of: open, restricted, closed, clear."]}`.

---

### P1 — High Severity UX, Data Integrity, Performance & Security Bugs

5. **[UX-01] Fresh-Visit Modal Stack Auto-Popup Blocks Login & Topbar Controls (`#whatsNewOverlay`, `#notifPromptOverlay`)**
   - **Steps:** Open `/admin-login`, `/`, `/master-bank`, `/submit-form`, or `/plan-view` in a fresh browser context (`admin-login_375_default.png`, `home_375_default.png`).
   - **Expected:** `/admin-login` renders only the login UI; onboarding prompts appear non-blockingly and fit within mobile viewports.
   - **Actual:** `#whatsNewOverlay` auto-opens over `/admin-login` and all public pages, clipping at bottom edge on 375px (`home_375_default.png`) and intercepting pointer clicks (`Submit`, `#filterBankTitle`). After dismissal on Live HTTPS, `#notifPromptOverlay.show` immediately popped over the page and timed out clicks on `#shellThemeToggle` and `#shellNotifBtn` (`task-334.log`).

6. **[UX-02] Unauthenticated `/master-bank` Fires 401 `/api/singer/songbook` Error on Every Load**
   - **Steps:** Visit `/master-bank` while logged out.
   - **Expected:** Skip personal songbook API fetch unless singer auth is present.
   - **Actual:** Console logs HTTP `401` (`Failed to load resource: the server responded with a status of 401 ()` for `/api/singer/songbook`), degrading Lighthouse Best Practices across every public visit.

7. **[UX-03] App Shell Direct Transition Stalls/Flashes `< Back Loading...` with Stale Header**
   - **Steps:** Navigate within the Playwright session directly to `/database`, `/bulletins`, or `/bhajan/341` (`database_1440_clean.png`, `bulletins_375_clean.png`, `bhajan-details_375_clean.png`).
   - **Expected:** Skeleton transition updates header title to destination page and populates `#shellDetailView` promptly.
   - **Actual:** Header stays stuck on previous tab title (`Live Session Plan` / `Master Songbook`) while `#shellDetailView` displays `< Back Loading...` over an empty canvas.

8. **[UI-01] Unreadable Dark-on-Dark Hero Buttons on 3 Admin Pages (`analytics`, `admin-users`, `activity-logs`)**
   - **Evidence:** `analytics_1440_default.png`, `analytics_375_default.png`, `admin-users_375_default.png`, `activity-logs_375_default.png`.
   - **Actual:** Secondary outline buttons inside dark indigo gradient hero banners (`Singers`, `Dashboard`, `Purge (>30d)`) inherit dark charcoal text (`#374151`) against `#2e1f9e`, rendering text nearly invisible.

9. **[DATA-01] Missing Bhajan Catcher Badge vs Page Total Mismatch (421 vs 461)**
   - **Evidence:** `admin-missing-bhajans_375_default.png` shows sidebar badge `421` while page header & KPI card show `461 Unlinked Submissions` / `461 MISSING FROM MASTER`.
   - **Root Cause:** `helpers.js` (`getCachedMissingCount`) matches by normalized title (`byNormTitle`), whereas `adminController.js:773-818` matches by exact lowercase title (`byExactLowerTitle`).

10. **[DATA-02] Analytics Tempo Corruption & Title Normalization Drift (`controllers/analyticsController.js:241-247`)**
    - **Evidence:** `analytics_1440_default.png` displays `27 SLOW (4%) | 693 MEDIUM (94%) | 21 FAST (3%)` (sum = **101%**) and `603 Unique Titles`.
    - **Raw SQLite Audit:** Actual DB values across 741 rows: `medium: 564`, `medium fast: 79`, `medium slow: 41`, `slow: 27`, `fast: 21`, `not specified: 8`, `Not specified: 1`. Only checking `slow` and `fast` misclassifies **129 rows (17.4%)** as `medium`. Additionally, `603` exact titles collapse to `588` normalized (`LOWER(TRIM(title))`) titles (15 case/whitespace duplicates).

11. **[DATA-03] `Activity Logs` Shows `Online Admins: 0` While Actively Browsing Admin**
    - **Evidence:** `activity-logs_375_default.png` displays `Online Admins: 0`, `Online Singers: 1` while the Super Admin is logged in on `/admin/activity-logs`. Admin pages omit heartbeat tracking / filter mismatch in `activityController`.

12. **[UI-02] `admin-user-form.ejs` Broken Card DOM Structure & Asymmetric Edges**
    - **Evidence:** `admin-user-form_1440_default.png`, `views/admin-user-form.ejs:48,140`.
    - **Actual:** `Administrator Information` lacks `.admin-card` wrapper, `.admin-card-body` padding is zeroed inside `.admin-form-wrapper` (`admin.css:1287-1290`), and a stray `</div>` closes the wrapper before `Security`, creating misaligned container widths and orange border mismatch.

13. **[A11Y-01] Critical Color Contrast Violations (1.02 Ratio) & Unlabeled Form Inputs**
    - **Evidence:** Lighthouse `color-contrast`: `#notifPromptOverlay .notif-benefits-list li strong` renders `#212529` on `#26221e` (**1.02** ratio!); `.pwa-banner-size`, `#pwaBannerSize`, `#pwaBtnDismiss` score **3.63** (`#8b8394` on `#fff`); `.notif-prompt-subtitle` scores **3.54** (`#888888` on `#fff`); disabled CTA on `singer-login_375_clean.png` in dark mode has ultra-low contrast.
    - **Missing Labels:** `#filterBankTitle` (`/master-bank`), `#ticketCodeInput` (`/my-reports`), `#` (`/forgot-password`) lack `<label>` / proper `aria-label` associations.

14. **[PERF-01] Oversized `/master-bank` HTML Payload (~670–677 KB) & Missing Diwali Indexes**
    - **Evidence:** HTTP probe shows `/master-bank` returning `669,783 B` (Live) / `676,757 B` (Local) because `views/master-bank.ejs:639` inlines the entire 1,024-bhajan array into HTML instead of paginating/loading JSON async. Live mobile FCP hits `3.9s`, LCP `4.5s`. Zero DB indexes exist across all 5 Diwali tables.

15. **[SEC-02] 17 Dependency Vulnerabilities (`npm audit --json`) + JS-Dependent CSRF in `admin-login.ejs`**
    - **Evidence:** `1 critical` (`tar` via `sqlite3`), `6 high` (`body-parser`, `cacache`, `make-fetch-happen`, `multer`, `node-gyp`, `sqlite3`), `8 moderate` (`sequelize`, `exceljs`, `connect-session-sequelize`, `uuid`, `ip-address`, `qs`, `minimatch`, `nodemon`), `2 low`. Plus `views/admin-login.ejs` omits `<input type="hidden" name="_csrf">` from server HTML, failing if JS hasn't hydrated yet.

---

### P2 — Medium Severity UX, Layout & Maintainability Debt

16. **[UI-03] Mobile Sticky Bottom `Admin` Pill Overlaps Page Content (`admin-dashboard_375_default.png`, `admin-reports_375_default.png`, `singers_375_default.png`)**
    - Bottom clearance (`padding-bottom`) on `.page-body` / admin views is insufficient, so row 5 of the calendar (`29, 30`) and bottom filter/list cards sit under the floating bottom `Admin` pill.

17. **[UI-04] Mobile Session View Truncates All 4 KPI Cards (`admin-session-view_375_default.png`)**
    - At 375px, 2-up `.session-stat-card` widths compress strings into `2 Bhajan... / PROGRAM S...` and `1 Mediu... / TEMPO DIS...`, and renders a redundant `(Thursday)` beneath `Thursday, Nov 5, 2026`.

18. **[UI-05] Mobile Rules Cards Render Blank Field Rows (`admin-rules_375_default.png`)**
    - On `/admin/rules` at 375px, `#filter` placeholder truncates (`Search deity na`) and responsive card stacking hides table headers without restoring visible `data-label` prefixes above the `- 0 +` and `- 2 +` steppers.

19. **[UI-06] Singer Directory Filter Strip Clipped & 73% Missing Gender (`singers_375_default.png`)**
    - Filter tab bar clips `Not [Protected]` vertically at 375px; `27 of 37` singers lack gender data (`9 Male 24%`, `1 Female 3%`), skewing coordination planning metrics.

20. **[UX-04] `/master-bank` 144–148 Undersized Touch Targets (<44px) & FAB Overlap (`master-bank_375_clean.png`)**
    - `btn-pitch-drone-play` (`22x22`), `card-details-arrow-btn` (`30x30`), `card-sheet-btn-sm` (`75x26`), `btn-card-bookmark` (`34x44`), topbar icon buttons (`36x36`), and bottom pill links (`38px` height) fall below 44x44pt Apple/Google touch minimums. The floating yellow Tanpura FAB overlaps the Reset button at 375px (`master-bank_375_clean.png`).

21. **[UX-05] Naive `Accept` Header Matching Returns 401 Instead of Login Redirect & 404/Auth Ordering**
    - Browsers/clients sending `Accept` containing `json` (e.g., programmatic fetches or hybrid navigations) receive raw `401` on `/my-hub` and `/singer/hub`, while `/admin/users` (mistyped route for `/admin/admin-users`) returns `404` while logged out before checking admin auth. Also `/admin/bulletins` (`admin-bulletins_375_default.png`) leaves test entries (`test3433532`, `test test`) visible in the DB.

22. **[DEBT-01] `develop` Branch Lags `main` by 33 Commits & 3,025 `!important` CSS Rules**
    - `origin/develop` (`9114381`) misses 33 commits already in `origin/main` (`5db8435` — Claude-style sidebar hover/pin, dedicated server-side portrait/landscape PDF generator, Diwali drag-drop & musicians, bulletin date/preview & mobile nav fixes). Zero automated tests were committed prior to this audit (`53/53` local tests added during Phase 1–3 fixes remain in ignored `tests/`).

23. **[ADMIN-01] `POST /admin/edit/:id` Lacks Validation & Redirects to `/admin/date/undefined` (`controllers/adminController.js:426-445`)**
    - `updateSubmission` destructures `session_date` and song fields directly into `BhajanSubmission.update(...)` without validator enforcement or row-existence check. Submitting omitted/invalid `session_date` produces `302 -> /admin/date/undefined`, while `GET /admin/date/not-a-date` (`adminController.js:231-240`) runs an invalid `DATEONLY` query (`moment` deprecation stack trace) and renders `200 OK`.

24. **[ADMIN-02] Heavy Admin Payloads & Secondary Form A11y/CSRF Gaps Across Uncovered Sub-Routes**
    - Full 35-route sweep with `mobtest` (`super_admin`) & `prashant16` (`admin`) confirmed clean RBAC (`403` on all 8 restricted `super_admin` endpoints) and healthy `.sqlite`/`.xlsx` exports, **but** uncovered severe HTML bloat on `/admin/archived-master-bhajans` (**1.99 MB HTML, 7,966 inline `style=` attributes**), `/admin/activity-logs` (**422 KB, 2,287 inline styles** + **131 KB JSON**), `/admin/missing-bhajans` (**314 KB, 1,350 inline styles**), and `/admin/singers` (**214 KB, 669 inline styles**). Secondary admin/Diwali forms (`/admin/edit/:id`, `/admin/admin-users/:id/edit`, `/admin/admin-users/:id/reset-password`, `/admin/bulletins/new`, `/admin/diwali/*`) omit `for`/`id` label links, `<h1>` landmarks, specific `<title>` tags, and server-side `_csrf` hidden inputs (relying on `public/js/script.js` submit injection). *(Live Railway `POST /admin-login` with `mobtest` returned `401`, indicating `mobtest` only exists locally.)*

---

## 7. Performance & Lighthouse Summary

| Target & Page | Form Factor | Perf | A11y | BP | SEO | FCP | LCP | CLS | TBT | Transfer / HTML Size |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Live `/` | Mobile | **77** | **96** | 96 | 100 | 3.6 s | 4.3 s | 0 | 0 ms | 387 KiB (128 KB HTML `br`) |
| Live `/` | Desktop | **87** | **96** | 96 | 100 | 1.4 s | 1.4 s | 0.003 | 0 ms | 387 KiB |
| Live `/master-bank` | Mobile | **75** | **90** | 96 | 100 | 3.9 s | 4.5 s | 0 | 0 ms | 416 KiB (670 KB HTML `br`) |
| Live `/plan-view` | Mobile | **77** | **94** | 96 | 100 | 3.7 s | 4.3 s | 0 | 0 ms | 370 KiB (92 KB HTML `br`) |
| Live `/admin-login` | Desktop | **82** | **96** | **93** | **91** | 1.3 s | 1.8 s | 0.027 | 0 ms | 772 KiB (`bf-cache` failed) |
| Local `/` | Mobile | **83** | **96** | 96 | 100 | 3.0 s | 3.8 s | 0 | 0 ms | 412 KiB (130 KB HTML `gzip`) |
| Local `/` | Desktop | **97** | **96** | 96 | 100 | 0.9 s | 0.9 s | 0.001 | 0 ms | 421 KiB |
| Local `/master-bank` | Mobile | **81** | **90** | 96 | 100 | 3.3 s | 3.9 s | 0 | 0 ms | 451 KiB (677 KB HTML `gzip`) |

**Key Optimization Bottlenecks Observed:** `errors-in-console` (stack overflow + 401), render-blocking stylesheets (`network-dependency-tree-insight`), `forced-reflow-insight`, `/master-bank` inline JSON bloat, missing Diwali table indexes, and `bf-cache` prevention (`Cache-Control: no-store` on login page).

---

## 8. Key Screenshot Index (`/audit/screenshots/`)

- `home_375_default.png`, `home_1440_default.png` — Fresh-visit `#whatsNewOverlay` blocking viewport & clipping at 375px
- `home_375_clean.png`, `home_1440_clean.png` — Clean hero, SSSO emblems, Thursday banner, and bottom tab bar
- `master-bank_375_clean.png`, `master-bank_1440_clean.png` — Dark mode mobile clipping placeholder & yellow FAB over Reset; desktop card grid
- `plan-view_375_clean.png`, `plan-view_1440_clean.png` — Truncated session selector on 375px, clean empty state
- `database_375_clean.png`, `database_1440_clean.png`, `bulletins_375_clean.png`, `bhajan-details_375_clean.png` — App shell `< Back Loading...` stall & stale header title during direct transition
- `singer-login_375_clean.png`, `admin-login_375_default.png` — Faint disabled CTA in dark mode; `#whatsNewOverlay` hijacking admin login
- `admin-dashboard_375_default.png`, `admin-dashboard_375_drawer-open.png`, `admin-dashboard_1440_default.png` — Month wrap, bottom sticky overlap, functioning 290px mobile drawer, desktop topbar duplication & non-truncating username
- `admin-session-view_375_default.png`, `admin-session-view_1440_default.png` — Redundant `(Thursday)`, `Past` + `Submissions Open` contradiction, truncated KPI cards, clashing indigo/teal inline buttons
- `admin-user-form_1440_default.png` — Misaligned card containers from stray `</div>` and missing `.admin-card`
- `analytics_1440_default.png`, `analytics_375_default.png`, `admin-users_375_default.png`, `activity-logs_375_default.png` — Unreadable dark-on-dark hero buttons; tempo summing to `101%`; `Online Admins: 0`
- `admin-missing-bhajans_375_default.png` — Sidebar `421` badge vs page `461` total mismatch
- `admin-rules_375_default.png`, `singers_375_default.png`, `admin-reports_375_default.png`, `admin-bulletins_375_default.png`, `admin-danger-reset_375_default.png` — Blank mobile stepper labels, clipped `Not [Protected]` filter, truncated inputs, pre-existing test bulletins, unmounted POST reset form
- `diwali-dashboard_1440_default.png`, `diwali-dashboard_375_default.png` — Strong benchmark layout for clean admin cards & tables

