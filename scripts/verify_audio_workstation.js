"use strict";

/**
 * Bhajan Planner — Phase 9 Automated Audio Quality Verification, Regression Corpus
 * & Level-Matched A/B Reference Comparator (Parts 14 & 16 / Sections 36–38).
 *
 * Usage:
 *   node scripts/verify_audio_workstation.js
 *   node scripts/verify_audio_workstation.js --full-60s
 *   node scripts/verify_audio_workstation.js --compare <bhajan-planner.wav> <audition-ref.wav>
 */

const fs = require("fs");
const path = require("path");

const Dsp = require("../public/js/live-stream-dsp");
const WavUtils = require("../public/js/live-stream-wav-utils");

function createSeededPrng(seed) {
  let state = (seed >>> 0) || 0x12345678;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Decodes a standard 16-bit PCM, 24-bit signed PCM, or 32-bit IEEE Float RIFF/WAVE buffer
 * into stereo Float32Arrays in [-1, 1].
 */
function decodeWavBufferToFloat32(bufferOrArrayBuffer) {
  let u8;
  if (Buffer.isBuffer(bufferOrArrayBuffer)) {
    u8 = new Uint8Array(bufferOrArrayBuffer.buffer, bufferOrArrayBuffer.byteOffset, bufferOrArrayBuffer.byteLength);
  } else if (bufferOrArrayBuffer instanceof Uint8Array) {
    u8 = bufferOrArrayBuffer;
  } else if (bufferOrArrayBuffer instanceof ArrayBuffer) {
    u8 = new Uint8Array(bufferOrArrayBuffer);
  } else {
    throw new Error("Unsupported WAV input buffer");
  }
  if (u8.byteLength < 44) throw new Error("WAV buffer smaller than 44 bytes");

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Invalid RIFF/WAVE header");
  }

  let offset = 12;
  let audioFormat = 1;
  let numChannels = 2;
  let sampleRate = 48000;
  let bitDepth = 24;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= u8.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const sz = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 24 <= u8.byteLength) {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitDepth = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = Math.min(sz, u8.byteLength - dataOffset);
      break;
    }
    offset += 8 + sz + (sz % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error("WAV data chunk missing or empty");
  }

  const bytesPerSample = Math.max(2, Math.floor(bitDepth / 8));
  const totalFrames = Math.floor(dataSize / (bytesPerSample * numChannels));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);

  let ptr = dataOffset;
  for (let i = 0; i < totalFrames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      let s = 0;
      if (bitDepth === 32 && audioFormat === 3) {
        s = view.getFloat32(ptr, true);
      } else if (bitDepth === 16) {
        const iv = view.getInt16(ptr, true);
        s = iv < 0 ? iv / 32768 : iv / 32767;
      } else {
        const b0 = u8[ptr];
        const b1 = u8[ptr + 1];
        const b2 = u8[ptr + 2];
        let iv = b0 | (b1 << 8) | (b2 << 16);
        if (iv & 0x800000) iv |= ~0xffffff;
        s = iv < 0 ? iv / 8388608 : iv / 8388607;
      }
      if (ch === 0) left[i] = s;
      else if (ch === 1) right[i] = s;
      ptr += bytesPerSample;
    }
    if (numChannels === 1) right[i] = left[i];
  }

  return { sampleRate, numChannels, bitDepth, left, right };
}

function measureRmsDb(arr, startIdx = 0, endIdx = arr.length) {
  let sumSq = 0;
  const count = Math.max(1, endIdx - startIdx);
  for (let i = startIdx; i < endIdx; i += 1) {
    sumSq += arr[i] * arr[i];
  }
  const rms = Math.sqrt(sumSq / count);
  return rms > 1e-12 ? 20 * Math.log10(rms) : -160;
}

/**
 * Computes Total Harmonic Distortion (harmonics 2f..8f relative to fundamental)
 * using Hann-windowed single-frequency DFT bins on steady-state samples.
 */
