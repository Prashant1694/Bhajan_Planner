/* Web Worker: Real-Time Stereo MP3 Encoder (up to 320 kbps) */
importScripts("/js/vendor/lame.min.js");

let mp3Encoder = null;

self.onmessage = function (event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === "init") {
    const channels = msg.channels === 1 ? 1 : 2;
    const sampleRate = Number(msg.sampleRate) || 48000;
    const kbps = Number(msg.kbps) || 320;
    const Mp3Encoder = (self.lamejs && self.lamejs.Mp3Encoder) || self.Mp3Encoder;
    mp3Encoder = new Mp3Encoder(channels, sampleRate, kbps);
    self.postMessage({ type: "ready", sampleRate, kbps });
    return;
  }

  if (msg.type === "encode" && mp3Encoder) {
    const left = new Int16Array(msg.left);
    const right = new Int16Array(msg.right || msg.left);
    const encoded = mp3Encoder.encodeBuffer(left, right);
    if (encoded && encoded.length > 0) {
      const copy = new Uint8Array(encoded);
      self.postMessage({ type: "chunk", buffer: copy.buffer }, [copy.buffer]);
    }
    return;
  }

  if (msg.type === "flush") {
    if (mp3Encoder) {
      const flushed = mp3Encoder.flush();
      if (flushed && flushed.length > 0) {
        const copy = new Uint8Array(flushed);
        self.postMessage({ type: "chunk", buffer: copy.buffer }, [copy.buffer]);
      }
      mp3Encoder = null;
    }
    self.postMessage({ type: "flushed" });
  }
};
