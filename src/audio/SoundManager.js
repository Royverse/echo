// Procedural sound via the Web Audio API. Everything is synthesized — no assets.
// All voices route through a master bus so the whole thing can be muted/ducked.

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.ambience = null;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
    } catch (e) {
      console.error('Web Audio unsupported', e);
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(muted ? 0 : 0.9, this.ctx.currentTime + 0.1);
    }
  }

  _ready() {
    this.init();
    this.resume();
    return Boolean(this.ctx);
  }

  _tone(type, freqStart, freqEnd, dur, peak, when = 0) {
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, t);
    if (freqEnd !== freqStart) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + dur * 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return { osc, gain, t };
  }

  _noise(dur, filterFreq, peak, type = 'bandpass') {
    const t = this.ctx.currentTime;
    const size = Math.floor(this.ctx.sampleRate * dur);
    const buffer = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    noise.start(t);
    noise.stop(t + dur + 0.02);
  }

  playStep() {
    if (!this._ready()) return;
    this._tone('triangle', 130, 36, 0.1, 0.18);
    this._noise(0.04, 1100, 0.05);
  }

  playLand() {
    if (!this._ready()) return;
    this._tone('sine', 90, 30, 0.18, 0.3);
    this._noise(0.08, 600, 0.08, 'lowpass');
  }

  playJump() {
    if (!this._ready()) return;
    this._tone('sine', 180, 460, 0.22, 0.16);
  }

  playTurn() {
    if (!this._ready()) return;
    const { osc } = this._tone('triangle', 320, 200, 0.28, 0.07);
    // servo flutter
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    mod.frequency.value = 34;
    modGain.gain.value = 38;
    mod.connect(modGain);
    modGain.connect(osc.frequency);
    mod.start(this.ctx.currentTime);
    mod.stop(this.ctx.currentTime + 0.28);
  }

  playBoost() {
    if (!this._ready()) return;
    this._tone('sawtooth', 220, 520, 0.3, 0.08);
    this._noise(0.25, 1800, 0.03, 'highpass');
  }

  playBlip() {
    if (!this._ready()) return;
    this._tone('square', 660, 880, 0.08, 0.05);
  }

  playError() {
    if (!this._ready()) return;
    this._tone('sawtooth', 130, 70, 0.25, 0.09);
  }

  // Soft evolving drone for atmosphere. Idempotent.
  startAmbience() {
    if (!this._ready() || this.ambience) return;
    const t = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(0.05, t + 3);
    bus.connect(this.master);

    const voices = [55, 82.4, 110].map((freq, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = i === 2 ? 'triangle' : 'sine';
      osc.frequency.value = freq;
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = 0.05 + i * 0.03;
      lfoGain.gain.value = freq * 0.01;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(bus);
      osc.start(t);
      lfo.start(t);
      return { osc, lfo };
    });

    this.ambience = { bus, voices };
  }

  stopAmbience() {
    if (!this.ambience) return;
    const t = this.ctx.currentTime;
    this.ambience.bus.gain.cancelScheduledValues(t);
    this.ambience.bus.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    const { voices } = this.ambience;
    setTimeout(() => voices.forEach((v) => { v.osc.stop(); v.lfo.stop(); }), 1600);
    this.ambience = null;
  }
}
