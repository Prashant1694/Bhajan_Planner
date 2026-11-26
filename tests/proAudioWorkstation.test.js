const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const request = require("supertest");

const { setupTestDb } = require("./setup");

const Dsp = require("../public/js/live-stream-dsp");
const WavUtils = require("../public/js/live-stream-wav-utils");
const Soundcheck = require("../public/js/live-stream-soundcheck");
const Engine = require("../public/js/live-stream-daw-engine");
const audioStorageService = require("../services/audioStorageService");

const ROOT = path.join(__dirname, "..");

function makeSine(freqHz, durationSec, amp, sr = 48000) {
  const n = Math.floor(durationSec * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  }
  return out;
}

function measureRms(arr, startIdx = 0, endIdx = arr.length) {
  let sum = 0;
  const count = Math.max(1, endIdx - startIdx);
  for (let i = startIdx; i < endIdx; i += 1) sum += arr[i] * arr[i];
  return Math.sqrt(sum / count);
}

function assertCleanAudio(buf, label) {
  let sum = 0;
  let maxAbs = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = buf[i];
    assert.ok(Number.isFinite(v), `${label} produced non-finite sample at ${i}`);
    sum += v;
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  const dcOffset = Math.abs(sum / Math.max(1, buf.length));
  assert.ok(dcOffset < 0.015, `${label} DC offset too high: ${dcOffset}`);
  return { maxAbs, dcOffset };
}

function extractCsrf(html) {
  const m = html.match(/name=["']csrf-token["']\s+content=["']([^"']+)["']/);
  if (m) return m[1];
  const i = html.match(/name=["']_csrf["']\s+value=["']([^"']+)["']/);
  return i ? i[1] : "";
}

async function loginAdminAgent(app) {
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
  assert.equal(res.status, 200);
  const dash = await agent.get("/admin/live-stream");
  assert.equal(dash.status, 200);
  return { agent, csrf: extractCsrf(dash.text), html: dash.text };
}

test.before(async () => {
  await setupTestDb();
});

test("DSP FX Catalog includes gate & stereo_width plus all 8 core plugins", () => {
  const all = ["eq", "filter", "compressor", "deesser", "reverb", "delay", "saturation", "limiter", "gate", "stereo_width"];
  all.forEach((k) => {
    assert.ok(Dsp.FX_CATALOG[k], `Missing plugin ${k}`);
    const slot = Dsp.createDefaultFxSlot(k);
    assert.equal(slot.type, k);
  });
});

test("RBJ Parametric EQ + Peak/RMS Compressor + Hysteresis Gate + 4x Saturation + Hall IR", () => {
  const sr = 48000;
  const sig = makeSine(1000, 0.5, 0.25, sr);
  const eqOut = Dsp.processParametricEqOffline(sig, null, {
    b80: 0,
    b250: 0,
    b1k: 6,
    b3k5: 0,
    b10k: 0
  }, sr);
  assertCleanAudio(eqOut.left, "EQ +6dB 1k");
  const gainRatio = measureRms(eqOut.left, 4800) / measureRms(sig, 4800);
  assert.ok(gainRatio > 1.7 && gainRatio < 2.3, `Expected ~+6dB boost ratio, got ${gainRatio}`);

  const compPeak = Dsp.processCompressorOffline(makeSine(440, 0.5, 0.8, sr), null, {
    threshold: -18,
    ratio: 4,
    attackMs: 5,
    releaseMs: 120,
    detection: "peak"
  }, sr);
  const compRms = Dsp.processCompressorOffline(makeSine(440, 0.5, 0.8, sr), null, {
    threshold: -18,
    ratio: 4,
    attackMs: 10,
    releaseMs: 150,
    detection: "rms"
  }, sr);
  assert.ok(measureRms(compPeak.left, 9600) < 0.5, "Peak compressor should attenuate 0.8 amplitude above -18dB");
  assert.ok(measureRms(compRms.left, 9600) < 0.55, "RMS compressor should attenuate 0.8 amplitude above -18dB");

  // Hysteresis Expander/Gate: active phrase stays untouched, -60dB floor suppressed
  const quietNoise = makeSine(120, 0.6, 0.001, sr);
  const gatedNoise = Dsp.processExpanderGateOffline(quietNoise, null, {
    thresholdDb: -40,
    hysteresisDb: 4,
    rangeDb: -42
  }, sr);
  assert.ok(measureRms(gatedNoise.left, 12000) < measureRms(quietNoise, 12000) * 0.2, "Noise below gate must attenuate");

  // 4x Oversampled Saturation preserves DC balance and adds controlled harmonics without clipping past 1
  const sat = Dsp.processSaturationOffline(makeSine(220, 0.4, 0.45, sr), null, {
    drive: 45,
    mode: 1,
    toneHz: 11000
  }, sr);
  const stats = assertCleanAudio(sat.left, "Saturation 4x");
  assert.ok(stats.maxAbs <= 1.25, "Saturation must remain bounded");

  // 6 Mandir Hall IR Presets generate finite impulse buffers
  Object.keys(Dsp.FX_CATALOG.reverb.presets).forEach((presetKey) => {
    const p = Dsp.FX_CATALOG.reverb.presets[presetKey].params;
    const mockCtx = {
      sampleRate: sr,
      createBuffer(ch, len) {
        const chans = Array.from({ length: ch }, () => new Float32Array(len));
        return {
          numberOfChannels: ch,
          length: len,
          getChannelData(idx) {
            return chans[idx];
          }
        };
      }
    };
    const ir = Dsp.buildHallImpulseResponse(mockCtx, { preset: presetKey, decay: p.decay, preDelayMs: p.preDelayMs });
    assertCleanAudio(ir.getChannelData(0), `HallIR ${presetKey} L`);
    assertCleanAudio(ir.getChannelData(1), `HallIR ${presetKey} R`);
  });
});

test("Dynamic Split-Band De-Esser targets 6.8kHz sibilance while preserving 250Hz vocal fundament", () => {
  const sr = 48000;
  const dur = 0.5;
  const warm = makeSine(250, dur, 0.25, sr);
  const sib = makeSine(6800, dur, 0.35, sr);
  const combined = new Float32Array(warm.length);
  for (let i = 0; i < combined.length; i += 1) combined[i] = warm[i] + sib[i];

  const processed = Dsp.processDeEsserOffline(combined, null, {
    freqHz: 6500,
    cutDb: 7.5,
    thresholdDb: -26,
    q: 2.2
  }, sr);
  assertCleanAudio(processed.left, "Dynamic De-Esser");
  assert.ok(measureRms(processed.left, 4800) < measureRms(combined, 4800) * 0.85, "Sibilant HF energy should be reduced dynamically");

  const warmOnly = Dsp.processDeEsserOffline(warm, null, {
    freqHz: 6500,
    cutDb: 7.5,
    thresholdDb: -26
  }, sr);
  const warmRatio = measureRms(warmOnly.left, 4800) / measureRms(warm, 4800);
  assert.ok(warmRatio > 0.96, `250 Hz fundamental should pass nearly untouched (ratio=${warmRatio})`);
});

test("BS.1770-4 True Peak 4x Oversampling & Lookahead Limiter enforce -1.0 dBTP ceiling", () => {
  const sr = 48000;
  const hot = makeSine(1000, 0.8, 1.9, sr); // +5.6 dBFS
  const beforeTp = Dsp.measureTruePeakDb(hot);
  assert.ok(beforeTp > 4.5, `Expected hot input > +4.5 dBTP, got ${beforeTp}`);

  const res = Dsp.applyTruePeakLimiterOffline(hot, null, {
    ceilingDb: -1.0,
    lookaheadMs: 5,
    releaseMs: 80,
    sampleRate: sr
  });
  assertCleanAudio(res.left, "Lookahead Limiter");
  const afterTp = Dsp.measureTruePeakDb(res.left);
  assert.ok(afterTp <= -0.95, `Expected limited True Peak <= -0.95 dBTP, got ${afterTp} (res=${res.truePeakDb})`);

  const fullStats = Dsp.analyzeLoudnessFull(res.left, null, sr);
  assert.ok(Number.isFinite(fullStats.integratedLufs));
  assert.ok(Number.isFinite(fullStats.shortTermMaxLufs));
  assert.ok(Number.isFinite(fullStats.momentaryMaxLufs));
  assert.ok(Number.isFinite(fullStats.loudnessRangeLu));
  assert.ok(fullStats.truePeakDb <= -0.95);
});

test("WAV Utilities: 16-bit TPDF dither, 24-bit stereo WAV, Sinc SRC 44.1k->48k & header verifier", () => {
  const sr441 = 44100;
  const sine441 = makeSine(1000, 0.25, 0.5, sr441);
  const sine48 = WavUtils.resampleFloat32Sinc(sine441, sr441, 48000);
  assertCleanAudio(sine48, "Sinc 44.1k->48k");
  assert.ok(Math.abs(sine48.length - Math.round(sine441.length * (48000 / 44100))) <= 4);

  const wav16 = WavUtils.encodeStereoWavBuffer({
    left: sine48,
    right: sine48,
    sampleRate: 48000,
    bitDepth: 16,
    dither: true
  });
  const check16 = WavUtils.verifyWavHeaderAndSize(wav16);
  assert.equal(check16.valid, true);
  assert.equal(check16.numChannels, 2);
  assert.equal(check16.bitDepth, 16);

  const wav24 = WavUtils.encodeStereoWavBuffer({
    left: sine48,
    right: sine48,
    sampleRate: 48000,
    bitDepth: 24,
    dither: false
  });
  const check24 = WavUtils.verifyWavHeaderAndSize(wav24);
  assert.equal(check24.valid, true);
  assert.equal(check24.bitDepth, 24);

  const emptyCheck = WavUtils.verifyWavHeaderAndSize(new ArrayBuffer(44));
  assert.equal(emptyCheck.valid, false);
});

test("Audio Regression Corpus: 8 standard test signals stay NaN-free, DC-safe & <= -0.9 dBTP", () => {
  const sr = 48000;
  const n = Math.floor(0.5 * sr);

  const signals = {
    silence: new Float32Array(n),
    sine1k: makeSine(1000, 0.5, 0.5, sr),
    sweep: (() => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const f = 20 * Math.pow(1000, i / n);
        a[i] = 0.45 * Math.sin((2 * Math.PI * f * i) / sr);
      }
      return a;
    })(),
    impulse: (() => {
      const a = new Float32Array(n);
      a[1000] = 0.95;
      return a;
    })(),
    noise: (() => {
      const a = new Float32Array(n);
      let s = 1234567;
      for (let i = 0; i < n; i += 1) {
        s = (s * 1664525 + 1013904223) >>> 0;
        a[i] = ((s / 4294967296) * 2 - 1) * 0.2;
      }
      return a;
    })(),
    vocalSibilant: (() => {
      const f0 = makeSine(240, 0.5, 0.25, sr);
      const sib = makeSine(6900, 0.5, 0.28, sr);
      return f0.map((v, idx) => v + sib[idx]);
    })(),
    harmonium: (() => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        a[i] =
          0.25 * Math.sin((2 * Math.PI * 261.6 * i) / sr) +
          0.16 * Math.sin((2 * Math.PI * 523.2 * i) / sr) +
          0.09 * Math.sin((2 * Math.PI * 784.8 * i) / sr);
      }
      return a;
    })(),
    tabla: (() => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const t = i / sr;
        a[i] = 0.7 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * 190 * t);
      }
      return a;
    })()
  };

  Object.entries(signals).forEach(([name, arr]) => {
    const step1 = Dsp.processParametricEqOffline(arr, null, { b80: -2, b250: 1.5, b1k: 0, b3k5: 2.5, b10k: 1 }, sr);
    const step2 = Dsp.processDeEsserOffline(step1.left, null, { freqHz: 6500, cutDb: 3.5 }, sr);
    const step3 = Dsp.processCompressorOffline(step2.left, null, { threshold: -18, ratio: 3.5 }, sr);
    const step4 = Dsp.applyTruePeakLimiterOffline(step3.left, null, { ceilingDb: -1.0, sampleRate: sr });
    assertCleanAudio(step4.left, `Corpus:${name}`);
    assert.ok(Dsp.measureTruePeakDb(step4.left) <= -0.9, `Corpus:${name} exceeded ceiling`);
  });
});

