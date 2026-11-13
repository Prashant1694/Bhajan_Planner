# Bhajan Planner — Prioritized Implementation & Roadmap Plan

**Baseline Audit Score:** **63 / 100** (see `AUDIT_REPORT.md`)
**Current Branch State (`develop` + local Phase 1–3 fixes):** Phases 1–3 core fixes + Diwali DB indexes + `53` local tests implemented & passing; Live Railway still on pre-fix deployment (**401** for local-only `mobtest` user).
**Target Post-Execution Score:** **96 / 100**

---

## Execution Overview & Re-Score Projections

| Phase | Scope | Status | Est. Score After Phase | Risk & Rollback Strategy |
|---|---|---|---:|---|
| **Baseline** | Initial `develop` (`9114381`) | **Audited** | **63 / 100** | Read-only baseline |
| **Phase 1: P0 Critical Fixes** | Escape script JSON (`plan-view` + 4 views), fix `app-shell-router.js` recursion, mount `POST /admin/danger-reset-history`, align `special`/`festival` permission validator | **Implemented Locally** (`tests/` pass) | **73 / 100** | **Low risk.** Small isolated changes; test XSS & shell navigation before deploy. |
| **Phase 2: Quick Wins (<1 hr each)** | Fix `#notifPromptOverlay` contrast & login suppression, guard `/api/singer/songbook`, mount server CSRF hidden input in `admin-login.ejs`, remove `(Thursday)` / `Submissions Open` badge contradiction, clean dev test bulletins, add public filter/ticket labels | **Implemented Locally** (`tests/` pass) | **79 / 100** | **Very low risk.** Markup/CSS/client guard tweaks; zero schema migrations. |
| **Phase 3: Polish Sprint** | Fix hero dark-on-dark buttons, unify `421`/`461` missing count & analytics tempo normalization, fix `admin-user-form.ejs` & `.admin-card` padding, fix mobile KPI/stacking/clearance/touch targets, compact `/master-bank` + Diwali DB indexes | **Implemented Locally** (excl. online `npm audit` & async `/master-bank` split) | **87 / 100** | **Medium risk.** SQLite backup prior to deploying new indexes/analytics changes; verify raw SQL totals. |
| **Phase 5A (Priority Reconcile): `main` <-> `develop` Sync** | Cherry-pick 33 commits from `origin/main` (`5db8435`): dedicated portrait/landscape PDF generator, Claude hover/pin sidebar, Diwali drag-drop/musicians/locks, bulletin & mobile nav fixes — preserving `manifest.dev.json` & Phases 1–3 | **Pending (Run BEFORE Phase 4B)** | **89 / 100** | **Medium risk.** Cherry-pick in 4 grouped batches; run `npm test` after each batch to keep Phases 1–3 intact. |
| **Phase 4: Hardening + Coordinator & Devotional Workflows** | **Wave 4A:** Fix `POST /admin/edit/:id` & date guard, paginate `archived-master` (**2 MB**)/`activity-logs`/`missing`/`singers`, secondary form A11y/`_csrf`/styled `403`, upgrade `npm audit` deps + Railway deploy. **Wave 4B:** Finish Thursday PDF polish (`origin/main`), WhatsApp + `.ics` reminders, rotation cooldown/availability matrix, CSV/XLSX bulk roster/gender sync. **Wave 4C:** Full offline PWA mode | **Restructured** | **93 / 100** | **Low–Medium risk.** Ship Wave 4A before feature rollout; keep JSON endpoints backwards-compatible. |
| **Phase 5 (5B–5D): Long-Term Architectural Refactors** | **5B:** Extract `plannerController.js` & `plannerService.js` HTML strings to EJS partials. **5C:** CSS `@layer` + `.adm-` token isolation (eliminate **3,025** `!important` & **~12k** admin inline styles). **5D:** Track `tests/` (**53+** tests), add Playwright visual E2E + GitHub Actions CI | **Restructured** | **96 / 100** | **Higher scope risk.** Execute CSS layers view-by-view against Playwright visual snapshots. |

---

## Phase 1: P0 Critical Fixes (Do First — Stop Crashes & Vulnerabilities)

### [FIX-P0-01] Escape Inline `<%- JSON.stringify(...) %>` Across EJS Views (Reflected & Stored XSS)
- **Category:** Security
- **Severity:** **P0**
- **Affected Files / Routes:** `views/plan-view.ejs:147-148,259`, `controllers/plannerController.js:590`, `views/admin-session-view.ejs:1327-1328`, `views/database.ejs:300`, `views/master-bank.ejs:639`, `views/app-shell.ejs:1032-1051` (`GET /plan-view`, `/admin/date/:date`, `/database`, `/master-bank`, shell routes)
- **Root Cause:** `req.query.session_date` lacks `YYYY-MM-DD` validation in `planView` and is written raw via `<%- JSON.stringify(sessionDate) %>` inside an inline `<script>` tag under CSP `'unsafe-inline'`, allowing `</script><script>alert(1)</script>` breakout.
- **Proposed Fix:**
  1. Create a shared `safeJsonForScript(obj)` helper (`res.locals.safeJson`) that serializes via `JSON.stringify` and replaces `<`, `>`, `&`, `\u2028`, `\u2029` with `\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029`.
  2. Validate `req.query.session_date` in `plannerController.planView` against `/^\d{4}-\d{2}-\d{2}$/` (falling back cleanly to default session or 400).
  3. Replace every `<%- JSON.stringify(...) %>` in the 5 affected views with `<%- safeJson(...) %>` or `<script type="application/json">` data blocks parsed with `JSON.parse`.
