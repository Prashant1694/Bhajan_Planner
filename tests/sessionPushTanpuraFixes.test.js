const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");
const webpush = require("web-push");

const { setupTestDb, sequelize } = require("./setup");

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:test@example.com";
}

test.before(async () => {
  await setupTestDb();
});

const { app, sessionStore } = require("../app");
const { ADMIN_IDLE_MAX_MS, invalidateAdminCache } = require("../middleware/auth");
const notificationService = require("../services/notificationService");
const PushSubscription = require("../models/PushSubscription");

const ROOT = path.join(__dirname, "..");

function extractCsrfFromHtml(html) {
  const metaMatch = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/);
  if (metaMatch) return metaMatch[1];
  const inputMatch = html.match(/name=["']_csrf["']\s+value=["']([^"']+)["']/);
  if (inputMatch) return inputMatch[1];
  const scriptMatch = html.match(/['"]csrf-token['"]\s*:\s*['"]([^'"]+)['"]/);
  return scriptMatch ? scriptMatch[1] : "";
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  return haystack.split(needle).length - 1;
}

// =========================================================================
// 1. ADMIN 90-DAY PERSISTENT AUTHENTICATION
// =========================================================================

test("Admin auth: ADMIN_IDLE_MAX_MS defaults to 90 days", () => {
  assert.strictEqual(ADMIN_IDLE_MAX_MS, 90 * 24 * 60 * 60 * 1000);
});

test("Admin auth: session cookie has ~90d validity and persists in SQLite Sessions store", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/admin-login");
  assert.strictEqual(loginPage.status, 200);
  const csrf = extractCsrfFromHtml(loginPage.text);
  assert.ok(csrf, "CSRF token should be present on /admin-login");

  const username = process.env.SUPER_ADMIN_USER || "testadmin";
  const password = process.env.SUPER_ADMIN_PASS || "TestAdmin#12345";

  const loginRes = await agent
    .post("/admin-login")
    .type("form")
    .send({ username, password, _csrf: csrf });

  assert.strictEqual(loginRes.status, 200);
  assert.ok(loginRes.text.includes("window.location.href = '/admin'"));

  const setCookies = loginRes.headers["set-cookie"] || [];
  const sidCookie = setCookies.find((c) => c.startsWith("connect.sid="));
  assert.ok(sidCookie, "connect.sid session cookie should be set on admin login");
  assert.ok(/HttpOnly/i.test(sidCookie), "connect.sid cookie must be HttpOnly");

  const expiresMatch = sidCookie.match(/Expires=([^;]+)/i);
  const maxAgeMatch = sidCookie.match(/Max-Age=(\d+)/i);
  assert.ok(expiresMatch || maxAgeMatch, "connect.sid cookie should include persistent Expires or Max-Age");
  if (maxAgeMatch) {
    const maxAgeSec = Number(maxAgeMatch[1]);
    assert.ok(maxAgeSec >= 89 * 24 * 60 * 60, `Expected ~90d Max-Age, got ${maxAgeSec}s`);
  }
  if (expiresMatch) {
    const expiresMs = Date.parse(expiresMatch[1]) - Date.now();
    assert.ok(expiresMs >= 89 * 24 * 60 * 60 * 1000, "Expires timestamp should be ~90 days ahead");
  }

  // Verify dashboard works normally
  const adminRes1 = await agent.get("/admin");
  assert.strictEqual(adminRes1.status, 200);

  // Simulate restart: clear in-memory admin cache & replay raw cookie via stateless client
  invalidateAdminCache();
  const cookieHeader = sidCookie.split(";")[0];

  const [sessionRows] = await sequelize.query(
    "SELECT sid, expires, data FROM Sessions WHERE data LIKE '%adminLastActive%'"
  );
  assert.ok(sessionRows.length >= 1, "Admin session must be persisted inside SQLite Sessions table");

  const rawSid = decodeURIComponent(cookieHeader.replace(/^connect\.sid=/, ""))
    .replace(/^s:/, "")
    .split(".")[0];
  const storedSession = await new Promise((resolve, reject) => {
    sessionStore.get(rawSid, (err, sess) => (err ? reject(err) : resolve(sess)));
  });
  assert.ok(storedSession && storedSession.admin, "sessionStore.get must restore admin session");

  const adminResReplay = await request(app).get("/admin").set("Cookie", cookieHeader);
  assert.strictEqual(adminResReplay.status, 200);

  // Backdate adminLastActive by 30 days (< 90d): session MUST remain valid
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const targetRow = sessionRows.find((r) => r.sid === rawSid);
  assert.ok(targetRow, "Persisted row for active admin sid must exist");
  const parsed30 = JSON.parse(targetRow.data);
  parsed30.adminLastActive = thirtyDaysAgo;
  await sequelize.query("UPDATE Sessions SET data = ? WHERE sid = ?", {
    replacements: [JSON.stringify(parsed30), rawSid]
  });

  const adminAfter30Days = await request(app).get("/admin").set("Cookie", cookieHeader);
  assert.strictEqual(
    adminAfter30Days.status,
    200,
    "Admin must remain logged in after 30 days within 90-day validity"
  );

  // Backdate adminLastActive by 91 days (> 90d): session MUST expire
  const ninetyOneDaysAgo = Date.now() - 91 * 24 * 60 * 60 * 1000;
  const parsed91 = JSON.parse(targetRow.data);
  parsed91.adminLastActive = ninetyOneDaysAgo;
  await sequelize.query("UPDATE Sessions SET data = ? WHERE sid = ?", {
    replacements: [JSON.stringify(parsed91), rawSid]
  });

  const adminAfter91Days = await request(app).get("/admin").set("Cookie", cookieHeader);
  assert.strictEqual(adminAfter91Days.status, 302);
  assert.strictEqual(adminAfter91Days.headers.location, "/admin-login");

  // Re-login and verify explicit POST /logout terminates admin session
  const agent2 = request.agent(app);
  const lp2 = await agent2.get("/admin-login");
  const csrf2 = extractCsrfFromHtml(lp2.text);
  const loginRes2 = await agent2
    .post("/admin-login")
    .type("form")
    .send({ username, password, _csrf: csrf2 });
  assert.strictEqual(loginRes2.status, 200);

  const dashRes = await agent2.get("/admin");
  assert.strictEqual(dashRes.status, 200);
  const logoutCsrf = extractCsrfFromHtml(dashRes.text);

  const logoutRes = await agent2.post("/logout").set("X-CSRF-Token", logoutCsrf).send({});
  assert.strictEqual(logoutRes.status, 200);
  assert.ok(logoutRes.text.includes("Logging out..."));

  const afterLogout = await agent2.get("/admin");
  assert.strictEqual(afterLogout.status, 302);
  assert.strictEqual(afterLogout.headers.location, "/admin-login");
});

test("Admin auth & DB hardening: proxy, WAL FULL sync, shutdown checkpoint & busy resilience", () => {
  const appSrc = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const dbSrc = fs.readFileSync(path.join(ROOT, "config", "database.js"), "utf8");
  const authSrc = fs.readFileSync(path.join(ROOT, "middleware", "auth.js"), "utf8");
  const schedulerSrc = fs.readFileSync(path.join(ROOT, "services", "sessionScheduler.js"), "utf8");

  assert.match(appSrc, /proxy:\s*true/);
  assert.match(appSrc, /sessionStoreReady\s*=\s*sessionStore\.sync\(\)/);
  assert.match(appSrc, /stopSessionScheduler\(\)/);
  assert.match(appSrc, /closeIdleConnections/);
  assert.match(appSrc, /PRAGMA wal_checkpoint\(TRUNCATE\)/);

  assert.match(dbSrc, /PRAGMA synchronous = FULL/);
  assert.match(dbSrc, /PRAGMA wal_autocheckpoint/);

  assert.match(authSrc, /isTransientLock/);
  assert.match(schedulerSrc, /\.unref\(\)/);
});

// =========================================================================
// 2. NATIVE WEB PUSH NOTIFICATIONS
// =========================================================================

test("Push unit: isNativePushSubscription & buildPushPayload format", () => {
  assert.strictEqual(
    notificationService.isNativePushSubscription({
      endpoint: "in_app_dev-1",
      p256dh: "",
      auth: ""
    }),
    false
  );
  assert.strictEqual(
    notificationService.isNativePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "BKey123",
      auth: "Auth456"
    }),
    true
  );

  const raw = notificationService.buildPushPayload({
    id: 77,
    type: "session",
    title: "Evening Bhajan",
    body: "Starts at 6:30 PM",
    link: "/planner"
  });
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.title, "Evening Bhajan");
  assert.strictEqual(parsed.body, "Starts at 6:30 PM");
  assert.strictEqual(parsed.url, "/planner");
  assert.ok(parsed.icon);
  assert.ok(parsed.badge);
  assert.strictEqual(parsed.tag, "bp-notif-77");
  assert.strictEqual(typeof parsed.timestamp, "number");
});

test("Push lifecycle: subscribe upgrades cleanly, resists in_app downgrade, sends high-urgency webpush & cleans up 410", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/singer/login");
  const csrf = extractCsrfFromHtml(loginPage.text);

  const singerLogin = await agent
    .post("/api/singer/login")
    .set("X-CSRF-Token", csrf)
    .send({ singer_id: 1, pin: "1234" });
  assert.strictEqual(singerLogin.status, 200);

  const deviceId = `test-device-${Date.now()}`;

  const statusBefore = await agent.get(
    `/api/notifications/subscription-status?device_id=${encodeURIComponent(deviceId)}`
  );
  assert.strictEqual(statusBefore.status, 200);
  assert.strictEqual(statusBefore.body.subscribed, false);
  assert.strictEqual(statusBefore.body.hasNativePush, false);
  assert.strictEqual(statusBefore.body.vapidConfigured, true);
  assert.strictEqual(statusBefore.body.hasSessionSinger, true);

  // Register in-app fallback first
  const inAppSub = await agent
    .post("/api/notifications/subscribe")
    .set("X-CSRF-Token", csrf)
    .send({ device_id: deviceId, subscription: null });
  assert.strictEqual(inAppSub.status, 200);
  assert.strictEqual(inAppSub.body.hasNativePush, false);

  // Upgrade to native Web Push keys
  const nativeSubPayload = {
    endpoint: `https://fcm.googleapis.com/fcm/send/token-${Date.now()}`,
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg"
    }
  };
  const nativeSub = await agent
    .post("/api/notifications/subscribe")
    .set("X-CSRF-Token", csrf)
    .send({ device_id: deviceId, subscription: nativeSubPayload });
  assert.strictEqual(nativeSub.status, 200);
  assert.strictEqual(nativeSub.body.success, true);
  assert.strictEqual(nativeSub.body.hasNativePush, true);

  // Subsequent null subscription call must NOT downgrade existing native push
  const attemptedDowngrade = await agent
    .post("/api/notifications/subscribe")
    .set("X-CSRF-Token", csrf)
    .send({ device_id: deviceId, subscription: null });
  assert.strictEqual(attemptedDowngrade.status, 200);
  assert.strictEqual(attemptedDowngrade.body.hasNativePush, true);

  const row = await PushSubscription.findOne({ where: { device_id: deviceId } });
  assert.ok(row);
  assert.strictEqual(row.endpoint, nativeSubPayload.endpoint);
  assert.strictEqual(row.p256dh, nativeSubPayload.keys.p256dh);

  // Intercept webpush.sendNotification cleanly to verify options & delivery
  const origSend = webpush.sendNotification;
  const calls = [];
  webpush.sendNotification = async (sub, payload, options) => {
    calls.push({ sub, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  };

  try {
    const testDeviceRes = await agent
      .post("/api/notifications/test-device")
      .set("X-CSRF-Token", csrf)
      .send({ device_id: deviceId });

    assert.strictEqual(testDeviceRes.status, 200);
    assert.strictEqual(testDeviceRes.body.success, true);
    assert.strictEqual(testDeviceRes.body.status, "sent");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].sub.endpoint, nativeSubPayload.endpoint);
    assert.deepStrictEqual(calls[0].options, { TTL: 86400, urgency: "high" });
    assert.strictEqual(calls[0].payload.title, "Bhajan Planner");

    // Expired subscription (HTTP 410 Gone) should auto-remove dead row
    webpush.sendNotification = async () => {
      const err = new Error("Gone");
      err.statusCode = 410;
      throw err;
    };
    const goneRes = await notificationService.sendPushToDevice(deviceId, {
      id: 99,
      title: "Test Gone",
      body: "Expired",
      link: "/"
    });
    assert.strictEqual(goneRes.status, "gone");

    const afterGone = await PushSubscription.findOne({ where: { device_id: deviceId } });
    assert.strictEqual(afterGone, null, "Expired 410 push subscription must be deleted");
  } finally {
    webpush.sendNotification = origSend;
  }
});