test("Soundcheck verifies 2-channel isolation and flags duplicated mono inputs", () => {
  const sc = Soundcheck.createSoundcheckSession({
    deviceName: "Behringer UMC202HD",
    sourceType: "asio",
    sampleRate: 48000,
    channelCount: 2
  });

  // Stage 1: vocal isolated >= 12dB above Ch2
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_VOCAL);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.45, rms1: 0.25, peak2: 0.01, rms2: 0.005, corr12: 0.08 });
  // Stage 2: inst isolated >= 12dB above Ch1
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_INST);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.01, rms1: 0.005, peak2: 0.42, rms2: 0.22, corr12: 0.06 });
  // Stage 3: simultaneous performance with healthy independence
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_BOTH);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.5, rms1: 0.28, peak2: 0.4, rms2: 0.2, corr12: 0.14 });

  const good = Soundcheck.evaluateReadiness(sc, { requireDualInput: true });
  assert.equal(good.ready, true);
  assert.equal(good.canRecordDualStems, true);
  assert.equal(good.severity, "ok");

  // Simulate OS mono-downmix driver duplicating Ch1 onto Ch2 (corr = 0.99 for >=3 frames)
  const monoSc = Soundcheck.createSoundcheckSession({ deviceName: "Generic Mono Driver", sampleRate: 48000, channelCount: 2 });
  Soundcheck.setSoundcheckStage(monoSc, Soundcheck.STAGE_BOTH);
  for (let i = 0; i < 4; i++) {
    Soundcheck.ingestTelemetryFrame(monoSc, { peak1: 0.4, rms1: 0.22, peak2: 0.4, rms2: 0.22, corr12: 0.992 });
  }
  const monoBlocked = Soundcheck.evaluateReadiness(monoSc, { requireDualInput: true });
  assert.equal(monoBlocked.canRecordDualStems, false);
  assert.ok(/identical/i.test(monoBlocked.message));
  monoSc.singleChannelAllowed = true;
  const monoAccepted = Soundcheck.evaluateReadiness(monoSc, { requireDualInput: true });
  assert.equal(monoAccepted.ready, true);
});

test("DAW Engine: Vocals Ch1 / Instruments Ch2 mapping, slip, nudge, snap, normalize, loop & automation", () => {
  const st = Engine.createInitialState();
  assert.equal(st.tracks[0].role, "ch1");
  assert.ok(/Vocal/i.test(st.tracks[0].name));
  assert.equal(st.tracks[1].role, "ch2");
  assert.ok(/Instrument/i.test(st.tracks[1].name));

  const s1 = Engine.addSource(st, { id: "src-1", name: "vocal.wav", duration: 60 });
  const clip = Engine.appendClip(st, {
    sourceId: s1,
    trackId: st.tracks[0].id
  });
  assert.equal(Engine.trimClip(st, clip.id, { newSourceStart: 10, newSourceEnd: 30 }), true);

  // Slip moves sourceStart/End while holding duration constant
  assert.equal(Engine.slipClip(st, clip.id, 3), true);
  assert.equal(clip.sourceStart, 13);
  assert.equal(clip.sourceEnd, 33);

  // Nudge updates timelineOffsetSec on track clip
  assert.equal(Engine.nudgeClip(st, clip.id, 2.5), true);
  assert.equal(clip.timelineOffsetSec, 2.5);

  // Snap to marker
  Engine.addMarker(st, { bhajan_title: "Aarti", start_seconds: 15.0 });
  assert.equal(Engine.snapTime(st, 14.85, { markersEnabled: true, toleranceSec: 0.3 }), 15.0);

  // Duplicate + Normalize clip
  const dup = Engine.duplicateClip(st, clip.id);
  assert.ok(dup && dup.id !== clip.id);
  assert.equal(Engine.normalizeClip(st, dup.id, -1.0, -8.5), true);
  assert.equal(dup.gainDb, 7.5);

  // Duplicate FX slot
  const eq = Engine.addTrackFx(st, st.tracks[0].id, "eq", { b80: 2 });
  const eqClone = Engine.duplicateTrackFx(st, st.tracks[0].id, eq.id);
  assert.ok(eqClone && eqClone.id !== eq.id && eqClone.params.b80 === 2);

  // Automation lane add, evaluate, sample & manifest roundtrip
  const pt1 = Engine.addAutomationPoint(st, st.tracks[0].id, "gain", 0, 100);
  const pt2 = Engine.addAutomationPoint(st, st.tracks[0].id, "gain", 10, 50);
  assert.ok(pt1 && pt2);
  assert.equal(Engine.evaluateAutomation(st.tracks[0].automation.gain, 5, 100), 75);
  const envSamples = Engine.sampleAutomationEnvelope(st.tracks[0].automation.gain, 0, 5, 8000, 100);
  assert.equal(envSamples.length, 5);
  assert.ok(Math.abs(envSamples[0] - 100) < 0.01);

  Engine.setLoopRegion(st, { enabled: true, startSec: 4, endSec: 18 });
  const manifest = Engine.exportProjectManifest(st, { sessionDate: "2026-11-25" });
  const targetState = Engine.createInitialState();
  Engine.importProjectManifest(targetState, manifest);
  assert.equal(targetState.loopRegion.enabled, true);
  assert.equal(targetState.loopRegion.endSec, 18);
  assert.equal(targetState.tracks[0].automation.gain.length, 2);
});

test("AWS SigV4 R2 Presigner generates compliant signed PUT URL", async () => {
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "example-account-123";
  process.env.CLOUDFLARE_R2_BUCKET_NAME = "bhajan-audio";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "AKIAEXAMPLEKEY123";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "SecretExampleKeyValueForSigV4TestsOnly99";

  const signed = audioStorageService.createPresignedR2Url({
    key: "recordings/2026-11-25/session-master.mp3",
    expiresIn: 1800
  });
  assert.ok(signed.url.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
  assert.ok(signed.url.includes("X-Amz-Signature="));
  assert.ok(signed.url.includes("X-Amz-Expires=1800"));
  assert.equal(signed.key, "recordings/2026-11-25/session-master.mp3");
});

test("StudioProject CRUD API, Auto end_seconds calculation & CSS/CSP guardrails", async () => {
  const css = fs.readFileSync(path.join(ROOT, "public/css/live-stream-studio.css"), "utf8");
  assert.equal(css.includes("!important"), false, "CSS must never contain !important overrides");

  const { app } = require("../app");
  const { agent, csrf, html } = await loginAdminAgent(app);

  // Studio markup renders all Workstation controls
  assert.ok(html.includes('id="lsResourceStrip"'));
  assert.ok(html.includes('id="lsCaptureBackendSelect"'));
  assert.ok(html.includes('id="lsSoundcheckDrawer"'));
  assert.ok(html.includes('id="lsDawLoopBtn"'));
  assert.ok(html.includes('id="lsDawAutoToggleBtn"'));
  assert.ok(html.includes('id="lsDawExportFormatSelect"'));

  // StudioProject Save / Get / List / Delete
  const st = Engine.createInitialState();
  const manifest = Engine.exportProjectManifest(st, { sessionDate: "2026-11-25" });
  const saveRes = await agent
    .post("/api/admin/live-stream/projects")
    .set("X-CSRF-Token", csrf)
    .send({
      projectUid: "qa-proj-001",
      sessionDate: "2026-11-25",
      title: "Thursday Mandir Studio",
      manifest
    });
  assert.equal(saveRes.status, 200);
  assert.equal(saveRes.body.success, true);

  const getRes = await agent.get("/api/admin/live-stream/projects/qa-proj-001");
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.project.project_uid, "qa-proj-001");

  const listRes = await agent.get("/api/admin/live-stream/projects");
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.projects.some((p) => p.project_uid === "qa-proj-001"));

  // Publish R2 metadata computes sequential end_seconds cleanly
  const pubRes = await agent
    .post("/api/admin/live-stream/r2/publish")
    .set("X-CSRF-Token", csrf)
    .send({
      session_date: "2026-11-25",
      title: "Thursday Satsang Master",
      storage_key: "recordings/2026-11-25/master.mp3",
      file_size_bytes: 2450000,
      duration_seconds: 900,
      is_published: true,
      project_uid: "qa-proj-001",
      timestamps: [
        { bhajan_title: "Ganesha Vandana", singer_name: "Singer A", start_seconds: 15 },
        { bhajan_title: "Sai Ram Dhun", singer_name: "Singer B", start_seconds: 320 }
      ]
    });
  assert.equal(pubRes.status, 200);
  assert.equal(pubRes.body.success, true);

  const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
  const rows = await SessionAudioTimestamp.findAll({
    where: { session_audio_id: pubRes.body.audio.id },
    order: [["start_seconds", "ASC"]]
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].end_seconds, 320);
  assert.equal(rows[1].end_seconds, 900);

  const delRes = await agent
    .delete("/api/admin/live-stream/projects/qa-proj-001")
    .set("X-CSRF-Token", csrf);
  assert.equal(delRes.status, 200);
});

