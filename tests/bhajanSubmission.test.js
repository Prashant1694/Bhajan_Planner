const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const {
  validateSubmitForm,
  validateCopySession,
  validateUpdatePermission,
  validateReorder
} = require("../services/validators");

test("Validator: reject unexpected body keys in submitForm", () => {
  const result = validateSubmitForm({
    title: "Ganesha Sharanam",
    singer_name: "Test Singer",
    deity: "Ganesha",
    session_date: "2026-10-15",
    malicious_injected_field: "attack"
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("Unexpected fields not allowed")));
});

test("Validator: accept valid bhajan submission", () => {
  const result = validateSubmitForm({
    title: "Ganesha Sharanam",
    singer_name: "Test Singer",
    deity: "Ganesha",
    session_date: "2026-10-15",
    speed: "Medium",
    scale: "5.5"
  });

  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.data.title, "Ganesha Sharanam");
});

test("Validator: validateCopySession rejects same source and target date", () => {
  const result = validateCopySession({
    source_date: "2026-10-15",
    target_date: "2026-10-15"
  });

  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("different")));
});

test("Validator: validateUpdatePermission validates valid types", () => {
  const invalidType = validateUpdatePermission({
    date: "2026-10-15",
    type: "bogus_status",
    description: "Invalid status"
  });
  assert.strictEqual(invalidType.valid, false);

  const validFestival = validateUpdatePermission({
    date: "2026-10-15",
    type: "festival",
    description: "Navaratri Session"
  });
  assert.strictEqual(validFestival.valid, true);

  const validSpecial = validateUpdatePermission({
    date: "2026-10-15",
    type: "special",
    description: "Special Session"
  });
  assert.strictEqual(validSpecial.valid, true);

  const validClear = validateUpdatePermission({
    date: "2026-10-15",
    type: "clear"
  });
  assert.strictEqual(validClear.valid, true);
});

test("Validator: validateReorder ensures orderData is an array of valid IDs", () => {
  const invalid = validateReorder({ orderData: "not-an-array" });
  assert.strictEqual(invalid.valid, false);

  const valid = validateReorder({
    orderData: [
      { id: 1, order: 0 },
      { id: 2, order: 1 }
    ]
  });
  assert.strictEqual(valid.valid, true);
});

test("POST /submit-form without authenticated singer redirects to singer login", async () => {
  const agent = request.agent(app);
  const getRes = await agent.get("/singer/login");
  const csrfMatch = getRes.text.match(/name="csrf-token" content="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  const res = await agent.post("/submit-form").set("X-CSRF-Token", csrfToken).send({
    title: "Ganesha Sharanam",
    singer_name: "Unauthenticated Devotee",
    deity: "Ganesha",
    session_date: "2026-10-15"
  });

  assert.strictEqual(res.status, 302);
  assert.ok(res.headers.location.includes("/singer/login"));
});

test("GET /submit-form serves CSRF token in meta tag and hidden form field", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/singer/login");
  const loginCsrf = (loginPage.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1];

  await agent.post("/api/singer/login").set("X-CSRF-Token", loginCsrf).send({
    singer_id: 1,
    pin: "1234",
    redirect: "/submit-form"
  });

  const formPage = await agent.get("/submit-form");
  assert.strictEqual(formPage.status, 200);

  const metaMatch = formPage.text.match(/<meta name="csrf-token" content="([^"]+)"/);
  assert.ok(metaMatch, "Should have csrf-token meta tag");
  assert.ok(metaMatch[1].length > 0, "CSRF token should not be empty");

  const inputMatch = formPage.text.match(/<input type="hidden" name="_csrf" value="([^"]+)"/);
  assert.ok(inputMatch, "Should have hidden _csrf input in bhajanForm");
  assert.strictEqual(inputMatch[1], metaMatch[1], "Input CSRF token should match meta tag");
});

test("POST /submit-form succeeds with _csrf in body (standard browser form submission)", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/singer/login");
  const loginCsrf = (loginPage.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1];

  await agent.post("/api/singer/login").set("X-CSRF-Token", loginCsrf).send({
    singer_id: 1,
    pin: "1234",
    redirect: "/submit-form"
  });

  const formPage = await agent.get("/submit-form");
  const inputMatch = formPage.text.match(/<input type="hidden" name="_csrf" value="([^"]+)"/);
  assert.ok(inputMatch, "Hidden _csrf input must be present");
  const csrfToken = inputMatch[1];

  const dateMatch = formPage.text.match(/name="session_date" value="([^"]+)"/);
  const sessionDate = dateMatch ? dateMatch[1] : "2026-10-15";

  const mb = await MasterBhajan.findOne({ where: { deity: "Ganesha", is_active: true } });
  assert.ok(mb, "Should find active Ganesha master bhajan");

  const res = await agent
    .post("/submit-form")
    .type("form")
    .send({
      _csrf: csrfToken,
      session_date: sessionDate,
      singer_name: "Test Singer",
      gender: "Male",
      deity: "Ganesha",
      title: mb.title,
      master_bhajan_id: mb.id,
      speed: "Medium",
      scale: "5.5"
    });

  assert.notStrictEqual(res.status, 403, "Must not return 403 CSRF forbidden");
  assert.strictEqual(res.status, 302, "Should redirect upon successful submission");
  assert.ok(res.headers.location.includes("success=true"));
});

