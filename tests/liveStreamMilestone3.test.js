const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const LiveStreamDsp = require("../public/js/live-stream-dsp");
const { DEFAULT_PRESETS } = require("../services/liveStreamService");

function makeSine(freqHz, durationSec, amplitude, sampleRate = 48000) {
  const n = Math.floor(durationSec * sampleRate);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    buf[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return buf;
}

function rmsDb(arr, startIdx = 0) {
  let sum = 0;
  const count = arr.length - startIdx;
  if (count <= 0) return -Infinity;
  for (let i = startIdx; i < arr.length; i += 1) {
    sum += arr[i] * arr[i];
  }
  const rms = Math.sqrt(sum / count);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

test("Milestone 3 DSP module exports required mastering & loudness helpers", () => {
  assert.equal(typeof LiveStreamDsp.buildHallImpulseResponse, "function");
  assert.equal(typeof LiveStreamDsp.buildChannelAndMasterDsp, "function");
  assert.equal(typeof LiveStreamDsp.applyNoiseGateOffline, "function");
  assert.equal(typeof LiveStreamDsp.measureIntegratedLufs, "function");
  assert.equal(typeof LiveStreamDsp.normalizeToTargetLufs, "function");
  assert.equal(typeof LiveStreamDsp.computeEqCurvePoints, "function");
});

test("computeEqCurvePoints reflects active 5-band EQ gains and returns 0 dB when bypassed", () => {
  const flatPts = LiveStreamDsp.computeEqCurvePoints({
    b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0, bypass: false
  });
  assert.ok(flatPts.every((p) => Math.abs(p.db) < 0.01));

  const boostedConfig = {
    b80: 6, b250: -3, b1k: 0, b3k5: 4.5, b10k: 2, bypass: false
  };
  const activePts = LiveStreamDsp.computeEqCurvePoints(boostedConfig, [32, 80, 250, 3500]);
  assert.ok(activePts[0].db > 5.0, `Expected full low shelf boost at 32 Hz, got ${activePts[0].db}`);
  assert.ok(activePts[1].db > 2.5, `Expected low shelf corner boost at 80 Hz, got ${activePts[1].db}`);
  assert.ok(activePts[2].db < -1.5, `Expected dip at 250 Hz, got ${activePts[2].db}`);
  assert.ok(activePts[3].db > 3.0, `Expected presence boost at 3500 Hz, got ${activePts[3].db}`);

  const bypassedPts = LiveStreamDsp.computeEqCurvePoints({ ...boostedConfig, bypass: true });
  assert.ok(bypassedPts.every((p) => p.db === 0));
});

test("applyNoiseGateOffline preserves active vocals (-12 dB) and attenuates room noise (-60 dB)", () => {
  const sr = 48000;
  const loudSig = makeSine(440, 0.5, Math.pow(10, -12 / 20), sr);
  const beforeLoudDb = rmsDb(loudSig, 4800);
  LiveStreamDsp.applyNoiseGateOffline(loudSig, sr, -48, 80, 120);
  const afterLoudDb = rmsDb(loudSig, 4800);
  assert.ok(Math.abs(afterLoudDb - beforeLoudDb) < 0.5, "Loud signal above gate threshold should pass untouched");

  const quietFloor = makeSine(100, 0.6, Math.pow(10, -60 / 20), sr);
  const beforeNoiseDb = rmsDb(quietFloor, Math.floor(sr * 0.3));
  LiveStreamDsp.applyNoiseGateOffline(quietFloor, sr, -48, 80, 120);
  const afterNoiseDb = rmsDb(quietFloor, Math.floor(sr * 0.3));
  assert.ok(
    beforeNoiseDb - afterNoiseDb > 25,
    `Expected >25 dB attenuation on -60 dB noise, got ${(beforeNoiseDb - afterNoiseDb).toFixed(1)} dB`
  );
});

test("measureIntegratedLufs and normalizeToTargetLufs normalize to -14 LUFS and enforce -1.0 dBTP ceiling", () => {
  const sr = 48000;

  // Silence safety check
  const silent = new Float32Array(sr);
  assert.equal(LiveStreamDsp.measureIntegratedLufs(silent, null, sr), -Infinity);
  const silentRes = LiveStreamDsp.normalizeToTargetLufs(silent, null, { targetLufs: -14, ceilingDb: -1.0, sampleRate: sr });
  assert.equal(silentRes.outputLufs, -Infinity);
  assert.equal(silentRes.gainDb, 0);

  // Quiet stereo signal -> normalized to -14 LUFS within 0.3 LU tolerance
  const amp = 0.08;
  const left = makeSine(1000, 1.2, amp, sr);
  const right = makeSine(1000, 1.2, amp, sr);
  const res = LiveStreamDsp.normalizeToTargetLufs(left, right, {
    targetLufs: -14,
    ceilingDb: -1.0,
    sampleRate: sr
  });
  assert.ok(Number.isFinite(res.inputLufs) && res.inputLufs < -16);
  assert.ok(Math.abs(res.outputLufs - (-14)) < 0.35, `Expected ~ -14 LUFS, got ${res.outputLufs}`);
  assert.ok(res.peakDb <= -0.99, `Expected peak <= -1.0 dBTP, got ${res.peakDb}`);

  // Transient spike signal hitting ceiling limiter
  const spikeL = makeSine(440, 1.2, 0.15, sr);
  const spikeR = makeSine(440, 1.2, 0.15, sr);
  spikeL[24000] = 0.95;
  const peakProtected = LiveStreamDsp.normalizeToTargetLufs(spikeL, spikeR, {
    targetLufs: -14,
    ceilingDb: -1.0,
    sampleRate: sr
  });
  assert.equal(peakProtected.limiterEngaged, true);
  assert.ok(peakProtected.peakDb <= -0.99, `Expected peak clipped cleanly at ceiling, got ${peakProtected.peakDb}`);
});

test("Built-in studio presets include deesser and glueComp mastering parameters", () => {
  const studioPresets = DEFAULT_PRESETS.filter((p) => p.isBuiltIn && p.id !== "builtin-flat");
  assert.ok(studioPresets.length >= 4);
  for (const p of studioPresets) {
    assert.ok(typeof p.config.vocal.deesser === "number" && p.config.vocal.deesser > 0);
    assert.equal(p.config.master.glueComp, true);
  }
  const flat = DEFAULT_PRESETS.find((p) => p.id === "builtin-flat");
  assert.ok(flat);
  assert.equal(flat.config.vocal.deesser, 0);
  assert.equal(flat.config.master.glueComp, false);
});

test("Milestone 3 Studio & DAW markup, styles, and scripts are wired cleanly", () => {
  const ejsPath = path.join(__dirname, "../views/admin-live-stream.ejs");
  const cssPath = path.join(__dirname, "../public/css/live-stream-studio.css");
  const studioJsPath = path.join(__dirname, "../public/js/live-stream-studio.js");
  const dawUiPath = path.join(__dirname, "../public/js/live-stream-daw-ui.js");

  const ejs = fs.readFileSync(ejsPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");
  const studioJs = fs.readFileSync(studioJsPath, "utf8");
  const dawUi = fs.readFileSync(dawUiPath, "utf8");

  // Script load order
  const dspIdx = ejs.indexOf("/js/live-stream-dsp.js");
  const dawIdx = ejs.indexOf("/js/live-stream-daw-ui.js");
  const studioIdx = ejs.indexOf("/js/live-stream-studio.js");
  assert.ok(dspIdx > 0 && dspIdx < dawIdx && dspIdx < studioIdx);

  // Studio & DAW UI controls present
  [
    "lsVocalDeesser",
    "lsVocalGrBar",
    "lsGlueCompBtn",
    "lsLimiterGrBar",
    "lsEqSpectrumCanvas",
    "lsDawApplyFxCheck",
    "lsDawNoiseGateCheck",
    "lsDawLufsSelect",
    "lsDawLoudnessReport"
  ].forEach((id) => {
    assert.ok(ejs.includes(`id="${id}"`), `Missing control #${id} in admin-live-stream.ejs`);
  });

  // Studio JS integration
  assert.ok(studioJs.includes("vocalDeesser"));
  assert.ok(studioJs.includes("glueComp"));
  assert.ok(studioJs.includes("drawEqAndSpectrum"));
  assert.ok(studioJs.includes("getActiveFxConfig"));

  // DAW UI DSP integration
  assert.ok(dawUi.includes("buildChannelAndMasterDsp"));
  assert.ok(dawUi.includes("applyNoiseGateOffline"));
  assert.ok(dawUi.includes("normalizeToTargetLufs"));
  assert.ok(dawUi.includes('addEventListener("keydown"'));

  // CSS rules must have zero !important
  assert.equal((css.match(/!important/g) || []).length, 0);
});