test("Phase 2: Discrete dual-input AudioWorklet, sample-clock sync, hard preflight block, Resource UI & Python bridge", async () => {
  const workletSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-worklet.js"), "utf8");
  const studioSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-studio.js"), "utf8");
  const recorderSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-recorder.js"), "utf8");
  const viewSrc = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");

  // 1. BpDryCaptureProcessor must never clone Ch1 into Ch2 when input[1] is absent
  const dryClassBlock = workletSrc.slice(
    workletSrc.indexOf("class BpDryCaptureProcessor"),
    workletSrc.indexOf("class BpAsioIngestProcessor")
  );
  assert.equal(dryClassBlock.includes("input[1] || input[0]"), false, "BpDryCaptureProcessor must not clone Ch1 onto Ch2");
  assert.ok(dryClassBlock.includes("const hasCh2 = input.length > 1"), "Worklet must check discrete input channel presence");
  assert.ok(dryClassBlock.includes('ev.data.type === "reset-clock"'));

  // 2. Studio enforces discrete channelInterpretation, USB unplug detection & hard dual-input block
  assert.ok(studioSrc.includes('source.channelInterpretation = "discrete"'));
  assert.ok(studioSrc.includes('track.addEventListener("ended"'));
  assert.ok(studioSrc.includes('type: "reset-clock"'));
  assert.ok(studioSrc.includes("Dual-input check blocked startRecording"));
  assert.ok(studioSrc.includes("#lsResEngineLoad") || studioSrc.includes('"lsResEngineLoad"'));
  assert.ok(studioSrc.includes('"lsResDiskFree"'));

  // 3. View contains per-channel Soundcheck telemetry and sample-rate / buffer controls
  assert.ok(viewSrc.includes('id="lsScCh1Stats"'));
  assert.ok(viewSrc.includes('id="lsScCh2Stats"'));
  assert.ok(viewSrc.includes('id="lsScConnBadge"'));
  assert.ok(viewSrc.includes('id="lsHwSampleRateSelect"'));
  assert.ok(viewSrc.includes('id="lsHwBufferSelect"'));

  // 4. Recorder sample-clock origin sync & structured getState() under simulated soundcheck offset
  const vm = require("node:vm");
  const WavUtilsMock = require("../public/js/live-stream-wav-utils");
  const store = {};
  const ctx = {
    window: {
      LiveStreamWavUtils: WavUtilsMock,
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      }
    },
    Worker: function MockWorker() {
      return { postMessage() {}, terminate() {} };
    },
    File: globalThis.File || class MockFile {
      constructor(parts, name, opts) {
        this.parts = parts;
        this.name = name;
        this.type = opts && opts.type;
        this.size = parts.reduce((acc, p) => acc + (p.byteLength || p.length || 0), 0);
      }
      async arrayBuffer() {
        return Buffer.concat(this.parts.map((p) => Buffer.from(p.buffer || p))).buffer;
      }
      slice(a, b) {
        const full = Buffer.concat(this.parts.map((p) => Buffer.from(p.buffer || p)));
        return { async arrayBuffer() { return full.subarray(a, b).buffer; } };
      }
    },
    navigator: {},
    Blob: globalThis.Blob,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    clearInterval,
    setInterval,
    setTimeout,
    Date,
    Math,
    Number,
    String,
    Array,
    Float32Array,
    Uint8Array,
    Int16Array,
    DataView,
    ArrayBuffer,
    JSON,
    console
  };
  ctx.window.window = ctx.window;
  vm.runInNewContext(recorderSrc, ctx);
  const rec = ctx.window.LiveStudioRecorder;

  const initSt = rec.getState();
  assert.equal(typeof initSt, "object");
  assert.equal(initSt.active, false);

  await rec.startRecording({
    sessionDate: "2026-11-25",
    sessionUid: "phase2-sync-test",
    sampleRate: 48000,
    bitDepth: 24,
    recordMasterMp3: false,
    hardwareCaptureFormat: { driver: "ASIO4ALL v2", sampleRate: 48000, channelCount: 2, sampleSizeBits: 24 }
  });

  // Simulate 180s prior soundcheck offset on worklet clock (8,640,000 + 2048 frames)
  const block1 = new Float32Array(2048).fill(0.15);
  const block2 = new Float32Array(2048).fill(0.25);
  rec.pushDryPcm(block1, block2, 8642048);
  rec.pushDryPcm(block1, block2, 8644096);

  const stats = rec.getStats();
  assert.equal(stats.sampleFrames, 4096, "clockOriginFrames must keep recording clock anchored at 0");
  assert.equal(stats.sampleSyncDriftFrames, 0, "Ch1 & Ch2 sample counts must have 0 frame drift");
  assert.equal(stats.ch1Samples, 4096);
  assert.equal(stats.ch2Samples, 4096);

  const stopRes = await rec.stopRecording([]);
  assert.equal(stopRes.verified, true);
  assert.equal(stopRes.sampleFrames, 4096);
  assert.equal(stopRes.sampleSyncDriftFrames, 0);
  assert.ok(stopRes.hardwareCaptureFormat && stopRes.hardwareCaptureFormat.driver === "ASIO4ALL v2");

  // 5. Python local audio bridge runs --list cleanly with stdlib on this workstation
  const { execFileSync } = require("node:child_process");
  const bridgeOut = execFileSync("python", ["scripts/local_asio_bridge.py", "--list"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const parsedBridge = JSON.parse(bridgeOut);
  assert.ok(Array.isArray(parsedBridge.registeredAsioDrivers));
  assert.ok(Array.isArray(parsedBridge.inputDevices));
});

test("Phase 3 Live Mixing Engine: channel EQ biquads, Hall presets, AudioWorklets & console contracts", () => {
  const vm = require("node:vm");

  // 1. LiveStreamDsp.computeChannelEqCurvePoints exact biquads + 12/24 dB/oct HPF slope + LPF + dynamic de-ess notch
  const flatPts = Dsp.computeChannelEqCurvePoints({ hpf: 85, low: 4, mid: 3, high: 2, eqBypass: true }, { isVocal: true, freqs: [60, 220, 3200] });
  flatPts.forEach((pt) => assert.equal(pt.db, 0, "Bypassed channel EQ must yield flat 0 dB"));

  const hpf12 = Dsp.computeChannelEqCurvePoints({ hpf: 120, hpfSlope: 12, low: 0, mid: 0, high: 0 }, { isVocal: true, freqs: [45] });
  const hpf24 = Dsp.computeChannelEqCurvePoints({ hpf: 120, hpfSlope: 24, low: 0, mid: 0, high: 0 }, { isVocal: true, freqs: [45] });
  assert.ok(hpf24[0].db < hpf12[0].db - 8, `24 dB/oct HPF (${hpf24[0].db}) must roll off steeper than 12 dB/oct (${hpf12[0].db})`);

  const lpfCut = Dsp.computeChannelEqCurvePoints({ hpf: 20, lpf: 4000, low: 0, mid: 0, high: 0 }, { isVocal: false, freqs: [1000, 12000] });
  assert.ok(lpfCut[1].db < -12, `LPF at 4 kHz must strongly attenuate 12 kHz (got ${lpfCut[1].db})`);

  const noDeess = Dsp.computeChannelEqCurvePoints({ hpf: 20, low: 0, mid: 0, high: 0, deessFreq: 6500 }, { isVocal: true, freqs: [6500], dynamicDeessGrDb: 0 });
  const activeDeess = Dsp.computeChannelEqCurvePoints({ hpf: 20, low: 0, mid: 0, high: 0, deessFreq: 6500 }, { isVocal: true, freqs: [6500], dynamicDeessGrDb: -4.5 });
  assert.equal(noDeess[0].db, 0, "Silent de-esser must not color vocal curve statically");
  assert.ok(activeDeess[0].db <= -3.5, `Active de-esser GR must show dynamic notch (got ${activeDeess[0].db})`);

  // 2. HALL_IR_PRESETS & buildChannelAndMasterDsp complete graph verification
  ["small_mandir", "medium_prayer_hall", "large_mandir_hall", "concert_hall", "vocal_plate", "studio_room", "mandir_warm"].forEach((k) => {
    assert.ok(Dsp.HALL_IR_PRESETS[k], `Missing HALL_IR_PRESETS.${k}`);
  });
  function mkParam(val = 0) {
    return { value: val, setTargetAtTime(v) { this.value = v; } };
  }
  function mkNode() {
    const n = {
      gain: mkParam(1),
      frequency: mkParam(1000),
      Q: mkParam(0.707),
      threshold: mkParam(0),
      ratio: mkParam(1),
      attack: mkParam(0.01),
      release: mkParam(0.1),
      knee: mkParam(10),
      pan: mkParam(0),
      type: "peaking",
      buffer: null,
      connect(dest) { return dest; }
    };
    return n;
  }
  const mockGraphCtx = {
    sampleRate: 48000,
    currentTime: 0,
    createGain: mkNode,
    createBiquadFilter: mkNode,
    createDynamicsCompressor: mkNode,
    createConvolver: mkNode,
    createStereoPanner: mkNode,
    createBuffer(ch, len) {
      const arrs = Array.from({ length: ch }, () => new Float32Array(len));
      return { numberOfChannels: ch, length: len, getChannelData: (idx) => arrs[idx] };
    }
  };
  const builtGraph = Dsp.buildChannelAndMasterDsp(mockGraphCtx, {
    inst: { gain: 100, hpf: 45, hpfSlope: 24, lpf: 16000, midFreq: 450, midQ: 1.1, pan: -15, reverbSend: 60, preFaderSend: false },
    vocal: { gain: 112, hpf: 85, hpfSlope: 12, lpf: 20000, midFreq: 3200, midQ: 1.2, pan: 0, reverbSend: 100, preFaderSend: true },
    reverb: { preset: "large_mandir_hall", wet: 18, decay: 2.1, preDelayMs: 32 },
    master: { b80: 0.5, b250: -1.5, b1k: 0, b3k5: 1.5, b10k: 1.0, glueComp: true, limiter: true, gain: 100 }
  });
  assert.ok(builtGraph.nodes.instPreSend.gain.value === 0 && builtGraph.nodes.instPostSend.gain.value > 0.5);
  assert.ok(builtGraph.nodes.vocalPreSend.gain.value > 0.9 && builtGraph.nodes.vocalPostSend.gain.value === 0);
  assert.equal(builtGraph.nodes.instHpf2.frequency.value, 45);
  assert.equal(builtGraph.nodes.vocalHpf2.frequency.value, 10);

  // 3. AudioWorklet BpProDspProcessor & BpPcmCaptureProcessor live simulation
  const workletSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-worklet.js"), "utf8");
  const regMap = {};
  const wCtx = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { onmessage: null, sent: [], postMessage(d) { this.sent.push(d); } };
      }
    },
    registerProcessor(name, cls) { regMap[name] = cls; },
    Float32Array,
    Int16Array,
    Math,
    Number,
    Object
  };
  vm.runInNewContext(workletSrc, wCtx);

  const proDsp = new regMap["bp-pro-dsp"]();
  proDsp.port.onmessage({
    data: {
      type: "params",
      params: {
        gateEnabled: true,
        gateThresholdDb: -40,
        deessEnabled: true,
        deessFreqHz: 6500,
        deessThresholdDb: -26,
        deessReductionDb: 6,
        compEnabled: true,
        compThresholdDb: -18,
        compRatio: 4,
        limEnabled: true,
        limCeilingDb: -1.0
      }
    }
  });
  const hotSibInL = makeSine(6600, 0.1, 1.4, 48000);
  const hotSibInR = new Float32Array(hotSibInL);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  for (let off = 0; off + 128 <= hotSibInL.length; off += 128) {
    proDsp.process([[hotSibInL.subarray(off, off + 128), hotSibInR.subarray(off, off + 128)]], [[outL, outR]]);
    const blkTp = Dsp.measureTruePeakDb(outL, outR);
    assert.ok(blkTp <= -0.95, `BpProDspProcessor limiter violated -1.0 dBTP ceiling: ${blkTp}`);
  }
  const meterMsgs = proDsp.port.sent.filter((m) => m.type === "dsp-meters");
  assert.ok(meterMsgs.length >= 1, "BpProDspProcessor must emit dsp-meters");
  assert.ok(meterMsgs[0].deesserGrDb < -0.5, `Expected sibilance de-esser GR, got ${meterMsgs[0].deesserGrDb}`);

  const pcmCap = new regMap["bp-pcm-capture"]();
  const stInL = makeSine(1000, 0.12, 0.35, 48000);
  const stInR = makeSine(1000, 0.12, 0.25, 48000);
  for (let off = 0; off + 128 <= stInL.length; off += 128) {
    pcmCap.process([[stInL.subarray(off, off + 128), stInR.subarray(off, off + 128)]]);
  }
  const pcmMsgs = pcmCap.port.sent.filter((m) => m.type === "pcm");
  const telemMsgs = pcmCap.port.sent.filter((m) => m.type === "master-telemetry");
  assert.ok(pcmMsgs.length >= 2, "BpPcmCaptureProcessor must emit 2304-sample Int16 PCM blocks");
  assert.ok(telemMsgs.length >= 1, "BpPcmCaptureProcessor must emit master-telemetry");
  assert.ok(telemMsgs[0].peakL > telemMsgs[0].peakR && Number.isFinite(telemMsgs[0].kwMeanSq));

  // 4. Console EJS/JS/CSS contracts
  const ejsSrc = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");
  const studioSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-studio.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "public/css/live-stream-studio.css"), "utf8");
  ["lsMasterLufsVal", "lsMasterRmsVal", "lsMasterMeterFillR", "lsVocalDeessGrBar", "lsInstGrBar", "lsVocalHpfSlope", "lsInstHpfSlope", "lsVocalRevSend", "lsInstRevSend", "lsReverbCustomIrInput"].forEach((id) => {
    assert.ok(ejsSrc.includes(`id="${id}"`), `Missing Phase 3 Live Console DOM element #${id}`);
  });
  assert.ok(studioSrc.includes("vocalPreRevSendGain") && studioSrc.includes("instPreRevSendGain"));
  assert.ok(studioSrc.includes("masterProDspNode") && studioSrc.includes("instProDspNode"));
  assert.ok(studioSrc.includes("wireEqCanvasInteraction"));
  assert.equal((cssSrc.match(/!important/g) || []).length, 0);
});

