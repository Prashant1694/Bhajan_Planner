const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");
const request = require("supertest");
const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const { isDevelopmentPwa, getPwaMetadata } = require("../services/pwaConfig");

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("PWA Config: resolves development variant from Railway branch, environment, or dev hostname", () => {
  withEnv(
    {
      PWA_APP_VARIANT: undefined,
      RAILWAY_GIT_BRANCH: undefined,
      RAILWAY_ENVIRONMENT_NAME: undefined,
      RAILWAY_ENVIRONMENT: undefined,
      RAILWAY_SERVICE_NAME: undefined
    },
    () => {
      assert.strictEqual(isDevelopmentPwa(), false);

      withEnv({ RAILWAY_GIT_BRANCH: "develop" }, () => {
        assert.strictEqual(isDevelopmentPwa(), true);
        assert.strictEqual(getPwaMetadata().manifestPath, "/manifest.dev.json");
      });

      withEnv({ RAILWAY_GIT_BRANCH: "main", RAILWAY_ENVIRONMENT_NAME: "develop" }, () => {
        // Explicit main branch must remain production even if another field mentions develop
        assert.strictEqual(isDevelopmentPwa(), false);
      });

      withEnv({ PWA_APP_VARIANT: "production", RAILWAY_GIT_BRANCH: "develop" }, () => {
        assert.strictEqual(isDevelopmentPwa(), false);
      });

      withEnv({ PWA_APP_VARIANT: "development" }, () => {
        assert.strictEqual(isDevelopmentPwa(), true);
      });

      withEnv({ RAILWAY_ENVIRONMENT_NAME: "development" }, () => {
        assert.strictEqual(isDevelopmentPwa(), true);
      });

      assert.strictEqual(
        isDevelopmentPwa({ hostname: "bhajan-planner-develop.up.railway.app" }),
        true
      );
      assert.strictEqual(
        isDevelopmentPwa({ hostname: "bhajan-planner.up.railway.app" }),
        false
      );
    }
  );
});

test("PWA Manifest: manifest.dev.json has distinct identity and existing PNG icons", () => {
  const devManifestPath = path.join(__dirname, "../public/manifest.dev.json");
  const devManifest = JSON.parse(fs.readFileSync(devManifestPath, "utf8"));

  assert.strictEqual(devManifest.name, "Bhajan Planner DEV");
  assert.strictEqual(devManifest.short_name, "Bhajan DEV");
  assert.strictEqual(devManifest.id, "bhajan-planner-dev-ssso-gn");
  assert.ok(Array.isArray(devManifest.icons) && devManifest.icons.length === 3);

  const purposes = devManifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
  assert.deepStrictEqual(purposes, [
    "192x192:any",
    "512x512:any",
    "512x512:maskable"
  ]);

  for (const icon of devManifest.icons) {
    const filePath = path.join(__dirname, "../public", icon.src);
    assert.ok(fs.existsSync(filePath), `Icon file should exist: ${icon.src}`);
  }

  const appleTouchPath = path.join(__dirname, "../public/images/icons/dev/apple-touch-icon.png");
  assert.ok(fs.existsSync(appleTouchPath), "Dev apple-touch-icon.png should exist");
});

test("PWA Templates: app-shell.ejs and main.ejs switch manifest and icons for development", async () => {
  const devPwa = withEnv({ PWA_APP_VARIANT: "development" }, () => getPwaMetadata());
  const prodPwa = withEnv({ PWA_APP_VARIANT: "production" }, () => getPwaMetadata());

  const appShellPath = path.join(__dirname, "../views/app-shell.ejs");
  const appShellDevHtml = await ejs.renderFile(appShellPath, {
    pageTitle: "Bhajan Planner DEV",
    initialTab: "home",
    initialRoute: "/",
    currentAdmin: null,
    currentSinger: null,
    initialFragmentHtml: "<div>ok</div>",
    initialPageCss: "",
    isDevelopmentPwa: devPwa.isDevelopmentPwa,
    pwa: devPwa,
    csrfToken: "test-csrf"
  });

  assert.ok(appShellDevHtml.includes('href="/manifest.dev.json"'));
  assert.ok(appShellDevHtml.includes('href="/images/icons/dev/icon-192x192.png"'));
  assert.ok(appShellDevHtml.includes('href="/images/icons/dev/apple-touch-icon.png"'));
  assert.ok(appShellDevHtml.includes('name="bp-pwa-variant" content="development"'));
  assert.ok(appShellDevHtml.includes('name="apple-mobile-web-app-title" content="Bhajan DEV"'));
  assert.ok(appShellDevHtml.includes('src="/images/icons/dev/icon-192x192.png"'));

  const appShellProdHtml = await ejs.renderFile(appShellPath, {
    pageTitle: "Bhajan Planner",
    initialTab: "home",
    initialRoute: "/",
    currentAdmin: null,
    currentSinger: null,
    initialFragmentHtml: "<div>ok</div>",
    initialPageCss: "",
    isDevelopmentPwa: prodPwa.isDevelopmentPwa,
    pwa: prodPwa,
    csrfToken: "test-csrf"
  });

  assert.ok(appShellProdHtml.includes('href="/manifest.json"'));
  assert.ok(appShellProdHtml.includes('href="/images/icons/icon-192x192.png"'));
  assert.ok(appShellProdHtml.includes('name="bp-pwa-variant" content="production"'));
  assert.ok(appShellProdHtml.includes('name="apple-mobile-web-app-title" content="Bhajan Planner"'));
});

test("PWA HTTP: manifest.dev.json and dev icons serve without stale manifest caching", async () => {
  const manifestRes = await request(app).get("/manifest.dev.json");
  assert.strictEqual(manifestRes.status, 200);
  assert.ok(String(manifestRes.headers["cache-control"] || "").includes("no-store"));

  const swRes = await request(app).get("/sw.js");
  assert.strictEqual(swRes.status, 200);
  assert.ok(String(swRes.headers["cache-control"] || "").includes("no-store"));

  for (const iconUrl of [
    "/images/icons/dev/icon-192x192.png",
    "/images/icons/dev/icon-512x512.png",
    "/images/icons/dev/icon-maskable-512x512.png",
    "/images/icons/dev/apple-touch-icon.png"
  ]) {
    const iconRes = await request(app).get(iconUrl);
    assert.strictEqual(iconRes.status, 200, `${iconUrl} should return 200`);
    assert.ok(
      String(iconRes.headers["content-type"] || "").includes("image/png"),
      `${iconUrl} should serve image/png`
    );
  }
});

