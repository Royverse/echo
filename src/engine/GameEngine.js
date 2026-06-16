// Core engine: scene setup, momentum locomotion, the sequential command queue,
// the cinematic chase camera, and the per-frame render loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Robot } from './Robot.js';
import { Ball } from './Ball.js';
import { Goalkeeper } from './Goalkeeper.js';
import { Defender } from './Defender.js';

// --- Locomotion tuning -------------------------------------------------------
const WALK_SPEED = 3.2;     // units / second
const RUN_SPEED = 7.0;
const ACCEL = 14;           // how fast speed ramps up
const DECEL = 16;           // braking
const TURN_RATE = 2.6;      // max steering rad/s
const TURN_ACCEL = 12;
const STEP_SIZE = 1.6;      // distance per "step" for counted commands
const DEFAULT_MOVE_STEPS = 5; // bare "walk forward" => bounded so the queue advances
const ARENA_RADIUS = 26;
const GRAVITY = 26;
const JUMP_VELOCITY = 9.2;

// --- Football tuning ---------------------------------------------------------
// Spoken intent → physics. Power sets launch speed; loft sets vertical launch.
const KICK_POWER = { tap: 5, pass: 9, drive: 14, blast: 21 }; // m/s along the aim
const KICK_LOFT = { ground: 0, low: 2.6, lofted: 7.5, chip: 9 }; // m/s upward
const SHOT_SPEED = { tap: 10, pass: 13, drive: 18, blast: 24 }; // firmer than a pass — placed shots at goal
const BALL_GRAVITY = 24;       // MUST match GRAVITY in Ball.js (used by the shot solver)
const KICK_SPIN = 0.34;        // lateral spin magnitude for "curl/bend"
const AIM_OFFSET = 0.22;       // radians a left/right "aim" nudges the shot (~13°)
const STRIKE_RANGE = 1.6;      // robot must be this close to strike; else it runs up

// --- Possession tuning -------------------------------------------------------
const CONTROL_RADIUS = 1.4;    // a loose, slow ball this close gets brought under control
const CONTROL_SPEED = 7;       // ...and only if it isn't moving faster than this
const CONTROL_NEAR = 0.7;      // close-control distance ahead of the feet at a walk
const CONTROL_FAR = 1.7;       // ...stretched ahead at a run (knock-ahead = tackleable)
const CONTROL_STIFFNESS = 10;  // how snappily the ball tracks the feet (spring rate)

export class GameEngine {
  constructor(container, soundManager, ui = {}) {
    this.container = container;
    this.sound = soundManager;
    this.ui = ui; // { onTelemetry({speed01, action, running}) }
    this.clock = new THREE.Clock();

    this.cameraMode = 'follow';

    // Locomotion state
    this.heading = 0;
    this.speed = 0;
    this.turnRate = 0;
    this.throttle = 0;        // -1..1 continuous intent (voice/keys)
    this.steer = 0;           // -1..1 continuous intent
    this.running = false;
    this.speedScale = 1;      // faster/slower multiplier (0.5..1.6)

    this.moveGoal = null;     // { dir, remaining } precise distance
    this.turnGoal = null;     // { dir, remaining } precise angle (radians)
    this.queue = [];          // pending actions, executed strictly in order
    this.active = null;       // the action currently running (blocks the queue)
    this._aid = 0;            // monotonic id for queued actions

    this.vy = 0;              // vertical velocity (jump)
    this.airborne = false;
    this.landSquash = 0;

    this.pose = 'none';
    this.poseTimer = 0;
    this.resetTween = null;

    // Football state
    this.juggleStreak = 0;    // keepie-uppie counter (freestyle toy)
    this._pendingKick = null; // { impulse, spin, t, power } released at foot contact
    this.possession = null;   // 'robot' | 'defender' | null (loose / in-flight)
    this.ballState = 'loose'; // 'loose' | 'controlled' | 'shot' | 'saved'
    this._shieldTimer = 0;    // > 0 while actively shielding (protects possession)
    this._collectCooldown = 0;// brief lockout so a fresh shot isn't re-collected instantly
    this.score = { goals: 0, saves: 0 };
    this._ballPrevZ = 5;      // for goal/save line-crossing detection
    this._kickoffTimer = 0;   // counts down after a goal, then re-centres for kickoff
    this._flash = null;       // { text, t } momentary HUD banner (GOAL! / SAVED! …)

    this.actionLabel = 'IDLE';

    // smoothed camera aim
    this._camLook = new THREE.Vector3();
    this._tmp = new THREE.Vector3();

    this.initThree();
    this.buildEnvironment();
    this.spawnRobot();
    this.animate();
  }

