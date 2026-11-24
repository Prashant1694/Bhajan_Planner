const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("stream");
const { URLSearchParams } = require("url");
const { setupTestDb } = require("./setup");

let app;
let MasterBhajan;
let syncMasterBhajans;

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

async function loginAs(username, password) {
  const loginPage = await invokeApp("GET", "/admin-login");
  let cookies = mergeCookies([], loginPage.headers["set-cookie"]);
  const csrfMatch = loginPage.text.match(/name="csrf-token"\s+content="([^"]+)"/i);
  const csrf = csrfMatch ? csrfMatch[1] : "";

  const formBody = new URLSearchParams({
    username,
    password,
    _csrf: csrf
  }).toString();

  const loginRes = await invokeApp("POST", "/admin-login", {
    cookies,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody
  });
  cookies = mergeCookies(cookies, loginRes.headers["set-cookie"]);
  assert.ok(
    loginRes.status === 200 || loginRes.status === 302,
    `Expected login success for ${username}, got ${loginRes.status}`
  );

  const dash = await invokeApp("GET", "/admin", { cookies });
  const postCsrfMatch = dash.text.match(/name="csrf-token"\s+content="([^"]+)"/i);
  return { cookies, csrf: postCsrfMatch ? postCsrfMatch[1] : csrf };
}

