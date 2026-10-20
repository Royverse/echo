// A self-contained arcade football with generalized 3D Magnus physics,
// knuckleball turbulence, squash/stretch dynamics, and contact shadows.
import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';

const RADIUS = Config.PHYSICS.BALL_RADIUS;
const GRAVITY = Config.PHYSICS.GRAVITY;
const RESTITUTION = Config.PHYSICS.BALL_RESTITUTION;
const ROLL_FRICTION = Config.PHYSICS.BALL_ROLL_FRICTION;
const AIR_DRAG = Config.PHYSICS.BALL_AIR_DRAG;
const MAGNUS = Config.PHYSICS.BALL_MAGNUS;
const SPIN_DECAY = Config.PHYSICS.BALL_SPIN_DECAY;
const STOP_SPEED = Config.PHYSICS.BALL_STOP_SPEED;

export class Ball {
  constructor(arenaRadius = Config.ARENA.RADIUS) {
    this.arenaRadius = arenaRadius;
    this.radius = RADIUS;

    this.vel = new THREE.Vector3();
    // 3D spin vector: (spinX = topspin/backspin, spinY = lateral curve, spinZ = tilt)
    this.spinVector = new THREE.Vector3();
    this.isKnuckle = false;
    this.knuckleSeed = 0;
    this.grounded = true;

    // Squash & stretch dynamics
    this._squash = 0;
    this._squashVel = 0;

    // Previous physics state for interpolation
    this.prevPosition = new THREE.Vector3(0, RADIUS, 5);
    this.currentPosition = new THREE.Vector3(0, RADIUS, 5);

    this._tmp = new THREE.Vector3();
    this._magnusForce = new THREE.Vector3();
    this._rollAxis = new THREE.Vector3();
    this._scaleVec = new THREE.Vector3(1, 1, 1);

    this.mesh = new THREE.Group();
    this.build();
    this.mesh.position.set(0, RADIUS, 5);
    this.currentPosition.copy(this.mesh.position);
    this.prevPosition.copy(this.mesh.position);
  }

  get spin() {
    return this.spinVector.y;
  }

  set spin(val) {
    this.spinVector.y = val;
  }