- **Effort:** S (1–2 hours)
- **Dependencies:** None
- **Acceptance Criteria:** Requesting `/plan-view?session_date=</script><script>alert(1)</script>` yields zero literal `<script>alert(1)</script>` anywhere in HTML; CSP works without relying on XSS tolerance.

### [FIX-P0-02] Fix Infinite Mutual Recursion in App Shell Idle Prewarming
- **Category:** Bug / Performance
- **Severity:** **P0**
- **Affected Files / Routes:** `public/js/app-shell-router.js:1238-1325` (all app-shell routes: `/`, `/master-bank`, `/plan-view`, `/database`, `/bulletins`, `/my-reports`, `/notification-settings`, `/singer/login`)
- **Root Cause:** `prefetchTab(tabName)` invokes `prefetchRoute(defaultUrl)`, which checks `!isDetailRoute(pathname) && targetTab && !paneState[targetTab].loaded` and calls `prefetchTab(targetTab)` in an endless mutual loop (`RangeError: Maximum call stack size exceeded`).
- **Proposed Fix:**
  1. Add a `Set` (`prefetchingTabs`) or pass `{ bypassTabRedirect: true }` into `prefetchRoute` from `prefetchTab`.
  2. Mark `paneState[targetTab].loading = true` before initiating `fetchAndMountFragment` so re-entrant calls exit immediately.
  3. Ensure failed prefetches clear `loading = false` in `finally`.
- **Effort:** S (30 min)
- **Dependencies:** None
- **Acceptance Criteria:** Navigating all public routes across 375/768/1024/1440px and Lighthouse audits emits zero `Maximum call stack size exceeded` errors.

### [FIX-P0-03] Mount `POST /admin/danger-reset-history` Route
- **Category:** Bug
- **Severity:** **P0**
- **Affected Files / Routes:** `routes/admin.js`, `views/admin-danger-reset.ejs:33`, `controllers/adminController.js:665` (`POST /admin/danger-reset-history`)
- **Root Cause:** `adminController.dangerResetHistory` and the EJS form exist, but `POST /admin/danger-reset-history` was never registered in `routes/admin.js`, causing HTTP `404` on submit.
- **Proposed Fix:**
  1. Add `router.post("/admin/danger-reset-history", requireSuperAdmin, adminController.dangerResetHistory);` in `routes/admin.js`.
  2. Verify typed phrase `DELETE ALL HISTORY` check, automatic SQLite pre-backup creation, and CSRF verification inside `dangerResetHistory`.
- **Effort:** S (15 min)
- **Dependencies:** None
- **Acceptance Criteria:** Authenticated Super Admin submitting `DELETE ALL HISTORY` receives clean reset confirmation (200/302) with pre-backup created; non-super-admins receive 403.

### [FIX-P0-04] Allow `special` and `festival` Permission Types in Validator
- **Category:** Bug
- **Severity:** **P0**
- **Affected Files / Routes:** `services/validators.js:151`, `views/admin-dashboard.ejs:114,123` (`POST /admin/permission`)
- **Root Cause:** Dashboard modal buttons invoke `updatePermission('special')` and `updatePermission('festival')`, while `validateUpdatePermission` restricts `validTypes` to `["open", "restricted", "closed", "clear"]`.
- **Proposed Fix:**
  1. Update `validTypes` in `services/validators.js:151` to match all UI session permission types supported by `adminController.updatePermission` (`open`, `restricted`, `closed`, `clear`, `special`, `festival`).
  2. Add controller handling test to ensure `special`/`festival` update `SessionPermission` cleanly.
- **Effort:** S (20 min)
- **Dependencies:** None
- **Acceptance Criteria:** Clicking Special/Festival toggles in `adminDateModal` returns HTTP `200` and reflects on the admin calendar & session view.

---

## Phase 2: Quick Wins (< 1 Hour Each)

### [QW-01] Suppress Onboarding Overlays on Auth Pages & Fix Sequential Gating + 1.02 Contrast
- **Category:** UX / Accessibility
- **Severity:** **P1**
- **Affected Files / Routes:** `views/admin-login.ejs`, `views/forgot-password*.ejs`, `public/js/notifications.js`, `public/css/style.css` (`#whatsNewOverlay`, `#notifPromptOverlay`)
- **Root Cause:** Fresh visitors get `#whatsNewOverlay` (blocking login submit & clipping at 375px) followed immediately on Live HTTPS by `#notifPromptOverlay.show`, whose `.notif-benefits-list li strong` renders `#212529` on `#26221e` (**1.02** contrast ratio).
- **Proposed Fix:** Skip What's New & Notification prompts on auth routes (`/admin-login`, `/forgot-password`, `/singer/login`); limit to one non-blocking toast/sheet per visit after user lands on `/`; make `#whatsNewOverlay` max-height `88dvh` with internal scroll at 375px; set `#notifPromptOverlay` card background and `strong` foreground colors to >= 7:1 contrast.
- **Effort:** S (45 min) | **Dependencies:** None | **Acceptance Criteria:** `/admin-login` renders clean without popups on fresh browsers; Lighthouse `color-contrast` passes on `#notifPromptOverlay`.

