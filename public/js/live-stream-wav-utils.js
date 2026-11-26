/**
 * Lossless WAV Binary Encoder, TPDF Dithering, Windowed-Sinc SRC & RIFF Verifier
 * Plus Adobe Audition CC Marker CSV Utilities.
 * Works cleanly in Browser Window, Web Worker, and Node.js unit tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.LiveStreamWavUtils = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i) & 0xff);
    }
  }

  /**
   * Builds a standard 44-byte RIFF/WAVE header.
   * bitDepth 32 uses IEEE Float (format 3); 16 and 24 use signed linear PCM (format 1).
   */
  function buildWavHeader({ sampleRate = 48000, numChannels = 1, bitDepth = 24, dataByteLength = 0 } = {}) {
    const safeRate = Math.max(8000, Math.floor(Number(sampleRate) || 48000));
    const safeCh = Math.max(1, Math.min(2, Math.floor(Number(numChannels) || 1)));
    const safeBits = bitDepth === 32 ? 32 : bitDepth === 16 ? 16 : 24;
    const audioFormat = safeBits === 32 ? 3 : 1;
    const bytesPerSample = safeBits / 8;
    const blockAlign = safeCh * bytesPerSample;
    const byteRate = safeRate * blockAlign;
    const safeDataLen = Math.max(0, Math.min(0xffffffff - 36, Math.floor(Number(dataByteLength) || 0)));

    const buf = new ArrayBuffer(44);
    const view = new DataView(buf);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + safeDataLen, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, audioFormat, true);
    view.setUint16(22, safeCh, true);
    view.setUint32(24, safeRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, safeBits, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, safeDataLen, true);

    return new Uint8Array(buf);
  }

  /**
   * Generates Triangular Probability Density Function (TPDF) dither noise in [-1, 1] LSB.
   */
  function createPrng(seed) {
    let state = (seed >>> 0) || 0x9e3779b9;
    return function nextRand() {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  /**
   * Converts Float32 [-1, 1] mono samples into packed little-endian PCM / IEEE Float bytes.
   * For 16-bit PCM, applies TPDF dithering by default unless opts.dither === false.
   */
  function floatToPcmBytes(floatSamples, bitDepth = 24, opts = {}) {
    const len = floatSamples ? floatSamples.length : 0;
    const safeBits = bitDepth === 32 ? 32 : bitDepth === 16 ? 16 : 24;
    const useDither = safeBits === 16 && opts.dither === true;
    const rand = useDither
      ? (opts.seed != null ? createPrng(opts.seed) : Math.random)
      : null;

    if (safeBits === 32) {
      const out = new Uint8Array(len * 4);
      const view = new DataView(out.buffer);
      for (let i = 0; i < len; i++) {
        let s = floatSamples[i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        view.setFloat32(i * 4, s, true);
      }
      return out;
    }

    if (safeBits === 16) {
      const out = new Uint8Array(len * 2);
      const view = new DataView(out.buffer);
      for (let i = 0; i < len; i++) {
        let s = floatSamples[i];
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        let scaled = s * 32767;
        if (useDither) {
          scaled += rand() - rand();
        }
        let val = Math.round(s < 0 && !useDither ? s * 32768 : scaled);
        if (val > 32767) val = 32767;
        else if (val < -32768) val = -32768;
        view.setInt16(i * 2, val, true);
      }
      return out;
    }

    // 24-bit signed little-endian PCM (3 bytes per sample)
    const out = new Uint8Array(len * 3);
    let offset = 0;
    for (let i = 0; i < len; i++) {
      let s = floatSamples[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      let val = s < 0 ? Math.round(s * 8388608) : Math.round(s * 8388607);
      if (val > 8388607) val = 8388607;
      else if (val < -8388608) val = -8388608;
      out[offset++] = val & 0xff;
      out[offset++] = (val >> 8) & 0xff;
      out[offset++] = (val >> 16) & 0xff;
    }
    return out;
  }

  /**
   * Converts Float32 [-1, 1] mono samples into TPDF-dithered Int16Array for MP3 / 16-bit mastering pipelines.
   */
  function floatToInt16Dithered(floatSamples, opts = {}) {
    const len = floatSamples ? floatSamples.length : 0;
    const out = new Int16Array(len);
    const useDither = opts.dither !== false;
    const rand = useDither
      ? (opts.seed != null ? createPrng(opts.seed) : Math.random)
      : null;
    for (let i = 0; i < len; i += 1) {
      let s = floatSamples[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      let scaled = s * 32767;
      if (useDither) scaled += rand() - rand();
      let val = Math.round(s < 0 && !useDither ? s * 32768 : scaled);
      if (val > 32767) val = 32767;
      else if (val < -32768) val = -32768;
      out[i] = val;
    }
    return out;
  }

  /**
   * Encodes mono or stereo Float32 arrays directly into a complete RIFF/WAVE Uint8Array.
   * Applies TPDF dither automatically for 16-bit exports.
   */
  function encodeStereoWavBuffer({
    left,
    right = null,
    sampleRate = 48000,
    bitDepth = 24,
    dither = true
  } = {}) {
    const chL = left || new Float32Array(0);
    const isStereo = Boolean(right && right.length === chL.length);
    const numChannels = isStereo ? 2 : 1;
    const frames = chL.length;
    const safeBits = bitDepth === 32 ? 32 : bitDepth === 16 ? 16 : 24;

    let interleaved;
    if (isStereo) {
      interleaved = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = chL[i];
        interleaved[i * 2 + 1] = right[i];
      }
    } else {
      interleaved = chL;
    }

    const pcmBytes = floatToPcmBytes(interleaved, safeBits, {
      dither: safeBits === 16 && dither !== false
    });
    const header = buildWavHeader({
      sampleRate,
      numChannels,
      bitDepth: safeBits,
      dataByteLength: pcmBytes.byteLength
    });
    const out = new Uint8Array(44 + pcmBytes.byteLength);
    out.set(header, 0);
    out.set(pcmBytes, 44);
    return out;
  }

  /**
   * High-quality 32-tap Blackman-windowed Sinc sample-rate converter for Float32 mono buffers.
   */
  function resampleFloat32Sinc(input, srcRate, dstRate) {
    if (!input || input.length === 0) return new Float32Array(0);
    const sRate = Number(srcRate) || 48000;
    const dRate = Number(dstRate) || 48000;
    if (Math.abs(sRate - dRate) < 1) {
      const copy = new Float32Array(input.length);
      copy.set(input);
      return copy;
    }

    const ratio = dRate / sRate;
    const outLen = Math.max(1, Math.round(input.length * ratio));
    const out = new Float32Array(outLen);
    const halfTaps = 16; // 32-tap kernel
    const cutoff = Math.min(1, ratio) * 0.92;
    const inLen = input.length;

    for (let i = 0; i < outLen; i++) {
      const srcPos = i / ratio;
      const center = Math.floor(srcPos);
      let acc = 0;
      let wSum = 0;
      for (let k = -halfTaps + 1; k <= halfTaps; k++) {
        const idx = center + k;
        if (idx < 0 || idx >= inLen) continue;
        const x = srcPos - idx;
        const normX = (k - (srcPos - center) + halfTaps) / (2 * halfTaps);
        const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * normX) + 0.08 * Math.cos(4 * Math.PI * normX);
        const arg = Math.PI * cutoff * x;
        const sinc = Math.abs(arg) < 1e-6 ? 1 : Math.sin(arg) / arg;
        const w = win * sinc * cutoff;
        acc += input[idx] * w;
        wSum += w;
      }
      out[i] = wSum > 1e-6 ? acc / wSum : 0;
    }
    return out;
  }

  /**
   * Stereo 32-tap Blackman-windowed Sinc sample-rate conversion for offline mastering exports.
   */
  function resampleStereoSinc(left, right, srcRate, dstRate) {
    const outRate = Number(dstRate) || 48000;
    const outL = resampleFloat32Sinc(left, srcRate, outRate);
    const outR = right ? resampleFloat32Sinc(right, srcRate, outRate) : null;
    return { left: outL, right: outR, sampleRate: outRate };
  }

  /**
   * Verifies RIFF/WAVE header fields and payload byte alignment.
   */
  function verifyWavHeaderAndSize(buf) {
    if (!buf) return { valid: false, error: "Empty buffer" };
    const u8 = buf instanceof Uint8Array
      ? buf
      : buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : ArrayBuffer.isView(buf)
          ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
          : null;
    if (!u8 || u8.byteLength < 44) {
      return { valid: false, error: `WAV too small (${u8 ? u8.byteLength : 0} bytes)` };
    }
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const ascii = (pos, len) => {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(pos + i));
      return s;
    };
    if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
      return { valid: false, error: "Missing RIFF/WAVE signature" };
    }

    let offset = 12;
    let audioFormat = 0;
    let numChannels = 0;
    let sampleRate = 0;
    let bitDepth = 0;
    let dataSize = 0;
    let dataOffset = -1;
    while (offset + 8 <= u8.byteLength) {
      const id = ascii(offset, 4);
      const chunkSize = view.getUint32(offset + 4, true);
      if (id === "fmt " && offset + 24 <= u8.byteLength) {
        audioFormat = view.getUint16(offset + 8, true);
        numChannels = view.getUint16(offset + 10, true);
        sampleRate = view.getUint32(offset + 12, true);
        bitDepth = view.getUint16(offset + 22, true);
      } else if (id === "data") {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }

    if (dataOffset < 0 || (audioFormat !== 1 && audioFormat !== 3)) {
      return { valid: false, error: "Invalid WAV fmt/data chunks" };
    }
    if (dataSize <= 0 || u8.byteLength < dataOffset + dataSize) {
      return {
        valid: false,
        error: `WAV data size mismatch (declared ${dataSize} bytes, actual payload ${u8.byteLength - dataOffset} bytes)`
      };
    }
    const bytesPerFrame = Math.max(1, numChannels * (bitDepth / 8));
    return {
      valid: true,
      audioFormat,
      numChannels,
      sampleRate,
      bitDepth,
      dataByteLength: dataSize,
      durationSeconds: dataSize / (bytesPerFrame * Math.max(1, sampleRate))
    };
  }

  function formatSecondsMMSS(sec) {
    const total = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  function formatAuditionTimestamp(sec) {
    const safeSec = Math.max(0, Number(sec) || 0);
    const whole = Math.floor(safeSec);
    const ms = Math.round((safeSec - whole) * 1000);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  }

  /**
   * Generates Adobe Audition CC importable tab-delimited Markers CSV.
   */
  function formatAuditionMarkersCsv(markers) {
    const header = "Name\tStart\tDuration\tTime Format\tType\tDescription";
    const rows = (Array.isArray(markers) ? markers : []).map((m, idx) => {
      const name = String(m.bhajan_title || m.title || `Bhajan ${idx + 1}`).replace(/[\t\r\n]+/g, " ");
      const start = formatAuditionTimestamp(m.start_seconds);
      const desc = String(m.singer_name || "").replace(/[\t\r\n]+/g, " ");
      return `${name}\t${start}\t0:00.000\tdecimal\tCue\t${desc}`;
    });
    return [header, ...rows].join("\n") + "\n";
  }

  return {
    buildWavHeader,
    floatToPcmBytes,
    floatToInt16Dithered,
    encodeStereoWavBuffer,
    resampleFloat32Sinc,
    resampleStereoSinc,
    verifyWavHeaderAndSize,
    formatSecondsMMSS,
    formatAuditionTimestamp,
    formatAuditionMarkersCsv
  };
});