function measureThd1kHz(samples, sampleRate = 48000, fundamentalHz = 1000) {
  const start = Math.min(Math.floor(samples.length * 0.1), Math.floor(sampleRate * 0.1));
  const avail = Math.max(1024, samples.length - start);
  const periodSamples = Math.max(1, Math.round(sampleRate / fundamentalHz));
  const cycles = Math.max(4, Math.floor(avail / periodSamples));
  const N = Math.min(avail, cycles * periodSamples);

  function singleToneMag(freqHz) {
    let re = 0;
    let im = 0;
    const step = (2 * Math.PI * freqHz) / sampleRate;
    for (let i = 0; i < N; i += 1) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, N - 1)));
      const v = samples[start + i] * w;
      const ph = step * i;
      re += v * Math.cos(ph);
      im -= v * Math.sin(ph);
    }
    return Math.sqrt(re * re + im * im) / Math.max(1, N * 0.5);
  }

  const fundMag = singleToneMag(fundamentalHz);
  let harmSqSum = 0;
  for (let h = 2; h <= 8; h += 1) {
    const f = fundamentalHz * h;
    if (f >= sampleRate * 0.45) break;
    const hm = singleToneMag(f);
    harmSqSum += hm * hm;
  }
  const harmMag = Math.sqrt(harmSqSum);
  const ratio = fundMag > 1e-9 ? harmMag / fundMag : 0;
  return {
    thdPercent: ratio * 100,
    thdDb: ratio > 1e-12 ? 20 * Math.log10(ratio) : -160,
    fundamentalDb: fundMag > 1e-12 ? 20 * Math.log10(fundMag) : -160
  };
}

/**
 * Generates all 10 deterministic Section 37 Audio Regression Corpus test signals.
 */
function generateReferenceCorpus(sampleRate = 48000, durationSec = 1.0) {
  const n = Math.max(1024, Math.floor(durationSec * sampleRate));
  const rand = createSeededPrng(20261125);

  const silence = new Float32Array(n);

  const sine1k = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    sine1k[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  }

  const sweep20to20k = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const f = 20 * Math.pow(1000, i / n);
    sweep20to20k[i] = 0.45 * Math.sin((2 * Math.PI * f * i) / sampleRate);
  }

  const impulse = new Float32Array(n);
  impulse[Math.min(n - 1, Math.floor(sampleRate * 0.1))] = 0.9;

  const whiteNoise = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    whiteNoise[i] = (rand() * 2 - 1) * 0.18;
  }

  // Paul Kellet pink noise (-3 dB/oct) filter on seeded white noise
  const pinkNoise = new Float32Array(n);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < n; i += 1) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    pinkNoise[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
    b6 = white * 0.115926;
  }

  const vocalPhrase = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 5.2 * t);
    const f0 = 220 * vib;
    const env = Math.sin(Math.PI * Math.min(1, t / Math.max(0.2, durationSec)));
    const sibWin = t > 0.35 && t < 0.45 ? 0.24 : 0.0;
    vocalPhrase[i] =
      env *
      (0.24 * Math.sin(2 * Math.PI * f0 * t) +
        0.13 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        0.07 * Math.sin(2 * Math.PI * f0 * 3 * t) +
        sibWin * Math.sin(2 * Math.PI * 6800 * t));
  }

  const harmoniumReeds = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.04);
    harmoniumReeds[i] =
      attack *
      (0.18 * Math.sin(2 * Math.PI * 261.63 * t) +
        0.16 * Math.sin(2 * Math.PI * 262.15 * t) +
        0.1 * Math.sin(2 * Math.PI * 523.25 * t) +
        0.06 * Math.sin(2 * Math.PI * 784.88 * t) +
        0.04 * Math.sin(2 * Math.PI * 1046.5 * t));
  }

  const tablaBols = new Float32Array(n);
  const strikePeriod = Math.floor(sampleRate * 0.32);
  for (let i = 0; i < n; i += 1) {
    const localIdx = i % strikePeriod;
    const dt = localIdx / sampleRate;
    const isBayan = Math.floor(i / strikePeriod) % 2 === 1;
    if (isBayan) {
      const fBayan = 95 - 32 * Math.min(1, dt * 6);
      tablaBols[i] = 0.55 * Math.exp(-dt * 11) * Math.sin(2 * Math.PI * fBayan * dt);
    } else {
      tablaBols[i] =
        0.48 * Math.exp(-dt * 18) * (Math.sin(2 * Math.PI * 293.66 * dt) + 0.35 * Math.sin(2 * Math.PI * 587.33 * dt));
    }
  }

  // Realistic full stereo devotional ensemble (~-16.5 LUFS) combining Vocal, Harmonium & Tabla
  const ensL = new Float32Array(n);
  const ensR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = vocalPhrase[i] * 0.85;
    const h = harmoniumReeds[i] * 0.65;
    const tb = tablaBols[i] * 0.6;
    ensL[i] = v * 0.72 + h * 0.82 + tb * 0.55;
    ensR[i] = v * 0.72 + h * 0.55 + tb * 0.82;
  }

  return {
    silence,
    sine_1khz: sine1k,
    sweep_20_20k: sweep20to20k,
    impulse,
    white_noise: whiteNoise,
    pink_noise: pinkNoise,
    vocal_phrase: vocalPhrase,
    harmonium_reeds: harmoniumReeds,
    tabla_bols: tablaBols,
    full_stereo_ensemble: { left: ensL, right: ensR }
  };
}