### [QW-02] Stop Firing Unauthenticated `/api/singer/songbook` on Public `/master-bank`
- **Category:** Bug / Best Practices
- **Severity:** **P1**
- **Affected Files / Routes:** `views/master-bank.ejs` / `public/js/` (`GET /master-bank`)
- **Root Cause:** Client script unconditionally fetches `/api/singer/songbook` even when visitor is not authenticated as a singer, logging a `401` console error on every page load.
- **Proposed Fix:** Pass `isSingerLoggedIn` (or check body data attribute `data-singer-auth="1"`) before fetching `/api/singer/songbook`.
- **Effort:** S (15 min) | **Dependencies:** None | **Acceptance Criteria:** Visiting `/master-bank` logged out yields zero HTTP 401 console errors.

### [QW-03] Render Server-Side `_csrf` Hidden Input Directly in `admin-login.ejs` & Add Input Labels
- **Category:** Security / Accessibility
- **Severity:** **P1**
- **Affected Files / Routes:** `views/admin-login.ejs`, `views/master-bank.ejs` (`#filterBankTitle`), `views/my-reports.ejs` (`#ticketCodeInput`), `views/forgot-password*.ejs` (`input#`)
- **Root Cause:** `admin-login.ejs` omits `<input type="hidden" name="_csrf">`, relying on JS injection; three public inputs fail accessibility label checks.
- **Proposed Fix:** Render `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` inside `admin-login.ejs` form and associate visible or `.sr-only` `<label for="...">` tags (plus explicit `id` on forgot-password input).
- **Effort:** S (25 min) | **Dependencies:** None | **Acceptance Criteria:** Zero `unlabeledControls` reported by Playwright; login succeeds even before secondary JS completes.

### [QW-04] Fix Past Session Badge Contradiction & Duplicate `(Thursday)` Subtitle
- **Category:** Bug / Copywriting
- **Severity:** **P2**
- **Affected Files / Routes:** `views/admin-session-view.ejs` (`GET /admin/date/:date`)
- **Root Cause:** Past sessions render both `Past` and green `Submissions Open`, and header repeats `(Thursday)` directly under `Thursday, Nov 5, 2026`.
- **Proposed Fix:** Conditionally suppress or switch `Submissions Open` -> `Session Completed / Archived` when `isPast`; strip redundant `(Day)` when date string already includes weekday.
- **Effort:** S (20 min) | **Dependencies:** None | **Acceptance Criteria:** `/admin/date/2026-11-05` renders clean single day header and non-contradictory status badge.

### [QW-05] Redirect Browsers Cleanly on `/my-hub` & `/singer/hub` + Fix `/admin/users` Auth Ordering
- **Category:** UX / Auth
- **Severity:** **P2**
- **Affected Files / Routes:** `middleware/singerAuth.js:140-210`, `routes/adminUsers.js` (`GET /my-hub`, `/singer/hub`, `/admin/users`)
- **Root Cause:** `req.headers.accept.includes("json")` triggers JSON `401` even for standard browser/XHR HTML navigations; `/admin/users` returns `404` when logged out.
- **Proposed Fix:** Use `req.accepts(["html", "json"]) === "json" && req.xhr` (or `/api/` path prefix check) before returning JSON 401; add a clean alias redirect `/admin/users` -> `/admin/admin-users` behind `requireLogin, requireSuperAdmin`.
- **Effort:** S (25 min) | **Dependencies:** None | **Acceptance Criteria:** Visiting `/my-hub` redirects to `/singer/login`; unauthenticated `/admin/users` redirects to `/admin-login`.

### [QW-06] Fix `Online Admins: 0` Telemetry & Remove Dev Test Bulletins (`test3433532`, `test test`)
- **Category:** Bug / Data Hygiene
- **Severity:** **P2**
- **Affected Files / Routes:** `controllers/activityController.js`, admin heartbeats, live/dev DB (`bulletins` table)
- **Root Cause:** Admin views omit active session presence registration or activity feed filters out current admin sessions (`Online Admins: 0` on `/admin/activity-logs`); legacy test rows sit published in bulletins.
- **Proposed Fix:** Register admin presence heartbeat/session count accurately in `activityController`; delete/archive `test3433532` and `test test` bulletins and `tester` synthetic records from shared dev DB.
- **Effort:** S (30 min) | **Dependencies:** None | **Acceptance Criteria:** Logged-in admin sees `Online Admins >= 1`; public bulletin feed displays zero `test*` titles.

---

## Phase 3: Polish Sprint (UI, UX, Data Integrity, Performance & Dependencies)

