/**
 * Lossless WAV Binary Encoder & Adobe Audition CC Marker CSV Utilities.
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
    view.setUint32(16, 16, true); // PCM / IEEE subchunk1 size
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
   * Converts Float32 [-1, 1] mono samples into packed little-endian PCM / IEEE Float bytes.
   */
  function floatToPcmBytes(floatSamples, bitDepth = 24) {
    const len = floatSamples ? floatSamples.length : 0;
    const safeBits = bitDepth === 32 ? 32 : bitDepth === 16 ? 16 : 24;

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
        const val = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
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
    formatSecondsMMSS,
    formatAuditionTimestamp,
    formatAuditionMarkersCsv
  };
});
