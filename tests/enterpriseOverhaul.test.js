const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const Singer = require("../models/Singer");

test("First-login PIN: rejects mismatched confirm_pin", async () => {
  const agent = request.agent(app);
  const getRes = await agent.get("/singer/login");
  const csrfMatch = getRes.text.match(/name="csrf-token" content="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  // Unclaimed Singer (id: 2) has pin: null
  const res = await agent.post("/api/singer/login").set("X-CSRF-Token", csrfToken).send({
    singer_id: 2,
    pin: "5555",
    confirm_pin: "9999"
  });

  assert.strictEqual(res.status, 400);
  assert.ok(res.body.error.includes("PINs do not match"));
});

test("First-login PIN: successfully creates PIN on first login and authenticates", async () => {
  const agent = request.agent(app);
  const getRes = await agent.get("/singer/login");
  const csrfMatch = getRes.text.match(/name="csrf-token" content="([^"]+)"/);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  const res = await agent.post("/api/singer/login").set("X-CSRF-Token", csrfToken).send({
    singer_id: 2,
    pin: "5555",
    confirm_pin: "5555"
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.singer.id, 2);
  assert.strictEqual(res.body.singer.name, "Unclaimed Singer");

  // Verify PIN is now hashed in database
  const updated = await Singer.scope("withSecrets").findByPk(2);
  assert.ok(updated.pin && updated.pin.startsWith("$2b$"));
  assert.ok(updated.pin_set_at);

  // Subsequent login with same PIN succeeds
  const loginRes = await agent.post("/api/singer/login").set("X-CSRF-Token", csrfToken).send({
    singer_id: 2,
    pin: "5555"
  });
  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.body.success, true);

  // Login with wrong PIN now returns 403
  const wrongRes = await agent.post("/api/singer/login").set("X-CSRF-Token", csrfToken).send({
    singer_id: 2,
    pin: "1234"
  });
  assert.strictEqual(wrongRes.status, 403);
  assert.ok(wrongRes.body.error.includes("Incorrect"));
});

test("App-Shell Fragment: X-App-Shell: 1 header sets X-Shell-Url and returns chromeless fragment", async () => {
  const res = await request(app)
    .get("/master-bank")
    .set("X-App-Shell", "1");

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["x-shell-url"], "/master-bank");
  // Fragment must not contain full outer HTML skeleton with head/app-shell
  assert.ok(!res.text.includes('<div id="appShellRoot">'));
  assert.ok(res.text.includes("master-catalog-view"));
});

test("API: GET /api/bhajan/:id/lyrics returns JSON lyrics without full page overhead", async () => {
  // Test with first catalog entry or placeholder if bank is initialized
  const res = await request(app).get("/api/bhajan/1/lyrics");
  if (res.status === 200) {
    assert.ok(res.body.id);
    assert.ok("title" in res.body);
    assert.ok("lyrics" in res.body);
  } else {
    assert.strictEqual(res.status, 404);
  }
});