test("Push frontend & SW static guarantees", () => {
  const swSrc = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
  const notifJs = fs.readFileSync(path.join(ROOT, "public", "js", "notifications.js"), "utf8");
  const pwaJs = fs.readFileSync(path.join(ROOT, "public", "js", "pwa.js"), "utf8");
  const reportsEjs = fs.readFileSync(path.join(ROOT, "views", "user-reports.ejs"), "utf8");

  assert.match(swSrc, /urlBase64ToUint8Array/);
  assert.match(swSrc, /addEventListener\(["']push["']/);
  assert.match(swSrc, /addEventListener\(["']notificationclick["']/);
  assert.match(swSrc, /addEventListener\(["']pushsubscriptionchange["']/);
  assert.match(swSrc, /BP_PUSH_RECEIVED/);
  assert.ok(swSrc.includes("/css/native.css?v=6.7"));
  assert.ok(swSrc.includes("/js/native-ui.js?v=6.5"));

  assert.match(notifJs, /window\.BPPush\s*=/);
  assert.match(notifJs, /BP_PUSH_SUBSCRIPTION_CHANGED/);
  assert.match(notifJs, /BP_PUSH_RECEIVED/);
  assert.match(notifJs, /Notification\.requestPermission\(\)/);

  assert.match(pwaJs, /window\.BPWaitForServiceWorker/);
  assert.ok(reportsEjs.includes("(function () {"), "user-reports script should be wrapped in an IIFE");
  assert.ok(
    reportsEjs.includes("window.lookupTicket = lookupTicket;"),
    "user-reports should expose lookupTicket cleanly on window"
  );
});

// =========================================================================
// 3. TANPURA PERSISTENT DRONE STATE & SINGLE SHELL WIDGET
// =========================================================================

test("Tanpura SSR: app-shell routes render strictly one tanpuraFloatingWidget", async () => {
  const agent = request.agent(app);
  const singerLoginPage = await agent.get("/singer/login");
  const singerCsrf = extractCsrfFromHtml(singerLoginPage.text);
  const singerAuthRes = await agent
    .post("/api/singer/login")
    .set("X-CSRF-Token", singerCsrf)
    .send({ singer_id: 1, pin: "1234" });
  assert.strictEqual(singerAuthRes.status, 200);

  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    for (const routePath of ["/", "/submit-form", "/master-bank", "/notification-settings"]) {
      const res = await agent.get(routePath).set("Accept", "text/html");
      assert.strictEqual(res.status, 200, `${routePath} should return 200`);
      assert.ok(
        res.text.includes("window.__SHELL_BOOT__"),
        `${routePath} should render wrapped inside app-shell.ejs`
      );
      const count = countOccurrences(res.text, 'id="tanpuraFloatingWidget"');
      assert.strictEqual(
        count,
        1,
        `Expected exactly 1 tanpuraFloatingWidget on ${routePath}, found ${count}`
      );
    }

    const fragRes = await agent.get("/master-bank").set("X-App-Shell", "1");
    assert.strictEqual(fragRes.status, 200);
    assert.strictEqual(
      countOccurrences(fragRes.text, 'id="tanpuraFloatingWidget"'),
      0,
      "Shell fragment fetch must not embed duplicate tanpuraFloatingWidget"
    );
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("Tanpura client architecture: singleton, router deduplication, CSS visibility & sync", () => {
  const tanpuraJs = fs.readFileSync(path.join(ROOT, "public", "js", "tanpura.js"), "utf8");
  const routerJs = fs.readFileSync(path.join(ROOT, "public", "js", "app-shell-router.js"), "utf8");
  const shellCss = fs.readFileSync(path.join(ROOT, "public", "css", "app-shell.css"), "utf8");
  const widgetEjs = fs.readFileSync(path.join(ROOT, "views", "partials", "tanpura-widget.ejs"), "utf8");

  assert.match(tanpuraJs, /__initialized/);
  assert.match(tanpuraJs, /transitionSeq/);
  assert.match(tanpuraJs, /getPrimaryWidget/);
  assert.match(tanpuraJs, /bp_tanpura_prefs/);

  assert.match(shellCss, /:not\(\.visible\):not\(\.is-playing\)/);
  assert.match(widgetEjs, /tanpuraBound/);
  assert.match(widgetEjs, /clampTanpuraPosition/);

  assert.ok(
    countOccurrences(routerJs, 'querySelectorAll("#tanpuraFloatingWidget")') >= 3,
    "Router must strip stray #tanpuraFloatingWidget across fragment fetch, revalidate and prefetch"
  );
  assert.match(routerJs, /executeContainerScripts/);
  assert.match(routerJs, /syncContextualWidgets\(\)/);
});
