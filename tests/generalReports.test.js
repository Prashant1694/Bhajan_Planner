const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb } = require("./setup");

let app;
let BhajanReport;
let sequelize;
let initializeDatabase;

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  BhajanReport = require("../models/BhajanReport");
  sequelize = require("../config/database");
  ({ initializeDatabase } = require("../services/databaseInitializer"));
});

function extractCsrf(html) {
  const metaMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch) return metaMatch[1];
  const inputMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return inputMatch ? inputMatch[1] : "";
}

async function getAnonAgentWithCsrf() {
  const agent = request.agent(app);
  const res = await agent.get("/my-reports");
  assert.strictEqual(res.status, 200);
  const csrf = extractCsrf(res.text);
  assert.ok(csrf, "CSRF token should be present on /my-reports");
  return { agent, csrf };
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
  return { agent, csrf };
}

test("General Reports: submit missing_bhajan without master_id and persist report_type & page_context", async () => {
  const { agent, csrf } = await getAnonAgentWithCsrf();

  const res = await agent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", csrf)
    .send({
      report_type: "general",
      subject: "Ananda Sagara Muralidhara",
      categories: ["missing_bhajan"],
      description: "Please add this Krishna bhajan in 2P scale.",
      suggested_correction: "Raga: Charukesi",
      reporter_name: "Devotee Test",
      visitor_id: "vid-general-1",
      page_context: "/master-bank"
    });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.report_type, "general");
  assert.match(res.body.ticket_code, /^REP-[A-Z0-9]+$/);
  assert.strictEqual(res.body.ticket.report_type, "general");
  assert.strictEqual(res.body.ticket.page_context, "/master-bank");

  const dbRow = await BhajanReport.findOne({
    where: { ticket_code: res.body.ticket_code },
    raw: true
  });
  assert.ok(dbRow);
  assert.strictEqual(dbRow.master_id, null);
  assert.strictEqual(dbRow.report_type, "general");
  assert.strictEqual(dbRow.bhajan_title, "Ananda Sagara Muralidhara");
  assert.strictEqual(dbRow.page_context, "/master-bank");
  assert.deepStrictEqual(JSON.parse(dbRow.categories), ["missing_bhajan"]);
});

test("General Reports: derives default subject for app_bug & suggestion when subject is omitted", async () => {
  const { agent, csrf } = await getAnonAgentWithCsrf();

  const bugRes = await agent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", csrf)
    .send({
      categories: ["app_bug"],
      description: "Tanpura volume slider resets after switching tabs.",
      visitor_id: "vid-general-2"
    });

  assert.strictEqual(bugRes.status, 201);
  assert.strictEqual(bugRes.body.report_type, "general");
  assert.strictEqual(bugRes.body.ticket.bhajan_title, "App Bug Report");

  const suggRes = await agent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", csrf)
    .send({
      categories: ["suggestion"],
      description: "Add dark-mode toggle shortcut in Singer Hub.",
      visitor_id: "vid-general-2"
    });

  assert.strictEqual(suggRes.status, 201);
  assert.strictEqual(suggRes.body.report_type, "general");
  assert.strictEqual(suggRes.body.ticket.bhajan_title, "Feature Suggestion");
});

test("General Reports: rejects empty submission with 400", async () => {
  const { agent, csrf } = await getAnonAgentWithCsrf();

  const res = await agent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", csrf)
    .send({
      report_type: "general",
      categories: [],
      description: "   "
    });

  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error);
});

test("Backward compatibility: standard bhajan report keeps report_type = bhajan", async () => {
  const { agent, csrf } = await getAnonAgentWithCsrf();

  const res = await agent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", csrf)
    .send({
      bhajan_title: "Ganesha Vandana Classic",
      categories: ["lyrics"],
      description: "Minor spelling correction on stanza 2",
      visitor_id: "vid-bhajan-1"
    });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.report_type, "bhajan");

  const lookupRes = await agent.get("/api/reports/ticket/" + res.body.ticket_code);
  assert.strictEqual(lookupRes.status, 200);
  assert.strictEqual(lookupRes.body.report_type, "bhajan");
});

