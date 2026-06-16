// A self-contained arcade football. The engine decides *intent* (how hard, how
// high, how much curve) and hands the ball an impulse; the ball owns the physics:
// gravity, a bouncy ground contact, rolling friction, light air drag, and a
// Magnus-style sideways push from spin so curled shots actually bend in flight.
// Asset-free, like the rest of the project — a procedural sphere + contact shadow.
import * as THREE from 'three';

const RADIUS = 0.36;
const GRAVITY = 24;          // matches the engine's jump gravity for a consistent feel
const RESTITUTION = 0.55;    // bounciness on the ground
const ROLL_FRICTION = 0.9;   // horizontal damping while rolling (per second, exp)
const AIR_DRAG = 0.16;       // horizontal damping while airborne
const MAGNUS = 1.15;         // how strongly spin curves the flight
const SPIN_DECAY = 0.6;      // spin bleeds off over time
const STOP_SPEED = 0.06;     // below this the ball is treated as at rest

export class Ball {
  constructor(arenaRadius = 26) {
    this.arenaRadius = arenaRadius;
    this.radius = RADIUS;

    this.vel = new THREE.Vector3();
    this.spin = 0;            // +/- : signed lateral spin (curve)
    this.grounded = true;

    this._tmp = new THREE.Vector3();
    this._perp = new THREE.Vector3();
    this._rollAxis = new THREE.Vector3();

    this.mesh = new THREE.Group();
    this.build();
    this.mesh.position.set(0, RADIUS, 5); // sits a few units in front of spawn
  }

