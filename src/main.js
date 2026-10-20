// App wiring: splash -> engine + voice + input -> HUD.
import './style.css';
import { GameEngine } from './engine/GameEngine.js';
import { SoundManager } from './audio/SoundManager.js';
import { VoiceController } from './voice/VoiceController.js';
import { saveMacro } from './voice/parser.js';
import { events } from './core/EventBus.js';

const $ = (id) => document.getElementById(id);

const scene = $('scene');
const splash = $('splash');
const micOrb = $('mic-orb');
const micStatus = $('mic-status');
const transcript = $('transcript');
const actionLabel = $('action-label');
const speedFill = $('speed-fill');
const botResponse = $('bot-response');
const feed = $('feed');
const drawer = $('help-drawer');
const cmdInput = $('cmd-input');
const queueStrip = $('queue-strip');
const voiceState = $('voice-state');
const vsTitle = $('vs-title');
const vsHint = $('vs-hint');
const juggleCounter = $('juggle-counter');
const jcValue = $('jc-value');
const ballStateEl = $('ball-state');
const sbGoals = $('sb-goals');
const sbSaves = $('sb-saves');
const flashEl = $('flash');
const orderChip = $('order-chip');
const orderIcon = $('order-icon');
const orderLabel = $('order-label');
const flowTier = $('flow-tier');
const flowFill = $('flow-fill');
const suggestionChips = $('suggestion-chips');

let micState = 'off';
let queueBusy = false;

function updateVoiceState() {
  let title;
  let hint;
  if (micState === 'processing') {
    title = 'PROCESSING…';
    hint = 'One moment — figuring that out. Hold on.';
  } else if (micState === 'listening') {
    title = queueBusy ? 'LISTENING · RUNNING' : 'LISTENING';
    hint = queueBusy
      ? 'Keep talking — commands flow seamlessly.'
      : 'Go ahead — say "carry", "feint", "shoot", or hold Space.';
  } else {
    title = 'MIC OFF';
    hint = 'Click the mic or hold Space to command.';
  }
  voiceState.className = `voice-state ${micState}`;
  vsTitle.textContent = title;
  vsHint.textContent = hint;
}

const sound = new SoundManager();

// ---- Engine & HUD Telemetry -------------------------------------------------
let lastAction = '';
let lastBallState = '';
let lastFlash = null;
let lastOrder = null;
let lastFlowTier = null;
const BALL_STATE_TEXT = { controlled: 'ON THE BALL', loose: 'LOOSE BALL', shot: 'SHOT!', saved: 'SAVED!', goal: 'GOAL!' };

const engine = new GameEngine(scene, sound, {
  onTelemetry: ({ speed01, action, juggleStreak, possession, ballState, score, flash, order, flowTier: fTier, flowScore: fScore }) => {
    speedFill.style.width = `${Math.round(speed01 * 100)}%`;
    if (action !== lastAction) {
      lastAction = action;
      actionLabel.textContent = action;
      actionLabel.style.color = action === 'IDLE' ? 'var(--text)'
        : /DANC|WAV|JUGGL|FEINT|FLICK|BICYCLE/.test(action) ? 'var(--magenta)' : 'var(--cyan)';
    }

    if (juggleStreak > 0) {
      jcValue.textContent = juggleStreak;
      juggleCounter.classList.add('show');
    } else {
      juggleCounter.classList.remove('show');
    }

    // Possession / ball state
    if (ballState !== lastBallState) {
      lastBallState = ballState;
      ballStateEl.textContent = BALL_STATE_TEXT[ballState] || 'LOOSE BALL';
      ballStateEl.className = `ball-state ${possession === 'robot' ? 'have' : ballState}`;
      updateDynamicSuggestions(possession, ballState);
    }

    // Scoreboard
    if (score) {
      sbGoals.textContent = score.goals;
      sbSaves.textContent = score.saves;
    }

    // Momentary banner
    if (flash !== lastFlash) {
      lastFlash = flash;
      if (flash) {
        flashEl.textContent = flash;
        flashEl.className = `flash show ${flash === 'GOAL!' ? 'goal' : 'save'}`;
      } else {
        flashEl.className = 'flash';
      }
    }

    // Active Standing Order Chip
    if (order !== lastOrder) {
      lastOrder = order;
      if (order) {
        orderIcon.textContent = order.icon;
        orderLabel.textContent = order.label;
        orderChip.classList.remove('hidden');
      } else {
        orderChip.classList.add('hidden');
      }
    }

    // Flow Meter
    if (fTier && fTier !== lastFlowTier) {
      lastFlowTier = fTier;
      flowTier.textContent = `${fTier.name} ${fTier.mult}x`;
      flowTier.style.color = fTier.color;
    }
    if (typeof fScore === 'number') {
      flowFill.style.width = `${fScore}%`;
    }
  },

  onQueueChange: (items) => {
    queueStrip.innerHTML = '';
    for (const it of items) {
      const chip = document.createElement('div');
      chip.className = `q-chip ${it.status}`;
      chip.textContent = it.label;
      queueStrip.appendChild(chip);
    }
    queueBusy = items.length > 0;
    updateVoiceState();
  },
});
window.gameEngine = engine;

