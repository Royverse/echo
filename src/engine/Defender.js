// Procedural outfield defender: pressures the ball-carrier from the goal side,
// lunges to tackle when close, and is beatable — outpace him, shield the ball, or
// knock it past. When he wins it he just boots it upfield (no dribbling AI), so
// the ball goes loose and the player can win it back. Asset-free, like Robot.js.
import * as THREE from 'three';

const DEF_SPEED = 4.6;         // chase pace — slower than a run (7) so pace beats him
const TACKLE_RANGE = 1.4;
const LUNGE_TIME = 0.32;
const TACKLE_COOLDOWN = 1.1;
const PRESSURE_RANGE = 3.0;    // within this of the carrier → flags pressure (amber ring)

export class Defender {
  constructor(goal) {
    this.goal = goal;
    this.homeZ = goal.z - 9;
    this.cooldown = 0;
    this.lungeT = 0;
    this.speedNow = 0;
    this.gait = 0;

    this.mesh = new THREE.Group();
    this.build();
    this.mesh.position.set(0, 0, this.homeZ);
  }

  build() {
    const kit = new THREE.MeshStandardMaterial({ color: 0xe0463c, roughness: 0.5, metalness: 0.1 });
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

  reset(x = 0) {
    this.cooldown = 0; this.lungeT = 0;
    this.mesh.position.set(x, 0, this.homeZ);
    this.body.rotation.set(0, 0, 0);
  }

  _moveToward(tx, tz, speed, dt) {
    const me = this.mesh.position;
    const dx = tx - me.x, dz = tz - me.z;
    const d = Math.hypot(dx, dz);
    const stepLen = speed * dt;
    if (d > 0.02) {
      const s = Math.min(stepLen, d);
      me.x += (dx / d) * s; me.z += (dz / d) * s;
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

    let pose = 'run';
    ctx.setPressure(ctx.possession === 'robot' && toBall < PRESSURE_RANGE);

    if (this.lungeT > 0) {
      // Committed lunge: drive at the ball; resolve the tackle when it ends.
      this.lungeT -= dt;
      this._moveToward(b.x, b.z, DEF_SPEED * 1.6, dt);
      pose = 'lunge';
      if (this.lungeT <= 0) {
        const reBall = Math.hypot(b.x - me.x, b.z - me.z);
        if (ctx.possession === 'robot' && !ctx.shielding && reBall < TACKLE_RANGE + 0.35) {
          ctx.onTackle();
        }
        this.cooldown = TACKLE_COOLDOWN;
      }
    } else if (ctx.possession === 'robot') {
      // Pressure: aim for a point a touch goal-side of the ball, then lunge in range.
      this._moveToward(b.x, b.z + 0.9, DEF_SPEED, dt);
      if (toBall < TACKLE_RANGE && this.cooldown <= 0) this.lungeT = LUNGE_TIME;
      pose = toBall < PRESSURE_RANGE ? 'press' : 'run';
    } else {
      // Ball loose / robot has no possession: hold a goal-side screening position.
      const hz = Math.min(this.goal.z - 5, (b.z + this.goal.z) / 2);
      this._moveToward(b.x * 0.5, hz, DEF_SPEED * 0.75, dt);
      pose = this.speedNow > 0.2 ? 'run' : 'idle';
    }

    this._face(b.x, b.z, dt);
    this.animate(dt, pose);
  }

  animate(dt, pose) {
    if (pose === 'lunge') {
      // Stretch a leg out toward the ball, lean in.
      this.hipR.rotation.x = THREE.MathUtils.lerp(this.hipR.rotation.x, -1.1, 0.3);
      this.hipL.rotation.x = THREE.MathUtils.lerp(this.hipL.rotation.x, 0.5, 0.3);
      this.body.rotation.x = THREE.MathUtils.lerp(this.body.rotation.x, 0.3, 0.3);
      this.armL.rotation.z = THREE.MathUtils.lerp(this.armL.rotation.z, 0.8, 0.3);
      this.armR.rotation.z = THREE.MathUtils.lerp(this.armR.rotation.z, -0.8, 0.3);
      return;
    }
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
