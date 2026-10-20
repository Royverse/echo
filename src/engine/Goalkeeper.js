// Procedural goalkeeper with full FSM:
// SET -> SHUFFLE -> RUSH -> DIVE -> RECOVER,
// positioning along the ball-goal bisector, reaction delay,
// wind-up telegraph lean, and multi-tier trajectory simulation.
import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';

const GRAVITY = Config.PHYSICS.GRAVITY;
const TRACK_SPEED = Config.KEEPER.TRACK_SPEED;
const TRACK_BIAS = Config.KEEPER.TRACK_BIAS;
const DIVE_REACH = Config.KEEPER.DIVE_REACH;
const DIVE_SPEED = Config.KEEPER.DIVE_SPEED;
const CATCH = Config.KEEPER.CATCH;
const DIVE_TIME = Config.KEEPER.DIVE_TIME;
const RUSH_SPEED = Config.KEEPER.RUSH_SPEED;
const RECOVER_TIME = Config.KEEPER.RECOVER_TIME;

export class Goalkeeper {
  constructor(goal, tier = 2) {
    this.goal = goal;
    this.homeZ = goal.z - 0.6;
    this.half = goal.w / 2 - 0.5;
    this.tier = tier; // 1: straight line, 2: curl simulator, 3: topspin simulator

    this.fsmState = 'SET'; // 'SET' | 'SHUFFLE' | 'RUSH' | 'DIVE' | 'RECOVER'
    this.x = 0;
    this.z = this.homeZ;
    this.reachY = 1.0;
    this.diveT = 0;
    this.recoverT = 0;
    this.reactionTimer = 0;
    this.pendingShot = null;

    this.setX = 0;
    this.divePredX = 0;
    this.divePredY = 1.0;
    this.diveDir = 0;
    this.reachPoint = new THREE.Vector3(0, 1.0, this.homeZ);
    this.CATCH = CATCH;

    this.mesh = new THREE.Group();
    this.build();
    this.reset();
  }

