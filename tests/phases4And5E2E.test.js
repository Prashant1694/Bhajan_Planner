const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const request = require("supertest");
const { setupTestDb } = require("./setup");

let app;
let AdminUser;
let BhajanSubmission;
let Singer;

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  AdminUser = require("../models/AdminUser");
  BhajanSubmission = require("../models/BhajanSubmission");
  Singer = require("../models/Singer");
});

function extractCsrf(html) {
  const metaMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch) return metaMatch[1];
  const inputMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return inputMatch ? inputMatch[1] : "";
}

async function loginAsAdmin(username, password) {
  const agent = request.agent(app);
  const getRes = await agent.get("/admin-login");
  const csrf = extractCsrf(getRes.text);
  const postRes = await agent
    .post("/admin-login")
    .type("form")
    .send({
      username: username || process.env.SUPER_ADMIN_USER || "testadmin",
      password: password || process.env.SUPER_ADMIN_PASS || "TestAdmin#12345",
      _csrf: csrf
    });
  assert.strictEqual(postRes.status, 200);
  return agent;
}

test("HARD-01: Invalid date, missing edit ID, invalid edit submit, and RBAC render styled admin-error", async () => {
  const superAgent = await loginAsAdmin();

  const badDateRes = await superAgent.get("/admin/date/2026-99-99");
  assert.strictEqual(badDateRes.status, 400);
  assert.ok(badDateRes.text.includes("Invalid Session Date"));

  const missingEditRes = await superAgent.get("/admin/edit/999999");
  assert.strictEqual(missingEditRes.status, 404);
  assert.ok(missingEditRes.text.includes("Entry Not Found"));

  // Create a submission and test invalid edit submission stays at edit page (no /admin/date/undefined)
  const createdSub = await BhajanSubmission.create({
    session_date: "2026-11-19",
    singer_name: "Test Singer",
    title: "E2E Editable Bhajan",
    deity: "Ganesha",
    scale: "C#",
    speed: "Medium"
  });

  const editGet = await superAgent.get(`/admin/edit/${createdSub.id}`);
  assert.strictEqual(editGet.status, 200);
  assert.ok(editGet.text.includes('for="editTitle"'));
  const csrf = extractCsrf(editGet.text);

  const badPost = await superAgent
    .post(`/admin/edit/${createdSub.id}`)
    .type("form")
    .send({
      _csrf: csrf,
      session_date: "2026-11-19",
      singer_name: "Test Singer",
      title: "",
      deity: "Ganesha"
    });
  assert.strictEqual(badPost.status, 400);
  assert.ok(badPost.text.includes("adm-alert-error"));

  // Non-super-admin hits /admin/users -> styled 403
  const regularAdminName = "stdadmin_e2e";
  const existingRegular = await AdminUser.findOne({ where: { username: regularAdminName } });
  if (!existingRegular) {
    await AdminUser.create({
      username: regularAdminName,
      display_name: "Standard Coordinator",
      password_hash: await bcrypt.hash("StdPass#12345", 10),
      role: "admin",
      is_active: true
    });
  }
  const stdAgent = await loginAsAdmin(regularAdminName, "StdPass#12345");
  const forbiddenRes = await stdAgent.get("/admin/users");
  assert.strictEqual(forbiddenRes.status, 403);
  assert.ok(forbiddenRes.text.includes("Super Admin Access Required"));
});

test("HARD-02 & HARD-03: Catalog JSON, paginated admin views, labels, and Diwali markup hygiene", async () => {
  const catRes = await request(app).get("/api/master-bhajans/catalog.json");
  assert.strictEqual(catRes.status, 200);
  assert.ok(Array.isArray(catRes.body.bhajans));
  assert.ok(catRes.headers["cache-control"]?.includes("max-age=300"));
  if (catRes.body.bhajans.length > 0) {
    assert.ok(!("lyrics" in catRes.body.bhajans[0]), "Catalog JSON must not embed lyrics");
  }

  const superAgent = await loginAsAdmin();
  const archivedRes = await superAgent.get("/admin/archived-master-bhajans?page=1");
  assert.strictEqual(archivedRes.status, 200);
  assert.ok(archivedRes.text.includes('for="filterArchivedTitle"'));

  const logsRes = await superAgent.get("/admin/activity-logs?page=1");
  assert.strictEqual(logsRes.status, 200);

  const feedRes = await superAgent.get("/api/admin/activity-feed?limit=5");
  assert.strictEqual(feedRes.status, 200);
  assert.ok(Array.isArray(feedRes.body.logs));

  const diwaliDash = fs.readFileSync(
    path.join(__dirname, "../views/diwali/dashboard.ejs"),
    "utf8"
  );
  assert.ok(!/data-confirm="[^"]*<input/i.test(diwaliDash), "No unclosed <input inside data-confirm");
});