  // ---------------------------------------------------------------- setup ----
  initThree() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1324);
    this.scene.fog = new THREE.FogExp2(0x0e1324, 0.014);

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 400);
    this.baseFov = 60;
    this.camera.position.set(0, 4, -8);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.container.appendChild(this.renderer.domElement);

    // Post-processing: ACES tone-mapped output. (Bloom intentionally omitted
    // for a cleaner, less neon look; re-add an UnrealBloomPass here to bring it back.)
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 60;
    this.controls.enabled = false;

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
    this.scene.add(new THREE.AmbientLight(0x3a4a6a, 0.8));

    const key = new THREE.DirectionalLight(0xbcd4ff, 2.2);
    key.position.set(14, 22, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 70;
    const d = 30;
    key.shadow.camera.left = -d; key.shadow.camera.right = d;
    key.shadow.camera.top = d; key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8ab4f8, 0.8);
    fill.position.set(-14, 12, 10);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xff2d78, 1.2);
    rim.position.set(-12, 8, -14);
    this.scene.add(rim);

    window.addEventListener('resize', () => this.onResize());
  }

  buildEnvironment() {
    // Floor (subtly reflective dark).
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(ARENA_RADIUS + 8, 64),
      new THREE.MeshStandardMaterial({ color: 0x121726, roughness: 0.55, metalness: 0.6 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(ARENA_RADIUS * 2, 40, 0x6e7f98, 0x2e3b52);
    grid.position.y = 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    this.scene.add(grid);

    // Elegant boundary ring.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA_RADIUS, 0.12, 12, 120),
      new THREE.MeshStandardMaterial({ color: 0x5c6d84 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.12;
    this.scene.add(ring);

    // Contact glow that follows the robot.
    this.contact = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.95, 40),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.02;
    this.scene.add(this.contact);

    // Possession ring — shows under the robot when it's on the ball. Green when
    // secure, amber when a defender is pressuring. Hidden when the ball is loose.
    this.possRing = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.22, 44),
      new THREE.MeshBasicMaterial({ color: 0x00e676, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.possRing.rotation.x = -Math.PI / 2;
    this.possRing.position.y = 0.03;
    this.scene.add(this.possRing);

    // A few elegant pillars for parallax/depth.
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x323a4a, roughness: 0.3, metalness: 0.6 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x8ab4f8 });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.3;
      const r = ARENA_RADIUS - 2.5;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      const hgt = 5 + (i % 3) * 2;
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, hgt, 1.2), pillarMat);
      pillar.position.set(px, hgt / 2, pz);
      pillar.castShadow = true;
      this.scene.add(pillar);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.16, 1.26), trimMat);
      trim.position.set(px, hgt - 0.6, pz);
      this.scene.add(trim);
    }

    // Decorative goal — purely an aim target ("far post", "top corner"); no
    // keeper, no score. The net ripples when the ball goes in for a bit of juice.
    this.buildGoal();

    // Drifting light motes for atmosphere (replaces the old collectibles).
    const count = 160;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * ARENA_RADIUS;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = 0.5 + Math.random() * 9;
      positions[i * 3 + 2] = Math.sin(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.motes = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0x6fe9ff, size: 0.12, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.scene.add(this.motes);
  }

  spawnRobot() {
    this.robot = new Robot();
    this.scene.add(this.robot.mesh);
    this.ball = new Ball(ARENA_RADIUS);
    this.scene.add(this.ball.mesh);
    this.keeper = new Goalkeeper(this.goal);
    this.scene.add(this.keeper.mesh);
    this.defender = new Defender(this.goal);
    this.scene.add(this.defender.mesh);
    this.snapCamera();
  }

  updateOpponents(dt) {
    if (this.keeper) this.keeper.update(dt, { ball: this.ball, possession: this.possession });
    if (this.defender) this.defender.update(dt, this._defenderCtx());
  }

  _defenderCtx() {
    return {
      ball: this.ball,
      possession: this.possession,
      shielding: this._shieldTimer > 0,
      goalZ: this.goal.z,
      setPressure: (v) => { this._defenderNear = v; },
      onTackle: () => this.loseBallToTackle(),
    };
  }

  // The defender nicks the ball: knock it loose upfield, end the robot's action,
  // and lock out re-collection briefly so it's a real turnover to fight back from.
  loseBallToTackle() {
    if (this.possession !== 'robot') return;
    this.releasePossession('loose');
    const away = new THREE.Vector3(THREE.MathUtils.randFloatSpread(6), 0, -7); // booted back upfield
    this.ball.kick(away, 0);
    this.sound.playTackle();
    this.moveGoal = null; this.throttle = 0; this.running = false;
    this._collectCooldown = 0.9;
    if (this.active && ['move', 'dribble', 'knock'].includes(this.active.type)) this.finishActive();
  }

  buildGoal() {
    const z = ARENA_RADIUS - 3;   // tucked just inside the boundary
    const w = 7;
    const h = 2.7;
    this.goal = { z, w, h, scored: false, ripple: 0 };

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xf4f7ff, roughness: 0.4, metalness: 0.3, emissive: 0x1a2740, emissiveIntensity: 0.4,
    });
    const post = new THREE.CylinderGeometry(0.1, 0.1, h, 12);
    const left = new THREE.Mesh(post, postMat);
    left.position.set(-w / 2, h / 2, z);
    left.castShadow = true;
    this.scene.add(left);
    const right = left.clone();
    right.position.x = w / 2;
    this.scene.add(right);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, w + 0.2, 12), postMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, h, z);
    this.scene.add(bar);

    // Wireframe netting (back + roof) — light, transparent, asset-free.
    const netMat = new THREE.MeshBasicMaterial({
      color: 0x9fb4d4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, wireframe: true,
    });
    this.goalNet = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 14, 7), netMat);
    this.goalNet.position.set(0, h / 2, z + 1.3);
    this.scene.add(this.goalNet);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.5, 14, 4), netMat);
    roof.rotation.x = Math.PI / 2;
    roof.position.set(0, h, z + 0.65);
    this.scene.add(roof);

    // Faint target grid so the placement zones read (top/bottom × left/center/right).
    const gridMat = new THREE.LineBasicMaterial({ color: 0x9fb4d4, transparent: true, opacity: 0.13 });
    const gpts = [];
    for (const fx of [-w / 6, w / 6]) gpts.push(fx, 0.05, z, fx, h, z);  // column dividers
    gpts.push(-w / 2, h / 2, z, w / 2, h / 2, z);                        // row divider
    const ggeo = new THREE.BufferGeometry();
    ggeo.setAttribute('position', new THREE.Float32BufferAttribute(gpts, 3));
    this.scene.add(new THREE.LineSegments(ggeo, gridMat));

    // Aim marker — a bright ring that flashes on the goal where a shot is placed.
    this.aimMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.34, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.aimMarker.position.set(0, h / 2, z - 0.08);
    this.aimMarker.renderOrder = 3;
    this.scene.add(this.aimMarker);
    this._aimFade = 0;
  }

  // ------------------------------------------------------------- commands ----
  // Append intents to the queue. They execute strictly one-at-a-time, each
  // running to completion before the next begins, so a string of spoken
  // commands plays back as a clean, watchable sequence. "stop" clears all.
  runIntents(intents) {
    if (!intents || !intents.length) return;
    if (intents.some((i) => i.type === 'stop')) { this.halt(); return; }
    for (const intent of intents) this.queue.push({ ...intent, _id: ++this._aid });
    this.emitQueue();
    this.pump();
  }

  pump() {
    if (this.active) return;
    while (this.queue.length) {
      const a = this.queue.shift();
      if (this.beginAction(a)) { this.active = a; this.emitQueue(); return; }
      // non-blocking modifier (e.g. speed) — apply and keep draining the queue
    }
    this.active = null;
    this.emitQueue();
  }

  // Returns true if the action blocks the queue until it finishes.
  beginAction(a) {
    switch (a.type) {
      case 'move': {
        this.pose = 'none'; this.robot.pose = 'none';

        // Diagonals decompose into a turn (45°/135°) then a straight move.
        const diag = {
          'forward-left': [45, 'left'], 'forward-right': [45, 'right'],
          'backward-left': [135, 'left'], 'backward-right': [135, 'right'],
        }[a.dir];
        if (diag) {
          this.queue.unshift({ type: 'move', dir: 'forward', ...(a.steps ? { steps: a.steps } : {}), _id: ++this._aid });
          this.queue.unshift({ type: 'turn', dir: diag[1], degrees: diag[0], _id: ++this._aid });
          return false; // expanded in place; the pump continues with the turn
        }

        const dirSign = a.dir === 'backward' ? -1 : 1;
        const steps = a.steps || DEFAULT_MOVE_STEPS;
        this.moveGoal = { dir: dirSign, remaining: steps * STEP_SIZE };
        this.throttle = dirSign;
        return true;
      }
      case 'turn': {
        this.pose = 'none'; this.robot.pose = 'none';
        let angle = Math.PI / 2;
        if (a.dir === 'around') angle = Math.PI;
        else if (a.degrees) angle = THREE.MathUtils.degToRad(a.degrees);
        this.turnGoal = { dir: a.dir === 'right' ? -1 : 1, remaining: angle };
        this.sound.playTurn();
        return true;
      }
      case 'speed':
        if (a.level === 'run') { this.running = true; this.sound.playBoost(); }
        else if (a.level === 'walk') this.running = false;
        else if (a.level === 'faster') { this.speedScale = Math.min(1.6, this.speedScale + 0.25); this.sound.playBoost(); }
        else if (a.level === 'slower') this.speedScale = Math.max(0.5, this.speedScale - 0.25);
        return false;
      case 'jump': this.startJump(); return true;
      case 'wave': this.startPose('wave', 2.4); return true;
      case 'dance': this.startPose('dance', 4.5); return true;
      case 'reset': this.startReset(); return true;

      // ---- football ----
      case 'kick': {
        // Run up to the ball if it isn't at the robot's feet, then strike.
        if (this.approachBall(a, 1.0)) return false;
        this.startKickStrike(a);
        return true;
      }
      case 'dribble': {
        if (this.approachBall(a, 0.8)) return false;             // run up & collect a loose ball
        this.pose = 'none'; this.robot.pose = 'none';
        this.running = false;                                    // tight close control at a walk
        const dir = a.dir === 'backward' ? -1 : 1;
        const steps = a.steps || 4;
        this.moveGoal = { dir, remaining: steps * STEP_SIZE };
        this.throttle = dir;
        return true; // completes via the shared move-goal logic
      }
      case 'juggle': this.startJuggle(); return true;
      case 'trap': this.ball.trap(); this.sound.playBounce(0.3); return false;
      case 'shield': this.startShield(); return false;
      case 'knock': return this.startKnock(a);
      case 'win': {
        if (this.possession === 'robot') return false;
        this.running = true;
        if (this.approachBall(a, 0.8)) return false;             // sprint to the loose ball; auto-collect
        return false;
      }

      default: return false;
    }
  }

  // Decompose a ball action into "turn to face the ball → walk up → <action>" when
  // the ball is out of range. Returns true if it expanded the queue (the AI does
  // the run-up); false if the robot is already close enough to act now.
  approachBall(a, stopDist) {
    if (a._approached) return false;
    const rp = this.robot.mesh.position;
    const bp = this.ball.position;
    const dx = bp.x - rp.x;
    const dz = bp.z - rp.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= stopDist) return false;

    const targetHeading = Math.atan2(dx, dz);
    const delta = Math.atan2(Math.sin(targetHeading - this.heading), Math.cos(targetHeading - this.heading));
    const degrees = THREE.MathUtils.radToDeg(Math.abs(delta));
    const steps = Math.max(1, Math.round((dist - (stopDist - 0.3)) / STEP_SIZE));

    this.queue.unshift({ ...a, _approached: true, _id: ++this._aid });
    this.queue.unshift({ type: 'move', dir: 'forward', steps, _id: ++this._aid });
    if (degrees > 4) {
      this.queue.unshift({ type: 'turn', dir: delta > 0 ? 'left' : 'right', degrees, _id: ++this._aid });
    }
    return true;
  }

  startKickStrike(a) {
    this.pose = 'kick';
    this.poseTimer = 0.7;
    this.throttle = 0; this.steer = 0;
    this.moveGoal = null; this.turnGoal = null;
    this.juggleStreak = 0;

    const rp = this.robot.mesh.position;
    const bp = this.ball.position;
    const spin = a.curve === 'left' ? KICK_SPIN : a.curve === 'right' ? -KICK_SPIN : 0;
    const target = a.target ? this.resolveTarget(a.target, bp) : null;

    let impulse, isShot, legHint;
    if (target) {
      // Placed shot: solve the launch so the ball passes through the called spot on
      // the goal. A curl bias starts the ball a touch wider so Magnus bends it back.
      impulse = this.solveShot(bp, target, a.power, spin);
      isShot = true;
      legHint = target.x >= bp.x ? 1 : -1;          // strike with the leg toward the target
      const fh = Math.atan2(target.x - bp.x, this.goal.z - bp.z);
      this.heading = fh; this.robot.mesh.rotation.y = fh;   // face the shot
      this.showAimMarker(target);
    } else {
      // Hybrid heading aim: the ball flies along the robot's facing (turn to line up);
      // only snap to face the ball if it's well behind. left/right = player's view.
      const toBall = Math.atan2(bp.x - rp.x, bp.z - rp.z);
      const delta = Math.atan2(Math.sin(toBall - this.heading), Math.cos(toBall - this.heading));
      if (Math.abs(delta) > (2 * Math.PI) / 3) { this.heading = toBall; this.robot.mesh.rotation.y = this.heading; }
      const aimOff = a.aim === 'left' ? -AIM_OFFSET : a.aim === 'right' ? AIM_OFFSET : 0;
      const aimHeading = this.heading + aimOff;
      const speed = KICK_POWER[a.power] ?? KICK_POWER.drive;
      const vy = KICK_LOFT[a.loft] ?? KICK_LOFT.low;
      const hSpeed = a.loft === 'chip' ? speed * 0.55 : speed;   // chip floats up, less drive
      impulse = new THREE.Vector3(Math.sin(aimHeading) * hSpeed, vy, Math.cos(aimHeading) * hSpeed);
      isShot = a.power === 'blast' || a.power === 'drive';        // a firm strike reads as a shot for the HUD
      legHint = a.aim === 'right' || a.curve === 'right' ? 1 : -1;
    }

    this.robot.startKick(0.7, legHint >= 0 ? 1 : -1);
    const power01 = Math.min(1, Math.hypot(impulse.x, impulse.z) / KICK_POWER.blast);
    // Release the impulse mid-swing (foot meets ball), not now.
    this._pendingKick = { impulse, spin, t: this.robot.KICK_CONTACT * 0.7, power: power01, shot: isShot };
  }

  // Map a spoken target ("top-left", "bottom-right", "near-post"…) to a world point
  // on the goal plane. left/right = the player's view when attacking the +z goal
  // (world −x = left). Corners tuck just inside the posts and under the bar.
  resolveTarget(name, bp) {
    const g = this.goal;
    const sideX = g.w / 2 - 1.0;       // inside the post with room for the ball
    const topY = g.h - 0.5;            // just under the bar
    const lowY = 0.5;                  // just off the deck
    let x = 0;
    let y = /top|roof|bins|upper|high/.test(name) ? topY : lowY;
    if (/left/.test(name)) x = -sideX;
    else if (/right/.test(name)) x = sideX;
    else if (/near.?post/.test(name)) x = bp.x >= 0 ? sideX : -sideX;   // near = ball's side
    else if (/far.?post/.test(name)) x = bp.x >= 0 ? -sideX : sideX;
    return new THREE.Vector3(x, y, g.z);
  }

  // Projectile solve: given ball P and goal-plane target T, pick a launch velocity
  // whose arc passes through T's height at the goal line. A small drag fudge keeps
  // "top corner" actually reaching the top despite the ball's air drag.
  solveShot(P, T, powerWord, spin = 0) {
    const dx = T.x - P.x;
    const dz = this.goal.z - P.z;
    const D = Math.max(0.6, Math.hypot(dx, dz));
    let vh = SHOT_SPEED[powerWord] ?? SHOT_SPEED.drive;
    const vyCap = T.y < 1.2 ? 3.2 : 10.5; // low shots stay driven & flat; high shots arc just over the keeper
    let t = D / vh;
    let vy = (T.y - P.y + 0.5 * BALL_GRAVITY * t * t) / t;
    // A low target shouldn't lob — drive the ball faster until the arc flattens out.
    let guard = 0;
    while (vy > vyCap && vh < 32 && guard++ < 16) { vh += 5; t = D / vh; vy = (T.y - P.y + 0.5 * BALL_GRAVITY * t * t) / t; }
    vy = THREE.MathUtils.clamp(vy * 1.05, 0, 16);   // small drag fudge so it still reaches height
    let dirX = dx / D;
    let dirZ = dz / D;
    if (spin) {                          // curl: start a touch wider so Magnus bends it back to target
      const bias = -spin * 0.5;          // spin sign already encodes left/right
      const c = Math.cos(bias), s = Math.sin(bias);
      const rx = dirX * c - dirZ * s;
      const rz = dirX * s + dirZ * c;
      dirX = rx; dirZ = rz;
    }
    return new THREE.Vector3(dirX * vh, vy, dirZ * vh);
  }

  showAimMarker(t) {
    if (!this.aimMarker) return;
    this.aimMarker.position.set(t.x, t.y, this.goal.z - 0.08);
    this._aimFade = 1.4;
  }

  updateAimMarker(dt) {
    if (!this.aimMarker || this._aimFade <= 0) return;
    this._aimFade = Math.max(0, this._aimFade - dt);
    this.aimMarker.material.opacity = Math.min(0.9, this._aimFade);
    this.aimMarker.scale.setScalar(1 + (1.4 - this._aimFade) * 0.6);
  }

  startJuggle() {
    this.throttle = 0; this.steer = 0;
    this.moveGoal = null; this.turnGoal = null;
    this.pose = 'juggle'; this.poseTimer = 6;
    this.robot.pose = 'juggle';
    this.juggleStreak = 0;

    // Pop the ball up over the robot's feet to begin the rally.
    const rp = this.robot.mesh.position;
    this.ball.position.set(rp.x, 1.1, rp.z + 0.2);
    this.ball.vel.set(0, 3.6, 0);
    this.ball.spin = 0;
    this.ball.grounded = false;
  }

  // Shield: stop, turn your body between the defender and the ball, and pull it in
  // tight (the close-control offset shrinks while _shieldTimer is up).
  startShield() {
    this._shieldTimer = 1.8;
    this.throttle = 0; this.moveGoal = null; this.turnGoal = null;
    this.pose = 'none'; this.robot.pose = 'none';
    if (this.defender) {
      const dp = this.defender.mesh.position;
      const rp = this.robot.mesh.position;
      this.heading = Math.atan2(rp.x - dp.x, rp.z - dp.z); // face away from the defender
      this.robot.mesh.rotation.y = this.heading;
    }
    this.sound.playTouch();
  }

  // Knock-on: shove the ball ahead along the heading and sprint after it — the way
  // you beat a defender by pushing it past and running on. Re-collect when you catch up.
  startKnock(a) {
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.ball.kick(new THREE.Vector3(dir.x * 9, 0, dir.z * 9), 0);
    this.releasePossession('loose');
    this._collectCooldown = 0.25;      // it's your touch — collect again soon
    this.pose = 'none'; this.robot.pose = 'none';
    this.running = true;
    const steps = a.steps || 5;
    this.moveGoal = { dir: 1, remaining: steps * STEP_SIZE };
    this.throttle = 1;
    this.sound.playKick(0.4);
    return true; // blocking until the chase completes
  }

  // Called when the active blocking action completes; advance the queue.
  finishActive() {
    this.active = null;
    this.emitQueue();
    this.pump();
  }

  labelFor(a) {
    switch (a.type) {
      case 'move': return `${a.dir === 'backward' ? 'BACK' : 'FWD'}${a.steps && a.steps < 100 ? ' ' + a.steps : ''}`;
      case 'turn': return `TURN ${(a.dir || '').toUpperCase()}`;
      case 'speed': return a.level.toUpperCase();
      case 'jump': return 'JUMP';
      case 'wave': return 'WAVE';
      case 'dance': return 'DANCE';
      case 'reset': return 'RECENTER';
      case 'kick': {
        if (a.target) {
          const arrows = { 'top-left': '↖', 'top-right': '↗', 'top-center': '↑', 'bottom-left': '↙', 'bottom-right': '↘', 'low': '↓', 'near-post': 'NEAR', 'far-post': 'FAR' };
          return `SHOOT ${arrows[a.target] || a.target.toUpperCase()}${a.curve ? '↻' : ''}`;
        }
        const p = a.power === 'blast' ? 'BLAST' : a.power === 'pass' ? 'PASS' : a.power === 'tap' ? 'TAP' : 'KICK';
        return a.loft === 'chip' ? 'CHIP' : a.curve ? `${p}↻` : p;
      }
      case 'dribble': return `DRIBBLE${a.dir === 'backward' ? ' BACK' : ''}`;
      case 'juggle': return 'JUGGLE';
      case 'trap': return 'TRAP';
      case 'shield': return 'SHIELD';
      case 'knock': return 'KNOCK ON';
      case 'win': return 'WIN BALL';
      default: return a.type.toUpperCase();
    }
  }

  emitQueue() {
    if (!this.ui.onQueueChange) return;
    const items = [];
    if (this.active) items.push({ label: this.labelFor(this.active), status: 'active' });
    for (const a of this.queue) items.push({ label: this.labelFor(a), status: 'pending' });
    this.ui.onQueueChange(items);
  }

  startPose(pose, duration) {
    this.pose = pose;
    this.poseTimer = duration;
    this.robot.pose = pose;
    this.throttle = 0;
    this.steer = 0;
    this.moveGoal = null;
    this.turnGoal = null;
  }

  startReset() {
    this.throttle = 0; this.steer = 0;
    this.moveGoal = null; this.turnGoal = null;
    this.pose = 'none'; this.robot.pose = 'none';
    this._pendingKick = null;
    this.juggleStreak = 0;
    this.ball.reset(); // give the ball a clean slate too
    this.releasePossession('loose');
    this.resetTween = {
      t: 0, dur: 1.2,
      fromPos: this.robot.mesh.position.clone(),
      fromHeading: this.heading,
    };
  }

  halt() {
    this.throttle = 0;
    this.steer = 0;
    this.moveGoal = null;
    this.turnGoal = null;
    this.queue = [];
    this.active = null;
    this.pose = 'none';
    this.robot.pose = 'none';
    this.poseTimer = 0;
    this.resetTween = null;
    this._pendingKick = null; // cancel any kick caught mid wind-up
    this.emitQueue();
  }

  startJump() {
    if (this.airborne || this.resetTween) return;
    this.vy = JUMP_VELOCITY;
    this.airborne = true;
    this.robot.pose = 'none';
    this.pose = 'none';
    this.sound.playJump();
  }

  // Keyboard Space: a one-off hop that doesn't disturb the command queue.
  doJump() { this.startJump(); }

  // -------- analog input from keyboard (overrides any queued voice action) ---
  setThrottle(v) {
    if (v !== 0) {
      this.pose = 'none'; this.robot.pose = 'none';
      this.moveGoal = null; this.resetTween = null;
      this._pendingKick = null;
      this.queue = []; this.active = null; this.emitQueue();
    }
    this.throttle = v;
  }

  setSteer(v) {
    if (v !== 0) {
      this.turnGoal = null;
      this.queue = []; this.active = null; this.emitQueue();
    }
    this.steer = v;
  }

  setRunning(on) { this.running = on; }

  // ------------------------------------------------------------- main loop ---
  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.resetTween) this.updateReset(dt);
    else this.updateLocomotion(dt);

    this.updateJump(dt);

    // --- football ---
    this.updateBall(dt);          // free physics, or close-control carry if in possession
    if (this.pose === 'juggle') this.updateJuggle(dt);
    this.updatePossession(dt);    // collect / release transitions + possession ring
    this.updatePendingKick(dt);
    this.updateOpponents(dt);     // keeper (and defender) AI
    this.updateGoal(dt);
    this.updateAimMarker(dt);

    const footfall = this.robot.update(dt, {
      speed: this.speed,
      turnRate: this.turnRate,
      maxSpeed: RUN_SPEED * this.speedScale,
      airborne: this.airborne,
    });
    if (footfall && !this.airborne) this.sound.playStep();

    this.updatePoseTimer(dt);
    this.updateContact();
    this.updateMotes(dt);
    this.updateCamera(dt);
    this.reportTelemetry();

    if (this.cameraMode === 'orbit') {
      this.controls.target.lerp(this.robot.mesh.position, 0.2);
      this.controls.update();
    }
    this.composer.render();
  }

  updateLocomotion(dt) {
    const maxSpeed = (this.running ? RUN_SPEED : WALK_SPEED) * this.speedScale;

    // --- forward/back ---
    let targetSpeed = this.throttle * maxSpeed;
    if (this.moveGoal) {
      // ease down as we approach the target distance for a clean stop
      const ease = THREE.MathUtils.clamp(this.moveGoal.remaining / 1.4, 0.18, 1);
      targetSpeed = this.moveGoal.dir * maxSpeed * ease;
    }
    const sRate = (Math.abs(targetSpeed) > Math.abs(this.speed) ? ACCEL : DECEL) * dt;
    this.speed = THREE.MathUtils.clamp(targetSpeed, this.speed - sRate, this.speed + sRate);
    if (Math.abs(this.speed) < 0.01) this.speed = 0;

    // --- turning ---
    let targetTurn = this.steer * TURN_RATE;
    if (this.turnGoal) {
      const ease = THREE.MathUtils.clamp(this.turnGoal.remaining / 0.5, 0.18, 1);
      targetTurn = this.turnGoal.dir * TURN_RATE * ease;
    }
    const tRate = TURN_ACCEL * dt;
    this.turnRate = THREE.MathUtils.clamp(targetTurn, this.turnRate - tRate, this.turnRate + tRate);
    if (!this.turnGoal && this.steer === 0 && Math.abs(this.turnRate) < 0.02) this.turnRate = 0;

    // integrate heading + position
    this.heading += this.turnRate * dt;
    const fwd = this._tmp.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const pos = this.robot.mesh.position;
    pos.addScaledVector(fwd, this.speed * dt);
    this.robot.mesh.rotation.y = this.heading;

    // soft circular wall — abandon the current move and advance the queue
    const r = Math.hypot(pos.x, pos.z);
    if (r > ARENA_RADIUS - 0.8) {
      const k = (ARENA_RADIUS - 0.8) / r;
      pos.x *= k; pos.z *= k;
      this.speed *= 0.4;
      this.moveGoal = null;
      this.throttle = 0;
      if (this.isMoveActive()) this.finishActive();
    }

    // consume precise goals
    if (this.moveGoal) {
      this.moveGoal.remaining -= Math.abs(this.speed) * dt;
      if (this.moveGoal.remaining <= 0.02) {
        this.moveGoal = null;
        this.throttle = 0;
        if (this.isMoveActive()) this.finishActive();
      }
    }
    if (this.turnGoal) {
      this.turnGoal.remaining -= Math.abs(this.turnRate) * dt;
      if (this.turnGoal.remaining <= 0.01) {
        this.turnGoal = null;
        if (this.active && this.active.type === 'turn') this.finishActive();
      }
    }
  }

  updateReset(dt) {
    const rt = this.resetTween;
    rt.t += dt;
    const k = THREE.MathUtils.clamp(rt.t / rt.dur, 0, 1);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    this.robot.mesh.position.lerpVectors(rt.fromPos, new THREE.Vector3(0, this.robot.defaultHeight, 0), e);
    this.heading = THREE.MathUtils.lerp(rt.fromHeading, 0, e);
    this.robot.mesh.rotation.y = this.heading;
    this.speed = 0; this.turnRate = 0;
    if (k >= 1) {
      this.resetTween = null;
      this.robot.mesh.position.set(0, this.robot.defaultHeight, 0);
      if (this.active && this.active.type === 'reset') this.finishActive();
    }
  }

  updateJump(dt) {
    if (!this.airborne) {
      if (this.landSquash > 0) {
        this.landSquash = Math.max(0, this.landSquash - dt * 6);
        this.robot.setJumpBend(this.landSquash * 0.6);
      }
      return;
    }
    this.vy -= GRAVITY * dt;
    const pos = this.robot.mesh.position;
    pos.y += this.vy * dt;
    if (pos.y <= this.robot.defaultHeight) {
      pos.y = this.robot.defaultHeight;
      this.vy = 0;
      this.airborne = false;
      this.landSquash = 1;
      this.sound.playLand();
      if (this.active && this.active.type === 'jump') this.finishActive();
    }
  }

  isMoveActive() {
    return this.active && (this.active.type === 'move' || this.active.type === 'dribble' || this.active.type === 'knock');
  }

  updatePoseTimer(dt) {
    if (this.pose === 'none') return;
    this.poseTimer -= dt;
    if (this.poseTimer <= 0) {
      this.pose = 'none';
      this.robot.pose = 'none';
      // Safety: if a kick is ending and the impulse never fired, fire it now.
      if (this._pendingKick) this.releaseKick();
      if (this.active && ['wave', 'dance', 'kick', 'juggle'].includes(this.active.type)) this.finishActive();
    }
  }

  // Hold the ball aloft and bounce it foot-to-foot, ticking the streak counter.
  updateJuggle(dt) {
    const rp = this.robot.mesh.position;
    const bp = this.ball.position;
    // Glide the ball back over the feet and bleed off horizontal drift.
    bp.x += (rp.x - bp.x) * Math.min(1, dt * 4);
    bp.z += (rp.z + 0.2 - bp.z) * Math.min(1, dt * 4);
    this.ball.vel.x *= 0.6;
    this.ball.vel.z *= 0.6;

    // Apply gravity and integrate vertical position
    this.ball.vel.y -= 24 * dt;
    bp.y += this.ball.vel.y * dt;
    this.ball._updateVisual(dt);

    // Catch it around knee height and pop it back up.
    if (bp.y <= 1.0 && this.ball.vel.y <= 0) {
      this.ball.vel.y = 3.9;
      this.ball.grounded = false;
      this.juggleStreak += 1;
      this.sound.playBounce(0.45);
    }
  }

  // Ball advance: while the robot is on the ball, close control glues it to the
  // feet (so every move keeps it); otherwise it's free physics. Juggle owns the
  // ball itself, so defer to it that frame.
  updateBall(dt) {
    if (this.pose === 'juggle') return;
    if (this.possession === 'robot') this.carryBall(dt);
    else this.ball.update(dt);
  }

  // Close control: park the ball a little ahead of the feet along the heading.
  // The offset stretches with speed — a tight touch at a walk, knocked further
  // ahead at a run (faster, but easier for a defender to nick). Turning sweeps
  // the control point around, so the ball follows through any move or pivot.
  carryBall(dt) {
    const speed01 = Math.min(1, Math.abs(this.speed) / RUN_SPEED);
    let dist = THREE.MathUtils.lerp(CONTROL_NEAR, CONTROL_FAR, speed01);
    let ang = this.heading;
    if (this.speed < -0.1) ang += Math.PI;          // reversing → keep it on the trailing foot
    if (this._shieldTimer > 0) dist = 0.45;          // shielding pulls it in tight to the body
    const p = this.robot.mesh.position;
    this._carryPoint = this._carryPoint || new THREE.Vector3();
    this._carryPoint.set(p.x + Math.sin(ang) * dist, this.ball.radius, p.z + Math.cos(ang) * dist);
    this.ball.carryTo(this._carryPoint, dt, CONTROL_STIFFNESS);
  }

  // Possession transitions: collect a loose ball at the feet (first touch), keep
  // HUD ballState current, and drive the possession ring.
  updatePossession(dt) {
    if (this._collectCooldown > 0) this._collectCooldown -= dt;
    if (this._shieldTimer > 0) this._shieldTimer -= dt;

    if (this.possession === null && this.pose !== 'juggle' && this._collectCooldown <= 0 && !this.airborne) {
      const p = this.robot.mesh.position;
      const b = this.ball.position;
      if (Math.hypot(b.x - p.x, b.z - p.z) < CONTROL_RADIUS && this.ball.horizontalSpeed < CONTROL_SPEED) {
        this.possession = 'robot';
        this.ballState = 'controlled';
        this.sound.playTouch();
      }
    }

    // HUD ball-state: controlled when owned; 'shot'/'saved' persist while the ball
    // is travelling fast; otherwise it has settled to a loose ball.
    if (this.possession === 'robot') this.ballState = 'controlled';
    else if (this.ball.horizontalSpeed < 1.5 && this.ballState !== 'controlled') this.ballState = 'loose';

    this.updatePossRing(dt);
  }

  // Robot loses the ball — to a strike (released), a tackle, or a reset.
  releasePossession(state = 'loose') {
    this.possession = null;
    this.ballState = state;
    this._collectCooldown = 0.45; // don't re-collect the ball we just struck
  }

  updatePossRing(dt) {
    if (!this.possRing) return;
    const show = this.possession === 'robot';
    const pressured = show && this._defenderNear;       // set by the defender AI (Phase D)
    const targetOpacity = show ? (pressured ? 0.6 : 0.4) : 0;
    const m = this.possRing.material;
    m.opacity += (targetOpacity - m.opacity) * Math.min(1, dt * 8);
    m.color.setHex(pressured ? 0xffb300 : 0x00e676);
    const p = this.robot.mesh.position;
    this.possRing.position.set(p.x, 0.03, p.z);
    if (pressured) {                                     // urgent pulse when about to be tackled
      const s = 1 + Math.sin(this.clock.elapsedTime * 18) * 0.06;
      this.possRing.scale.setScalar(s);
    } else {
      this.possRing.scale.setScalar(1);
    }
  }

  releaseKick() {
    if (!this._pendingKick) return;
    this.ball.kick(this._pendingKick.impulse, this._pendingKick.spin);
    this.sound.playKick(this._pendingKick.power);
    this.releasePossession(this._pendingKick.shot ? 'shot' : 'loose');
    this._pendingKick = null;
  }

  updatePendingKick(dt) {
    if (!this._pendingKick) return;
    this._pendingKick.t -= dt;
    if (this._pendingKick.t <= 0) this.releaseKick();
  }

  updateGoal(dt) {
    if (!this.goal) return;
    const b = this.ball.position;
    const prevZ = this._ballPrevZ;
    this._ballPrevZ = b.z;
    const movingIn = this.ball.vel.z > 0.5;

    // Keeper save: the ball crosses his line within his reach → parry it clear.
    const kz = this.keeper ? this.keeper.homeZ : this.goal.z - 0.6;
    if (this.keeper && movingIn && this.ballState !== 'saved' && prevZ <= kz && b.z >= kz) {
      const k = this.keeper.reachPoint;
      if (Math.hypot(b.x - k.x, b.y - k.y) < this.keeper.CATCH) {
        this.ball.parry(this._tmp.set(THREE.MathUtils.randFloatSpread(0.8), 0, -1).normalize());
        this.ballState = 'saved';
        this.score.saves++;
        this.sound.playSave();
        this.keeper.onSave();
        this.flash('SAVED!');
      }
    }

    if (this._kickoffTimer > 0) {
      this._kickoffTimer -= dt;
      if (this._kickoffTimer <= 0) this.kickoff();
    }

    // Goal: the ball crosses the line, inside the posts and under the bar.
    if (movingIn && !this.goal.scored && prevZ <= this.goal.z && b.z >= this.goal.z
        && Math.abs(b.x) < this.goal.w / 2 && b.y < this.goal.h) {
      this.onGoalScored();
    } else if (b.z < this.goal.z - 3 && this.goal.scored) {
      this.goal.scored = false; // re-arm once the ball is well clear (no kickoff case)
    }

    if (this.goal.ripple > 0) {
      this.goal.ripple = Math.max(0, this.goal.ripple - dt);
      this.goalNet.position.z = this.goal.z + 1.3 + Math.sin(this.clock.elapsedTime * 28) * this.goal.ripple * 0.18;
    }
  }

  onGoalScored() {
    this.goal.scored = true;
    this.goal.ripple = 0.6;
    this.ballState = 'goal';
    this.score.goals++;
    this.sound.playNet();
    this.flash('GOAL!');
    this._kickoffTimer = 2.2;   // celebrate, then re-centre for kickoff
  }

  flash(text) { this._flash = { text, t: 1.6 }; }

  // Reset to a kickoff: robot on the ball at centre, opponents back to their posts.
  kickoff() {
    this.halt();
    this.robot.mesh.position.set(0, this.robot.defaultHeight, 0);
    this.heading = 0; this.robot.mesh.rotation.y = 0;
    this.speed = 0; this.turnRate = 0;
    this.ball.reset(0, 0.9);          // just ahead of the robot
    this.possession = 'robot'; this.ballState = 'controlled'; this._collectCooldown = 0;
    this.goal.scored = false;
    this.keeper.reset();
    this.defender.reset(0);
    this.snapCamera();
  }

  updateContact() {
    const p = this.robot.mesh.position;
    this.contact.position.set(p.x, 0.02, p.z);
    const pulse = 1 + Math.min(1, Math.abs(this.speed) / RUN_SPEED) * 0.4;
    this.contact.scale.setScalar(pulse);
    this.contact.material.opacity = this.airborne ? 0.12 : 0.35;
  }

  updateMotes(dt) {
    this.motes.rotation.y += dt * 0.02;
    this.motes.position.y = Math.sin(this.clock.elapsedTime * 0.2) * 0.3;
  }

  updateCamera(dt) {
    if (this.cameraMode !== 'follow') return;
    const p = this.robot.mesh.position;
    const fwd = this._tmp.set(Math.sin(this.heading), 0, Math.cos(this.heading));

    // desired position: behind + above, nudged out a touch at speed
    const back = 7.5 + Math.abs(this.speed) * 0.12;
    const desired = new THREE.Vector3(
      p.x - fwd.x * back,
      p.y + 3.0,
      p.z - fwd.z * back
    );
    const k = 1 - Math.exp(-4.5 * dt); // frame-rate independent smoothing
    this.camera.position.lerp(desired, k);

    // look slightly ahead of the robot
    const look = new THREE.Vector3(
      p.x + fwd.x * (1.5 + Math.abs(this.speed) * 0.2),
      p.y + 0.6,
      p.z + fwd.z * (1.5 + Math.abs(this.speed) * 0.2)
    );
    this._camLook.lerp(look, 1 - Math.exp(-6 * dt));
    this.camera.lookAt(this._camLook);

    // subtle speed FOV
    const targetFov = this.baseFov + Math.min(1, Math.abs(this.speed) / RUN_SPEED) * 7;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-3 * dt));
    this.camera.updateProjectionMatrix();
  }

  snapCamera() {
    const p = this.robot.mesh.position;
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.camera.position.set(p.x - fwd.x * 7.5, p.y + 3, p.z - fwd.z * 7.5);
    this._camLook.copy(p).add(new THREE.Vector3(fwd.x * 1.5, 0.6, fwd.z * 1.5));
    this.camera.lookAt(this._camLook);
  }

  setCameraMode(mode) {
    this.cameraMode = mode;
    if (mode === 'orbit') {
      this.controls.enabled = true;
      this.controls.target.copy(this.robot.mesh.position);
    } else {
      this.controls.enabled = false;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      this.snapCamera();
    }
  }

  reportTelemetry() {
    let action = 'IDLE';
    if (this.resetTween) action = 'RETURNING';
    else if (this.pose === 'dance') action = 'DANCING';
    else if (this.pose === 'wave') action = 'WAVING';
    else if (this.pose === 'kick') action = 'KICKING';
    else if (this.pose === 'juggle') action = 'JUGGLING';
    else if (this.airborne) action = 'JUMPING';
    else if (this.active?.type === 'dribble' && Math.abs(this.speed) > 0.1) action = 'DRIBBLING';
    else if (this.turnGoal || (this.steer !== 0 && Math.abs(this.speed) < 0.2)) {
      action = `TURNING ${(this.turnGoal?.dir ?? this.steer) > 0 ? 'LEFT' : 'RIGHT'}`;
    } else if (Math.abs(this.speed) > 0.1) {
      const verb = this.running || this.speed > WALK_SPEED + 0.5 ? 'RUNNING' : 'WALKING';
      action = `${verb} ${this.speed < 0 ? 'BACK' : 'FWD'}`;
    }
    this.actionLabel = action;

    if (this._flash && (this._flash.t -= 0.016) <= 0) this._flash = null;

    if (this.ui.onTelemetry) {
      this.ui.onTelemetry({
        speed01: Math.min(1, Math.abs(this.speed) / RUN_SPEED),
        action,
        running: this.running,
        juggleStreak: this.juggleStreak,
        possession: this.possession,
        ballState: this.ballState,
        score: this.score,
        flash: this._flash ? this._flash.text : null,
      });
    }
  }

  onResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }
}
