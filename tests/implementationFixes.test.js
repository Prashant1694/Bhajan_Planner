const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb } = require("./setup");

let app;
let BhajanSubmission;
let SessionPermission;
let helpers;

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  BhajanSubmission = require("../models/BhajanSubmission");
  SessionPermission = require("../models/SessionPermission");
  helpers = require("../services/helpers");
});

function extractCsrf(html) {
  const metaMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch) return metaMatch[1];
  const inputMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return inputMatch ? inputMatch[1] : "";
}

async function loginAsSuperAdmin() {
  const agent = request.agent(app);
  const loginGet = await agent.get("/admin-login");
  const csrf = extractCsrf(loginGet.text);
  const postRes = await agent
    .post("/admin-login")
    .type("form")
    .send({
      username: process.env.SUPER_ADMIN_USER || "testadmin",
      password: process.env.SUPER_ADMIN_PASS || "TestAdmin#12345",
      _csrf: csrf
    });
  assert.strictEqual(postRes.status, 200);
  assert.ok(postRes.text.includes("window.location.href = '/admin'"), "Super admin login must succeed");
  return agent;
}

test("P0-01: /plan-view rejects invalid session_date XSS payload and escapes safeJson", async () => {
  const res = await request(app).get(
    '/plan-view?session_date="><script>window.__xss=1</script>'
  );
  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes("window.__xss=1"), "XSS payload must not be reflected");
  assert.strictEqual(
    helpers.safeJson('</script><script>alert("x")&'),
    '"\\u003c/script\\u003e\\u003cscript\\u003ealert(\\"x\\")\\u0026"'
  );
});

test("P0-01 / QW-01 / QW-03: /admin-login has hidden CSRF field, label fixes on forgot-password & reports", async () => {
  const loginRes = await request(app).get("/admin-login");
  assert.strictEqual(loginRes.status, 200);
  assert.ok(/<input[^>]+type="hidden"[^>]+name="_csrf"/i.test(loginRes.text));

  const forgotRes = await request(app).get("/forgot-password");
  assert.strictEqual(forgotRes.status, 200);
  assert.ok(forgotRes.text.includes('for="forgotUsername"'));
  assert.ok(forgotRes.text.includes('id="forgotUsername"'));

  const reportsRes = await request(app).get("/my-reports");
  assert.strictEqual(reportsRes.status, 200);
  assert.ok(reportsRes.text.includes('for="ticketCodeInput"'));

  const bankRes = await request(app).get("/master-bank");
  assert.strictEqual(bankRes.status, 200);
  assert.ok(bankRes.text.includes('for="filterBankTitle"'));
  assert.ok(bankRes.text.includes("if (!isSingerLoggedIn) return;"));
});

test("QW-05: /my-hub with Accept: text/html,application/json redirects HTML browsers and returns 401 only for JSON API", async () => {
  const htmlNav = await request(app)
    .get("/my-hub")
    .set("Accept", "text/html,application/json,*/*");
  assert.strictEqual(htmlNav.status, 302);
  assert.ok(htmlNav.headers.location.includes("/singer/login"));

  const apiCall = await request(app)
    .get("/api/singer/songbook")
    .set("Accept", "application/json");
  assert.strictEqual(apiCall.status, 401);
});

test("P0-03 & QW-05: /admin/danger-reset-history & /admin/users routes behave accurately", async () => {
  const unauthUsers = await request(app).get("/admin/users");
  assert.strictEqual(unauthUsers.status, 302);
  assert.ok(unauthUsers.headers.location.includes("/admin-login"));

  const agent = await loginAsSuperAdmin();

  const authUsers = await agent.get("/admin/users");
  assert.strictEqual(authUsers.status, 302);
  assert.ok(authUsers.headers.location.endsWith("/admin/admin-users"));

  const resetPage = await agent.get("/admin/danger-reset-history");
  assert.strictEqual(resetPage.status, 200);
  const csrf = extractCsrf(resetPage.text);

  // Submitting wrong phrase proves POST handler is mounted (no 404) & blocks wipe cleanly
  const badResetPost = await agent
    .post("/admin/danger-reset-history")
    .type("form")
    .send({
      _csrf: csrf,
      confirmation: "WRONG PHRASE",
      admin_password: "wrong"
    });
  assert.notStrictEqual(badResetPost.status, 404);
  assert.strictEqual(badResetPost.status, 400);
  assert.ok(badResetPost.text.includes("DELETE ALL HISTORY"));
});

test("P0-04: /admin/permission accepts special, festival, and clear types", async () => {
  const agent = await loginAsSuperAdmin();
  const dash = await agent.get("/admin");
  const csrf = extractCsrf(dash.text);

  for (const type of ["special", "festival", "clear"]) {
    const res = await agent
      .post("/admin/permission")
      .set("X-CSRF-Token", csrf)
      .send({
        date: "2026-12-24",
        type,
        description: `Test ${type}`
      });
    assert.strictEqual(res.status, 200, `Expected 200 for type=${type}`);
    assert.strictEqual(res.body.success, true);
  }
  await SessionPermission.destroy({ where: { date: "2026-12-24" } });
});