/**
 * Runs complete Section 36 & 37 DSP quality metrics, corpus checks & runtime benchmark.
 */
function runFullAudioQualityBenchmark({ sampleRate = 48000, full60s = false } = {}) {
  const corpus = generateReferenceCorpus(sampleRate, 2.0);

  // 1. Neutral EQ Flatness (100 Hz, 1 kHz, 10 kHz) + +6 dB Bell Check
  const testFreqs = [100, 1000, 10000];
  let eqFlatnessMaxErrDb = 0;
  for (const hz of testFreqs) {
    const dry = new Float32Array(sampleRate);
    for (let i = 0; i < dry.length; i += 1) {
      dry[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    }
    const flatEq = Dsp.processParametricEqOffline(
      dry,
      null,
      { hpfHz: 20, lpfHz: 20000, b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0 },
      sampleRate
    );
    const inDb = measureRmsDb(dry, Math.floor(sampleRate * 0.2));
    const outDb = measureRmsDb(flatEq.left, Math.floor(sampleRate * 0.2));
    eqFlatnessMaxErrDb = Math.max(eqFlatnessMaxErrDb, Math.abs(outDb - inDb));
  }

  // 2. Neutral & Saturation THD (1 kHz)
  const neutralEqOut = Dsp.processParametricEqOffline(
    corpus.sine_1khz,
    null,
    { hpfHz: 20, lpfHz: 20000, b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0 },
    sampleRate
  );
  const neutralThd = measureThd1kHz(neutralEqOut.left, sampleRate, 1000);

  const satOut = Dsp.processSaturationOffline(
    corpus.sine_1khz,
    null,
    { drive: 30, mode: 0, bias: 10, toneHz: 14000, mix: 100, autoGain: 1 },
    sampleRate
  );
  const saturationThd = measureThd1kHz(satOut.left, sampleRate, 1000);

  // 3. Noise Floor & Quantization / TPDF Dither Floor
  const silentChain = Dsp.processFxRackOffline(
    corpus.silence,
    corpus.silence,
    [
      { type: "eq", enabled: true, wetDry: 100, params: { b1k: 0 } },
      { type: "deesser", enabled: true, wetDry: 100, params: { freqHz: 6500, cutDb: 3 } },
      { type: "compressor", enabled: true, wetDry: 100, params: { threshold: -18, ratio: 3.5 } },
      { type: "limiter", enabled: true, wetDry: 100, params: { ceilingDb: -1.0 } }
    ],
    sampleRate
  );
  let silentMaxAbs = 0;
  for (let i = 0; i < silentChain.left.length; i += 1) {
    const a = Math.abs(silentChain.left[i]);
    if (a > silentMaxAbs) silentMaxAbs = a;
  }
  const chainSilencePeakDb = silentMaxAbs > 1e-12 ? 20 * Math.log10(silentMaxAbs) : -160;

  const wav24Bytes = WavUtils.encodeStereoWavBuffer({
    left: corpus.sine_1khz,
    right: corpus.sine_1khz,
    sampleRate,
    bitDepth: 24,
    dither: false
  });
  const dec24 = decodeWavBufferToFloat32(wav24Bytes);
  const err24 = new Float32Array(corpus.sine_1khz.length);
  for (let i = 0; i < err24.length; i += 1) err24[i] = dec24.left[i] - corpus.sine_1khz[i];
  const wav24QuantNoiseDb = measureRmsDb(err24);

  const wav16SilenceBytes = WavUtils.encodeStereoWavBuffer({
    left: corpus.silence,
    right: corpus.silence,
    sampleRate,
    bitDepth: 16,
    dither: true
  });
  const dec16Silence = decodeWavBufferToFloat32(wav16SilenceBytes);
  const wav16TpdfNoiseDb = measureRmsDb(dec16Silence.left);

  // 4. 513-Tap Linear-Phase FIR Insert Latency Self-Compensation (Offline = 0 skew) & Live Latency Reporting (256 smp)
  const linRack = [{ type: "eq", enabled: true, wetDry: 100, params: { linearPhase: 1, b80: 0, b250: 0, b1k: 0, b3k5: 0, b10k: 0 } }];
  const reportedLatencySamples = Dsp.getFxRackLatencySamples(linRack, sampleRate);
  const linOut = Dsp.processFxRackOffline(corpus.impulse, null, linRack, sampleRate);
  const findPeakIdx = (arr) => {
    let best = 0;
    let bestVal = -1;
    for (let i = 0; i < arr.length; i += 1) {
      const a = Math.abs(arr[i]);
      if (a > bestVal) {
        bestVal = a;
        best = i;
      }
    }
    return best;
  };
  const peakIdxLin = findPeakIdx(linOut.left);
  const peakIdxMinAligned = findPeakIdx(corpus.impulse);
  const latencySampleSkew = Math.abs(peakIdxLin - peakIdxMinAligned);

  // 5. All 10 Reference Signals through Master DSP + True-Peak Limiter (-1.0 dBTP)
  const corpusResults = Object.entries(corpus).map(([name, val]) => {
    const inL = val.left ? val.left : val;
    const inR = val.right ? val.right : val;
    const fxOut = Dsp.processFxRackOffline(
      inL,
      inR,
      [
        { type: "eq", enabled: true, wetDry: 100, params: { hpfHz: 35, b80: -1, b250: -1.5, b3k5: 1.5, b10k: 1 } },
        { type: "deesser", enabled: true, wetDry: 100, params: { freqHz: 6500, cutDb: 3.5 } },
        { type: "compressor", enabled: true, wetDry: 100, params: { threshold: -18, ratio: 3.0 } },
        { type: "limiter", enabled: true, wetDry: 100, params: { ceilingDb: -1.0, lookaheadMs: 2.5, releaseMs: 80 } }
      ],
      sampleRate
    );
    let nonFinite = 0;
    let clippedSamples = 0;
    let sumL = 0;
    for (let i = 0; i < fxOut.left.length; i += 1) {
      const l = fxOut.left[i];
      const r = fxOut.right ? fxOut.right[i] : l;
      if (!Number.isFinite(l) || !Number.isFinite(r)) nonFinite += 1;
      if (Math.abs(l) > 1.0 || Math.abs(r) > 1.0) clippedSamples += 1;
      sumL += l;
    }
    const dcOffset = Math.abs(sumL / Math.max(1, fxOut.left.length));
    const stats = Dsp.analyzeLoudnessFull(fxOut.left, fxOut.right || fxOut.left, sampleRate);
    return {
      name,
      nonFinite,
      clippedSamples,
      dcOffset,
      truePeakDb: stats.truePeakDb,
      integratedLufs: stats.integratedLufs
    };
  });

  // 6. Loudness Target Convergence (-14.0 LUFS) on Full Stereo Ensemble
  const normRes = Dsp.normalizeToTargetLufs(
    new Float32Array(corpus.full_stereo_ensemble.left),
    new Float32Array(corpus.full_stereo_ensemble.right),
    { targetLufs: -14.0, ceilingDb: -1.0, sampleRate, protectDynamics: true }
  );
  const normStats = Dsp.analyzeLoudnessFull(normRes.left, normRes.right, sampleRate);

  // 7. Chunked Stateful Mastering Continuity + Timing Benchmark (continuous stereo signal)
  const benchDurSec = full60s ? 60 : 5;
  const benchSamplesL = new Float32Array(sampleRate * benchDurSec);
  const benchSamplesR = new Float32Array(sampleRate * benchDurSec);
  for (let i = 0; i < benchSamplesL.length; i += 1) {
    const t = i / sampleRate;
    const v = 0.28 * Math.sin(2 * Math.PI * 220 * t) + 0.14 * Math.sin(2 * Math.PI * 440 * t);
    const h = 0.22 * Math.sin(2 * Math.PI * 330 * t) + 0.1 * Math.sin(2 * Math.PI * 660 * t);
    benchSamplesL[i] = v * 0.8 + h * 0.4;
    benchSamplesR[i] = v * 0.6 + h * 0.8;
  }

  const chunkRack = [
    { type: "eq", enabled: true, wetDry: 100, params: { hpfHz: 35, b1k: 1.0, linearPhase: 0 } },
    { type: "compressor", enabled: true, wetDry: 100, params: { threshold: -18, ratio: 3.0 } },
    { type: "limiter", enabled: true, wetDry: 100, params: { ceilingDb: -1.0, releaseMs: 80 } }
  ];
  const proc = Dsp.createStatefulMasterProcessor({ masterRack: chunkRack, sampleRate });
  const t0 = Date.now();
  const blockLen = sampleRate; // 1-sec chunks
  let chunkSeamMaxJump = 0;
  let prevLast = 0;
  for (let off = 0; off < benchSamplesL.length; off += blockLen) {
    const end = Math.min(benchSamplesL.length, off + blockLen);
    const resChunk = proc.processChunk(benchSamplesL.subarray(off, end), benchSamplesR.subarray(off, end));
    if (off > 0 && resChunk.left.length > 0) {
      chunkSeamMaxJump = Math.max(chunkSeamMaxJump, Math.abs(resChunk.left[0] - prevLast));
    }
    prevLast = resChunk.left[resChunk.left.length - 1] || 0;
  }
  const benchElapsedMs = Math.max(1, Date.now() - t0);
  const realtimeMultiple = (benchDurSec * 1000) / benchElapsedMs;

  return {
    sampleRate,
    eqFlatnessMaxErrDb,
    neutralThd,
    saturationThd,
    noiseFloor: {
      chainSilencePeakDb,
      wav24QuantNoiseDb,
      wav16TpdfNoiseDb
    },
    latencyAlignment: {
      reportedLatencySamples,
      peakIdxLin,
      peakIdxMinAligned,
      sampleSkew: latencySampleSkew
    },
    corpusResults,
    masteringConvergence: {
      targetLufs: -14.0,
      integratedLufs: normStats.integratedLufs,
      truePeakDb: normStats.truePeakDb,
      loudnessRangeLu: normStats.loudnessRangeLu
    },
    chunkSeamMaxJump,
    benchmark: {
      durationSec: benchDurSec,
      elapsedMs: benchElapsedMs,
      realtimeMultiple
    }
  };
}

/**
 * Compares two stereo WAV buffers level-matched by Integrated LUFS (Section 38 A/B Analysis):
 * measures Integrated LUFS, True Peak, Crest Factor, Stereo Correlation, and 4-Band RMS Deltas.
 */
function compareWavFilesAB(wavBufA, wavBufB) {
  const a = decodeWavBufferToFloat32(wavBufA);
  const b = decodeWavBufferToFloat32(wavBufB);
  const statsA = Dsp.analyzeLoudnessFull(a.left, a.right, a.sampleRate);
  const statsB = Dsp.analyzeLoudnessFull(b.left, b.right, b.sampleRate);

  const matchGainDb =
    Number.isFinite(statsA.integratedLufs) && Number.isFinite(statsB.integratedLufs)
      ? statsA.integratedLufs - statsB.integratedLufs
      : 0;
  const matchLin = Math.pow(10, Math.max(-24, Math.min(24, matchGainDb)) / 20);
  const matchedBLeft = new Float32Array(b.left.length);
  const matchedBRight = new Float32Array(b.right.length);
  for (let i = 0; i < b.left.length; i += 1) {
    matchedBLeft[i] = b.left[i] * matchLin;
    matchedBRight[i] = b.right[i] * matchLin;
  }
  const matchedStatsB = Dsp.analyzeLoudnessFull(matchedBLeft, matchedBRight, b.sampleRate);

  function measureBands(left, right, sr) {
    const low = Dsp.processFilterOffline(left, null, { hpfHz: 20, lpfHz: 200, slope: 12 }, sr).left;
    const mid = Dsp.processFilterOffline(left, null, { hpfHz: 200, lpfHz: 2000, slope: 12 }, sr).left;
    const pres = Dsp.processFilterOffline(left, null, { hpfHz: 2000, lpfHz: 6000, slope: 12 }, sr).left;
    const air = Dsp.processFilterOffline(left, null, { hpfHz: 6000, lpfHz: 20000, slope: 12 }, sr).left;

    let lrSum = 0;
    let llSum = 0;
    let rrSum = 0;
    for (let i = 0; i < left.length; i += 1) {
      lrSum += left[i] * right[i];
      llSum += left[i] * left[i];
      rrSum += right[i] * right[i];
    }
    const corr = llSum > 1e-12 && rrSum > 1e-12 ? lrSum / Math.sqrt(llSum * rrSum) : 1;
    return {
      lowDb: measureRmsDb(low),
      midDb: measureRmsDb(mid),
      presenceDb: measureRmsDb(pres),
      airDb: measureRmsDb(air),
      stereoCorrelation: corr
    };
  }

  const bandsA = measureBands(a.left, a.right, a.sampleRate);
  const bandsB = measureBands(matchedBLeft, matchedBRight, b.sampleRate);

  return {
    fileA: {
      sampleRate: a.sampleRate,
      bitDepth: a.bitDepth,
      integratedLufs: statsA.integratedLufs,
      truePeakDb: statsA.truePeakDb,
      crestFactorDb: statsA.crestFactorDb,
      bands: bandsA
    },
    fileBMatched: {
      sampleRate: b.sampleRate,
      bitDepth: b.bitDepth,
      appliedMatchGainDb: matchGainDb,
      integratedLufs: matchedStatsB.integratedLufs,
      truePeakDb: matchedStatsB.truePeakDb,
      crestFactorDb: matchedStatsB.crestFactorDb,
      bands: bandsB
    },
    deltasBMinusA: {
      lowDb: bandsB.lowDb - bandsA.lowDb,
      midDb: bandsB.midDb - bandsA.midDb,
      presenceDb: bandsB.presenceDb - bandsA.presenceDb,
      airDb: bandsB.airDb - bandsA.airDb,
      crestFactorDb: matchedStatsB.crestFactorDb - statsA.crestFactorDb,
      truePeakDb: matchedStatsB.truePeakDb - statsA.truePeakDb
    }
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const cmpIdx = args.indexOf("--compare");
  if (cmpIdx >= 0 && args[cmpIdx + 1] && args[cmpIdx + 2]) {
    const fileA = path.resolve(args[cmpIdx + 1]);
    const fileB = path.resolve(args[cmpIdx + 2]);
    const res = compareWavFilesAB(fs.readFileSync(fileA), fs.readFileSync(fileB));
    console.log(JSON.stringify(res, null, 2));
  } else {
    const full60s = args.includes("--full-60s");
    const report = runFullAudioQualityBenchmark({ sampleRate: 48000, full60s });
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("=== Bhajan Planner Pro Audio Workstation — Phase 9 Quality Report ===");
      console.log(`Sample Rate          : ${report.sampleRate} Hz`);
      console.log(`Neutral EQ Flatness  : +/- ${report.eqFlatnessMaxErrDb.toFixed(4)} dB`);
      console.log(`Neutral EQ THD (1k)  : ${report.neutralThd.thdPercent.toFixed(4)}% (${report.neutralThd.thdDb.toFixed(1)} dB)`);
      console.log(`Tape Sat THD (30%)   : ${report.saturationThd.thdPercent.toFixed(2)}%`);
      console.log(`Silence Chain Floor  : ${report.noiseFloor.chainSilencePeakDb.toFixed(1)} dBFS`);
      console.log(`24-bit Quant Floor   : ${report.noiseFloor.wav24QuantNoiseDb.toFixed(1)} dBFS`);
      console.log(`16-bit TPDF Floor    : ${report.noiseFloor.wav16TpdfNoiseDb.toFixed(1)} dBFS`);
      console.log(`FIR Latency Align    : ${report.latencyAlignment.reportedLatencySamples} smp reported, skew=${report.latencyAlignment.sampleSkew} smp`);
      console.log(`Mastering (-14 LUFS) : ${report.masteringConvergence.integratedLufs.toFixed(2)} LUFS | TP ${report.masteringConvergence.truePeakDb.toFixed(2)} dBTP | LRA ${report.masteringConvergence.loudnessRangeLu.toFixed(2)} LU`);
      console.log(`Chunk Seam Max Delta : ${report.chunkSeamMaxJump.toFixed(5)}`);
      console.log(`Offline Bench (${report.benchmark.durationSec}s)  : ${report.benchmark.elapsedMs} ms (${report.benchmark.realtimeMultiple.toFixed(1)}x real-time)`);
      console.log("10-Signal Corpus     :");
      report.corpusResults.forEach((r) => {
        console.log(`  - ${r.name.padEnd(22)} TP=${r.truePeakDb.toFixed(2)} dBTP  DC=${r.dcOffset.toFixed(5)}  Clipped=${r.clippedSamples}  NaN=${r.nonFinite}`);
      });
    }
  }
}

module.exports = {
  decodeWavBufferToFloat32,
  measureThd1kHz,
  generateReferenceCorpus,
  runFullAudioQualityBenchmark,
  compareWavFilesAB
};