  build() {
    // Shell container for squash/stretch
    this.squashGroup = new THREE.Group();
    this.mesh.add(this.squashGroup);

    // Shell
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4f7ff, roughness: 0.45, metalness: 0.1 })
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.shell = shell;
    this.squashGroup.add(shell);

    // Dark geometric panels
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x141a2a, roughness: 0.5 });
    const dirs = [
      [0, 1, 0], [0, -1, 0], [1, 0.3, 0], [-1, 0.3, 0],
      [0.3, 0.1, 1], [0.3, 0.1, -1], [-0.7, -0.4, 0.7], [0.7, -0.4, -0.7],
    ];
    for (const d of dirs) {
      const n = new THREE.Vector3(...d).normalize();
      const patch = new THREE.Mesh(new THREE.CircleGeometry(RADIUS * 0.34, 5), panelMat);
      patch.position.copy(n).multiplyScalar(RADIUS * 0.995);
      patch.lookAt(n.clone().multiplyScalar(RADIUS * 2));
      shell.add(patch);
    }

    // Equator accent ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(RADIUS * 0.99, 0.012, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 0.5, roughness: 0.3 })
    );
    ring.rotation.x = Math.PI / 2;
    shell.add(ring);

    // Contact shadow
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * 1.5, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.015;
    this.mesh.add(this.shadow);
  }

  get position() { return this.mesh.position; }

  get horizontalSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  isMoving() {
    return this.horizontalSpeed > STOP_SPEED || Math.abs(this.vel.y) > STOP_SPEED || !this.grounded;
  }

  /**
   * Strike the ball.
   * @param {THREE.Vector3} impulse Velocity vector
   * @param {number|THREE.Vector3} spin Lateral spin or full 3D spin vector
   * @param {boolean} isKnuckle True for knuckleball wobble
   */
  kick(impulse, spin = 0, isKnuckle = false) {
    this.vel.copy(impulse);
    if (typeof spin === 'number') {
      this.spinVector.set(0, spin, 0);
    } else if (spin && spin.isVector3) {
      this.spinVector.copy(spin);
    }
    this.isKnuckle = Boolean(isKnuckle);
    this.knuckleSeed = Math.random() * 100;
    if (impulse.y > 0.1) this.grounded = false;

    // Contact squash
    const speed = impulse.length();
    this._squash = -Math.min(0.3, speed * 0.015);
  }

  nudge(dir, targetSpeed) {
    const hs = this.horizontalSpeed;
    if (hs < targetSpeed) {
      this.vel.x = dir.x * targetSpeed;
      this.vel.z = dir.z * targetSpeed;
    }
    this.spinVector.set(0, 0, 0);
    this.isKnuckle = false;
  }

  carryTo(point, dt, stiffness = 10) {
    const pos = this.mesh.position;
    const k = dt > 0 ? 1 - Math.exp(-stiffness * dt) : 1;
    const nx = pos.x + (point.x - pos.x) * k;
    const nz = pos.z + (point.z - pos.z) * k;
    if (dt > 0) {
      this.vel.x = (nx - pos.x) / dt;
      this.vel.z = (nz - pos.z) / dt;
    }
    pos.x = nx; pos.z = nz; pos.y = this.radius;
    this.currentPosition.copy(pos);
    this.prevPosition.copy(pos);
    this.vel.y = 0;
    this.spinVector.set(0, 0, 0);
    this.isKnuckle = false;
    this.grounded = true;
    this._updateVisual(dt);
  }

  parry(awayDir, strength = 0.4) {
    this.vel.multiplyScalar(strength);
    this.vel.x += awayDir.x * 3.5;
    this.vel.z += awayDir.z * 3.5;
    this.vel.y = Math.max(this.vel.y * 0.5, 2.2);
    this.spinVector.set(0, 0, 0);
    this.isKnuckle = false;
    this.grounded = false;
    this._squash = -0.15;
  }

  trap() {
    this.vel.set(0, 0, 0);
    this.spinVector.set(0, 0, 0);
    this.isKnuckle = false;
    this.mesh.position.y = this.radius;
    this.currentPosition.copy(this.mesh.position);
    this.prevPosition.copy(this.mesh.position);
    this.grounded = true;
    this._squash = -0.1;
  }

  reset(x = 0, z = 5) {
    this.vel.set(0, 0, 0);
    this.spinVector.set(0, 0, 0);
    this.isKnuckle = false;
    this.grounded = true;
    this._squash = 0;
    this._squashVel = 0;
    this.mesh.position.set(x, this.radius, z);
    this.mesh.rotation.set(0, 0, 0);
    this.currentPosition.copy(this.mesh.position);
    this.prevPosition.copy(this.mesh.position);
  }

  /**
   * Fixed physics step (dt = Config.PHYSICS.FIXED_DT).
   */
  fixedUpdate(dt) {
    const pos = this.mesh.position;

    if (this.grounded && this.horizontalSpeed < STOP_SPEED && Math.abs(this.vel.y) < STOP_SPEED) {
      if (this.vel.lengthSq() > 0) this.vel.set(0, 0, 0);
      return;
    }

    const hs = this.horizontalSpeed;

    // --- 3D Magnus Effect: a = MAGNUS * (spinVector x vel) ---
    if (this.spinVector.lengthSq() > 0.0001 && hs > 0.2) {
      this._magnusForce.crossVectors(this.spinVector, this.vel).multiplyScalar(MAGNUS);
      this.vel.addScaledVector(this._magnusForce, dt);
      this.spinVector.multiplyScalar(Math.exp(-SPIN_DECAY * dt));
    }

    // --- Knuckleball Turbulence (erratic air wobbles at speed) ---
    if (this.isKnuckle && hs > 14 && !this.grounded) {
      this.knuckleSeed += dt * 9.0;
      const noise = (Math.sin(this.knuckleSeed) + Math.sin(this.knuckleSeed * 2.3)) * 0.5;
      this.vel.x += noise * 6.0 * dt;
    }

    // --- Gravity & Air Drag ---
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      const drag = Math.exp(-AIR_DRAG * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    }

    // --- Integrate position ---
    pos.addScaledVector(this.vel, dt);

    // --- Ground Contact ---
    if (pos.y <= this.radius) {
      pos.y = this.radius;
      if (this.vel.y < -0.4) {
        this._squash = Math.max(-0.35, this.vel.y * 0.02); // squash spring trigger
        this.vel.y = -this.vel.y * RESTITUTION;
        this.grounded = false;
        events.emit('ball_bounce', { speed: Math.abs(this.vel.y) });
      } else {
        this.vel.y = 0;
        this.grounded = true;
      }

      // Rolling friction
      const roll = Math.exp(-ROLL_FRICTION * dt);
      this.vel.x *= roll;
      this.vel.z *= roll;
      if (this.horizontalSpeed < STOP_SPEED) {
        this.vel.x = 0;
        this.vel.z = 0;
      }
    } else {
      this.grounded = false;
    }

    // --- Arena Wall Reflection ---
    const r = Math.hypot(pos.x, pos.z);
    const limit = this.arenaRadius - 0.8 - this.radius;
    if (r > limit) {
      const nx = pos.x / r;
      const nz = pos.z / r;
      pos.x = nx * limit;
      pos.z = nz * limit;
      const dot = this.vel.x * nx + this.vel.z * nz;
      this.vel.x = (this.vel.x - 2 * dot * nx) * 0.7;
      this.vel.z = (this.vel.z - 2 * dot * nz) * 0.7;
      this.spinVector.y *= -0.4;
      this._squash = -0.15;
    }
  }

  /**
   * Backward-compatible update wrapper.
   */
  update(dt) {
    this.fixedUpdate(dt);
    this._updateVisual(dt);
  }

  /**
   * Render update: interpolate visual mesh between physics steps.
   */
  render(alpha, dt) {
    this.mesh.position.lerpVectors(this.prevPosition, this.currentPosition, alpha);
    this._updateVisual(dt);
  }

  _updateVisual(dt) {
    const pos = this.mesh.position;
    const hs = this.horizontalSpeed;

    // Shell rolling
    if (hs > 0.01) {
      this._rollAxis.set(this.vel.z, 0, -this.vel.x).normalize();
      this.shell.rotateOnWorldAxis(this._rollAxis, (hs * dt) / this.radius);
    }

    // Squash & Stretch Spring (k = 260, c = 14)
    const k = 260;
    const c = 14;
    const force = -k * this._squash - c * this._squashVel;
    this._squashVel += force * dt;
    this._squash += this._squashVel * dt;

    // Dynamic flight elongation + contact squash
    const totalSpeed = this.vel.length();
    const flightStretch = this.grounded ? 0 : Math.min(0.25, totalSpeed / 40);
    const sx = 1 + this._squash - flightStretch * 0.5;
    const sy = 1 - this._squash * 1.5;
    const sz = 1 + this._squash + flightStretch;

    this.squashGroup.scale.set(sx, sy, sz);
    if (!this.grounded && totalSpeed > 2.0) {
      this.squashGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this._tmp.copy(this.vel).normalize());
    } else {
      this.squashGroup.quaternion.identity();
    }

    // Shadow
    const h = Math.max(0, pos.y - this.radius);
    const shadowK = THREE.MathUtils.clamp(1 - h / 6, 0.25, 1);
    this.shadow.position.y = 0.015 - pos.y;
    this.shadow.scale.setScalar(shadowK);
    this.shadow.material.opacity = 0.32 * shadowK;
  }
}