### [POL-01] Fix Dark-on-Dark Hero Action Buttons Across 3 Admin Views
- **Category:** Visual / Accessibility
- **Severity:** **P1**
- **Affected Files / Routes:** `public/css/admin.css`, `views/analytics.ejs`, `views/admin-users.ejs`, `views/activity-logs.ejs`
- **Root Cause:** Hero outline/ghost buttons inherit dark slate text color (`#374151`) inside dark indigo gradient cards (`.adm-hero-banner` / `.analytics-hero`).
- **Proposed Fix:** Scope `.adm-hero-dark .btn-outline` / hero secondary buttons explicitly to `#ffffff` ink, crisp `rgba(255,255,255,0.28)` border, `rgba(255,255,255,0.12)` hover surface, and remove inline button style overrides.
- **Effort:** S (45 min) | **Dependencies:** None | **Acceptance Criteria:** Contrast ratio >= 7:1 on `Singers`, `Dashboard`, and `Purge (>30d)` hero buttons at all breakpoints.

### [POL-02] Fix `admin-user-form.ejs` Broken Card Alignment & Card Horizontal Padding
- **Category:** Visual / Layout
- **Severity:** **P1**
- **Affected Files / Routes:** `views/admin-user-form.ejs:48,140`, `public/css/admin.css:1287-1290,3589-3617`, `views/admin-users.ejs:1`, `views/analytics.ejs:1`
- **Root Cause:** Card 1 omits `.admin-card` wrapper, line 140 has an extra `</div>` closing `.admin-form-wrapper` prematurely before `Security`, and CSS rules zero horizontal `.admin-card-body` padding or squeeze `.page-body:has(.session-unified-page)` to `6px` on mobile.
- **Proposed Fix:** Add `.admin-card` wrapper consistently to Card 1, remove stray `</div>` at line 140, restore uniform horizontal card/body tokens (`16px` mobile / `24px` desktop) across all `.admin-card-body` & `.page-body` layouts, and remove inline wrapper padding hacks.
- **Effort:** M (1.5 hours) | **Dependencies:** None | **Acceptance Criteria:** `Administrator Information` and `Security` cards share identical width, shadow, left alignment, and comfortable mobile/desktop padding.

### [POL-03] Unify Missing Count Logic (**421 vs 461**) & Fix Analytics Tempo Normalization
- **Category:** Bug / Data Integrity
- **Severity:** **P1**
- **Affected Files / Routes:** `utils/helpers.js` (`getCachedMissingCount`), `controllers/adminController.js:773-818` (`showMissingBhajans`), `controllers/analyticsController.js:241-265`
- **Root Cause:** `helpers.js` matches missing bhajans using normalized titles (`byNormTitle` -> `421`) while `showMissingBhajans` uses exact lowercase (`byExactLowerTitle` -> `461`). `analyticsController` only buckets exact `"slow"` and `"fast"`, dumping **129** `medium fast`/`medium slow`/`not specified` rows into `medium` (`693`), and displays rounded percentages summing to `101%`.
- **Proposed Fix:** Extract one shared `BhajanMatchService` used by both the sidebar badge cache and Missing Catcher page; map `tempoStats` into explicit buckets (`Slow`, `Medium Slow`, `Medium`, `Medium Fast`, `Fast`, `Unspecified`) with largest-remainder percentage rounding summing to `100%`; surface both normalized unique song count (`588`) and distinct title spellings (`603`) clearly.
- **Effort:** M (2 hours) | **Dependencies:** None | **Acceptance Criteria:** Sidebar badge matches Missing Catcher KPI count identically; Analytics tempo counts match raw SQLite groupings cleanly and sum to `100%`.

### [POL-04] Fix Admin Topbar Duplication/Wrapping, Bottom Sticky Clearance & Hardcoded Session Buttons
- **Category:** Visual / UX
- **Severity:** **P2**
- **Affected Files / Routes:** `views/partials/topbar.ejs`, `views/partials/sidebar.ejs:18`, `public/css/admin.css:738,812,2029-2056`, `views/admin-session-view.ejs`, `views/admin-dashboard.ejs`
- **Root Cause:** Desktop shows brand logo in both sidebar and topbar (`Bhajan\nPlanner` wraps onto 2 lines), `.topbar-left`/`.topbar-right` CSS selectors don't match `.native-top-left`/`.native-top-actions`, long admin names overflow, triple-bound sidebar toggle handlers duplicate events, bottom sticky `Admin` bar overlaps page content on 375px, and session actions use hardcoded `#3d35d8` / `#0f766e` styles.
- **Proposed Fix:** Hide duplicate brand mark inside topbar when desktop sidebar is expanded; style `.native-top-left`/`.native-top-actions` with `white-space: nowrap` and `max-width: 180px; text-overflow: ellipsis` on `.admin-name`; consolidate to a single delegated sidebar drawer handler; add `padding-bottom: calc(84px + env(safe-area-inset-bottom))` on mobile `.page-body`; replace inline button styles with unified theme classes.
- **Effort:** M (2–3 hours) | **Dependencies:** None | **Acceptance Criteria:** Zero brand wrapping, ellipsis truncation on long usernames, clean bottom clearance on November calendar & reports/singers at 375px.