test("Tracker & Admin: my-reports returns general tickets and admin filters/updates them", async () => {
  const { agent: devAgent, csrf: devCsrf } = await getAnonAgentWithCsrf();
  const createdRes = await devAgent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", devCsrf)
    .send({
      report_type: "general",
      subject: "Session Audio Sync Feedback",
      categories: ["session_audio"],
      description: "Thursday recording volume is low.",
      visitor_id: "vid-track-admin"
    });
  assert.strictEqual(createdRes.status, 201);
  const code = createdRes.body.ticket_code;
  const id = createdRes.body.report_id;

  const myRes = await devAgent.get("/api/reports/my-reports?tickets=" + encodeURIComponent(code));
  assert.strictEqual(myRes.status, 200);
  const found = myRes.body.reports.find((r) => r.ticket_code === code);
  assert.ok(found);
  assert.strictEqual(found.report_type, "general");

  const { agent: adminAgent } = await loginAsSuperAdmin();
  const adminPage = await adminAgent.get("/admin/reports");
  assert.strictEqual(adminPage.status, 200);
  const adminCsrf = extractCsrf(adminPage.text);

  const generalFiltered = await adminAgent.get("/admin/reports?type=general");
  assert.strictEqual(generalFiltered.status, 200);
  assert.ok(generalFiltered.text.includes("Session Audio Sync Feedback"));
  assert.ok(!generalFiltered.text.includes("Ganesha Vandana Classic"));

  const bhajanFiltered = await adminAgent.get("/admin/reports?type=bhajan");
  assert.strictEqual(bhajanFiltered.status, 200);
  assert.ok(bhajanFiltered.text.includes("Ganesha Vandana Classic"));
  assert.ok(!bhajanFiltered.text.includes("Session Audio Sync Feedback"));

  const updateRes = await adminAgent
    .post("/admin/reports/" + id + "/update")
    .set("X-CSRF-Token", adminCsrf)
    .send({
      status: "resolved",
      admin_response: "Sai Ram! Audio gain has been adjusted."
    });
  assert.strictEqual(updateRes.status, 200);
  assert.strictEqual(updateRes.body.success, true);
  assert.strictEqual(updateRes.body.report.status, "resolved");
});

test("Views & Route: /my-reports composer prefill and entry links across views", async () => {
  const res = await request(app).get("/my-reports?new=1&cat=missing_bhajan&from=/master-bank");
  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes("generalReportComposer"));
  assert.ok(res.text.includes("submitGeneralReport"));
  assert.ok(res.text.includes('value="missing_bhajan" checked'));
  assert.ok(res.text.includes('value="app_bug"'));
  assert.ok(res.text.includes('value="suggestion"'));

  const viewsRoot = path.join(__dirname, "..", "views");
  const masterBankHtml = fs.readFileSync(path.join(viewsRoot, "master-bank.ejs"), "utf8");
  const siteFooterHtml = fs.readFileSync(path.join(viewsRoot, "partials", "site-footer.ejs"), "utf8");
  const singerHubHtml = fs.readFileSync(path.join(viewsRoot, "singer-hub.ejs"), "utf8");
  const adminReportsHtml = fs.readFileSync(path.join(viewsRoot, "admin-reports.ejs"), "utf8");

  assert.ok(masterBankHtml.includes("/my-reports?new=1"));
  assert.ok(siteFooterHtml.includes("/my-reports?new=1"));
  assert.ok(singerHubHtml.includes("/my-reports?new=1"));
  assert.ok(adminReportsHtml.includes('name="type"'));
  assert.ok(adminReportsHtml.includes('value="missing_bhajan"'));
  assert.ok(adminReportsHtml.includes("applyQuickReply('missing_bhajan')"));
});