test("GET /submit-form?_embed=1 renders Tanpura widget, stylesheet, script and sound button", async () => {
  const agent = request.agent(app);
  const loginPage = await agent.get("/singer/login");
  const loginCsrf = (loginPage.text.match(/name="csrf-token" content="([^"]+)"/) || [])[1];

  await agent.post("/api/singer/login").set("X-CSRF-Token", loginCsrf).send({
    singer_id: 1,
    pin: "1234",
    redirect: "/submit-form"
  });

  const formPage = await agent.get("/submit-form?_embed=1");
  assert.strictEqual(formPage.status, 200);
  assert.ok(formPage.text.includes("/css/tanpura.css"), "Should include tanpura.css");
  assert.ok(formPage.text.includes("/js/tanpura.js"), "Should include tanpura.js");
  assert.ok(formPage.text.includes("tanpuraFloatingWidget"), "Should include Tanpura floating widget");
  assert.ok(formPage.text.includes("btnAuditionScale"), "Should include Sound Tanpura audition button");
});

test("Admin session view renders _csrf in delete forms and POST /admin/delete/:id deletes submission without 403", async () => {
  const sessionDate = "2026-10-22";
  const submission = await BhajanSubmission.create({
    title: "Ganesha Sharanam",
    singer_name: "Test Singer",
    gender: "Male",
    deity: "Ganesha",
    speed: "Medium",
    scale: "5.5",
    session_date: sessionDate
  });

  try {
    const agent = request.agent(app);
    const loginPage = await agent.get("/admin-login");
    const loginCsrfMatch = loginPage.text.match(/name="csrf-token" content="([^"]+)"/);
    const loginCsrf = loginCsrfMatch ? loginCsrfMatch[1] : "";
    assert.ok(loginCsrf.length > 0, "Admin login page should provide a CSRF token");

    const loginRes = await agent
      .post("/admin-login")
      .type("form")
      .send({
        _csrf: loginCsrf,
        username: process.env.SUPER_ADMIN_USER || "testadmin",
        password: process.env.SUPER_ADMIN_PASS || "TestAdmin#12345"
      });
    assert.strictEqual(loginRes.status, 200, "Admin login should succeed with 200 interstitial redirect");
    assert.ok(loginRes.text.includes("Logging in..."), "Admin login response should confirm login");

    const sessionViewRes = await agent.get(`/admin/date/${sessionDate}`);
    assert.strictEqual(sessionViewRes.status, 200);

    const formRegex = new RegExp(
      `<form\\s+action="/admin/delete/${submission.id}"\\s+method="POST"[\\s\\S]*?<\\/form>`,
      "g"
    );
    const formMatches = sessionViewRes.text.match(formRegex) || [];
    assert.strictEqual(
      formMatches.length,
      2,
      "Desktop table and mobile card should both render /admin/delete/:id forms"
    );

    const extractedTokens = formMatches.map((formHtml) => {
      const m = formHtml.match(/<input\s+type="hidden"\s+name="_csrf"\s+value="([^"]+)"/);
      assert.ok(m && m[1].length > 0, "Each delete form must embed a non-empty hidden _csrf input");
      return m[1];
    });

    const delRes = await agent
      .post(`/admin/delete/${submission.id}`)
      .type("form")
      .send({ _csrf: extractedTokens[0] });

    assert.notStrictEqual(delRes.status, 403, "Must not return 403 CSRF forbidden");
    assert.strictEqual(delRes.status, 302, "Should redirect back to session view after delete");
    assert.strictEqual(delRes.headers.location, `/admin/date/${sessionDate}`);

    const remaining = await BhajanSubmission.findByPk(submission.id);
    assert.strictEqual(remaining, null, "Deleted submission must be removed from database");
  } finally {
    await BhajanSubmission.destroy({ where: { id: submission.id } });
  }
});

test("Client [data-confirm] and programmatic form.submit sync _csrf token before native submission", () => {
  const nativeUiJs = fs.readFileSync(
    path.join(__dirname, "../public/js/native-ui.js"),
    "utf8"
  );
  const scriptJs = fs.readFileSync(path.join(__dirname, "../public/js/script.js"), "utf8");

  assert.match(nativeUiJs, /function syncFormCsrfBeforeSubmit\(form\)/);
  assert.match(nativeUiJs, /syncFormCsrfBeforeSubmit\(form\);\s*form\.submit\(\);/);
  assert.match(scriptJs, /function ensureFormCsrfToken\(form\)/);
  assert.match(
    scriptJs,
    /HTMLFormElement\.prototype\.submit\s*=\s*function\s*\(\)\s*\{\s*ensureFormCsrfToken\(this\);/
  );
});