### [POL-05] Fix Mobile Card Stacking, KPI Truncation, App Shell Transition & Touch Targets (>= 44px)
- **Category:** UX / Accessibility
- **Severity:** **P1–P2**
- **Affected Files / Routes:** `views/submit-form.ejs:282-318`, `views/admin-session-view.ejs`, `views/admin-rules.ejs`, `views/singers.ejs`, `views/master-bank.ejs`, `public/js/app-shell-router.js:979-1025`, `public/css/style.css`
- **Root Cause:** `.submitted-bhajans-card` overrides mobile card CSS; 375px 2-column KPI grid truncates all labels (`2 Bhajan... / PROGRAM S...`); `/admin/rules` hides column headers without showing card field names; `/master-bank` renders 144–148 buttons `<44px` and floating FAB overlaps Reset; direct navigation to detail views flashes stale header + `< Back Loading...`.
- **Proposed Fix:** Enable responsive `[data-label]` stacked cards inside `.submitted-bhajans-card` and `/admin/rules` mobile view; stack session KPI grid or expand typography sizing cleanly on 375px; expand interactive card targets/paddings cleanly to `min-height: 44px; min-width: 44px` via clickable `::after` hit slop where compact visuals are desired; allow horizontal scroll / wrap on `/admin/singers` filter chips; immediately update `#shellDetailTitle` cleanly on navigation with shimmer skeleton cards.
- **Effort:** L (4–6 hours) | **Dependencies:** None | **Acceptance Criteria:** Zero mid-word KPI/label truncation at 375px, `submit-form` table stacks cleanly into cards on mobile, Master Bank passes touch-target check without FAB overlap.

### [POL-06] Paginate `/master-bank` Data Payload & Add Diwali DB Indexes + Upgrade Dependencies
- **Category:** Performance / Security
- **Severity:** **P1**
- **Affected Files / Routes:** `controllers/masterBankController.js`, `views/master-bank.ejs:639`, `public/css/*.css`, `databaseInitializer.js`, `package.json`
- **Root Cause:** `/master-bank` embeds ~670 KB inline catalog JSON in initial HTML; 10+ synchronous `<head>` stylesheets push Live Mobile LCP to `4.3–4.5s`; zero indexes exist on the 5 Diwali tables; `npm audit` flags 17 vulns (`1 critical` `tar` via `sqlite3`, `6 high` including `multer`, `body-parser`).
- **Proposed Fix:**
  1. Server-render initial page slice (24 cards, <60 KB HTML) and fetch/cache compact indexed JSON (`/api/master-bhajans/catalog.json` with ETag & `max-age` caching) or move search API-side.
  2. Add `CREATE INDEX IF NOT EXISTS` statements for foreign keys/lookup columns (`event_id`, `singer_name`, `gender`, `sequence_id`, `status`) on all 5 Diwali tables.
  3. Update `multer`, `body-parser`, `qs`, `express`/`sqlite3` prebuilt binaries cleanly, verify app startup, and split non-critical CSS (`media="print" onload` or single bundled asset).
  4. Re-save `/images/icons/dev/` legacy alias or 301 redirect if referenced anywhere, and allow Google GSI origin config cleanly for localhost dev.
- **Effort:** L (5 hours) | **Dependencies:** None | **Acceptance Criteria:** `/master-bank` HTML < 100 KB, Live Mobile LCP < 2.5s, Lighthouse Perf >= 90, `npm audit` critical/high = 0.

---

## Phase 4: Production Hardening, Uncovered Admin Fixes & Coordinator Workflows

> **Why Re-Structured:** Auditing the remaining 35 admin/Diwali/secondary endpoints and inspecting `git log origin/develop..origin/main --oneline` revealed that (1) **`origin/main` already built the dedicated server-side session PDF generator (`bcd49b0`..`5db8435`)**, (2) secondary admin routes have newly discovered **validation bugs (`POST /admin/edit/:id` -> `/admin/date/undefined`), ~2.0 MB unbounded HTML payloads (`/admin/archived-master-bhajans`), and missing form labels/CSRF inputs**, and (3) Phase 3's async `/master-bank` JSON endpoint and online `npm audit` upgrades still remain. Phase 4 is therefore structured into three sequential waves (**4A Hardening -> 4B Workflows -> 4C Offline PWA**), with **`[DEBT-01]` (`main` <-> `develop` sync) running immediately prior to Wave 4B** so we never rebuild PDFs from scratch.

### Wave 4A — Admin Validation, Payload Reduction & Production Release Readiness

#### [HARD-01] Admin Edit Submission Validation, Session Date Guard & Styled `403` RBAC (`ADMIN-01`)
- **Category:** Bug / Security | **Impact:** **P1** | **Effort:** S (1.5 hrs) | **Dependencies:** None
- **Affected Files / Routes:** `controllers/adminController.js:231-240,426-449`, `middleware/auth.js` (`requireSuperAdmin`), `services/validators.js`
- **Root Cause:** `POST /admin/edit/:id` updates `BhajanSubmission` without validating `session_date`, required fields, or row existence (omitting `session_date` redirects `302 -> /admin/date/undefined`). `GET /admin/date/:date` accepts invalid strings (`not-a-date`), logging Moment/Sequelize fallback warnings and rendering `200 OK`. `requireSuperAdmin` returns raw plain text `403` to browsers.
- **Proposed Fix:** Validate `req.params.date` against `/^\d{4}-\d{2}-\d{2}$/` cleanly (`400` rendered in admin error template); validate `POST /admin/edit/:id` through a `validateAdminSubmissionEdit` validator, check row existence (`404`), preserve existing `session_date` when unchanged, and render a styled admin `403` page for HTML navigation on `requireSuperAdmin`.
- **Acceptance Criteria:** `POST /admin/edit/:id` with invalid date/fields returns `400` or falls back cleanly; `/admin/date/not-a-date` returns `400` with zero Moment warnings; standard `admin` (`prashant16`) sees clean branded `403`.

