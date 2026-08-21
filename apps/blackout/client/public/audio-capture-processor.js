/**
 * AudioWorklet processor for the moderator's audio capture path.
 *
 * Runs on the Web Audio rendering thread. Reads input samples from
 * the upstream MediaElementSource (the radio stream), downsamples
 * them to 16 kHz mono, converts Float32 → Int16 (linear16), buffers
 * to ~250 ms windows, and posts each window as a transferable
 * ArrayBuffer to the main thread. Main thread forwards the buffer
 * over the moderator WebSocket as a binary frame; the server pipes
 * it to Deepgram with `encoding: linear16, sample_rate: 16000,
 * channels: 1`.
 *
 * Why we landed here: pre-2026-05-02 (live test) the path was
 * MediaRecorder → webm/opus → Deepgram auto-detect. Deepgram parsed
 * the webm container, sent a Metadata handshake, then closed
 * cleanly with code 1000 every time — its parser saw the chunks
 * but reported `duration: 0, channels: 0`, i.e. no audio data
 * inside the container. Switching to raw PCM with explicit format
 * declared to Deepgram bypasses the webm-container compatibility
 * problem entirely. Same path the OLD ffmpeg-transcoded HLS used,
 * which worked end-to-end.
 *
 * Downsampling: simple decimation (every Nth sample) rather than a
 * proper low-pass-and-decimate. Aliasing is mild and Deepgram's
 * model tolerates it; the simplicity is worth more than the
 * fidelity gain for ASR.
 */

const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHUNK_MS = 250;

class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a worklet global — the AudioContext's actual
    // hardware rate (typically 48000 in Chrome, 44100 elsewhere).
    this.decimationRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.targetSamples = Math.round((TARGET_SAMPLE_RATE * TARGET_CHUNK_MS) / 1000);
    this.buffer = new Float32Array(this.targetSamples);
    this.bufferIndex = 0;
    // Fractional decimation accumulator so e.g. 44100→16000 (ratio
    // 2.756…) doesn't drift over time.
    this.acc = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      this.acc += 1;
      if (this.acc >= this.decimationRatio) {
        this.acc -= this.decimationRatio;
        this.buffer[this.bufferIndex++] = channel[i];
        if (this.bufferIndex >= this.targetSamples) {
          this.flush();
        }
      }
    }
    return true;
  }

  flush() {
    const out = new Int16Array(this.bufferIndex);
    for (let i = 0; i < this.bufferIndex; i++) {
      const s = Math.max(-1, Math.min(1, this.buffer[i]));
      // Asymmetric clamp matches the int16 range exactly.
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    this.bufferIndex = 0;
  }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
