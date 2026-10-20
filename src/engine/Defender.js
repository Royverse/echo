// Procedural outfield defender & opponent agent with full FSM:
// JOCKEY -> PRESS -> COMMIT_TACKLE (snapshot target) -> RECOVER,
// plus CARRY, SHOOT, and COVER_LANE with shot-blocking hitbox.
import * as THREE from 'three';
import { Config } from '../core/Config.js';
import { events } from '../core/EventBus.js';

const DEF_SPEED = Config.DEFENDER.SPEED;
const TACKLE_RANGE = Config.DEFENDER.TACKLE_RANGE;
const LUNGE_TIME = Config.DEFENDER.LUNGE_TIME;
const TACKLE_COOLDOWN = Config.DEFENDER.TACKLE_COOLDOWN;
const PRESSURE_RANGE = Config.DEFENDER.PRESSURE_RANGE;
const JOCKEY_DIST = Config.DEFENDER.JOCKEY_DIST;

const _v1 = new THREE.Vector3();
const _snapshotTarget = new THREE.Vector3();

export class Defender {
  constructor(goal, isSecondOpponent = false) {
    this.goal = goal;
    this.isSecondOpponent = isSecondOpponent;
    this.homeZ = goal.z - (isSecondOpponent ? 12 : 9);
    this.homeX = isSecondOpponent ? 4.0 : -2.0;

    this.fsmState = 'JOCKEY'; // 'JOCKEY' | 'PRESS' | 'COMMIT_TACKLE' | 'RECOVER' | 'CARRY' | 'SHOOT' | 'COVER_LANE'
    this.cooldown = 0;
    this.lungeT = 0;
    this.recoverT = 0;
    this.speedNow = 0;
    this.gait = 0;
    this.stunnedT = 0;

    // Shot blocking cylinder (r = 0.5, h = 1.9)
    this.blockRadius = 0.5;
    this.blockHeight = 1.9;

    this.mesh = new THREE.Group();
    this.build();
    this.reset(this.homeX);
  }