test("QW-04, QW-06, POL-01..03: Activity Presence, Missing Catcher Parity, Session View Badges, & Analytics Math", async () => {
  const agent = await loginAsSuperAdmin();

  // Seed diverse bhajan submissions including mixed speeds & uncataloged titles
  await BhajanSubmission.bulkCreate([
    {
      session_date: "2025-10-02",
      singer_name: "Test Singer",
      deity: "Ganesha",
      title: "ZZ_UNIQUE_MISSING_ALPHA_1",
      speed: "Medium Slow",
      scale: "1 P",
      list_order: 1
    },
    {
      session_date: "2025-10-02",
      singer_name: "Test Singer",
      deity: "Sai",
      title: "ZZ_UNIQUE_MISSING_ALPHA_2",
      speed: "Medium Fast",
      scale: "2 P",
      list_order: 2
    },
    {
      session_date: "2025-10-02",
      singer_name: "Test Singer",
      deity: "Shiva",
      title: "zz_unique_missing_alpha_1",
      speed: "",
      scale: "3 P",
      list_order: 3
    },
    {
      session_date: "2025-10-02",
      singer_name: "Test Singer",
      deity: "Krishna",
      title: "ZZ_UNIQUE_MISSING_ALPHA_3",
      speed: "Slow",
      scale: "4 P",
      list_order: 4
    },
    {
      session_date: "2025-10-02",
      singer_name: "Test Singer",
      deity: "Rama",
      title: "ZZ_UNIQUE_MISSING_ALPHA_4",
      speed: "Fast",
      scale: "5 P",
      list_order: 5
    }
  ]);
  helpers.invalidateMissingCount();

  // QW-06: Admin visiting /admin/activity-logs flushes buffer so onlineAdminsCount >= 1
  const actRes = await agent.get("/admin/activity-logs");
  assert.strictEqual(actRes.status, 200);
  const onlineMatch = actRes.text.match(/id="cardOnlineAdmins">(\d+)</);
  assert.ok(onlineMatch && Number(onlineMatch[1]) >= 1, "Online Admins card must be >= 1");

  // POL-03a: Missing Catcher badge === Missing Catcher page count
  const badgeCount = await helpers.getCachedMissingCount(true);
  const missingPage = await agent.get("/admin/missing-bhajans");
  assert.strictEqual(missingPage.status, 200);
  const pageCountMatch = missingPage.text.match(/class="sidebar-badge-count[^"]*">(\d+)</);
  assert.ok(pageCountMatch, "Sidebar badge should render on missing-bhajans page");
  assert.strictEqual(Number(pageCountMatch[1]), badgeCount);

  // POL-03b: Analytics tempo counts & percentages sum cleanly to totalSung and 100%
  const analyticsRes = await agent.get("/admin/analytics");
  assert.strictEqual(analyticsRes.status, 200);
  assert.ok(analyticsRes.text.includes("hero-btn-ghost"), "Hero uses fixed high-contrast ghost buttons");
  assert.ok(analyticsRes.text.includes("Med Slow"), "Medium Slow speed tracked explicitly");
  assert.ok(analyticsRes.text.includes("Med Fast"), "Medium Fast speed tracked explicitly");
  assert.ok(analyticsRes.text.includes("Unspecified"), "Unspecified speed tracked explicitly");

  // Extract tempo counts and pcts from rendered stat boxes and verify totals = 5 and 100%
  const boxMatches = [
    ...analyticsRes.text.matchAll(
      /<strong[^>]*>(\d+)<\/strong>\s*<span[^>]*>[A-Za-z ]+\((\d+)%\)<\/span>/g
    )
  ];
  assert.ok(boxMatches.length >= 3, "Analytics tempo boxes rendered");
  const countSum = boxMatches.reduce((acc, m) => acc + Number(m[1]), 0);
  const pctSum = boxMatches.reduce((acc, m) => acc + Number(m[2]), 0);
  assert.strictEqual(countSum, 5, "Tempo counts must equal totalSung (5)");
  assert.strictEqual(pctSum, 100, "Tempo percentages must equal strictly 100%");

  // QW-04: Past session view shows Session Closed (Past) and no duplicate weekday
  const sessRes = await agent.get("/admin/date/2025-10-02");
  assert.strictEqual(sessRes.status, 200);
  assert.ok(sessRes.text.includes("Session Closed (Past)"));
  assert.ok(!sessRes.text.includes("(Thursday)"), "Must not duplicate weekday in header");

  // POL-01 / POL-02: Admin user form renders balanced .admin-card wrappers
  const userFormRes = await agent.get("/admin/admin-users/new");
  assert.strictEqual(userFormRes.status, 200);
  const openCards = (userFormRes.text.match(/class="admin-card"/g) || []).length;
  assert.strictEqual(openCards, 2, "Expected 2 .admin-card containers in admin-user-form");
});
