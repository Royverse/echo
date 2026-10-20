// FlowManager: handles the Flow Meter, Combo multipliers,
// the local zero-latency Commentator, Persistent Progression, and Replay Recording.
import { events } from '../core/EventBus.js';

export const FLOW_TIERS = [
  { name: 'COOL', threshold: 0, mult: 1.0, color: '#00e5ff' },
  { name: 'HOT', threshold: 30, mult: 1.5, color: '#ffab00' },
  { name: 'ON FIRE', threshold: 65, mult: 2.0, color: '#ff3d00' },
  { name: 'ECHO MODE', threshold: 95, mult: 3.0, color: '#e040fb' },
];

export class FlowManager {
  constructor() {
    this.flowScore = 15; // 0..100
    this.currentTierIndex = 0;
    this.streakCount = 0;
    this.lastActionType = null;
    this.silenceTimer = 0;
    this.wordsSpokenInPossession = 0;

    // Progression
    this.xp = 0;
    this.level = 1;
    this.loadProgression();

    // Replay recording buffer
    this.isRecording = true;
    this.recordedEvents = [];
    this.recordingStartTime = Date.now();

    this.bindEvents();
  }

  loadProgression() {
    try {
      const data = JSON.parse(localStorage.getItem('echo_progression') || '{}');
      this.xp = data.xp || 0;
      this.level = Math.floor(this.xp / 100) + 1;
    } catch {
      this.xp = 0;
      this.level = 1;
    }
  }

  saveProgression() {
    try {
      localStorage.setItem('echo_progression', JSON.stringify({ xp: this.xp, level: this.level }));
    } catch {
      // ignore in incognito
    }
  }

  addXP(amount) {
    this.xp += amount;
    const oldLevel = this.level;
    this.level = Math.floor(this.xp / 100) + 1;
    if (this.level > oldLevel) {
      events.emit('commentary', { text: `LEVEL UP! REACHED LEVEL ${this.level}` });
    }
    this.saveProgression();
  }

  bindEvents() {
    events.on('possession_gained', () => {
      this.addFlow(10);
      this.wordsSpokenInPossession = 0;
    });

    events.on('possession_lost', () => {
      this.drainFlow(15);
    });

    events.on('feint_beat', () => {
      this.addFlow(20);
      this.addXP(25);
      events.emit('commentary', { text: 'Beautiful dummy sent the defender flying!' });
    });

    events.on('flick_success', () => {
      this.addFlow(25);
      this.addXP(30);
      events.emit('commentary', { text: 'Outrageous rainbow flick!' });
    });

    events.on('nutmeg', () => {
      this.addFlow(30);
      this.addXP(40);
      events.emit('commentary', { text: 'THROUGH THE LEGS! Absolute filth!' });
    });

    events.on('woodwork', () => {
      this.addFlow(15);
      events.emit('commentary', { text: 'Off the woodwork! What a strike!' });
    });

    events.on('goal', (e) => {
      const tier = FLOW_TIERS[this.currentTierIndex];
      const bonus = Math.round(50 * tier.mult);
      this.addFlow(40);
      this.addXP(bonus);

      let line = 'GOAL! Clean finish!';
      if (tier.name === 'ECHO MODE') line = 'ECHO MODE UNLEASHED! UNSTOPPABLE!';
      else if (e.style === 'knuckle') line = 'Knuckleball rocket in off the post!';
      else if (e.style === 'finesse') line = 'Curled with precision into the top corner!';
      events.emit('commentary', { text: line });
    });

    events.on('save', () => {
      events.emit('commentary', { text: 'What a fingertip save from the keeper!' });
    });
  }

  addFlow(points) {
    this.flowScore = Math.min(100, this.flowScore + points);
    this.silenceTimer = 0;
    this.checkTierChange();
  }

  drainFlow(points) {
    this.flowScore = Math.max(0, this.flowScore - points);
    this.checkTierChange();
  }

  checkTierChange() {
    let newTier = 0;
    for (let i = FLOW_TIERS.length - 1; i >= 0; i--) {
      if (this.flowScore >= FLOW_TIERS[i].threshold) {
        newTier = i;
        break;
      }
    }
    if (newTier !== this.currentTierIndex) {
      this.currentTierIndex = newTier;
      events.emit('flow_tier_up', FLOW_TIERS[newTier]);
    }
  }

  get currentTier() {
    return FLOW_TIERS[this.currentTierIndex];
  }

  recordIntent(intent) {
    if (!this.isRecording) return;
    this.recordedEvents.push({
      t: Date.now() - this.recordingStartTime,
      intent,
    });
  }

  exportReplayJSON(seed = 1337) {
    return JSON.stringify({
      version: 1,
      seed,
      events: this.recordedEvents,
    });
  }

  update(dt, isPlaying) {
    if (!isPlaying) return;

    // Passive decay during silence or inaction
    this.silenceTimer += dt;
    if (this.silenceTimer > 3.0) {
      this.drainFlow(dt * 3.5);
    }
  }
}
