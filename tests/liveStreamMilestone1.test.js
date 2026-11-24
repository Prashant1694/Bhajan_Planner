const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");

const { setupTestDb } = require("./setup");

test.before(async () => {
  await setupTestDb();
});

const { app } = require("../app");
const audioStorageService = require("../services/audioStorageService");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const wavUtils = require("../public/js/live-stream-wav-utils");

const ROOT = path.join(__dirname, "..");

function extractCsrf(html) {
  const m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/);
  if (m) return m[1];
  const i = html.match(/name=["']_csrf["']\s+value=["']([^"']+)["']/);
  return i ? i[1] : "";
}

async function loginAdminAgent() {
  const agent = request.agent(app);
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

test("WAV Utils: builds valid 24-bit PCM & 32-bit Float RIFF headers and encodes 24-bit samples", () => {
  const h24 = wavUtils.buildWavHeader({
    sampleRate: 48000,
    numChannels: 1,
    bitDepth: 24,
    dataByteLength: 300
  });
  const v24 = new DataView(h24.buffer, h24.byteOffset, h24.byteLength);
  assert.strictEqual(Buffer.from(h24.slice(0, 4)).toString("ascii"), "RIFF");
  assert.strictEqual(v24.getUint32(4, true), 336);
  assert.strictEqual(Buffer.from(h24.slice(8, 12)).toString("ascii"), "WAVE");
  assert.strictEqual(v24.getUint16(20, true), 1); // linear PCM
  assert.strictEqual(v24.getUint16(22, true), 1); // mono
  assert.strictEqual(v24.getUint32(24, true), 48000);
  assert.strictEqual(v24.getUint32(28, true), 144000); // 48000 * 3
  assert.strictEqual(v24.getUint16(34, true), 24);
  assert.strictEqual(v24.getUint32(40, true), 300);

  const h32 = wavUtils.buildWavHeader({
    sampleRate: 48000,
    numChannels: 2,
    bitDepth: 32,
    dataByteLength: 640
  });
  const v32 = new DataView(h32.buffer, h32.byteOffset, h32.byteLength);
  assert.strictEqual(v32.getUint16(20, true), 3); // IEEE Float
  assert.strictEqual(v32.getUint16(34, true), 32);

  // 24-bit sample byte packing check (+1.0 clamps cleanly to 0x7FFFFF, 0 -> 0)
  const pcm = wavUtils.floatToPcmBytes(new Float32Array([0, 1.5, -1.5]), 24);
  assert.strictEqual(pcm.length, 9);
  assert.deepStrictEqual(Array.from(pcm.slice(0, 3)), [0x00, 0x00, 0x00]);
  assert.deepStrictEqual(Array.from(pcm.slice(3, 6)), [0xff, 0xff, 0x7f]); // +8388607
  assert.deepStrictEqual(Array.from(pcm.slice(6, 9)), [0x00, 0x00, 0x80]); // -8388608

  const csv = wavUtils.formatAuditionMarkersCsv([
    { bhajan_title: "Omkaram", singer_name: "Test Singer", start_seconds: 65 }
  ]);
  assert.ok(csv.startsWith("Name\tStart\tDuration\tTime Format\tType\tDescription"));
  assert.ok(csv.includes("Omkaram\t1:05.000\t0:00.000\tdecimal\tCue\tTest Singer"));
});

test("audioStorageService: key sanitization, AccessDenied messaging & multipart mock lifecycle", async () => {
  assert.strictEqual(
    audioStorageService.sanitizeR2StorageKey("../../etc/passwd", "2026-11-24"),
    "recordings/2026-11-24-session.mp3"
  );
  assert.strictEqual(
    audioStorageService.sanitizeR2StorageKey("/recordings/2026-11-24 test.mp3"),
    "recordings/2026-11-24-test.mp3"
  );

  const errFormatted = audioStorageService.formatR2Error({
    name: "AccessDenied",
    $metadata: { httpStatusCode: 403 },
    message: "Access Denied"
  });
  assert.ok(errFormatted.message.includes("Object Read & Write"));

  const prevEnv = {
    CLOUDFLARE_R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID,
    CLOUDFLARE_R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    CLOUDFLARE_R2_BUCKET_NAME: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    CLOUDFLARE_R2_PUBLIC_URL: process.env.CLOUDFLARE_R2_PUBLIC_URL
  };
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "acc123";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "key123";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "sec123";
  process.env.CLOUDFLARE_R2_BUCKET_NAME = "session-recordings";
  process.env.CLOUDFLARE_R2_PUBLIC_URL = "https://pub-test.r2.dev";

  const sentCommands = [];
  audioStorageService.__setS3ClientForTest({
    send: async (cmd) => {
      sentCommands.push(cmd.constructor.name);
      if (cmd.constructor.name === "CreateMultipartUploadCommand") {
        return { UploadId: "up-xyz" };
      }
      if (cmd.constructor.name === "UploadPartCommand") {
        return { ETag: `"etag-${cmd.input.PartNumber}"` };
      }
      if (cmd.constructor.name === "CompleteMultipartUploadCommand") {
        return { ETag: '"final-etag"' };
      }
      return { ETag: '"put-etag"' };
    }
  });

  try {
    const init = await audioStorageService.initMultipartUpload({ key: "recordings/demo.mp3" });
    assert.strictEqual(init.uploadId, "up-xyz");
    const p1 = await audioStorageService.uploadMultipartPart({
      key: init.key,
      uploadId: init.uploadId,
      partNumber: 1,
      body: Buffer.from("chunk1")
    });
    assert.strictEqual(p1.etag, '"etag-1"');
    const comp = await audioStorageService.completeMultipartUpload({
      key: init.key,
      uploadId: init.uploadId,
      parts: [{ PartNumber: 1, ETag: p1.etag }]
    });
    assert.strictEqual(comp.publicUrl, "https://pub-test.r2.dev/recordings/demo.mp3");
    assert.deepStrictEqual(sentCommands, [
      "CreateMultipartUploadCommand",
      "UploadPartCommand",
      "CompleteMultipartUploadCommand"
    ]);
  } finally {
    audioStorageService.__setS3ClientForTest(null);
    Object.assign(process.env, prevEnv);
  }
});

test("R2 Cloud Upload & Publish Routes: multipart upload + SessionAudio & timestamps auto-publish", async () => {
  const { agent, csrf } = await loginAdminAgent();

  const prevEnv = {
    CLOUDFLARE_R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID,
    CLOUDFLARE_R2_ACCESS_KEY_ID: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    CLOUDFLARE_R2_BUCKET_NAME: process.env.CLOUDFLARE_R2_BUCKET_NAME,
    CLOUDFLARE_R2_PUBLIC_URL: process.env.CLOUDFLARE_R2_PUBLIC_URL
  };
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "acc123";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "key123";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "sec123";
  process.env.CLOUDFLARE_R2_BUCKET_NAME = "session-recordings";
  process.env.CLOUDFLARE_R2_PUBLIC_URL = "https://pub-test.r2.dev";

  const uploadedBodies = [];
  audioStorageService.__setS3ClientForTest({
    send: async (cmd) => {
      const name = cmd.constructor.name;
      if (name === "CreateMultipartUploadCommand") return { UploadId: "mp-100" };
      if (name === "UploadPartCommand") {
        uploadedBodies.push(Buffer.from(cmd.input.Body));
        return { ETag: `"part-${cmd.input.PartNumber}"` };
      }
      if (name === "CompleteMultipartUploadCommand") {
        return { ETag: '"mp-done"' };
      }
      if (name === "PutObjectCommand") {
        uploadedBodies.push(Buffer.from(cmd.input.Body));
        return { ETag: '"single-done"' };
      }
      return {};
    }
  });

  try {
    // Non-admin blocked
    const unauthStatus = await request(app).get("/api/admin/live-stream/r2/status");
    assert.strictEqual(unauthStatus.status, 401);

    const statusRes = await agent.get("/api/admin/live-stream/r2/status");
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body.configured, true);
    assert.strictEqual(statusRes.body.bucketName, "session-recordings");

    // Multipart flow over HTTP with raw application/octet-stream chunks
    const initRes = await agent
      .post("/api/admin/live-stream/r2/upload-init")
      .set("X-CSRF-Token", csrf)
      .send({ key: "recordings/2026-11-24-test.mp3", single_part: false });
    assert.strictEqual(initRes.status, 200);
    assert.strictEqual(initRes.body.mode, "multipart");
    assert.strictEqual(initRes.body.uploadId, "mp-100");

    const chunkBytes = Buffer.from("ID3-FAKE-MP3-CHUNK-1");
    const partRes = await agent
      .post(
        `/api/admin/live-stream/r2/upload-part?mode=multipart&key=${encodeURIComponent(initRes.body.key)}&uploadId=mp-100&partNumber=1`
      )
      .set("X-CSRF-Token", csrf)
      .set("Content-Type", "application/octet-stream")
      .send(chunkBytes);
    assert.strictEqual(partRes.status, 200);
    assert.strictEqual(partRes.body.etag, '"part-1"');
    assert.strictEqual(uploadedBodies[0].toString("utf8"), "ID3-FAKE-MP3-CHUNK-1");

    const compRes = await agent
      .post("/api/admin/live-stream/r2/upload-complete")
      .set("X-CSRF-Token", csrf)
      .send({
        key: initRes.body.key,
        uploadId: "mp-100",
        parts: [{ PartNumber: 1, ETag: '"part-1"' }]
      });
    assert.strictEqual(compRes.status, 200);
    assert.strictEqual(compRes.body.publicUrl, "https://pub-test.r2.dev/recordings/2026-11-24-test.mp3");

    // Publish SessionAudio + sorted timestamps
    const pubRes = await agent
      .post("/api/admin/live-stream/r2/publish")
      .set("X-CSRF-Token", csrf)
      .send({
        session_date: "2026-11-24",
        title: "Thursday Evening Cloud Recording",
        storage_key: compRes.body.key,
        audio_url: compRes.body.publicUrl,
        duration_seconds: 3615,
        file_size_bytes: 50331648,
        is_published: true,
        notify_devotees: false,
        timestamps: [
          { bhajan_title: "Second Bhajan", singer_name: "Singer B", start_seconds: 320 },
          { bhajan_title: "First Bhajan", singer_name: "Singer A", start_seconds: 15 }
        ]
      });
    assert.strictEqual(pubRes.status, 200);
    assert.strictEqual(pubRes.body.success, true);
    assert.strictEqual(pubRes.body.timestampCount, 2);

    const savedAudio = await SessionAudio.findOne({ where: { session_date: "2026-11-24" } });
    assert.ok(savedAudio);
    assert.strictEqual(savedAudio.audio_url, "https://pub-test.r2.dev/recordings/2026-11-24-test.mp3");
    assert.strictEqual(savedAudio.duration_seconds, 3615);

    const savedTs = await SessionAudioTimestamp.findAll({
      where: { session_audio_id: savedAudio.id },
      order: [["start_seconds", "ASC"]]
    });
    assert.strictEqual(savedTs.length, 2);
    assert.strictEqual(savedTs[0].bhajan_title, "First Bhajan");
    assert.strictEqual(savedTs[0].start_seconds, 15);
    assert.strictEqual(savedTs[1].bhajan_title, "Second Bhajan");
    assert.strictEqual(savedTs[1].start_seconds, 320);
  } finally {
    audioStorageService.__setS3ClientForTest(null);
    Object.assign(process.env, prevEnv);
  }
});

test("Milestone 1 static guarantees: dry worklet, SSD recorder & zero CSS !important", () => {
  const workletSrc = fs.readFileSync(path.join(ROOT, "public", "js", "live-stream-worklet.js"), "utf8");
  const studioEjs = fs.readFileSync(path.join(ROOT, "views", "admin-live-stream.ejs"), "utf8");
  const studioCss = fs.readFileSync(path.join(ROOT, "public", "css", "live-stream-studio.css"), "utf8");

  assert.ok(workletSrc.includes('"bp-dry-capture"'));
  assert.ok(studioEjs.includes('id="lsPickSsdFolderBtn"'));
  assert.ok(studioEjs.includes('id="lsPublishR2Btn"'));
  assert.ok(studioEjs.includes("live-stream-wav-utils.js"));
  assert.ok(studioEjs.includes("live-stream-recorder.js"));
  assert.strictEqual((studioCss.match(/!important/g) || []).length, 0);
});
