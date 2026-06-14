# ECHO — Voice-Driven Robot Sandbox

**ECHO** is a procedurally animated, voice-controlled 3D robot playground built with **Three.js**, **Web Speech API**, **Web Audio API**, and **Gemini 2.5 NLU**. 

Drive a retro-futuristic robot through an interactive arena using natural spoken commands. The application features a fully responsive chase camera, procedural audio effects, an action queue system, text-to-speech feedback, and continuous listening with intelligent background noise filters.

---

## 🚀 Key Features

* **Continuous Listening & Action Chaining**: The microphone stays open continuously (`continuous = true`). You can queue commands in rapid succession (e.g., *"walk forward 3 steps, then turn left, then dance"*), and the robot executes them sequentially.
* **Fuzzy & LLM Semantic Parsing**: A local regex parser processes standard movement commands with zero network latency. Fuzzy, complex, or conversational phrasing (e.g., *"hey buddy, could you spin around please"*) is escalated to a secure **Gemini 2.5 Flash** serverless proxy.
* **Apple-Grade Feedback States**:
  * **Standby Dimming**: The microphone orb dims and disables click events when the robot is speaking, preventing feedback loops from speaker audio.
  * **Visual Soundwave**: An animated CSS soundwave visualizer plays inside the robot's speech bubble during voice synthesis.
  * **Emergency Override**: Emergency commands like *"stop"*, *"halt"*, or *"freeze"* bypass speaker locks and immediately cancel all queued actions.
* **Procedural Sound Effects**: All sound effects (footfalls, turns, jumps, collections) are synthesized dynamically in real-time using the **Web Audio API** oscillators and white noise buffers.
* **Sequential Diagonal Walk Sequencing**: Direct diagonal commands (e.g., *"walk forward-left"*) are resolved by first rotating the character 45 degrees to face the target heading, then walking forward, matching physical animation cycles with ground speed.

---

## 🛠️ Technology Stack

* **Front-end**: Vanilla JS / HTML5 / CSS3
* **3D Rendering**: Three.js (WebGL, OrbitControls, PCFShadowMap, ACESFilmicToneMapping)
* **Voice Recognition**: Web Speech API (`window.SpeechRecognition`)
* **Natural Language Understanding**: Gemini 2.5 Flash (`gemini-2.5-flash` via Netlify Functions proxy)
* **Speech Synthesis (TTS)**: StreamElements Polly API (Brian voice) with local browser fallback
* **Build Tool**: Vite
* **Testing**: Playwright End-to-End Testing Framework

---

## 📦 Project Architecture

```
├── .netlify/
│   └── state.json          # Netlify project link configuration
├── netlify/
│   └── functions/
│       ├── _gemini.mjs     # Shared Gemini prompt & fetch configurations
│       ├── parse.mjs       # Serverless function for Gemini intent NLU
│       └── tts.mjs         # Serverless function proxy for speech generation
├── public/
│   ├── favicon.svg         # SVG icon with soundwave arches
│   ├── icons.svg           # Sprite vector shapes for HUD
│   └── manifest.webmanifest# Progressive Web App properties
├── src/
│   ├── api.js              # Client NLU/TTS router (Vite dev vs. Netlify prod)
│   ├── audio.js            # Web Audio API sound synthesis engine
│   ├── character.js        # 3D primitives assembly & animation rigs
│   ├── commands.js         # Local fast-path parser
│   ├── game.js             # Physics, locomotion, lighting, and queue loop
│   ├── main.js             # DOM coordinator, key bindings, and HUD status
│   └── style.css           # Neon-glassmorphic styling & keyframe animations
├── tests/
│   ├── mechanics.spec.js   # E2E locomotion and decoupling tests
│   └── ui.spec.js          # E2E interface mounting & command deck tests
├── netlify.toml            # Serverless headers & redirects
└── playwright.config.js    # Playwright configuration (ports & timeouts)
```

---

## 🏁 Getting Started

### Prerequisites

Ensure you have Node.js version 18+ installed on your machine.

### Installation

1. Clone the repository and navigate to the project directory:
   ```bash
   git clone https://github.com/Royverse/echo.git
   cd echo
   ```
2. Install the dependencies:
   ```bash
   npm install
   ```
3. Initialize the Playwright browsers:
   ```bash
   npx playwright install
   ```

### Running Locally

1. Create a `.env.development.local` file in the root directory:
   ```env
   VITE_GEMINI_API_KEY=your_gemini_api_key_here
   ```
2. Start the Vite development server:
   ```bash
   npm run dev
   ```
3. Open your browser and navigate to `http://localhost:5174/`.

### Running Tests

To run the full E2E test suite sequentially (to prevent WebGL GPU resource contention in headless browsers):
```bash
npx playwright test --workers=1
```

---

## 🌐 Production Deployment

This project is deployed to **Netlify** with serverless functions proxying Gemini API requests securely.

* **Production URL**: [https://echo-voice-sandbox.netlify.app](https://echo-voice-sandbox.netlify.app)
* **API Security**: The client sends transcripts to the internal serverless endpoint `/.netlify/functions/parse`, which reads the server-side `GEMINI_API_KEY` environment variable. The secret key is never exposed to the client.