  build() {
    const kit = new THREE.MeshStandardMaterial({ color: 0x2fe08a, roughness: 0.5, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14361f, roughness: 0.6 });
    const glove = new THREE.MeshStandardMaterial({ color: 0xffe14d, emissive: 0xffe14d, emissiveIntensity: 0.25, roughness: 0.4 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xcf9b6a, roughness: 0.6 });

    this.body = new THREE.Group();
    this.mesh.add(this.body);

    const legGeo = new THREE.BoxGeometry(0.22, 0.7, 0.24);
    this.legL = new THREE.Mesh(legGeo, dark);
    this.legL.position.set(-0.16, 0.35, 0);
    this.legL.castShadow = true;
    this.body.add(this.legL);

    this.legR = this.legL.clone();
    this.legR.position.x = 0.16;
    this.body.add(this.legR);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.34), kit);
    torso.position.y = 1.1;
    torso.castShadow = true;
    this.body.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skin);
    head.position.y = 1.72;
    head.castShadow = true;
    this.body.add(head);

    const buildArm = (side) => {
      const arm = new THREE.Group();
      arm.position.set(0.34 * side, 1.42, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.52, 0.15), kit);
      upper.position.y = -0.26;
      upper.castShadow = true;
      arm.add(upper);
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), glove);
      hand.position.y = -0.56;
      arm.add(hand);
      this.body.add(arm);
      return arm;
    };
    this.armL = buildArm(-1);
    this.armR = buildArm(1);
    this.armL.rotation.z = 0.35;
    this.armR.rotation.z = -0.35;
  }

  reset() {
    this.fsmState = 'SET';
    this.diveT = 0;
    this.recoverT = 0;
    this.reactionTimer = 0;
    this.pendingShot = null;
    this.x = 0;
    this.z = this.homeZ;
    this.mesh.position.set(0, 0, this.homeZ);
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
  }

  onSave() {
    this.fsmState = 'RECOVER';
    this.recoverT = RECOVER_TIME;
    this.diveT = 0.2;
    events.emit('save', { keeper: 'gk', reachPoint: this.reachPoint });
  }

  /**
   * Trajectory simulation to predict where a shot arrives at the keeper's line.
   */
  _predictArrival(ball) {
    if (this.tier === 1) {
      // Tier 1: straight line prediction
      const tHit = (this.homeZ - ball.position.z) / Math.max(0.1, ball.vel.z);
      const px = ball.position.x + ball.vel.x * tHit;
      const py = ball.position.y + ball.vel.y * tHit - 0.5 * GRAVITY * tHit * tHit;
      return { px, py };
    }

    // Tier 2 & 3: numerical integration reading curl and topspin
    const simPos = ball.position.clone();
    const simVel = ball.vel.clone();
    const simSpin = ball.spinVector.clone();
    const dtSim = 0.04;
    let t = 0;

    while (simPos.z < this.homeZ && t < 1.6) {
      // Magnus acceleration
      if (simSpin.lengthSq() > 0.001) {
        const magnusAcc = new THREE.Vector3().crossVectors(simSpin, simVel).multiplyScalar(Config.PHYSICS.BALL_MAGNUS);
        simVel.addScaledVector(magnusAcc, dtSim);
        simSpin.multiplyScalar(Math.exp(-Config.PHYSICS.BALL_SPIN_DECAY * dtSim));
      }
      simVel.y -= GRAVITY * dtSim;
      simPos.addScaledVector(simVel, dtSim);
      t += dtSim;
    }

    return { px: simPos.x, py: Math.max(0.2, simPos.y) };
  }

  update(dt, ctx) {
    const ball = ctx.ball;
    const b = ball.position;
    const distToBall = Math.hypot(b.x - this.x, b.z - this.z);

    // Dynamic off-the-line positioning along the bisector to cut the angle
    const offLineDist = THREE.MathUtils.clamp((18 - distToBall) * 0.22, 0, 3.5);
    const targetZ = this.homeZ - offLineDist;

    // Evaluate incoming shot
    const incoming = ball.vel.z > 5 && b.z < this.homeZ - 0.4 && b.z > this.homeZ - 18;

    if (this.fsmState === 'RECOVER') {
      this.recoverT -= dt;
      this.reachY += (1.0 - this.reachY) * Math.min(1, dt * 6);
      if (this.recoverT <= 0) {
        this.fsmState = 'SET';
      }
    } else if (this.fsmState === 'DIVE') {
      this.diveT = Math.max(0, this.diveT - dt);
      this.x += THREE.MathUtils.clamp(this.divePredX - this.x, -DIVE_SPEED * dt, DIVE_SPEED * dt);
      this.reachY += (this.divePredY - this.reachY) * Math.min(1, dt * 10);
      if (ball.vel.z < 1 || b.z > this.homeZ + 1.2 || this.diveT <= 0) {
        this.fsmState = 'RECOVER';
        this.recoverT = RECOVER_TIME;
      }
    } else if (incoming) {
      if (!this.pendingShot) {
        // Telegraph wind-up reaction delay (0.18s to 0.28s)
        this.reactionTimer = 0.22;
        this.pendingShot = true;
      }
      this.reactionTimer -= dt;

      if (this.reactionTimer <= 0) {
        const { px, py } = this._predictArrival(ball);
        this.setX = this.x;
        this.divePredX = THREE.MathUtils.clamp(px, this.setX - DIVE_REACH, this.setX + DIVE_REACH);
        this.divePredY = THREE.MathUtils.clamp(py, 0.25, 2.6);
        this.diveDir = Math.sign(this.divePredX - this.setX) || 1;
        this.fsmState = 'DIVE';
        this.diveT = DIVE_TIME;
        this.pendingShot = false;
      }
    } else {
      this.pendingShot = false;

      // 1v1 Rush condition: loose ball or uncontrolled attacker within 6.5m
      if (distToBall < 6.5 && b.z > this.goal.z - 12 && ctx.possession !== 'robot') {
        this.fsmState = 'RUSH';
        this.z += THREE.MathUtils.clamp(b.z - this.z, -RUSH_SPEED * dt, RUSH_SPEED * dt);
        this.x += THREE.MathUtils.clamp(b.x - this.x, -RUSH_SPEED * dt, RUSH_SPEED * dt);
      } else {
        // Shuffle along the line with central bias
        this.fsmState = 'SHUFFLE';
        this.z += (targetZ - this.z) * Math.min(1, dt * 4);
        const desiredX = THREE.MathUtils.clamp(b.x * TRACK_BIAS, -this.half, this.half);
        this.x += THREE.MathUtils.clamp(desiredX - this.x, -TRACK_SPEED * dt, TRACK_SPEED * dt);
        this.reachY += (1.0 - this.reachY) * Math.min(1, dt * 6);
      }
    }

    this.mesh.position.set(this.x, 0, this.z);
    this.reachPoint.set(this.x, this.reachY, this.z);
    this.applyPose(dt);
  }

  applyPose(dt) {
    const diving = this.fsmState === 'DIVE' && this.diveT > 0;
    const t = diving ? 1 - this.diveT / DIVE_TIME : 0;
    const lean = diving ? this.diveDir * 0.95 * t : (this.pendingShot ? this.diveDir * 0.3 : 0);
    const lift = diving ? -0.25 * t : 0;

    this.body.rotation.z = THREE.MathUtils.lerp(this.body.rotation.z, lean, 0.3);
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, lift, 0.3);

    const high = this.divePredY > 1.4;
    const armUp = diving ? (high ? -2.2 : -0.4) * t : (this.fsmState === 'RUSH' ? -1.0 : 0);
    this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, armUp, 0.25);
    this.armR.rotation.x = THREE.MathUtils.lerp(this.armR.rotation.x, armUp, 0.25);
    this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.35 + (diving ? this.diveDir * 0.5 : 0), 0.25);
    this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, -0.35 + (diving ? this.diveDir * 0.5 : 0), 0.25);
  }
}
