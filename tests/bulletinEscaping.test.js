const test = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const { setupTestDb, sequelize } = require("./setup");

let app;
let Bulletin;
let Notification;
let repairEscapedBulletinTitles;

test.before(async () => {
  await setupTestDb();
  ({ app } = require("../app"));
  Bulletin = require("../models/Bulletin");
  Notification = require("../models/Notification");
  ({ repairEscapedBulletinTitles } = require("../services/databaseInitializer"));
});

function extractCsrf(html) {
  const metaMatch = html.match(/name="csrf-token"\s+content="([^"]+)"/i);
  if (metaMatch) return metaMatch[1];
  const inputMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return inputMatch ? inputMatch[1] : "";
}

async function loginAsAdmin() {
  const agent = request.agent(app);
  const getRes = await agent.get("/admin-login");
  const csrf = extractCsrf(getRes.text);
  const postRes = await agent
    .post("/admin-login")
    .type("form")
    .send({
      username: process.env.SUPER_ADMIN_USER || "testadmin",
      password: process.env.SUPER_ADMIN_PASS || "TestAdmin#12345",
      _csrf: csrf
    });
  assert.strictEqual(postRes.status, 200);
  return agent;
}

test("Bulletin titles are stored raw and rendered without double HTML-escaping", async () => {
  const adminAgent = await loginAsAdmin();
  const newFormRes = await adminAgent.get("/admin/bulletins/new");
  assert.strictEqual(newFormRes.status, 200);
  const createCsrf = extractCsrf(newFormRes.text);

  const rawTitle = 'Swami\'s Birthday & "Special" <Event>';

  const createRes = await adminAgent
    .post("/admin/bulletins")
    .type("form")
    .send({
      _csrf: createCsrf,
      title: rawTitle,
      content: "Beloved Bhagwan's Birthday",
      category: "event",
      status: "published",
      send_notification: "on"
    });
  assert.strictEqual(createRes.status, 302);

  const created = await Bulletin.findOne({
    where: { category: "event" },
    order: [["id", "DESC"]]
  });
  assert.ok(created, "Bulletin should be created in database");
  assert.strictEqual(created.title, rawTitle);

  const notif = await Notification.findOne({
    where: { event_key: `bulletin_published:${created.id}` }
  });
  assert.ok(notif, "Bulletin published notification should be created");
  assert.strictEqual(notif.title, `📢 ${rawTitle}`);

  const routesToCheck = [
    { name: "GET /", res: await request(app).get("/") },
    { name: "GET /bulletins", res: await request(app).get("/bulletins") },
    { name: "GET /bulletins/:id", res: await request(app).get(`/bulletins/${created.id}`) },
    { name: "GET /admin/bulletins", res: await adminAgent.get("/admin/bulletins") },
    {
      name: "GET /admin/bulletins/:id/edit",
      res: await adminAgent.get(`/admin/bulletins/${created.id}/edit`)
    }
  ];

  for (const { name, res } of routesToCheck) {
    assert.strictEqual(res.status, 200, `${name} should return 200`);
    assert.ok(!res.text.includes("&amp;#039;"), `${name} must not double-escape &#039;`);
    assert.ok(!res.text.includes("&amp;#39;"), `${name} must not double-escape &#39;`);
    assert.ok(!res.text.includes("&amp;amp;"), `${name} must not double-escape &amp;`);
    assert.ok(!res.text.includes("<Event>"), `${name} must not render raw <Event> tag`);
    assert.ok(res.text.includes("&lt;Event&gt;"), `${name} must single-escape <Event> tag`);
  }

  const editRes = routesToCheck[4].res;
  const editCsrf = extractCsrf(editRes.text);
  const updateRes = await adminAgent
    .post(`/admin/bulletins/${created.id}`)
    .type("form")
    .send({
      _csrf: editCsrf,
      title: rawTitle,
      content: "Updated Beloved Bhagwan's Birthday",
      category: "event",
      status: "published"
    });
  assert.strictEqual(updateRes.status, 302);

  await created.reload();
  assert.strictEqual(created.title, rawTitle);
});

test("repairEscapedBulletinTitles decodes legacy entities once and respects _app_meta guard", async () => {
  const b1 = await Bulletin.create({
    title: "Swami&#039;s Birthday Celebration!!",
    content: "Details",
    category: "event",
    status: "published",
    published_at: new Date()
  });
  const b2 = await Bulletin.create({
    title: "Swami&amp;#039;s &amp;amp; Friends",
    content: "Details",
    category: "announcement",
    status: "published",
    published_at: new Date()
  });
  const n1 = await Notification.create({
    event_key: `test:bulletin_repair:${Date.now()}`,
    type: "bulletin_published",
    title: "📢 Swami&#039;s Birthday Celebration!!",
    body: "Details",
    link: `/bulletins/${b1.id}`
  });

  await sequelize.query("DELETE FROM _app_meta WHERE key = 'bulletin_title_entity_cleanup_v1'");
  await repairEscapedBulletinTitles();

  await b1.reload();
  await b2.reload();
  await n1.reload();

  assert.strictEqual(b1.title, "Swami's Birthday Celebration!!");
  assert.strictEqual(b2.title, "Swami's & Friends");
  assert.strictEqual(n1.title, "📢 Swami's Birthday Celebration!!");

  const sentinel = await Bulletin.create({
    title: "Sentinel&#039;s Title",
    content: "Details",
    category: "announcement",
    status: "draft"
  });

  await repairEscapedBulletinTitles();
  await sentinel.reload();
  assert.strictEqual(
    sentinel.title,
    "Sentinel&#039;s Title",
    "Subsequent repairEscapedBulletinTitles calls must skip after _app_meta marker is set"
  );
});
