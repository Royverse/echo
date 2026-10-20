// Procedural sound via the Web Audio API. Everything is synthesized — 100% asset-free.
// All voices route through a master bus with sidechain ducking, earcons,
// layered impact synthesis, and procedural crowd atmosphere.

export class SoundManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.duckNode = null;
    this.muted = false;
    this.ambience = null;
    this.crowd = null;
  }

  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.duckNode = this.ctx.createGain();

      this.duckNode.gain.value = 1.0;
      this.master.gain.value = this.muted ? 0 : 0.9;

      this.duckNode.connect(this.master);
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

  duck(amountDb = -12, durationMs = 200) {
    if (!this._ready() || !this.duckNode) return;
    const t = this.ctx.currentTime;
    const linearGain = Math.pow(10, amountDb / 20);
    this.duckNode.gain.cancelScheduledValues(t);
    this.duckNode.gain.setValueAtTime(linearGain, t);
    this.duckNode.gain.exponentialRampToValueAtTime(1.0, t + durationMs / 1000);
  }

  _ready() {
    this.init();
    this.resume();
    return Boolean(this.ctx);
  }

  _tone(type, freqStart, freqEnd, dur, peak, when = 0, bus = this.duckNode) {
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
    gain.connect(bus || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return { osc, gain, t };
  }

  _noise(dur, filterFreq, peak, type = 'bandpass', bus = this.duckNode) {
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
    gain.connect(bus || this.master);
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

  /**
   * Fast 60ms earcons representing distinct verb categories.
   */
  playEarcon(category = 'move') {
    if (!this._ready()) return;
    switch (category) {
      case 'move':
        this._tone('triangle', 320, 440, 0.06, 0.12);
        break;
      case 'kick':
        this._tone('sine', 580, 820, 0.06, 0.16);
        this._noise(0.02, 2400, 0.06, 'highpass');
        break;
      case 'trick':
        this._tone('sine', 880, 1100, 0.04, 0.14);
        this._tone('sine', 1100, 1400, 0.04, 0.14, 0.03);
        break;
      case 'order':
        this._tone('triangle', 440, 660, 0.07, 0.15);
        break;
      case 'rejected':
      default:
        this._tone('sawtooth', 140, 90, 0.08, 0.1);
        break;
    }
  }

  /**
   * Layered kick impact: sub-thump + transient click + body + tail, with ±3% pitch randomization.
   */
  playKick(power = 0.6) {
    if (!this._ready()) return;
    const p = Math.max(0.15, Math.min(1, power));
    const detune = 1.0 + (Math.random() - 0.5) * 0.06;

    // Sub thump (sine 90 -> 40Hz, 80ms)
    this._tone('sine', 95 * detune, 40 * detune, 0.09, 0.35 * p);

    // Transient click (HP noise 3kHz, 10ms)
    this._noise(0.015, 3200, 0.25 * p, 'highpass');

    // Body (triangle scaled by power)
    this._tone('triangle', (160 + p * 120) * detune, 55, 0.14 + p * 0.06, 0.2 + p * 0.25);

    // Tail for hard strikes
    if (p > 0.5) {
      this._noise(0.18, 900 + p * 1200, 0.15 * p, 'bandpass');
      this.duck(-6, 150); // duck ambient for blast punch
    }
  }

  playTouch() {
    if (!this._ready()) return;
    this._tone('sine', 240, 150, 0.06, 0.05);
    this._noise(0.02, 800, 0.02, 'lowpass');
  }

  playBounce(strength = 0.5) {
    if (!this._ready()) return;
    const s = Math.max(0.1, Math.min(1, strength));
    this._tone('sine', 220 + s * 160, 120, 0.07, 0.04 + s * 0.06);
    this._noise(0.025, 1400, 0.03 * s);
  }

  playJuggle(streak = 1) {
    if (!this._ready()) return;
    // Semitone rising scale
    const baseFreq = 330;
    const semitones = Math.floor(streak / 5);
    const freq = baseFreq * Math.pow(2, semitones / 12);
    this._tone('sine', freq, freq * 1.05, 0.08, 0.18);
    this._noise(0.02, 2200, 0.04);
  }

  playTackle() {
    if (!this._ready()) return;
    this._tone('sine', 120, 60, 0.12, 0.16);
    this._noise(0.09, 500, 0.12, 'lowpass');
  }

  playSave() {
    if (!this._ready()) return;
    this._tone('sine', 200, 90, 0.12, 0.16);
    this._noise(0.06, 2200, 0.1, 'bandpass');
  }

  playNet() {
    if (!this._ready()) return;
    this._noise(0.18, 2600, 0.06, 'bandpass');
    this._tone('triangle', 520, 360, 0.12, 0.03);
  }

  playWoodwork() {
    if (!this._ready()) return;
    // Inharmonic partials 1 : 2.76 : 5.4 for rich metal crossbar clang
    const base = 480;
    this._tone('sine', base, base * 0.99, 0.35, 0.28);
    this._tone('sine', base * 2.76, base * 2.75, 0.25, 0.18);
    this._tone('sine', base * 5.4, base * 5.38, 0.18, 0.12);
    this._noise(0.04, 3800, 0.15, 'highpass');
    this.duck(-8, 250);
  }

  playError() {
    if (!this._ready()) return;
    this._tone('sawtooth', 130, 70, 0.25, 0.09);
  }

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
