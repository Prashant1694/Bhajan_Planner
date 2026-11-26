/**
 * AudioWorklet Processors for Bhajan Planner Professional Audio Workstation:
 * 1. "bp-pcm-capture"  - MPEG-frame-aligned master stereo capture -> Web Worker MP3
 * 2. "bp-dry-capture"  - Pre-FX lossless float PCM capture + sample frame clock & dual-input telemetry
 * 3. "bp-asio-ingest"  - Lock-free ring buffer ingest for Local Native ASIO Bridge frames
 * 4. "bp-pro-dsp"      - Real-time Hysteresis Gate, Dynamic Split-Band De-Esser, Peak/RMS Comp & Lookahead Limiter
 */

function clampUnit(v) {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

function dbToLin(db) {
  return Math.pow(10, db / 20);
}

function linToDb(lin) {
  return lin > 1e-6 ? 20 * Math.log10(lin) : -120;
}

function computeRbjBiquad(type, freqHz, q, fs) {
  const safeFs = Math.max(8000, fs || 48000);
  const f0 = Math.max(20, Math.min(safeFs * 0.45, Number(freqHz) || 1000));
  const safeQ = Math.max(0.3, Math.min(12, Number(q) || 0.707));
  const w0 = (2 * Math.PI * f0) / safeFs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * safeQ);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  if (type === "highpass") {
    b0 = (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 = (1 + cosW0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  } else if (type === "bandpass") {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  }
  return {
    b0: b0 / a0,
    b1: b1 / a0,
    b2: b2 / a0,
    a1: a1 / a0,
    a2: a2 / a0
  };
}

const WORKLET_BS1770_PHASES = [
  [0.001708984375, -0.0291748046875, -0.0189208984375, -0.00830078125, 0.302978515625, 0.90380859375, -0.2236328125, 0.097412109375, -0.05126953125, 0.02734375, -0.013671875, 0.00537109375],
  [0.00146484375, -0.0262451171875, -0.02685546875, 0.130615234375, 0.6929931640625, 0.45361328125, -0.2589111328125, 0.129638671875, -0.068359375, 0.03662109375, -0.0185546875, 0.00732421875],
  [0.000732421875, -0.0185546875, 0.03662109375, -0.068359375, 0.129638671875, -0.2589111328125, 0.45361328125, 0.6929931640625, 0.130615234375, -0.02685546875, -0.0262451171875, 0.00146484375],
  [0.00537109375, -0.013671875, 0.02734375, -0.05126953125, 0.097412109375, -0.2236328125, 0.90380859375, 0.302978515625, -0.00830078125, -0.0189208984375, -0.0291748046875, 0.001708984375]
];

function computeKWeightWorkletCoeffs(fs) {
  const sr = Math.max(8000, fs || 48000);
  if (Math.abs(sr - 48000) < 1) {
    return {
      s1: { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
      s2: { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 }
    };
  }
  const f0 = 1681.974450955533;
  const K = Math.tan((Math.PI * f0) / sr);
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const Q = 0.7071752369554196;
  const a0s = 1 + K / Q + K * K;
  const f0hp = 38.13547087602444;
  const Qhp = 0.5003270373238773;
  const Khp = Math.tan((Math.PI * f0hp) / sr);
  const a0hp = 1 + Khp / Qhp + Khp * Khp;
  return {
    s1: {
      b0: (Vh + (Vb * K) / Q + K * K) / a0s,
      b1: (2 * (K * K - Vh)) / a0s,
      b2: (Vh - (Vb * K) / Q + K * K) / a0s,
      a1: (2 * (K * K - 1)) / a0s,
      a2: (1 - K / Q + K * K) / a0s
    },
    s2: {
      b0: 1 / a0hp,
      b1: -2 / a0hp,
      b2: 1 / a0hp,
      a1: (2 * (Khp * Khp - 1)) / a0hp,
      a2: (1 - Khp / Qhp + Khp * Khp) / a0hp
    }
  };
}

class BpPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 2304;
    this.leftBuf = new Int16Array(this.blockSize);
    this.rightBuf = new Int16Array(this.blockSize);
    this.offset = 0;

    this.ditherSeed = 0x5f3759df;
    this.peakL = 0;
    this.peakR = 0;
    this.truePeak = 0;
    this.sumLSq = 0;
    this.sumRSq = 0;
    this.kwSumSq = 0;
    this.mSamples = 0;
    this.mBlocks = 0;

    this.tpRingL = new Float32Array(12);
    this.tpRingR = new Float32Array(12);
    this.tpIdx = 0;

    const kw = computeKWeightWorkletCoeffs(typeof sampleRate === "number" ? sampleRate : 48000);
    this.kwS1 = kw.s1;
    this.kwS2 = kw.s2;
    this.k1x1L = 0; this.k1x2L = 0; this.k1y1L = 0; this.k1y2L = 0;
    this.k2x1L = 0; this.k2x2L = 0; this.k2y1L = 0; this.k2y2L = 0;
    this.k1x1R = 0; this.k1x2R = 0; this.k1y1R = 0; this.k1y2R = 0;
    this.k2x1R = 0; this.k2x2R = 0; this.k2y1R = 0; this.k2y2R = 0;
  }

  _nextRand() {
    this.ditherSeed = (this.ditherSeed * 1664525 + 1013904223) >>> 0;
    return this.ditherSeed / 4294967296;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const inL = input[0];
    const inR = input[1] || input[0];
    const len = inL.length;
    const s1c = this.kwS1;
    const s2c = this.kwS2;
    const inv15 = 1 / 32768;

    for (let i = 0; i < len; i++) {
      const fL = inL[i];
      const fR = inR[i];
      const aL = fL < 0 ? -fL : fL;
      const aR = fR < 0 ? -fR : fR;
      if (aL > this.peakL) this.peakL = aL;
      if (aR > this.peakR) this.peakR = aR;
      if (aL > this.truePeak) this.truePeak = aL;
      if (aR > this.truePeak) this.truePeak = aR;
      this.sumLSq += fL * fL;
      this.sumRSq += fR * fR;

      // 12-tap polyphase 4x True Peak
      this.tpRingL[this.tpIdx] = fL;
      this.tpRingR[this.tpIdx] = fR;
      const prevIdx = (this.tpIdx + 1) % 12;
      this.tpIdx = prevIdx;
      for (let p = 0; p < 4; p++) {
        const k = WORKLET_BS1770_PHASES[p];
        let accL = 0;
        let accR = 0;
        for (let t = 0; t < 12; t++) {
          const rIdx = (this.tpIdx + t) % 12;
          accL += this.tpRingL[rIdx] * k[t];
          accR += this.tpRingR[rIdx] * k[t];
        }
        const tL = accL < 0 ? -accL : accL;
        const tR = accR < 0 ? -accR : accR;
        if (tL > this.truePeak) this.truePeak = tL;
        if (tR > this.truePeak) this.truePeak = tR;
      }

      // BS.1770-4 K-Weighting L+R
      const y1L = s1c.b0 * fL + s1c.b1 * this.k1x1L + s1c.b2 * this.k1x2L - s1c.a1 * this.k1y1L - s1c.a2 * this.k1y2L;
      this.k1x2L = this.k1x1L; this.k1x1L = fL; this.k1y2L = this.k1y1L; this.k1y1L = y1L;
      const kwL = s2c.b0 * y1L + s2c.b1 * this.k2x1L + s2c.b2 * this.k2x2L - s2c.a1 * this.k2y1L - s2c.a2 * this.k2y2L;
      this.k2x2L = this.k2x1L; this.k2x1L = y1L; this.k2y2L = this.k2y1L; this.k2y1L = kwL;

      const y1R = s1c.b0 * fR + s1c.b1 * this.k1x1R + s1c.b2 * this.k1x2R - s1c.a1 * this.k1y1R - s1c.a2 * this.k1y2R;
      this.k1x2R = this.k1x1R; this.k1x1R = fR; this.k1y2R = this.k1y1R; this.k1y1R = y1R;
      const kwR = s2c.b0 * y1R + s2c.b1 * this.k2x1R + s2c.b2 * this.k2x2R - s2c.a1 * this.k2y1R - s2c.a2 * this.k2y2R;
      this.k2x2R = this.k2x1R; this.k2x1R = y1R; this.k2y2R = this.k2y1R; this.k2y1R = kwR;

      this.kwSumSq += kwL * kwL + kwR * kwR;
      this.mSamples++;

      // TPDF dither before 16-bit quantization
      const tpdfL = (this._nextRand() - this._nextRand()) * inv15;
      const tpdfR = (this._nextRand() - this._nextRand()) * inv15;
      const l = clampUnit(fL + tpdfL);
      const r = clampUnit(fR + tpdfR);

      this.leftBuf[this.offset] = l < 0 ? (l * 32768) | 0 : (l * 32767) | 0;
      this.rightBuf[this.offset] = r < 0 ? (r * 32768) | 0 : (r * 32767) | 0;
      this.offset++;

      if (this.offset >= this.blockSize) {
        const sendL = this.leftBuf;
        const sendR = this.rightBuf;
        this.port.postMessage(
          { type: "pcm", left: sendL, right: sendR },
          [sendL.buffer, sendR.buffer]
        );
        this.leftBuf = new Int16Array(this.blockSize);
        this.rightBuf = new Int16Array(this.blockSize);
        this.offset = 0;

        this.mBlocks++;
        if (this.mBlocks >= 2 && this.mSamples > 0) {
          const n = this.mSamples;
          this.port.postMessage({
            type: "master-telemetry",
            peakL: this.peakL,
            peakR: this.peakR,
            rmsL: Math.sqrt(this.sumLSq / n),
            rmsR: Math.sqrt(this.sumRSq / n),
            truePeak: this.truePeak,
            kwMeanSq: this.kwSumSq / n,
            frames: n
          });
          this.mBlocks = 0;
          this.peakL = 0;
          this.peakR = 0;
          this.truePeak = 0;
          this.sumLSq = 0;
          this.sumRSq = 0;
          this.kwSumSq = 0;
          this.mSamples = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("bp-pcm-capture", BpPcmCaptureProcessor);

/**
 * Pre-FX lossless float PCM capture processor.
 * Taps raw Ch1 & Ch2 before any gain/EQ/reverb in 2048-sample blocks for direct-to-SSD 24-bit WAV recording,
 * maintains hardware sample frame count, and emits dual-input isolation/level telemetry.
 */
class BpDryCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 2048;
    this.ch1Buf = new Float32Array(this.blockSize);
    this.ch2Buf = new Float32Array(this.blockSize);
    this.offset = 0;
    this.totalFrames = 0;
    this.blockStartFrame = 0;
    this.telemetryCounter = 0;

    this.peak1 = 0;
    this.peak2 = 0;
    this.sum1Sq = 0;
    this.sum2Sq = 0;
    this.sum12 = 0;
    this.clip1 = 0;
    this.clip2 = 0;
    this.telemSamples = 0;

    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.type === "reset-clock") {
        this.totalFrames = 0;
        this.blockStartFrame = 0;
        this.offset = 0;
        return;
      }
      if (ev.data && ev.data.type === "flush" && this.offset > 0) {
        const send1 = this.ch1Buf.slice(0, this.offset);
        const send2 = this.ch2Buf.slice(0, this.offset);
        const endFrame = this.totalFrames;
        this.port.postMessage(
          {
            type: "dry-pcm",
            ch1: send1,
            ch2: send2,
            startFrame: this.blockStartFrame,
            totalFrames: endFrame
          },
          [send1.buffer, send2.buffer]
        );
        this.blockStartFrame = endFrame;
        this.offset = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const in1 = input[0];
    const hasCh2 = input.length > 1 && input[1] && input[1].length > 0;
    const in2 = hasCh2 ? input[1] : null;
    const len = in1.length;

    for (let i = 0; i < len; i++) {
      const s1 = in1[i];
      const s2 = in2 ? in2[i] : 0;
      this.ch1Buf[this.offset] = s1;
      this.ch2Buf[this.offset] = s2;
      this.offset++;
      this.totalFrames++;

      const a1 = s1 < 0 ? -s1 : s1;
      const a2 = s2 < 0 ? -s2 : s2;
      if (a1 > this.peak1) this.peak1 = a1;
      if (a2 > this.peak2) this.peak2 = a2;
      if (a1 >= 0.985) this.clip1++;
      if (a2 >= 0.985) this.clip2++;
      this.sum1Sq += s1 * s1;
      this.sum2Sq += s2 * s2;
      this.sum12 += s1 * s2;
      this.telemSamples++;

      if (this.offset >= this.blockSize) {
        const send1 = this.ch1Buf;
        const send2 = this.ch2Buf;
        const endFrame = this.totalFrames;
        this.port.postMessage(
          {
            type: "dry-pcm",
            ch1: send1,
            ch2: send2,
            startFrame: this.blockStartFrame,
            totalFrames: endFrame,
            inputChannels: hasCh2 ? 2 : 1
          },
          [send1.buffer, send2.buffer]
        );
        this.ch1Buf = new Float32Array(this.blockSize);
        this.ch2Buf = new Float32Array(this.blockSize);
        this.blockStartFrame = endFrame;
        this.offset = 0;

        this.telemetryCounter++;
        if (this.telemetryCounter >= 4 && this.telemSamples > 0) {
          const n = this.telemSamples;
          const rms1 = Math.sqrt(this.sum1Sq / n);
          const rms2 = Math.sqrt(this.sum2Sq / n);
          const denom = Math.sqrt(this.sum1Sq * this.sum2Sq);
          const corr12 = denom > 1e-12 ? this.sum12 / denom : 0;
          this.port.postMessage({
            type: "input-telemetry",
            peak1: this.peak1,
            rms1,
            peak2: this.peak2,
            rms2,
            clip1: this.clip1,
            clip2: this.clip2,
            corr12,
            inputChannels: hasCh2 ? 2 : 1,
            totalFrames: endFrame
          });
          this.telemetryCounter = 0;
          this.peak1 = 0;
          this.peak2 = 0;
          this.sum1Sq = 0;
          this.sum2Sq = 0;
          this.sum12 = 0;
          this.clip1 = 0;
          this.clip2 = 0;
          this.telemSamples = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("bp-dry-capture", BpDryCaptureProcessor);

/**
 * Lock-free ring buffer ingest for synchronized dual-mono ASIO bridge frames.
 */
class BpAsioIngestProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 96000;
    this.ring1 = new Float32Array(this.capacity);
    this.ring2 = new Float32Array(this.capacity);
    this.readIdx = 0;
    this.writeIdx = 0;
    this.available = 0;
    this.underruns = 0;
    this.telemFrames = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === "reset") {
        this.readIdx = 0;
        this.writeIdx = 0;
        this.available = 0;
        this.underruns = 0;
        return;
      }
      if (msg.type === "asio-pcm" && msg.ch1) {
        const c1 = msg.ch1;
        const hasCh2 = Boolean(msg.ch2 && msg.channels !== 1);
        const c2 = hasCh2 ? msg.ch2 : null;
        const count = c1.length;
        for (let i = 0; i < count; i++) {
          if (this.available >= this.capacity) {
            this.readIdx = (this.readIdx + 1) % this.capacity;
            this.available--;
          }
          this.ring1[this.writeIdx] = c1[i];
          this.ring2[this.writeIdx] = c2 ? c2[i] : 0;
          this.writeIdx = (this.writeIdx + 1) % this.capacity;
          this.available++;
        }
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const out1 = out[0];
    const out2 = out[1] || out[0];
    const len = out1.length;

    if (this.available < len) {
      this.underruns++;
      out1.fill(0);
      if (out2 !== out1) out2.fill(0);
    } else {
      for (let i = 0; i < len; i++) {
        out1[i] = this.ring1[this.readIdx];
        if (out2 !== out1) out2[i] = this.ring2[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        this.available--;
      }
    }

    this.telemFrames += len;
    if (this.telemFrames >= 9600) {
      this.telemFrames = 0;
      this.port.postMessage({
        type: "asio-telemetry",
        bufferedFrames: this.available,
        underruns: this.underruns
      });
    }
    return true;
  }
}

registerProcessor("bp-asio-ingest", BpAsioIngestProcessor);

/**
 * Real-Time Professional Dynamics DSP AudioWorklet:
 *   - Polarity inversion & input trim
 *   - Hysteresis Gate / Downward Expander
 *   - Dynamic Split-Band / Wideband Vocal De-Esser
 *   - Peak / RMS Sidechain-HPF Soft-Knee Compressor
 *   - Stereo-linked 1.5 ms Lookahead True-Peak Limiter
 */
class BpProDspProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate || 48000;
    this.fs = fs;

    this.params = {
      polarityInvert: false,
      trimDb: 0,
      gateEnabled: false,
      gateThresholdDb: -46,
      gateHysteresisDb: 4,
      gateAttackMs: 4,
      gateHoldMs: 90,
      gateReleaseMs: 220,
      gateRangeDb: -18,
      gateScHpfHz: 80,
      deessEnabled: false,
      deessFreqHz: 6500,
      deessQ: 3.2,
      deessThresholdDb: -26,
      deessReductionDb: 4,
      deessWideband: false,
      compEnabled: false,
      compThresholdDb: -18,
      compRatio: 3.5,
      compKneeDb: 10,
      compAttackMs: 8,
      compReleaseMs: 180,
      compMakeupDb: 0,
      compPeakMode: false,
      compScHpfHz: 60,
      limEnabled: false,
      limCeilingDb: -1.0,
      limLookaheadMs: 1.5,
      limReleaseMs: 80
    };

    // Gate state + key HPF
    this.gateScCoeffs = computeRbjBiquad("highpass", 80, 0.707, fs);
    this.gScX1L = 0; this.gScX2L = 0; this.gScY1L = 0; this.gScY2L = 0;
    this.gScX1R = 0; this.gScX2R = 0; this.gScY1R = 0; this.gScY2R = 0;
    this.gateEnv = 0;
    this.gateOpen = true;
    this.gateHoldCtr = 0;
    this.gateGain = 1;

    // De-esser state
    this.deessCoeffs = computeRbjBiquad("bandpass", 6500, 3.2, fs);
    this.dsX1L = 0; this.dsX2L = 0; this.dsY1L = 0; this.dsY2L = 0;
    this.dsX1R = 0; this.dsX2R = 0; this.dsY1R = 0; this.dsY2R = 0;
    this.deessEnv = 0;
    this.deessGain = 1;

    // Compressor state
    this.scCoeffs = computeRbjBiquad("highpass", 60, 0.707, fs);
    this.scX1L = 0; this.scX2L = 0; this.scY1L = 0; this.scY2L = 0;
    this.scX1R = 0; this.scX2R = 0; this.scY1R = 0; this.scY2R = 0;
    this.compEnvSq = 0;
    this.compGrDb = 0;

    // Lookahead limiter ring buffers (max 10ms) + 12-tap 4x BS.1770-4 True-Peak ring
    this.limMaxDelay = Math.max(64, Math.ceil(fs * 0.01));
    this.limDelayL = new Float32Array(this.limMaxDelay);
    this.limDelayR = new Float32Array(this.limMaxDelay);
    this.limWriteIdx = 0;
    this.limLookSamples = Math.max(1, Math.round((fs * 1.5) / 1000));
    this.limEnv = 0;
    this.limHoldCtr = 0;
    this.limGain = 1;
    this.limTpRingL = new Float32Array(12);
    this.limTpRingR = new Float32Array(12);
    this.limTpIdx = 0;
    this.meterFrames = 0;

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || msg.type !== "params") return;
      const incoming = msg.params && typeof msg.params === "object" ? msg.params : msg;
      Object.assign(this.params, incoming);
      delete this.params.type;
      this.gateScCoeffs = computeRbjBiquad("highpass", this.params.gateScHpfHz || 80, 0.707, this.fs);
      this.deessCoeffs = computeRbjBiquad(
        "bandpass",
        this.params.deessFreqHz,
        this.params.deessQ,
        this.fs
      );
      this.scCoeffs = computeRbjBiquad("highpass", this.params.compScHpfHz, 0.707, this.fs);
      this.limLookSamples = Math.max(
        1,
        Math.min(this.limMaxDelay - 1, Math.round((this.fs * (Number(this.params.limLookaheadMs) || 1.5)) / 1000))
      );
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inL = input[0];
    const inR = input[1] || input[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const len = inL.length;
    const p = this.params;
    const fs = this.fs;

    const trimGain = (p.polarityInvert ? -1 : 1) * dbToLin(Number(p.trimDb) || 0);
    const gsc = this.gateScCoeffs;
    const gateOpenThr = dbToLin(Number(p.gateThresholdDb ?? -46));
    const gateCloseThr = dbToLin(Number(p.gateThresholdDb ?? -46) - Math.max(0, Number(p.gateHysteresisDb ?? 4)));
    const gateFloor = dbToLin(Math.min(0, Number(p.gateRangeDb ?? -18)));
    const gateAttCoeff = Math.exp(-1 / Math.max(1, (fs * Math.max(0.5, Number(p.gateAttackMs) || 4)) / 1000));
    const gateRelCoeff = Math.exp(-1 / Math.max(1, (fs * Math.max(10, Number(p.gateReleaseMs) || 220)) / 1000));
    const gateHoldSamples = Math.round((fs * Math.max(0, Number(p.gateHoldMs) || 90)) / 1000);

    const dsThrDb = Number(p.deessThresholdDb ?? -26);
    const dsMaxCut = Math.max(0, Number(p.deessReductionDb ?? 4));
    const dsAttCoeff = Math.exp(-1 / Math.max(1, (fs * 1.5) / 1000));
    const dsRelCoeff = Math.exp(-1 / Math.max(1, (fs * 65) / 1000));
    const dc = this.deessCoeffs;

    const sc = this.scCoeffs;
    const compThr = Number(p.compThresholdDb ?? -18);
    const compRatio = Math.max(1, Number(p.compRatio ?? 3.5));
    const compKnee = Math.max(0, Number(p.compKneeDb ?? 10));
    const compAttCoeff = Math.exp(-1 / Math.max(1, (fs * Math.max(0.5, Number(p.compAttackMs) || 8)) / 1000));
    const compRelCoeff = Math.exp(-1 / Math.max(1, (fs * Math.max(10, Number(p.compReleaseMs) || 180)) / 1000));
    const compMakeup = dbToLin(Number(p.compMakeupDb ?? 0));

    const limCeil = dbToLin(Math.min(0, Number(p.limCeilingDb ?? -1.0))) * 0.975;
    const limAttCoeff = 1 - Math.exp(-5.0 / Math.max(1, this.limLookSamples));
    const limRelCoeff = Math.exp(-1 / Math.max(1, (fs * Math.max(10, Number(p.limReleaseMs) || 80)) / 1000));

    let minGateGain = 1;
    let minDeessGain = 1;
    let maxCompGr = 0;
    let minLimGain = 1;

    for (let i = 0; i < len; i++) {
      let l = inL[i] * trimGain;
      let r = inR[i] * trimGain;

      // 1. Hysteresis Downward Expander / Gate with Sidechain Key HPF
      if (p.gateEnabled) {
        const gsL = gsc.b0 * l + gsc.b1 * this.gScX1L + gsc.b2 * this.gScX2L - gsc.a1 * this.gScY1L - gsc.a2 * this.gScY2L;
        this.gScX2L = this.gScX1L; this.gScX1L = l; this.gScY2L = this.gScY1L; this.gScY1L = gsL;
        const gsR = gsc.b0 * r + gsc.b1 * this.gScX1R + gsc.b2 * this.gScX2R - gsc.a1 * this.gScY1R - gsc.a2 * this.gScY2R;
        this.gScX2R = this.gScX1R; this.gScX1R = r; this.gScY2R = this.gScY1R; this.gScY1R = gsR;

        const absMax = Math.max(Math.abs(gsL), Math.abs(gsR));
        this.gateEnv = absMax > this.gateEnv ? absMax : this.gateEnv * 0.996 + absMax * 0.004;
        if (this.gateEnv >= gateOpenThr) {
          this.gateOpen = true;
          this.gateHoldCtr = gateHoldSamples;
        } else if (this.gateHoldCtr > 0) {
          this.gateHoldCtr--;
        } else if (this.gateEnv < gateCloseThr) {
          this.gateOpen = false;
        }
        const targetG = this.gateOpen ? 1 : gateFloor;
        const cG = targetG > this.gateGain ? gateAttCoeff : gateRelCoeff;
        this.gateGain = cG * this.gateGain + (1 - cG) * targetG;
        if (this.gateGain < minGateGain) minGateGain = this.gateGain;
        l *= this.gateGain;
        r *= this.gateGain;
      }

      // 2. Dynamic Split-Band / Wideband Vocal De-Esser
      if (p.deessEnabled && dsMaxCut > 0.05) {
        const bpL = dc.b0 * l + dc.b1 * this.dsX1L + dc.b2 * this.dsX2L - dc.a1 * this.dsY1L - dc.a2 * this.dsY2L;
        this.dsX2L = this.dsX1L; this.dsX1L = l; this.dsY2L = this.dsY1L; this.dsY1L = bpL;

        const bpR = dc.b0 * r + dc.b1 * this.dsX1R + dc.b2 * this.dsX2R - dc.a1 * this.dsY1R - dc.a2 * this.dsY2R;
        this.dsX2R = this.dsX1R; this.dsX1R = r; this.dsY2R = this.dsY1R; this.dsY1R = bpR;

        const sibAbs = Math.max(Math.abs(bpL), Math.abs(bpR));
        const ec = sibAbs > this.deessEnv ? dsAttCoeff : dsRelCoeff;
        this.deessEnv = ec * this.deessEnv + (1 - ec) * sibAbs;
        const sibDb = linToDb(this.deessEnv);
        let redDb = 0;
        if (sibDb > dsThrDb) {
          redDb = Math.min(dsMaxCut, (sibDb - dsThrDb) * 0.75);
        }
        const gTarget = dbToLin(-redDb);
        this.deessGain = 0.85 * this.deessGain + 0.15 * gTarget;
        if (this.deessGain < minDeessGain) minDeessGain = this.deessGain;

        if (p.deessWideband) {
          l *= this.deessGain;
          r *= this.deessGain;
        } else {
          l = (l - bpL) + bpL * this.deessGain;
          r = (r - bpR) + bpR * this.deessGain;
        }
      }

      // 3. Peak/RMS Sidechain-HPF Soft-Knee Compressor
      if (p.compEnabled) {
        const scL = sc.b0 * l + sc.b1 * this.scX1L + sc.b2 * this.scX2L - sc.a1 * this.scY1L - sc.a2 * this.scY2L;
        this.scX2L = this.scX1L; this.scX1L = l; this.scY2L = this.scY1L; this.scY1L = scL;

        const scR = sc.b0 * r + sc.b1 * this.scX1R + sc.b2 * this.scX2R - sc.a1 * this.scY1R - sc.a2 * this.scY2R;
        this.scX2R = this.scX1R; this.scX1R = r; this.scY2R = this.scY1R; this.scY1R = scR;

        const energy = p.compPeakMode
          ? Math.max(scL * scL, scR * scR)
          : 0.5 * (scL * scL + scR * scR);
        const dcC = energy > this.compEnvSq ? compAttCoeff : compRelCoeff;
        this.compEnvSq = dcC * this.compEnvSq + (1 - dcC) * energy;
        const envDb = linToDb(Math.sqrt(Math.max(1e-12, this.compEnvSq)));

        let targetGrDb = 0;
        if (compKnee > 0 && Math.abs(envDb - compThr) <= compKnee * 0.5) {
          const d = envDb - compThr + compKnee * 0.5;
          targetGrDb = ((1 - 1 / compRatio) * d * d) / (2 * compKnee);
        } else if (envDb > compThr) {
          targetGrDb = (envDb - compThr) * (1 - 1 / compRatio);
        }
        this.compGrDb = 0.85 * this.compGrDb + 0.15 * targetGrDb;
        if (this.compGrDb > maxCompGr) maxCompGr = this.compGrDb;

        const cGain = dbToLin(-this.compGrDb) * compMakeup;
        l *= cGain;
        r *= cGain;
      }

      // 4. Stereo-Linked Lookahead ITU-R BS.1770-4 4x True-Peak Limiter
      if (p.limEnabled) {
        const readIdx = (this.limWriteIdx - this.limLookSamples + this.limMaxDelay) % this.limMaxDelay;
        const delL = this.limDelayL[readIdx];
        const delR = this.limDelayR[readIdx];
        this.limDelayL[this.limWriteIdx] = l;
        this.limDelayR[this.limWriteIdx] = r;
        this.limWriteIdx = (this.limWriteIdx + 1) % this.limMaxDelay;

        this.limTpRingL[this.limTpIdx] = l;
        this.limTpRingR[this.limTpIdx] = r;
        this.limTpIdx = (this.limTpIdx + 1) % 12;

        const curDelMax = Math.max(Math.abs(delL), Math.abs(delR));
        let lookPeak = Math.max(Math.abs(l), Math.abs(r), curDelMax);
        for (let ph = 0; ph < 4; ph++) {
          const k = WORKLET_BS1770_PHASES[ph];
          let accL = 0;
          let accR = 0;
          for (let t = 0; t < 12; t++) {
            const rIdx = (this.limTpIdx + t) % 12;
            accL += this.limTpRingL[rIdx] * k[t];
            accR += this.limTpRingR[rIdx] * k[t];
          }
          const tL = accL < 0 ? -accL : accL;
          const tR = accR < 0 ? -accR : accR;
          if (tL > lookPeak) lookPeak = tL;
          if (tR > lookPeak) lookPeak = tR;
        }

        if (lookPeak >= this.limEnv) {
          this.limEnv = lookPeak;
          this.limHoldCtr = this.limLookSamples + 12;
        } else if (this.limHoldCtr > 0) {
          this.limHoldCtr--;
        } else {
          this.limEnv = limRelCoeff * this.limEnv + (1 - limRelCoeff) * lookPeak;
        }

        const reqGain = this.limEnv > limCeil ? limCeil / this.limEnv : 1;
        if (reqGain < this.limGain) {
          this.limGain += (reqGain - this.limGain) * limAttCoeff;
        } else {
          this.limGain = limRelCoeff * this.limGain + (1 - limRelCoeff) * reqGain;
        }
        if (curDelMax * this.limGain > limCeil) {
          this.limGain = limCeil / curDelMax;
        }
        if (this.limGain < minLimGain) minLimGain = this.limGain;
        l = delL * this.limGain;
        r = delR * this.limGain;
      }

      outL[i] = l;
      if (outR !== outL) outR[i] = r;
    }

    this.meterFrames += len;
    if (this.meterFrames >= 3200) {
      this.meterFrames = 0;
      this.port.postMessage({
        type: "dsp-meters",
        gateGainDb: linToDb(minGateGain),
        deesserGrDb: linToDb(minDeessGain),
        compGrDb: -maxCompGr,
        limiterGrDb: linToDb(minLimGain)
      });
    }
    return true;
  }
}

registerProcessor("bp-pro-dsp", BpProDspProcessor);