test("HARD-04: Legacy dev icon redirect & localhost Google OAuth guard", async () => {
  const iconRes = await request(app).get("/images/icons/bhajan-planner-dev-192.png");
  assert.strictEqual(iconRes.status, 301);
  assert.strictEqual(iconRes.headers.location, "/images/icons/dev/icon-192x192.png");

  const prevGoogleId = process.env.GOOGLE_CLIENT_ID;
  const prevAllowLocal = process.env.GOOGLE_ALLOW_LOCALHOST;
  process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  delete process.env.GOOGLE_ALLOW_LOCALHOST;
  try {
    const loginRes = await request(app)
      .get("/admin-login")
      .set("Host", "localhost:8000");
    assert.strictEqual(loginRes.status, 200);
    assert.ok(!loginRes.text.includes('id="google-signin-button"'));
  } finally {
    if (prevGoogleId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = prevGoogleId;
    if (prevAllowLocal === undefined) delete process.env.GOOGLE_ALLOW_LOCALHOST;
    else process.env.GOOGLE_ALLOW_LOCALHOST = prevAllowLocal;
  }
});

test("FEAT-01 & FEAT-02 & DEBT-02: Plan View partials, accompanist print cue, .ics download & open-slot reminder", async () => {
  const planRes = await request(app).get("/plan-view?session_date=2026-11-19");
  assert.strictEqual(planRes.status, 200);
  assert.ok(planRes.text.includes("print-accompanist-cue"));
  assert.ok(planRes.text.includes("/plan-view/session.ics"));
  assert.ok(planRes.text.includes('data-no-shell="1"'));
  assert.ok(planRes.text.includes('download="bhajan-session-'));

  const routerSrc = fs.readFileSync(
    path.join(__dirname, "../public/js/app-shell-router.js"),
    "utf8"
  );
  assert.ok(routerSrc.includes('"/plan-view/session.ics"'));

  const appShellSrc = fs.readFileSync(
    path.join(__dirname, "../views/app-shell.ejs"),
    "utf8"
  );
  assert.ok(appShellSrc.includes("@media print"));
  assert.ok(appShellSrc.includes("#mobileBottomCapsule"));

  const icsRes = await request(app).get("/plan-view/session.ics?session_date=2026-11-19");
  assert.strictEqual(icsRes.status, 200);
  assert.ok(icsRes.headers["content-type"].includes("text/calendar"));
  assert.ok(icsRes.text.includes("BEGIN:VCALENDAR"));
  assert.ok(icsRes.text.includes("BEGIN:VTIMEZONE"));
  assert.ok(icsRes.text.includes("TZID:Asia/Kolkata"));
  assert.ok(icsRes.text.includes("DTSTART;TZID=Asia/Kolkata:20261119T193000"));

  const superAgent = await loginAsAdmin();
  const dashRes = await superAgent.get("/admin");
  assert.strictEqual(dashRes.status, 200);
  assert.ok(dashRes.text.includes("Open-Slot Reminder"));

  const notFoundBulletin = await request(app).get("/bulletins/999999");
  assert.strictEqual(notFoundBulletin.status, 404);
  assert.ok(notFoundBulletin.text.includes("Bulletin Not Found"));
});

test("FEAT-03: Singer Thursday availability toggle surfaces Traveling & Cooldown warnings in Admin Sequencer", async () => {
  // Login as seeded Singer 1 ("Test Singer", PIN 1234)
  const singerAgent = request.agent(app);
  const loginGet = await singerAgent.get("/singer/login");
  const singerCsrf = extractCsrf(loginGet.text);
  const loginPost = await singerAgent
    .post("/api/singer/login")
    .set("X-CSRF-Token", singerCsrf)
    .send({ singer_id: 1, pin: "1234" });
  assert.strictEqual(loginPost.status, 200);

  const hubGet = await singerAgent.get("/my-hub");
  assert.strictEqual(hubGet.status, 200);
  assert.ok(hubGet.text.includes("Upcoming Thursday Availability"));
  const hubCsrf = extractCsrf(hubGet.text);

  const targetDate = "2026-11-26";
  const availRes = await singerAgent
    .post("/api/singer/availability")
    .set("X-CSRF-Token", hubCsrf)
    .send({ toggle_date: targetDate });
  assert.strictEqual(availRes.status, 200);
  assert.strictEqual(availRes.body.success, true);
  assert.ok(availRes.body.unavailable_dates.includes(targetDate));

  // Create a prior session bhajan & same title on targetDate for Test Singer
  await BhajanSubmission.create({
    session_date: "2026-11-12",
    singer_name: "Other Devotee",
    title: "Sai Ram Cooldown Bhajan",
    deity: "Sai",
    scale: "C#",
    speed: "Medium"
  });
  await BhajanSubmission.create({
    session_date: targetDate,
    singer_name: "Test Singer",
    title: "Sai Ram Cooldown Bhajan",
    deity: "Sai",
    scale: "C#",
    speed: "Medium"
  });

  const superAgent = await loginAsAdmin();
  const seqRes = await superAgent.get(`/admin/date/${targetDate}`);
  assert.strictEqual(seqRes.status, 200);
  assert.ok(seqRes.text.includes("Traveling"), "Admin sequencer must warn about Traveling singer");
  assert.ok(seqRes.text.includes("Cooldown"), "Admin sequencer must warn about recent repertoire repeat");
});

test("FEAT-04: Bulk CSV import, safe CSV export, and quick inline gender completion", async () => {
  const superAgent = await loginAsAdmin();
  const singersPage = await superAgent.get("/admin/singers");
  assert.strictEqual(singersPage.status, 200);
  const csrf = extractCsrf(singersPage.text);

  // Bulk import CSV including a formula-like prefix row
  const importRes = await superAgent
    .post("/api/admin/singers/import-csv")
    .type("form")
    .send({
      _csrf: csrf,
      csv_text: "Name,Gender,Preferred Scale\nMeera E2E,Female,G#\n=FormulaSinger,Male,C#"
    });
  assert.strictEqual(importRes.status, 302);

  const exportRes = await superAgent.get("/admin/singers/export.csv");
  assert.strictEqual(exportRes.status, 200);
  assert.ok(exportRes.headers["content-type"].includes("text/csv"));
  assert.ok(exportRes.text.includes('"Meera E2E","Female","G#"'));
  assert.ok(exportRes.text.includes(`"'=FormulaSinger"`), "CSV export must neutralize spreadsheet formulas");

  // Quick update gender inline
  const targetSinger = await Singer.create({ name: "NoGender E2E", gender: null });
  const quickRes = await superAgent
    .post("/api/admin/singers/quick-gender")
    .set("X-CSRF-Token", csrf)
    .send({ id: targetSinger.id, gender: "Female" });
  assert.strictEqual(quickRes.status, 200);
  assert.strictEqual(quickRes.body.gender, "Female");
});

test("FEAT-05, DEBT-03 & DEBT-04: Offline SW caching, CSS @layer & !important ratchet, tracked tests & CI", () => {
  const sw = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
  assert.ok(sw.includes('"/plan-view"'));
  assert.ok(sw.includes('"/api/master-bhajans/catalog.json"'));
  assert.ok(sw.includes("isOfflineDevotionalEndpoint"));

  const styleCss = fs.readFileSync(path.join(__dirname, "../public/css/style.css"), "utf8");
  const adminCss = fs.readFileSync(path.join(__dirname, "../public/css/admin.css"), "utf8");
  assert.ok(styleCss.includes("@layer base, components, layout, overrides;"));
  assert.ok(adminCss.includes("@layer base, components, layout, overrides;"));
  assert.ok(!/^\s*\.topbar-(left|right)\s*\{/m.test(adminCss), "Dead topbar-left/right rules removed");

  // !important ceiling ratchet across CSS directory
  const cssDir = path.join(__dirname, "../public/css");
  let totalImportant = 0;
  fs.readdirSync(cssDir)
    .filter((f) => f.endsWith(".css"))
    .forEach((f) => {
      const content = fs.readFileSync(path.join(cssDir, f), "utf8");
      totalImportant += (content.match(/!important/g) || []).length;
    });
  assert.ok(totalImportant <= 3300, `CSS !important count (${totalImportant}) must stay at or below 3300`);

  const gitignore = fs.readFileSync(path.join(__dirname, "../.gitignore"), "utf8");
  assert.ok(!/^tests\/\s*$/m.test(gitignore), ".gitignore must not ignore tests/");
  assert.ok(fs.existsSync(path.join(__dirname, "../.github/workflows/ci.yml")), "CI workflow must exist");
});