test("Phase 4: All 10 DSP plugins offline parity, Linear-Phase FIR EQ, DAW_CHAIN_PRESETS, and custom UI contracts", () => {
  const sr = 48000;
  const rms = (arr, start = 4000) => {
    let s = 0;
    for (let i = start; i < arr.length; i += 1) s += arr[i] * arr[i];
    return Math.sqrt(s / Math.max(1, arr.length - start));
  };

  // 1. Linear-Phase FIR EQ symmetry & zero-latency impulse peak alignment + Parametric EQ slopes/Qs/bypasses
  const lpParams = {
    b80: 4, b250: -3, b1k: 2, b3k5: 3, b10k: 1,
    q250: 2.2, hpfHz: 80, hpfSlope: 24, lpfHz: 14000,
    on1: 1, on2: 1, on3: 1, on4: 1, on5: 1, linearPhase: 1
  };
  const lpKernel = Dsp.buildLinearPhaseEqKernel(lpParams, sr, 513);
  assert.ok(lpKernel instanceof Float32Array && lpKernel.length === 513);
  assert.ok(Math.abs(lpKernel[0] - lpKernel[512]) < 1e-6);
  assert.ok(Math.abs(lpKernel[100] - lpKernel[412]) < 1e-6);

  const mockCtx = {
    sampleRate: sr,
    createBuffer(ch, bLen) {
      const arrs = Array.from({ length: ch }, () => new Float32Array(bLen));
      return { numberOfChannels: ch, length: bLen, getChannelData: (idx) => arrs[idx] };
    }
  };
  const lpBuf = Dsp.buildLinearPhaseEqImpulseResponse(mockCtx, lpParams, 513);
  assert.equal(lpBuf.length, 513);
  assert.ok(Math.abs(lpBuf.getChannelData(0)[100] - lpBuf.getChannelData(0)[412]) < 1e-6);

  const impulseIn = new Float32Array(4096);
  impulseIn[1000] = 1.0;
  const lpOut = Dsp.processLinearPhaseEqOffline(impulseIn, null, {
    b1k: 3, linearPhase: 1, hpfHz: 20, lpfHz: 20000
  }, sr);
  let peakIdx = 0;
  let peakVal = -1;
  for (let i = 0; i < lpOut.left.length; i += 1) {
    if (Math.abs(lpOut.left[i]) > peakVal) {
      peakVal = Math.abs(lpOut.left[i]);
      peakIdx = i;
    }
  }
  assert.equal(peakIdx, 1000);

  // Parametric EQ hpfSlope 24 vs 12 & band toggle on1..on5
  const lowTone = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) lowTone[i] = 0.5 * Math.sin(2 * Math.PI * 50 * i / sr);
  const eq12 = Dsp.processParametricEqOffline(lowTone, null, { hpfHz: 120, hpfSlope: 12 }, sr);
  const eq24 = Dsp.processParametricEqOffline(lowTone, null, { hpfHz: 120, hpfSlope: 24 }, sr);
  assert.ok(rms(eq24.left) < rms(eq12.left));

  const tone1k = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) tone1k[i] = 0.25 * Math.sin(2 * Math.PI * 1000 * i / sr);
  const eqBandOn = Dsp.processParametricEqOffline(tone1k, null, { b1k: 6, on3: 1, hpfHz: 20, lpfHz: 20000 }, sr);
  const eqBandOff = Dsp.processParametricEqOffline(tone1k, null, { b1k: 6, on3: 0, hpfHz: 20, lpfHz: 20000 }, sr);
  assert.ok(rms(eqBandOn.left) > rms(eqBandOff.left) * 1.5);

  // 2. Filter plugin offline (hpfHz / lpfHz / slope)
  const highTone = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) highTone[i] = 0.4 * Math.sin(2 * Math.PI * 6000 * i / sr);
  const filtLp = Dsp.processFilterOffline(highTone, null, { hpfHz: 20, lpfHz: 800, q: 0.707, slope: 24 }, sr);
  assert.ok(rms(filtLp.left) < rms(highTone) * 0.1);

  // 3. Compressor peak vs rms, scHpfHz, parallel mix
  const burst = new Float32Array(sr / 2);
  for (let i = 0; i < burst.length; i += 1) {
    const bass = 0.7 * Math.sin(2 * Math.PI * 45 * i / sr);
    const spike = (i >= 10000 && i < 10050) ? 0.9 * Math.sin(2 * Math.PI * 2000 * i / sr) : 0.1 * Math.sin(2 * Math.PI * 1000 * i / sr);
    burst[i] = Math.max(-0.99, Math.min(0.99, bass + spike));
  }
  const compPeak = Dsp.processCompressorOffline(burst, null, { threshold: -20, ratio: 8, attackMs: 2, releaseMs: 80, detection: "peak", mix: 100 }, sr);
  const compRms = Dsp.processCompressorOffline(burst, null, { threshold: -20, ratio: 8, attackMs: 2, releaseMs: 80, detection: "rms", mix: 100 }, sr);
  const compScHpf = Dsp.processCompressorOffline(burst, null, { threshold: -20, ratio: 8, scHpfHz: 180, mix: 100 }, sr);
  const compMix0 = Dsp.processCompressorOffline(burst, null, { threshold: -20, ratio: 8, mix: 0 }, sr);
  assert.notEqual(rms(compPeak.left, 9900), rms(compRms.left, 9900));
  assert.ok(rms(compScHpf.left, 2000) > rms(compPeak.left, 2000));
  assert.ok(Math.abs(rms(compMix0.left, 0) - rms(burst, 0)) < 1e-6);

  // 4. Expander/Gate hysteresisDb, holdMs, scHpfHz
  const gateSig = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) {
    gateSig[i] = i < sr / 2 ? 0.5 * Math.sin(2 * Math.PI * 1000 * i / sr) : 0.005 * Math.sin(2 * Math.PI * 60 * i / sr);
  }
  const gated = Dsp.processExpanderGateOffline(gateSig, null, { thresholdDb: -24, rangeDb: -50, holdMs: 40, hysteresisDb: 6, scHpfHz: 120 }, sr);
  assert.ok(rms(gated.left, sr * 0.75) < rms(gateSig, sr * 0.75) * 0.25);
  assert.ok(rms(gated.left, 2000) > 0.2);

  // 5. De-Esser split vs wideband & attack/release
  const sib = new Float32Array(sr / 2);
  for (let i = 0; i < sib.length; i += 1) {
    sib[i] = 0.25 * Math.sin(2 * Math.PI * 400 * i / sr) + 0.5 * Math.sin(2 * Math.PI * 7200 * i / sr);
  }
  const deSplit = Dsp.processDeEsserOffline(sib, null, { freqHz: 7000, thresholdDb: -28, cutDb: 12, wideband: 0, attackMs: 1, releaseMs: 30 }, sr);
  const deWide = Dsp.processDeEsserOffline(sib, null, { freqHz: 7000, thresholdDb: -28, cutDb: 12, wideband: 1, attackMs: 1, releaseMs: 30 }, sr);
  assert.ok(rms(deSplit.left, 4000) < rms(sib, 4000));
  assert.ok(rms(deWide.left, 4000) < rms(deSplit.left, 4000));

  // 6. Reverb offline & HALL_IR_PRESETS labels & customIrData
  for (const key of Object.keys(Dsp.HALL_IR_PRESETS)) {
    assert.ok(typeof Dsp.HALL_IR_PRESETS[key].label === "string" && Dsp.HALL_IR_PRESETS[key].label.length > 0);
  }
  const click = new Float32Array(sr / 2);
  click[500] = 0.8;
  const customIr = new Array(4000).fill(0);
  customIr[0] = 0.9;
  customIr[2500] = 0.6;
  const revOut = Dsp.processReverbOffline(click, new Float32Array(click), {
    decay: 1.5, wet: 50, customIrData: { left: customIr, right: customIr }
  }, sr);
  assert.ok(Math.abs(revOut.left[3000]) > 0.05);

  // 7. Delay L/R taps, BPM sync, Ping-Pong alternation, runaway feedback clamp
  const ping = new Float32Array(sr);
  ping[100] = 0.9;
  const dlySync = Dsp.processDelayOffline(ping, new Float32Array(sr), {
    bpm: 120, syncSubdiv: 0, pingPong: 1, feedback: 150, wet: 50, modDepthMs: 0
  }, sr);
  let maxDelayVal = 0;
  for (const ch of [dlySync.left, dlySync.right]) {
    for (let i = 0; i < ch.length; i += 1) {
      assert.ok(Number.isFinite(ch[i]));
      if (Math.abs(ch[i]) > maxDelayVal) maxDelayVal = Math.abs(ch[i]);
    }
  }
  assert.ok(maxDelayVal < 2.5);
  // First 1/4 echo at 120 BPM = 500ms = 24000 samples (pingPong feeds mono sum into L buffer, echoing at 24100)
  assert.ok(Math.abs(dlySync.left[24100]) > 0.05);

  // 8. Saturation Tape (odd symmetry) vs Tube (even asymmetry), low DC, autoGain unity matching
  const satSine = new Float32Array(sr);
  const amp18 = Math.pow(10, -18 / 20) * Math.SQRT2;
  for (let i = 0; i < sr; i += 1) satSine[i] = amp18 * Math.sin(2 * Math.PI * 500 * i / sr);
  const tapeOut = Dsp.processSaturationOffline(satSine, null, { drive: 55, mode: 0, autoGain: 1, mix: 100 }, sr);
  const tubeOut = Dsp.processSaturationOffline(satSine, null, { drive: 55, mode: 1, autoGain: 1, mix: 100 }, sr);
  let tubeSum = 0;
  for (let i = 2000; i < tubeOut.left.length; i += 1) tubeSum += tubeOut.left[i];
  const tubeDc = Math.abs(tubeSum / (tubeOut.left.length - 2000));
  assert.ok(tubeDc < 0.01);
  const inDb = 20 * Math.log10(Math.max(1e-6, rms(satSine, 2000)));
  const tapeDb = 20 * Math.log10(Math.max(1e-6, rms(tapeOut.left, 2000)));
  assert.ok(Math.abs(tapeDb - inDb) <= 2.5);
  assert.notEqual(rms(tapeOut.left, 2000), rms(tubeOut.left, 2000));

  // 9. Stereo Width bassMonoHz keeps 55 Hz mono while keeping 3 kHz wide
  const bassL = new Float32Array(sr);
  const bassR = new Float32Array(sr);
  const hiL = new Float32Array(sr);
  const hiR = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) {
    bassL[i] = 0.4 * Math.sin(2 * Math.PI * 55 * i / sr);
    bassR[i] = -0.4 * Math.sin(2 * Math.PI * 55 * i / sr);
    hiL[i] = 0.4 * Math.sin(2 * Math.PI * 3000 * i / sr);
    hiR[i] = -0.4 * Math.sin(2 * Math.PI * 3000 * i / sr);
  }
  const bassMonoed = Dsp.processStereoWidthOffline(bassL, bassR, { widthPct: 160, bassMonoHz: 150 }, sr);
  const hiStayedWide = Dsp.processStereoWidthOffline(hiL, hiR, { widthPct: 160, bassMonoHz: 150 }, sr);
  let bassDiffSq = 0;
  let hiDiffSq = 0;
  for (let i = 4000; i < sr; i += 1) {
    const bd = bassMonoed.left[i] - bassMonoed.right[i];
    const hd = hiStayedWide.left[i] - hiStayedWide.right[i];
    bassDiffSq += bd * bd;
    hiDiffSq += hd * hd;
  }
  assert.ok(Math.sqrt(bassDiffSq / (sr - 4000)) < 0.18);
  assert.ok(Math.sqrt(hiDiffSq / (sr - 4000)) > 0.7);

  // 10. processFxRackOffline wetDry 0 vs 100 & Part 12 DAW_CHAIN_PRESETS + static UI/CSS contracts
  const rackBypass = Dsp.processFxRackOffline(tone1k, new Float32Array(tone1k), [
    { type: "eq", enabled: true, wetDry: 0, params: { b1k: 6, on3: 1 } }
  ], sr);
  const rackWet = Dsp.processFxRackOffline(tone1k, new Float32Array(tone1k), [
    { type: "eq", enabled: true, wetDry: 100, params: { b1k: 6, on3: 1 } }
  ], sr);
  assert.ok(Math.abs(rms(rackBypass.left, 2000) - rms(tone1k, 2000)) < 1e-4);
  assert.ok(rms(rackWet.left, 2000) > rms(rackBypass.left, 2000) * 1.4);

  const expectedChainIds = [
    "natural_vocal_processing", "harmonium_eq", "tabla_eq", "vocal_deesser",
    "mandir_hall_reverb", "vocal_compressor", "master_glue", "streaming_master"
  ];
  for (const id of expectedChainIds) {
    assert.ok(Dsp.DAW_CHAIN_PRESETS[id] && Array.isArray(Dsp.DAW_CHAIN_PRESETS[id].slots) && Dsp.DAW_CHAIN_PRESETS[id].slots.length > 0);
  }
  assert.equal(Object.keys(Dsp.FX_CATALOG).length, 10);

  const dawUiSrc = fs.readFileSync(path.join(__dirname, "../public/js/live-stream-daw-ui.js"), "utf8");
  const ejsSrc = fs.readFileSync(path.join(__dirname, "../views/admin-live-stream.ejs"), "utf8");
  const cssSrc = fs.readFileSync(path.join(__dirname, "../public/css/live-stream-studio.css"), "utf8");
  assert.ok(dawUiSrc.includes("setWetDry("));
  assert.ok(dawUiSrc.includes("DAW_CHAIN_PRESETS"));
  assert.ok(dawUiSrc.includes("ls-eq-band-strip-grid"));
  assert.ok(ejsSrc.includes("lsDawChainPresetSelect") && ejsSrc.includes("lsDawApplyChainPresetBtn") && ejsSrc.includes("lsDawSaveChainPresetBtn"));
  assert.ok(cssSrc.includes(".ls-eq-band-strip-grid") && cssSrc.includes(".ls-plugin-param-grid"));
  assert.equal((cssSrc.match(/!important/g) || []).length, 0);
});

