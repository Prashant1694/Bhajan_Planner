const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
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
  const valid = validateUpdatePermission({
    date: "2026-10-15",
    type: "festival",
    description: "Navaratri Session"
  });
  // 'festival' is invalid type, valid are open, restricted, closed, clear
  assert.strictEqual(valid.valid, false);

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

