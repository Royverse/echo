# AGENTS.md

Orientation for AI assistants (and humans) working in this repo. Read this before editing — it captures the
architecture and the conventions that aren't obvious from any single file.

## What this is

ECHO is a voice-driven 3D robot sandbox: **vanilla ES modules + Three.js**, no framework, no state
library, no 3D/audio asset files (everything is generated in code). It's deployed as a static site plus
Netlify Functions. Keep it small, dependency-light, and readable.

## The one idea that ties it together: the intent

Speech and keyboard both reduce to a stream of **intents** with a single shared schema. Every producer emits
this shape; the engine consumes it. If you keep the schema stable, the layers stay decoupled.

```js
{ type: 'move',  dir: 'forward'|'backward', steps?: number }   // steps omitted → DEFAULT_MOVE_STEPS
{ type: 'turn',  dir: 'left'|'right'|'around', degrees?: number }
{ type: 'speed', level: 'run'|'walk'|'faster'|'slower' }
{ type: 'stop' } | 'jump' | 'wave' | 'dance' | 'reset'
```

## Data flow

```
mic ─► VoiceController.handleUtterance(text)
          ├─ parser.parseCommand(text)              # local, instant, splits clauses
          │     └─ confident? → onIntents(intents)
          └─ not confident → gemini.parseIntentWithGemini(text)   # dev: Google direct · prod: function
                                  └─ onIntents(intents)

onIntents ─► GameEngine.runIntents(intents)
                └─ queue → pump() → beginAction() (blocking) → completion hook → finishActive() → next
```

The engine runs blocking actions **one at a time** (move/turn/jump/wave/dance/reset). `speed` is a
non-blocking modifier. `stop` clears everything. The HUD reflects the queue via `onQueueChange`.

## Module map (who owns what)

| File | Responsibility |
| --- | --- |
| `src/main.js` | Wiring only: constructs the engine/voice/sound, binds DOM + keyboard, renders HUD state. No game logic. |
| `src/engine/GameEngine.js` | Scene, lights, environment, render loop, **momentum locomotion**, the **command queue**, chase camera. |
| `src/engine/Robot.js` | Procedural Three.js rig + animation. Pure: it's told `{speed, turnRate, ...}` and poses itself. |
| `src/voice/VoiceController.js` | Web Speech recognition, mic-level metering, status, and layered TTS. Emits intents via callbacks. |
| `src/voice/parser.js` | Local intent parser. Instant, no network. Splits run-on speech into ordered clauses. |
| `src/voice/gemini.js` | Gemini NLU + TTS. Dev-direct (VITE key) or serverless proxy (prod). |
| `src/audio/SoundManager.js` | Procedural Web Audio SFX + ambient drone. Everything routes through a master gain. |
| `netlify/functions/*` | Serverless Gemini proxy so the key stays server-side. `_gemini.mjs` holds the shared prompt. |

## Recipe: add a new voice command end-to-end

Say you want **“crouch”**. Touch these four places, in order:

1. **`src/voice/parser.js`** — recognize the words in `parseClause`, push `{ type: 'crouch' }`.
2. **`netlify/functions/_gemini.mjs`** (+ the mirrored prompt in `src/voice/gemini.js`) — add `crouch` to the
   schema so fuzzy phrasing maps to it too.
3. **`src/engine/GameEngine.js`** — handle it in `beginAction()` (return `true` if it should block the queue
   until done), add a completion hook that calls `finishActive()`, and a `labelFor()` entry for the HUD chip.
4. **`index.html`** — add it to the command reference / quick-chips so it's discoverable.

That's the whole pattern: **parser → schema → engine action + completion + label → docs.**

## Conventions

- **PascalCase files export a class** (`GameEngine.js`, `Robot.js`, `SoundManager.js`, `VoiceController.js`);
  camelCase files export functions (`parser.js`, `gemini.js`).
- Every module starts with a short comment explaining its job. Keep it accurate when you change behavior.
- Engine math is frame-rate independent (`dt`-scaled, or `1 - exp(-k*dt)` smoothing). Don't introduce
  per-frame constants that assume 60fps.
- No dead code or unused imports. If you remove a feature, remove its wiring.
- The local parser must stay zero-network; only `gemini.js` may make requests.

## Commands

```bash
npm run dev       # Vite dev server (use a real browser tab for the mic)
npm run build     # production build → dist/
npm run preview   # serve the production build
npm test          # Playwright E2E (runs with --workers=1 to avoid WebGL contention)
```

## Gotchas

- **Mic needs a real browser + secure origin.** Embedded preview panes often block `getUserMedia`/Speech;
  test on `http://localhost` or HTTPS in Chrome/Edge.
- **Key handling differs by mode.** `VITE_GEMINI_API_KEY` lives in `.env.development.local` (dev only, never
  bundled). Production uses server-side `GEMINI_API_KEY` via the functions. Never put the key in `.env.local`
  or `.env` — those load during `vite build` and would ship it.
- **Robot voice (TTS) is off by default** — it gated the mic and broke back-to-back commands. The toggle is
  the VOICE pill. If you re-enable it by default, restore the mic-bleed guard in `VoiceController`.
- **Continuous recognition self-restarts** on `onend`; don't assume a single session.
- The keyboard path calls `engine.setThrottle/setSteer` directly (analog) and intentionally **overrides** the
  voice queue — manual control wins.