// Contextual predictive suggestions
function updateDynamicSuggestions(possession, ballState) {
  let suggestions = [];
  if (possession === 'robot') {
    suggestions = [
      { label: 'Carry', cmd: 'carry' },
      { label: 'Feint', cmd: 'feint left' },
      { label: 'Top Bins', cmd: 'shoot top corner' },
    ];
  } else if (ballState === 'loose') {
    suggestions = [
      { label: 'Win Ball', cmd: 'press' },
      { label: 'Screen', cmd: 'screen' },
      { label: '1-2 Wall', cmd: 'one two' },
    ];
  } else {
    suggestions = [
      { label: 'Carry', cmd: 'carry' },
      { label: 'Flick 🌈', cmd: 'rainbow flick' },
      { label: 'Smart Shot', cmd: 'shoot' },
    ];
  }

  suggestionChips.innerHTML = '';
  for (const s of suggestions) {
    const btn = document.createElement('button');
    btn.className = 'chip sugg-chip';
    btn.dataset.cmd = s.cmd;
    btn.textContent = s.label;
    btn.addEventListener('click', () => {
      sound.init();
      voice.processText(s.cmd);
    });
    suggestionChips.appendChild(btn);
  }
}

// EventBus commentary subscriber
events.on('commentary', ({ text }) => {
  log('gemini', `🎙️ ${text}`);
});

// ---- helpers ----------------------------------------------------------------
function log(kind, text) {
  const row = document.createElement('div');
  row.className = `row ${kind}`;
  row.textContent = text;
  feed.appendChild(row);
  while (feed.childElementCount > 40) feed.removeChild(feed.firstChild);
  feed.scrollTop = feed.scrollHeight;
}

function describeIntents(intents) {
  return intents.map((i) => {
    if (i.type === 'order') return `ORDER: ${i.order}`;
    if (i.type === 'squad') return `SQUAD: ${i.verb}`;
    if (i.type === 'feint') return `feint ${i.dir}`;
    if (i.type === 'flick') return 'rainbow flick';
    if (i.type === 'onetwo') return 'one-two';
    if (i.type === 'nutmeg') return 'nutmeg';
    if (i.type === 'bicycle') return 'bicycle kick';
    if (i.type === 'move') return `move ${i.dir}${i.steps ? ' ' + i.steps : ''}`;
    if (i.type === 'turn') return `turn ${i.dir}`;
    if (i.type === 'speed') return i.level;
    if (i.type === 'kick') {
      if (i.target) return `shoot ${i.target}${i.curve ? `, curl ${i.curve}` : ''}`;
      const bits = [i.power || 'drive'];
      if (i.loft && i.loft !== 'low') bits.push(i.loft);
      if (i.curve) bits.push(`curl ${i.curve}`);
      if (i.aim) bits.push(`aim ${i.aim}`);
      return `kick (${bits.join(', ')})`;
    }
    if (i.type === 'dribble') return `dribble ${i.dir}${i.steps ? ' ' + i.steps : ''}`;
    if (i.type === 'juggle') return 'juggle';
    if (i.type === 'trap') return 'trap';
    if (i.type === 'shield') return 'shield';
    if (i.type === 'knock') return 'knock past';
    if (i.type === 'win') return 'win the ball';
    return i.type;
  }).join(' + ');
}

