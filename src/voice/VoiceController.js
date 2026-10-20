// Voice layer: recognition -> speculative hybrid parsing -> intents,
// RMS audio analyzer for urgency detection, barge-in interruptible TTS, and idle sleep.
import { parseCommand } from './parser.js';
import { parseIntentWithGemini, synthesizeSpeech, hasApiKey } from './gemini.js';
import { events } from '../core/EventBus.js';

export class VoiceController {
  constructor(callbacks = {}) {
    this.cb = callbacks; // { onIntents, onStatus, onTranscript, onLevel, onResponse, onUrgency, onGhostChip }
    this.recognition = null;
    this.isSupported = false;
    this.isActive = false;
    this.shouldRestart = false;
    this.speaking = false;
    this.voiceEnabled = false;

    this.accumulated = '';
    this.lastInterimStop = false;
    this.lastSpokenText = '';
    this.speakingEndTime = 0;

    // Speculative parsing state
    this.prevInterimParse = null;
    this.speculativeExecuted = false;

    // Mic level & Urgency metering
    this.audioCtx = null;
    this.analyser = null;
    this.micStream = null;
    this.levelRAF = null;
    this.currentRMS = 0;
    this.peakRMS = 0;
    this.wordsPerSec = 0;
    this.lastTranscriptTime = Date.now();
    this.wordCountWindow = 0;

    // Idle sleep & wake word
    this.isSleeping = false;
    this.lastSpeechTimestamp = Date.now();
    this.IDLE_SLEEP_TIMEOUT = 12000; // 12s

    this.currentAudio = null;
    this.synth = window.speechSynthesis;

    this.initRecognition();
    this.initMicMetering();
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
        this.cb.onStatus?.('listening', 'Listening… try "carry", "shoot", or "press".');
      } else if (e.error !== 'aborted') {
        this.cb.onStatus?.('listening', `Reconnecting (${e.error})…`);
      }
    };

    this.recognition.onresult = (event) => this.handleResult(event);
  }

  async initMicMetering() {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = this.audioCtx.createMediaStreamSource(this.micStream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        source.connect(this.analyser);
        this._pollLevel();
      }
    } catch (err) {
      // Permission might be handled later by recognition
    }
  }

  _pollLevel() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    const check = () => {
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const val = (data[i] - 128) / 128;
        sum += val * val;
      }
      this.currentRMS = Math.sqrt(sum / data.length);
      this.peakRMS = Math.max(this.peakRMS * 0.95, this.currentRMS);

      // Barge-in check: user speaking cancels robot TTS instantly!
      if (this.currentRMS > 0.08 && this.speaking) {
        this.cancelTTS();
      }

      this.cb.onLevel?.(Math.min(1.0, this.currentRMS * 4.0));
      this._updateUrgency();
      this.levelRAF = requestAnimationFrame(check);
    };
    check();
  }

  _updateUrgency() {
    const rawScore = 0.7 * Math.min(1, this.peakRMS * 3.5) + 0.3 * Math.min(1, Math.max(0, (this.wordsPerSec - 1.5) / 3));
    let level = 'normal';
    if (rawScore > 0.6) level = 'urgent';
    else if (rawScore < 0.25) level = 'calm';

    this.cb.onUrgency?.({ level, score: rawScore });
  }

  isTTSBleed(text) {
    const cleanSpeech = text.toLowerCase().replace(/[^\w\s]/g, '').trim();
    if (cleanSpeech.includes('stop') || cleanSpeech.includes('halt') || cleanSpeech.includes('freeze')) {
      return false; // Always allow stop
    }
    if (this.speaking) return true;
    if (this.speakingEndTime && Date.now() - this.speakingEndTime < 1000) {
      if (!this.lastSpokenText) return false;
      const cleanLastSpoken = this.lastSpokenText.toLowerCase().replace(/[^\w\s]/g, '').trim();
      return cleanSpeech.includes(cleanLastSpoken) || cleanLastSpoken.includes(cleanSpeech);
    }
    return false;
  }

  cancelTTS() {
    if (this.synth) this.synth.cancel();
    if (this.currentAudio) {
      try { this.currentAudio.pause(); } catch {}
      this.currentAudio = null;
    }
    this.speaking = false;
    this.cb.onSpeakingStateChange?.(false);
  }

  handleResult(event) {
    this.lastSpeechTimestamp = Date.now();
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (this.isTTSBleed(t)) continue;
      if (event.results[i].isFinal) final += t; else interim += t;
    }

    // Wake word check if sleeping
    if (this.isSleeping) {
      const combined = (interim + ' ' + final).toLowerCase();
      if (combined.includes('echo') || combined.includes('wake')) {
        this.isSleeping = false;
        this.cb.onStatus?.('listening', 'ECHO active! What is your command?');
      }
      return;
    }

    if (interim) {
      this.cb.onTranscript?.(interim, false);

      // Instant safety stop
      const probe = parseCommand(interim);
      if (probe.confident && probe.intents.some((c) => c.type === 'stop')) {
        this.cb.onIntents?.([{ type: 'stop' }], interim.trim(), 'local');
        return;
      }

      // Speculative parsing across consecutive interims
      if (probe.confident && probe.intents.length === 1) {
        const repr = JSON.stringify(probe.intents[0]);
        if (this.prevInterimParse === repr && !this.speculativeExecuted) {
          this.cb.onGhostChip?.(probe.intents[0]);
          // For immediate fast verbs like shoot, execute speculatively
          if (['kick', 'feint', 'flick', 'jump'].includes(probe.intents[0].type)) {
            this.speculativeExecuted = true;
            this.cb.onIntents?.(probe.intents, interim.trim(), 'local_speculative');
          }
        }
        this.prevInterimParse = repr;
      }
    }

    if (final) {
      const text = final.trim();
      this.cb.onTranscript?.(final, true);
      this.prevInterimParse = null;

      // Track speech rate
      const words = text.split(/\s+/).length;
      const now = Date.now();
      const dtSec = Math.max(0.5, (now - this.lastTranscriptTime) / 1000);
      this.wordsPerSec = words / dtSec;
      this.lastTranscriptTime = now;

      if (!this.speculativeExecuted && text) {
        this.handleUtterance(text);
      }
      this.speculativeExecuted = false;
    }
  }

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
    if (result.responsePhrase && this.voiceEnabled) {
      this.cb.onResponse?.(result.responsePhrase);
      this.speak(result.responsePhrase);
    }
    if (this.isActive) this.cb.onStatus?.('listening', 'Listening — speak a command.');
  }

  speak(text) {
    if (!this.voiceEnabled || !this.synth) return;
    this.cancelTTS();
    this.speaking = true;
    this.lastSpokenText = text;
    this.cb.onSpeakingStateChange?.(true);

    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => {
      this.speaking = false;
      this.speakingEndTime = Date.now();
      this.cb.onSpeakingStateChange?.(false);
    };
    utter.onerror = () => {
      this.speaking = false;
      this.cb.onSpeakingStateChange?.(false);
    };
    this.synth.speak(utter);
  }

  processText(text) {
    return this.handleUtterance(text.trim());
  }

  start() {
    this.shouldRestart = true;
    if (this.recognition && !this.isActive) {
      try { this.recognition.start(); } catch {}
    }
  }

  stop() {
    this.shouldRestart = false;
    if (this.recognition && this.isActive) {
      try { this.recognition.stop(); } catch {}
    }
    this.cancelTTS();
  }

  setVoiceEnabled(enabled) {
    this.voiceEnabled = enabled;
  }
}
