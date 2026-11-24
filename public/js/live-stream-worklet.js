/**
 * AudioWorklet processor that captures processed master stereo PCM
 * in MPEG-frame-aligned blocks (2304 samples = 2 MP3 frames @ 48 kHz)
 * with minimal GC overhead and transfers Int16 buffers to the Web Worker.
 */
class BpPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 2304;
    this.leftBuf = new Int16Array(this.blockSize);
    this.rightBuf = new Int16Array(this.blockSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const inL = input[0];
    const inR = input[1] || input[0];
    const len = inL.length;

    for (let i = 0; i < len; i++) {
      let l = inL[i];
      let r = inR[i];
      if (l > 1) l = 1;
      else if (l < -1) l = -1;
      if (r > 1) r = 1;
      else if (r < -1) r = -1;

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
      }
    }
    return true;
  }
}

registerProcessor("bp-pcm-capture", BpPcmCaptureProcessor);