let responseTimer;
function showResponse(text) {
  botResponse.innerHTML = `
    <div class="bot-response-content">
      <span class="soundwave">
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
        <span class="bar"></span>
      </span>
      <span class="response-text">“${text}”</span>
    </div>
  `;
  botResponse.classList.add('show');
  clearTimeout(responseTimer);
  responseTimer = setTimeout(() => {
    if (!robotSpeaking) botResponse.classList.remove('show');
  }, 4500);
}

// ---- voice ------------------------------------------------------------------
let micOn = false;
let robotSpeaking = false;
let lastSavedCompound = [];

const voice = new VoiceController({
  onIntents: (intents, rawText, source) => {
    if (rawText) log('user', `“${rawText}”`);

    // Check for macro definition
    if (intents.length === 1 && intents[0].type === 'macro_record') {
      const name = intents[0].name;
      if (lastSavedCompound.length) {
        saveMacro(name, lastSavedCompound);
        log('local', `💾 Saved macro "${name}" (${describeIntents(lastSavedCompound)})`);
      } else {
        log('warn', `No recent play to save under "${name}".`);
      }
      return;
    }

    const real = intents.filter((i) => i.type !== 'unknown');
    if (!real.length) {
      sound.playError();
      log('warn', "didn't catch a command — try 'carry' or 'shoot'");
      return;
    }

    if (real.length > 1) {
      lastSavedCompound = real;
    }

    log(source === 'gemini' ? 'gemini' : 'local', `→ ${describeIntents(real)}`);
    if (!/stop/.test(describeIntents(real))) sound.playBlip();
    engine.runIntents(real);
  },

  onStatus: (status, msg) => {
    if (robotSpeaking) return;
    micOn = status === 'listening' || status === 'thinking';
    micOrb.className = `mic-orb ${status === 'listening' || status === 'thinking' ? status : status === 'error' ? 'error' : 'idle'}`;
    micStatus.textContent = msg;
    micState = status === 'listening' ? 'listening' : status === 'thinking' ? 'processing' : 'off';
    updateVoiceState();
  },

  onTranscript: (text, isFinal) => {
    if (robotSpeaking) return;
    transcript.textContent = text;
    transcript.style.opacity = isFinal ? '1' : '0.7';
  },

  onLevel: (level) => {
    if (robotSpeaking) return;
    const ring = micOrb.querySelector('.level-ring');
    if (ring) ring.style.transform = `scale(${1 + level * 0.6})`;
  },

  onGhostChip: (intent) => {
    const chip = document.createElement('div');
    chip.className = 'q-chip ghost';
    chip.textContent = engine.labelFor(intent);
    queueStrip.appendChild(chip);
    setTimeout(() => chip.remove(), 1200);
  },

  onSpeakingStateChange: (speaking) => {
    robotSpeaking = speaking;
    const ring = micOrb.querySelector('.level-ring');
    if (speaking) {
      micOrb.className = 'mic-orb robot-speaking';
      micStatus.textContent = 'Robot is speaking...';
      if (ring) ring.style.transform = 'scale(1)';
    } else {
      if (ring) ring.style.transform = 'scale(1)';
      const currentStatus = voice.isActive ? 'listening' : 'idle';
      micOn = currentStatus === 'listening';
      micOrb.className = `mic-orb ${currentStatus}`;
      micStatus.textContent = voice.isActive ? 'Listening — speak a command.' : 'Mic off — click the orb or hold Space';
      setTimeout(() => {
        if (!robotSpeaking) botResponse.classList.remove('show');
      }, 1000);
    }
  },

  onResponse: showResponse,
});

// ---- splash / audio unlock --------------------------------------------------
function enter(withVoice) {
  sound.init();
  sound.resume();
  splash.classList.add('hide');
  setTimeout(() => (splash.style.display = 'none'), 500);
  if (withVoice) voice.start();
}
$('btn-start-voice').addEventListener('click', () => enter(true));
$('btn-start-keys').addEventListener('click', () => enter(false));

// ---- mic orb ----------------------------------------------------------------
micOrb.addEventListener('click', () => {
  sound.init();
  if (micOn) voice.stop();
  else voice.start();
});

// ---- manual deck ------------------------------------------------------------
function sendManual(text) {
  if (!text.trim()) return;
  sound.init();
  voice.processText(text);
}
$('btn-cmd-send').addEventListener('click', () => { sendManual(cmdInput.value); cmdInput.value = ''; });
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { sendManual(cmdInput.value); cmdInput.value = ''; }
});
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => { sound.init(); voice.processText(chip.dataset.cmd); });
});

