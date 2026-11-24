const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const request = require("supertest");
const WebSocket = require("ws");

const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const liveStreamService = require("../services/liveStreamService");
const LiveStream = require("../models/LiveStream");

const ROOT = path.join(__dirname, "..");

function extractCsrf(html) {
  const m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/);
  if (m) return m[1];
  const i = html.match(/name=["']_csrf["']\s+value=["']([^"']+)["']/);
  return i ? i[1] : "";
}

async function loginAdminAgent(baseAppOrUrl) {
  const agent = request.agent(baseAppOrUrl);
  const lp = await agent.get("/admin-login");
  const csrf = extractCsrf(lp.text);
  const res = await agent
    .post("/admin-login")
    .type("form")
    .send({
      username: process.env.SUPER_ADMIN_USER || "testadmin",
      password: process.env.SUPER_ADMIN_PASS || "TestAdmin#12345",
      _csrf: csrf
    });
  assert.strictEqual(res.status, 200);
  const dash = await agent.get("/admin");
  assert.strictEqual(dash.status, 200);
  return { agent, csrf: extractCsrf(dash.text) };
}

function encodeSampleStereoMp3(kbps = 320) {
  const code = fs.readFileSync(path.join(ROOT, "public", "js", "vendor", "lame.min.js"), "utf8");
  const ctx = { console };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.runInNewContext(code, ctx);
  const Mp3Encoder = (ctx.lamejs && ctx.lamejs.Mp3Encoder) || ctx.Mp3Encoder;
  const encoder = new Mp3Encoder(2, 48000, kbps);

  const left = new Int16Array(2304);
  const right = new Int16Array(2304);
  for (let i = 0; i < 2304; i++) {
    left[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 14000);
    right[i] = Math.round(Math.sin((2 * Math.PI * 660 * i) / 48000) * 14000);
  }
  const part1 = Buffer.from(encoder.encodeBuffer(left, right));
  const part2 = Buffer.from(encoder.flush());
  return Buffer.concat([part1, part2]);
}

test.after(async () => {
  await liveStreamService.stopStream().catch(() => {});
  liveStreamService.shutdownLiveStream();
});

test("Encoder bundle: self-hosted lame.min.js encodes 48kHz stereo 320kbps valid MP3 frames", () => {
  const mp3 = encodeSampleStereoMp3(320);
  assert.ok(mp3.length > 500, "Expected non-trivial encoded MP3 output");
  const syncOffset = liveStreamService.findMpegSyncOffset(mp3);
  assert.ok(syncOffset >= 0, "Encoded MP3 must contain valid MPEG frame sync header");
});

test("Live Stream RBAC & Security Headers: non-admin blocked, microphone allowed strictly on /admin/live-stream", async () => {
  const unauthStudio = await request(app).get("/admin/live-stream");
  assert.strictEqual(unauthStudio.status, 302);
  assert.strictEqual(unauthStudio.headers.location, "/admin-login");

  const unauthStart = await request(app).post("/api/admin/live-stream/start").send({});
  assert.strictEqual(unauthStart.status, 403); // CSRF check or 401 before session

  const publicHome = await request(app).get("/");
  assert.ok(
    (publicHome.headers["permissions-policy"] || "").includes("microphone=()"),
    "Public routes must keep microphone disabled"
  );
  assert.ok(
    (publicHome.headers["content-security-policy"] || "").includes("wss:"),
    "CSP connect-src must permit wss: WebSockets"
  );

  const { agent } = await loginAdminAgent(app);
  const studioRes = await agent.get("/admin/live-stream");
  assert.strictEqual(studioRes.status, 200);
  assert.ok(
    (studioRes.headers["permissions-policy"] || "").includes("microphone=(self)"),
    "Admin live studio must allow microphone=(self)"
  );
  assert.ok(studioRes.text.includes("Live Stream Broadcast Studio"));
  assert.ok(studioRes.text.includes("live-stream-studio.js"));
});

test("Live Stream Presets CRUD: list built-ins, save custom preset, delete custom preset", async () => {
  const { agent, csrf } = await loginAdminAgent(app);

  const list1 = await agent.get("/api/admin/live-stream/presets");
  assert.strictEqual(list1.status, 200);
  assert.ok(Array.isArray(list1.body.presets));
  assert.ok(list1.body.presets.some((p) => p.isBuiltIn && p.name === "Mandir Bhajan Studio"));

  const saveRes = await agent
    .post("/api/admin/live-stream/presets")
    .set("X-CSRF-Token", csrf)
    .send({
      name: "Thursday Mandir Test Preset",
      config: { mode: "split", inst: { gain: 95 }, vocal: { gain: 115 } }
    });
  assert.strictEqual(saveRes.status, 200);
  assert.strictEqual(saveRes.body.success, true);
  assert.ok(saveRes.body.preset.dbId);

  const delRes = await agent
    .delete(`/api/admin/live-stream/presets/${saveRes.body.preset.dbId}`)
    .set("X-CSRF-Token", csrf);
  assert.strictEqual(delRes.status, 200);
  assert.strictEqual(delRes.body.success, true);
});

test("Live Stream E2E: WebSocket 320kbps MP3 ingest, aligned burst, multi-listener fan-out, Now Singing SSE & singers_only ACL", async () => {
  const server = http.createServer(app);
  liveStreamService.attachLiveStreamWebSocket(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const { agent, csrf } = await loginAdminAgent(baseUrl);

    // 1. Unauthorized WebSocket upgrade must fail
    await new Promise((resolve) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws/live-stream/ingest?token=invalidtoken`);
      badWs.on("unexpected-response", (req, res) => {
        assert.strictEqual(res.statusCode, 401);
        badWs.close();
        resolve();
      });
      badWs.on("error", () => resolve());
    });

    // 2. Start 320kbps public broadcast
    const startRes = await agent
      .post("/api/admin/live-stream/start")
      .set("X-CSRF-Token", csrf)
      .send({
        title: "Live E2E Test Bhajan",
        bitrate_kbps: 320,
        access_mode: "public",
        notify_devotees: false
      });
    assert.strictEqual(startRes.status, 200);
    assert.strictEqual(startRes.body.success, true);
    const { ingestToken, stream } = startRes.body;
    assert.ok(ingestToken);
    assert.strictEqual(stream.bitrateKbps, 320);

    const dbRow = await LiveStream.findByPk(stream.streamId);
    assert.strictEqual(dbRow.status, "live");

    // 3. Connect SSE client and verify live event arrival + Now Singing update
    const sseEvents = [];
    const sseReq = await new Promise((resolve) => {
      const r = http.get(`${baseUrl}/api/live-stream/events`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        res.on("data", (chunk) => sseEvents.push(chunk.toString("utf8")));
        resolve(r);
      });
    });

    const nowSingingRes = await agent
      .post("/api/admin/live-stream/now-singing")
      .set("X-CSRF-Token", csrf)
      .send({
        title: "Ganesha Vandana Live",
        singer_name: "Test Singer",
        master_id: 12
      });
    assert.strictEqual(nowSingingRes.status, 200);
    assert.strictEqual(nowSingingRes.body.nowSinging.title, "Ganesha Vandana Live");

    await new Promise((r) => setTimeout(r, 80));
    const joinedSse = sseEvents.join("");
    assert.ok(joinedSse.includes("Ganesha Vandana Live"), "SSE client must receive Now Singing update");
    sseReq.destroy();

    // 4. Connect authorized broadcaster WS & push garbage prefix + valid MP3 frame
    const broadcasterWs = await new Promise((resolve, reject) => {
      const sock = new WebSocket(
        `ws://127.0.0.1:${port}/ws/live-stream/ingest?token=${encodeURIComponent(ingestToken)}`
      );
      sock.on("open", () => resolve(sock));
      sock.on("error", reject);
    });

    const mp3Sample = encodeSampleStereoMp3(320);
    const prefixedBurst = Buffer.concat([Buffer.from([0x01, 0x02, 0x03, 0x04]), mp3Sample]);
    broadcasterWs.send(prefixedBurst);
    await new Promise((r) => setTimeout(r, 40));

    // 5. Connect two concurrent HTTP audio listeners and verify frame-aligned MP3 fan-out
    function openAudioListener() {
      return new Promise((resolve, reject) => {
        const chunks = [];
        let reqRef;
        reqRef = http.get(`${baseUrl}/api/live-stream/audio`, (res) => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Unexpected audio status: ${res.statusCode}`));
          }
          assert.strictEqual(res.headers["content-type"], "audio/mpeg");
          assert.strictEqual(res.headers["x-accel-buffering"], "no");
          res.on("data", (c) => chunks.push(c));
          resolve({
            req: reqRef,
            res,
            getBuffer: () => Buffer.concat(chunks)
          });
        });
        reqRef.on("error", reject);
      });
    }

    const listener1 = await openAudioListener();
    const listener2 = await openAudioListener();

    // Push one more live chunk to verify ongoing real-time relay
    broadcasterWs.send(mp3Sample);
    await new Promise((r) => setTimeout(r, 100));

    const l1Buf = listener1.getBuffer();
    const l2Buf = listener2.getBuffer();
    assert.ok(l1Buf.length > mp3Sample.length, "Listener 1 should receive burst + live audio");
    assert.ok(l2Buf.length > mp3Sample.length, "Listener 2 should receive burst + live audio");
    assert.strictEqual(l1Buf[0], 0xff, "Initial burst must start on aligned MPEG sync byte");
    assert.strictEqual(l2Buf[0], 0xff, "Initial burst must start on aligned MPEG sync byte");

    const statusLive = await request(baseUrl).get("/api/live-stream/status");
    assert.strictEqual(statusLive.status, 200);
    assert.strictEqual(statusLive.body.isLive, true);
    assert.strictEqual(statusLive.body.listenerCount, 2);

    listener1.req.destroy();
    listener2.req.destroy();
    broadcasterWs.close(1000, "Done");

    // 6. Stop broadcast and verify clean offline state
    const stopRes = await agent
      .post("/api/admin/live-stream/stop")
      .set("X-CSRF-Token", csrf)
      .send({});
    assert.strictEqual(stopRes.status, 200);
    assert.strictEqual(stopRes.body.stream.isLive, false);

    const dbRowAfter = await LiveStream.findByPk(stream.streamId);
    assert.strictEqual(dbRowAfter.status, "offline");

    // 7. Singers-only access control
    const privStart = await agent
      .post("/api/admin/live-stream/start")
      .set("X-CSRF-Token", csrf)
      .send({
        title: "Private Satsang",
        bitrate_kbps: 192,
        access_mode: "singers_only",
        notify_devotees: false
      });
    assert.strictEqual(privStart.status, 200);

    const unauthAudio = await request(baseUrl).get("/api/live-stream/audio");
    assert.strictEqual(unauthAudio.status, 401);

    await agent.post("/api/admin/live-stream/stop").set("X-CSRF-Token", csrf).send({});
  } finally {
    await liveStreamService.stopStream().catch(() => {});
    liveStreamService.shutdownLiveStream();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Live Stream static integration: SW bypass, router shell script & zero !important bloat", () => {
  const swSrc = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
  const routerSrc = fs.readFileSync(path.join(ROOT, "public", "js", "app-shell-router.js"), "utf8");
  const appShell = fs.readFileSync(path.join(ROOT, "views", "app-shell.ejs"), "utf8");
  const mainLayout = fs.readFileSync(path.join(ROOT, "views", "layouts", "main.ejs"), "utf8");
  const studioCss = fs.readFileSync(path.join(ROOT, "public", "css", "live-stream-studio.css"), "utf8");
  const playerCss = fs.readFileSync(path.join(ROOT, "public", "css", "live-stream.css"), "utf8");
  const studioEjs = fs.readFileSync(path.join(ROOT, "views", "admin-live-stream.ejs"), "utf8");
  const studioJs = fs.readFileSync(path.join(ROOT, "public", "js", "live-stream-studio.js"), "utf8");

  assert.ok(swSrc.includes('url.pathname.startsWith("/api/live-stream/")'));
  assert.ok(routerSrc.includes('"live-stream-player.js"'));
  assert.ok(appShell.includes('id="shellLivePill"'));
  assert.ok(appShell.indexOf("/css/live-stream.css") < appShell.indexOf("/css/native.css"));
  assert.ok(mainLayout.indexOf("/css/live-stream.css") < mainLayout.indexOf("/css/native.css"));
  assert.strictEqual((studioCss.match(/!important/g) || []).length, 0);
  assert.strictEqual((playerCss.match(/!important/g) || []).length, 0);
  assert.ok(studioEjs.includes('id="lsTestFileInput"'));
  assert.ok(studioJs.includes("createMediaElementSource"));
  assert.ok(studioJs.includes('"devicechange"'));
});