#### [HARD-02] Paginate Heavy Admin Tables (**2.0 MB Archived Master**) & Complete `/master-bank` Async Split (`POL-06` + `ADMIN-02`)
- **Category:** Performance | **Impact:** **P1** | **Effort:** M (4 hrs) | **Dependencies:** None
- **Affected Files / Routes:** `controllers/masterBankController.js:206-244`, `views/admin-archived-master.ejs`, `controllers/activityController.js`, `views/activity-logs.ejs`, `views/admin-missing-bhajans.ejs`, `views/singers.ejs`, `views/master-bank.ejs`
- **Root Cause:** `/admin/archived-master-bhajans` renders every inactive song server-side (`1,990,093 B` HTML, `7,966` inline styles); `/admin/activity-logs` renders `422 KB` HTML (`2,287` inline styles) + `131 KB` `/api/admin/activity-feed` JSON; `/admin/missing-bhajans` (`314 KB`) and `/admin/singers` (`214 KB`) ship unbounded rows; `/master-bank` still embeds catalog metadata inline.
- **Proposed Fix:** Server-paginate `/admin/archived-master-bhajans`, `/admin/activity-logs` (+ `/api/admin/activity-feed` `limit=50&cursor=...`), `/admin/missing-bhajans`, and `/admin/singers` (50 rows/page + server-side search query), replace per-row inline style attributes with semantic `.adm-` classes, and move `/master-bank` full catalog JSON to an ETag-cached `/api/master-bhajans/catalog.json` fetch while deferring non-critical `<head>` CSS.
- **Acceptance Criteria:** `/admin/archived-master-bhajans` & `/admin/activity-logs` responses drop below `120 KB`; `/master-bank` HTML `< 100 KB`; Live Mobile Lighthouse Perf >= `90`.

#### [HARD-03] Secondary Admin Form Accessibility (`for`/`id`), Page Landmarks & Server `_csrf` Hygiene (`ADMIN-02`)
- **Category:** Accessibility / Security Hygiene | **Impact:** **P2** | **Effort:** M (2.5 hrs) | **Dependencies:** None
- **Affected Files / Routes:** `views/admin-edit-submission.ejs`, `views/admin-user-form.ejs`, `views/admin-user-reset-password.ejs`, `views/admin-dashboard.ejs`, `views/admin-session-view.ejs`, `views/admin-rules.ejs`, `views/admin-missing-bhajans.ejs`, `views/admin-notifications.ejs`, `views/admin-import-sessions.ejs`, `views/admin-bulletins*.ejs`, `views/diwali/*.ejs`
- **Root Cause:** Automated DOM sweep found unlabeled inputs across modal & CRUD forms (`display_name`, `username`, `role`, `password`, `singer_name`, `mbTitle`, `custTitle`, `raw_text`, Diwali filters), missing `<h1>` landmarks on 7 sub-pages, generic `<title>Bhajan Planner</title>` on 3 admin routes, and 10 `<form method="POST">` blocks omitting server `<input type="hidden" name="_csrf">` (relying solely on `script.js` client injection).
- **Proposed Fix:** Wire explicit `<label for="...">` + matching `id` on all form fields, add concise page `<title>` & visible `<h1>` landmarks, and insert `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` inside all remaining admin/Diwali POST forms.
- **Acceptance Criteria:** Automated route DOM check finds `0` unlabeled form inputs, `0` POST forms without server `_csrf`, and valid `<h1>` + page `<title>` across all 35 admin routes.

#### [HARD-04] Upgrade Vulnerable `npm` Dependencies, Fix Dev Icon Redirect & Deploy Local Fixes to Live Railway (`SEC-02`)
- **Category:** Security / Ops | **Impact:** **P1** | **Effort:** S (1.5 hrs) | **Dependencies:** `HARD-01..03`
- **Affected Files / Routes:** `package.json`, `package-lock.json`, `app.js`, Railway deployment (`develop`), local vs Railway admin user alignment
- **Root Cause:** Offline sandbox prevented `npm update` (`1 critical` `tar` via `sqlite3`, `6 high` including `multer`, `body-parser`, `node-gyp`). Phases 1–3 fixes currently live only locally (not pushed/deployed to `bhajanschedular-development.up.railway.app`); legacy `/images/icons/dev/` alias & `GOOGLE_CLIENT_ID` localhost dev origin remain unconfigured; `mobtest` returned `401` on Live.
- **Proposed Fix:** Run online `npm audit fix` / prebuilt binary upgrades (`sqlite3`, `multer`, `body-parser`, `qs`, `exceljs`, `connect-session-sequelize`) + verify `npm test`; add 301 fallback if any bookmark hits legacy `/images/icons/bhajan-planner-dev-192.png` and gate GSI client init on authorized origins; push verified changes to `develop` & confirm Live deployment + pre-deploy SQLite `.backup`.
- **Acceptance Criteria:** `npm audit` critical & high = `0`; `53+` tests pass; Live `https://bhajanschedular-development.up.railway.app/` serves patched `/plan-view`, `/admin`, and `/master-bank`.