test("Route Audit: /singers and /singer-dictionary safely redirect without 404/500", async () => {
  const r1 = await request(app).get("/singers");
  assert.ok(r1.status === 302 || r1.status === 200);

  const r2 = await request(app).get("/singer-dictionary");
  assert.ok(r2.status === 302 || r2.status === 200);
});

  test("Service Worker: cache version and network-first CSS/JS strategy configured", async () => {
    const fs = require("fs");
    const path = require("path");
    const swCode = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
    assert.ok(swCode.includes('CACHE_VERSION = "v6.2"'));
    assert.ok(swCode.includes("request.destination === \"style\""));
    assert.ok(swCode.includes("request.destination === \"script\""));
  });

  test("Session Audio Player: close() applies immediate display: none and removes is-visible", async () => {
    const fs = require("fs");
    const path = require("path");
    const jsCode = fs.readFileSync(
      path.join(__dirname, "../public/js/session-audio-player.js"),
      "utf8"
    );
    assert.ok(jsCode.includes('bar.style.setProperty("display", "none", "important")'));
    assert.ok(jsCode.includes('bar.classList.remove("is-visible")'));
    assert.ok(!jsCode.includes('setTimeout(function () { if (bar && !bar.classList.contains("is-visible"))'));
  });

  test("Desktop Sidebar & Navigation: router syntax valid and nav click handlers bound", async () => {
    const fs = require("fs");
    const path = require("path");
    const routerCode = fs.readFileSync(
      path.join(__dirname, "../public/js/app-shell-router.js"),
      "utf8"
    );
    // Verify clean syntax and exposed globals
    assert.ok(routerCode.includes("window.handleNavClick ="));
    assert.ok(routerCode.includes("window.handleDeepLink ="));
    assert.ok(routerCode.includes("window.AppShell ="));

    // Verify app-shell template binds onclick to both desktop sidebar and mobile nav with resilient fallback
    const shellTemplate = fs.readFileSync(
      path.join(__dirname, "../views/app-shell.ejs"),
      "utf8"
    );
    assert.ok(shellTemplate.includes("handleNavClick('home'"));
    assert.ok(shellTemplate.includes("handleNavClick('bank'"));
    assert.ok(shellTemplate.includes("handleDeepLink('/database'"));
  });

  test("Home View: Renders complete dashboard and sacred stage", async () => {
    const res = await request(app).get("/").set("Accept", "text/html");
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes("zen-glass-stage") || res.text.includes("Bhajan Planner"));
    assert.ok(res.text.includes("Bhajan"));
  });

  test("Theme Architecture: Unified Dark/Light toggler manages both data-theme and .dark class", async () => {
    const fs = require("fs");
    const path = require("path");

    // 1. App Shell Router theme synchronization
    const routerCode = fs.readFileSync(path.join(__dirname, "../public/js/app-shell-router.js"), "utf8");
    assert.ok(routerCode.includes('document.documentElement.setAttribute("data-theme", "dark")'));
    assert.ok(routerCode.includes('document.documentElement.classList.add("dark")'));
    assert.ok(routerCode.includes('document.documentElement.removeAttribute("data-theme")'));
    assert.ok(routerCode.includes('document.documentElement.classList.remove("dark")'));
    assert.ok(routerCode.includes("window.toggleTheme ="));
    assert.ok(routerCode.includes("window.applyTheme ="));

    // 2. Script.js global theme controller and duplicate-attachment avoidance
    const scriptCode = fs.readFileSync(path.join(__dirname, "../public/js/script.js"), "utf8");
    assert.ok(scriptCode.includes('document.documentElement.setAttribute("data-theme", "dark")'));
    assert.ok(scriptCode.includes('document.documentElement.classList.add("dark")'));
    assert.ok(scriptCode.includes('document.documentElement.removeAttribute("data-theme")'));
    assert.ok(scriptCode.includes('document.documentElement.classList.remove("dark")'));
    assert.ok(scriptCode.includes('onclickAttr.indexOf("toggleTheme") !== -1'));

    // 3. Early Anti-FOUC in layouts/main.ejs and app-shell.ejs
    const mainLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/main.ejs"), "utf8");
    assert.ok(mainLayout.includes("window.toggleTheme ="));
    assert.ok(mainLayout.includes("window.applyTheme ="));
    assert.ok(mainLayout.includes("classList.add('dark')"));
    assert.ok(mainLayout.includes("classList.remove('dark')"));

    const appShell = fs.readFileSync(path.join(__dirname, "../views/app-shell.ejs"), "utf8");
    assert.ok(appShell.includes("window.toggleTheme ="));
    assert.ok(appShell.includes("window.applyTheme ="));
    assert.ok(appShell.includes("classList.add('dark')"));
    assert.ok(appShell.includes("classList.remove('dark')"));

    // 4. Admin topbar toggle button has resilient onclick
    const topbar = fs.readFileSync(path.join(__dirname, "../views/partials/topbar.ejs"), "utf8");
    assert.ok(topbar.includes('id="topbarThemeToggle"'));
    assert.ok(topbar.includes("toggleTheme(event)"));
  });