test("Phase 5: Advanced Multitrack DAW — latency compensation, 7 automation lanes, cut/join/range gain, grouping, bar/beat snap, history & UI contracts", () => {
  // 1. Insert latency compensation calculation for Linear-Phase FIR EQ
  assert.equal(typeof Dsp.getFxRackLatencySamples, "function");
  assert.equal(Dsp.getFxRackLatencySamples([
    { type: "eq", enabled: true, params: { linearPhase: 0 } },
    { type: "compressor", enabled: true, params: {} }
  ], 48000), 0);
  assert.equal(Dsp.getFxRackLatencySamples([
    { type: "eq", enabled: true, params: { linearPhase: 1 } },
    { type: "eq", enabled: false, params: { linearPhase: 1 } }
  ], 48000), 256);

  // 2. 7 Automation lanes & clearAutomationLane
  const st = Engine.createInitialState();
  const expectedLanes = ["gain", "pan", "clipGain", "eqPresenceDb", "compThreshold", "reverbSend", "fxWetDry"];
  expectedLanes.forEach((lane) => {
    assert.ok(Engine.AUTOMATION_LANES[lane], `Missing AUTOMATION_LANES.${lane}`);
    assert.ok(Array.isArray(st.tracks[0].automation[lane]));
  });
  const autoPt = Engine.addAutomationPoint(st, "track-1", "eqPresenceDb", 2.5, 4.0);
  assert.ok(autoPt && st.tracks[0].automation.eqPresenceDb.length === 1);
  assert.equal(Engine.evaluateAutomation(st.tracks[0].automation.eqPresenceDb, 2.5, 0), 4.0);
  assert.equal(Engine.clearAutomationLane(st, "track-1", "eqPresenceDb"), true);
  assert.equal(st.tracks[0].automation.eqPresenceDb.length, 0);

  // 3. Bar/Beat snap + Sample-accurate quantization + TimelineConfig roundtrip
  Engine.setTimelineConfig(st, { rulerMode: "bars", bpm: 120, beatsPerBar: 4, sampleRate: 48000 });
  const snappedBeat = Engine.snapTime(st, 1.48, { gridEnabled: true, markersEnabled: false });
  assert.ok(Math.abs(snappedBeat - 1.5) < 1e-4);

  // 4. Split -> Join, Cut -> Paste, and Range-Based Gain
  const srcId = Engine.addSource(st, { id: "src-p5", name: "bhajan_dry.wav", duration: 12, sampleRate: 48000 });
  const clip = Engine.appendClip(st, { sourceId: srcId, trackId: "track-1", timelineOffsetSec: 0, label: "Lead" });
  assert.equal(Engine.splitAt(st, 6.0, "track-1"), true);
  assert.equal(st.clips.length, 2);

  const joined = Engine.joinClips(st, [st.clips[0].id, st.clips[1].id]);
  assert.ok(joined && st.clips.length === 1);
  assert.ok(Math.abs(joined.sourceStart - 0) < 1e-3 && Math.abs(joined.sourceEnd - 12) < 1e-3);

  const rangeMod = Engine.applyRangeGain(st, 2.0, 5.0, 3.5, "track-1");
  assert.equal(rangeMod, 1);
  assert.equal(st.clips.length, 3);
  assert.equal(st.clips[1].gainDb, 3.5);
  assert.equal(st.clips[0].gainDb, 0);
  assert.equal(st.clips[2].gainDb, 0);

  const cutCount = Engine.cutClips(st, [st.clips[1].id]);
  assert.equal(cutCount, 1);
  assert.equal(st.clips.length, 2);
  const pasted = Engine.pasteClips(st, 4.0, "track-1");
  assert.equal(pasted.length, 1);
  assert.equal(st.clips.length, 3);

  // 5. Track Grouping linked gain/mute/solo
  Engine.setTrackGroup(st, "track-1", "A");
  Engine.setTrackGroup(st, "track-2", "A");
  Engine.updateTrackProps(st, "track-1", { gain: 115, mute: true });
  assert.equal(Engine.getTrackById(st, "track-2").gain, 115);
  assert.equal(Engine.getTrackById(st, "track-2").mute, true);

  // 6. Labeled History Browser & Multi-Step Jump + Manifest Roundtrip
  const hist = Engine.getHistoryList(st);
  assert.ok(hist.undoItems.length >= 4);
  assert.ok(hist.undoItems.some((u) => u.label === "Range Gain"));
  const jumped = Engine.jumpToHistoryStep(st, "undo", 2);
  assert.equal(jumped, 2);
  assert.equal(Engine.getHistoryList(st).redoItems.length, 2);

  const manifest = Engine.exportProjectManifest(st, { sessionDate: "2026-11-25" });
  assert.equal(manifest.timelineConfig.bpm, 120);
  assert.equal(manifest.timelineConfig.rulerMode, "bars");
  const st2 = Engine.createInitialState();
  Engine.importProjectManifest(st2, manifest);
  assert.equal(st2.timelineConfig.bpm, 120);

  // 7. Static Recorder / UI / EJS / CSS Phase 5 Contracts
  const dspSrc = fs.readFileSync(path.join(__dirname, "../public/js/live-stream-dsp.js"), "utf8");
  const recSrc = fs.readFileSync(path.join(__dirname, "../public/js/live-stream-recorder.js"), "utf8");
  const dawUiSrc = fs.readFileSync(path.join(__dirname, "../public/js/live-stream-daw-ui.js"), "utf8");
  const ejsSrc = fs.readFileSync(path.join(__dirname, "../views/admin-live-stream.ejs"), "utf8");
  const cssSrc = fs.readFileSync(path.join(__dirname, "../public/css/live-stream-studio.css"), "utf8");

  assert.ok(dspSrc.includes("automationTargets"));
  assert.ok(recSrc.includes("saveArtifactFile:") && recSrc.includes("readFileFromSessionDir"));
  assert.ok(dawUiSrc.includes("renderSingleTrackBufferOffline") && dawUiSrc.includes("freezeOrUnfreezeTrack") && dawUiSrc.includes("getOrBuildPyramid"));
  [
    "lsDawRulerModeSelect", "lsDawBpmInput", "lsDawJoinClipsBtn", "lsDawCutClipBtn",
    "lsDawCopyClipBtn", "lsDawPasteClipBtn", "lsDawRangeNormBtn", "lsDawPrevMarkerBtn",
    "lsDawNextMarkerBtn", "lsDawAutoClearBtn", "lsDawHistoryBtn", "lsDawHistoryMenu",
    "lsDawTrackHeightBtn", "lsDawWaveScaleBtn", "lsDawImportProjectInput",
    "lsDawSlipBackBtn", "lsDawSlipFwdBtn"
  ].forEach((id) => {
    assert.ok(ejsSrc.includes(`id="${id}"`), `Missing Phase 5 DAW element #${id}`);
  });
  assert.ok(cssSrc.includes(".ls-daw-history-popover") && cssSrc.includes(".ls-daw-track-box.is-frozen"));
  assert.equal((cssSrc.match(/!important/g) || []).length, 0);
  void clip;
});

