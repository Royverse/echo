// App wiring: splash -> engine + voice + input -> HUD.
import './style.css';
import { GameEngine } from './engine/GameEngine.js';
import { SoundManager } from './audio/SoundManager.js';
import { VoiceController } from './voice/VoiceController.js';

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

// Central, unmistakable communication of what the system wants from the user.
let micState = 'off';   // 'off' | 'listening' | 'processing'
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
      ? 'Keep talking — I queue commands and run them in order.'
      : 'Go ahead — say a command, or several in a row.';
  } else {
    title = 'MIC OFF';
    hint = 'Click the mic (bottom-left) to start talking.';
  }
  voiceState.className = `voice-state ${micState}`;
  vsTitle.textContent = title;
  vsHint.textContent = hint;
}

const sound = new SoundManager();

// ---- engine -----------------------------------------------------------------
let lastAction = '';
let lastBallState = '';
let lastFlash = null;
const BALL_STATE_TEXT = { controlled: 'ON THE BALL', loose: 'LOOSE BALL', shot: 'SHOT!', saved: 'SAVED!', goal: 'GOAL!' };
const engine = new GameEngine(scene, sound, {
  onTelemetry: ({ speed01, action, juggleStreak, possession, ballState, score, flash }) => {
    speedFill.style.width = `${Math.round(speed01 * 100)}%`;
    if (action !== lastAction) {
      lastAction = action;
      actionLabel.textContent = action;
      actionLabel.style.color = action === 'IDLE' ? 'var(--text)'
        : /DANC|WAV|JUGGL/.test(action) ? 'var(--magenta)' : 'var(--cyan)';
    }
    if (juggleStreak > 0) {
      jcValue.textContent = juggleStreak;
      juggleCounter.classList.add('show');
    } else {
      juggleCounter.classList.remove('show');
    }
    // possession / ball state
    if (ballState !== lastBallState) {
      lastBallState = ballState;
      ballStateEl.textContent = BALL_STATE_TEXT[ballState] || 'LOOSE BALL';
      ballStateEl.className = `ball-state ${possession === 'robot' ? 'have' : ballState}`;
    }
    // scoreboard
    if (score) { sbGoals.textContent = score.goals; sbSaves.textContent = score.saves; }
    // momentary GOAL! / SAVED! banner
    if (flash !== lastFlash) {
      lastFlash = flash;
      if (flash) {
        flashEl.textContent = flash;
        flashEl.className = `flash show ${flash === 'GOAL!' ? 'goal' : 'save'}`;
      } else {
        flashEl.className = 'flash';
      }
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
window.gameEngine = engine; // for tests

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
const voice = new VoiceController({
  onIntents: (intents, rawText, source) => {
    if (rawText) log('user', `“${rawText}”`);
    const real = intents.filter((i) => i.type !== 'unknown');
    if (!real.length) {
      sound.playError();
      log('warn', "didn't catch a command — try 'walk forward' or 'stop'");
      return;
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
  onSpeakingStateChange: (speaking) => {
    robotSpeaking = speaking;
    const ring = micOrb.querySelector('.level-ring');
    if (speaking) {
      micOrb.className = 'mic-orb robot-speaking';
      micStatus.textContent = 'Robot is speaking...';
      if (ring) ring.style.transform = 'scale(1)';
    } else {
      if (ring) ring.style.transform = 'scale(1)';
      // Restore mic status
      const currentStatus = voice.isActive ? 'listening' : 'idle';
      micOn = currentStatus === 'listening';
      micOrb.className = `mic-orb ${currentStatus}`;
      micStatus.textContent = voice.isActive ? 'Listening — speak a command.' : 'Mic off — click the orb to talk';
      
      // Hide speech bubble slightly after speaking finishes
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
  // Ambient drone intentionally not started — it read as a constant buzz.
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
let voiceReplies = false; // robot voice off by default; user can opt in
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

// ---- keyboard (analog momentum) --------------------------------------------
const held = new Set();
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

  switch (k) {
    case ' ': engine.doJump(); e.preventDefault(); break;
    case 'e': engine.runIntents([{ type: 'kick' }]); break;
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
  if (MOVE_KEYS[k]) { held.delete(MOVE_KEYS[k]); recompute(); }
  else if (k === 'shift') engine.setRunning(false);
});

// Pause momentum if the window loses focus (avoids "stuck key" drift).
window.addEventListener('blur', () => { held.clear(); recompute(); engine.setRunning(false); });

log('local', 'Ready. Press Start, then say "walk forward".');
