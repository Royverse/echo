// Core game engine for ECHO: fixed-timestep physics, continuous intercept steering,
// Standing Orders, multi-agent 2v2 street football, procedural camera, and juice.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';
import { Time } from '../core/Time.js';
import { RNG } from '../core/RNG.js';

import { Robot } from './Robot.js';
import { Ball } from './Ball.js';
import { Goalkeeper } from './Goalkeeper.js';
import { Defender } from './Defender.js';
import { Teammate } from './Teammate.js';
import { OrderManager } from '../orders/OrderManager.js';
import { Steering } from '../orders/Steering.js';
import { JuiceManager } from './JuiceManager.js';
import { FlowManager } from './FlowManager.js';

const ARENA_RADIUS = Config.ARENA.RADIUS;
const WALK_SPEED = Config.ROBOT.WALK_SPEED;
const RUN_SPEED = Config.ROBOT.RUN_SPEED;
const ACCEL = Config.ROBOT.ACCEL;
const DECEL = Config.ROBOT.BRAKE;
const TURN_RATE = Config.ROBOT.TURN_RATE;
const TURN_ACCEL = Config.ROBOT.TURN_ACCEL;
const STEP_SIZE = Config.ROBOT.STEP_SIZE;
const DEFAULT_MOVE_STEPS = Config.ROBOT.DEFAULT_MOVE_STEPS;
const GRAVITY = Config.PHYSICS.GRAVITY;
const JUMP_VELOCITY = Config.PHYSICS.JUMP_VELOCITY;

const KICK_POWER = Config.ROBOT.KICK_POWER;
const KICK_LOFT = Config.ROBOT.KICK_LOFT;
const SHOT_SPEED = Config.ROBOT.SHOT_SPEED;
const BALL_GRAVITY = Config.PHYSICS.GRAVITY;
const KICK_SPIN = Config.ROBOT.KICK_SPIN;
const AIM_OFFSET = Config.ROBOT.AIM_OFFSET;

const CONTROL_RADIUS = Config.ROBOT.CONTROL_RADIUS;
const CONTROL_SPEED = Config.ROBOT.CONTROL_SPEED;
const CONTROL_NEAR = Config.ROBOT.CONTROL_NEAR;
const CONTROL_FAR = Config.ROBOT.CONTROL_FAR;
const CONTROL_STIFFNESS = Config.ROBOT.CONTROL_STIFFNESS;

