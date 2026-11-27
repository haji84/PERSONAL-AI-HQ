const blockSamples = 2400;

class RealtimeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const limit = options.processorOptions?.maxSamples;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24000 * 60) throw new Error('Invalid capture size');
    this.remaining = limit;
    this.buffer = new ArrayBuffer(blockSamples * 2);
    this.samples = new DataView(this.buffer);
    this.length = 0;
    this.activeSamples = 0;
    this.live = true;
    this.port.onmessage = event => { if (event.data === 'finish') this.finish(false); };
  }

  flush() {
    if (this.length === 0) return;
    const pcm = this.length === blockSamples ? this.buffer : this.buffer.slice(0, this.length * 2);
    this.port.postMessage({type: 'chunk', pcm, activeSamples: this.activeSamples}, [pcm]);
    this.buffer = new ArrayBuffer(blockSamples * 2);
    this.samples = new DataView(this.buffer);
    this.length = 0;
    this.activeSamples = 0;
  }

  finish(limit) {
    if (!this.live) return;
    this.live = false;
    this.flush();
    this.port.postMessage({type: 'done', limit});
  }

  process(inputs, outputs) {
    // Connect a rendered but silent output so browsers continue driving the graph.
    outputs[0]?.[0]?.fill(0);
    if (!this.live) return false;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const frames = Math.min(channel.length, this.remaining);
    for (let index = 0; index < frames; index++) {
      const value = Number.isFinite(channel[index]) ? Math.min(1, Math.max(-1, channel[index])) : 0;
      const sample = Math.round(value < 0 ? value * 32768 : value * 32767);
      this.samples.setInt16(this.length * 2, sample, true);
      if (Math.abs(sample) >= 64) this.activeSamples++;
      if (++this.length === blockSamples) this.flush();
    }
    this.remaining -= frames;
    if (this.remaining === 0) this.finish(true);
    return this.live;
  }
}

registerProcessor('hq-realtime-capture', RealtimeCapture);