  build() {
    // Bright shell so the ball pops against the dark arena; subtle panels + a
    // cyan seam to tie it into ECHO's neon identity.
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xf4f7ff, roughness: 0.45, metalness: 0.1 })
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.shell = shell;
    this.mesh.add(shell);

    // A handful of dark "panels" for a football read, placed around the sphere.
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

    // Equator accent ring.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(RADIUS * 0.99, 0.012, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 0.5, roughness: 0.3 })
    );
    ring.rotation.x = Math.PI / 2;
    shell.add(ring);

    // Contact shadow that lives on the floor under the ball.
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS * 1.5, 28),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 })
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.015;
    this.mesh.add(this.shadow);
  }

  get position() { return this.mesh.position; }

  /** Speed of horizontal travel (m/s) — handy for telemetry & dribble logic. */
  get horizontalSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  isMoving() {
    return this.horizontalSpeed > STOP_SPEED || Math.abs(this.vel.y) > STOP_SPEED || !this.grounded;
  }

  /**
   * Strike the ball.
   * @param {THREE.Vector3} impulse desired velocity (includes any vertical loft)
   * @param {number} spin signed lateral spin for curve (0 = straight)
   */
  kick(impulse, spin = 0) {
    this.vel.copy(impulse);
    this.spin = spin;
    if (impulse.y > 0.1) this.grounded = false;
  }

  /** A soft dribble touch: nudge the ball along `dir` up to `targetSpeed`. */
  nudge(dir, targetSpeed) {
    const hs = this.horizontalSpeed;
    if (hs < targetSpeed) {
      this.vel.x = dir.x * targetSpeed;
      this.vel.z = dir.z * targetSpeed;
    }
    this.spin = 0;
  }

  /**
   * Close control: spring the ball toward a control point at the carrier's feet.
   * Used while a player is in possession — replaces normal physics for that frame.
   * Velocity is derived from the actual displacement so the shell rolls naturally
   * and a release (shot/pass) inherits the carrying momentum.
   */
  carryTo(point, dt, stiffness = 9) {
    const pos = this.mesh.position;
    const k = dt > 0 ? 1 - Math.exp(-stiffness * dt) : 1;
    const nx = pos.x + (point.x - pos.x) * k;
    const nz = pos.z + (point.z - pos.z) * k;
    if (dt > 0) { this.vel.x = (nx - pos.x) / dt; this.vel.z = (nz - pos.z) / dt; }
    pos.x = nx; pos.z = nz; pos.y = this.radius;
    this.vel.y = 0;
    this.spin = 0;
    this.grounded = true;
    this._updateVisual(dt);
  }

  /**
   * Keeper save: deflect the ball away from goal, bleeding most of its pace and
   * popping it up so it spills back into play. `awayDir` points back upfield.
   */
  parry(awayDir, strength = 0.4) {
    this.vel.multiplyScalar(strength);
    this.vel.x += awayDir.x * 3.5;
    this.vel.z += awayDir.z * 3.5;
    this.vel.y = Math.max(this.vel.y * 0.5, 2.2);
    this.spin = 0;
    this.grounded = false;
  }

  /** Trap / control: kill all motion and settle to the floor. */
  trap() {
    this.vel.set(0, 0, 0);
    this.spin = 0;
    this.mesh.position.y = this.radius;
    this.grounded = true;
  }

  reset(x = 0, z = 5) {
    this.vel.set(0, 0, 0);
    this.spin = 0;
    this.grounded = true;
    this.mesh.position.set(x, this.radius, z);
    this.mesh.rotation.set(0, 0, 0);
  }

  update(dt) {
    const pos = this.mesh.position;

    // Sleep: a ball at rest on the ground does no physics work, so idle frames
    // stay cheap (it's stationary most of the time).
    if (this.grounded && this.horizontalSpeed < STOP_SPEED && Math.abs(this.vel.y) < STOP_SPEED) {
      if (this.vel.lengthSq() > 0) this.vel.set(0, 0, 0);
      return;
    }

    // --- spin → curve (Magnus): push sideways, perpendicular to travel ---
    const hs = this.horizontalSpeed;
    if (Math.abs(this.spin) > 0.001 && hs > 0.2) {
      // left-perpendicular of the horizontal velocity
      this._perp.set(-this.vel.z, 0, this.vel.x).normalize();
      const accel = this.spin * MAGNUS * hs;
      this.vel.x += this._perp.x * accel * dt;
      this.vel.z += this._perp.z * accel * dt;
      this.spin *= Math.exp(-SPIN_DECAY * dt);
    }

    // --- gravity + drag ---
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      const drag = Math.exp(-AIR_DRAG * dt);
      this.vel.x *= drag;
      this.vel.z *= drag;
    }

    // --- integrate ---
    pos.addScaledVector(this.vel, dt);

    // --- ground contact ---
    if (pos.y <= this.radius) {
      pos.y = this.radius;
      if (this.vel.y < -0.4) {
        this.vel.y = -this.vel.y * RESTITUTION;   // bounce
        this.grounded = false;
      } else {
        this.vel.y = 0;
        this.grounded = true;
      }
      // rolling friction on the ground
      const roll = Math.exp(-ROLL_FRICTION * dt);
      this.vel.x *= roll;
      this.vel.z *= roll;
      if (this.horizontalSpeed < STOP_SPEED) { this.vel.x = 0; this.vel.z = 0; }
    } else {
      this.grounded = false;
    }

    // --- arena wall: reflect inward off the boundary ---
    const r = Math.hypot(pos.x, pos.z);
    const limit = this.arenaRadius - 0.8 - this.radius;
    if (r > limit) {
      const nx = pos.x / r;
      const nz = pos.z / r;
      pos.x = nx * limit;
      pos.z = nz * limit;
      const dot = this.vel.x * nx + this.vel.z * nz;
      this.vel.x = (this.vel.x - 2 * dot * nx) * 0.7; // reflect + dampen
      this.vel.z = (this.vel.z - 2 * dot * nz) * 0.7;
      this.spin *= -0.4;
    }

    this._updateVisual(dt);
  }

  // Roll the shell to match ground speed, and pin/scale the contact shadow to the
  // floor (fainter & smaller the higher the ball flies). Shared by update + carryTo.
  _updateVisual(dt) {
    const pos = this.mesh.position;
    const hs = this.horizontalSpeed;
    if (hs > 0.01) {
      this._rollAxis.set(this.vel.z, 0, -this.vel.x).normalize();
      this.shell.rotateOnWorldAxis(this._rollAxis, (hs * dt) / this.radius);
    }
    const h = Math.max(0, pos.y - this.radius);
    const k = THREE.MathUtils.clamp(1 - h / 6, 0.25, 1);
    this.shadow.position.y = 0.015 - pos.y;
    this.shadow.scale.setScalar(k);
    this.shadow.material.opacity = 0.32 * k;
  }
}