---

### Wave 4B — Coordinator & Devotional Workflow Features *(Execute AFTER Wave 5A `DEBT-01` Sync)*

#### [FEAT-01] Polish & Extend Synced Thursday Program Sheet PDF (`origin/main` Baseline)
- **Category:** Feature | **Impact:** **P2** | **Effort:** S (2 hrs, reduced from 4 hrs via `DEBT-01`) | **Dependencies:** Wave 5A (`DEBT-01` cherry-picking `bcd49b0`..`5db8435`)
- **Proposal:** Rather than building PDF generation from scratch, inherit the handcrafted portrait Thursday & landscape Diwali PDF controller/layout already live on `origin/main` (`e61e170`..`5db8435`), fix any mobile preview edge cases, and include tempo + harmonium/tabla cues & clean empty-slot formatting cleanly on 1 A4 page.
- **Acceptance Criteria:** Live Plan & Admin Session print/download routes produce crisp single-page portrait Thursday sheets with SSSO header, sequence #, deity badge, scale, tempo, and accompanist cues.

#### [FEAT-02] Automated Thursday Submission Reminders & `.ics` Calendar Invite
- **Category:** Feature | **Impact:** **P2** | **Effort:** M (4 hrs) | **Dependencies:** `notifications.js`, Wave 4A Live deploy
- **Proposal:** Add `/plan-view/session.ics` calendar download, 1-click "Share Open Slot Reminder to WhatsApp Group" preformatted copy in Admin Dashboard, and scheduled Web Push cutoff alert on Wednesday evening / Thursday morning.
- **Acceptance Criteria:** Coordinator copies formatted WhatsApp slot announcement in 1 tap; calendar `.ics` opens cleanly on iOS/Android; push subscribers receive weekly cutoff alert.

#### [FEAT-03] Smart Repertoire Cooldown Warnings & Singer Availability Matrix
- **Category:** Feature | **Impact:** **P2** | **Effort:** M (5 hrs) | **Dependencies:** `POL-03` (`BhajanMatchService`)
- **Proposal:** Highlight singers who led in the last consecutive Thursday vs those awaiting a turn, warn on back-to-back same-singer slots or duplicate ragas on `/admin/date/:date`, and let singers toggle upcoming Thursday `"Available / Traveling"` flags inside `/my-hub`.
- **Acceptance Criteria:** Admin session sequencer displays live rotation/cooldown warning pills and excludes traveling singers when filling open slots.

#### [FEAT-04] Bulk CSV/XLSX Roster & Master Bank Import/Export + Singer Gender Completion Flow
- **Category:** Feature | **Impact:** **P2** | **Effort:** M (4 hrs) | **Dependencies:** `HARD-02`
- **Proposal:** Provide clean CSV/XLSX bulk import/export templates for Singers Directory & Master Bhajan Bank plus a quick inline completion flow to fill missing Gender metadata on the **27 of 37** singers (`73%`) without editing records one by one.
- **Acceptance Criteria:** Coordinators can bulk-update singer gender/default pitch in under 2 minutes; Singers Directory reaches ~100% gender completeness cleanly.

---

### Wave 4C — Offline Mandir Hall Readiness

#### [FEAT-05] Full Offline PWA Mode (Cached Lineup, Master Bank & Singer Songbook)
- **Category:** Feature / Native Polish | **Impact:** **P2** | **Effort:** M (5 hrs) | **Dependencies:** `HARD-02` (`/api/master-bhajans/catalog.json`), `sw.js`
- **Proposal:** Cache `/`, `/plan-view`, active weekly lineup JSON, Singer's bookmarked Songbook, and compressed catalog JSON in CacheStorage / IndexedDB via `sw.js` stale-while-revalidate so Mandir halls with weak cellular reception load lyrics, scales, and Thursday order instantaneously.
- **Acceptance Criteria:** Enabling DevTools Offline renders `/`, active Thursday lineup, and Master Bank search/lyrics cleanly without network error screens.

---

## Phase 5: Branch Reconciliation & Long-Term Architectural Refactors

> **Execution Sequence Rationale:** **`[DEBT-01]` (`origin/main` <-> `origin/develop` sync) moves to the front of the architectural queue (Wave 5A)** ahead of Wave 4B features and Waves 5B–5D refactors because `origin/main` contains **33 unmerged commits** modifying sidebar partials, Diwali views, and print/PDF controllers. Reconciling first prevents double work and eliminates merge conflicts during partial/CSS extraction.