test("Phase 6: Mastering Engine & Offline Rendering — 9-stage master chain, 7-metric loudness, dynamics guard, stateful chunked DSP, stereo Sinc SRC & TPDF Int16", () => {
  const sr = 48000;

  // 1. Default Master Track includes modular mastering stages (some optional bypassed) + inputTrimDb
  const st = Engine.createInitialState();
  assert.equal(st.masterTrack.inputTrimDb, 0);
  assert.ok(st.masterTrack.fxRack.length >= 6);
  assert.equal(st.masterTrack.fxRack.find((s) => s.id === "fx-master-eq")?.enabled, true);
  assert.equal(st.masterTrack.fxRack.find((s) => s.id === "fx-master-glue")?.enabled, true);
  assert.equal(st.masterTrack.fxRack.find((s) => s.id === "fx-master-lim")?.enabled, true);
  assert.equal(st.masterTrack.fxRack.find((s) => s.id === "fx-master-sat")?.enabled, false);
  Engine.updateTrackProps(st, "master", { inputTrimDb: -3.5 });
  assert.equal(st.masterTrack.inputTrimDb, -3.5);

  // 2. Delivery profiles & Smart Dynamics Guard prevents excessive >6dB limiting crush
  assert.ok(Dsp.MASTERING_DELIVERY_PROFILES.streaming_14.targetLufs === -14);
  assert.ok(Dsp.MASTERING_DELIVERY_PROFILES.podcast_16.targetLufs === -16);
  const preDynStats = { integratedLufs: -28, truePeakDb: -2.0, samplePeakDb: -2.1 };
  const safety = Dsp.evaluateNormalizationSafety(preDynStats, { targetLufs: -14, ceilingDb: -1.0, maxAllowedGrDb: 6.0 });
  assert.equal(safety.canReachTargetCleanly, false);
  assert.equal(safety.gainCapped, true);
  assert.ok(safety.safeGainDb < safety.requestedGainDb);

  const sparseSpike = new Float32Array(sr);
  for (let i = 0; i < sr; i += 1) sparseSpike[i] = 0.03 * Math.sin((2 * Math.PI * 330 * i) / sr);
  sparseSpike[sr / 2] = 0.85; // high peak vs quiet body (~ -29 LUFS)
  const normSafe = Dsp.normalizeToTargetLufs(sparseSpike, null, { targetLufs: -14, ceilingDb: -1.0, sampleRate: sr, protectDynamics: true });
  assert.equal(normSafe.gainCapped, true);
  assert.ok(normSafe.truePeakDb <= -0.95);
  assert.ok(normSafe.loudnessReport && Number.isFinite(normSafe.loudnessReport.shortTermMaxLufs) && Number.isFinite(normSafe.loudnessReport.rmsDb));

  // 3. Rack effect tail calculation for Reverb & Delay
  const tailSec = Dsp.computeRackTailSeconds([
    { mute: false, fxRack: [{ type: "reverb", enabled: true, params: { decay: 2.2, preDelayMs: 40 } }] },
    { mute: true, fxRack: [{ type: "reverb", enabled: true, params: { decay: 4.0, preDelayMs: 100 } }] }
  ], null);
  assert.ok(tailSec >= 2.5 && tailSec <= 3.0);

  // 4. Stateful chunked mastering processor preserves continuity across chunks without clicks or NaN
  const wholeIn = makeSine(440, 0.5, 0.35, sr);
  const chunkRack = [
    { type: "eq", enabled: true, wetDry: 100, params: { hpfHz: 40, b1k: 2.0, linearPhase: 0 } },
    { type: "compressor", enabled: true, wetDry: 100, params: { threshold: -16, ratio: 3.0, attackMs: 5, releaseMs: 120 } },
    { type: "saturation", enabled: true, wetDry: 100, params: { drive: 20, mode: 0, mix: 35, autoGain: 1 } },
    { type: "limiter", enabled: true, wetDry: 100, params: { ceilingDb: -1.0, releaseMs: 80 } }
  ];
  const proc = Dsp.createStatefulMasterProcessor({ masterRack: chunkRack, inputTrimDb: -1.5, sampleRate: sr });
  const c1 = proc.processChunk(wholeIn.subarray(0, sr / 4), wholeIn.subarray(0, sr / 4));
  const c2 = proc.processChunk(wholeIn.subarray(sr / 4), wholeIn.subarray(sr / 4));
  assertCleanAudio(c1.left, "StatefulMaster Chunk 1");
  assertCleanAudio(c2.left, "StatefulMaster Chunk 2");
  const seamJump = Math.abs(c2.left[0] - c1.left[c1.left.length - 1]);
  assert.ok(seamJump < 0.08, `Expected smooth chunk seam continuity, got delta=${seamJump}`);

  // 5. Stereo Sinc SRC (48k -> 44.1k) & TPDF Dithered Int16 encoder
  const sine48 = makeSine(1000, 0.25, 0.4, 48000);
  const res441 = WavUtils.resampleStereoSinc(sine48, sine48, 48000, 44100);
  assert.equal(res441.sampleRate, 44100);
  assert.ok(res441.right && Math.abs(res441.left.length - Math.round(sine48.length * (44100 / 48000))) <= 4);
  assertCleanAudio(res441.left, "Stereo Sinc 48k->44.1k");

  const ditheredInt16 = WavUtils.floatToInt16Dithered(res441.left, { dither: true, seed: 42 });
  assert.ok(ditheredInt16 instanceof Int16Array && ditheredInt16.length === res441.left.length);

  // 6. Static Mastering Dock UI & CSS Contracts (0 !important)
  const dawUiSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-daw-ui.js"), "utf8");
  const ejsSrc = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "public/css/live-stream-studio.css"), "utf8");
  assert.ok(dawUiSrc.includes("renderTimelineInChunksOffline") && dawUiSrc.includes("renderLoudnessReportCard") && dawUiSrc.includes("analyzeMixOffline"));
  assert.ok(dawUiSrc.includes("resampleStereoSinc") && dawUiSrc.includes("floatToInt16Dithered"));
  [
    "lsDawExportSampleRateSelect", "lsDawMasterTrimInput", "lsDawCustomLufsWrap",
    "lsDawCustomLufsInput", "lsDawCustomCeilingInput", "lsDawProtectDynamicsCheck",
    "lsDawLoudnessReportCard", "lsDawAnalyzeMixBtn"
  ].forEach((id) => {
    assert.ok(ejsSrc.includes(`id="${id}"`), `Missing Phase 6 element #${id}`);
  });
  assert.ok(cssSrc.includes(".ls-loudness-report-card") && cssSrc.includes(".ls-loudness-advisory"));
  assert.equal((cssSrc.match(/!important/g) || []).length, 0);
});

test("Phase 7: Automated Cloud Workflow — structured R2 keys, decimal timestamp parsing, idempotent republish & revision history, manifest validation & UI contracts", async () => {
  // 1. Decimal-safe timestamp parsing
  assert.equal(audioStorageService.parseTimestampToSeconds("125.75"), 125);
  assert.equal(audioStorageService.parseTimestampToSeconds("02:05.8"), 125);
  assert.equal(audioStorageService.parseTimestampToSeconds("01:02:03.9"), 3723);
  assert.equal(audioStorageService.parseTimestampToSeconds(-10), 0);
  assert.equal(audioStorageService.parseTimestampToSeconds(""), 0);

  // 2. Session manifest schema validator
  const okManifest = audioStorageService.validateSessionManifest({
    project_uid: "proj-2026-11-26-phase7",
    session_date: "2026-11-26",
    sample_rate: 48000,
    bit_depth: 24,
    duration_seconds: 1840,
    timestamps: [{ bhajan_title: "Jai Sai Ram", start_seconds: 12 }]
  });
  assert.equal(okManifest.valid, true);
  assert.equal(okManifest.errors.length, 0);

  const badManifest = audioStorageService.validateSessionManifest({
    session_date: "bad-date",
    sample_rate: 1200,
    bit_depth: 12,
    duration_seconds: -5
  });
  assert.equal(badManifest.valid, false);
  assert.ok(badManifest.errors.length >= 4);

  // 3. Controller idempotency, revision history & timestamp preservation with SQLite test DB
  await setupTestDb();
  const StudioProject = require("../models/StudioProject");
  const SessionAudio = require("../models/SessionAudio");
  const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
  const prevAudio = await SessionAudio.findOne({ where: { session_date: "2026-11-26" } });
  if (prevAudio) {
    await SessionAudioTimestamp.destroy({ where: { session_audio_id: prevAudio.id } }).catch(() => {});
    await prevAudio.destroy().catch(() => {});
  }
  await StudioProject.destroy({ where: { project_uid: "proj-phase7-test" } }).catch(() => {});
  const liveCtrl = require("../controllers/liveStreamController");

  const makeMockRes = () => {
    const out = { statusCode: 200, body: null };
    out.status = (code) => { out.statusCode = code; return out; };
    out.json = (payload) => { out.body = payload; return out; };
    return out;
  };

  // Invalid manifest blocked with 400
  const invalidProjRes = makeMockRes();
  await liveCtrl.saveStudioProject({
    body: {
      project_uid: "proj-phase7-test",
      session_date: "2026-11-26",
      sample_rate: 500,
      bit_depth: 11,
      manifest: { session_date: "2026-11-26", sample_rate: 500, bit_depth: 11 }
    }
  }, invalidProjRes);
  assert.equal(invalidProjRes.statusCode, 400);
  assert.equal(invalidProjRes.body.success, false);

  // Create initial StudioProject
  const saveProjRes = makeMockRes();
  await liveCtrl.saveStudioProject({
    body: {
      project_uid: "proj-phase7-test",
      session_date: "2026-11-26",
      title: "Phase 7 Test Session",
      sample_rate: 48000,
      bit_depth: 24,
      duration_seconds: 620,
      manifest: { projectUid: "proj-phase7-test", sessionDate: "2026-11-26", sampleRate: 48000, bitDepth: 24 }
    }
  }, saveProjRes);
  assert.equal(saveProjRes.statusCode, 200);
  assert.equal(saveProjRes.body.success, true);

  // First publish (live_ref) with duplicate timestamp entry -> deduplicated & sorted
  const pub1Res = makeMockRes();
  await liveCtrl.r2PublishSession({
    ip: "127.0.0.1",
    body: {
      session_date: "2026-11-26",
      project_uid: "proj-phase7-test",
      title: "Phase 7 Test Session",
      storage_key: "recordings/2026-11-26/proj-phase7-test/live-ref.mp3",
      audio_url: "https://cdn.example.com/recordings/2026-11-26/proj-phase7-test/live-ref.mp3",
      duration_seconds: 620,
      file_size_bytes: 512000,
      artifact_role: "live_ref",
      checksum_sha256: "aaa111",
      timestamps: [
        { bhajan_title: "Second Bhajan", start_seconds: 180 },
        { bhajan_title: "First Bhajan", start_seconds: 10 },
        { bhajan_title: "First Bhajan", start_seconds: 10, submission_id: 77 }
      ]
    }
  }, pub1Res);
  assert.equal(pub1Res.body.success, true);
  assert.equal(pub1Res.body.timestampCount, 2);
  assert.equal(pub1Res.body.revisionsCount, 1);

  // Exact retry should detect idempotency & not duplicate revisions
  const retryRes = makeMockRes();
  await liveCtrl.r2PublishSession({
    ip: "127.0.0.1",
    body: {
      session_date: "2026-11-26",
      project_uid: "proj-phase7-test",
      title: "Phase 7 Test Session",
      storage_key: "recordings/2026-11-26/proj-phase7-test/live-ref.mp3",
      audio_url: "https://cdn.example.com/recordings/2026-11-26/proj-phase7-test/live-ref.mp3",
      duration_seconds: 620,
      file_size_bytes: 512000,
      artifact_role: "live_ref",
      checksum_sha256: "aaa111"
    }
  }, retryRes);
  assert.equal(retryRes.body.success, true);
  assert.equal(retryRes.body.idempotentRetry, true);
  assert.equal(retryRes.body.preservedTimestamps, true);
  assert.equal(retryRes.body.revisionsCount, 1);

  // Second publish (final_master) without timestamps preserves existing SessionAudioTimestamps
  const pub2Res = makeMockRes();
  await liveCtrl.r2PublishSession({
    ip: "127.0.0.1",
    body: {
      session_date: "2026-11-26",
      project_uid: "proj-phase7-test",
      title: "Phase 7 Mastered",
      storage_key: "recordings/2026-11-26/proj-phase7-test/final-master.mp3",
      audio_url: "https://cdn.example.com/recordings/2026-11-26/proj-phase7-test/final-master.mp3",
      duration_seconds: 635,
      file_size_bytes: 920000,
      artifact_role: "final_master",
      checksum_sha256: "bbb222"
    }
  }, pub2Res);
  assert.equal(pub2Res.body.success, true);
  assert.equal(pub2Res.body.preservedTimestamps, true);
  assert.equal(pub2Res.body.timestampCount, 2);
  assert.equal(pub2Res.body.revisionsCount, 2);

  // Saving project again afterwards preserves published revisions history
  const saveProj2 = makeMockRes();
  await liveCtrl.saveStudioProject({
    body: {
      project_uid: "proj-phase7-test",
      session_date: "2026-11-26",
      sample_rate: 48000,
      bit_depth: 24,
      manifest: { projectUid: "proj-phase7-test", sessionDate: "2026-11-26", sampleRate: 48000, bitDepth: 24 }
    }
  }, saveProj2);
  assert.equal(saveProj2.statusCode, 200);
  const reloadedProj = await StudioProject.findOne({ where: { project_uid: "proj-phase7-test" } });
  const parsedKeys = JSON.parse(reloadedProj.r2_keys_json);
  assert.equal(parsedKeys.revisions.length, 2);
  assert.equal(parsedKeys.final_master_key, "recordings/2026-11-26/proj-phase7-test/final-master.mp3");
  const tsCount = await SessionAudioTimestamp.count({ where: { session_audio_id: pub2Res.body.audio.id } });
  assert.equal(tsCount, 2);

  // 4. Client recorder, studio, DAW bridge & EJS contracts
  const recSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-recorder.js"), "utf8");
  const studioSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-studio.js"), "utf8");
  const dawUiSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-daw-ui.js"), "utf8");
  const ejsSrc = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");
  const ctrlSrc = fs.readFileSync(path.join(ROOT, "controllers/liveStreamController.js"), "utf8");

  assert.ok(recSrc.includes("buildStructuredR2Key") && recSrc.includes("bp_studio_uploads_v1"));
  assert.ok(recSrc.includes("uploadAuxObjectToR2") && recSrc.includes("retryPendingUploads") && recSrc.includes("backupDryStemsToR2"));
  assert.ok(studioSrc.includes("syncInitialStudioProject") && studioSrc.includes("sample_frame"));
  assert.ok(studioSrc.includes("lsBackupDryStemsR2Btn") && studioSrc.includes("lsRetryQueuedUploadsBtn"));
  assert.ok(dawUiSrc.includes('artifactRole: "final_master"') && dawUiSrc.includes("projectManifest: exportManifest"));
  assert.ok(ctrlSrc.includes("requestedType") && ctrlSrc.includes("idempotentRetry"));
  [
    "lsAutoOpenDawCheck", "lsAutoUploadRefCheck",
    "lsBackupDryStemsR2Btn", "lsRetryQueuedUploadsBtn", "lsQueuedCountBadge"
  ].forEach((id) => {
    assert.ok(ejsSrc.includes(`id="${id}"`), `Missing Phase 7 element #${id}`);
  });
});

