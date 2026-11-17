const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("stream");
const { URLSearchParams } = require("url");
const { setupTestDb } = require("./setup");

let app;
let BhajanSubmission;
let MasterBhajan;

function invokeApp(method, url, { headers = {}, body = null, cookies = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    req.url = url;
    req.originalUrl = url;
    req.method = method;
    req.headers = Object.assign({ host: "localhost:8000", accept: "application/json,text/html" }, headers);
    if (cookies.length > 0) {
      req.headers.cookie = cookies.join("; ");
    }
    req.connection = { remoteAddress: "127.0.0.1" };
    req.socket = req.connection;

    if (body !== null) {
      const payload = typeof body === "string" ? body : JSON.stringify(body);
      req.headers["content-length"] = String(Buffer.byteLength(payload));
      process.nextTick(() => {
        req.push(Buffer.from(payload));
        req.push(null);
      });
    } else {
      process.nextTick(() => req.push(null));
    }

    const resHeaders = {};
    const chunks = [];
    const res = new PassThrough();
    res.statusCode = 200;
    res.setHeader = (k, v) => {
      resHeaders[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => resHeaders[k.toLowerCase()];
    res.removeHeader = (k) => {
      delete resHeaders[k.toLowerCase()];
    };
    res.getHeaders = () => resHeaders;
    res.writeHead = (code, h) => {
      res.statusCode = code;
      if (h) Object.assign(resHeaders, h);
    };
    res.write = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const buf = Buffer.concat(chunks);
      resolve({ status: res.statusCode, headers: resHeaders, text: buf.toString("utf8") });
    };

    app(req, res, (err) => {
      if (err) reject(err);
    });
  });
}

function mergeCookies(existing, setCookieHeader) {
  const map = new Map();
  existing.forEach((c) => {
    const idx = c.indexOf("=");
    if (idx > 0) map.set(c.slice(0, idx), c);
  });
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  list.forEach((raw) => {
    const pair = String(raw).split(";")[0];
    const idx = pair.indexOf("=");
    if (idx > 0) map.set(pair.slice(0, idx), pair);
  });
  return Array.from(map.values());
}

async function loginAsAdmin() {
  const loginPage = await invokeApp("GET", "/admin-login");
  let cookies = mergeCookies([], loginPage.headers["set-cookie"]);
  const csrfMatch = loginPage.text.match(/name="csrf-token"\s+content="([^"]+)"/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";

  const formBody = new URLSearchParams({
    username: process.env.SUPER_ADMIN_USER || "testadmin",
    password: process.env.SUPER_ADMIN_PASS || "TestAdmin#12345",
    _csrf: csrf
  }).toString();

  const postRes = await invokeApp("POST", "/admin-login", {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody,
    cookies
  });
  assert.strictEqual(postRes.status, 200);
  cookies = mergeCookies(cookies, postRes.headers["set-cookie"]);
  return { cookies, csrf };
}

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  BhajanSubmission = require("../models/BhajanSubmission");
  MasterBhajan = require("../models/MasterBhajan");

  await BhajanSubmission.create({
    session_date: "2026-11-19",
    singer_name: "Test Singer",
    deity: "Ganesha",
    title: "Ganapathi Bappa Typo Unlinked",
    scale: "5.5P",
    speed: "Medium",
    list_order: 1
  });
});

test("Missing Bhajan search endpoint requires admin auth", async () => {
  const unauthPage = await invokeApp("GET", "/admin/missing-bhajans");
  assert.strictEqual(unauthPage.status, 302);
  assert.ok(String(unauthPage.headers.location).includes("/admin-login"));

  const unauthSearch = await invokeApp("GET", "/api/admin/master-bhajans/search?q=gana");
  assert.strictEqual(unauthSearch.status, 401);
});

test("Simplified Missing Bhajan Catcher renders per-bhajan search without fuzzy matching and links exact match", async () => {
  const { cookies, csrf } = await loginAsAdmin();

  const missingRes = await invokeApp("GET", "/admin/missing-bhajans", { cookies });
  assert.strictEqual(missingRes.status, 200);
  assert.ok(missingRes.text.includes("Ganapathi Bappa Typo Unlinked"));
  assert.ok(missingRes.text.includes("mb-master-search-input"));
  assert.ok(!missingRes.text.includes("% match"));
  assert.ok(!missingRes.text.includes("With Auto-Matches"));

  const emptySearch = await invokeApp("GET", "/api/admin/master-bhajans/search?q=", { cookies });
  assert.strictEqual(emptySearch.status, 200);
  assert.deepStrictEqual(JSON.parse(emptySearch.text), { results: [] });

  const master = await MasterBhajan.findOne({ where: { is_active: true }, raw: true });
  assert.ok(master && master.title);
  const queryToken = master.title.split(/\s+/).find((w) => w.length >= 3) || master.title.slice(0, 4);

  const searchRes = await invokeApp(
    "GET",
    `/api/admin/master-bhajans/search?q=${encodeURIComponent(queryToken)}`,
    { cookies }
  );
  assert.strictEqual(searchRes.status, 200);
  const searchJson = JSON.parse(searchRes.text);
  assert.ok(Array.isArray(searchJson.results) && searchJson.results.length > 0);
  assert.ok(searchJson.results.some((r) => r.id === master.id));

  const linkRes = await invokeApp("POST", "/api/admin/reconcile-bhajan", {
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf
    },
    body: {
      submitted_title: "Ganapathi Bappa Typo Unlinked",
      action: "link",
      master_bhajan_id: master.id
    },
    cookies
  });
  assert.strictEqual(linkRes.status, 200);
  const linkJson = JSON.parse(linkRes.text);
  assert.strictEqual(linkJson.success, true);
  assert.strictEqual(linkJson.updatedCount, 1);
  assert.strictEqual(linkJson.masterTitle, master.title);

  const afterMissingRes = await invokeApp("GET", "/admin/missing-bhajans", { cookies });
  assert.strictEqual(afterMissingRes.status, 200);
  assert.ok(!afterMissingRes.text.includes("Ganapathi Bappa Typo Unlinked"));
});
