// Voice layer: recognition -> hybrid parsing -> intents, plus layered TTS.
import { parseCommand } from './commands.js';
import { parseIntentWithGemini, synthesizeSpeech, hasApiKey } from './api.js';

const GEMINI_VOICE = 'Puck'; // upbeat; good fit for a sassy bot

export class VoiceManager {
  constructor(callbacks = {}) {
    this.cb = callbacks; // { onIntents, onStatus, onTranscript, onLevel, onResponse }
    this.recognition = null;
    this.isSupported = false;
    this.isActive = false;
    this.shouldRestart = false;
    this.speaking = false;
    this.voiceEnabled = false; // robot TTS off by default — keeps the mic open for back-to-back commands

    this.accumulated = '';
    this.debounce = null;
    this.lastInterimStop = false;
    this.lastSpokenText = '';
    this.speakingEndTime = 0;

    // mic level metering (separate stream from recognition)
    this.audioCtx = null;
    this.analyser = null;
    this.micStream = null;
    this.levelRAF = null;

    this.currentAudio = null;
    this.synth = window.speechSynthesis;

    this.initRecognition();
  }

  initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.cb.onStatus?.('unsupported', 'Speech recognition needs Chrome, Edge, or Safari. Use the keyboard or type commands instead.');
      return;
    }
    this.isSupported = true;
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onstart = () => {
      this.isActive = true;
      this.cb.onStatus?.('listening', 'Listening — speak a command.');
    };
    this.recognition.onend = () => {
      this.isActive = false;
      if (this.shouldRestart) {
        try { this.recognition.start(); } catch { /* will retry on next tick */ }
      } else {
        this.cb.onStatus?.('idle', 'Microphone off.');
      }
    };
    this.recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.shouldRestart = false;
        this.cb.onStatus?.('error', 'Microphone blocked. Allow mic access, then press Start.');
      } else if (e.error === 'no-speech') {
        this.cb.onStatus?.('listening', 'Listening… try "walk forward" or "turn left".');
      } else if (e.error !== 'aborted') {
        this.cb.onStatus?.('listening', `Reconnecting (${e.error})…`);
      }
    };
    this.recognition.onresult = (event) => this.handleResult(event);
  }

  isTTSBleed(text) {
    const cleanSpeech = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (cleanSpeech === 'stop' || cleanSpeech.includes('stop') || cleanSpeech.includes('halt') || cleanSpeech.includes('freeze')) {
      return false; // Always allow stop/emergency commands
    }
    if (this.speaking) return true;
    if (this.speakingEndTime && Date.now() - this.speakingEndTime < 1800) {
      if (!this.lastSpokenText) return false;
      const cleanLastSpoken = this.lastSpokenText.toLowerCase().replace(/[^\w\s]/g, '').trim();
      if (!cleanSpeech || !cleanLastSpoken) return false;
      return cleanSpeech.includes(cleanLastSpoken) || cleanLastSpoken.includes(cleanSpeech);
    }
    return false;
  }

  handleResult(event) {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (this.isTTSBleed(t)) {
        continue;
      }
      if (event.results[i].isFinal) final += t; else interim += t;
    }

    if (interim) {
      this.cb.onTranscript?.(interim, false);
      // Instant safety: react to "stop" the moment we hear it, no debounce.
      const probe = parseCommand(interim);
      const isStop = probe.confident && probe.intents.some((c) => c.type === 'stop');
      if (isStop && !this.lastInterimStop) {
        this.lastInterimStop = true;
        this.cb.onIntents?.([{ type: 'stop' }], interim.trim(), 'local');
      }
    }

    if (final) {
      const text = final.trim();
      this.cb.onTranscript?.(final, true);
      this.lastInterimStop = false;
      // Process each finalized phrase immediately — the engine queue keeps order,
      // so commands land with no added latency as you keep talking.
      if (text) this.handleUtterance(text);
    }
  }

  // Local parse first; only escalate to Gemini for fuzzy phrasing.
  async handleUtterance(text) {
    if (!text) return;
    const local = parseCommand(text);
    if (local.confident && local.intents.length) {
      this.cb.onIntents?.(local.intents, text, 'local');
      return;
    }

    if (!hasApiKey) {
      this.cb.onIntents?.([{ type: 'unknown' }], text, 'local');
      return;
    }

    this.cb.onStatus?.('thinking', 'Processing command…');
    const result = await parseIntentWithGemini(text);
    if (result.commands.length) {
      this.cb.onIntents?.(result.commands, text, 'gemini');
    } else {
      this.cb.onIntents?.([{ type: 'unknown' }], text, 'gemini');
    }
    if (result.responsePhrase) {
      this.cb.onResponse?.(result.responsePhrase);
      this.speak(result.responsePhrase);
    }
    if (this.isActive) this.cb.onStatus?.('listening', 'Listening — speak a command.');
  }

  // Manual deck / typed input share the exact same pipeline.
  processText(text) {
    return this.handleUtterance(text.trim());
  }

  async start() {
    if (!this.isSupported) return;
    this.shouldRestart = true;
    this.startLevelMeter();
    if (!this.isActive) {
      try { this.recognition.start(); } catch { /* already starting */ }
    }
  }

  stop() {
    if (!this.isSupported) return;
    this.shouldRestart = false;
    this.stopLevelMeter();
    if (this.isActive) this.recognition.stop();
  }

  // --------------------------------------------------------- mic metering ---
  async startLevelMeter() {
    if (this.analyser) return;
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaStreamSource(this.micStream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      const tick = () => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        this.cb.onLevel?.(Math.min(1, rms * 3));
        this.levelRAF = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      /* metering is a nicety; ignore if denied */
    }
  }

  stopLevelMeter() {
    cancelAnimationFrame(this.levelRAF);
    this.cb.onLevel?.(0);
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => {});
    this.analyser = null;
    this.audioCtx = null;
    this.micStream = null;
  }

  // ----------------------------------------------------------------- TTS ----
  setVoiceEnabled(on) {
    this.voiceEnabled = on;
    if (!on) this.stopSpeaking();
  }

  stopSpeaking() {
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    this.synth?.cancel();
    if (this.speaking) {
      this.speaking = false;
      this.speakingEndTime = Date.now();
      this.cb.onSpeakingStateChange?.(false);
    }
  }

  async speak(text) {
    if (!text || !this.voiceEnabled) return;
    this.stopSpeaking();
    this.speaking = true;
    this.lastSpokenText = text;
    this.cb.onSpeakingStateChange?.(true);

    // 1) Gemini neural voice
    try {
      const url = await synthesizeSpeech(text, GEMINI_VOICE);
      if (url) { await this.playUrl(url, true); return; }
    } catch (e) {
      console.warn('Gemini TTS failed, falling back:', e?.message || e);
    }
    // 2) StreamElements (free Polly)
    try {
      const url = `https://api.streamelements.com/kappa/v2/speech?voice=Brian&text=${encodeURIComponent(text)}`;
      await this.playUrl(url, false);
      return;
    } catch (e) {
      console.warn('StreamElements TTS failed, falling back to browser:', e?.message || e);
    }
    // 3) Browser synthesis
    this.browserSpeak(text);
  }

  playUrl(url, revoke) {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      this.currentAudio = audio;
      const done = () => {
        this.speaking = false;
        this.speakingEndTime = Date.now();
        this.cb.onSpeakingStateChange?.(false);
        if (revoke) URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = done;
      audio.onerror = () => {
        this.speaking = false;
        this.speakingEndTime = Date.now();
        this.cb.onSpeakingStateChange?.(false);
        if (revoke) URL.revokeObjectURL(url);
        reject(new Error('audio error'));
      };
      audio.play().catch(reject);
    });
  }

  browserSpeak(text) {
    if (!this.synth) {
      this.speaking = false;
      this.cb.onSpeakingStateChange?.(false);
      return;
    }
    this.synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.pitch = 1.15; u.rate = 1.05;
    u.onend = () => {
      this.speaking = false;
      this.speakingEndTime = Date.now();
      this.cb.onSpeakingStateChange?.(false);
    };
    u.onerror = () => {
      this.speaking = false;
      this.speakingEndTime = Date.now();
      this.cb.onSpeakingStateChange?.(false);
    };
    this.synth.speak(u);
  }
}