// ---- settings ---------------------------------------------------------------
const btnCam = $('btn-cam');
let orbit = false;
function toggleCamera() {
  orbit = !orbit;
  engine.setCameraMode(orbit ? 'orbit' : 'follow');
  btnCam.textContent = orbit ? '◍ ORBIT' : '◎ FOLLOW';
  log('local', `camera: ${orbit ? 'orbit (drag to rotate)' : 'follow'}`);
}
btnCam.addEventListener('click', toggleCamera);

const btnVoice = $('btn-voice');
let voiceReplies = false;
voice.setVoiceEnabled(false);
btnVoice.classList.remove('on');
btnVoice.addEventListener('click', () => {
  voiceReplies = !voiceReplies;
  voice.setVoiceEnabled(voiceReplies);
  btnVoice.classList.toggle('on', voiceReplies);
  log('local', `robot voice ${voiceReplies ? 'on' : 'off'}`);
});

const btnSound = $('btn-sound');
let muted = false;
function toggleMute() {
  muted = !muted;
  sound.setMuted(muted);
  btnSound.classList.toggle('on', !muted);
}
btnSound.addEventListener('click', toggleMute);

$('btn-help').addEventListener('click', () => drawer.classList.add('open'));
$('btn-help-close').addEventListener('click', () => drawer.classList.remove('open'));

// ---- keyboard & Push-to-Talk ------------------------------------------------
const held = new Set();
let spaceDownTime = 0;
let isPushToTalk = false;

function recompute() {
  let th = 0;
  let st = 0;
  if (held.has('fwd')) th += 1;
  if (held.has('back')) th -= 1;
  if (held.has('left')) st += 1;
  if (held.has('right')) st -= 1;
  engine.setThrottle(th);
  engine.setSteer(st);
}

const MOVE_KEYS = {
  w: 'fwd', arrowup: 'fwd', s: 'back', arrowdown: 'back',
  a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right',
};

window.addEventListener('keydown', (e) => {
  if (document.activeElement === cmdInput) return;
  const k = e.key.toLowerCase();

  if (MOVE_KEYS[k]) { held.add(MOVE_KEYS[k]); recompute(); e.preventDefault(); return; }
  if (k === 'shift') { engine.setRunning(true); return; }
  if (e.repeat) return;

  // Space: Push-to-Talk and Tap Jump
  if (k === ' ') {
    spaceDownTime = Date.now();
    sound.init();
    if (!micOn) {
      voice.start();
      isPushToTalk = true;
    }
    e.preventDefault();
    return;
  }

  switch (k) {
    case 'e': engine.runIntents([{ type: 'kick' }]); break;
    case 'q': engine.runIntents([{ type: 'feint', dir: 'left' }]); break;
    case 'z': engine.runIntents([{ type: 'flick' }]); break;
    case 'x': engine.runIntents([{ type: 'onetwo' }]); break;
    case 'f': engine.runIntents([{ type: 'wave' }]); break;
    case 'g': engine.runIntents([{ type: 'dance' }]); break;
    case 'j': engine.runIntents([{ type: 'juggle' }]); break;
    case 'r': engine.runIntents([{ type: 'reset' }]); break;
    case 'c': toggleCamera(); break;
    case 'm': toggleMute(); break;
    case 'escape': engine.runIntents([{ type: 'stop' }]); held.clear(); recompute(); break;
    case '?': drawer.classList.toggle('open'); break;
  }
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS[k]) {
    held.delete(MOVE_KEYS[k]);
    recompute();
  } else if (k === 'shift') {
    engine.setRunning(false);
  } else if (k === ' ') {
    // If Space was tapped (<280ms), perform jump
    if (Date.now() - spaceDownTime < 280) {
      engine.doJump();
    }
    // If Space was held as Push-to-Talk, release mic
    if (isPushToTalk) {
      voice.stop();
      isPushToTalk = false;
    }
  }
});

window.addEventListener('blur', () => {
  held.clear();
  recompute();
  engine.setRunning(false);
  if (isPushToTalk) {
    voice.stop();
    isPushToTalk = false;
  }
});

log('local', 'Ready. Press Start, then command your squad with voice or deck.');