  build() {
    const kitColor = this.isSecondOpponent ? 0xd03060 : 0xe0463c;
    const kit = new THREE.MeshStandardMaterial({ color: kitColor, roughness: 0.5, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2330, roughness: 0.6 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xcf9b6a, roughness: 0.6 });

    this.body = new THREE.Group();
    this.mesh.add(this.body);

    const buildLeg = (side) => {
      const hip = new THREE.Group();
      hip.position.set(0.16 * side, 0.7, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.22), dark);
      leg.position.y = -0.35; leg.castShadow = true; hip.add(leg);
      this.body.add(hip);
      return hip;
    };
    this.hipL = buildLeg(-1);
    this.hipR = buildLeg(1);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.34), kit);
    torso.position.y = 1.1; torso.castShadow = true; this.body.add(torso);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), skin);
    head.position.y = 1.72; head.castShadow = true; this.body.add(head);

    const buildArm = (side) => {
      const arm = new THREE.Group();
      arm.position.set(0.34 * side, 1.42, 0);
      const upper = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.14), kit);
      upper.position.y = -0.25; upper.castShadow = true; arm.add(upper);
      this.body.add(arm);
      return arm;
    };
    this.armL = buildArm(-1);
    this.armR = buildArm(1);
  }

  reset(x = this.homeX) {
    this.cooldown = 0;
    this.lungeT = 0;
    this.recoverT = 0;
    this.stunnedT = 0;
    this.fsmState = 'JOCKEY';
    this.mesh.position.set(x, 0, this.homeZ);
    this.body.rotation.set(0, 0, 0);
  }

  stun(duration = 0.8) {
    this.stunnedT = duration;
    this.lungeT = 0;
    this.fsmState = 'RECOVER';
  }

  /**
   * Check if an in-flight ball intersects the defender's blocking cylinder.
   * @param {THREE.Vector3} ballPos 
   * @returns {boolean}
   */
  checkShotBlock(ballPos) {
    const me = this.mesh.position;
    const distHoriz = Math.hypot(ballPos.x - me.x, ballPos.z - me.z);
    return distHoriz < this.blockRadius + 0.36 && ballPos.y < this.blockHeight;
  }

  _moveToward(tx, tz, speed, dt) {
    const me = this.mesh.position;
    const dx = tx - me.x, dz = tz - me.z;
    const d = Math.hypot(dx, dz);
    const stepLen = speed * dt;
    if (d > 0.02) {
      const s = Math.min(stepLen, d);
      me.x += (dx / d) * s;
      me.z += (dz / d) * s;
    }
    this.speedNow = d > 0.02 ? speed : THREE.MathUtils.lerp(this.speedNow, 0, 0.2);
  }

  _face(tx, tz, dt) {
    const me = this.mesh.position;
    const want = Math.atan2(tx - me.x, tz - me.z);
    const cur = this.mesh.rotation.y;
    const delta = Math.atan2(Math.sin(want - cur), Math.cos(want - cur));
    this.mesh.rotation.y = cur + delta * Math.min(1, dt * 10);
  }

  update(dt, ctx) {
    const b = ctx.ball.position;
    const me = this.mesh.position;
    const toBall = Math.hypot(b.x - me.x, b.z - me.z);

    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.stunnedT > 0) {
      this.stunnedT -= dt;
      this.animate(dt, 'stunned');
      return;
    }

    ctx.setPressure(ctx.possession === 'robot' && toBall < PRESSURE_RANGE);

    const goalZ = ctx.goalZ !== undefined ? ctx.goalZ : (ctx.goal ? ctx.goal.z : (this.goal ? this.goal.z : 23));

    // State Machine Evaluation
    switch (this.fsmState) {
      case 'COMMIT_TACKLE': {
        this.lungeT -= dt;
        // Drive toward snapshot target committed at start of tackle (so feints evade him!)
        this._moveToward(_snapshotTarget.x, _snapshotTarget.z, DEF_SPEED * 1.6, dt);
        this.animate(dt, 'lunge');

        if (this.lungeT <= 0) {
          const reBall = Math.hypot(b.x - me.x, b.z - me.z);
          if (ctx.possession === 'robot' && !ctx.shielding && reBall < TACKLE_RANGE + 0.35) {
            ctx.onTackle();
            events.emit('tackle_won', { tackler: 'defender', cleanly: true });
          } else if (ctx.possession === 'robot') {
            events.emit('tackle_lost', { tackler: 'defender', reason: 'feint' });
          }
          this.fsmState = 'RECOVER';
          this.recoverT = Config.DEFENDER.RECOVER_LOCKOUT;
          this.cooldown = TACKLE_COOLDOWN;
        }
        break;
      }

      case 'RECOVER': {
        this.recoverT -= dt;
        this._moveToward(me.x, me.z + 1.0, DEF_SPEED * 0.4, dt);
        this.animate(dt, 'idle');
        if (this.recoverT <= 0) {
          this.fsmState = ctx.possession === 'robot' ? 'JOCKEY' : 'COVER_LANE';
        }
        break;
      }

      case 'PRESS': {
        this._moveToward(b.x, b.z + 0.5, DEF_SPEED, dt);
        this._face(b.x, b.z, dt);
        this.animate(dt, 'run');

        if (toBall < TACKLE_RANGE && this.cooldown <= 0) {
          // Commit to snapshot position of the ball at this instant
          _snapshotTarget.copy(b);
          this.fsmState = 'COMMIT_TACKLE';
          this.lungeT = LUNGE_TIME;
        } else if (toBall > PRESSURE_RANGE + 1.5) {
          this.fsmState = 'JOCKEY';
        }
        break;
      }

      case 'JOCKEY': {
        // Hold distance from carrier, mirror lateral movement, stay goal-side
        const targetZ = Math.max(goalZ - 16, b.z + JOCKEY_DIST);
        const targetX = b.x * 0.85;
        this._moveToward(targetX, targetZ, DEF_SPEED * 0.8, dt);
        this._face(b.x, b.z, dt);
        this.animate(dt, 'press');

        if (toBall < TACKLE_RANGE + 0.4 && this.cooldown <= 0) {
          _snapshotTarget.copy(b);
          this.fsmState = 'COMMIT_TACKLE';
          this.lungeT = LUNGE_TIME;
        } else if (toBall < PRESSURE_RANGE * 0.75) {
          this.fsmState = 'PRESS';
        }
        break;
      }

      case 'COVER_LANE':
      default: {
        // Stand on the direct line between ball and goal center
        const hz = Math.min(goalZ - 5, (b.z + goalZ) * 0.5);
        this._moveToward(b.x * 0.5, hz, DEF_SPEED * 0.75, dt);
        this._face(b.x, b.z, dt);
        this.animate(dt, this.speedNow > 0.2 ? 'run' : 'idle');

        if (ctx.possession === 'robot') {
          this.fsmState = toBall < PRESSURE_RANGE ? 'PRESS' : 'JOCKEY';
        }
        break;
      }
    }
  }

  animate(dt, pose) {
    if (pose === 'lunge') {
      this.hipR.rotation.x = THREE.MathUtils.lerp(this.hipR.rotation.x, -1.1, 0.3);
      this.hipL.rotation.x = THREE.MathUtils.lerp(this.hipL.rotation.x, 0.5, 0.3);
      this.body.rotation.x = THREE.MathUtils.lerp(this.body.rotation.x, 0.3, 0.3);
      this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.8, 0.3);
      this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, -0.8, 0.3);
      return;
    }
    if (pose === 'stunned') {
      this.body.rotation.z = Math.sin(Date.now() * 0.02) * 0.2;
      this.body.rotation.x = -0.2;
      return;
    }
    this.body.rotation.z = 0;
    this.body.rotation.x = THREE.MathUtils.lerp(this.body.rotation.x, pose === 'press' ? 0.12 : 0, 0.2);
    this.gait += this.speedNow * 1.7 * dt;
    const sw = Math.min(1, this.speedNow / DEF_SPEED) * 0.7;
    this.hipR.rotation.x = Math.sin(this.gait) * sw;
    this.hipL.rotation.x = -Math.sin(this.gait) * sw;
    this.armR.rotation.x = -Math.sin(this.gait) * sw * 0.8;
    this.armL.rotation.x = Math.sin(this.gait) * sw * 0.8;
    this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.18, 0.2);
    this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, -0.18, 0.2);
  }
}
