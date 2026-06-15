<div align="center">

# ECHO

### Drive a neon robot through a 3D sandbox — with your voice.

[**Live demo →**](https://echo-voice-sandbox.netlify.app) · Built with Three.js, the Web Speech API, and Gemini

</div>

---

ECHO is a voice-driven 3D playground. Speak naturally — *“walk forward, then turn left, then dance”* — and a
procedurally-animated robot carries out your commands in order, with smooth momentum-based locomotion and a
cinematic chase camera. Everything (the robot, the sound, the world) is generated in code; there are no 3D
model files or audio assets.

It’s deliberately small and dependency-light: **vanilla ES modules + Three.js**, no UI framework, no state
library. The interesting parts are the *voice-to-action pipeline* and the *momentum engine*.

## Highlights

- **Talk in sequences.** Continuous speech recognition captures whatever you say; the words are parsed into a
  queue of intents that execute strictly one at a time, each running to completion before the next. A HUD strip
  shows the queue filling and draining.
- **Instant where it can be, smart where it must be.** A local zero-latency [parser](src/voice/parser.js)
  resolves the common cases (and splits run-on speech into ordered clauses). Only fuzzy, conversational phrasing
  escalates to Gemini.
- **The API key never reaches the browser.** In production, Gemini is called through
  [Netlify Functions](netlify/functions/); the client only talks to `/.netlify/functions/*`. In local dev a
  dev-only key is used directly. (See [security](#security).)
- **Momentum, not teleporting.** Real acceleration, braking, and banking turns; the walk/run gait is driven by
  actual ground speed, so the feet never slide.
- **Clear feedback at all times.** A prominent banner tells you when ECHO is *listening*, *processing*, or
  *off* — so you always know whether to keep talking or wait.
- **Installable.** A web-app manifest makes it a standalone PWA.

## How it works

```
   🎤 speech ─► VoiceController ─► parser.js (local, instant) ──┐
                  (recognition,      │                          ├─► intents ─► GameEngine queue ─► Robot + camera
                   mic level,        └─ gemini.js (fuzzy) ──────┘                 (one action at a time)
                   TTS)                   │
                                          └─ dev: Google direct │ prod: /.netlify/functions/parse
```

Every parser — local and Gemini — emits the **same intent schema**, so the engine has a single code path:

```js
{ type: 'move',  dir: 'forward'|'backward', steps?: number }   // steps omitted → engine default
{ type: 'turn',  dir: 'left'|'right'|'around', degrees?: number }
{ type: 'speed', level: 'run'|'walk'|'faster'|'slower' }
{ type: 'stop' } | 'jump' | 'wave' | 'dance' | 'reset'
```

## Project structure

```
echo/
├── index.html                 # HUD markup + splash; mounts /src/main.js
├── netlify.toml               # build + functions config
├── netlify/functions/         # serverless Gemini proxy (key stays server-side)
│   ├── _gemini.mjs            # shared prompt, model ids, helpers
│   ├── parse.mjs              # POST transcript → intents
│   └── tts.mjs                # POST text → neural speech audio
├── public/
│   ├── favicon.svg            # the ECHO mark
│   └── manifest.webmanifest   # PWA / standalone install
└── src/
    ├── main.js                # app wiring: engine + voice + input + HUD
    ├── style.css              # the entire HUD design system
    ├── engine/
    │   ├── GameEngine.js      # scene, render loop, locomotion, command queue, camera
    │   └── Robot.js           # procedural rig + speed-driven animation
    ├── voice/
    │   ├── VoiceController.js  # mic, recognition, status, layered TTS
    │   ├── parser.js          # local instant intent parser
    │   └── gemini.js          # NLU + TTS (dev-direct or serverless proxy)
    └── audio/
        └── SoundManager.js    # procedural Web Audio SFX + ambience
```

New to the codebase? Start with [`AGENTS.md`](AGENTS.md) — it maps the architecture and shows how to add a
command end-to-end.

## Getting started

```bash
git clone https://github.com/Royverse/echo.git
cd echo
npm install

cp .env.example .env.development.local   # then add your Gemini API key
npm run dev                              # http://localhost:5173
```

> **Use a real browser tab (Chrome/Edge), not an embedded preview pane** — the Web Speech API needs a true
> browser context and a secure origin (localhost counts).

A [Gemini API key](https://aistudio.google.com/apikey) is optional: the local parser handles most commands
without it. The key only powers fuzzy natural-language understanding and the (off-by-default) robot voice.

## Controls

**Voice** — say it, or type it in the command deck (`?` to open):

| Say | ECHO does |
| --- | --- |
| “walk forward”, “go” | move ahead (a few steps; chainable) |
| “walk five steps”, “back up three” | move an exact distance |
| “turn left / right”, “spin around” | turn in place |
| “run”, “faster”, “slower”, “walk” | change pace |
| “jump”, “wave”, “dance”, “go home” | actions |
| **“stop”** | halt instantly — even mid-word |

**Keyboard** — `W A S D` / arrows to drive, `Shift` run, `Space` jump, `F` wave, `G` dance, `C` camera,
`R` recenter, `M` mute, `Esc` stop.

## Security

`VITE_*` variables are baked into the client bundle at build time, so the Gemini key is handled in two paths:

- **Dev** — `VITE_GEMINI_API_KEY` in `.env.development.local` (loaded by Vite *only* in dev mode) is used to
  call Google directly. Convenient, and never shipped.
- **Prod** — no client key. The client calls the Netlify Functions, which read a **server-side**
  `GEMINI_API_KEY`. Set it with `netlify env:set GEMINI_API_KEY "<key>"`.

## Deployment

Hosted on **Netlify** (static `dist/` + serverless functions):

```bash
netlify env:set GEMINI_API_KEY "<key>"   # server-side only
netlify deploy --build --prod
```

## Tech stack

Vanilla JS · [Three.js](https://threejs.org) (WebGL, OrbitControls, ACES tone mapping) · Web Speech API ·
Web Audio API · [Gemini 2.5 Flash](https://ai.google.dev) · [Vite](https://vitejs.dev) ·
[Playwright](https://playwright.dev) · Netlify Functions.

## License

[MIT](LICENSE) © Royverse
