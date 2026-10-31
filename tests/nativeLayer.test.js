const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const MasterBhajan = require("../models/MasterBhajan");

test("Native Layer: native.css is loaded last in both app-shell and main layouts", () => {
  const mainLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/main.ejs"), "utf8");
  const appShell = fs.readFileSync(path.join(__dirname, "../views/app-shell.ejs"), "utf8");

  function assertNativeIsLastCss(content, layoutName) {
    const cssLinks = Array.from(content.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi))
      .map((m) => m[0]);
    assert.ok(cssLinks.length > 0, `${layoutName} should have stylesheet links`);
    const lastCss = cssLinks[cssLinks.length - 1];
    assert.ok(
      lastCss.includes("/css/native.css"),
      `In ${layoutName}, native.css should be the last loaded stylesheet, got: ${lastCss}`
    );
  }

  assertNativeIsLastCss(mainLayout, "views/layouts/main.ejs");
  assertNativeIsLastCss(appShell, "views/app-shell.ejs");
});

test("Native Layer: Google Fonts use non-blocking preload with noscript fallback in both layouts", () => {
  const mainLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/main.ejs"), "utf8");
  const appShell = fs.readFileSync(path.join(__dirname, "../views/app-shell.ejs"), "utf8");

  [mainLayout, appShell].forEach((content) => {
    assert.ok(
      content.includes('rel="preload" as="style"'),
      "Should contain non-blocking font preload link"
    );
    assert.ok(
      content.includes("fonts.googleapis.com"),
      "Should reference Google Fonts"
    );
    assert.ok(
      content.includes("<noscript>"),
      "Should include noscript fallback for font stylesheet"
    );
  });
});

test("Native Layer: Service Worker precache list includes native.css and native-ui.js", () => {
  const swCode = fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
  assert.ok(
    swCode.includes('"/css/native.css?v=6.5"'),
    "Service Worker should precache native.css"
  );
  assert.ok(
    swCode.includes('"/js/native-ui.js?v=6.5"'),
    "Service Worker should precache native-ui.js"
  );
  assert.ok(
    !swCode.includes("compatibility"),
    "Service Worker should have removed CACHE_VERSION compatibility comment"
  );
});

test("Native Layer: Manifest and meta theme-color match primary color", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../public/manifest.json"), "utf8")
  );
  const mainLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/main.ejs"), "utf8");

  assert.strictEqual(manifest.theme_color, "#FAF7F2");
  assert.strictEqual(manifest.background_color, "#FAF7F2");
  assert.strictEqual(manifest.lang, "en");
  assert.strictEqual(manifest.dir, "ltr");
  assert.deepStrictEqual(manifest.display_override, ["standalone", "minimal-ui"]);
  assert.strictEqual(manifest.prefer_related_applications, false);
  assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length === 3);

  assert.ok(
    mainLayout.includes('name="theme-color" content="#FAF7F2"'),
    "Main layout primary meta theme-color should match manifest"
  );
  assert.ok(
    mainLayout.includes('name="apple-mobile-web-app-title" content="Bhajan Planner"'),
    "Main layout should declare apple-mobile-web-app-title"
  );
  assert.ok(
    mainLayout.includes('name="format-detection" content="telephone=no"'),
    "Main layout should disable automatic phone number detection"
  );
  assert.ok(
    mainLayout.includes('name="color-scheme" content="light dark"'),
    "Main layout should declare color-scheme"
  );
});