test("Migration regression: BhajanReport.sync() & initializeDatabase() succeed on legacy table without report_type/page_context", async () => {
  await sequelize.query("DROP TABLE IF EXISTS bhajan_reports");
  await sequelize.query(`
    CREATE TABLE bhajan_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_code VARCHAR(30) NOT NULL UNIQUE,
      master_id INTEGER,
      singer_id INTEGER,
      bhajan_title VARCHAR(255) NOT NULL,
      categories TEXT NOT NULL DEFAULT '[]',
      description TEXT NOT NULL,
      suggested_correction TEXT,
      reporter_name VARCHAR(100),
      reporter_contact VARCHAR(150),
      visitor_id VARCHAR(100),
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      admin_response TEXT,
      admin_notes TEXT,
      reviewed_by VARCHAR(100),
      reviewed_at DATETIME,
      resolved_at DATETIME,
      user_viewed_reply TINYINT(1) DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await BhajanReport.sync();
  await initializeDatabase();

  const [cols] = await sequelize.query("PRAGMA table_info(bhajan_reports)");
  const colNames = cols.map((c) => c.name);
  assert.ok(colNames.includes("report_type"), "report_type column should be added idempotently");
  assert.ok(colNames.includes("page_context"), "page_context column should be added idempotently");

  const [indexes] = await sequelize.query("PRAGMA index_list(bhajan_reports)");
  const indexNames = indexes.map((idx) => idx.name);
  assert.ok(
    indexNames.includes("idx_bhajan_reports_type"),
    "idx_bhajan_reports_type index should exist after migration"
  );
});

test("Shell UI: sticky deity filter cannot overlap detail sheet and header report button precedes theme toggle", () => {
  const rootDir = path.join(__dirname, "..");
  const shellCss = fs.readFileSync(path.join(rootDir, "public", "css", "app-shell.css"), "utf8");
  const shellEjs = fs.readFileSync(path.join(rootDir, "views", "app-shell.ejs"), "utf8");
  const userReportsEjs = fs.readFileSync(path.join(rootDir, "views", "user-reports.ejs"), "utf8");

  assert.ok(/\.shell-pane\s*\{[\s\S]*?isolation:\s*isolate;/m.test(shellCss));
  assert.ok(/\.shell-detail-sheet\s*\{[\s\S]*?z-index:\s*120;/m.test(shellCss));
  assert.ok(shellCss.includes("body.shell-body.detail-sheet-open .shell-pane .bank-deity-chips-scroll"));
  assert.ok(userReportsEjs.includes(".shell-detail-body .ur-standalone-back"));

  const headerStart = shellEjs.indexOf('class="header-right"');
  const reportBtnIdx = shellEjs.indexOf('id="shellReportBtn"', headerStart);
  const themeBtnIdx = shellEjs.indexOf('id="shellThemeToggle"', headerStart);
  assert.ok(headerStart !== -1 && reportBtnIdx !== -1 && themeBtnIdx !== -1);
  assert.ok(
    reportBtnIdx < themeBtnIdx,
    "Header report button must render immediately before dark/light theme toggle"
  );
});

test("Singer Hub & key routes: /singer/hub renders general reports safely without r.categories.forEach TypeError", async () => {
  const singerAgent = request.agent(app);
  const loginPage = await singerAgent.get("/singer/login");
  assert.strictEqual(loginPage.status, 200);
  const loginCsrf = extractCsrf(loginPage.text);

  const loginRes = await singerAgent
    .post("/api/singer/login")
    .set("X-CSRF-Token", loginCsrf)
    .send({
      singer_id: 1,
      pin: "1234",
      redirect: "/singer/hub"
    });
  assert.strictEqual(loginRes.status, 200);

  const reportCsrf = extractCsrf((await singerAgent.get("/my-reports")).text);
  const submitRes = await singerAgent
    .post("/api/reports/submit")
    .set("X-CSRF-Token", reportCsrf)
    .send({
      report_type: "general",
      subject: "Hub Test Missing Bhajan & Bug",
      categories: ["missing_bhajan", "app_bug"],
      description: "Testing Singer Hub rendering of general categories."
    });
  assert.strictEqual(submitRes.status, 201);

  const hubRes = await singerAgent.get("/singer/hub");
  assert.strictEqual(hubRes.status, 200);
  assert.ok(hubRes.text.includes(submitRes.body.ticket_code));
  assert.ok(hubRes.text.includes("Hub Test Missing Bhajan &amp; Bug") || hubRes.text.includes("Hub Test Missing Bhajan & Bug"));
  assert.ok(hubRes.text.includes("Missing Bhajan"));
  assert.ok(hubRes.text.includes("App Bug"));
  assert.ok(hubRes.text.includes("General / App"));

  const [homeRes, bankRes] = await Promise.all([
    singerAgent.get("/"),
    singerAgent.get("/master-bank")
  ]);
  assert.strictEqual(homeRes.status, 200);
  assert.strictEqual(bankRes.status, 200);
});