### Wave 5A — `[DEBT-01]` Reconcile `origin/develop` with `origin/main` (33 Commits)
- **Category:** Debt / Release Alignment | **Severity:** **P1** | **Effort:** M (3 hrs) | **Dependencies:** Wave 4A clean baseline commit
- **Verified Commit Batches (`git log origin/develop..origin/main --oneline`):**
  1. **Chrome, Nav & Copy Fixes (4 commits):** `e5177b1`, `1ded466`, `aff0eed`, `44d3436` (mobile bottom nav + SSSSO acronym fixes) + `4504eda`, `d007d06` (bulletin previews).
  2. **Claude-Style Admin Sidebar (`1 commit`):** `96008e0` (hover/pin desktop sidebar — merge carefully around `POL-04` topbar dedup & single drawer toggle).
  3. **Diwali Module Upgrades (11 commits):** `9b3531b`..`67acd1b` (drag-and-drop sequence editor, musician assignments, manual builder, delete sequence, CSRF expiry & SQLite lock hardening).
  4. **Dedicated Server-Side PDF Export (15 commits):** `4237b8e`..`5db8435` (handcrafted Thursday portrait PDF + landscape 100th-birthday Diwali PDF + Live Plan print routing).
- **Guardrails:** Explicitly preserve `develop`'s `manifest.dev.json` / `/images/icons/dev/` branding isolation and all Phases 1–4A fixes (`tests/*.test.js` must remain `100%` green after each batch).

### Wave 5B — `[DEBT-02]` Migrate Server-Side HTML Concatenation to EJS Partials
- **Category:** Debt | **Severity:** **P2** | **Effort:** L (6 hrs) | **Dependencies:** Wave 5A (`DEBT-01`), `FIX-P0-01`
- **Affected Files:** `controllers/plannerController.js:705-853`, `services/plannerService.js`, `views/partials/`
- **Proposed Fix:** Extract timeline cards, plan table rows, and remaining HTML concatenation fragments into reusable `views/partials/plan-timeline.ejs` and `views/partials/plan-table.ejs` templates, eliminating manual `escapeHtml` drift and unifying mobile responsive classes.

### Wave 5C — `[DEBT-03]` CSS Cascade Layers (`@layer`), `.adm-` Token Isolation & Style-Bloat Elimination
- **Category:** Debt / Visual Maintainability | **Severity:** **P2** | **Effort:** L (8 hrs) | **Dependencies:** `HARD-02`, Wave 5A/5B
- **Affected Files:** `public/css/style.css`, `public/css/admin.css`, `views/admin-*.ejs`
- **Proposed Fix:** Introduce CSS cascade layers (`@layer reset, base, layout, components, utilities`), isolate all admin styling cleanly under `.adm-` tokens, delete unused `.topbar-left`/`.topbar-right` rules, finish converting the ~**12,200** table/card inline `style=` attributes measured across `/admin/archived-master-bhajans` (**7,966**), `/admin/activity-logs` (**2,287**), `/admin/missing-bhajans` (**1,350**), and `/admin/singers` (**669**) into utility/component classes, and add a Stylelint/CI ratchet capping and monotonically reducing the **3,025** `!important` declarations.

### Wave 5D — `[DEBT-04]` Expand & Commit CI Regression Gate (Supertest + Playwright E2E)
- **Category:** Debt / Quality Engineering | **Severity:** **P2** | **Effort:** M (4 hrs, reduced from 5 hrs — **53/53 unit/integration tests already running locally in `tests/`**) | **Dependencies:** None (incremental alongside Waves 4A–5C)
- **Proposed Fix:** Remove `tests/` exclusion (or `git add -f tests/*.test.js`) so the 8 existing test files (**53 tests**: `auth`, `bhajanSubmission`, `enterpriseOverhaul`, `healthz`, `nativeLayer`, `pinLockout`, `pwaVariant`, `implementationFixes`) are version-controlled; add `HARD-01` (`POST /admin/edit/:id`, `/admin/date/:date` invalid format) and `HARD-02` pagination assertions; add a headless Playwright desktop+mobile layout smoke script (`375px` & `1440px` `overflow === 0`, console errors `=== 0`, admin route `200`/`403` verification) wired into GitHub Actions on PRs to `develop` & `main`.

---

## Recommended Execution Order Summary

1. **Wave 4A (`HARD-01` -> `HARD-04`)** — Fix `POST /admin/edit/:id` & date guard, paginate `1.99 MB` archived master / `422 KB` activity logs, fix secondary admin form A11y/`_csrf`, upgrade `npm audit` deps, and deploy Phases 1–4A to Railway `develop`. *(Score -> ~89/100 live)*
2. **Wave 5A (`DEBT-01`)** — Cherry-pick the 33 commits from `origin/main` in 4 tested batches, immediately unlocking PDF export & Claude sidebar before building new features. *(Score -> ~90/100)*
3. **Wave 4B (`FEAT-01` -> `FEAT-04`)** — Polish synced Thursday PDFs, WhatsApp + `.ics` reminders, rotation cooldown warnings, and bulk roster/gender sync. *(Score -> ~92/100)*
4. **Wave 4C (`FEAT-05`)** — Full offline Service Worker catalog & songbook caching for basement Mandir halls. *(Score -> ~94/100)*
5. **Waves 5B -> 5D (`DEBT-02` -> `DEBT-04`)** — EJS partial extraction, CSS `@layer` + `!important`/inline-style cleanup, and full CI Playwright + Supertest gate. *(Score -> **96 / 100**)*

