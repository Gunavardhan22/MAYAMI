// AudioWorklet that turns the incoming audio into 16-bit PCM and posts it in 100 ms
// chunks. It runs in an AudioContext created at 16 kHz, so the browser has already
// resampled the input and this only needs to convert Float32 -> Int16.
const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz

class PcmChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === CHUNK_SAMPLES) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(CHUNK_SAMPLES);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-chunker", PcmChunker);
