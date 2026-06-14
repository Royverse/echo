// Core engine: momentum locomotion, cinematic chase camera, bloom, environment.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RobotCharacter } from './character.js';

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

    // Post-processing: removed bloom to reduce neon aesthetic.
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
    this.robot = new RobotCharacter();
    this.scene.add(this.robot.mesh);
    this.snapCamera();
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
      default: return false;
    }
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
      if (this.active && this.active.type === 'move') this.finishActive();
    }

    // consume precise goals
    if (this.moveGoal) {
      this.moveGoal.remaining -= Math.abs(this.speed) * dt;
      if (this.moveGoal.remaining <= 0.02) {
        this.moveGoal = null;
        this.throttle = 0;
        if (this.active && this.active.type === 'move') this.finishActive();
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

  updatePoseTimer(dt) {
    if (this.pose === 'none') return;
    this.poseTimer -= dt;
    if (this.poseTimer <= 0) {
      this.pose = 'none';
      this.robot.pose = 'none';
      if (this.active && (this.active.type === 'wave' || this.active.type === 'dance')) this.finishActive();
    }
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
    else if (this.airborne) action = 'JUMPING';
    else if (this.turnGoal || (this.steer !== 0 && Math.abs(this.speed) < 0.2)) {
      action = `TURNING ${(this.turnGoal?.dir ?? this.steer) > 0 ? 'LEFT' : 'RIGHT'}`;
    } else if (Math.abs(this.speed) > 0.1) {
      const verb = this.running || this.speed > WALK_SPEED + 0.5 ? 'RUNNING' : 'WALKING';
      action = `${verb} ${this.speed < 0 ? 'BACK' : 'FWD'}`;
    }
    this.actionLabel = action;

    if (this.ui.onTelemetry) {
      this.ui.onTelemetry({
        speed01: Math.min(1, Math.abs(this.speed) / RUN_SPEED),
        action,
        running: this.running,
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
    if (this.bloom) this.bloom.setSize(w, h);
  }
}