test("Master Bank permissions enforce super_admin for add/delete while preserving admin edit rights", async (t) => {
  await setupTestDb();
  ({ app } = require("../app"));
  MasterBhajan = require("../models/MasterBhajan");
  syncMasterBhajans = require("../services/databaseInitializer").syncMasterBhajans;

  const regularAuth = await loginAs("regular_admin", "AdminPass#12345");
  const superAuth = await loginAs(
    process.env.SUPER_ADMIN_USER || "testadmin",
    process.env.SUPER_ADMIN_PASS || "TestAdmin#12345"
  );

  const existing = await MasterBhajan.findOne({ where: { is_active: true } });
  assert.ok(existing, "Expected seeded active master bhajan");
  const originalTitle = existing.title;

  await t.test("Regular Admin cannot add or delete Master Bank bhajans (403), but CAN edit them (200)", async () => {
    const addRes = await invokeApp("POST", "/api/add-master-bhajan", {
      cookies: regularAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": regularAuth.csrf
      },
      body: {
        title: "Unauthorized Admin Add",
        deity: "Ganesha",
        tempo: "Medium"
      }
    });
    assert.equal(addRes.status, 403);
    const addJson = JSON.parse(addRes.text);
    assert.equal(addJson.success, false);
    assert.match(addJson.error, /Super Admin/i);

    const createdCheck = await MasterBhajan.findOne({ where: { title: "Unauthorized Admin Add" } });
    assert.equal(createdCheck, null);

    const delRes = await invokeApp("POST", `/api/admin/delete-master-bhajan/${existing.id}`, {
      cookies: regularAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": regularAuth.csrf
      },
      body: {}
    });
    assert.equal(delRes.status, 403);
    const delJson = JSON.parse(delRes.text);
    assert.equal(delJson.success, false);

    await existing.reload();
    assert.equal(existing.is_active, true);

    const editRes = await invokeApp("POST", `/api/admin/update-master-bhajan/${existing.id}`, {
      cookies: regularAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": regularAuth.csrf
      },
      body: {
        title: `${originalTitle} (Admin Edited)`,
        deity: existing.deity || "Ganesha",
        tempo: existing.tempo || "Medium",
        raga: existing.raga || "",
        level: existing.level || "simple",
        shruti: existing.shruti || "",
        shruti_female: existing.shruti_female || "",
        language: existing.language || "",
        lyrics: existing.lyrics || ""
      }
    });
    assert.equal(editRes.status, 200);
    const editJson = JSON.parse(editRes.text);
    assert.equal(editJson.success, true);

    await existing.reload();
    assert.equal(existing.title, `${originalTitle} (Admin Edited)`);
  });

  await t.test("Super Admin can add, edit, and delete Master Bank bhajans", async () => {
    const addRes = await invokeApp("POST", "/api/add-master-bhajan", {
      cookies: superAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": superAuth.csrf
      },
      body: {
        title: "Super Admin Added Bhajan",
        deity: "Sai",
        tempo: "Slow",
        raga: "Yaman",
        language: "Hindi",
        lyrics: "Sai Bhajan Lyrics"
      }
    });
    assert.equal(addRes.status, 200);
    const addJson = JSON.parse(addRes.text);
    assert.equal(addJson.success, true);
    assert.ok(addJson.bhajan && addJson.bhajan.id, "Created bhajan returned in response");

    const createdId = addJson.bhajan.id;

    // Simulate the bundled master-catalog synchronization that runs on every
    // application startup/redeployment. User-created rows must remain active.
    await syncMasterBhajans();
    const afterStartupSync = await MasterBhajan.findByPk(createdId);
    assert.ok(afterStartupSync, "Super-admin bhajan must survive startup catalog sync");
    assert.equal(afterStartupSync.is_active, true, "Startup sync must not archive user-created bhajans");

    const editRes = await invokeApp("POST", `/api/admin/update-master-bhajan/${createdId}`, {
      cookies: superAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": superAuth.csrf
      },
      body: {
        title: "Super Admin Edited Bhajan",
        deity: "Sai",
        tempo: "Medium"
      }
    });
    assert.equal(editRes.status, 200);
    const editJson = JSON.parse(editRes.text);
    assert.equal(editJson.success, true);

    const delRes = await invokeApp("POST", `/api/admin/delete-master-bhajan/${createdId}`, {
      cookies: superAuth.cookies,
      headers: {
        "content-type": "application/json",
        "x-csrf-token": superAuth.csrf
      },
      body: {}
    });
    assert.equal(delRes.status, 200);
    const delJson = JSON.parse(delRes.text);
    assert.equal(delJson.success, true);

    const archived = await MasterBhajan.findByPk(createdId);
    assert.equal(archived.is_active, false);
  });

  await t.test("Master Bank and Missing Catcher views hide Add/Delete for regular admins and show them for super admins", async () => {
    const regMaster = await invokeApp("GET", "/master-bank", { cookies: regularAuth.cookies });
    assert.equal(regMaster.status, 200);
    assert.match(regMaster.text, /window\.IS_ADMIN_MASTER_BANK\s*=\s*true/);
    assert.match(regMaster.text, /window\.IS_SUPERADMIN_MASTER_BANK\s*=\s*false/);
    assert.match(regMaster.text, /class="admin-action-btn admin-btn-edit"/);
    const regMasterHtmlBody = regMaster.text.split('<script id="allMasterBhajansData"')[0];
    assert.ok(!regMaster.text.includes('id="btnAddMasterBhajan"'), "Regular admin must not see Add Bhajan button");
    assert.ok(
      !regMasterHtmlBody.includes('class="admin-action-btn admin-btn-delete"'),
      "Regular admin SSR cards must not include Delete buttons"
    );

    const supMaster = await invokeApp("GET", "/master-bank", { cookies: superAuth.cookies });
    assert.equal(supMaster.status, 200);
    assert.match(supMaster.text, /window\.IS_SUPERADMIN_MASTER_BANK\s*=\s*true/);
    assert.ok(supMaster.text.includes('id="btnAddMasterBhajan"'), "Super admin must see Add Bhajan button");
    const supMasterHtmlBody = supMaster.text.split('<script id="allMasterBhajansData"')[0];
    assert.ok(
      supMasterHtmlBody.includes('class="admin-action-btn admin-btn-delete"'),
      "Super admin SSR cards must include Delete buttons"
    );

    const regMissing = await invokeApp("GET", "/admin/missing-bhajans", { cookies: regularAuth.cookies });
    assert.equal(regMissing.status, 200);
    assert.match(regMissing.text, /IS_SUPERADMIN_MISSING_CATCHER\s*=\s*false/);
    assert.ok(!regMissing.text.includes('id="missingBhajanModal"'));

    const supMissing = await invokeApp("GET", "/admin/missing-bhajans", { cookies: superAuth.cookies });
    assert.equal(supMissing.status, 200);
    assert.match(supMissing.text, /IS_SUPERADMIN_MISSING_CATCHER\s*=\s*true/);
    assert.ok(supMissing.text.includes('id="missingBhajanModal"'));
  });
});