test("Phase 8: Dual-Theme Studio UI — semantic token 1:1 parity, global CSS isolation, zero !important, HiDPI canvases, rotary knobs & contextual workspace switcher", () => {
  const cssSrc = fs.readFileSync(path.join(ROOT, "public/css/live-stream-studio.css"), "utf8");
  const ejsSrc = fs.readFileSync(path.join(ROOT, "views/admin-live-stream.ejs"), "utf8");
  const studioSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-studio.js"), "utf8");
  const dawUiSrc = fs.readFileSync(path.join(ROOT, "public/js/live-stream-daw-ui.js"), "utf8");

  // 1. Strict 0 !important rule
  assert.equal((cssSrc.match(/!important/g) || []).length, 0);

  // 2. Parse Light and Dark token blocks and enforce 1:1 parity
  const lightStart = cssSrc.indexOf(".ls-studio-wrap {");
  const darkStart = cssSrc.indexOf('[data-theme="dark"] .ls-studio-wrap');
  const postDark = cssSrc.indexOf(".ls-studio-wrap *,");
  assert.ok(lightStart > 0 && darkStart > lightStart && postDark > darkStart);

  const lightBlock = cssSrc.slice(lightStart, darkStart);
  const darkBlock = cssSrc.slice(darkStart, postDark);
  const extractDefs = (block) => new Set([...block.matchAll(/(--studio-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const lightDefs = extractDefs(lightBlock);
  const darkDefs = extractDefs(darkBlock);

  assert.ok(lightDefs.size >= 35, `Expected comprehensive light token set, got ${lightDefs.size}`);
  for (const tok of lightDefs) {
    assert.ok(darkDefs.has(tok), `Light token ${tok} missing in Dark theme block`);
  }
  for (const tok of darkDefs) {
    assert.ok(lightDefs.has(tok), `Dark token ${tok} missing in Light theme block`);
  }

  // Every referenced var(--studio-*) across CSS and JS must exist in both Light & Dark definitions
  const usedTokens = new Set([
    ...[...cssSrc.matchAll(/var\((--studio-[a-z0-9-]+)/g)].map((m) => m[1]),
    ...[...studioSrc.matchAll(/--studio-[a-z0-9-]+/g)].map((m) => m[0]),
    ...[...dawUiSrc.matchAll(/--studio-[a-z0-9-]+/g)].map((m) => m[0])
  ]);
  for (const tok of usedTokens) {
    assert.ok(lightDefs.has(tok), `Referenced ${tok} missing in Light theme tokens`);
    assert.ok(darkDefs.has(tok), `Referenced ${tok} missing in Dark theme tokens`);
  }

  // 3. Part 13 Section 30 palette alignment
  [
    "#101218", "#141820", "#191f29", "#202734", "#151a22", "#303a49", "#f3f5f8", "#a1acbc", "#a855f7", "#529bff",
    "#f2f4f8", "#f7f8fa", "#ffffff", "#f0f2f6", "#dde2ea", "#202633", "#647084", "#8145d9", "#3579d5"
  ].forEach((hex) => {
    assert.ok(cssSrc.toLowerCase().includes(hex.toLowerCase()), `Missing Section 30 token hex ${hex}`);
  });

  // 4. Global style.css isolation rules (typography + control min-height + input contrast)
  assert.ok(cssSrc.includes("min-height: 0;"));
  assert.ok(cssSrc.includes(".ls-studio-wrap h1"));
  assert.ok(cssSrc.includes('[data-theme="dark"] .ls-studio-wrap input.ls-input'));
  assert.ok(cssSrc.includes("background: var(--studio-panel-elevated);") && !cssSrc.includes("var(--studio-elevated)"));

  // 5. Phase 8 markup & JS component contracts
  [
    "lsStudioThemeToggleBtn", "lsListenerChip", "lsIoRibbonDetails", "lsIoSummaryTag",
    "lsDawWorkspaceViewBar", "lsReverbDecayChip"
  ].forEach((id) => {
    assert.ok(ejsSrc.includes(`id="${id}"`), `Missing Phase 8 element #${id}`);
  });
  assert.ok(ejsSrc.includes('data-rotary-for="lsVocalPan"') && ejsSrc.includes('data-rotary-for="lsInstPan"') && ejsSrc.includes('data-rotary-for="lsReverbDecay"'));
  assert.ok(studioSrc.includes("prepareHiDpiCanvas") && studioSrc.includes("wireRotaryKnobs") && studioSrc.includes("syncRotaryVisuals"));
  assert.ok(dawUiSrc.includes("prepareHiDpiCanvas") && dawUiSrc.includes("ls-daw-tracks-corner") && dawUiSrc.includes("ls-fx-cat-tag") && dawUiSrc.includes("data-daw-view-btn"));
});

test("Phase 9A: Part 14 Full 10-Signal Audio Regression Corpus, THD, Noise Floor, Linear-Phase Latency Alignment, A/B Comparator & Python BPAS Protocol", () => {
  const { execFileSync } = require("node:child_process");
  const {
    runFullAudioQualityBenchmark,
    compareWavFilesAB
  } = require("../scripts/verify_audio_workstation");

  const report = runFullAudioQualityBenchmark({ sampleRate: 48000, full60s: false });

  // 1. Section 36 quantitative DSP & quality gates
  assert.ok(report.eqFlatnessMaxErrDb < 0.05, `Neutral EQ passband drift too high: ${report.eqFlatnessMaxErrDb}`);
  assert.ok(report.neutralThd.thdPercent < 0.02, `Neutral EQ THD too high: ${report.neutralThd.thdPercent}%`);
  assert.ok(
    report.saturationThd.thdPercent > 0.2 && report.saturationThd.thdPercent < 20,
    `Expected musical Tape Saturation THD between 0.2% and 20%, got ${report.saturationThd.thdPercent}%`
  );
  assert.ok(report.noiseFloor.chainSilencePeakDb <= -96, `Silence chain noise floor exceeded -96 dBFS: ${report.noiseFloor.chainSilencePeakDb}`);
  assert.ok(report.noiseFloor.wav24QuantNoiseDb <= -135, `24-bit quantization floor too high: ${report.noiseFloor.wav24QuantNoiseDb}`);
  assert.ok(
    report.noiseFloor.wav16TpdfNoiseDb >= -99 && report.noiseFloor.wav16TpdfNoiseDb <= -88,
    `Expected 16-bit TPDF dither floor in [-99, -88] dBFS, got ${report.noiseFloor.wav16TpdfNoiseDb}`
  );
  assert.equal(report.latencyAlignment.reportedLatencySamples, 256);
  assert.ok(report.latencyAlignment.sampleSkew <= 1, `Expected <= 1 sample alignment skew, got ${report.latencyAlignment.sampleSkew}`);

  // 2. All 10 Section 37 reference signals (including pink_noise & full_stereo_ensemble)
  assert.equal(report.corpusResults.length, 10);
  [
    "silence", "sine_1khz", "sweep_20_20k", "impulse", "white_noise",
    "pink_noise", "vocal_phrase", "harmonium_reeds", "tabla_bols", "full_stereo_ensemble"
  ].forEach((sigName) => {
    const row = report.corpusResults.find((r) => r.name === sigName);
    assert.ok(row, `Missing corpus signal ${sigName}`);
    assert.equal(row.nonFinite, 0, `${sigName} produced non-finite samples`);
    assert.equal(row.clippedSamples, 0, `${sigName} exceeded 0 dBFS`);
    assert.ok(row.dcOffset < 0.015, `${sigName} DC offset too high: ${row.dcOffset}`);
    assert.ok(row.truePeakDb <= -0.92, `${sigName} true peak exceeded limit: ${row.truePeakDb}`);
  });

  // 3. Mastering LUFS convergence & stateful chunk continuity
  assert.ok(
    Math.abs(report.masteringConvergence.integratedLufs - (-14.0)) <= 0.6,
    `Expected -14.0 +/- 0.6 LUFS convergence, got ${report.masteringConvergence.integratedLufs}`
  );
  assert.ok(report.masteringConvergence.truePeakDb <= -0.95);
  assert.ok(report.chunkSeamMaxJump < 0.08, `Stateful chunk seam jump too high: ${report.chunkSeamMaxJump}`);

  // 4. Section 38 Level-Matched WAV A/B Comparator detects spectral tilt accurately on broadband pink noise
  const sr = 48000;
  const { generateReferenceCorpus } = require("../scripts/verify_audio_workstation");
  const baseL = generateReferenceCorpus(sr, 2.0).pink_noise;
  const brightOut = Dsp.processParametricEqOffline(baseL, baseL, { b10k: 6.0 }, sr);
  const wavFlat = WavUtils.encodeStereoWavBuffer({ left: baseL, right: baseL, sampleRate: sr, bitDepth: 24 });
  const wavBright = WavUtils.encodeStereoWavBuffer({ left: brightOut.left, right: brightOut.right, sampleRate: sr, bitDepth: 24 });
  const cmp = compareWavFilesAB(wavFlat, wavBright);
  assert.ok(Math.abs(cmp.fileBMatched.integratedLufs - cmp.fileA.integratedLufs) <= 0.2);
  assert.ok(cmp.deltasBMinusA.airDb > 1.5, `Expected Air band boost delta > 1.5 dB, got ${cmp.deltasBMinusA.airDb}`);

  // 5. Python local_asio_bridge.py BPAS-v1 binary packet interoperability
  const pyCmd = [
    "-c",
    "import scripts.local_asio_bridge as b, sys; sys.stdout.buffer.write(b.pack_bpas_packet([0.25, -0.5, 0.75], [-0.25, 0.5, -0.75]))"
  ];
  const pktBuf = execFileSync("python", pyCmd, { cwd: ROOT });
  assert.equal(pktBuf.subarray(0, 4).toString("ascii"), "BPAS");
  const view = new DataView(pktBuf.buffer, pktBuf.byteOffset, pktBuf.byteLength);
  const frames = view.getUint32(4, true);
  assert.equal(frames, 3);
  const ch1 = [view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true)];
  const ch2 = [view.getFloat32(20, true), view.getFloat32(24, true), view.getFloat32(28, true)];
  assert.deepEqual(ch1, [0.25, -0.5, 0.75]);
  assert.deepEqual(ch2, [-0.25, 0.5, -0.75]);

  // 6. Part 17 Zero-Cost Local-First Package Audit (no paid audio/cloud-DSP dependencies)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const depNames = Object.keys(pkg.dependencies || {});
  ["dolby", "izotope", "waves", "twilio", "agora", "mux", "assemblyai", "elevenlabs"].forEach((paid) => {
    assert.equal(depNames.some((d) => d.toLowerCase().includes(paid)), false, `Unexpected paid dependency ${paid}`);
  });
});

test("Phase 9B: Part 16 Complete 21-Step End-to-End Mandir Workflow — Soundcheck -> Untouched 24-bit Dry Stems -> Timestamps -> DAW Ripple Edit, Presets & Automation -> Master WAV & LAME MP3 -> R2 Presign & SessionAudio Republish -> Reopen Roundtrip", async () => {
  const crypto = require("node:crypto");
  const { generateReferenceCorpus, decodeWavBufferToFloat32 } = require("../scripts/verify_audio_workstation");
  const sr = 48000;

  // Steps 1-5: Connect 2-ch interface, assign In1=Vocals / In2=Instruments, pass 3-Stage Soundcheck
  const sc = Soundcheck.createSoundcheckSession({
    deviceName: "Behringer UMC202HD (Phase 9 E2E)",
    sourceType: "asio",
    sampleRate: sr,
    channelCount: 2
  });
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_VOCAL);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.42, rms1: 0.21, peak2: 0.008, rms2: 0.004, corr12: 0.05 });
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_INST);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.007, rms1: 0.003, peak2: 0.39, rms2: 0.19, corr12: 0.06 });
  Soundcheck.setSoundcheckStage(sc, Soundcheck.STAGE_BOTH);
  Soundcheck.ingestTelemetryFrame(sc, { peak1: 0.44, rms1: 0.22, peak2: 0.38, rms2: 0.18, corr12: 0.12 });
  const readiness = Soundcheck.evaluateReadiness(sc, { requireDualInput: true });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.canRecordDualStems, true);

  // Steps 6-9: Capture untouched 24-bit/48kHz dry stems + verify SHA-256 immutability
  const corpus = generateReferenceCorpus(sr, 5.0);
  const dryCh1Wav = WavUtils.encodeStereoWavBuffer({ left: corpus.vocal_phrase, sampleRate: sr, bitDepth: 24 });
  const dryCh2Wav = WavUtils.encodeStereoWavBuffer({ left: corpus.harmonium_reeds, sampleRate: sr, bitDepth: 24 });
  assert.equal(WavUtils.verifyWavHeaderAndSize(dryCh1Wav).valid, true);
  assert.equal(WavUtils.verifyWavHeaderAndSize(dryCh2Wav).valid, true);
  const drySha1Before = crypto.createHash("sha256").update(dryCh1Wav).digest("hex");
  const drySha2Before = crypto.createHash("sha256").update(dryCh2Wav).digest("hex");

  // Steps 10-16: Open decoded dry stems in DAW, capture markers, ripple-cut silence/intro, apply Part 12 presets & automation
  const decVocal = decodeWavBufferToFloat32(dryCh1Wav);
  const decInst = decodeWavBufferToFloat32(dryCh2Wav);
  const daw = Engine.createInitialState();
  const srcV = Engine.addSource(daw, { id: "src-vocal", name: "vocals-dry.wav", duration: 5.0 });
  const srcI = Engine.addSource(daw, { id: "src-inst", name: "instruments-dry.wav", duration: 5.0 });
  Engine.appendClip(daw, { sourceId: srcV, trackId: daw.tracks[0].id });
  Engine.appendClip(daw, { sourceId: srcI, trackId: daw.tracks[1].id });

  Engine.addMarker(daw, { bhajan_title: "Ganesha Stuti", singer_name: "Samiti Lead", start_seconds: 0.5 });
  Engine.addMarker(daw, { bhajan_title: "Sai Ram Dhun", singer_name: "Chorus", start_seconds: 3.5 });
  assert.equal(Engine.rippleDeleteRange(daw, 1.0, 2.0, { joinCrossfadeSec: 0.15 }), true);

  // Markers after the cut range shift earlier by ~1.0s while pre-cut marker stays anchored
  const shiftedSecondMarker = daw.markers.find((m) => m.bhajan_title === "Sai Ram Dhun");
  assert.ok(shiftedSecondMarker && Math.abs(shiftedSecondMarker.start_seconds - 2.5) <= 0.25);

  const chainPresets = Object.values(Dsp.DAW_CHAIN_PRESETS || {});
  const vocalPreset = chainPresets.find((p) => /vocal/i.test(p.label || p.id || ""));
  const masterPreset = chainPresets.find((p) => /master/i.test(p.label || p.id || ""));
  if (vocalPreset) {
    vocalPreset.slots.forEach((s) => Engine.addTrackFx(daw, daw.tracks[0].id, s.type, s.params));
  }
  if (masterPreset) {
    masterPreset.slots.forEach((s) => Engine.addTrackFx(daw, "master", s.type, s.params));
  }
  Engine.addAutomationPoint(daw, daw.tracks[0].id, "gain", 0, 100);
  Engine.addAutomationPoint(daw, daw.tracks[0].id, "gain", 4, 110);

  // Step 17: Offline Track + Master DSP mixdown -> 24-bit Master WAV + LAME MP3
  const vFx = Dsp.processFxRackOffline(decVocal.left, null, daw.tracks[0].fxRack, sr);
  const iFx = Dsp.processFxRackOffline(decInst.left, null, daw.tracks[1].fxRack, sr);
  const mixL = new Float32Array(vFx.left.length);
  const mixR = new Float32Array(vFx.left.length);
  for (let i = 0; i < mixL.length; i += 1) {
    mixL[i] = vFx.left[i] * 0.65 + (iFx.left[i] || 0) * 0.5;
    mixR[i] = vFx.left[i] * 0.65 + (iFx.right ? iFx.right[i] : (iFx.left[i] || 0)) * 0.5;
  }
  const mastered = Dsp.normalizeToTargetLufs(mixL, mixR, { targetLufs: -14.0, ceilingDb: -1.0, sampleRate: sr });
  assert.ok(Dsp.measureTruePeakDb(mastered.left, mastered.right) <= -0.95);

  const masterWav24 = WavUtils.encodeStereoWavBuffer({ left: mastered.left, right: mastered.right, sampleRate: sr, bitDepth: 24 });
  assert.equal(WavUtils.verifyWavHeaderAndSize(masterWav24).valid, true);

  const { Mp3Encoder } = await import("@breezystack/lamejs");
  const mp3Enc = new Mp3Encoder(2, sr, 192);
  const intL = WavUtils.floatToInt16Dithered(mastered.left, { dither: true, seed: 9 });
  const intR = WavUtils.floatToInt16Dithered(mastered.right, { dither: true, seed: 10 });
  const mp3Chunks = [];
  const block = 11520;
  for (let off = 0; off < intL.length; off += block) {
    const end = Math.min(intL.length, off + block);
    const encBuf = mp3Enc.encodeBuffer(intL.subarray(off, end), intR.subarray(off, end));
    if (encBuf && encBuf.length > 0) mp3Chunks.push(Buffer.from(encBuf));
  }
  const flushBuf = mp3Enc.flush();
  if (flushBuf && flushBuf.length > 0) mp3Chunks.push(Buffer.from(flushBuf));
  const masterMp3Buf = Buffer.concat(mp3Chunks);
  assert.ok(masterMp3Buf.byteLength > 2000, `Expected valid MP3 output > 2 KB, got ${masterMp3Buf.byteLength}`);
  assert.equal(masterMp3Buf[0], 0xff);
  assert.equal((masterMp3Buf[1] & 0xe0) === 0xe0, true);

  // Steps 18-21: AWS SigV4 Presign, StudioProject save, Live Ref + Final Master republish, Reopen Roundtrip & Dry Immutability
  process.env.CLOUDFLARE_R2_ACCOUNT_ID = "phase9-account";
  process.env.CLOUDFLARE_R2_BUCKET_NAME = "bhajan-audio";
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = "AKIAEXAMPLEKEY999";
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "SecretExampleKeyValueForPhase9E2ETest";

  const liveRefKey = "recordings/2026-11-27/proj-phase9-e2e/live-ref.mp3";
  const finalMasterKey = "recordings/2026-11-27/proj-phase9-e2e/final-master.mp3";
  const presignedFinal = audioStorageService.createPresignedR2Url({ key: finalMasterKey, expiresIn: 900 });
  assert.ok(presignedFinal.url.includes("X-Amz-Signature="));

  await setupTestDb();
  const StudioProject = require("../models/StudioProject");
  const SessionAudio = require("../models/SessionAudio");
  const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
  const liveCtrl = require("../controllers/liveStreamController");

  const prevAudio = await SessionAudio.findOne({ where: { session_date: "2026-11-27" } });
  if (prevAudio) {
    await SessionAudioTimestamp.destroy({ where: { session_audio_id: prevAudio.id } }).catch(() => {});
    await prevAudio.destroy().catch(() => {});
  }
  await StudioProject.destroy({ where: { project_uid: "proj-phase9-e2e" } }).catch(() => {});

  const makeMockRes = () => {
    const out = { statusCode: 200, body: null };
    out.status = (code) => { out.statusCode = code; return out; };
    out.json = (payload) => { out.body = payload; return out; };
    return out;
  };

  const manifestOut = Engine.exportProjectManifest(daw, {
    projectUid: "proj-phase9-e2e",
    sessionDate: "2026-11-27",
    localFiles: { ch1DryWav: "vocals-dry.wav", ch2DryWav: "instruments-dry.wav" }
  });

  const saveRes = makeMockRes();
  await liveCtrl.saveStudioProject({
    body: {
      project_uid: "proj-phase9-e2e",
      session_date: "2026-11-27",
      title: "Phase 9 Mandir Workflow",
      sample_rate: sr,
      bit_depth: 24,
      duration_seconds: 4,
      manifest: manifestOut
    }
  }, saveRes);
  assert.equal(saveRes.statusCode, 200);

  const pubLiveRes = makeMockRes();
  await liveCtrl.r2PublishSession({
    ip: "127.0.0.1",
    body: {
      session_date: "2026-11-27",
      project_uid: "proj-phase9-e2e",
      title: "Phase 9 Live Reference",
      storage_key: liveRefKey,
      audio_url: `https://cdn.example.com/${liveRefKey}`,
      duration_seconds: 5,
      file_size_bytes: masterMp3Buf.byteLength,
      artifact_role: "live_ref",
      timestamps: daw.markers
    }
  }, pubLiveRes);
  assert.equal(pubLiveRes.body.success, true);
  assert.equal(pubLiveRes.body.timestampCount, 2);

  const pubFinalRes = makeMockRes();
  await liveCtrl.r2PublishSession({
    ip: "127.0.0.1",
    body: {
      session_date: "2026-11-27",
      project_uid: "proj-phase9-e2e",
      title: "Phase 9 Final Mastered",
      storage_key: finalMasterKey,
      audio_url: `https://cdn.example.com/${finalMasterKey}`,
      duration_seconds: 4,
      file_size_bytes: masterMp3Buf.byteLength,
      artifact_role: "final_master"
    }
  }, pubFinalRes);
  assert.equal(pubFinalRes.body.success, true);
  assert.equal(pubFinalRes.body.preservedTimestamps, true);
  assert.equal(pubFinalRes.body.revisionsCount, 2);
  assert.equal(pubFinalRes.body.audio.storage_key, finalMasterKey);

  // Reopen StudioProject manifest and verify exact edit state roundtrip
  const getRes = makeMockRes();
  await liveCtrl.getStudioProject({ params: { idOrDate: "proj-phase9-e2e" } }, getRes);
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.body.project.r2_keys.revisions.length, 2);

  const reopened = Engine.createInitialState();
  Engine.importProjectManifest(reopened, getRes.body.project.manifest);
  assert.equal(reopened.markers.length, 2);
  assert.equal(reopened.tracks[0].automation.gain.length, 2);
  assert.ok(reopened.tracks[0].fxRack.length >= 1);

  // Verify original dry 24-bit WAV buffers remained bit-exact throughout
  const drySha1After = crypto.createHash("sha256").update(dryCh1Wav).digest("hex");
  const drySha2After = crypto.createHash("sha256").update(dryCh2Wav).digest("hex");
  assert.equal(drySha1After, drySha1Before);
  assert.equal(drySha2After, drySha2Before);
});