test("Native Layer: Every table with data-mobile-cards has a thead element", () => {
  const viewsDir = path.join(__dirname, "../views");

  function findEjsFiles(dir) {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(findEjsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ejs")) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const ejsFiles = findEjsFiles(viewsDir);
  let cardTablesFound = 0;

  ejsFiles.forEach((file) => {
    const content = fs.readFileSync(file, "utf8");
    if (!content.includes("data-mobile-cards")) return;

    const tableMatches = content.matchAll(/<table[^>]*data-mobile-cards[^>]*>([\s\S]*?)<\/table>/gi);
    for (const match of tableMatches) {
      cardTablesFound++;
      const innerTable = match[1];
      assert.ok(
        /<thead[\s>]/i.test(innerTable),
        `Table with data-mobile-cards in ${path.relative(viewsDir, file)} must contain a <thead>`
      );
    }
  });

  assert.ok(cardTablesFound >= 9, `Expected at least 9 data-mobile-cards tables, found ${cardTablesFound}`);
});

test("Native Layer: Master Bank catalog JSON omits raw lyrics and exposes has_lyrics flag", () => {
  const masterBankEjs = fs.readFileSync(path.join(__dirname, "../views/master-bank.ejs"), "utf8");
  assert.ok(
    masterBankEjs.includes("has_lyrics: !!b.has_lyrics"),
    "Catalog JSON in master-bank.ejs should project has_lyrics boolean"
  );
  assert.ok(
    !masterBankEjs.includes("lyrics: b.lyrics || ''"),
    "Catalog JSON in master-bank.ejs must not project lyrics: b.lyrics || ''"
  );
});

test("Native Layer: Master Bank renders max 24 initial SSR cards and guards admin modal", async () => {
  const masterBankEjs = fs.readFileSync(path.join(__dirname, "../views/master-bank.ejs"), "utf8");
  assert.ok(
    masterBankEjs.includes("const INITIAL_RENDER = 24"),
    "master-bank.ejs should define const INITIAL_RENDER = 24"
  );
  assert.ok(
    masterBankEjs.includes("<% if (isAdmin) { %>") && masterBankEjs.includes("adminEditBhajanModal"),
    "adminEditBhajanModal should be wrapped in <% if (isAdmin) { %>"
  );

  // Assert public request does not render adminEditBhajanModal
  const res = await request(app).get("/master-bank");
  assert.strictEqual(res.status, 200);
  assert.ok(
    !res.text.includes('id="adminEditBhajanModal"'),
    "Public master bank response must not contain adminEditBhajanModal"
  );
});

test("Native Layer: /api/bhajan/:id/lyrics returns JSON lyrics without full page overhead", async () => {
  const { invalidateMasterCache } = require("../services/catalogCache");
  const mb = await MasterBhajan.findOne({ where: { is_active: true } });
  assert.ok(mb, "Should find at least one active MasterBhajan");

  // Update with known sample lyrics for test verification
  await mb.update({ lyrics: "Sample sacred devotional lyrics line 1\nLine 2", has_lyrics: true });
  invalidateMasterCache();

  const res = await request(app).get(`/api/bhajan/${mb.id}/lyrics`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers["content-type"].includes("application/json"), true);
  assert.strictEqual(res.body.id, mb.id);
  assert.ok("lyrics" in res.body);
  assert.ok(res.body.lyrics.includes("Sample sacred devotional lyrics"));
});

test("Native Layer: singer-login fragment does not leak top-level variables and uses unique IDs", () => {
  const singerLoginEjs = fs.readFileSync(path.join(__dirname, "../views/singer-login.ejs"), "utf8");

  // Script must be wrapped in IIFE or block scope
  assert.ok(
    singerLoginEjs.includes("(function()") || singerLoginEjs.includes("(function ()"),
    "singer-login.ejs script must be scoped in an IIFE"
  );
  // Must generate unique instance UID to avoid duplicate ID collisions
  assert.ok(
    singerLoginEjs.includes("uid"),
    "singer-login.ejs must generate an instance uid"
  );
  // Scoped to root container
  assert.ok(
    singerLoginEjs.includes("data-singer-login-root"),
    "singer-login.ejs must scope handlers to data-singer-login-root"
  );
  // No inline onsubmit or onchange
  assert.ok(
    !singerLoginEjs.includes('onsubmit="'),
    "singer-login.ejs must not contain inline onsubmit handlers"
  );
});

test("Native Layer: App-shell router idle pre-warm does not mount inactive panes", () => {
  const routerCode = fs.readFileSync(path.join(__dirname, "../public/js/app-shell-router.js"), "utf8");

  // Verify scheduleIdlePrewarm does not call fetchAndMountFragment
  const prewarmFnMatch = routerCode.match(/function scheduleIdlePrewarm\(\)[\s\S]*?\n\s{2}\}/);
  assert.ok(prewarmFnMatch, "scheduleIdlePrewarm should exist in router");
  const prewarmBody = prewarmFnMatch[0];

  assert.ok(
    !prewarmBody.includes("fetchAndMountFragment"),
    "scheduleIdlePrewarm must NOT call fetchAndMountFragment (must prefetch only)"
  );
  assert.ok(
    prewarmBody.includes("prefetchRoute") || prewarmBody.includes("prefetchTab"),
    "scheduleIdlePrewarm should prefetch routes without mounting"
  );
  assert.ok(
    prewarmBody.includes("saveData") || routerCode.includes("navigator.connection"),
    "Idle prewarm should check navigator.connection and saveData"
  );
});