export class GameEngine {
  constructor(container, soundManager, ui = {}) {
    this.container = container;
    this.sound = soundManager;
    this.ui = ui;
    this.clock = new THREE.Clock();

    this.cameraMode = 'follow';

    // Locomotion state
    this.heading = 0;
    this.speed = 0;
    this.turnRate = 0;
    this.throttle = 0;
    this.steer = 0;
    this.running = false;
    this.speedScale = 1;

    this.moveGoal = null;
    this.turnGoal = null;
    this.queue = [];
    this.active = null;
    this._aid = 0;

    this.vy = 0;
    this.airborne = false;
    this.landSquash = 0;

    this.pose = 'none';
    this.poseTimer = 0;
    this.resetTween = null;

    // Football state
    this.juggleStreak = 0;
    this._pendingKick = null;
    this.possession = null;
    this.ballState = 'loose';
    this._shieldTimer = 0;
    this._collectCooldown = 0;
    this.score = { goals: 0, saves: 0, opponentGoals: 0 };
    this._ballPrevZ = 5;
    this._kickoffTimer = 0;
    this._flash = null;

    this.actionLabel = 'IDLE';

    // Systems
    this.orderManager = new OrderManager();
    this.flowManager = new FlowManager();

    // Smoothed camera aim
    this._camLook = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._interceptPoint = new THREE.Vector3();

    this.initThree();
    this.buildEnvironment();
    this.spawnEntities();
    this.juice = new JuiceManager(this.scene, this.camera);
    this.animate();
  }

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

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(ARENA_RADIUS, 0.12, 12, 120),
      new THREE.MeshStandardMaterial({ color: 0x5c6d84 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.12;
    this.scene.add(ring);

    this.contact = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.95, 40),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.y = 0.02;
    this.scene.add(this.contact);

    // Possession ring with dynamic Order coloration
    this.possRing = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.25, 44),
      new THREE.MeshBasicMaterial({ color: 0x00e676, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.possRing.rotation.x = -Math.PI / 2;
    this.possRing.position.y = 0.03;
    this.scene.add(this.possRing);

    // Pillars
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

    this.buildGoals();

    // Motes
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

  buildGoals() {
    const z = Config.GOAL.Z;
    const w = Config.GOAL.W;
    const h = Config.GOAL.H;
    this.goal = { z, w, h, scored: false, ripple: 0 };

    const postMat = new THREE.MeshStandardMaterial({
      color: 0xf4f7ff, roughness: 0.4, metalness: 0.3, emissive: 0x1a2740, emissiveIntensity: 0.4,
    });
    const post = new THREE.CylinderGeometry(0.1, 0.1, h, 12);

    // North Goal (+Z, attack)
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

    const netMat = new THREE.MeshBasicMaterial({
      color: 0x9fb4d4, transparent: true, opacity: 0.16, side: THREE.DoubleSide, wireframe: true,
    });
    this.goalNet = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 14, 7), netMat);
    this.goalNet.position.set(0, h / 2, z + 1.3);
    this.scene.add(this.goalNet);

    // South Goal (-Z, defend)
    const southZ = -z;
    this.defendGoal = { z: southZ, w, h };
    const sLeft = new THREE.Mesh(post, postMat);
    sLeft.position.set(-w / 2, h / 2, southZ);
    this.scene.add(sLeft);
    const sRight = sLeft.clone();
    sRight.position.x = w / 2;
    this.scene.add(sRight);
    const sBar = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, w + 0.2, 12), postMat);
    sBar.rotation.z = Math.PI / 2;
    sBar.position.set(0, h, southZ);
    this.scene.add(sBar);

    // Aim marker
    this.aimMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.34, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0, side: THREE.DoubleSide })
    );
    this.aimMarker.position.set(0, h / 2, z - 0.08);
    this.aimMarker.renderOrder = 3;
    this.scene.add(this.aimMarker);
    this._aimFade = 0;
  }

  spawnEntities() {
    this.robot = new Robot();
    this.scene.add(this.robot.mesh);

    this.ball = new Ball(ARENA_RADIUS);
    this.scene.add(this.ball.mesh);

    this.keeper = new Goalkeeper(this.goal, 2);
    this.scene.add(this.keeper.mesh);

    this.defender = new Defender(this.goal, false);
    this.scene.add(this.defender.mesh);

    this.defender2 = new Defender(this.goal, true);
    this.scene.add(this.defender2.mesh);

    this.teammate = new Teammate('Nova', 0xffab00);
    this.scene.add(this.teammate.mesh);

    this.snapCamera();
  }

  // ------------------------------------------------------------- commands ----
  runIntents(intents) {
    if (!intents || !intents.length) return;
    if (intents.some((i) => i.type === 'stop')) {
      this.halt();
      return;
    }

    // Check Late-Aim Amendment during pending kick
    if (this._pendingKick && this._pendingKick.t > 0.15) {
      for (const i of intents) {
        if (i.type === 'kick' || i.target || i.aim || i.curve || i.power) {
          this.applyLateAim(i);
          return;
        }
      }
    }

    for (const intent of intents) {
      this.flowManager.recordIntent(intent);

      // Handle Standing Orders directly
      if (intent.type === 'order') {
        this.orderManager.setOrder(intent);
        this.sound.playEarcon('order');
        continue;
      }

      // Handle Squad Captain intents (Phase 3)
      if (intent.type === 'squad') {
        this.handleSquadIntent(intent);
        continue;
      }

      this.queue.push({ ...intent, _id: ++this._aid });
    }
    this.emitQueue();
    this.pump();
  }

  applyLateAim(a) {
    if (!this._pendingKick) return;
    if (a.curve) {
      this._pendingKick.spin = a.curve === 'left' ? KICK_SPIN : -KICK_SPIN;
    }
    if (a.target) {
      const bp = this.ball.position;
      const target = this.resolveTarget(a.target, bp);
      this._pendingKick.impulse = this.solveShot(bp, target, a.power || 'drive', this._pendingKick.spin);
      this.showAimMarker(target);
      this.sound.playEarcon('trick');
    }
  }

  handleSquadIntent(i) {
    if (!this.teammate) return;
    switch (i.verb) {
      case 'overlap':
        this.teammate.setRole('RUN');
        this.sound.playEarcon('order');
        break;
      case 'run':
        this.teammate.setRole('RUN');
        break;
      case 'cross':
        if (this.possession === 'robot') {
          // Play a lofted cross toward teammate
          const tp = this.teammate.mesh.position;
          const bp = this.ball.position;
          const crossImpulse = new THREE.Vector3((tp.x - bp.x) * 1.5, 7.5, (tp.z - bp.z) * 1.5);
          this.ball.kick(crossImpulse, 0.1);
          this.releasePossession('loose');
          this.teammate.setRole('RECEIVING');
        }
        break;
      case 'pass_to':
        if (this.possession === 'robot') {
          const tp = this.teammate.mesh.position;
          const bp = this.ball.position;
          const passDir = new THREE.Vector3(tp.x - bp.x, 0, tp.z - bp.z).normalize();
          this.ball.kick(new THREE.Vector3(passDir.x * 12, 1.0, passDir.z * 12), 0);
          this.releasePossession('loose');
          this.teammate.setRole('RECEIVING');
        }
        break;
      case 'call_ball':
        this.orderManager.setOrder({ type: 'press' });
        break;
      default:
        this.teammate.setRole('SUPPORT');
        break;
    }
  }

  pump() {
    if (this.active) return;
    while (this.queue.length) {
      const a = this.queue.shift();
      if (this.beginAction(a)) {
        this.active = a;
        this.emitQueue();
        return;
      }
    }
    this.active = null;
    this.emitQueue();
  }

  beginAction(a) {
    switch (a.type) {
      case 'move': {
        this.pose = 'none'; this.robot.pose = 'none';
        const diag = {
          'forward-left': [45, 'left'], 'forward-right': [45, 'right'],
          'backward-left': [135, 'left'], 'backward-right': [135, 'right'],
        }[a.dir];
        if (diag) {
          this.queue.unshift({ type: 'move', dir: 'forward', ...(a.steps ? { steps: a.steps } : {}), _id: ++this._aid });
          this.queue.unshift({ type: 'turn', dir: diag[1], degrees: diag[0], _id: ++this._aid });
          return false;
        }

        const dirSign = a.dir === 'backward' ? -1 : 1;
        const steps = a.steps || DEFAULT_MOVE_STEPS;
        this.moveGoal = { dir: dirSign, remaining: steps * STEP_SIZE };
        this.throttle = dirSign;
        this.sound.playEarcon('move');
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

      // ---- Football Mechanics ----
      case 'kick': {
        if (this.approachBall(a, 1.0)) return false;
        this.startKickStrike(a);
        return true;
      }
      case 'dribble': {
        if (this.approachBall(a, 0.8)) return false;
        this.pose = 'none'; this.robot.pose = 'none';
        this.running = false;
        const dir = a.dir === 'backward' ? -1 : 1;
        const steps = a.steps || 4;
        this.moveGoal = { dir, remaining: steps * STEP_SIZE };
        this.throttle = dir;
        return true;
      }
      case 'juggle': this.startJuggle(); return true;
      case 'trap': this.ball.trap(); this.sound.playBounce(0.3); return false;
      case 'shield': this.startShield(); return false;
      case 'knock': return this.startKnock(a);
      case 'win': {
        if (this.possession === 'robot') return false;
        this.running = true;
        if (this.approachBall(a, 0.8)) return false;
        return false;
      }

      // Phase 2 Tricks
      case 'feint': return this.startFeint(a);
      case 'flick': return this.startFlick(a);
      case 'onetwo': return this.startOneTwo(a);
      case 'nutmeg': return this.startNutmeg(a);
      case 'bicycle': return this.startBicycle(a);

      default: return false;
    }
  }

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

    let target = null;
    if (a.target) {
      target = this.resolveTarget(a.target, bp);
    } else if (a.smart) {
      // Smart Defaults: pick corner away from keeper's current position
      const keeperX = this.keeper ? this.keeper.x : 0;
      const smartTarget = keeperX <= 0 ? 'top-right' : 'top-left';
      target = this.resolveTarget(smartTarget, bp);
    }

    let impulse, isShot, legHint;
    if (target) {
      impulse = this.solveShot(bp, target, a.power, spin);
      isShot = true;
      legHint = target.x >= bp.x ? 1 : -1;
      const fh = Math.atan2(target.x - bp.x, this.goal.z - bp.z);
      this.heading = fh; this.robot.mesh.rotation.y = fh;
      this.showAimMarker(target);
    } else {
      const toBall = Math.atan2(bp.x - rp.x, bp.z - rp.z);
      const delta = Math.atan2(Math.sin(toBall - this.heading), Math.cos(toBall - this.heading));
      if (Math.abs(delta) > (2 * Math.PI) / 3) {
        this.heading = toBall;
        this.robot.mesh.rotation.y = this.heading;
      }
      const aimOff = a.aim === 'left' ? -AIM_OFFSET : a.aim === 'right' ? AIM_OFFSET : 0;
      const aimHeading = this.heading + aimOff;
      const speed = KICK_POWER[a.power] ?? KICK_POWER.drive;
      const vy = KICK_LOFT[a.loft] ?? KICK_LOFT.low;
      const hSpeed = a.loft === 'chip' ? speed * 0.55 : speed;
      impulse = new THREE.Vector3(Math.sin(aimHeading) * hSpeed, vy, Math.cos(aimHeading) * hSpeed);
      isShot = a.power === 'blast' || a.power === 'drive';
      legHint = a.aim === 'right' || a.curve === 'right' ? 1 : -1;
    }

    // Momentum inheritance: ball inherits 25% of robot ground velocity
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const robotVel = fwd.multiplyScalar(this.speed);
    impulse.addScaledVector(robotVel, Config.ROBOT.MOMENTUM_INHERITANCE);

    this.robot.startKick(0.7, legHint >= 0 ? 1 : -1);
    const power01 = Math.min(1, Math.hypot(impulse.x, impulse.z) / KICK_POWER.blast);
    this._pendingKick = {
      impulse,
      spin,
      t: this.robot.KICK_CONTACT * 0.7,
      power: power01,
      shot: isShot,
      isKnuckle: a.style === 'knuckle',
    };
    events.emit('shot', { shooter: 'robot', power: a.power || 'drive', target });
  }

  startFeint(a) {
    this.pose = 'feint';
    this.poseTimer = 0.5;
    this.robot.pose = 'feint';
    const lateralDir = a.dir === 'left' ? -1 : 1;
    // 1.2m lateral burst
    const side = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    this.robot.mesh.position.addScaledVector(side, lateralDir * 1.2);

    if (this.defender) {
      const dDist = Math.hypot(this.defender.mesh.position.x - this.robot.mesh.position.x, this.defender.mesh.position.z - this.robot.mesh.position.z);
      if (dDist < 3.0) {
        this.defender.stun(0.9);
        events.emit('feint_beat', { defender: 'def1' });
      }
    }
    this.sound.playEarcon('trick');
    return true;
  }

  startFlick(a) {
    this.pose = 'flick';
    this.poseTimer = 0.6;
    this.robot.pose = 'flick';
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // Rainbow arc: vy = 10.5, vh = 4.6
    this.ball.kick(new THREE.Vector3(fwd.x * 4.6, 10.5, fwd.z * 4.6), 0);
    this.releasePossession('loose');
    this._collectCooldown = 0.85; // bypass lockout right when it lands
    this.sound.playKick(0.7);
    events.emit('flick_success', { apex: 2.3 });
    return true;
  }

  startOneTwo(a) {
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const side = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const dronePos = this.robot.mesh.position.clone().addScaledVector(fwd, 5.5).addScaledVector(side, 3.0);

    // Initial pass to drone
    const passDir = dronePos.clone().sub(this.ball.position).normalize();
    this.ball.kick(new THREE.Vector3(passDir.x * 9.0, 0.5, passDir.z * 9.0), 0);
    this.releasePossession('loose');

    // Robot runs forward into return space
    this.running = true;
    this.throttle = 1.0;
    this.moveGoal = { dir: 1, remaining: 6.0 };

    setTimeout(() => {
      // Wall pass return into robot stride
      const leadPos = this.robot.mesh.position.clone().addScaledVector(fwd, 4.0);
      const retDir = leadPos.clone().sub(this.ball.position).normalize();
      this.ball.kick(new THREE.Vector3(retDir.x * 10.5, 0.5, retDir.z * 10.5), 0);
      this.sound.playTouch();
    }, 450);

    this.sound.playKick(0.5);
    return true;
  }

  startNutmeg(a) {
    if (!this.defender) return false;
    const dp = this.defender.mesh.position;
    const rp = this.robot.mesh.position;
    const toDef = Math.hypot(dp.x - rp.x, dp.z - rp.z);

    if (toDef < 3.2 && toDef > 1.0) {
      // Fire through leg gap
      const fwd = new THREE.Vector3(dp.x - rp.x, 0, dp.z - rp.z).normalize();
      this.ball.kick(new THREE.Vector3(fwd.x * 12.0, 0, fwd.z * 12.0), 0);
      this.releasePossession('loose');
      this.defender.stun(1.1);
      this.running = true;
      this.moveGoal = { dir: 1, remaining: 4.5 };
      this.throttle = 1.0;
      events.emit('nutmeg', { defender: 'def1' });
      this.sound.playKick(0.6);
      return true;
    }
    return false;
  }

  startBicycle(a) {
    const bp = this.ball.position;
    const rp = this.robot.mesh.position;
    const dist = Math.hypot(bp.x - rp.x, bp.z - rp.z);

    if (bp.y >= 1.2 && bp.y <= 2.8 && dist < 2.0) {
      this.startPose('bicycle', 0.85);
      const target = this.resolveTarget('top-right', bp);
      const impulse = this.solveShot(bp, target, 'blast', 0);
      this.ball.kick(impulse, 0);
      this.releasePossession('shot');
      this.sound.playKick(1.0);
      events.emit('shot', { shooter: 'robot', style: 'bicycle' });
      return true;
    }
    return false;
  }

  resolveTarget(name, bp) {
    const g = this.goal;
    const sideX = g.w / 2 - 1.0;
    const topY = g.h - 0.5;
    const lowY = 0.5;
    let x = 0;
    let y = /top|roof|bins|upper|high/.test(name) ? topY : lowY;
    if (/left/.test(name)) x = -sideX;
    else if (/right/.test(name)) x = sideX;
    else if (/near.?post/.test(name)) x = bp.x >= 0 ? sideX : -sideX;
    else if (/far.?post/.test(name)) x = bp.x >= 0 ? -sideX : sideX;
    return new THREE.Vector3(x, y, g.z);
  }

  solveShot(P, T, powerWord, spin = 0) {
    const dx = T.x - P.x;
    const dz = this.goal.z - P.z;
    const D = Math.max(0.6, Math.hypot(dx, dz));
    let vh = SHOT_SPEED[powerWord] ?? SHOT_SPEED.drive;
    const vyCap = T.y < 1.2 ? 3.2 : 10.5;
    let t = D / vh;
    let vy = (T.y - P.y + 0.5 * BALL_GRAVITY * t * t) / t;
    let guard = 0;
    while (vy > vyCap && vh < 32 && guard++ < 16) {
      vh += 5;
      t = D / vh;
      vy = (T.y - P.y + 0.5 * BALL_GRAVITY * t * t) / t;
    }
    vy = THREE.MathUtils.clamp(vy * 1.05, 0, 16);
    let dirX = dx / D;
    let dirZ = dz / D;
    if (spin) {
      const bias = -spin * 0.5;
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

    const rp = this.robot.mesh.position;
    this.ball.position.set(rp.x, 1.1, rp.z + 0.2);
    this.ball.vel.set(0, 3.6, 0);
    this.ball.spinVector.set(0, 0, 0);
    this.ball.grounded = false;
  }

  startShield() {
    this._shieldTimer = 1.8;
    this.throttle = 0; this.moveGoal = null; this.turnGoal = null;
    this.pose = 'none'; this.robot.pose = 'none';
    if (this.defender) {
      const dp = this.defender.mesh.position;
      const rp = this.robot.mesh.position;
      this.heading = Math.atan2(rp.x - dp.x, rp.z - dp.z);
      this.robot.mesh.rotation.y = this.heading;
    }
    this.sound.playTouch();
  }

  startKnock(a) {
    const dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.ball.kick(new THREE.Vector3(dir.x * 9, 0, dir.z * 9), 0);
    this.releasePossession('loose');
    this._collectCooldown = 0.25;
    this.pose = 'none'; this.robot.pose = 'none';
    this.running = true;
    const steps = a.steps || 5;
    this.moveGoal = { dir: 1, remaining: steps * STEP_SIZE };
    this.throttle = 1;
    this.sound.playKick(0.4);
    return true;
  }

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
      case 'feint': return `FEINT ${a.dir.toUpperCase()}`;
      case 'flick': return 'RAINBOW FLICK';
      case 'onetwo': return 'ONE-TWO';
      case 'nutmeg': return 'NUTMEG';
      case 'bicycle': return 'BICYCLE';
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
    this.ball.reset();
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
    this._pendingKick = null;
    this.orderManager.clearOrder('stop');
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

  doJump() { this.startJump(); }

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
    const rawDt = this.clock.getDelta();

    // Fixed-timestep simulation with render interpolation alpha
    const alpha = Time.step(rawDt, (fixedDt) => {
      this.fixedUpdate(fixedDt);
    });

    this.render(alpha, rawDt);
  }

  fixedUpdate(dt) {
    // If no blocking active action and queue empty, run persistent Standing Order
    if (!this.active && !this.queue.length && !this.resetTween) {
      this.orderManager.update(dt, {
        robot: this.robot,
        ball: this.ball,
        defender: this.defender,
        goal: this.goal,
        heading: this.heading,
        possession: this.possession,
        defenderNear: this._defenderNear,
        setThrottle: (t) => { this.throttle = t; },
        setSteer: (s) => { this.steer = s; },
        setRunning: (r) => { this.running = r; },
      });
    }

    if (this.resetTween) this.updateReset(dt);
    else this.updateLocomotion(dt);

    this.updateJump(dt);

    // Football physics
    this.updateBall(dt);
    if (this.pose === 'juggle') this.updateJuggle(dt);
    this.updatePossession(dt);
    this.updatePendingKick(dt);
    this.updateOpponents(dt);
    this.updateTeammate(dt);
    this.updateGoal(dt);

    this.flowManager.update(dt, this.possession === 'robot');
  }

  render(alpha, rawDt) {
    this.updateAimMarker(rawDt);

    const footfall = this.robot.update(rawDt, {
      speed: this.speed,
      turnRate: this.turnRate,
      maxSpeed: RUN_SPEED * this.speedScale,
      airborne: this.airborne,
    });
    if (footfall && !this.airborne) this.sound.playStep();

    this.updatePoseTimer(rawDt);
    this.updateContact();
    this.updateMotes(rawDt);
    this.updateCamera(rawDt);
    this.juice.update(rawDt, this.ball);
    this.reportTelemetry();

    if (this.cameraMode === 'orbit') {
      this.controls.target.lerp(this.robot.mesh.position, 0.2);
      this.controls.update();
    }
    this.composer.render();
  }

  updateLocomotion(dt) {
    const maxSpeed = (this.running ? RUN_SPEED : WALK_SPEED) * this.speedScale;

    let targetSpeed = this.throttle * maxSpeed;
    if (this.moveGoal) {
      const ease = THREE.MathUtils.clamp(this.moveGoal.remaining / 1.4, 0.18, 1);
      targetSpeed = this.moveGoal.dir * maxSpeed * ease;
    }
    const sRate = (Math.abs(targetSpeed) > Math.abs(this.speed) ? ACCEL : DECEL) * dt;
    this.speed = THREE.MathUtils.clamp(targetSpeed, this.speed - sRate, this.speed + sRate);
    if (Math.abs(this.speed) < 0.01) this.speed = 0;

    let targetTurn = this.steer * TURN_RATE;
    if (this.turnGoal) {
      const ease = THREE.MathUtils.clamp(this.turnGoal.remaining / 0.5, 0.18, 1);
      targetTurn = this.turnGoal.dir * TURN_RATE * ease;
    }
    const tRate = TURN_ACCEL * dt;
    this.turnRate = THREE.MathUtils.clamp(targetTurn, this.turnRate - tRate, this.turnRate + tRate);
    if (!this.turnGoal && this.steer === 0 && Math.abs(this.turnRate) < 0.02) this.turnRate = 0;

    this.heading += this.turnRate * dt;
    const fwd = this._tmp.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    const pos = this.robot.mesh.position;
    pos.addScaledVector(fwd, this.speed * dt);
    this.robot.mesh.rotation.y = this.heading;

    const r = Math.hypot(pos.x, pos.z);
    if (r > ARENA_RADIUS - 0.8) {
      const k = (ARENA_RADIUS - 0.8) / r;
      pos.x *= k; pos.z *= k;
      this.speed *= 0.4;
      this.moveGoal = null;
      this.throttle = 0;
      if (this.isMoveActive()) this.finishActive();
    }

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
    const e = 1 - Math.pow(1 - k, 3);
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
      if (this._pendingKick) this.releaseKick();
      if (this.active && ['wave', 'dance', 'kick', 'juggle', 'feint', 'flick', 'bicycle'].includes(this.active.type)) {
        this.finishActive();
      }
    }
  }

  updateJuggle(dt) {
    const rp = this.robot.mesh.position;
    const bp = this.ball.position;
    bp.x += (rp.x - bp.x) * Math.min(1, dt * 4);
    bp.z += (rp.z + 0.2 - bp.z) * Math.min(1, dt * 4);
    this.ball.vel.x *= 0.6;
    this.ball.vel.z *= 0.6;

    this.ball.vel.y -= 24 * dt;
    bp.y += this.ball.vel.y * dt;
    this.ball._updateVisual(dt);

    if (bp.y <= 1.0 && this.ball.vel.y <= 0) {
      this.ball.vel.y = 3.9;
      this.ball.grounded = false;
      this.juggleStreak += 1;
      this.sound.playJuggle(this.juggleStreak);
      events.emit('streak', { type: 'juggle', count: this.juggleStreak });
    }
  }

  updateBall(dt) {
    if (this.pose === 'juggle') return;
    if (this.possession === 'robot') this.carryBall(dt);
    else this.ball.update(dt);
  }

  carryBall(dt) {
    const speed01 = Math.min(1, Math.abs(this.speed) / RUN_SPEED);
    let dist = THREE.MathUtils.lerp(CONTROL_NEAR, CONTROL_FAR, speed01);
    let ang = this.heading;
    if (this.speed < -0.1) ang += Math.PI;
    if (this._shieldTimer > 0) dist = 0.45;
    const p = this.robot.mesh.position;
    this._carryPoint = this._carryPoint || new THREE.Vector3();
    this._carryPoint.set(p.x + Math.sin(ang) * dist, this.ball.radius, p.z + Math.cos(ang) * dist);
    this.ball.carryTo(this._carryPoint, dt, CONTROL_STIFFNESS);
  }

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
        events.emit('possession_gained', { who: 'robot', method: 'collect' });
      }
    }

    if (this.possession === 'robot') this.ballState = 'controlled';
    else if (this.ball.horizontalSpeed < 1.5 && this.ballState !== 'controlled') this.ballState = 'loose';

    this.updatePossRing(dt);
  }

  releasePossession(state = 'loose') {
    this.possession = null;
    this.ballState = state;
    this._collectCooldown = 0.45;
    events.emit('possession_lost', { who: 'robot', reason: state });
  }

  updatePossRing(dt) {
    if (!this.possRing) return;
    const show = this.possession === 'robot';
    const pressured = show && this._defenderNear;
    const targetOpacity = show ? (pressured ? 0.6 : 0.4) : 0;
    const m = this.possRing.material;
    m.opacity += (targetOpacity - m.opacity) * Math.min(1, dt * 8);

    // Color code to active Standing Order if set, or green/amber
    if (this.orderManager.hasOrder()) {
      m.color.setHex(this.orderManager.currentOrder.color);
    } else {
      m.color.setHex(pressured ? 0xffb300 : 0x00e676);
    }

    const p = this.robot.mesh.position;
    this.possRing.position.set(p.x, 0.03, p.z);
    if (pressured) {
      const s = 1 + Math.sin(this.clock.elapsedTime * 18) * 0.06;
      this.possRing.scale.setScalar(s);
    } else {
      this.possRing.scale.setScalar(1);
    }
  }

  releaseKick() {
    if (!this._pendingKick) return;
    this.ball.kick(this._pendingKick.impulse, this._pendingKick.spin, this._pendingKick.isKnuckle);
    this.sound.playKick(this._pendingKick.power);
    this.releasePossession(this._pendingKick.shot ? 'shot' : 'loose');
    this._pendingKick = null;
  }

  updatePendingKick(dt) {
    if (!this._pendingKick) return;
    this._pendingKick.t -= dt;
    if (this._pendingKick.t <= 0) this.releaseKick();
  }

  updateOpponents(dt) {
    if (this.keeper) this.keeper.update(dt, { ball: this.ball, possession: this.possession });
    if (this.defender) {
      this.defender.update(dt, this._defenderCtx());
      // Check defender cylinder shot block
      if (this.ballState === 'shot' && this.defender.checkShotBlock(this.ball.position)) {
        this.ball.parry(new THREE.Vector3(THREE.MathUtils.randFloatSpread(1), 0, -1).normalize());
        this.sound.playTackle();
        this.flash('BLOCKED!');
      }
    }
    if (this.defender2) {
      this.defender2.update(dt, {
        ball: this.ball,
        possession: this.possession,
        shielding: this._shieldTimer > 0,
        goalZ: this.goal.z,
        setPressure: () => {},
        onTackle: () => this.loseBallToTackle(),
      });
    }
  }

  updateTeammate(dt) {
    if (this.teammate) {
      this.teammate.update(dt, {
        ball: this.ball,
        robot: this.robot,
        goal: this.goal,
      });
    }
  }

  _defenderCtx() {
    return {
      ball: this.ball,
      possession: this.possession,
      shielding: this._shieldTimer > 0,
      goal: this.goal,
      goalZ: this.goal.z,
      setPressure: (v) => { this._defenderNear = v; },
      onTackle: () => this.loseBallToTackle(),
    };
  }

  loseBallToTackle() {
    if (this.possession !== 'robot') return;
    this.releasePossession('loose');
    const away = new THREE.Vector3(THREE.MathUtils.randFloatSpread(6), 0, -7);
    this.ball.kick(away, 0);
    this.sound.playTackle();
    this.moveGoal = null; this.throttle = 0; this.running = false;
    this._collectCooldown = 0.9;
    if (this.active && ['move', 'dribble', 'knock'].includes(this.active.type)) this.finishActive();
  }

  updateGoal(dt) {
    if (!this.goal) return;
    const b = this.ball.position;
    const prevZ = this._ballPrevZ;
    this._ballPrevZ = b.z;
    const movingIn = this.ball.vel.z > 0.5;

    // Woodwork check (crossbar and posts)
    if (Math.abs(b.z - this.goal.z) < 0.35 && movingIn) {
      const nearPost = Math.abs(Math.abs(b.x) - this.goal.w / 2) < 0.25 && b.y < this.goal.h;
      const nearBar = Math.abs(b.y - this.goal.h) < 0.25 && Math.abs(b.x) <= this.goal.w / 2;
      if (nearPost || nearBar) {
        this.sound.playWoodwork();
        events.emit('woodwork', { part: nearBar ? 'bar' : 'post' });
        this.ball.vel.z *= -0.7;
        this.ball.vel.y += 3.0;
        this.flash('WOODWORK!');
      }
    }

    // Keeper save
    const kz = this.keeper ? this.keeper.z : this.goal.z - 0.6;
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

    // Goal scored
    if (movingIn && !this.goal.scored && prevZ <= this.goal.z && b.z >= this.goal.z
        && Math.abs(b.x) < this.goal.w / 2 && b.y < this.goal.h) {
      this.onGoalScored();
    } else if (b.z < this.goal.z - 3 && this.goal.scored) {
      this.goal.scored = false;
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
    events.emit('goal', { team: 'player', score: this.score });
    this._kickoffTimer = 1.8;
  }

  flash(text) { this._flash = { text, t: 1.6 }; }

  kickoff() {
    this.halt();
    this.robot.mesh.position.set(0, this.robot.defaultHeight, 0);
    this.heading = 0; this.robot.mesh.rotation.y = 0;
    this.speed = 0; this.turnRate = 0;
    this.ball.reset(0, 0.9);
    this.possession = 'robot'; this.ballState = 'controlled'; this._collectCooldown = 0;
    this.goal.scored = false;
    this.keeper.reset();
    this.defender.reset(-2.0);
    if (this.defender2) this.defender2.reset(4.0);
    if (this.teammate) this.teammate.reset(6.0, 0);
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

    const back = 7.5 + Math.abs(this.speed) * 0.12;
    const desired = new THREE.Vector3(
      p.x - fwd.x * back,
      p.y + 3.0,
      p.z - fwd.z * back
    );
    const k = 1 - Math.exp(-4.5 * dt);
    this.camera.position.lerp(desired, k);

    const look = new THREE.Vector3(
      p.x + fwd.x * (1.5 + Math.abs(this.speed) * 0.2),
      p.y + 0.6,
      p.z + fwd.z * (1.5 + Math.abs(this.speed) * 0.2)
    );
    this._camLook.lerp(look, 1 - Math.exp(-6 * dt));
    this.camera.lookAt(this._camLook);

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
    else if (this.pose === 'feint') action = 'FEINTING';
    else if (this.pose === 'flick') action = 'FLICKING';
    else if (this.pose === 'bicycle') action = 'BICYCLE';
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
        order: this.orderManager.currentOrder,
        flowTier: this.flowManager.currentTier,
        flowScore: this.flowManager.flowScore,
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
